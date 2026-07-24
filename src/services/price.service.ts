// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { getMint } from '@solana/spl-token';
import { coldConnection } from '../lib/connection.js';
import { rpcLimiter } from '../lib/rpc-limiter.js';

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export function getBondingCurveAddress(tokenMint: string): string {
    const mintPubKey = new PublicKey(tokenMint);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubKey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return pda.toBase58();
}

export async function getCachedMintInfo(mint: string): Promise<{ decimals: number; mintAuthority: string | null; freezeAuthority: string | null }> {
    const key = `mint_info:${mint}`;
    try {
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);

        const info = await getMint(coldConnection, new PublicKey(mint));
        const payload = {
            decimals: info.decimals,
            mintAuthority: info.mintAuthority?.toBase58() ?? null,
            freezeAuthority: info.freezeAuthority?.toBase58() ?? null
        };
        
        await redis.set(key, JSON.stringify(payload), 'EX', 21600); 
        return payload;
    } catch (e: any) {
        return { decimals: 9, mintAuthority: null, freezeAuthority: null }; 
    }
}

export async function getTokenRiskDetails(tokenMint: string): Promise<{
    isUnsafe: boolean; isHoneypot: boolean; isMintable: boolean; top10Pct: number; score: number;
}> {
    const key = `rugdetails:${tokenMint}`;
    try {
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);

        const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`,
            { signal: AbortSignal.timeout(4000) }); 
        if (!res.ok) return { isUnsafe: false, isHoneypot: false, isMintable: false, top10Pct: 0, score: 0 };

        const data = (await res.json()) as any;
        const risks = data.risks || [];
        const isHoneypot = risks.some((r: any) => r.name === 'Freeze Authority still enabled');
        const isMintable = !!(data.token && data.token.mintAuthority);
        const topHolders = data.topHolders || [];
        const top10Pct = topHolders.reduce((acc: number, h: any) => acc + (h.pct || 0), 0);
        const isUnsafe = isHoneypot || isMintable || (data.score > 500) || top10Pct > 40.0;

        const payload = { isUnsafe, isHoneypot, isMintable, top10Pct, score: data.score || 0 };
        await redis.set(key, JSON.stringify(payload), 'EX', 600);
        return payload;
    } catch (_) {
        return { isUnsafe: false, isHoneypot: false, isMintable: false, top10Pct: 0, score: 0 };
    }
}

export function decodePumpCurvePrice(base64Data: string): number {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length < 40) return 0;
        const virtualTokenReserves = buffer.readBigUInt64LE(8);
        const virtualSolReserves = buffer.readBigUInt64LE(16);
        const solAmount = Number(virtualSolReserves) / 1_000_000_000;
        const tokenAmount = Number(virtualTokenReserves) / 1_000_000;
        if (tokenAmount === 0) return 0;
        return solAmount / tokenAmount;
    } catch (e: any) {
        return 0;
    }
}

export async function checkRecentMevActivity(tokenMint: string): Promise<boolean> {
    // 🟢 FIX: Cache for 10 minutes — this was running uncached on every scan
    const cacheKey = `mev_check:${tokenMint}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) return cached === 'true';

        const pubkey = new PublicKey(tokenMint);

        const sigs = await rpcLimiter.run(() =>
            connection.getSignaturesForAddress(pubkey, { limit: 10 }).catch(() => [])
        );
        if (sigs.length === 0) {
            await redis.set(cacheKey, 'false', 'EX', 600);
            return false;
        }

        const txs = await rpcLimiter.run(() =>
            connection.getParsedTransactions(
                sigs.map((s: any) => s.signature),
                { maxSupportedTransactionVersion: 0 }
            ).catch(() => [])
        );

        const buyerMap: Record<string, number[]> = {};
        txs.forEach((tx: any, blockIdx: number) => {
            if (!tx || tx.meta?.err) return;
            const buyer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
            if (!buyer) return;
            if (!buyerMap[buyer]) buyerMap[buyer] = [];
            buyerMap[buyer].push(blockIdx);
        });

        let isMev = false;
        for (const slots of Object.values(buyerMap)) {
            if (slots.length >= 3 && slots[slots.length - 1] - slots[0] <= 1) {
                isMev = true;
                break;
            }
        }

        // 🟢 Cache result 10 minutes — MEV status does not change second to second
        await redis.set(cacheKey, isMev ? 'true' : 'false', 'EX', 600);
        return isMev;
    } catch (e: any) {
        console.error("⚠️ [PRICE SERVICE] MEV activity check exception:", e.message);
        return false;
    }
}

export async function checkTokenRugRisk(tokenMint: string): Promise<boolean> {
    const key = `rugcheck:${tokenMint}`;
    try {
        const cached = await redis.get(key);
        if (cached !== null) return cached === 'true';

        const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`,
            { signal: AbortSignal.timeout(4000) });

        if (!res.ok) {
            throw new Error("Timeout or API error");
        }

        const data = (await res.json()) as any;
        const risks = data.risks || [];

        const isHoneypot = risks.some((r: any) => r.name === 'Freeze Authority still enabled');
        const isMintable = !!(data.token && data.token.mintAuthority);
        const highScore = data.score > 500;

        const topHolders = data.topHolders || [];
        const top10Pct = topHolders.reduce((acc: number, h: any) => acc + (h.pct || 0), 0);
        const isHighlyConcentrated = top10Pct > 40.0;

        const isUnsafe = isHoneypot || isMintable || highScore || isHighlyConcentrated;

        await redis.set(key, isUnsafe ? 'true' : 'false', 'EX', 600);
        return isUnsafe;
    } catch (_) {
        return false;
    }
}

export async function fetchDexScreenerCandles(
    tokenMint: string
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>> {
    try {
        const res = await fetch(
            `https://io.dexscreener.com/dex/chart/amm/v3/solana/${tokenMint}?res=1&cb=1`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return [];
        const data = (await res.json()) as any;
        return (data?.bars || []).slice(-60).map((b: any) => ({
            time: b.t, open: b.o, high: b.h, low: b.l, close: b.c
        }));
    } catch {
        return [];
    }
}