// src/services/caller.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';
import axios from 'axios';
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

// 🟢 Relaxed Default Filters to expand pool size
export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    const defaultFilters: CallerFilters = {
        isActive: false,
        minScore: 55,
        maxAgeMins: 90,
        minPctChange: 10,
        maxPctChange: 500,
        minLiquidity: 2000, 
        minVolume24h: 2000, 
        blockMev: true
    };

    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        if (raw) return { ...defaultFilters, ...JSON.parse(raw) };
    } catch (e) {}

    return defaultFilters;
}

export async function setUserCallerFilters(telegramId: string, updates: Partial<CallerFilters>) {
    const current = await getUserCallerFilters(telegramId);
    const updated = { ...current, ...updates };
    await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
    return updated;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export function humanizeMs(ms: number): string {
    const mins = ms / 60000;
    if (mins < 60) return `~${Math.round(mins)} Minutes`;
    if (mins < 1440) return `~${(mins / 60).toFixed(1)} Hours`;
    return `~${(mins / 1440).toFixed(1)} Days`;
}

export function getScoreBand(score: number): { label: string; sizeSol: string; risk: string } {
    if (score < 40) return { label: '🔵 Too Early', sizeSol: '0.01-0.02 SOL (watchlist only)', risk: 'Unproven — no real signal yet' };
    if (score < 60) return { label: '🟡 Speculative', sizeSol: '0.02-0.05 SOL', risk: 'Weak confirmation — lottery-ticket sizing' };
    if (score < 75) return { label: '🟠 Developing', sizeSol: '0.05-0.1 SOL', risk: 'Multiple signals confirmed' };
    return { label: '🟢 High Conviction', sizeSol: '0.1-0.2 SOL', risk: 'Strong confirmation across categories' };
}

export async function getCalibratedProjection(token: any) {
    const historyMap = await redis.hgetall('caller_history');
    const calls = Object.values(historyMap).map((v: any) => JSON.parse(v)).filter((c: any) => c.finalized && c.peakPct !== undefined);

    const scoreBand = 15;   
    const similar = calls.filter((c: any) =>
        Math.abs((c.score ?? 50) - (token.score ?? token.totalScore ?? 50)) <= scoreBand
    );

    if (similar.length >= 8) {
        const sortedPct = similar.map((c: any) => c.peakPct).sort((a: number, b: number) => a - b);
        const sortedTime = similar.map((c: any) => c.peakAtMs).sort((a: number, b: number) => a - b);
        const p25 = sortedPct[Math.floor(sortedPct.length * 0.25)];
        const p75 = sortedPct[Math.floor(sortedPct.length * 0.75)];
        const medianTimeMs = sortedTime[Math.floor(sortedTime.length * 0.5)];

        return {
            target: `+${Math.max(0, p25).toFixed(0)}% to +${Math.max(p25 + 1, p75).toFixed(0)}%`,
            timeframe: humanizeMs(medianTimeMs),
            volatility: `Calibrated (${similar.length} past alerts)`,
            sampleSize: similar.length,
            rawLow: Math.max(0, p25),
            rawHigh: Math.max(p25 + 1, p75),
            rawTimeMins: medianTimeMs / 60000
        };
    }

    const score = token.score ?? token.totalScore ?? 50;
    const liq = token.liquidity || 5000;
    const mom = token.priceChangeM5 || 10;
    const age = token.ageMins || 10;

    let baseMultiplier = (score / 100) * 4.5; 
    let liqMultiplier = Math.max(0.5, 20000 / Math.max(liq, 1000)); 
    let momMultiplier = 1 + (Math.min(mom, 300) / 100); 

    let minPeak = baseMultiplier * liqMultiplier * momMultiplier * 100;
    let maxPeak = minPeak * 1.5; 

    if (minPeak > 5000) minPeak = 3500;
    if (maxPeak > 10000) maxPeak = 7000;
    if (minPeak < 20) { minPeak = 20; maxPeak = 50; }

    let timeframe = "1 - 4 Hours";
    let rawTimeMins = 120;
    if (age < 15 && mom > 50) { timeframe = "10 - 30 Minutes"; rawTimeMins = 20; }
    else if (age < 60) { timeframe = "30 - 90 Minutes"; rawTimeMins = 60; }
    else if (liq > 50000) { timeframe = "12 - 24 Hours"; rawTimeMins = 720; }

    return {
        target: `+${Math.floor(minPeak).toLocaleString()}% to +${Math.floor(maxPeak).toLocaleString()}%`,
        timeframe,
        volatility: 'Preliminary Estimate (Building History)',
        sampleSize: similar.length,
        rawLow: minPeak,
        rawHigh: maxPeak,
        rawTimeMins
    };
}

let isScoring = false;

export async function startCoinCaller(bot: any) {
    console.log("🎯 [CALLER ENGINE] Initialized. Scanning distinct pipelines every 15 seconds.");

    setInterval(async () => {
        if (isScoring) {
            console.warn("⚠️ [CALLER ENGINE] Overlapping scan tick skipped. Previous scan still processing.");
            return;
        }
        isScoring = true;

        try {
            const tokens = await scoreTokens();
            if (tokens.length === 0) return;

            const allUsers = await prisma.user.findMany({ select: { telegramId: true } });
            
            for (const user of allUsers) {
                const filters = await getUserCallerFilters(user.telegramId);
                if (!filters.isActive) continue;

                let matchingTokens = tokens.filter(t => 
                    t.totalScore >= filters.minScore &&
                    t.ageMins <= filters.maxAgeMins &&
                    (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange)) &&
                    ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) || 
                     (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
                    t.liquidity >= filters.minLiquidity &&
                    (!filters.blockMev || t.breakdown.mevRisk >= 0)
                );

                // 🟢 Progressive Relaxation with Hard Safety Floors
                let isRelaxed = false;
                if (matchingTokens.length === 0) {
                    const relaxedFilters = {
                        ...filters,
                        minScore: Math.max(35, filters.minScore - 15), 
                        maxAgeMins: filters.maxAgeMins * 1.5,
                        minLiquidity: Math.max(1500, filters.minLiquidity * 0.5), 
                        minVolume24h: filters.minVolume24h * 0.5
                    };
                    matchingTokens = tokens.filter(t => 
                        t.totalScore >= relaxedFilters.minScore &&
                        t.ageMins <= relaxedFilters.maxAgeMins &&
                        (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= relaxedFilters.minPctChange && t.priceChangeM5 <= relaxedFilters.maxPctChange)) &&
                        ((t.sourceQuality !== 'onchain-only' && t.volume >= relaxedFilters.minVolume24h) || 
                         (t.sourceQuality === 'onchain-only' && t.liquidity >= relaxedFilters.minLiquidity)) &&
                        t.liquidity >= relaxedFilters.minLiquidity &&
                        (!relaxedFilters.blockMev || t.breakdown.mevRisk >= 0)
                    );
                    if (matchingTokens.length > 0) isRelaxed = true;
                }

                let matchedToken = null;
                for (const t of matchingTokens) {
                    const alertKey = `caller_alerted:${user.telegramId}:${t.mint}`;
                    const alreadyAlerted = await redis.get(alertKey);
                    if (!alreadyAlerted) {
                        matchedToken = t;
                        await redis.set(alertKey, '1', 'EX', 180); 
                        break; 
                    }
                }

                if (matchedToken) {
                    const projection = await getCalibratedProjection(matchedToken);
                    const historyData = {
                        mint: matchedToken.mint, symbol: matchedToken.symbol, score: matchedToken.totalScore,
                        priceAtAlert: matchedToken.price, alertedAt: Date.now(), tokenAgeAtAlertMins: matchedToken.ageMins,
                        predictedRangeLow: projection.rawLow, predictedRangeHigh: projection.rawHigh, predictedTimeframeMins: projection.rawTimeMins
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

                    const relaxNote = isRelaxed ? `⚠️ <i>Filters temporarily relaxed to find this match.</i>\n\n` : '';
                    const projLabel = projection.sampleSize >= 8 ? '🔮 <b>AI PROJECTION (Calibrated)</b>' : '🔮 <b>AI PROJECTION (Uncalibrated Estimate)</b>';
                    const band = getScoreBand(matchedToken.totalScore); 

                    const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                                `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                                `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n\n` +
                                `${band.label} — Suggested size: <b>${band.sizeSol}</b>\n<i>${band.risk}</i>\n\n` +
                                relaxNote +
                                `${projLabel}\n` +
                                `• Confidence: <b>${projection.volatility}</b>\n` +
                                `• Target Peak: <b>${projection.target}</b>\n` +
                                `• Est. Timeframe: <b>${projection.timeframe}</b>\n\n` +
                                `<b>Audit Trail:</b>\n` +
                                `${matchedToken.reasons.map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
                                historicalContext +
                                `<i>Click below to buy instantly via Jito:</i>`;
                    
                    try {
                        await bot.telegram.sendMessage(user.telegramId, msg, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${matchedToken.mint}_0.1` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
                                    [{ text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` }, { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }],
                                    [{ text: '⬅️ Manage Caller Settings', callback_data: 'menu_caller' }]
                                ]
                            }
                        });
                    } catch (e: any) {}
                }
            }
        } catch (e) {
        } finally {
            isScoring = false;
        }
    }, 15000);
}

// 🟢 Extended RugCheck Status with 4000ms timeout
async function getCachedRugStatus(mint: string): Promise<{ isRug: boolean; top10Pct: number; uncertain: boolean }> {
    const cacheKey = `rug_status_ext:${mint}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { timeout: 4000 });
        const data = res.data;
        const risks = data.risks || [];
        const isHoneypot = risks.some((r: any) => r.name === 'Freeze Authority still enabled');
        const isMintable = !!(data.token && data.token.mintAuthority);
        const topHolders = data.topHolders || [];
        const top10Pct = topHolders.reduce((acc: number, h: any) => acc + (h.pct || 0), 0);
        const isUnsafe = isHoneypot || isMintable || (data.score > 500) || top10Pct > 40.0;

        const result = { isRug: isUnsafe, top10Pct, uncertain: false };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    } catch (_) {
        return { isRug: false, top10Pct: 0, uncertain: true };
    }
}

// 🟢 DEDICATED SAFE FETCHER (PREVENTS 429 API BANS)
async function safeDexScreenerFetch(mints: string[]): Promise<any[]> {
    if (mints.length === 0) return [];
    const chunks = chunkArray(mints, 30);
    const allPairs: any[] = [];
    
    for (const chunk of chunks) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 3500 });
            if (res.data?.pairs) allPairs.push(...res.data.pairs);
        } catch (e: any) {
            // Silent fail to keep scanner moving
        }
        await new Promise(r => setTimeout(r, 250)); // Stagger to prevent 429s
    }
    return allPairs;
}

// 🟢 PIPELINE 1: WebSocket Buffer
async function fetchRecentNewMints() {
    const rawMints = getRecentNewMints().slice(0, 120) as any[];
    if (rawMints.length === 0) return [];

    const enrichedTokens: any[] = [];
    const mintsOnly = rawMints.map((m: any) => m.mint);
    
    const dsPairs = await safeDexScreenerFetch(mintsOnly);

    dsPairs.forEach((pair: any) => {
        enrichedTokens.push({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            priceChangeH1: pair.priceChange?.h1 || 0, pairCreatedAt: pair.pairCreatedAt || Date.now(),
            socials: pair.info?.socials || [], sourceQuality: 'dexscreener',
            creatorWallet: rawMints.find((m: any) => m.mint === pair.baseToken.address)?.creator || ''
        });
    });

    const missing = mintsOnly.filter(m => !enrichedTokens.some(e => e.mint === m));
    if (missing.length > 0) {
        try {
            const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
            const { connection } = await import('../lib/connection.js');
            const { PublicKey } = await import('@solana/web3.js');
            const { cachedSolUsdPrice } = await import('./grpc.service.js');

            const missingChunks = chunkArray(missing, 100);
            for (const mintChunk of missingChunks) {
                const pdaChunk = mintChunk.map(m => new PublicKey(getBondingCurveAddress(m)));
                const accInfos = await connection.getMultipleAccountsInfo(pdaChunk).catch(() => null);
                if (accInfos) {
                    accInfos.forEach((accInfo, idx) => {
                        if (!accInfo?.data) return;
                        const mint = mintChunk[idx];
                        const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                        const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                        const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                        
                        enrichedTokens.push({
                            mint, symbol: rawMints.find((m: any) => m.mint === mint)?.symbol || 'UNKNOWN',
                            price: decodePumpCurvePrice(buf.toString('base64')) * cachedSolUsdPrice,
                            volume: realSolReserves * cachedSolUsdPrice * 2, 
                            liquidity: virtualSolReserves * cachedSolUsdPrice,
                            priceChangeM5: 0, pairCreatedAt: rawMints.find((m: any) => m.mint === mint)?.firstSeenAt || Date.now(),
                            socials: [], sourceQuality: 'onchain-only',
                            creatorWallet: rawMints.find((m: any) => m.mint === mint)?.creator || ''
                        });
                    });
                }
                await new Promise(r => setTimeout(r, 200)); 
            }
        } catch (e: any) {}
    }
    return enrichedTokens;
}

// 🟢 PIPELINE 2: Direct Pump.fun API 
async function fetchFreshPumpTokens() {
    try {
        const res = await axios.get('https://frontend-api-v3.pump.fun/coins?offset=0&limit=60&sort=created_timestamp&order=DESC&includeNsfw=false', { timeout: 3500, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!Array.isArray(res.data)) return [];

        const now = Date.now();
        const recentPump = res.data.filter((c: any) => c.created_timestamp && (now - c.created_timestamp) < 20 * 60 * 1000);
        if (recentPump.length === 0) return [];

        const mintsOnly = recentPump.map((c: any) => c.mint);
        const dsPairs = await safeDexScreenerFetch(mintsOnly);
        
        const enrichedTokens: any[] = [];
        for (const coin of recentPump) {
            const dsPair = dsPairs.find((p: any) => p.baseToken.address === coin.mint);
            if (dsPair) {
                enrichedTokens.push({
                    mint: dsPair.baseToken.address, symbol: dsPair.baseToken.symbol, price: parseFloat(dsPair.priceUsd || "0"),
                    volume: dsPair.volume?.h24 || 0, liquidity: dsPair.liquidity?.usd || 0, priceChangeM5: dsPair.priceChange?.m5 || 0,
                    priceChangeH1: dsPair.priceChange?.h1 || 0, pairCreatedAt: dsPair.pairCreatedAt || coin.created_timestamp,
                    socials: dsPair.info?.socials || [], sourceQuality: 'pump-fallback'
                });
            } else {
                const { cachedSolUsdPrice } = await import('./grpc.service.js');
                const virtualSolReserves = coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1_000_000_000) : 30;
                const realSolReserves = coin.real_sol_reserves ? (coin.real_sol_reserves / 1_000_000_000) : 0;
                enrichedTokens.push({
                    mint: coin.mint, symbol: coin.symbol || 'UNKNOWN', price: coin.usd_market_cap ? (coin.usd_market_cap / 1_000_000_000) : 0, 
                    volume: realSolReserves * cachedSolUsdPrice * 2, liquidity: virtualSolReserves * cachedSolUsdPrice,
                    priceChangeM5: 0, priceChangeH1: 0, pairCreatedAt: coin.created_timestamp, socials: [], sourceQuality: 'onchain-only'
                });
            }
        }
        return enrichedTokens;
    } catch (e: any) {
        console.warn('[CALLER] pump-fallback pipeline failed:', e.message);
        return [];
    }
}

// 🟢 PIPELINE 3: DexScreener Latest Profile Submissions
async function fetchFreshViaRest() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 60);
        const dsPairs = await safeDexScreenerFetch(mints);

        const now = Date.now();
        return dsPairs.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || now, socials: pair.info?.socials || [], sourceQuality: 'rest-fallback'
        })).filter((t: any) => (now - t.pairCreatedAt) < 30 * 60 * 1000); 
    } catch (e: any) {
        console.warn('[CALLER] rest-fallback pipeline failed:', e.message);
        return [];
    }
}

// 🟢 PIPELINE 4: Boosted Pairs
async function fetchBoostedPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 60);
        const dsPairs = await safeDexScreenerFetch(mints);
        return dsPairs.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || Date.now(), socials: pair.info?.socials || []
        }));
    } catch (e: any) {
        console.warn('[CALLER] boosted pipeline failed:', e.message);
        return [];
    }
}

// 🟢 PIPELINE 5: NEW Raydium Pairs
async function fetchFreshRaydiumPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium', { timeout: 3000 });
        if (!res.data) return [];
        const now = Date.now();
        return (res.data?.pairs || [])
            .filter((p: any) => p.chainId === 'solana' && p.dexId === 'raydium' && (now - p.pairCreatedAt) < 30 * 60 * 1000)
            .slice(0, 60)
            .map((pair: any) => ({
                mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
                volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
                pairCreatedAt: pair.pairCreatedAt || now, socials: pair.info?.socials || [], sourceQuality: 'dexscreener'
            }));
    } catch (e: any) {
        console.warn('[CALLER] fetchFreshRaydiumPairs pipeline failed:', e.message);
        return [];
    }
}

export async function getDevReputation(creatorWallet: string): Promise<{ launchCount: number; avgRugScore: number; isKnownRugger: boolean }> {
    if (!creatorWallet) return { launchCount: 0, avgRugScore: 0, isKnownRugger: false };
    const cacheKey = `dev_rep:${creatorWallet}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        
        // Parallelized fetches for speed
        const sigs = await connection.getSignaturesForAddress(new PublicKey(creatorWallet), { limit: 8 }).catch(() => []);

        const txs = await Promise.all(
            sigs.map(s => connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null))
        );

        let rugCount = 0;
        for (const tx of txs) {
            if (!tx?.meta) continue;
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
        const largest = await connection.getTokenLargestAccounts(new PublicKey(mintAddress)).catch(()=>null);
        if (!largest || !largest.value[0]) return { locked: false, burned: false, lockPct: 0 };

        const top = largest.value[0];
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
        const largest = await connection.getTokenLargestAccounts(new PublicKey(mintAddress)).catch(()=>null);
        if(!largest) return { growthRate: 0, uniqueBuyers5m: 0 };
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

export async function simulateSellability(mintAddress: string, probeSolSize: number = 0.1): Promise<{ sellable: boolean; estimatedTaxPct: number }> {
    const cacheKey = `sellable:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const buyQuote = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mintAddress}&amount=${Math.floor(probeSolSize * 1e9)}&autoSlippage=true`).catch(() => null);
        
        if (!buyQuote?.data?.outAmount) {
            const result = { sellable: true, estimatedTaxPct: 0 }; 
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 120);
            return result;
        }

        const sellQuote = await axios.get(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${buyQuote.data.outAmount}&autoSlippage=true`).catch(() => null);

        if (!sellQuote?.data?.outAmount) {
            const result = { sellable: true, estimatedTaxPct: 0 }; 
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 120);
            return result;
        }

        const priceImpact = parseFloat(sellQuote.data.priceImpactPct || "0") * 100;
        const result = { sellable: priceImpact < 15, estimatedTaxPct: priceImpact };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
        return result;
    } catch (_) {
        return { sellable: true, estimatedTaxPct: 0 }; 
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
    uncertain?: boolean;
    devRep?: { launchCount: number; avgRugScore: number; isKnownRugger: boolean };
    lpLock?: { locked: boolean; burned: boolean; lockPct: number };
    velocity?: { growthRate: number; uniqueBuyers5m: number };
    sellability?: { sellable: boolean; estimatedTaxPct: number };
    observedVol?: number;
}

export function computeTokenScore(stats: TokenStats): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    reasons.push(`🕒 Age: ${Math.floor(stats.ageMins)}m`);
    if (stats.ageMins < 60) score += 30; 
    else if (stats.ageMins < 180) score += 15;

    const activeVol = stats.observedVol && stats.observedVol > stats.volume24h ? stats.observedVol : stats.volume24h;
    reasons.push(`💰 Vol: $${(activeVol/1000).toFixed(1)}k`);
    if (activeVol > 100000) score += 25; 
    else if (activeVol > 20000) score += 10;

    if (stats.liquidity > 0) {
        const volToLiqRatio = activeVol / stats.liquidity;
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
    if (stats.uncertain) { score -= 5; reasons.push(`⚠️ Rug check inconclusive (Timeout)`); } 

    if (stats.sourceQuality === 'onchain-only') {
        score -= 4; 
        reasons.push(`⛓️ Unindexed (early, unverified)`);
    }

    if (stats.sellability && !stats.sellability.sellable) {
        return { score: 0, reasons: [`🚨 UNSELLABLE (Honeypot/High Tax >15%)`] }; 
    }

    if (stats.devRep) {
        if (stats.devRep.isKnownRugger) {
            return { score: 0, reasons: [`🚨 Serial Rugger Wallet Detected`] }; 
        } else if (stats.devRep.launchCount > 5) {
            score += 10;
            reasons.push(`🏗️ Established Builder (${stats.devRep.launchCount} launches)`);
        }
    }

    if (stats.lpLock) {
        if (stats.lpLock.burned || stats.lpLock.lockPct > 80) {
            score += 15;
            reasons.push(`🔒 LP Secured (${stats.lpLock.lockPct.toFixed(0)}% Locked/Burned)`);
        } else if (stats.ageMins > 10 && stats.lpLock.lockPct === 0 && !stats.isRug) {
            score -= 20;
            reasons.push(`⚠️ Mature token with 0% LP Lock (Rug Setup)`);
        }
    }

    if (stats.velocity) {
        if (stats.velocity.growthRate > 50) {
            score += 15;
            reasons.push(`🔥 High Organic Velocity (+${stats.velocity.growthRate.toFixed(0)}% holders in 5m)`);
        } else if (stats.velocity.growthRate <= 0 && stats.priceChangeM5 > 5) {
            score -= 15;
            reasons.push(`🤖 Wash Buy Warning (Price rising but flat unique buyers)`);
        }
    }

    return { score: Math.max(0, score), reasons };
}

// 🟢 MERGE AND SCORE (WITH PARALLEL PIPELINES & FAST CHUNKING)
export async function scoreTokens() {
    try {
        const [newMints, pumpFallback, restFallback, boosted, raydiumPairs] = await Promise.all([
            fetchRecentNewMints(),
            fetchFreshPumpTokens(),
            fetchFreshViaRest(),
            fetchBoostedPairs(),
            fetchFreshRaydiumPairs() 
        ]);

        const allPairs = [...newMints, ...pumpFallback, ...restFallback, ...boosted, ...raydiumPairs];
        
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
            const chunks = chunkArray(needsFix, 100);
            for (const chunk of chunks) {
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
                await new Promise(r => setTimeout(r, 250)); // Safely stagger RPC queries
            }
        }

        // STAGE 1: Basic Scoring (Staggered to protect RugCheck limits)
        const stage1Scored: any[] = [];
        // 🟢 MEV / 429 FIX: Smaller chunk size to prevent API throttling
        const stage1Chunks = chunkArray(uniquePairs, 8);
        
        for (const chunk of stage1Chunks) {
            const results = await Promise.all(chunk.map(async (pair) => {
                const { isRug, top10Pct, uncertain } = await getCachedRugStatus(pair.mint);
                const observedVolStr = await redis.get(`observed_vol:${pair.mint}`);
                
                // 🟢 MEV / 429 FIX: 5 Minute Cache
                const mevCacheKey = `mev_check:${pair.mint}`;
                const cachedMev = await redis.get(mevCacheKey);
                let hasMev = false;
                if (cachedMev !== null) {
                    hasMev = cachedMev === 'true';
                } else {
                    const { checkRecentMevActivity } = await import('./price.service.js');
                    hasMev = await checkRecentMevActivity(pair.mint);
                    await redis.set(mevCacheKey, hasMev ? 'true' : 'false', 'EX', 300);
                }

                const stats: TokenStats = {
                    ageMins: (Date.now() - pair.pairCreatedAt) / 60000,
                    volume24h: pair.volume,
                    liquidity: pair.liquidity,
                    priceChangeM5: pair.priceChangeM5,
                    hasSocials: pair.socials.length > 0,
                    isRug,
                    uncertain,
                    sourceQuality: pair.sourceQuality,
                    observedVol: observedVolStr ? parseFloat(observedVolStr) : undefined
                };

                const { score, reasons } = computeTokenScore(stats);
                return { pair, stats, score, reasons, isRug, top10Pct, hasMev };
            }));
            stage1Scored.push(...results);
            // 🟢 MEV / 429 FIX: Safely stagger Stage 1
            await new Promise(r => setTimeout(r, 600)); 
        }

        const passedStage1 = stage1Scored.filter(t => t.score >= 25).sort((a,b) => b.score - a.score);

        // STAGE 2: Deep Verification (Staggered to protect RPC/Jup)
        const fullyScored: any[] = [];
        for (const t of passedStage1.slice(0, 20)) {
            const stillOnCurve = t.pair.mint.toLowerCase().endsWith('pump') && t.pair.sourceQuality !== 'dexscreener' && t.pair.sourceQuality !== 'pump-fallback';
            
            let sellability = { sellable: true, estimatedTaxPct: 0 };
            if (!stillOnCurve) {
                sellability = await simulateSellability(t.pair.mint);
            }

            const [devRep, lpLock, velocity] = await Promise.all([
                getDevReputation(t.pair.creatorWallet || ''), 
                checkLpLockStatus(t.pair.mint),
                trackHolderVelocity(t.pair.mint)
            ]);

            t.stats.devRep = devRep;
            t.stats.lpLock = lpLock;
            t.stats.velocity = velocity;
            t.stats.sellability = sellability;

            const finalScoreRes = computeTokenScore(t.stats);
            
            let concentrationAdjustedScore = finalScoreRes.score;
            if (!t.isRug && t.top10Pct > 25) {
                concentrationAdjustedScore -= Math.floor((t.top10Pct - 25) * 1.5);
                finalScoreRes.reasons.push(`⚠️ Top 10 holders own ${t.top10Pct.toFixed(1)}%`);
            }

            fullyScored.push({ 
                ...t.pair, 
                totalScore: Math.max(0, concentrationAdjustedScore), 
                ageMins: t.stats.ageMins, 
                reasons: finalScoreRes.reasons, 
                breakdown: { mevRisk: t.isRug || !sellability.sellable || t.hasMev ? -100 : 0 } 
            });
            // 🟢 MEV / 429 FIX: Safely stagger deep analytics
            await new Promise(r => setTimeout(r, 400)); 
        }

        const finalScored = [...fullyScored, ...stage1Scored.filter(t => t.score < 25).map(t => ({
            ...t.pair, totalScore: t.score, ageMins: t.stats.ageMins, reasons: t.reasons, breakdown: { mevRisk: t.isRug ? -100 : 0 }
        }))].sort((a, b) => b.totalScore - a.totalScore);

        await redis.set('caller:hot_scored_tokens', JSON.stringify(finalScored), 'EX', 30);
        return finalScored;
    } catch (e: any) {
        console.error("🔴 [CALLER] Engine Error:", e.message);
        return [];
    }
}

export function startCallerEvaluator() {
    setInterval(async () => {
        try {
            const historyMap = await redis.hgetall('caller_history');
            const now = Date.now();

            for (const [mint, val] of Object.entries(historyMap)) {
                const data = JSON.parse(val);
                if (data.finalized) continue;

                const ageMs = now - data.alertedAt;
                
                if (ageMs > 24 * 3600000) { 
                    data.finalized = true; 
                    
                    if (data.peakPct !== undefined && data.predictedRangeLow !== undefined && data.predictedRangeHigh !== undefined) {
                        const withinRange = data.peakPct >= data.predictedRangeLow && data.peakPct <= data.predictedRangeHigh;
                        await redis.incr(withinRange ? 'projection:hits' : 'projection:misses');
                    }
                    
                    await redis.hset('caller_history', mint, JSON.stringify(data)); 
                    continue; 
                }

                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3000 }).catch(() => null);
                const currentPrice = parseFloat(res?.data?.pairs?.[0]?.priceUsd || "0");

                if (currentPrice > 0) {
                    const pctChange = ((currentPrice - data.priceAtAlert) / data.priceAtAlert) * 100;
                    if (data.peakPct === undefined || pctChange > data.peakPct) {
                        data.peakPct = pctChange;
                        data.peakAtMs = ageMs; 
                    }
                    await redis.hset('caller_history', mint, JSON.stringify(data));
                }
            }
        } catch (_) {}
    }, 5 * 60 * 1000);
}