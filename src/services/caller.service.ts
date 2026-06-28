import dotenv from 'dotenv';
dotenv.config();

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
    priceChangeH1: number;
    breakdown: {
        volumeSpike:    number;
        buySellRatio:   number;
        liquidityDepth: number;
        ageScore:       number;
        mevRisk:        number;
        curveProgress:  number;
        momentumBonus:  number;
    };
    reasons:  string[];
    warnings: string[];
    source: string;
}

export interface CallerFilters {
    minVolUsd:    number;
    maxAgeMins:   number;
    minPctChange: number;
    maxPctChange: number;
    blockMev:     boolean;
    minScore:     number;
    isActive:     boolean;
}

const DEFAULT_FILTERS: CallerFilters = {
    minVolUsd:    5000,
    maxAgeMins:   120,
    minPctChange: 15,
    maxPctChange: 10000,
    blockMev:     true,
    minScore:     50,
    isActive:     false
};

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        if (!raw) return DEFAULT_FILTERS;
        return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
    } catch (e: any) {
        console.error(`⚠️ [CALLER] Failed to read filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

export async function setUserCallerFilters(
    telegramId: string,
    filters: Partial<CallerFilters>
): Promise<CallerFilters> {
    try {
        const current = await getUserCallerFilters(telegramId);
        const updated  = { ...current, ...filters };
        await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
        return updated;
    } catch (e: any) {
        console.error(`⚠️ [CALLER] Failed to write filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

const CURVE_PROGRESS_TTL = 30;       
const RUG_CHECK_TTL      = 600;      
const HOT_CACHE_KEY      = 'caller:hot_scored_tokens';
const HOT_CACHE_TTL      = 60;       

const dexClient = axios.create({
    baseURL: 'https://api.dexscreener.com',
    timeout: 6000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
});

const pumpClient = axios.create({
    baseURL: 'https://frontend-api.pump.fun',
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
});

async function mapParallel<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIdx = 0;

    async function worker() {
        while (true) {
            const i = nextIdx++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker)
    );
    return results;
}

async function fetchTrendingPairs(): Promise<any[]> {
    try {
        const res = await dexClient.get('/token-profiles/latest/v1', { timeout: 5000 });
        const profiles: any[] = Array.isArray(res.data) ? res.data : [];
        const solanaMints = profiles
            .filter(p => p.chainId === 'solana')
            .slice(0, 20)
            .map(p => p.tokenAddress)
            .filter(Boolean);

        if (solanaMints.length === 0) return [];

        const pairRes = await dexClient.get(
            `/latest/dex/tokens/${solanaMints.join(',')}`,
            { timeout: 6000 }
        );
        return (pairRes.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    } catch (_) { return []; }
}

async function fetchNewSolanaPairs(): Promise<any[]> {
    try {
        const res = await dexClient.get('/latest/dex/search?q=solana&sort=trending', { timeout: 5000 });
        const pairs: any[] = res.data?.pairs || [];
        return pairs.filter(p => p.chainId === 'solana').slice(0, 30);
    } catch (_) { return []; }
}

async function fetchPumpKothPairs(): Promise<any[]> {
    try {
        const res = await pumpClient.get(
            '/coins/king-of-the-hill?offset=0&limit=20&includeNsfw=false',
            { timeout: 5000 }
        );
        const coins: any[] = Array.isArray(res.data) ? res.data : [];
        if (coins.length === 0) return [];

        const mints = coins
            .filter(c => c.mint)
            .slice(0, 20)
            .map(c => c.mint);

        if (mints.length === 0) return [];

        const pairRes = await dexClient.get(
            `/latest/dex/tokens/${mints.join(',')}`,
            { timeout: 6000 }
        );
        return (pairRes.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    } catch (_) { return []; }
}

async function fetchBoostedPairs(): Promise<any[]> {
    try {
        const res = await dexClient.get('/token-boosts/top/v1', { timeout: 5000 });
        const profiles: any[] = (Array.isArray(res.data) ? res.data : [])
            .filter((p: any) => p.chainId === 'solana');
        if (profiles.length === 0) return [];

        const mints = profiles.slice(0, 25).map((p: any) => p.tokenAddress).filter(Boolean);
        const pairRes = await dexClient.get(
            `/latest/dex/tokens/${mints.join(',')}`,
            { timeout: 6000 }
        );
        return (pairRes.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    } catch (_) { return []; }
}

async function getCachedCurveProgress(
    mint: string
): Promise<{ progress: number; curveScore: number; reason: string | null }> {
    const key = `curve_progress:${mint}`;
    try {
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);
    } catch (_) {}

    try {
        const curvePda = getBondingCurveAddress(mint);
        const accInfo  = await connection.getAccountInfo(new PublicKey(curvePda));
        let result = { progress: 0, curveScore: 0, reason: null as string | null };

        if (accInfo?.data) {
            const buf               = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
            const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
            const progress          = Math.min(100, (virtualSolReserves / 85) * 100);

            if (progress > 80) {
                result = { progress, curveScore: 20, reason: `🔥 Curve ${progress.toFixed(0)}% to graduation` };
            } else if (progress > 50) {
                result = { progress, curveScore: 10, reason: null };
            }
        }

        await redis.set(key, JSON.stringify(result), 'EX', CURVE_PROGRESS_TTL);
        return result;
    } catch (_) {
        return { progress: 0, curveScore: 0, reason: null };
    }
}

async function getCachedRugStatus(mint: string): Promise<boolean> {
    const key = `rug_status:${mint}`;
    try {
        const cached = await redis.get(key);
        if (cached !== null) return cached === 'true';
    } catch (_) {}

    const isRug = await checkTokenRugRisk(mint);
    await redis.set(key, isRug ? 'true' : 'false', 'EX', RUG_CHECK_TTL).catch(() => {});
    return isRug;
}

async function scorePair(pair: any, source: string): Promise<TokenScore | null> {
    try {
        if (!pair?.baseToken?.address || !pair?.baseToken?.symbol) return null;

        const mint   = pair.baseToken.address as string;
        const symbol = pair.baseToken.symbol  as string;

        const reasons:  string[] = [];
        const warnings: string[] = [];

        const ageMins = pair.pairCreatedAt
            ? (Date.now() - pair.pairCreatedAt) / 60000
            : 999;

        let ageScore = 0;
        if      (ageMins < 10)  { ageScore = 25; reasons.push(`🆕 Ultra fresh (${ageMins.toFixed(0)}m old)`); }
        else if (ageMins < 30)  { ageScore = 20; reasons.push(`⏱️ Very fresh (${ageMins.toFixed(0)}m old)`); }
        else if (ageMins < 120) { ageScore = 10; }

        const priceChangeM5 = pair.priceChange?.m5  ?? 0;
        const priceChangeH1 = pair.priceChange?.h1  ?? 0;

        let momentumBonus = 0;
        const bestMomentum = Math.max(Math.abs(priceChangeM5), Math.abs(priceChangeH1) / 12);
        if (bestMomentum > 200) {
            momentumBonus = 20;
            reasons.push(`🚀 Extreme momentum (+${priceChangeM5.toFixed(0)}% 5m | +${priceChangeH1.toFixed(0)}% 1h)`);
        } else if (bestMomentum > 50) {
            momentumBonus = 12;
            reasons.push(`📈 Strong momentum (+${priceChangeM5.toFixed(0)}% 5m)`);
        } else if (bestMomentum > 20) {
            momentumBonus = 6;
        }

        if (priceChangeM5 < -20 || priceChangeH1 < -30) {
            warnings.push(`📉 Negative price action (${priceChangeM5.toFixed(0)}% 5m)`);
        }

        const vol5m       = pair.volume?.m5  || 0;
        const vol1h       = pair.volume?.h1  || 0.1;
        const vol24h      = pair.volume?.h24 || 0;
        const spikeRatio  = vol1h > 0 ? (vol5m * 12) / vol1h : 0;

        let volumeSpike = 0;
        if (spikeRatio > 3.0) {
            volumeSpike = 20;
            reasons.push(`⚡ Massive vol spike (${(spikeRatio).toFixed(1)}x above 1h avg)`);
        } else if (spikeRatio > 2.0) {
            volumeSpike = 15;
            reasons.push(`📊 High vol spike (${(spikeRatio).toFixed(1)}x)`);
        } else if (spikeRatio > 1.2) {
            volumeSpike = 8;
        }

        if (vol24h > 0) {
            reasons.push(`💹 24h Vol: $${vol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        }

        const buys    = pair.txns?.h1?.buys  || pair.txns?.m5?.buys  || 0;
        const sells   = pair.txns?.h1?.sells || pair.txns?.m5?.sells || 0;
        const totalTx = buys + sells;
        const buyRatio = totalTx > 0 ? buys / totalTx : 0;

        let buySellRatio = 0;
        if (buyRatio > 0.70) {
            buySellRatio = 15;
            reasons.push(`🟢 Heavy buy pressure (${(buyRatio * 100).toFixed(0)}% buys)`);
        } else if (buyRatio > 0.55) {
            buySellRatio = 8;
        } else if (buyRatio < 0.35) {
            buySellRatio = -10;
            warnings.push(`🔴 Heavy sell pressure (${(100 - buyRatio * 100).toFixed(0)}% sells)`);
        }

        const liq = pair.liquidity?.usd || 0;
        let liquidityDepth = 0;
        if      (liq > 100000) { liquidityDepth = 15; reasons.push(`💧 Deep liq ($${(liq/1000).toFixed(0)}k)`); }
        else if (liq > 50000)  { liquidityDepth = 10; reasons.push(`💧 Good liq ($${(liq/1000).toFixed(0)}k)`); }
        else if (liq > 10000)  { liquidityDepth = 5;  }
        else if (liq < 1000)   { warnings.push(`⚠️ Very low liquidity (<$1k)`); }

        let curveProgress = 0;
        if (mint.toLowerCase().endsWith('pump')) {
            const curveResult = await getCachedCurveProgress(mint);
            curveProgress = curveResult.curveScore;
            if (curveResult.reason) reasons.push(curveResult.reason);
        }

        const prelimScore = volumeSpike + buySellRatio + liquidityDepth + ageScore + curveProgress + momentumBonus;

        let safetyScore = 0;
        if (prelimScore >= 25) {
            const isRug = await getCachedRugStatus(mint);
            if (isRug) {
                safetyScore = -25;
                warnings.push(`🚨 RugCheck: HIGH RISK`);
            } else {
                safetyScore = 10;
                reasons.push(`✅ RugCheck: Safe`);
            }
        }

        const totalScore = Math.min(100, Math.max(0, prelimScore + safetyScore));

        return {
            mint, symbol, totalScore, ageMins, priceChangeM5, priceChangeH1,
            breakdown: { volumeSpike, buySellRatio, liquidityDepth, ageScore, mevRisk: safetyScore, curveProgress, momentumBonus },
            reasons, warnings, source
        };
    } catch (_) {
        return null;
    }
}

export async function scoreTokens(): Promise<TokenScore[]> {
    try {
        const [trendingPairs, newPairs, kothPairs, boostedPairs] = await Promise.all([
            fetchTrendingPairs(),
            fetchNewSolanaPairs(),
            fetchPumpKothPairs(),
            fetchBoostedPairs(),
        ]);

        const tagged: Array<{ pair: any; source: string }> = [
            ...trendingPairs.map(p => ({ pair: p, source: 'trending'  })),
            ...newPairs.map(p =>      ({ pair: p, source: 'new-pairs' })),
            ...kothPairs.map(p =>     ({ pair: p, source: 'pump-koth' })),
            ...boostedPairs.map(p =>  ({ pair: p, source: 'boosted'   })),
        ];

        const seenMints = new Set<string>();
        const deduped   = tagged.filter(({ pair }) => {
            const mint = pair?.baseToken?.address;
            if (!mint || seenMints.has(mint)) return false;
            seenMints.add(mint);
            return true;
        });

        console.log(`⚡ [CALLER] Scoring ${deduped.length} unique pairs from 4 sources...`);

        const scored = await mapParallel(deduped, 12, async ({ pair, source }) => {
            return await scorePair(pair, source);
        });

        const results = scored
            .filter((s): s is TokenScore => s !== null)
            .sort((a, b) => b.totalScore - a.totalScore);

        console.log(`✅ [CALLER] Scored ${results.length} tokens. Top score: ${results[0]?.totalScore ?? 0}`);
        return results;
    } catch (e: any) {
        console.error(`🔴 [CALLER] scoreTokens exception: ${e.message}`);
        return [];
    }
}

let hotCacheRefreshing = false;

async function refreshHotCache(): Promise<void> {
    if (hotCacheRefreshing) return; 
    hotCacheRefreshing = true;
    try {
        const tokens = await scoreTokens();
        if (tokens.length > 0) {
            await redis.set(HOT_CACHE_KEY, JSON.stringify(tokens), 'EX', HOT_CACHE_TTL);
        }
    } catch (e: any) {
        console.error(`🔴 [CALLER] Hot cache refresh failed: ${e.message}`);
    } finally {
        hotCacheRefreshing = false;
    }
}

async function getHotCache(): Promise<TokenScore[]> {
    try {
        const raw = await redis.get(HOT_CACHE_KEY);
        if (raw) return JSON.parse(raw) as TokenScore[];
    } catch (_) {}
    return [];
}

async function runNotificationPass(bot: any): Promise<void> {
    
    
    try {
        const topTokens = await getHotCache();
        if (topTokens.length === 0) return;

        const subscribedUsers = await prisma.user.findMany({ select: { telegramId: true } });

        const userFilters = await Promise.all(
            subscribedUsers.map(async u => ({
                telegramId: u.telegramId,
                filters:    await getUserCallerFilters(u.telegramId)
            }))
        );

        const activeUsers = userFilters.filter(u => u.filters.isActive);
        if (activeUsers.length === 0) return;

        await Promise.all(activeUsers.map(async ({ telegramId, filters }) => {
            try {
                const matchedToken = topTokens.find(t => {
                    if (t.totalScore < filters.minScore) return false;
                    if (t.ageMins > filters.maxAgeMins) return false;
                    if (filters.blockMev && t.breakdown.mevRisk < 0) return false;

                    const effectiveMomentum = Math.max(t.priceChangeM5, t.priceChangeH1 / 12);
                    if (effectiveMomentum < filters.minPctChange) return false;
                    if (effectiveMomentum > filters.maxPctChange)  return false;

                    return true;
                });

                if (!matchedToken) return;

                const lockKey     = `caller_notified:${telegramId}:${matchedToken.mint}`;
                const isNotified  = await redis.set(lockKey, '1', 'EX', 86400, 'NX');
                if (!isNotified) return;

                const botName = process.env.BOT_NAME || 'Sentry Terminal';

                let msg = `🎯 <b>${botName.toUpperCase()} — ALPHA ALERT</b>\n\n` +
                          `<b>Token:</b> $${matchedToken.symbol}\n` +
                          `<code>${matchedToken.mint}</code>\n\n` +
                          `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n` +
                          `<b>Age:</b> ${matchedToken.ageMins.toFixed(0)} mins\n` +
                          `<b>5m Change:</b> ${matchedToken.priceChangeM5 >= 0 ? '+' : ''}${matchedToken.priceChangeM5.toFixed(1)}%\n` +
                          `<b>1h Change:</b> ${matchedToken.priceChangeH1 >= 0 ? '+' : ''}${matchedToken.priceChangeH1.toFixed(1)}%\n` +
                          `<b>Source:</b> <code>${matchedToken.source}</code>\n\n` +
                          `${matchedToken.reasons.map(r => `✅ ${r}`).join('\n')}\n`;

                if (matchedToken.warnings && matchedToken.warnings.length > 0) {
                    msg += `${matchedToken.warnings.map(w => `⚠️ ${w}`).join('\n')}\n`;
                }

                msg += `\n<i>Click below to act instantly:</i>`;

                await bot.telegram.sendMessage(telegramId, msg, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '⚡ Snipe 0.1 SOL',    callback_data: `forcebuy_${matchedToken.mint}_0.1` },
                                { text: '📊 DexScreener',      url: `https://dexscreener.com/solana/${matchedToken.mint}` }
                            ],
                            [
                                { text: '🛡️ Deploy Guard',    callback_data: `caller_guard_${matchedToken.mint}` },
                                { text: '⏳ Start DCA',        callback_data: `caller_dca_${matchedToken.mint}` }
                            ],
                            [
                                { text: '⬅️ Caller Menu',     callback_data: 'menu_caller' }
                            ]
                        ]
                    }
                }).catch(() => null);

            } catch (_) {}
        }));

    } catch (e: any) {
        console.error(`🔴 [CALLER] Notification pass error: ${e.message}`);
    }
}

export async function startCoinCaller(bot: any): Promise<void> {
    console.log(`⚡ [CALLER] Multi-source parallel scanner v3 initialized.`);
    console.log(`   Sources: trending + new-pairs + pump-koth + boosted`);
    console.log(`   Hot cache refresh: every 12s | Notification pass: every 5s`);

    refreshHotCache().catch(() => {});

    setInterval(() => {
        refreshHotCache().catch(() => {});
    }, 12_000);

    setInterval(() => {
        runNotificationPass(bot).catch(() => {});
    }, 5_000);
}