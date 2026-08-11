// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generatePnlCard } from './image.service.js';
import { computeTokenScore, TokenStats, buildAuditTrailMessage } from './caller.service.js';
import { ensureFirstTradeAnchor } from './engine.service.js';

const activeSimLoops = new Set<string>();

export async function getSimCounters(telegramId: string): Promise<{ wins: number; losses: number; totalTrades: number; totalInvestedSol: number; totalPnlSol: number }> {
    const wins = parseInt(await redis.get(`sim:stats:wins:${telegramId}`) || '0');
    const losses = parseInt(await redis.get(`sim:stats:losses:${telegramId}`) || '0');
    const totalTrades = parseInt(await redis.get(`sim:stats:totalTrades:${telegramId}`) || '0');
    const totalInvestedSol = parseFloat(await redis.get(`sim:stats:totalInvestedSol:${telegramId}`) || '0');
    const totalPnlSol = parseFloat(await redis.get(`sim:stats:totalPnlSol:${telegramId}`) || '0');
    return { wins, losses, totalTrades, totalInvestedSol, totalPnlSol };
}

export async function setSimCounters(telegramId: string, wins: number, losses: number, totalTrades: number, totalInvestedSol: number, totalPnlSol: number) {
    await redis.set(`sim:stats:wins:${telegramId}`, wins.toString());
    await redis.set(`sim:stats:losses:${telegramId}`, losses.toString());
    await redis.set(`sim:stats:totalTrades:${telegramId}`, totalTrades.toString());
    await redis.set(`sim:stats:totalInvestedSol:${telegramId}`, totalInvestedSol.toString());
    await redis.set(`sim:stats:totalPnlSol:${telegramId}`, totalPnlSol.toString());
}

export async function getSimFirstTradeAt(telegramId: string): Promise<string | null> {
    return await redis.get(`sim:first_trade_at:${telegramId}`);
}

function randomBase58(length: number): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) result += chars[bytes[i] % chars.length];
    return result;
}

export function applySimSlippage(targetPnl: number): number {
    const maxPercentDeviation = Math.abs(targetPnl) * 0.05;
    const absoluteDeviation = (Math.random() * 2 - 1) * Math.max(1.2, maxPercentDeviation);
    return parseFloat((targetPnl + absoluteDeviation).toFixed(2));
}

export function generateSimWallets(): Array<{ address: string; balance: number }> {
    const count = Math.floor(Math.random() * 5) + 1;
    return Array.from({ length: count }, () => ({
        address: randomBase58(44), 
        balance: parseFloat((Math.random() * 8 + 0.5).toFixed(4))
    }));
}

export function generateSimTokenCA(): string {
    const isPump = Math.random() > 0.4;
    const base = randomBase58(isPump ? 36 : 44);
    return isPump ? base + 'pump' : base;
}

export function generateSimSignature(): string {
    return randomBase58(87);
}

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

    const { cachedSolUsdPrice } = await import('./grpc.service.js');
    const usdValue = (totalRealizedPnl * cachedSolUsdPrice).toFixed(2);

    await bot.telegram.sendMessage(telegramId,
        `🏁 <b>AUTO-SNIPE BUDGET EXHAUSTED${mode === 'sim' ? ' (SIM)' : ''}</b>\n\n` +
        `Total Spent: <b>${totalSpent.toFixed(4)} SOL</b>\n` +
        `Trades Executed: <b>${trades.length} (${wins}W / ${losses}L)</b>\n` +
        `Net Result: <b>${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(4)} SOL (${totalRealizedPnl >= 0 ? '+' : ''}$${usdValue})</b>\n\n` +
        `Session ended — budget cap reached.`,
        { parse_mode: 'HTML' }
    );
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
                create: trades.slice(0, 100).map((t: any) => ({
                    userId: user.id, tokenAddress: t.mint || t.tokenAddress || 'unknown',
                    isBuy: t.isBuy, amountInSol: t.amountInSol, profitPercent: t.profitPercent || 0,
                    realizedPnlSol: t.realizedPnlSol || 0, createdAt: new Date(t.createdAt)
                }))
            }
        },
        create: {
            userId: user.id, balance, startingBalance, volume, credits, active, autoSnipeActive, positions,
            trades: { 
                create: trades.slice(0, 100).map((t: any) => ({
                    userId: user.id, tokenAddress: t.mint || t.tokenAddress || 'unknown',
                    isBuy: t.isBuy, amountInSol: t.amountInSol, profitPercent: t.profitPercent || 0,
                    realizedPnlSol: t.realizedPnlSol || 0, createdAt: new Date(t.createdAt)
                }))
            }
        }
    });
}

export async function loadSimulationState(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    // Do NOT load if simulation mode is explicitly turned OFF
    const isActive = await redis.get(`sim:active:${telegramId}`);
    if (isActive === 'false') {
        return;
    }

    const state = await prisma.simState.findUnique({
        where: { userId: user.id }, 
        include: { trades: { orderBy: { createdAt: 'desc' }, take: 100 } }
    });
    if (!state) return;

    await redis.set(`sim:balance:${telegramId}`, state.balance.toFixed(4));
    await redis.set(`sim:starting_balance:${telegramId}`, state.startingBalance.toFixed(4));
    await redis.set(`sim:volume:${telegramId}`, state.volume.toFixed(4));
    await redis.set(`sim:credits:${telegramId}`, state.credits.toString());
    await redis.set(`sim:active:${telegramId}`, state.active ? 'true' : 'false');
    await redis.set(`sim:autosnipe:${telegramId}`, state.autoSnipeActive ? 'true' : 'false');
    if (state.positions) await redis.set(`sim:positions:${telegramId}`, JSON.stringify(state.positions));

    const trades = state.trades.map((t: any) => ({
        createdAt: t.createdAt.toISOString(), isBuy: t.isBuy, amountInSol: t.amountInSol,
        profitPercent: t.profitPercent || 0, realizedPnlSol: t.realizedPnlSol || 0,
        mint: t.tokenAddress, strategy: t.strategy || 'SIMULATED'
    }));
    await redis.set(`sim:trades:${telegramId}`, JSON.stringify(trades));
}

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

// src/services/simulation.service.ts

export async function getSimBalance(telegramId: string): Promise<string> {
    try {
        // 🟢 CRITICAL FIX: Check active flag safely without throwing if Redis is connecting
        const isActive = await isSimulationActive(telegramId).catch(() => false);
        if (!isActive) return '0.0000';
    } catch (e) {
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

    const events = raw.map((r: string) => {
        try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    const totalPnl = events.reduce((sum: number, e: any) => sum + (e.pnl || 0), 0);
    const wins = events.filter((e: any) => e.pnl > 0).length;
    const losses = events.filter((e: any) => e.pnl < 0).length;

    return { totalPnl, wins, losses, tradeCount: events.length };
}

export async function recordSimTrade(telegramId: string, isBuy: boolean, amountInSol: number, profitPercent: number = 0, strategy: string = 'SIMULATED') {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    const realizedPnlSol = isBuy ? 0 : amountInSol * (profitPercent / 100);

    existing.unshift({
        createdAt: new Date().toISOString(), isBuy, amountInSol, profitPercent, realizedPnlSol, strategy, mint: 'simulated'
    });

    const trimmed = existing.slice(0, 10000);
    await redis.set(key, JSON.stringify(trimmed));

    const anchorKey = `sim:first_trade_at:${telegramId}`;
    if (!(await redis.get(anchorKey))) await redis.set(anchorKey, new Date().toISOString());

    const counters = await getSimCounters(telegramId);
    counters.totalTrades++;
    if (!isBuy) {
        counters.totalInvestedSol += amountInSol;
        counters.totalPnlSol += realizedPnlSol;
        if (profitPercent > 0.5) counters.wins++;
        else if (profitPercent < -0.5) counters.losses++;
    }
    await setSimCounters(telegramId, counters.wins, counters.losses, counters.totalTrades, counters.totalInvestedSol, counters.totalPnlSol);
    await redis.incrbyfloat(`sim:volume:${telegramId}`, amountInSol);
}

export async function getRealTokenForSimDisplay(): Promise<{ mint: string; symbol: string }> {
    const cacheKey = 'sim:real_token_pool';
    let pool: Array<{ mint: string; symbol: string }> = [];
    const cached = await redis.get(cacheKey);
    if (cached) pool = JSON.parse(cached);

    if (pool.length === 0) {
        try {
            const { scoreTokens } = await import('./caller.service.js');
            const realTokens = await scoreTokens();
            // Explicit type casting on map callback
            pool = realTokens.map((t: any) => ({ mint: t.mint, symbol: t.symbol }));
            if (pool.length > 0) await redis.set(cacheKey, JSON.stringify(pool), 'EX', 60);
        } catch (_) { }
    }

    if (pool.length === 0) return { mint: generateSimTokenCA(), symbol: 'SIMDEMO' };
    return pool[Math.floor(Math.random() * pool.length)];
}

export async function simExecuteSnipe(
    telegramId: string, tokenAddress: string, amountSol: number
): Promise<{ success: boolean; signature: string; message: string; volumeSpent: number }> {
    await ensureFirstTradeAnchor(telegramId);
    const currentBal = parseFloat(await getSimBalance(telegramId));
    
    let actualSolSpent = amountSol;
    if (amountSol <= 0.05) {
        actualSolSpent = parseFloat((Math.random() * 3.44 + 0.01).toFixed(3));
    } else {
        const variance = (Math.random() * 0.6 + 0.7);
        actualSolSpent = parseFloat(Math.min(3.45, Math.max(0.01, amountSol * variance)).toFixed(3));
    }

    if (currentBal < actualSolSpent + 0.001) {
        actualSolSpent = Math.max(0.01, parseFloat((currentBal * 0.8).toFixed(3)));
        if (currentBal < 0.015) {
            return { success: false, signature: '', message: `🔴 Insufficient Funds. Balance: ${currentBal.toFixed(4)} SOL`, volumeSpent: 0 };
        }
    }

    await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));

    const newBal = Math.max(0, currentBal - actualSolSpent - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const posKey = `sim:positions:${telegramId}`;
    const existing = JSON.parse(await redis.get(posKey) || '[]');

    let symbol = 'UNKNOWN';
    let entryPriceSol = 0;
    let entryPriceUsd = 0;
    const solUsdPrice = 160;

    try {
        const { default: axios } = await import('axios');
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (res.data?.pairs?.length > 0) {
            symbol = res.data.pairs[0].baseToken.symbol;
            entryPriceUsd = parseFloat(res.data.pairs[0].priceUsd || "0");
        }
        const { getCachedTokenPrice } = await import('./engine.service.js');
        entryPriceSol = await getCachedTokenPrice(tokenAddress);
    } catch (e) { }

    if (entryPriceSol === 0) {
        entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(12));
        if (symbol === 'UNKNOWN') {
            const tokenNames = ['DEGEN', 'CHAD', 'PEPE', 'BONK', 'WIF', 'POPCAT', 'GIGA', 'PNUT', 'GOAT'];
            symbol = tokenNames[Math.floor(Math.random() * tokenNames.length)];
        }
    }
    if (entryPriceUsd === 0) entryPriceUsd = entryPriceSol * solUsdPrice;

    const tokenAmount = Math.floor(actualSolSpent / entryPriceSol);
    const entrySpread = (Math.random() * 0.06) - 0.03;
    const initialValueUsd = (actualSolSpent * solUsdPrice) * (0.99 + entrySpread);

    existing.push({
        mint: tokenAddress, symbol, amount: tokenAmount, entryPrice: entryPriceSol, entryPriceUsd,
        priceUsd: entryPriceUsd * (1 + entrySpread), valueUsd: parseFloat(initialValueUsd.toFixed(2)),
        amountInSol: actualSolSpent, highestSeenPrice: entryPriceSol,
        entryScore: Math.floor(Math.random() * 40) + 50, volatilitySeed: (Math.random() * 2 - 1)
    });

    await redis.set(posKey, JSON.stringify(existing));
    await recordSimTrade(telegramId, true, actualSolSpent, 0, 'SIMULATED_BUY');
    await recordStatsEvent(telegramId, 'sim', 0);
    await saveSimulationState(telegramId);

    return { success: true, signature: generateSimSignature(), message: '🟢 Simulated buy executed.', volumeSpent: actualSolSpent };
}

export async function simExecuteExit(
    telegramId: string, tokenAddress: string, percent: number, forcedPnlPercent?: number
): Promise<{ success: boolean; signature: string; message: string }> {

    await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));

    const posKey = `sim:positions:${telegramId}`;
    const positions = JSON.parse(await redis.get(posKey) || '[]');
    const pos = positions.find((p: any) => p.mint === tokenAddress);

    if (!pos) return { success: false, signature: '', message: '⚠️ No open position found for this token.' };

    let pnlPercent: number;
    if (forcedPnlPercent !== undefined) {
        pnlPercent = forcedPnlPercent;
    } else {
        const isProfit = await getNextSimOutcome(telegramId, 'guard', pos.entryScore);
        if (isProfit) pnlPercent = parseFloat((Math.random() * 80 + 15).toFixed(2));
        else pnlPercent = parseFloat((-(Math.random() * 20 + 5)).toFixed(2));
    }

    const soldSol = pos.amountInSol * (percent / 100);
    const rawReturn = soldSol * (1 + pnlPercent / 100);
    const platformFee = rawReturn * 0.01;
    const jitoTip = 0.0015;
    const netReturnSol = Math.max(0, rawReturn - platformFee - jitoTip);

    const currentBal = parseFloat(await getSimBalance(telegramId));
    await redis.set(`sim:balance:${telegramId}`, (currentBal + netReturnSol).toFixed(4));

    if (percent === 100) {
        const updated = positions.filter((p: any) => p.mint !== tokenAddress);
        await redis.set(posKey, JSON.stringify(updated));
    } else {
        pos.amount = pos.amount * (1 - (percent / 100));
        pos.amountInSol = pos.amountInSol * (1 - (percent / 100));
        pos.valueUsd = pos.valueUsd * (1 - (percent / 100));
        await redis.set(posKey, JSON.stringify(positions));
    }

    const realizedPnlSol = netReturnSol - soldSol;
    await recordSimTrade(telegramId, false, soldSol, pnlPercent, 'SIMULATED_SELL');
    await recordStatsEvent(telegramId, 'sim', realizedPnlSol);
    await saveSimulationState(telegramId);

    return { success: true, signature: generateSimSignature(), message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` };
}

export async function generateSimCallerAlert(telegramId: string, filters: {
    minScore: number; maxAgeMins: number; minPctChange: number; maxPctChange: number;
    minLiquidity: number; minVolume24h: number; blockMev: boolean;
}): Promise<any> {

    try {
        const hotRaw = await redis.get('caller:hot_scored_tokens');
        if (hotRaw) {
            const hotTokens = JSON.parse(hotRaw);
            const matching = hotTokens.filter((t: any) =>
                t.totalScore >= filters.minScore && t.ageMins <= filters.maxAgeMins &&
                t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange &&
                ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) ||
                    (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
                t.liquidity >= filters.minLiquidity && (!filters.blockMev || t.breakdown?.mevRisk >= 0)
            );

            if (matching.length > 0) {
                let bestMatch = null;
                let isReshow = false;
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
                if (bestMatch) return {
                    mint: bestMatch.mint, symbol: bestMatch.symbol, score: bestMatch.totalScore ?? bestMatch.score,
                    reasons: bestMatch.reasons || [], ageMins: bestMatch.ageMins, priceChangeM5: bestMatch.priceChangeM5 || 0,
                    mevRisk: bestMatch.breakdown?.mevRisk ?? 0, liquidity: bestMatch.liquidity, volume: bestMatch.volume, isReshow
                };
            }
        }
    } catch (e) { }

    const poolSize = 25;
    const candidates: any[] = [];
    const realToken = await getRealTokenForSimDisplay();

    for (let i = 0; i < poolSize; i++) {
        const ageMins = Math.floor(Math.random() * 120) + 1;

        let liquidity = 0;
        const liqRand = Math.random();
        if (liqRand < 0.70) liquidity = Math.random() * 7000 + 3000;
        else if (liqRand < 0.95) liquidity = Math.random() * 15000 + 10000;
        else liquidity = Math.random() * 55000 + 25000;

        let volume24h = 0;
        const volRand = Math.random();
        if (volRand < 0.60) volume24h = liquidity * (Math.random() * 2 + 0.5);
        else if (volRand < 0.90) volume24h = liquidity * (Math.random() * 5 + 2);
        else volume24h = liquidity * (Math.random() * 15 + 5);

        let priceChangeM5 = 0;
        const momRand = Math.random();
        if (momRand < 0.60) priceChangeM5 = (Math.random() * 15) - 10;
        else if (momRand < 0.90) priceChangeM5 = (Math.random() * 25) + 5;
        else priceChangeM5 = (Math.random() * 120) + 30;

        const stats: TokenStats = {
            ageMins, volume24h, liquidity, priceChangeM5: parseFloat(priceChangeM5.toFixed(1)),
            hasSocials: Math.random() > 0.40, isRug: Math.random() < 0.08,
            devRep: { launchCount: Math.floor(Math.random() * 12), avgRugScore: Math.random() * 0.3, isKnownRugger: Math.random() < 0.03 },
            lpLock: { burned: Math.random() < 0.35, locked: Math.random() < 0.25, lockPct: Math.random() < 0.5 ? Math.random() * 30 : 60 + Math.random() * 40 },
            velocity: { growthRate: Math.random() < 0.3 ? Math.random() * 80 : (Math.random() - 0.3) * 40, uniqueBuyers5m: Math.floor(Math.random() * 40) },
            sellability: { sellable: Math.random() > 0.05, estimatedTaxPct: Math.random() * 10 }
        };

        const rawScore = computeTokenScore(stats).score;
        const simScore = rawScore === 55 ? Math.floor(Math.random() * 30) + 56 : Math.round(rawScore);

        candidates.push({
            mint: realToken.mint, symbol: realToken.symbol, totalScore: simScore,
            reasons: computeTokenScore(stats).reasons, ageMins: stats.ageMins, priceChangeM5: stats.priceChangeM5,
            liquidity: stats.liquidity, volume: stats.volume24h, mevRisk: stats.isRug ? -100 : 0
        });
    }

    const matching = candidates.filter((t: any) =>
        t.totalScore >= filters.minScore && t.ageMins <= filters.maxAgeMins &&
        t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange &&
        t.liquidity >= filters.minLiquidity && t.volume >= filters.minVolume24h &&
        (!filters.blockMev || t.mevRisk >= 0)
    );

    if (matching.length > 0) {
        let bestMatch = null;
        let isReshow = false;
        for (const t of matching) {
            const seen = await redis.get(`sim_alerted:${telegramId}:${t.mint}`);
            if (!seen) {
                bestMatch = t;
                await redis.set(`sim_alerted:${telegramId}:${t.mint}`, '1', 'EX', 300);
                break;
            }
        }
        if (!bestMatch && matching.length > 0) {
            bestMatch = matching.sort((a: any, b: any) => b.totalScore - a.totalScore)[0];
            isReshow = true;
        }
        if (bestMatch) return { ...bestMatch, isReshow };
    }
    return null;
}

export async function getNextSimOutcome(telegramId: string, type: 'caller' | 'guard', score?: number): Promise<boolean> {
    const streakKey = `sim:streak:${type}:${telegramId}`;
    const streak = parseInt(await redis.get(streakKey) || '0');

    let baseWinProb = 0.50; 
    const organicVariance = (Math.random() * 0.30) - 0.15; 
    let adjustedProb = baseWinProb + organicVariance;
    
    adjustedProb = Math.min(0.70, Math.max(0.30, adjustedProb));
    
    const isWin = Math.random() < adjustedProb;

    const newStreak = isWin ? (streak > 0 ? streak + 1 : 1) : (streak < 0 ? streak - 1 : -1);
    await redis.set(streakKey, newStreak.toString(), 'EX', 3600);
    await redis.set(`sim:last_outcome:${type}:${telegramId}`, isWin ? 'true' : 'false', 'EX', 3600);

    return isWin;
}

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
    }
    
    await saveSimulationState(telegramId);
    return newState === 'true';
}

async function runSimAutoSnipeLoop(telegramId: string, bot: any) {
    const sessionId = await redis.get(`autosnipe:session_id:sim:${telegramId}`);

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        const amountSol = config?.amountSol || 0.1;
        const slPercent = config?.autoTrailingDropPercent || 20;
        const tpPercent = config?.autoTakeProfitPercent || 50;
        const maxBudget = config?.maxBudgetSol || 10.0;
        const minScore = config?.minScore || 0;

        const currentSpend = await getSessionSpend(telegramId, 'sim');
        if (currentSpend + amountSol > maxBudget) {
            await sendBudgetExhaustedSummary(bot, telegramId, 'sim', sessionId);
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            break;
        }

        const filters = { minScore: minScore || 0, maxAgeMins: 90, minPctChange: 10, maxPctChange: 500, minLiquidity: 2000, minVolume24h: 2000, blockMev: true };
        const alert = await generateSimCallerAlert(telegramId, filters);

        let tokenCA = '';
        let stats: any;
        let simScore = 0;

        if (alert && alert.mint) {
            tokenCA = alert.mint;
            simScore = alert.totalScore ?? alert.score ?? 50;
            stats = { ageMins: alert.ageMins, volume: alert.volume, liquidity: alert.liquidity, priceChangeM5: alert.priceChangeM5 };
            
            const currentCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0');
            if (currentCredits <= 0) {
                await bot.telegram.sendMessage(telegramId, `⚠️ <b>SIM CREDITS DEPLETED</b>\n\nYour simulated Auto-Sniper has paused. Top up credits with <code>/simcredits 500</code>.`, { parse_mode: 'HTML' });
                await redis.set(`sim:autosnipe:${telegramId}`, 'false');
                break;
            }
            await redis.set(`sim:credits:${telegramId}`, (currentCredits - 1).toString());

        } else {
            const realTok = await getRealTokenForSimDisplay();
            tokenCA = realTok.mint;
            stats = {
                ageMins: Math.floor(Math.random() * 60) + 1,
                volume: Math.random() * 50000 + 5000,
                liquidity: Math.random() * 20000 + 2000,
                priceChangeM5: Math.random() * 50 + 5,
                hasSocials: true, isRug: false
            };
            
            const floor = Math.max(50, minScore);
            simScore = Math.floor(Math.random() * (95 - floor + 1)) + floor;

            if (simScore < minScore) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
        }

        const isProfit = await getNextSimOutcome(telegramId, 'guard', simScore);
        const targetPnl = isProfit ? (tpPercent || 50) : -Math.abs(slPercent || 20);
        const finalPnl = applySimSlippage(targetPnl);

        const buyRes = await simExecuteSnipe(telegramId, tokenCA, amountSol);
        if (!buyRes.success) {
            await bot.telegram.sendMessage(telegramId, `🛑 <b>AUTO-SNIPER PAUSED:</b> Simulated balance insufficient.`, { parse_mode: 'HTML' });
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            break;
        }

        await addSessionSpend(telegramId, buyRes.volumeSpent, 'sim');
        if (sessionId) {
            await redis.rpush(`sim:session_trades:${sessionId}`, JSON.stringify({ mint: tokenCA, amountInSol: buyRes.volumeSpent, realizedPnlSol: 0 }));
        }

        const buyMsg = buildAuditTrailMessage(
            tokenCA, simScore, stats, buyRes.volumeSpent, slPercent, config?.autoTakeProfitPercent ? tpPercent : 'OFF', true
        ) + `\n\n🔗 <a href="https://solscan.io/tx/${buyRes.signature}">View on Solscan</a>`;

        await bot.telegram.sendMessage(telegramId, buyMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

        const useDeep = config?.useDeepScoring || false;
        const holdDelay = useDeep ? 5000 : 3000;
        await new Promise(r => setTimeout(r, holdDelay));

        const sellRes = await simExecuteExit(telegramId, tokenCA, 100, finalPnl);

        if (sessionId) {
            const realizedPnlSol = buyRes.volumeSpent * (finalPnl / 100);
            const lastTradeStr = await redis.rpop(`sim:session_trades:${sessionId}`);
            if (lastTradeStr) {
                const lastTrade = JSON.parse(lastTradeStr);
                lastTrade.realizedPnlSol = realizedPnlSol;
                await redis.rpush(`sim:session_trades:${sessionId}`, JSON.stringify(lastTrade));
            }
        }

        await sendSimPnlCard(telegramId, bot, tokenCA, buyRes.volumeSpent, finalPnl, slPercent, 0, 0);

        const organicDelayMs = [1000, 5000, 8000, 10000][Math.floor(Math.random() * 4)] + Math.random() * 1000;
        await new Promise(r => setTimeout(r, organicDelayMs));
    }

    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
    await saveSimulationState(telegramId);
}

async function sendSimPnlCard(telegramId: string, bot: any, tokenAddress: string, amountInSol: number, pnlPercent: number, slPercent: number, entryPriceSol: number, tokensBought: number) {
    const isProfit = pnlPercent >= 0;
    const exitSig = generateSimSignature();

    const pnlMessage = isProfit
        ? `💰 <b>Net Profit: +${(amountInSol * (pnlPercent / 100)).toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
        : `🩸 <b>Incurred Loss: -${(amountInSol * Math.abs(pnlPercent / 100)).toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;

    const captionText =
        `${isProfit ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'}\n\n` +
        `Token: <code>${tokenAddress.substring(0,8)}...</code>\n` +
        `${!isProfit ? `📉 <b>Peak Drop: -${slPercent.toFixed(1)}%</b>\n` : ''}` +
        `${pnlMessage}\n` +
        `Status: 🟢 Auto-Sold 100% via Simulated Jito Bundle.\n` +
        `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        const imageBuffer = await generatePnlCard(tokenAddress, pnlPercent, user?.referralCode ?? undefined);
        const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
        const imgId = crypto.randomBytes(8).toString('hex');
        await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);
        const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;
        const tweetText = encodeURIComponent(
            `Just secured a verified ${pnlPercent >= 0 ? `gain of +${pnlPercent.toFixed(1)}%` : `loss protection`} on $${tokenAddress.substring(0,6).toUpperCase()} using Sentry Terminal ⚡\n\nCopy my trades and earn passive SOL here 👇\n${shareUrl}`
        );
        const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

        await bot.telegram.sendPhoto(
            telegramId,
            { source: imageBuffer },
            { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
        );
    } catch (e: any) {
        await bot.telegram.sendMessage(telegramId, captionText, { parse_mode: 'HTML' });
    }
}

export async function walkSimPositionPrices(telegramId: string): Promise<void> {
    const posKey = `sim:positions:${telegramId}`;
    const raw = await redis.get(posKey);
    if (!raw) return;

    const positions = JSON.parse(raw);
    if (positions.length === 0) return;

    let changed = false;
    const solUsdPrice = 160;

    for (const p of positions) {
        if (p.volatilitySeed === undefined) p.volatilitySeed = (Math.random() * 2 - 1); 

        const scoreBias = ((p.entryScore ?? 50) - 50) / 50;
        const randomStep = (Math.random() - 0.48 + scoreBias * 0.2 + p.volatilitySeed * 0.1) * 7.5;
        const newPriceUsd = Math.max(p.entryPriceUsd * 0.02, p.priceUsd * (1 + randomStep / 100));

        p.priceUsd = newPriceUsd;
        
        const pnlRatio = newPriceUsd / (p.entryPriceUsd || 1);
        p.valueUsd = parseFloat(((p.amountInSol * solUsdPrice) * pnlRatio).toFixed(2));
        
        if (newPriceUsd > (p.highestSeenPrice || 0)) p.highestSeenPrice = newPriceUsd;
        changed = true;
    }

    if (changed) await redis.set(posKey, JSON.stringify(positions));
}

setInterval(async () => {
    try {
        const simStates = await prisma.simState.findMany({ 
            where: { active: true }, 
            select: { user: { select: { telegramId: true } } } 
        });
        for (const state of simStates) {
            if (state.user?.telegramId) await walkSimPositionPrices(state.user.telegramId);
        }
    } catch (e) {}
}, 3000);


export async function setSimulationMode(telegramId: string, active: boolean): Promise<void> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return;

  if (active) {
      const startBal = parseFloat(await redis.get(`sim:balance:${telegramId}`) || '1000');
      await redis.set(`sim:active:${telegramId}`, 'true');
      await redis.set(`sim:balance:${telegramId}`, startBal.toFixed(4));
      await redis.set(`sim:starting_balance:${telegramId}`, startBal.toFixed(4));
      const wallets = generateSimWallets();
      await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));

      await prisma.simState.upsert({
          where: { userId: user.id },
          update: { active: true, balance: startBal, startingBalance: startBal },
          create: { userId: user.id, active: true, balance: startBal, startingBalance: startBal }
      });
  } else {
      // Complete purge of Redis Keys and Database state
      const keys = await redis.keys(`sim:*:${telegramId}`);
      if (keys.length > 0) await redis.del(...keys);

      await prisma.simTrade.deleteMany({ where: { userId: user.id } });
      await prisma.simState.delete({ where: { userId: user.id } }).catch(() => {});

      await redis.set(`sim:active:${telegramId}`, 'false');
      console.log(`✅ [SIM] Completely purged simulation data for ${telegramId}`);
  }
}

export async function consumeSimCredit(telegramId: string): Promise<boolean> {
    const current = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0');
    if (current <= 0) return false;
    await redis.set(`sim:credits:${telegramId}`, (current - 1).toString());
    return true;
}