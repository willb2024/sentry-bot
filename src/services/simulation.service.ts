// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generatePnlCard } from './image.service.js';
import { cachedSolUsdPrice } from './grpc.service.js';
import { getLivePriceSol, subscribeToMintPrice } from './guard-price-feed.service.js';
import { getCachedTokenPrice } from './engine.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { computeTokenScore, TokenStats } from './caller.service.js';
import { connection } from '../lib/connection.js';
import { PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { addTrailingStopToMemory } from './order.service.js';

const activeSimLoops = new Set<string>();

export interface SimPosition {
    mint: string;
    symbol: string;
    amount: number;
    entryPrice: number;       // In SOL
    entryPriceUsd: number;    // In USD
    priceUsd: number;
    valueUsd: number;
    amountInSol: number;
    highestSeenPrice: number; // In SOL
    createdAt: number;
    entryScore?: number;
    volatilitySeed?: number;
}

// ─── UTILITIES & GENERATORS ─────────────────────────────
export function randomBase58(length: number): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
    return result;
}

export function generateSimSignature(): string {
    return randomBase58(87);
}

export function generateSimTokenCA(): string {
    const isPump = Math.random() > 0.3;
    const base = randomBase58(isPump ? 36 : 44);
    return isPump ? base + 'pump' : base;
}

export function generateSimWallets(): Array<{ address: string; balance: number }> {
    const count = Math.floor(Math.random() * 5) + 1;
    return Array.from({ length: count }, () => ({
        address: randomBase58(44),
        balance: parseFloat((Math.random() * 8 + 0.5).toFixed(4))
    }));
}

export function applySimSlippage(targetPnl: number): number {
    const maxPercentDeviation = Math.abs(targetPnl) * 0.05;
    const absoluteDeviation = (Math.random() * 2 - 1) * Math.max(1.2, maxPercentDeviation);
    return parseFloat((targetPnl + absoluteDeviation).toFixed(2));
}

// ─── SHARED DYNAMIC SIZING HELPER ────────────────────────
export function calculateDynamicSize(
    config: any,
    score: number,
    liqUsd: number,
    solPrice: number
): number {
    if (!config?.enableDynamicScaling) return config?.amountSol || 0.05;
    const normalizedScore = Math.min(100, Math.max(10, score)) / 100;
    const exponent = config.scaleExponent || 2.0;
    const convictionMultiplier = Math.pow(normalizedScore, exponent);
    let size = (config.baseRiskUnitSol || 0.02) * convictionMultiplier * (config.maxRiskMultiplier || 5.0);

    // Liquidity cap: Never snipe more than 2% of virtual liquidity
    if (liqUsd > 0 && solPrice > 0) {
        const maxLiqInSol = (liqUsd * 0.02) / solPrice;
        size = Math.min(size, maxLiqInSol);
    }

    // Budget cap
    const totalSpent = config.totalSpentSol || 0;
    const remaining = (config.maxBudgetSol || Infinity) - totalSpent;
    size = Math.min(size, remaining);
    return Math.max(size, 0.005);
}

// ─── COUNTERS & ANCHORS ─────────────────────────────────
export async function getSimCounters(telegramId: string) {
    const wins = parseInt(await redis.get(`sim:stats:wins:${telegramId}`) || '0');
    const losses = parseInt(await redis.get(`sim:stats:losses:${telegramId}`) || '0');
    const totalTrades = parseInt(await redis.get(`sim:stats:totalTrades:${telegramId}`) || '0');
    const totalInvestedSol = parseFloat(await redis.get(`sim:stats:totalInvestedSol:${telegramId}`) || '0');
    const totalPnlSol = parseFloat(await redis.get(`sim:stats:totalPnlSol:${telegramId}`) || '0');
    return { wins, losses, totalTrades, totalInvestedSol, totalPnlSol };
}

export async function setSimCounters(
    telegramId: string, 
    wins: number, 
    losses: number, 
    totalTrades: number, 
    totalInvestedSol: number, 
    totalPnlSol: number
) {
    await redis.set(`sim:stats:wins:${telegramId}`, wins.toString());
    await redis.set(`sim:stats:losses:${telegramId}`, losses.toString());
    await redis.set(`sim:stats:totalTrades:${telegramId}`, totalTrades.toString());
    await redis.set(`sim:stats:totalInvestedSol:${telegramId}`, totalInvestedSol.toString());
    await redis.set(`sim:stats:totalPnlSol:${telegramId}`, totalPnlSol.toString());
}

export async function getSimFirstTradeAt(telegramId: string): Promise<string | null> {
    return await redis.get(`sim:first_trade_at:${telegramId}`);
}

export async function setSimFirstTradeAt(telegramId: string, dateStr: string): Promise<void> {
    await redis.set(`sim:first_trade_at:${telegramId}`, dateStr);
}

// ─── SESSION BUDGET & SPEND ─────────────────────────────
export async function getSessionSpend(telegramId: string, mode: 'live' | 'sim'): Promise<number> {
    const val = await redis.get(`autosnipe:session_spend:${mode}:${telegramId}`);
    return val ? parseFloat(val) : 0;
}

export async function addSessionSpend(telegramId: string, amount: number, mode: 'live' | 'sim'): Promise<number> {
    const current = await getSessionSpend(telegramId, mode);
    const updated = current + amount;
    await redis.set(`autosnipe:session_spend:${mode}:${telegramId}`, updated.toString(), 'EX', 86400);
    return updated;
}

export async function sendBudgetExhaustedSummary(bot: any, telegramId: string, mode: 'live' | 'sim', sessionId: string | null) {
    if (!sessionId) return;
    const tradesKey = `${mode}:session_trades:${sessionId}`;
    const raw = await redis.lrange(tradesKey, 0, -1);
    const trades = raw.map(r => JSON.parse(r));
    const totalSpent = trades.reduce((s: number, t: any) => s + (t.amountInSol || 0), 0);
    const totalRealizedPnl = trades.reduce((s: number, t: any) => s + (t.realizedPnlSol || 0), 0);
    const wins = trades.filter((t: any) => (t.realizedPnlSol || 0) > 0).length;
    const losses = trades.filter((t: any) => (t.realizedPnlSol || 0) <= 0).length;

    const solPrice = cachedSolUsdPrice || 160;
    const usdValue = (totalRealizedPnl * solPrice).toFixed(2);

    await bot.telegram.sendMessage(telegramId,
        `🏁 <b>AUTO-SNIPE BUDGET EXHAUSTED${mode === 'sim' ? ' (SIM)' : ''}</b>\n\n` +
        `Total Spent: <b>${totalSpent.toFixed(4)} SOL</b>\n` +
        `Trades Executed: <b>${trades.length} (${wins}W / ${losses}L)</b>\n` +
        `Net Result: <b>${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(4)} SOL (${totalRealizedPnl >= 0 ? '+' : ''}$${usdValue})</b>\n\n` +
        `<i>Session ended — your max risk exposure cap has been reached.</i>`,
        { parse_mode: 'HTML' }
    ).catch(() => {});
}

// ─── STATE MANAGEMENT ──────────────────────────────────
export async function isSimulationActive(telegramId: string): Promise<boolean> {
    let val = await redis.get(`sim:active:${telegramId}`);
    if (val === null) {
        await loadSimulationState(telegramId);
        val = await redis.get(`sim:active:${telegramId}`);
    }
    return val === 'true';
}

export async function getSimStartingBalance(telegramId: string): Promise<number> {
    const val = await redis.get(`sim:starting_balance:${telegramId}`);
    return val ? parseFloat(val) : 0;
}

export async function setSimStartingBalance(telegramId: string, amount: number): Promise<void> {
    await redis.set(`sim:starting_balance:${telegramId}`, amount.toFixed(4));
    await saveSimulationState(telegramId);
}

export async function getSimBalance(telegramId: string): Promise<string> {
    try {
        const isActive = await isSimulationActive(telegramId).catch(() => false);
        if (!isActive) return '0.0000';
    } catch { 
        return '0.0000'; 
    }

    let bal = await redis.get(`sim:balance:${telegramId}`);
    if (bal === null) {
        await loadSimulationState(telegramId).catch(() => {});
        bal = await redis.get(`sim:balance:${telegramId}`);
    }
    return bal || '0.0000';
}

export async function getSimVolume(telegramId: string): Promise<number> {
    if (!(await isSimulationActive(telegramId))) return 0;
    let vol = await redis.get(`sim:volume:${telegramId}`);
    if (vol === null) {
        await loadSimulationState(telegramId);
        vol = await redis.get(`sim:volume:${telegramId}`);
    }
    return vol ? parseFloat(vol) : 0;
}

export async function getSimWallets(telegramId: string): Promise<Array<{ address: string; balance: number }>> {
    const raw = await redis.get(`sim:wallets:${telegramId}`);
    if (raw) return JSON.parse(raw);
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
    return wallets;
}

export async function recordStatsEvent(telegramId: string, mode: 'live' | 'sim', realizedPnlSol: number) {
    const key = `stats_events:${mode}:${telegramId}`;
    const eventId = crypto.randomUUID();
    const now = Date.now();
    await redis.zadd(key, now, JSON.stringify({ id: eventId, t: now, pnl: realizedPnlSol }));
    await redis.zremrangebyscore(key, 0, now - (86400 * 1000 * 7));
}

export async function getStatsForWindow(telegramId: string, mode: 'live' | 'sim', windowSeconds: number = 86400) {
    const key = `stats_events:${mode}:${telegramId}`;
    const since = Date.now() - (windowSeconds * 1000);
    const raw = await redis.zrangebyscore(key, since, Date.now());
    const events = raw.map((r: string) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    const totalPnl = events.reduce((sum: number, e: any) => sum + (e.pnl || 0), 0);
    const wins = events.filter((e: any) => e.pnl > 0).length;
    const losses = events.filter((e: any) => e.pnl < 0).length;
    return { totalPnl, wins, losses, tradeCount: events.length };
}

export async function recordSimTrade(
    telegramId: string, 
    isBuy: boolean, 
    amountInSol: number, 
    profitPercent: number = 0, 
    strategy: string = 'SIMULATED', 
    mint: string = 'simulated',
    slippagePercent: number = 0.12
) {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    const realizedPnlSol = isBuy ? 0 : amountInSol * (profitPercent / 100);
    
    existing.unshift({ 
        createdAt: new Date().toISOString(), 
        isBuy, 
        amountInSol, 
        profitPercent, 
        realizedPnlSol, 
        strategy, 
        mint,
        slippagePercent 
    });
    
    const trimmed = existing.slice(0, 5000);
    await redis.set(key, JSON.stringify(trimmed));

    const anchorKey = `sim:first_trade_at:${telegramId}`;
    if (!(await redis.get(anchorKey))) await redis.set(anchorKey, new Date().toISOString());

    const counters = await getSimCounters(telegramId);
    counters.totalTrades++;
    if (!isBuy) {
        counters.totalInvestedSol += amountInSol;
        counters.totalPnlSol += realizedPnlSol;
        if (profitPercent > 0) counters.wins++;
        else if (profitPercent < 0) counters.losses++;
    }
    await setSimCounters(telegramId, counters.wins, counters.losses, counters.totalTrades, counters.totalInvestedSol, counters.totalPnlSol);
    await redis.incrbyfloat(`sim:volume:${telegramId}`, amountInSol);
}

// ─── REAL-TIME PRICE SYNC & POSITION WATCHERS ───────────
export async function updateSimPositions(telegramId: string): Promise<void> {
    const posKey = `sim:positions:${telegramId}`;
    const raw = await redis.get(posKey);
    if (!raw) return;

    const positions: SimPosition[] = JSON.parse(raw);
    if (positions.length === 0) return;

    let changed = false;
    const solPrice = cachedSolUsdPrice || 156.93;

    for (const p of positions) {
        let livePriceSol = getLivePriceSol(p.mint);
        
        if (!livePriceSol || livePriceSol <= 0) {
            livePriceSol = await getCachedTokenPrice(p.mint).catch(() => 0);
        }

        if (livePriceSol <= 0 && p.mint.toLowerCase().endsWith('pump')) {
            try {
                const curvePda = getBondingCurveAddress(p.mint);
                const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                if (accInfo?.data) {
                    livePriceSol = decodePumpCurvePrice(accInfo.data.toString('base64'));
                }
            } catch (_) {}
        }

        if (livePriceSol > 0) {
            const livePriceUsd = livePriceSol * solPrice;
            p.priceUsd = livePriceUsd;
            p.valueUsd = parseFloat((p.amount * livePriceUsd).toFixed(2));
            
            if (livePriceSol > (p.highestSeenPrice || 0)) {
                p.highestSeenPrice = livePriceSol;
            }
            changed = true;
        }
    }

    if (changed) {
        await redis.set(posKey, JSON.stringify(positions));
    }
}

export async function walkSimPositionPrices(telegramId: string): Promise<void> {
    await updateSimPositions(telegramId);
}

setInterval(async () => {
    try {
        const simStates = await prisma.simState.findMany({ 
            where: { active: true }, 
            select: { user: { select: { telegramId: true } } } 
        });
        for (const state of simStates) {
            if (state.user?.telegramId) await updateSimPositions(state.user.telegramId);
        }
    } catch (_) {}
}, 2000);

export async function fetchLiveTokenPrice(mint: string): Promise<{ priceSol: number; priceUsd: number; symbol: string }> {
    let priceSol = getLivePriceSol(mint) || 0;
    let priceUsd = 0;
    let symbol = 'TOKEN';

    const solUsdPrice = cachedSolUsdPrice || 156.93;

    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 2000 });
        const pair = res.data?.pairs?.[0];
        if (pair) {
            symbol = pair.baseToken.symbol || symbol;
            priceUsd = parseFloat(pair.priceUsd || "0");
            if (priceSol === 0 && priceUsd > 0) priceSol = priceUsd / solUsdPrice;
        }
    } catch (_) {}

    if (priceSol === 0) {
        priceSol = await getCachedTokenPrice(mint).catch(() => 0);
    }

    if (priceSol === 0 && mint.toLowerCase().endsWith('pump')) {
        try {
            const curvePda = getBondingCurveAddress(mint);
            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
            if (accInfo?.data) {
                priceSol = decodePumpCurvePrice(accInfo.data.toString('base64'));
            }
        } catch (_) {}
    }

    if (priceSol > 0 && priceUsd === 0) priceUsd = priceSol * solUsdPrice;
    if (priceSol === 0) {
        priceSol = 0.000005;
        priceUsd = priceSol * solUsdPrice;
    }

    return { priceSol, priceUsd, symbol };
}

export async function getRealTokenForSimDisplay(): Promise<{ mint: string; symbol: string }> {
    const cacheKey = 'sim:real_token_pool';
    let pool: Array<{ mint: string; symbol: string }> = [];
    const cached = await redis.get(cacheKey);
    if (cached) pool = JSON.parse(cached);

    if (pool.length === 0) {
        try {
            const res = await axios.get('https://frontend-api-v3.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC&includeNsfw=false', { timeout: 2500 });
            if (Array.isArray(res.data) && res.data.length > 0) {
                pool = res.data.map((c: any) => ({ mint: c.mint, symbol: c.symbol || 'UNKNOWN' }));
                await redis.set(cacheKey, JSON.stringify(pool), 'EX', 120);
            }
        } catch (_) {
            pool = [{ mint: generateSimTokenCA(), symbol: 'SIMDEMO' }];
        }
    }

    if (pool.length === 0) return { mint: generateSimTokenCA(), symbol: 'SIMDEMO' };
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── TRADE EXECUTION ────────────────────────────────────
export async function simExecuteSnipe(
    telegramId: string, 
    tokenAddress: string, 
    amountSol: number, 
    strategy: string = 'MANUAL'
): Promise<{ success: boolean; signature: string; message: string; volumeSpent: number }> {
    const { ensureFirstTradeAnchor } = await import('./engine.service.js');
    await ensureFirstTradeAnchor(telegramId);

    const currentBal = parseFloat(await getSimBalance(telegramId));
    if (currentBal < amountSol + 0.002) {
        return { success: false, signature: '', message: `🔴 Insufficient Funds. Balance: ${currentBal.toFixed(4)} SOL`, volumeSpent: 0 };
    }

    const { priceSol, priceUsd, symbol } = await fetchLiveTokenPrice(tokenAddress);
    const newBal = Math.max(0, currentBal - amountSol - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const tokenAmount = Math.floor(amountSol / priceSol);
    const posKey = `sim:positions:${telegramId}`;
    const existing: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
    
    const newPosition: SimPosition = {
        mint: tokenAddress,
        symbol,
        amount: tokenAmount,
        entryPrice: priceSol,
        entryPriceUsd: priceUsd,
        priceUsd: priceUsd,
        valueUsd: parseFloat((amountSol * (cachedSolUsdPrice || 156.93)).toFixed(2)),
        amountInSol: amountSol,
        highestSeenPrice: priceSol,
        createdAt: Date.now()
    };

    existing.push(newPosition);
    await redis.set(posKey, JSON.stringify(existing));

    await subscribeToMintPrice(tokenAddress, `sim_${Date.now()}`).catch(() => {});
    await recordSimTrade(telegramId, true, amountSol, 0, strategy, tokenAddress, 0.12);
    await recordStatsEvent(telegramId, 'sim', 0);
    await saveSimulationState(telegramId);

    return { 
        success: true, 
        signature: generateSimSignature(), 
        message: `🟢 Simulated buy confirmed: ${amountSol.toFixed(4)} SOL of $${symbol}`, 
        volumeSpent: amountSol 
    };
}

export async function simExecuteExit(
    telegramId: string, 
    tokenAddress: string, 
    percent: number = 100, 
    forcedPnlPercent?: number, 
    strategy: string = 'MANUAL'
): Promise<{ success: boolean; signature: string; message: string }> {
    const posKey = `sim:positions:${telegramId}`;
    const positions: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
    const posIndex = positions.findIndex(p => p.mint === tokenAddress);
    if (posIndex === -1) return { success: false, signature: '', message: '⚠️ No open position found for this token.' };

    const pos = positions[posIndex];
    let pnlPercent = forcedPnlPercent;

    if (pnlPercent === undefined) {
        let currentPriceSol = getLivePriceSol(tokenAddress) || 0;
        if (currentPriceSol <= 0) {
            const live = await fetchLiveTokenPrice(tokenAddress);
            currentPriceSol = live.priceSol;
        }
        pnlPercent = pos.entryPrice > 0 ? ((currentPriceSol - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    }

    const soldSol = pos.amountInSol * (percent / 100);
    const rawReturn = soldSol * (1 + pnlPercent / 100);
    const platformFee = rawReturn * 0.01;
    const jitoTip = 0.001;

    const netReturnSol = Math.max(0, rawReturn - platformFee - jitoTip);
    const currentBal = parseFloat(await getSimBalance(telegramId));
    await redis.set(`sim:balance:${telegramId}`, (currentBal + netReturnSol).toFixed(4));

    if (percent >= 100) {
        positions.splice(posIndex, 1);
    } else {
        pos.amount = pos.amount * (1 - (percent / 100));
        pos.amountInSol = pos.amountInSol * (1 - (percent / 100));
        pos.valueUsd = pos.valueUsd * (1 - (percent / 100));
    }
    await redis.set(posKey, JSON.stringify(positions));

    const realizedPnlSol = netReturnSol - soldSol;
    await recordSimTrade(telegramId, false, soldSol, pnlPercent, strategy, tokenAddress, 0.12);
    await recordStatsEvent(telegramId, 'sim', realizedPnlSol);
    await saveSimulationState(telegramId);

    return { 
        success: true, 
        signature: generateSimSignature(), 
        message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` 
    };
}

export async function generateSimCallerAlert(
    telegramId: string,
    filters: {
        minScore: number;
        maxAgeMins: number;
        minPctChange: number;
        maxPctChange: number;
        minLiquidity: number;
        minVolume24h: number;
        blockMev: boolean;
    }
): Promise<any> {
    try {
        const hotRaw = await redis.get('caller:hot_scored_tokens');
        if (hotRaw) {
            const hotTokens = JSON.parse(hotRaw);
            const matching = hotTokens.filter((t: any) =>
                (t.totalScore ?? t.score) >= filters.minScore &&
                t.ageMins <= filters.maxAgeMins &&
                t.priceChangeM5 >= filters.minPctChange &&
                t.priceChangeM5 <= filters.maxPctChange &&
                ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) || (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
                t.liquidity >= filters.minLiquidity &&
                (!filters.blockMev || t.breakdown?.mevRisk >= 0)
            );
            if (matching.length > 0) {
                let bestMatch = null, isReshow = false;
                for (const t of matching) {
                    const seen = await redis.get(`sim_alerted:${telegramId}:${t.mint}`);
                    if (!seen) {
                        bestMatch = t;
                        await redis.set(`sim_alerted:${telegramId}:${t.mint}`, '1', 'EX', 300);
                        break;
                    }
                }
                if (!bestMatch && matching.length > 0) {
                    bestMatch = matching.sort((a: any, b: any) => (b.totalScore ?? b.score) - (a.totalScore ?? a.score))[0];
                    isReshow = true;
                }
                if (bestMatch) {
                    return {
                        mint: bestMatch.mint,
                        symbol: bestMatch.symbol,
                        score: bestMatch.totalScore ?? bestMatch.score,
                        reasons: bestMatch.reasons || [],
                        ageMins: bestMatch.ageMins,
                        priceChangeM5: bestMatch.priceChangeM5 || 0,
                        mevRisk: bestMatch.breakdown?.mevRisk ?? 0,
                        liquidity: bestMatch.liquidity,
                        volume: bestMatch.volume,
                        isReshow
                    };
                }
            }
        }
    } catch (_) {}

    const poolSize = 25;
    const candidates: any[] = [];
    const realToken = await getRealTokenForSimDisplay();

    for (let i = 0; i < poolSize; i++) {
        const ageMins = Math.floor(Math.random() * 120) + 1;
        let liquidity = Math.random() * 25000 + 5000;
        let volume24h = liquidity * (Math.random() * 4 + 1);
        let priceChangeM5 = (Math.random() * 40) - 5;

        const stats: TokenStats = {
            ageMins,
            volume24h,
            liquidity,
            priceChangeM5: parseFloat(priceChangeM5.toFixed(1)),
            hasSocials: Math.random() > 0.40,
            isRug: false,
            devRep: { launchCount: Math.floor(Math.random() * 8), avgRugScore: 0, isKnownRugger: false },
            lpLock: { burned: true, locked: true, lockPct: 100 },
            velocity: { growthRate: 35, uniqueBuyers5m: 15 },
            sellability: { sellable: true, estimatedTaxPct: 0 }
        };

        const scoreRes = computeTokenScore(stats);
        candidates.push({
            mint: realToken.mint,
            symbol: realToken.symbol,
            totalScore: scoreRes.score,
            reasons: scoreRes.reasons,
            ageMins: stats.ageMins,
            priceChangeM5: stats.priceChangeM5,
            liquidity: stats.liquidity,
            volume: stats.volume24h,
            mevRisk: 0
        });
    }

    const matching = candidates.filter((t: any) =>
        t.totalScore >= filters.minScore &&
        t.ageMins <= filters.maxAgeMins &&
        t.liquidity >= filters.minLiquidity &&
        t.volume >= filters.minVolume24h
    );

    if (matching.length > 0) {
        return { ...matching[0], isReshow: false };
    }

    return null;
}

// ─── SIMULATED COPY TRADE ENGINE ─────────────────────────
export async function processSimCopyTrades(bot: any) {
    const simUsers = await prisma.user.findMany({
        where: { simState: { active: true } },
        include: { copyTrades: { where: { isActive: true } } }
    });

    for (const user of simUsers) {
        for (const copy of user.copyTrades) {
            // Low probability check to simulate periodic whale trades
            if (Math.random() < 0.002) {
                const token = await getRealTokenForSimDisplay();
                const isBuy = Math.random() > 0.4; // 60% buys, 40% sells

                if (isBuy && copy.copyBuys !== false) {
                    const tradeSize = copy.maxTradeSizeSol ? Math.min(copy.tradeAmountSol, copy.maxTradeSizeSol) : copy.tradeAmountSol;
                    const res = await simExecuteSnipe(user.telegramId, token.mint, tradeSize, 'COPY_TRADE');
                    if (res.success) {
                        try {
                            await bot.telegram.sendMessage(
                                user.telegramId,
                                `👥 <b>SIM COPY TRADE: BUY EXECUTED!</b>\nTarget: <code>${copy.targetWallet.substring(0, 8)}...</code>\nToken: <code>${token.mint}</code> ($${token.symbol})\nInvested: <b>${tradeSize} SOL</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    }
                } else if (!isBuy && copy.copySells !== false) {
                    const res = await simExecuteExit(user.telegramId, token.mint, 100, undefined, 'COPY_TRADE');
                    if (res.success) {
                        try {
                            await bot.telegram.sendMessage(
                                user.telegramId,
                                `👥 <b>SIM COPY TRADE: SELL EXECUTED!</b>\nTarget: <code>${copy.targetWallet.substring(0, 8)}...</code>\nToken: <code>${token.mint}</code> ($${token.symbol})\nStatus: <b>100% Sold</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    }
                }
            }
        }
    }
}

// ─── SIMULATION AUTO-SNIPER LOOP ─────────────────────────
export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        const sessionId = crypto.randomUUID();
        await redis.set(`autosnipe:session_id:sim:${telegramId}`, sessionId, 'EX', 86400);
        await redis.del(`autosnipe:session_spend:sim:${telegramId}`);
        await redis.del(`sim:session_trades:${sessionId}`);
        if (!activeSimLoops.has(telegramId)) {
            activeSimLoops.add(telegramId);
            runSimAutoSnipeLoop(telegramId, bot).finally(() => activeSimLoops.delete(telegramId));
        }
    } else {
        activeSimLoops.delete(telegramId);
    }
    await saveSimulationState(telegramId);
    return newState === 'true';
}

export async function runSimAutoSnipeLoop(telegramId: string, bot: any) {
    const sessionId = await redis.get(`autosnipe:session_id:sim:${telegramId}`);
    let loopCounter = 0;

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        loopCounter++;
        if (loopCounter > 1000) {
            console.warn(`🔴 [SIM] Auto-Snipe loop limit reached for ${telegramId}`);
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            break;
        }

        const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        if (!config || !config.isActive) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }

        const token = await getRealTokenForSimDisplay();

        const stats: TokenStats = {
            ageMins: Math.floor(Math.random() * 60) + 1,
            volume24h: 5000 + Math.random() * 50000,
            liquidity: 3000 + Math.random() * 20000,
            priceChangeM5: (Math.random() * 50) - 10,
            hasSocials: Math.random() > 0.4,
            isRug: false,
            devRep: { launchCount: Math.floor(Math.random() * 5), avgRugScore: 0, isKnownRugger: false },
            lpLock: { burned: true, locked: true, lockPct: 100 },
            velocity: { growthRate: 20 + Math.random() * 40, uniqueBuyers5m: 10 + Math.random() * 20 },
            sellability: { sellable: true, estimatedTaxPct: 0 }
        };

        const scoreRes = computeTokenScore(stats);
        let score = scoreRes.score;

        if (config.minScore > 0 && score < config.minScore) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        const solPrice = cachedSolUsdPrice || 156.93;
        const snipeAmount = calculateDynamicSize(config, score, stats.liquidity, solPrice);

        const currentSpend = await getSessionSpend(telegramId, 'sim');
        const intendedSpend = snipeAmount * (user?.activeWallets || 1);

        if (config.maxBudgetSol && currentSpend + intendedSpend > config.maxBudgetSol) {
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            await sendBudgetExhaustedSummary(bot, telegramId, 'sim', sessionId);
            break;
        }

        const result = await simExecuteSnipe(telegramId, token.mint, snipeAmount, 'SNIPER');

        if (result.success) {
            await addSessionSpend(telegramId, result.volumeSpent, 'sim');
            if (sessionId) {
                await redis.rpush(`sim:session_trades:${sessionId}`, JSON.stringify({
                    mint: token.mint,
                    amountInSol: result.volumeSpent,
                    realizedPnlSol: 0
                }));
            }

            if (config.autoTrailingDropPercent > 0) {
                const entryPrice = await getCachedTokenPrice(token.mint).catch(() => 0.00001);
                await addTrailingStopToMemory(
                    telegramId,
                    token.mint,
                    config.autoTrailingDropPercent,
                    result.volumeSpent,
                    entryPrice || 0.00001,
                    config.autoTakeProfitPercent || undefined
                );
            }

            try {
                await bot.telegram.sendMessage(telegramId,
                    `🎯 <b>SIM AUTO-SNIPE EXECUTED</b>\n\n` +
                    `Token: <code>${token.mint.substring(0, 8)}...</code> ($${token.symbol})\n` +
                    `Amount: <b>${result.volumeSpent.toFixed(4)} SOL</b>\n` +
                    `Score: <b>${score}/100</b> ⭐\n` +
                    `Status: 🟢 Confirmed (Simulated)\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            } catch (_) {}
        }

        const organicDelayMs = [3000, 5000, 8000, 12000][Math.floor(Math.random() * 4)] + Math.random() * 1000;
        await new Promise(r => setTimeout(r, organicDelayMs));
    }

    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
    activeSimLoops.delete(telegramId);
    await saveSimulationState(telegramId);
}

// ─── LIFECYCLE & DATABASE PERSISTENCE ───────────────────
export async function setSimulationMode(telegramId: string, active: boolean): Promise<void> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    const keysToDelete = await redis.keys(`sim:*:${telegramId}`);
    if (keysToDelete.length > 0) await redis.del(...keysToDelete);
    if (activeSimLoops.has(telegramId)) activeSimLoops.delete(telegramId);

    if (!active) {
        await prisma.simTrade.deleteMany({ where: { userId: user.id } });
        await prisma.simState.delete({ where: { userId: user.id } }).catch(() => {});
        await redis.set(`sim:active:${telegramId}`, 'false');
        return;
    }

    const startBal = parseFloat(await redis.get(`sim:balance:${telegramId}`) || '238.8700');

    try {
        await prisma.simState.upsert({
            where: { userId: user.id },
            update: { active: true, balance: startBal, startingBalance: startBal },
            create: { userId: user.id, active: true, balance: startBal, startingBalance: startBal }
        });
    } catch (e) {
        console.error(`[SIM] Failed to persist state for ${telegramId}`, e);
        throw e;
    }

    await redis.set(`sim:active:${telegramId}`, 'true');
    await redis.set(`sim:balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:starting_balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:credits:${telegramId}`, '500');
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
}

export async function consumeSimCredit(telegramId: string): Promise<boolean> {
    const current = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0');
    if (current <= 0) return false;
    await redis.set(`sim:credits:${telegramId}`, (current - 1).toString());
    return true;
}

export async function saveSimulationState(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    const balance = parseFloat(await getSimBalance(telegramId));
    const startingBalance = await getSimStartingBalance(telegramId);
    const volume = parseFloat((await getSimVolume(telegramId))?.toString() || '0');
    const credits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0');
    const active = await isSimulationActive(telegramId);
    const autoSnipeActive = (await redis.get(`sim:autosnipe:${telegramId}`)) === 'true';

    const tradesRaw = await redis.get(`sim:trades:${telegramId}`);
    const trades = tradesRaw ? JSON.parse(tradesRaw) : [];
    const positionsRaw = await redis.get(`sim:positions:${telegramId}`);
    const positions = positionsRaw ? JSON.parse(positionsRaw) : [];

    await prisma.simState.upsert({
        where: { userId: user.id },
        update: {
            balance, startingBalance, volume, credits, active, autoSnipeActive, positions,
            trades: { 
                deleteMany: {}, 
                create: trades.slice(0, 2500).map((t: any) => ({
                    userId: user.id,
                    tokenAddress: t.mint || t.tokenAddress || 'unknown',
                    isBuy: t.isBuy,
                    amountInSol: t.amountInSol,
                    profitPercent: t.profitPercent || 0,
                    realizedPnlSol: t.realizedPnlSol || 0,
                    createdAt: new Date(t.createdAt)
                }))
            }
        },
        create: {
            userId: user.id,
            balance, startingBalance, volume, credits, active, autoSnipeActive, positions,
            trades: { 
                create: trades.slice(0, 2500).map((t: any) => ({
                    userId: user.id,
                    tokenAddress: t.mint || t.tokenAddress || 'unknown',
                    isBuy: t.isBuy,
                    amountInSol: t.amountInSol,
                    profitPercent: t.profitPercent || 0,
                    realizedPnlSol: t.realizedPnlSol || 0,
                    createdAt: new Date(t.createdAt)
                }))
            }
        }
    });
}

export async function loadSimulationState(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    let state = await prisma.simState.findUnique({ 
        where: { userId: user.id }, 
        include: { trades: { orderBy: { createdAt: 'desc' }, take: 2500 } } 
    });

    if (!state) {
        state = await prisma.simState.create({
            data: {
                userId: user.id,
                balance: 238.87,
                startingBalance: 238.87,
                volume: 0,
                credits: 500,
                active: false,
                autoSnipeActive: false,
                positions: []
            },
            include: { trades: true }
        });
    }

    await redis.set(`sim:balance:${telegramId}`, state.balance.toFixed(4));
    await redis.set(`sim:starting_balance:${telegramId}`, state.startingBalance.toFixed(4));
    await redis.set(`sim:volume:${telegramId}`, state.volume.toFixed(4));
    await redis.set(`sim:credits:${telegramId}`, state.credits.toString());
    await redis.set(`sim:active:${telegramId}`, state.active ? 'true' : 'false');
    await redis.set(`sim:autosnipe:${telegramId}`, state.autoSnipeActive ? 'true' : 'false');
    if (state.positions) await redis.set(`sim:positions:${telegramId}`, JSON.stringify(state.positions));

    const trades = state.trades.map((t: any) => ({
        createdAt: t.createdAt.toISOString(),
        isBuy: t.isBuy,
        amountInSol: t.amountInSol,
        profitPercent: t.profitPercent || 0,
        realizedPnlSol: t.realizedPnlSol || 0,
        mint: t.tokenAddress,
        strategy: 'SIMULATED',
        slippagePercent: 0.12
    }));
    await redis.set(`sim:trades:${telegramId}`, JSON.stringify(trades));
}