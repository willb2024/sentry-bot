// src/services/caller.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';
import axios from 'axios';
import { checkTokenRugRisk } from './price.service.js';
import { getRecentNewMints } from './grpc.service.js';

const prisma = new PrismaClient();

export interface CallerFilters {
    isActive: boolean;
    minScore: number;
    maxAgeMins: number;
    minPctChange: number;
    maxPctChange: number;
    minLiquidity: number; 
    minVolume24h: number; 
    blockMev: boolean;
}

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    const defaultFilters: CallerFilters = {
        isActive: false,
        minScore: 75,
        maxAgeMins: 60,
        minPctChange: 10,
        maxPctChange: 500,
        minLiquidity: 3000, 
        minVolume24h: 5000, 
        blockMev: true
    };

    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        if (raw) return { ...defaultFilters, ...JSON.parse(raw) };
    } catch (e) {}

    return defaultFilters;
}

export async function startCoinCaller(bot: any) {
    console.log("🎯 [CALLER ENGINE] Initialized. Scanning 5 distinct pipelines every 15 seconds.");

    setInterval(async () => {
        if (isScoring) return;
        isScoring = true;

        try {
            const tokens = await scoreTokens();
            if (tokens.length === 0) return;

            const allUsers = await prisma.user.findMany({ select: { telegramId: true } });
            
            for (const user of allUsers) {
                const filters = await getUserCallerFilters(user.telegramId);
                if (!filters.isActive) continue;

                const matchingTokens = tokens.filter(t => 
                    t.totalScore >= filters.minScore &&
                    t.ageMins <= filters.maxAgeMins &&
                    // 🟢 MOMENTUM FIX: Exempt fresh on-chain tokens since they don't have 5-min candles yet
                    (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange)) &&
                    // 🟢 VOLUME FIX: Exempt on-chain tokens from volume, check liquidity instead
                    ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) || 
                     (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
                    t.liquidity >= filters.minLiquidity && // Global minimum liquidity check
                    (!filters.blockMev || (t.breakdown && t.breakdown.mevRisk >= 0))
                );

                let matchedToken = null;
                
                for (const t of matchingTokens) {
                    const alertKey = `caller_alerted:${user.telegramId}:${t.mint}`;
                    const alreadyAlerted = await redis.get(alertKey);
                    if (!alreadyAlerted) {
                        matchedToken = t;
                        await redis.set(alertKey, '1', 'EX', 3600 * 24); 
                        break; 
                    }
                }

                if (matchedToken) {
                    const historyData = {
                        mint: matchedToken.mint,
                        symbol: matchedToken.symbol,
                        score: matchedToken.totalScore,
                        priceAtAlert: matchedToken.price,
                        alertedAt: Date.now()
                    };
                    await redis.hset(`caller_history`, matchedToken.mint, JSON.stringify(historyData));

                    let historicalContext = "";
                    try {
                        const historyMap = await redis.hgetall('caller_history');
                        const calls = Object.values(historyMap).map(val => JSON.parse(val)).filter(c => c.finalized && c.score >= 75);
                        if (calls.length >= 5) { 
                            const hits = calls.filter(c => Math.max(c.outcome1h || -100, c.outcome6h || -100, c.outcome24h || -100) >= 20).length;
                            const winRate = ((hits / calls.length) * 100).toFixed(1);
                            historicalContext = `<i>(Based on ${calls.length} verified alerts, coins scoring 75+ have a ${winRate}% win rate hitting +20%).</i>\n\n`;
                        }
                    } catch(e) {}

                    const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                                `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                                `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n\n` +
                                `<b>Audit Trail:</b>\n` +
                                `${matchedToken.reasons.map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
                                historicalContext +
                                `<i>Click below to buy instantly via Jito:</i>`;
                    
                    try {
                        await bot.telegram.sendMessage(user.telegramId, msg, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${matchedToken.mint}_0.1` },
                                        { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }
                                    ],
                                    [
                                        { text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` },
                                        { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }
                                    ],
                                    [{ text: '⬅️ Manage Caller Settings', callback_data: 'menu_caller' }]
                                ]
                            }
                        });
                    } catch (e: any) {
                        console.warn(`⚠️ [CALLER] Failed to send to ${user.telegramId}: ${e.message}`);
                    }
                }
            }
        } catch (e) {
        } finally {
            isScoring = false;
        }
    }, 15000);
}

export async function setUserCallerFilters(telegramId: string, updates: Partial<CallerFilters>) {
    const current = await getUserCallerFilters(telegramId);
    const updated = { ...current, ...updates };
    await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
    return updated;
}

async function getCachedRugStatus(mint: string): Promise<{ isRug: boolean; top10Pct: number }> {
    const { getTokenRiskDetails } = await import('./price.service.js');
    const details = await getTokenRiskDetails(mint);
    return { isRug: details.isUnsafe, top10Pct: details.top10Pct };
}

// 🟢 PIPELINE 1: WebSocket Buffer
async function fetchRecentNewMints() {
    const rawMints = getRecentNewMints();
    if (rawMints.length === 0) return [];

    const enrichedTokens: any[] = [];
    const mintsOnly = rawMints.map((m: any) => m.mint);
    
    const chunks: string[] = [];
    for (let i = 0; i < mintsOnly.length; i += 30) {
        chunks.push(mintsOnly.slice(i, i + 30).join(','));
    }

    const results = await Promise.all(chunks.map(chunk =>
        axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`, { timeout: 3000 }).catch(() => null)
    ));

    results.forEach(res => {
        if (res?.data?.pairs) {
            res.data.pairs.forEach((pair: any) => {
                enrichedTokens.push({
                    mint: pair.baseToken.address,
                    symbol: pair.baseToken.symbol,
                    price: parseFloat(pair.priceUsd || "0"),
                    volume: pair.volume?.h24 || 0,
                    liquidity: pair.liquidity?.usd || 0,
                    priceChangeM5: pair.priceChange?.m5 || 0,
                    priceChangeH1: pair.priceChange?.h1 || 0,
                    pairCreatedAt: pair.pairCreatedAt || Date.now(),
                    socials: pair.info?.socials || [],
                    sourceQuality: 'dexscreener'
                });
            });
        }
    });

    const missing = mintsOnly.filter(m => !enrichedTokens.some(e => e.mint === m));
    if (missing.length > 0) {
        try {
            const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
            const { connection } = await import('../lib/connection.js');
            const { PublicKey } = await import('@solana/web3.js');
            const { cachedSolUsdPrice } = await import('./grpc.service.js');

            for (let i = 0; i < missing.length; i += 100) {
                const mintChunk = missing.slice(i, i + 100);
                const pdaChunk = mintChunk.map(m => new PublicKey(getBondingCurveAddress(m)));

                const accInfos = await connection.getMultipleAccountsInfo(pdaChunk).catch(() => null);
                if (!accInfos) continue;

                accInfos.forEach((accInfo, idx) => {
                    if (!accInfo?.data) return;
                    const mint = mintChunk[idx];
                    const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                    
                    const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                    const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                    
                    enrichedTokens.push({
                        mint,
                        symbol: rawMints.find((m: any) => m.mint === mint)?.symbol || 'UNKNOWN',
                        price: decodePumpCurvePrice(buf.toString('base64')) * cachedSolUsdPrice,
                        volume: realSolReserves * cachedSolUsdPrice * 2, 
                        liquidity: virtualSolReserves * cachedSolUsdPrice,
                        priceChangeM5: 0,
                        pairCreatedAt: rawMints.find((m: any) => m.mint === mint)?.firstSeenAt || Date.now(),
                        socials: [],
                        sourceQuality: 'onchain-only'
                    });
                });
            }
        } catch (e: any) {
            console.error(`🔴 [CALLER] Onchain fallback fatal: ${e.message}`);
        }
    }
    return enrichedTokens;
}

// 🟢 PIPELINE 2: Direct Pump.fun API 
async function fetchFreshPumpTokens() {
    try {
        const res = await axios.get('https://frontend-api.pump.fun/coins/latest', { timeout: 3500 });
        if (!Array.isArray(res.data)) return [];

        const now = Date.now();
        const recentPump = res.data.filter((c: any) => c.created_timestamp && (now - c.created_timestamp) < 20 * 60 * 1000).slice(0, 30);
        if (recentPump.length === 0) return [];

        const mints = recentPump.map((c: any) => c.mint).join(',');
        const enrich = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 3000 }).catch(() => null);
        
        const enrichedTokens: any[] = [];
        const dsPairs = enrich?.data?.pairs || [];

        for (const coin of recentPump) {
            const dsPair = dsPairs.find((p: any) => p.baseToken.address === coin.mint);
            if (dsPair) {
                enrichedTokens.push({
                    mint: dsPair.baseToken.address, symbol: dsPair.baseToken.symbol,
                    price: parseFloat(dsPair.priceUsd || "0"), volume: dsPair.volume?.h24 || 0, liquidity: dsPair.liquidity?.usd || 0,
                    priceChangeM5: dsPair.priceChange?.m5 || 0, priceChangeH1: dsPair.priceChange?.h1 || 0,
                    pairCreatedAt: dsPair.pairCreatedAt || coin.created_timestamp, socials: dsPair.info?.socials || [],
                    sourceQuality: 'pump-fallback'
                });
            } else {
                const { cachedSolUsdPrice } = await import('./grpc.service.js');
                const virtualSolReserves = coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1_000_000_000) : 30;
                const realSolReserves = coin.real_sol_reserves ? (coin.real_sol_reserves / 1_000_000_000) : 0;

                enrichedTokens.push({
                    mint: coin.mint, symbol: coin.symbol || 'UNKNOWN',
                    price: coin.usd_market_cap ? (coin.usd_market_cap / 1_000_000_000) : 0, 
                    volume: realSolReserves * cachedSolUsdPrice * 2, 
                    liquidity: virtualSolReserves * cachedSolUsdPrice,
                    priceChangeM5: 0, priceChangeH1: 0,
                    pairCreatedAt: coin.created_timestamp, socials: [],
                    sourceQuality: 'onchain-only'
                });
            }
        }
        return enrichedTokens;
    } catch (_) { return []; }
}

// 🟢 PIPELINE 3: DexScreener Latest Profile Submissions
async function fetchFreshViaRest() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 30).join(',');
        const enrich = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 3000 });

        const now = Date.now();
        return (enrich.data?.pairs || []).map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol,
            price: parseFloat(pair.priceUsd || "0"), volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0,
            priceChangeM5: pair.priceChange?.m5 || 0, priceChangeH1: pair.priceChange?.h1 || 0,
            pairCreatedAt: pair.pairCreatedAt || now, socials: pair.info?.socials || [],
            sourceQuality: 'rest-fallback'
        })).filter((t: any) => (now - t.pairCreatedAt) < 30 * 60 * 1000); 
    } catch (_) { return []; }
}

// 🟢 PIPELINES 4 & 5: Established Momentum (Trending / Boosted)
async function fetchTrendingPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 30).join(',');
        const enrich = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 3000 });
        return enrich.data?.pairs?.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || Date.now(), socials: pair.info?.socials || []
        })) || [];
    } catch (_) { return []; }
}

async function fetchBoostedPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 30).join(',');
        const enrich = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 3000 });
        return enrich.data?.pairs?.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || Date.now(), socials: pair.info?.socials || []
        })) || [];
    } catch (_) { return []; }
}

// --- NEW DEFENSIVE PIPELINES ---

export async function getDevReputation(creatorWallet: string): Promise<{ launchCount: number; avgRugScore: number; isKnownRugger: boolean }> {
    const cacheKey = `dev_rep:${creatorWallet}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        const sigs = await connection.getSignaturesForAddress(new PublicKey(creatorWallet), { limit: 20 });

        let rugCount = 0;
        for (const sig of sigs) {
            const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
            if (!tx?.meta) continue;
            // crude proxy: if this wallet's SOL balance dropped >90% within the tx window shortly after, flag as rug-like
            const pre = tx.meta.preBalances?.[0] || 0;
            const post = tx.meta.postBalances?.[0] || 0;
            if (pre > 0 && (pre - post) / pre > 0.9) rugCount++;
        }

        const result = {
            launchCount: sigs.length,
            avgRugScore: sigs.length > 0 ? rugCount / sigs.length : 0,
            isKnownRugger: rugCount >= 2
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
        return result;
    } catch (_) {
        return { launchCount: 0, avgRugScore: 0, isKnownRugger: false };
    }
}

export async function checkLpLockStatus(mintAddress: string): Promise<{ locked: boolean; burned: boolean; lockPct: number }> {
    const cacheKey = `lp_lock:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const BURN_ADDRESS = "11111111111111111111111111111111";
    const STREAMFLOW_PROGRAM = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        // requires the LP mint address for the pool — assume resolved upstream and passed in via lpMint
        const largest = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
        const top = largest.value[0];
        if (!top) return { locked: false, burned: false, lockPct: 0 };

        const ownerInfo = await connection.getParsedAccountInfo(top.address);
        const owner = (ownerInfo.value?.data as any)?.parsed?.info?.owner || '';
        const pct = (top.uiAmount || 0) / (largest.value.reduce((s, v) => s + (v.uiAmount || 0), 0) || 1) * 100;

        const result = {
            burned: owner === BURN_ADDRESS,
            locked: owner === STREAMFLOW_PROGRAM,
            lockPct: pct
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    } catch (_) {
        return { locked: false, burned: false, lockPct: 0 };
    }
}

export async function trackHolderVelocity(mintAddress: string): Promise<{ growthRate: number; uniqueBuyers5m: number }> {
    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        const largest = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
        const currentCount = largest.value.filter(v => (v.uiAmount || 0) > 0).length;

        const snapshotKey = `holder_snapshots:${mintAddress}`;
        const now = Date.now();
        await redis.zadd(snapshotKey, now, `${now}:${currentCount}`);
        await redis.expire(snapshotKey, 3600);

        const fiveMinAgo = now - 5 * 60 * 1000;
        const oldEntries = await redis.zrangebyscore(snapshotKey, fiveMinAgo, fiveMinAgo + 60000);
        const oldCount = oldEntries.length > 0 ? parseInt(oldEntries[0].split(':')[1]) : currentCount;

        const growthRate = oldCount > 0 ? ((currentCount - oldCount) / oldCount) * 100 : 0;
        return { growthRate, uniqueBuyers5m: Math.max(0, currentCount - oldCount) };
    } catch (_) {
        return { growthRate: 0, uniqueBuyers5m: 0 };
    }
}

export async function simulateSellability(mintAddress: string): Promise<{ sellable: boolean; estimatedTaxPct: number }> {
    const cacheKey = `sellable:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const axios = (await import('axios')).default;
        const testAmount = "1000"; // tiny raw unit sell
        const quoteRes = await axios.get(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${testAmount}&autoSlippage=true`,
            { timeout: 3500 }
        ).catch(() => null);

        if (!quoteRes?.data?.outAmount) {
            const result = { sellable: false, estimatedTaxPct: 100 };
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
            return result;
        }

        const priceImpact = parseFloat(quoteRes.data.priceImpactPct || "0") * 100;
        const result = { sellable: priceImpact < 15, estimatedTaxPct: priceImpact };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
        return result;
    } catch (_) {
        return { sellable: false, estimatedTaxPct: 100 };
    }
}

export interface TokenStats {
    ageMins: number;
    volume24h: number;
    liquidity: number;
    priceChangeM5: number;
    hasSocials: boolean;
    isRug: boolean;
    sourceQuality?: string;
}

export function computeTokenScore(stats: TokenStats): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    reasons.push(`🕒 Age: ${Math.floor(stats.ageMins)}m`);
    if (stats.ageMins < 60) score += 30; 
    else if (stats.ageMins < 180) score += 15;

    reasons.push(`💰 Vol: $${(stats.volume24h/1000).toFixed(1)}k`);
    if (stats.volume24h > 100000) score += 25; 
    else if (stats.volume24h > 20000) score += 10;

    if (stats.liquidity > 0) {
        const volToLiqRatio = stats.volume24h / stats.liquidity;
        if (volToLiqRatio > 25) {
            score -= 25;
            reasons.push(`🚨 Vol/Liq ratio ${volToLiqRatio.toFixed(1)}x — likely wash-traded`);
        } else if (volToLiqRatio > 12) {
            score -= 10;
            reasons.push(`⚠️ High Vol/Liq ratio ${volToLiqRatio.toFixed(1)}x`);
        }
    }

    reasons.push(`📈 Mom: +${stats.priceChangeM5.toFixed(1)}%`);
    if (stats.priceChangeM5 > 15 && stats.priceChangeM5 <= 60) score += 20;
    else if (stats.priceChangeM5 > 60 && stats.priceChangeM5 <= 150) score += 12;
    else if (stats.priceChangeM5 > 150) { score += 3; reasons.push(`⚠️ Parabolic — elevated reversal risk`); }

    reasons.push(`💧 Liq: $${(stats.liquidity/1000).toFixed(1)}k`);
    if (stats.liquidity > 20000) score += 15;
    else if (stats.liquidity < 3000) { score -= 10; reasons.push(`⚠️ Thin liquidity — high slippage risk`); }

    if (stats.hasSocials) { score += 10; reasons.push(`🌐 Socials present`); }

    if (stats.isRug) { score -= 100; reasons.push(`🚨 Rug risk flagged`); }

    if (stats.sourceQuality === 'onchain-only') {
        score -= 8;
        reasons.push(`⛓️ Unindexed (early, unverified)`);
    }

    return { score: Math.max(0, score), reasons };
}

// 🟢 MERGE AND SCORE (WITH UNIVERSAL ZERO-FIXER)
export async function scoreTokens() {
    try {
        const [newMints, pumpFallback, restFallback, boosted] = await Promise.all([
            fetchRecentNewMints(),
            fetchFreshPumpTokens(),
            fetchFreshViaRest().catch(()=>[]),
            fetchBoostedPairs().catch(()=>[])
        ]);

        const allPairs = [...newMints, ...pumpFallback, ...restFallback, ...boosted];
        
        const sourceRank: Record<string, number> = { 'dexscreener': 3, 'pump-fallback': 3, 'rest-fallback': 2, 'onchain-only': 1 };
        const mergedMap = new Map<string, any>();
        
        for (const item of allPairs) {
            const existing = mergedMap.get(item.mint);
            if (!existing || (sourceRank[item.sourceQuality || 'onchain-only'] || 1) > (sourceRank[existing.sourceQuality || 'onchain-only'] || 1)) {
                mergedMap.set(item.mint, item);
            }
        }
        const uniquePairs = Array.from(mergedMap.values());

        const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        const { cachedSolUsdPrice } = await import('./grpc.service.js');

        const needsFix = uniquePairs.filter(p => (p.liquidity === 0 || p.volume === 0) && p.mint.toLowerCase().endsWith('pump'));

        if (needsFix.length > 0) {
            for (let i = 0; i < needsFix.length; i += 100) {
                const chunk = needsFix.slice(i, i + 100);
                const pdas = chunk.map(p => new PublicKey(getBondingCurveAddress(p.mint)));
                
                const accInfos = await connection.getMultipleAccountsInfo(pdas).catch(() => null);
                if (accInfos) {
                    accInfos.forEach((acc, idx) => {
                        if (acc?.data) {
                            const buf = Buffer.isBuffer(acc.data) ? acc.data : Buffer.from(acc.data);
                            if (buf.length >= 40) {
                                const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                                const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                                
                                const liqUsd = virtualSolReserves * cachedSolUsdPrice;
                                const volUsd = realSolReserves * cachedSolUsdPrice * 2; 

                                if (chunk[idx].liquidity === 0) chunk[idx].liquidity = liqUsd;
                                if (chunk[idx].volume === 0) chunk[idx].volume = volUsd;
                                if (chunk[idx].price === 0) {
                                    chunk[idx].price = decodePumpCurvePrice(buf.toString('base64')) * cachedSolUsdPrice;
                                }
                            }
                        }
                    });
                }
            }
        }

        const scored = await Promise.all(uniquePairs.map(async (pair) => {
            const { isRug, top10Pct } = await getCachedRugStatus(pair.mint);
            const stats: TokenStats = {
                ageMins: (Date.now() - pair.pairCreatedAt) / 60000,
                volume24h: pair.volume,
                liquidity: pair.liquidity,
                priceChangeM5: pair.priceChangeM5,
                hasSocials: pair.socials.length > 0,
                isRug,
                sourceQuality: pair.sourceQuality
            };

            const { score, reasons } = computeTokenScore(stats);

            let concentrationAdjustedScore = score;
            if (!isRug && top10Pct > 25) {
                concentrationAdjustedScore -= Math.floor((top10Pct - 25) * 1.5);
                reasons.push(`⚠️ Top 10 holders own ${top10Pct.toFixed(1)}%`);
            }

            return { ...pair, totalScore: Math.max(0, concentrationAdjustedScore), ageMins: stats.ageMins, reasons, breakdown: { mevRisk: isRug ? -100 : 0 } };
        }));

        const topScorers = scored.filter(t => t.totalScore >= 40).sort((a, b) => b.totalScore - a.totalScore);

        // Stage 2: expensive checks only on tokens that already cleared 40
        const enriched = await Promise.all(topScorers.slice(0, 20).map(async (t) => {
            const [sellability] = await Promise.all([
                simulateSellability(t.mint)
                // dev reputation & LP lock require creator wallet / lp mint resolution upstream;
                // wire in here once those addresses are available from the pair source
            ]);

            if (!sellability.sellable) {
                return { ...t, totalScore: 0, reasons: [...t.reasons, `🚨 Honeypot/unsellable (tax ${sellability.estimatedTaxPct.toFixed(0)}%)`] };
            }
            return t;
        }));

        const final = [...enriched, ...scored.filter(t => t.totalScore > 0 && t.totalScore < 40)]
            .sort((a, b) => b.totalScore - a.totalScore);

        await redis.set('caller:hot_scored_tokens', JSON.stringify(final), 'EX', 30);
        return final;
    } catch (e: any) {
        console.error("🔴 [CALLER] Engine Error:", e.message);
        return [];
    }
}

let isScoring = false;

// 🟢 Authentic Hit Rate Evaluator Job
export function startCallerEvaluator() {
    setInterval(async () => {
        try {
            const historyMap = await redis.hgetall('caller_history');
            const now = Date.now();

            for (const [mint, val] of Object.entries(historyMap)) {
                const data = JSON.parse(val);
                if (data.finalized) continue;

                const ageHours = (now - data.alertedAt) / 3600000;
                
                if (ageHours >= 1) {
                    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3000 }).catch(() => null);
                    const currentPrice = parseFloat(res?.data?.pairs?.[0]?.priceUsd || "0");

                    if (currentPrice > 0) {
                        const pctChange = ((currentPrice - data.priceAtAlert) / data.priceAtAlert) * 100;
                        if (ageHours < 6) data.outcome1h = Math.max(data.outcome1h || -100, pctChange);
                        else if (ageHours < 24) data.outcome6h = Math.max(data.outcome6h || -100, pctChange);
                        else {
                            data.outcome24h = Math.max(data.outcome24h || -100, pctChange);
                            data.finalized = true;
                        }
                        await redis.hset('caller_history', mint, JSON.stringify(data));
                    }
                }
            }
        } catch (_) {}
    }, 5 * 60 * 1000);
}