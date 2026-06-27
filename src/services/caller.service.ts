// src/services/caller.service.ts
import axios from 'axios';
import { checkTokenRugRisk, getBondingCurveAddress } from './price.service.js';
import { redis } from '../lib/redis.js';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface TokenScore {
    mint: string;
    symbol: string;
    totalScore: number;
    ageMins: number;        
    priceChangeM5: number;  
    breakdown: {
        volumeSpike: number;      
        buySellRatio: number;     
        liquidityDepth: number;   
        ageScore: number;         
        mevRisk: number;          
        curveProgress: number;    
    };
    reasons: string[];
    warnings: string[];
}

export interface CallerFilters {
    minVolUsd: number;
    maxAgeMins: number;
    minPctChange: number;   
    maxPctChange: number;   
    blockMev: boolean;
    minScore: number;       // 🟢 FIXED: Restored minScore to satisfy index.ts
    isActive: boolean;
}

const DEFAULT_FILTERS: CallerFilters = {
    minVolUsd: 10000,
    maxAgeMins: 120,
    minPctChange: 15,
    maxPctChange: 1000,
    blockMev: true,
    minScore: 50,
    isActive: false
};

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        return raw ? JSON.parse(raw) : DEFAULT_FILTERS;
    } catch (e: any) {
        console.error(`🔴 [CALLER] Failed to read filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

export async function setUserCallerFilters(telegramId: string, filters: Partial<CallerFilters>): Promise<CallerFilters> {
    try {
        const current = await getUserCallerFilters(telegramId);
        const updated = { ...current, ...filters };
        await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
        return updated;
    } catch (e: any) {
        console.error(`🔴 [CALLER] Failed to write filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

const CURVE_PROGRESS_CACHE_TTL_SECONDS = 30;

async function getCachedCurveProgress(mint: string): Promise<{ progress: number; curveScore: number; reason: string | null } | null> {
    const cacheKey = `curve_progress:${mint}`;
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
        try {
            return JSON.parse(cached);
        } catch (_) {}
    }

    try {
        const curvePda = getBondingCurveAddress(mint);
        const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));

        let result: { progress: number; curveScore: number; reason: string | null } = {
            progress: 0,
            curveScore: 0,
            reason: null
        };

        if (accInfo?.data) {
            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
            const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
            const progress = Math.min(100, (virtualSolReserves / 85) * 100);

            let curveScore = 0;
            let reason: string | null = null;
            if (progress > 80) { curveScore = 20; reason = `🚀 Curve ${progress.toFixed(0)}% to graduation`; }
            else if (progress > 50) { curveScore = 10; }

            result = { progress, curveScore, reason };
        }

        await redis.set(cacheKey, JSON.stringify(result), 'EX', CURVE_PROGRESS_CACHE_TTL_SECONDS);
        return result;
    } catch (_) {
        return null;
    }
}

const TOKEN_PROCESSING_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

export async function scoreTokens(): Promise<TokenScore[]> {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000 });
        const profiles = (Array.isArray(res.data) ? res.data : []).filter((p: any) => p.chainId === 'solana');
        if (profiles.length === 0) return [];

        const mints = profiles.slice(0, 30).map((p: any) => p.tokenAddress).join(',');
        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 8000 });
        const pairs = (dexRes.data?.pairs || []).filter((pair: any) => pair.chainId === 'solana');

        const scoredTokens = await mapWithConcurrency(pairs, TOKEN_PROCESSING_CONCURRENCY, async (pair: any) => {
            let totalScore = 0;
            const reasons: string[] = [];
            const warnings: string[] = [];

            const vol5m = pair.volume?.m5 || 0;
            const vol1h = pair.volume?.h1 || 0.1;
            const volSpikeRatio = (vol5m * 12) / vol1h;
            let volumeSpike = 0;
            if (volSpikeRatio > 2.0) { volumeSpike = 20; reasons.push(`🔥 High momentum (+${((volSpikeRatio-1)*100).toFixed(0)}% vol spike)`); }
            else if (volSpikeRatio > 1.2) { volumeSpike = 10; }

            const buys = pair.txns?.h1?.buys || 0;
            const sells = pair.txns?.h1?.sells || 0;
            const totalTx = buys + sells;
            const buyRatio = totalTx > 0 ? (buys / totalTx) : 0;
            let buySellRatio = 0;
            if (buyRatio > 0.65) { buySellRatio = 15; reasons.push(`📈 Heavy buy pressure (${(buyRatio*100).toFixed(0)}% buys)`); }
            else if (buyRatio < 0.4) { warnings.push(`📉 Heavy sell pressure`); buySellRatio = -10; }

            const liq = pair.liquidity?.usd || 0;
            let liquidityDepth = 0;
            
            if (liq > 50000) { liquidityDepth = 15; reasons.push(`💧 Deep liquidity ($${(liq/1000).toFixed(1)}k)`); }
            const vol24 = pair.volume?.h24 || 0;
            if (vol24 > 0) { reasons.push(`📊 24H Volume: $${vol24.toLocaleString(undefined, {maximumFractionDigits: 0})}`); }

            // 🟢 FIXED: Explicitly declared as local variables in scope for shorthand mapping
            const ageMins = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 999;
            const priceChangeM5 = pair.priceChange?.m5 || 0;

            if (ageMins < 30) { reasons.push(`👶 Very fresh (${ageMins.toFixed(0)} mins old)`); }

            let curveProgress = 0;
            const isPump = pair.baseToken?.address?.toLowerCase().endsWith('pump');
            if (isPump) {
                const curveResult = await getCachedCurveProgress(pair.baseToken.address);
                if (curveResult) {
                    curveProgress = curveResult.curveScore;
                    if (curveResult.reason) reasons.push(curveResult.reason);
                }
            }

            const prelimScore = volumeSpike + buySellRatio + liquidityDepth + (ageMins < 30 ? 20 : ageMins < 120 ? 10 : 0) + curveProgress;
            let safetyScore = 0;

            if (prelimScore >= 35) { 
                const cacheKey = `rug_status:${pair.baseToken.address}`;
                const cachedRug = await redis.get(cacheKey);
                let isRug = false;

                if (cachedRug !== null) {
                    isRug = cachedRug === 'true'; 
                } else {
                    isRug = await checkTokenRugRisk(pair.baseToken.address);
                    await redis.set(cacheKey, isRug ? 'true' : 'false', 'EX', 600); 
                }

                if (isRug) {
                    safetyScore = -25;
                    warnings.push(`❌ RugCheck flagged: HIGH RISK (LP unlocked or Freeze enabled)`);
                } else {
                    safetyScore = 10;
                    reasons.push(`🛡️ RugCheck passed: Low Risk (Safe contract)`);
                }
            } else {
                warnings.push(`⚠️ Skipped safety scan (Low score token)`);
            }

            totalScore = prelimScore + safetyScore;

            const scored: TokenScore = {
                mint: pair.baseToken.address,
                symbol: pair.baseToken.symbol,
                totalScore: Math.min(100, Math.max(0, totalScore)),
                ageMins,             
                priceChangeM5,       
                breakdown: { volumeSpike, buySellRatio, liquidityDepth, ageScore: (ageMins < 30 ? 20 : ageMins < 120 ? 10 : 0), mevRisk: safetyScore, curveProgress },
                reasons,
                warnings
            };
            return scored;
        });

        return scoredTokens.sort((a, b) => b.totalScore - a.totalScore);
    } catch (e: any) {
        console.error("⚠️ [COIN CALLER] Scorer Exception:", e.message);
        return [];
    }
}

export async function startCoinCaller(bot: any) {
    console.log("🎯 [COIN CALLER] Background Alpha Engine Initialized. Scanning every 15 seconds.");

    setInterval(async () => {
        try {
            const topTokens = await scoreTokens();
            if (topTokens.length === 0) return;

            const subscribedUsers = await prisma.user.findMany({ select: { telegramId: true } });
            
            for (const user of subscribedUsers) {
                const filters = await getUserCallerFilters(user.telegramId);
                if (!filters.isActive) continue;

                // Evaluates the updated filters seamlessly
                const token = topTokens.find(t => 
                    t.totalScore >= filters.minScore &&
                    t.ageMins <= filters.maxAgeMins &&
                    t.priceChangeM5 >= filters.minPctChange && 
                    t.priceChangeM5 <= filters.maxPctChange && 
                    (!filters.blockMev || t.breakdown.mevRisk >= 0)
                );

                if (token) {
                    const lockKey = `caller_notified:${user.telegramId}:${token.mint}`;
                    const isNotified = await redis.set(lockKey, '1', 'EX', 86400, 'NX');
                    
                    if (isNotified) {
                        const msg = `🎯 <b>SENTRY CALLER — Top Alpha Pick</b>\n\n` +
                                    `<b>Token:</b> $${token.symbol} (<code>${token.mint}</code>)\n` +
                                    `<b>Score:</b> ${token.totalScore}/100 ⭐\n\n` +
                                    `${token.reasons.map(r => `✅ ${r}`).join('\n')}\n` +
                                    `${token.warnings.map(w => `${w}`).join('\n')}\n\n` +
                                    `<i>Reply with the CA to quick-snipe, or click below.</i>`;
                        
                        await bot.telegram.sendMessage(user.telegramId, msg, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${token.mint}_0.1` },
                                        { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${token.mint}` }
                                    ],
                                    [
                                        { text: '🛡️ Deploy Guard', callback_data: `caller_guard_${token.mint}` },
                                        { text: '⏳ Start DCA', callback_data: `caller_dca_${token.mint}` }
                                    ]
                                ]
                            }
                        }).catch(() => null);
                    }
                }
            }
        } catch (e: any) {
            console.error("🔴 [COIN CALLER] Error:", e.message);
        }
    }, 15 * 1000); 
}