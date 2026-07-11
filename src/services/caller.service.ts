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
    blockMev: boolean;
}

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    const defaultFilters: CallerFilters = {
        isActive: false,
        minScore: 75,
        maxAgeMins: 60,
        minPctChange: 10,
        maxPctChange: 500,
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

async function getCachedRugStatus(mint: string): Promise<boolean> {
    const cached = await redis.get(`rugcheck:${mint}`);
    if (cached) return cached === 'true';
    const isRug = await checkTokenRugRisk(mint);
    await redis.set(`rugcheck:${mint}`, isRug ? 'true' : 'false', 'EX', 600);
    return isRug;
}

// 🟢 D1 FIX: Pull from the live WebSocket buffer instead of broken REST endpoints
async function fetchRecentNewMints() {
    const rawMints = getRecentNewMints();
    if (rawMints.length === 0) return [];

    const enrichedTokens: any[] = [];
    const mintsOnly = rawMints.map((m: any) => m.mint);
    
    for (let i = 0; i < mintsOnly.length; i += 30) {
        const chunk = mintsOnly.slice(i, i + 30).join(',');
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`, { timeout: 3000 });
            if (res.data?.pairs) {
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
                        socials: pair.info?.socials || []
                    });
                });
            }
        } catch (_) {}
    }
    return enrichedTokens;
}

async function fetchTrendingPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 30).join(',');
        const enrich = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { timeout: 3000 });
        return enrich.data?.pairs?.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol,
            price: parseFloat(pair.priceUsd || "0"), volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0,
            priceChangeM5: pair.priceChange?.m5 || 0, priceChangeH1: pair.priceChange?.h1 || 0,
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
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol,
            price: parseFloat(pair.priceUsd || "0"), volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0,
            priceChangeM5: pair.priceChange?.m5 || 0, priceChangeH1: pair.priceChange?.h1 || 0,
            pairCreatedAt: pair.pairCreatedAt || Date.now(), socials: pair.info?.socials || []
        })) || [];
    } catch (_) { return []; }
}

export async function scoreTokens() {
    try {
        const [newMints, trending, boosted] = await Promise.all([
            fetchRecentNewMints(),
            fetchTrendingPairs().catch(()=>[]),
            fetchBoostedPairs().catch(()=>[])
        ]);

        console.log(`🎯 [CALLER] Scanned Sources: NewMints=${newMints.length} | Trending=${trending.length} | Boosted=${boosted.length}`);

        const allPairs = [...newMints, ...trending, ...boosted];
        const uniquePairs = Array.from(new Map(allPairs.map(item => [item.mint, item])).values());

        const scored = await Promise.all(uniquePairs.map(async (pair) => {
            const ageMins = (Date.now() - pair.pairCreatedAt) / 60000;
            let score = 0;
            let reasons = [];
            
            // 🟢 Credibility FIX: Detailed, undeniable breakdowns
            reasons.push(`🕒 Age: ${Math.floor(ageMins)}m`);
            if (ageMins < 60) { score += 30; } else if (ageMins < 180) { score += 15; }

            reasons.push(`💰 Vol: $${(pair.volume/1000).toFixed(1)}k`);
            if (pair.volume > 100000) { score += 25; } else if (pair.volume > 20000) { score += 10; }

            reasons.push(`📈 Mom: +${pair.priceChangeM5.toFixed(1)}%`);
            if (pair.priceChangeM5 > 15) { score += 20; }

            reasons.push(`💧 Liq: $${(pair.liquidity/1000).toFixed(1)}k`);
            if (pair.liquidity > 20000) { score += 15; }

            if (pair.socials.length > 0) { score += 10; }

            const isRug = await getCachedRugStatus(pair.mint);
            if (isRug) score -= 100;

            return { ...pair, totalScore: Math.max(0, score), ageMins, reasons, breakdown: { mevRisk: isRug ? -100 : 0 } };
        }));

        const topScorers = scored.filter(t => t.totalScore > 0).sort((a, b) => b.totalScore - a.totalScore);
        
        await redis.set('caller:hot_scored_tokens', JSON.stringify(topScorers), 'EX', 30);
        return topScorers;
    } catch (e: any) {
        console.error("🔴 [CALLER] Engine Error:", e.message);
        return [];
    }
}
let isScoring = false;
export async function startCoinCaller(bot: any) {
    console.log("🎯 [CALLER ENGINE] Initialized. Scanning DexScreener every 15 seconds.");

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

                const matchedToken = tokens.find(t => 
                    t.totalScore >= filters.minScore &&
                    t.ageMins <= filters.maxAgeMins &&
                    t.priceChangeM5 >= filters.minPctChange &&
                    t.priceChangeM5 <= filters.maxPctChange &&
                    (!filters.blockMev || t.breakdown.mevRisk >= 0)
                );

                if (matchedToken) {
                    const alertKey = `caller_alerted:${user.telegramId}:${matchedToken.mint}`;
                    const alreadyAlerted = await redis.get(alertKey);
                    if (alreadyAlerted) continue;

                    await redis.set(alertKey, '1', 'EX', 3600 * 24);

                    // 🟢 Credibility FIX: Log to history for tracking
                    const historyData = {
                        mint: matchedToken.mint,
                        symbol: matchedToken.symbol,
                        score: matchedToken.totalScore,
                        priceAtAlert: matchedToken.price,
                        alertedAt: Date.now()
                    };
                    await redis.hset(`caller_history`, matchedToken.mint, JSON.stringify(historyData));

                    const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                                `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                                `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n\n` +
                                `<b>Audit Trail:</b>\n` +
                                `${matchedToken.reasons.map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
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