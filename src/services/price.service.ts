// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection, coldConnection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { getMint } from '@solana/spl-token';
import { rpcLimiter } from '../lib/rpc-limiter.js';
import { dexScreenerLimiter, rugCheckLimiter } from '../lib/api-limiter.js';
import axios from 'axios';

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
        return ""; 
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

export async function getTokensMetadata(mints: string[]): Promise<Record<string, any>> {
    if (mints.length === 0) return {};
    const result: Record<string, any> = {};
    const uncachedMints: string[] = [];

    await Promise.all(mints.map(async (mint) => {
        const cached = await redis.get(`token_metadata:${mint}`);
        if (cached) {
            result[mint] = JSON.parse(cached);
        } else {
            uncachedMints.push(mint);
        }
    }));

    if (uncachedMints.length === 0) return result;

    const chunks: string[][] = [];
    for (let i = 0; i < uncachedMints.length; i += 30) {
        chunks.push(uncachedMints.slice(i, i + 30));
    }

    await Promise.all(chunks.map(chunk => dexScreenerLimiter(async () => {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 2500 });
            const pairs = res.data?.pairs || [];
            
            for (const pair of pairs) {
                const mint = pair.baseToken?.address;
                if (!mint) continue;
                const metadata = {
                    symbol: pair.baseToken?.symbol || "UNKNOWN",
                    name: pair.baseToken?.name || "Unknown Token",
                    decimals: 6,
                    liquidityUsd: pair.liquidity?.usd || 0,
                    volume24h: pair.volume?.h24 || 0,
                    priceUsd: parseFloat(pair.priceUsd || '0'),
                };
                result[mint] = metadata;
                redis.set(`token_metadata:${mint}`, JSON.stringify(metadata), 'EX', 300).catch(() => {});
            }
        } catch (_) {}
    })));

    for (const mint of uncachedMints) {
        if (!result[mint]) {
            result[mint] = { symbol: "UNKNOWN", name: "Unknown Token", decimals: 6, liquidityUsd: 0, volume24h: 0, priceUsd: 0 };
        }
    }

    return result;
}

export async function getTokenMetadata(mint: string): Promise<{
    symbol: string;
    decimals: number;
    liquidityUsd: number;
    volume24h: number;
    priceUsd: number;
    name: string;
}> {
    const cacheKey = `token_metadata:${mint}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const fallback = { symbol: "UNKNOWN", name: "Unknown Token", decimals: 6, liquidityUsd: 0, volume24h: 0, priceUsd: 0 };

    try {
        const res = await dexScreenerLimiter(() =>
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 2500 })
        );
        
        const pair = res.data?.pairs?.[0];
        if (!pair) return fallback;

        const metadata = {
            symbol: pair.baseToken?.symbol || "UNKNOWN",
            name: pair.baseToken?.name || "Unknown Token",
            decimals: 6,
            liquidityUsd: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            priceUsd: parseFloat(pair.priceUsd || '0'),
        };

        await redis.set(cacheKey, JSON.stringify(metadata), 'EX', 300); 
        return metadata;
    } catch (e) {
        return fallback;
    }
}

// src/services/price.service.ts
export async function checkTokenRugRisk(tokenMint: string): Promise<boolean> {
    const key = `rugcheck:${tokenMint}`;
    try {
        const cached = await redis.get(key);
        if (cached === 'true') return true;
        if (cached === 'false') return false;

        const { keepAliveHttpsAgent } = await import('../lib/http-agent.js');
        const res = await rugCheckLimiter(() => 
            axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`, { 
                timeout: 2500,
                httpsAgent: keepAliveHttpsAgent 
            })
        );

        const data = res.data;
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
        await redis.set(key, 'uncertain', 'EX', 45).catch(() => {});
        return false; // Inconclusive network result: do not hard-block
    }
}

export async function getTokenRiskDetails(tokenMint: string): Promise<{
    isUnsafe: boolean; isHoneypot: boolean; isMintable: boolean; top10Pct: number; score: number;
}> {
    const key = `rugdetails:${tokenMint}`;
    try {
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);

        const { keepAliveHttpsAgent } = await import('../lib/http-agent.js');
        const res = await rugCheckLimiter(() => 
            axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`, { 
                timeout: 2500,
                httpsAgent: keepAliveHttpsAgent
            })
        );
        
        const data = res.data;
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

// 🟢 FIX: Trimmed signatures lookup to limit: 6
export async function checkRecentMevActivity(tokenMint: string): Promise<boolean> {
    if (!tokenMint || !BASE58_MINT_REGEX.test(tokenMint)) return false;

    const cacheKey = `mev_check:${tokenMint}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached === 'true') return true;
        if (cached === 'false') return false;

        let pubkey: PublicKey;
        try { pubkey = new PublicKey(tokenMint); } catch { return true; } 

        const sigs = await rpcLimiter.run(() =>
            connection.getSignaturesForAddress(pubkey, { limit: 6 }).catch(() => null)
        );
        if (sigs === null) {
            await redis.set(cacheKey, 'true', 'EX', 30);
            return true;
        }
        if (sigs.length === 0) {
            await redis.set(cacheKey, 'false', 'EX', 600);
            return false;
        }

        const txs = await rpcLimiter.run(() =>
            connection.getParsedTransactions(sigs.map((s: any) => s.signature), { maxSupportedTransactionVersion: 0 }).catch(() => null)
        );
        if (txs === null) {
            await redis.set(cacheKey, 'true', 'EX', 30);
            return true;
        }

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
            if (slots.length >= 3 && slots[slots.length - 1] - slots[0] <= 1) { isMev = true; break; }
        }

        await redis.set(cacheKey, isMev ? 'true' : 'false', 'EX', 600);
        return isMev;
    } catch (e: any) {
        await redis.set(cacheKey, 'true', 'EX', 30).catch(() => {});
        return true; 
    }
}

// 🟢 FIX: Tightened timeout to 400ms inside rugCheckLimiter

export async function getTokenPriceUsd(mintAddress: string): Promise<number> {
    const cacheKey = `price:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return parseFloat(cached);

    try {
        const res = await dexScreenerLimiter(() =>
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 800 })
        ).catch(() => null);

        const priceUsd = parseFloat(res?.data?.pairs?.[0]?.priceUsd || '0');
        if (priceUsd > 0) {
            await redis.set(cacheKey, priceUsd.toString(), 'EX', 10);
            return priceUsd;
        }
        return 0;
    } catch (_) {
        return 0;
    }
}

export async function getVolatilityAdjustedSlippage(targetCA: string, baseSlippage: number): Promise<number> {
    try {
        const res = await dexScreenerLimiter(() =>
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${targetCA}`, { timeout: 500 })
        ).catch(() => null);

        const pair = res?.data?.pairs?.[0];
        if (!pair) return baseSlippage;

        const m5Change = Math.abs(parseFloat(pair.priceChange?.m5 || "0"));
        if (m5Change > 50) return Math.max(baseSlippage, 35.0);
        if (m5Change > 25) return Math.max(baseSlippage, 25.0);
        if (m5Change > 10) return Math.max(baseSlippage, 15.0);

        return baseSlippage;
    } catch (_) {
        return baseSlippage;
    }
}