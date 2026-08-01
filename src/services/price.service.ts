// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { getMint } from '@solana/spl-token';
import { coldConnection } from '../lib/connection.js';
import { rpcLimiter } from '../lib/rpc-limiter.js';

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const BASE58_MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function getBondingCurveAddress(tokenMint: string): string {
    try {
        if (!tokenMint || !BASE58_MINT_REGEX.test(tokenMint)) return "";
        const mintPubKey = new PublicKey(tokenMint);
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mintPubKey.toBuffer()],
            PUMP_FUN_PROGRAM_ID
        );
        return pda.toBase58();
    } catch (e) {
        return ""; // Failsafe trap
    }
}

export async function getCachedMintInfo(mint: string): Promise<{ decimals: number; mintAuthority: string | null; freezeAuthority: string | null }> {
    const key = `mint_info:${mint}`;
    try {
        if (!mint || !BASE58_MINT_REGEX.test(mint)) throw new Error("Invalid Mint");
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
    if (!tokenMint || !BASE58_MINT_REGEX.test(tokenMint)) return false; 

    const cacheKey = `mev_check:${tokenMint}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached !== null) return cached === 'true';

        let pubkey: PublicKey;
        try { pubkey = new PublicKey(tokenMint); } catch { return false; } // Strict trap

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

        await redis.set(cacheKey, isMev ? 'true' : 'false', 'EX', 600);
        return isMev;
    } catch (e: any) {
        return false;
    }
}

export async function checkTokenRugRisk(tokenMint: string): Promise<boolean> {
    const key = `rugcheck:${tokenMint}`;
    try {
        const cached = await redis.get(key);
        if (cached !== null) return cached === 'true';

        // 🟢 NEW FEATURE: NATIVE TOKEN-2022 TAX DETECTOR
        // Catch hidden 99% transfer taxes at the protocol level before APIs index them
        try {
            const pubkey = new PublicKey(tokenMint);
            const accountInfo = await connection.getAccountInfo(pubkey);
            if (accountInfo && accountInfo.owner.toBase58() === 'TokenzQdBNbLqP5VEhvkASnYGQYcBmiJXcwghAMPw') {
                // If it's a Token-2022 contract, we check the extension buffer length.
                // Large extension buffers usually indicate TransferFeeConfig (Tax) or Interest Bearing extensions.
                if (accountInfo.data.length > 165) {
                    console.warn(`🚨 [HONEYPOT DETECTED] Token-2022 Tax / TransferFee extension found on ${tokenMint}`);
                    await redis.set(key, 'true', 'EX', 600);
                    return true;
                }
            }
        } catch (e) {} // Fail silently and pass to RugCheck fallback

        const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`,
            { signal: AbortSignal.timeout(4000) });

        if (!res.ok) throw new Error("Timeout or API error");

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