// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export function getBondingCurveAddress(tokenMint: string): string {
    const mintPubKey = new PublicKey(tokenMint);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubKey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return pda.toBase58();
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
        console.error("⚠️ [PRICE SERVICE] Failed to decode pump curve price:", e.message);
        return 0;
    }
}

export async function checkRecentMevActivity(tokenMint: string): Promise<boolean> {
    try {
        const pubkey = new PublicKey(tokenMint);
        const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 10 });
        const txs = await connection.getParsedTransactions(
            sigs.map((s: any) => s.signature),
            { maxSupportedTransactionVersion: 0 }
        );

        const buyerMap: Record<string, number[]> = {};

        txs.forEach((tx: any, blockIdx: number) => {
            if (!tx || tx.meta?.err) return;
            const buyer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
            if (!buyer) return;
            if (!buyerMap[buyer]) buyerMap[buyer] = [];
            buyerMap[buyer].push(blockIdx);
        });

        for (const slots of Object.values(buyerMap)) {
            if (slots.length >= 2 && slots[slots.length - 1] - slots[0] <= 2) {
                return true;
            }
        }
        return false;
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
            { signal: AbortSignal.timeout(2000) });

        if (!res.ok) {
            await redis.set(key, 'false', 'EX', 60);
            return false;
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
        await redis.set(key, 'false', 'EX', 60);
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
            time: b.t,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c
        }));
    } catch {
        return [];
    }
}