// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generatePnlCard } from './image.service.js';
import { cachedSolUsdPrice } from './grpc.service.js';
import { computeTokenScore, TokenStats } from './caller.service.js';
import axios from 'axios';
import { awardGuildPoints } from './guild.service.js';

const activeSimLoops = new Set<string>();

export interface SimPosition {
    mint: string;
    symbol: string;
    amount: number;
    entryPrice: number;       // SOL
    entryPriceUsd: number;    // USD
    priceUsd: number;
    valueUsd: number;
    amountInSol: number;
    highestSeenPrice: number; // SOL
    currentPriceSol: number;  // SOL
    trailingPercent: number;  // e.g. 10 for -10%
    takeProfitPercent?: number; // e.g. 40 for +40%
    strategy: string;
    createdAt: number;
    score?: number;
    winTrajectory?: boolean;
    ticksRemaining?: number;
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
    const maxPercentDeviation = Math.abs(targetPnl) * 0.04;
    const absoluteDeviation = (Math.random() * 2 - 1) * Math.max(0.8, maxPercentDeviation);
    return parseFloat((targetPnl + absoluteDeviation).toFixed(2));
}

// ─── DYNAMIC SIZING ENGINE ──────────────────────────────
export function calculateDynamicSize(
    config: any,
    score: number,
    liqUsd: number,
    solPrice: number
): number {
    if (!config?.enableDynamicScaling) return config?.amountSol || 0.05;
    
    const normalizedScore = Math.min(85, Math.max(55, score)) / 100;
    const exponent = config.scaleExponent || 2.0;
    const convictionMultiplier = Math.pow(normalizedScore, exponent);
    
    let size = (config.baseRiskUnitSol || 0.02) + (convictionMultiplier * ((config.baseRiskUnitSol || 0.02) * (config.maxRiskMultiplier || 5.0)));

    if (liqUsd > 0 && solPrice > 0) {
        const maxLiqInSol = (liqUsd * 0.02) / solPrice;
        size = Math.min(size, maxLiqInSol);
    }

    const totalSpent = config.totalSpentSol || 0;
    const remaining = (config.maxBudgetSol || Infinity) - totalSpent;
    size = Math.min(size, remaining);
    
    return Math.max(parseFloat(size.toFixed(4)), 0.005);
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

// ─── SESSION BUDGET ─────────────────────────────────────
export async function getSessionSpend(telegramId: string, mode: 'live' | 'sim'): Promise<number> {
    const val = await redis.get(`autosnipe:session_spend:${mode}:${telegramId}`);
    return val ? parseFloat(val) : 0;
}

export async function addSessionSpend(telegramId: string, amount: number, mode: 'live' | 'sim'): Promise<number> {
    const current = await getSessionSpend(telegramId, mode);
    const updated = current + amount;
    await redis.set(`autosnipe:session_spend:${mode}:${telegramId}`, updated.toString(), 'EX', 86400);
    await redis.set(`sim:session_spend:${telegramId}`, updated.toString(), 'EX', 86400);
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

    const solPrice = cachedSolUsdPrice || 156.93;
    const totalSpentUsd = (totalSpent * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totalPnlUsd = (Math.abs(totalRealizedPnl) * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pnlSign = totalRealizedPnl >= 0 ? '+' : '-';
    const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : "0.0";

    await bot.telegram.sendMessage(telegramId,
        `🏁 <b>AUTO-SNIPE BUDGET EXHAUSTED</b>\n\n` +
        `• <b>Total Spent:</b> <code>${totalSpent.toFixed(4)} SOL ($${totalSpentUsd})</code>\n` +
        `• <b>Trades Executed:</b> ${trades.length} Total (${wins}W / ${losses}L — ${winRate}% Win Rate)\n` +
        `• <b>Net Realized PnL:</b> <b>${pnlSign}${Math.abs(totalRealizedPnl).toFixed(4)} SOL (${pnlSign}$${totalPnlUsd})</b>\n\n` +
        `<i>Session completed. Auto-Sniper paused to protect your exposure limit.</i>`,
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
    strategy: string = 'Sniper Engine', 
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

// ─── HIGH-FREQUENCY SIMULATION GUARD RESOLVER ───────────
export async function startSimulationGuardResolver(bot: any) {
    setInterval(async () => {
        try {
            const simKeys = await redis.keys('sim:positions:*');
            if (simKeys.length === 0) return;

            const solPrice = cachedSolUsdPrice || 156.93;

            for (const key of simKeys) {
                const tgId = key.replace('sim:positions:', '');
                if (!(await isSimulationActive(tgId))) continue;

                const raw = await redis.get(key);
                if (!raw) continue;
                const positions: SimPosition[] = JSON.parse(raw);
                if (positions.length === 0) continue;

                const remainingPositions: SimPosition[] = [];

                for (const pos of positions) {
                    if (pos.ticksRemaining === undefined || pos.ticksRemaining === null) {
                        pos.ticksRemaining = 0;
                    } else {
                        pos.ticksRemaining -= 1;
                    }

                    const targetPnl = pos.winTrajectory
                        ? (pos.takeProfitPercent || 40.0)
                        : -(pos.trailingPercent || 10.0);

                    const progressRatio = (4 - Math.max(0, pos.ticksRemaining)) / 4;
                    let intermediatePnl: number;

                    if (progressRatio < 0.6) {
                        const peakMultiplier = pos.winTrajectory ? 1.20 : 0.4;
                        intermediatePnl = (targetPnl * peakMultiplier) * (progressRatio / 0.6);
                    } else {
                        const peakPnl = targetPnl * (pos.winTrajectory ? 1.20 : 0.4);
                        const pullbackProgress = (progressRatio - 0.6) / 0.4;
                        intermediatePnl = peakPnl + (targetPnl - peakPnl) * pullbackProgress;
                    }

                    pos.currentPriceSol = pos.entryPrice * (1 + intermediatePnl / 100);
                    pos.priceUsd = pos.currentPriceSol * solPrice;
                    pos.valueUsd = parseFloat((pos.amount * pos.priceUsd).toFixed(2));

                    if (pos.currentPriceSol > pos.highestSeenPrice) {
                        pos.highestSeenPrice = pos.currentPriceSol;
                    }

                    // Exit on final tick
                    if (pos.ticksRemaining <= 0) {
                        const finalPnl = applySimSlippage(targetPnl);
                        const isWin = finalPnl >= 0;

                        const exitRes = await simExecuteExit(tgId, pos.mint, 100, finalPnl, pos.strategy);
                        
                        const sessionId = await redis.get(`autosnipe:session_id:sim:${tgId}`);
                        if (sessionId) {
                            const realizedSol = pos.amountInSol * (finalPnl / 100);
                            await redis.rpush(`sim:session_trades:${sessionId}`, JSON.stringify({
                                mint: pos.mint,
                                amountInSol: pos.amountInSol,
                                realizedPnlSol: realizedSol
                            }));
                        }

                        try {
                            const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
                            const imageBuffer = await generatePnlCard(pos.mint, finalPnl, user?.referralCode ?? undefined);
                            const imgId = crypto.randomBytes(8).toString('hex');
                            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);

                            const caption = `${isWin ? '🟢 <b>TAKE PROFIT TRIGGERED!</b>' : '🔴 <b>TRAILING GUARD TRIGGERED!</b>'}\n\n` +
                                `<b>Token:</b> $${pos.symbol} (<code>${pos.mint.substring(0, 8)}...</code>)\n` +
                                `<b>Strategy:</b> <code>${pos.strategy}</code>\n` +
                                `<b>Realized PnL:</b> <b>${isWin ? '+' : ''}${finalPnl.toFixed(2)}%</b>\n` +
                                `<b>Status:</b> 🟢 Confirmed\n` +
                                `🔗 <a href="https://solscan.io/tx/${exitRes.signature}">View on Solscan</a>`;

                            await bot.telegram.sendPhoto(tgId, { source: imageBuffer }, { 
                                caption, 
                                parse_mode: 'HTML',
                                link_preview_options: { is_disabled: true }
                            });
                        } catch (_) {}
                    } else {
                        remainingPositions.push(pos);
                    }
                }

                await redis.set(key, JSON.stringify(remainingPositions));
            }
        } catch (_) {}
    }, 2000);
}

export async function updateSimPositions(telegramId: string): Promise<void> {
    const posKey = `sim:positions:${telegramId}`;
    const raw = await redis.get(posKey);
    if (!raw) return;
    const positions: SimPosition[] = JSON.parse(raw);
    if (positions.length === 0) return;
    const solPrice = cachedSolUsdPrice || 156.93;

    for (const p of positions) {
        if (!p.currentPriceSol) p.currentPriceSol = p.entryPrice;
        p.priceUsd = p.currentPriceSol * solPrice;
        p.valueUsd = parseFloat((p.amount * p.priceUsd).toFixed(2));
    }
    await redis.set(posKey, JSON.stringify(positions));
}

export async function walkSimPositionPrices(telegramId: string): Promise<void> {
    await updateSimPositions(telegramId);
}

export async function getRealTokenForSimDisplay(): Promise<{ mint: string; symbol: string }> {
    const cacheKey = 'sim:real_token_pool';
    let pool: Array<{ mint: string; symbol: string }> = [];
    const cached = await redis.get(cacheKey);
    if (cached) pool = JSON.parse(cached);

    if (pool.length === 0) {
        try {
            const res = await axios.get('https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false', { timeout: 2500 });
            if (Array.isArray(res.data) && res.data.length > 0) {
                pool = res.data.map((c: any) => ({ mint: c.mint, symbol: c.symbol || 'UNKNOWN' }));
                await redis.set(cacheKey, JSON.stringify(pool), 'EX', 120);
            }
        } catch (_) {
            pool = [{ mint: generateSimTokenCA(), symbol: 'MEME' }];
        }
    }

    if (pool.length === 0) return { mint: generateSimTokenCA(), symbol: 'MEME' };
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── TRADE EXECUTION ────────────────────────────────────
export async function simExecuteSnipe(
    telegramId: string, 
    tokenAddress: string, 
    amountSol: number, 
    strategy: string = 'Sniper Engine',
    score: number = 75,
    trailingPercent: number = 10,
    takeProfitPercent: number = 40
): Promise<{ 
    success: boolean; 
    signature: string; 
    message: string; 
    volumeSpent: number;
    auditStats: any;
    auditReasons: string[];
    entryPriceSol: number;
    entryPriceUsd: number;
}> {
    const currentBal = parseFloat(await getSimBalance(telegramId));
    if (currentBal < amountSol + 0.002) {
        return { 
            success: false, 
            signature: '', 
            message: `🔴 Insufficient Funds. Balance: ${currentBal.toFixed(4)} SOL`, 
            volumeSpent: 0,
            auditStats: null,
            auditReasons: [],
            entryPriceSol: 0,
            entryPriceUsd: 0
        };
    }

    const solPrice = cachedSolUsdPrice || 156.93;
    const realToken = await getRealTokenForSimDisplay();
    const symbol = realToken.symbol;
    const priceSol = 0.000005 + (Math.random() * 0.000002);
    const priceUsd = priceSol * solPrice;

    const newBal = Math.max(0, currentBal - amountSol - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const tokenAmount = Math.floor(amountSol / priceSol);
    const posKey = `sim:positions:${telegramId}`;
    const existing: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
    
    // 🟢 Organic score strictly between 58 and 84
    const clampedScore = Math.min(84, Math.max(58, score));
    let winProbability = 0.42;
    if (clampedScore >= 75) winProbability = 0.68;
    else if (clampedScore >= 65) winProbability = 0.58;
    
    const winTrajectory = Math.random() < winProbability;

    const newPosition: SimPosition = {
        mint: tokenAddress,
        symbol,
        amount: tokenAmount,
        entryPrice: priceSol,
        entryPriceUsd: priceUsd,
        priceUsd: priceUsd,
        valueUsd: parseFloat((amountSol * solPrice).toFixed(2)),
        amountInSol: amountSol,
        highestSeenPrice: priceSol,
        currentPriceSol: priceSol,
        trailingPercent: trailingPercent || 10,
        takeProfitPercent: takeProfitPercent || 40,
        strategy,
        score: clampedScore,
        winTrajectory,
        ticksRemaining: 4,
        createdAt: Date.now()
    };

    existing.push(newPosition);
    await redis.set(posKey, JSON.stringify(existing));

    await recordSimTrade(telegramId, true, amountSol, 0, strategy, tokenAddress, 0.12);
    await recordStatsEvent(telegramId, 'sim', 0);
    await awardGuildPoints(telegramId, amountSol).catch(() => {});
    await saveSimulationState(telegramId);

    const auditStats = {
        ageMins: Math.floor(Math.random() * 35) + 2,
        volume: 20000 + Math.random() * 80000,
        liquidity: 12000 + Math.random() * 38000,
        priceChangeM5: (Math.random() * 45) + 15,
        socials: true,
        lpLock: { lockPct: 100, burned: true }
    };

    const auditReasons = [
        `🕒 Age: ${auditStats.ageMins}m`,
        `💰 Vol: $${(auditStats.volume / 1000).toFixed(1)}k`,
        `📈 Mom: +${auditStats.priceChangeM5.toFixed(1)}%`,
        `💧 Liq: $${(auditStats.liquidity / 1000).toFixed(1)}k`,
        `🌐 Socials present`,
        `🔒 LP Secured (100% Locked/Burned)`
    ];

    return { 
        success: true, 
        signature: generateSimSignature(), 
        message: `🟢 Buy confirmed: ${amountSol.toFixed(4)} SOL of $${symbol}`, 
        volumeSpent: amountSol,
        auditStats,
        auditReasons,
        entryPriceSol: priceSol,
        entryPriceUsd: priceUsd
    };
}

export async function simExecuteExit(
    telegramId: string, 
    tokenAddress: string, 
    percent: number = 100, 
    forcedPnlPercent?: number, 
    strategy: string = 'Sniper Engine'
): Promise<{ success: boolean; signature: string; message: string }> {
    const posKey = `sim:positions:${telegramId}`;
    const positions: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
    const posIndex = positions.findIndex(p => p.mint === tokenAddress);
    if (posIndex === -1) return { success: false, signature: '', message: '⚠️ No open position found.' };

    const pos = positions[posIndex];
    const pnlPercent = forcedPnlPercent !== undefined ? forcedPnlPercent : 15.0;

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

    await awardGuildPoints(telegramId, soldSol).catch(() => {});
    await saveSimulationState(telegramId);

    return { 
        success: true, 
        signature: generateSimSignature(), 
        message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` 
    };
}

// ─── SIMULATED AI COIN CALLER ───────────────────────────
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
    const realToken = await getRealTokenForSimDisplay();

    for (let i = 0; i < 20; i++) {
        const ageMins = Math.floor(Math.random() * Math.min(filters.maxAgeMins || 60, 45)) + 1;
        const liquidity = Math.max(filters.minLiquidity, 10000 + Math.random() * 30000);
        const volume24h = Math.max(filters.minVolume24h, liquidity * (Math.random() * 3 + 1.5));
        const priceChangeM5 = Math.min(filters.maxPctChange, Math.max(filters.minPctChange, (Math.random() * 40) + 10));

        const stats: TokenStats = {
            ageMins,
            volume24h,
            liquidity,
            priceChangeM5: parseFloat(priceChangeM5.toFixed(1)),
            hasSocials: true,
            isRug: false,
            devRep: { launchCount: Math.floor(Math.random() * 5), avgRugScore: 0, isKnownRugger: false },
            lpLock: { burned: true, locked: true, lockPct: 100 },
            velocity: { growthRate: 35, uniqueBuyers5m: 18 },
            sellability: { sellable: true, estimatedTaxPct: 0 }
        };

        const scoreRes = computeTokenScore(stats);
        
        // 🟢 Score strictly between 58 and 84
        const simScore = Math.floor(Math.random() * (84 - 58 + 1)) + 58;

        if (simScore >= (filters.minScore || 55)) {
            return {
                mint: realToken.mint,
                symbol: realToken.symbol,
                totalScore: simScore,
                reasons: scoreRes.reasons,
                ageMins: stats.ageMins,
                priceChangeM5: stats.priceChangeM5,
                liquidity: stats.liquidity,
                volume: stats.volume24h,
                mevRisk: 0,
                isReshow: false
            };
        }
    }

    return null;
}

// ─── SIMULATION COPY TRADE SIMULATOR ─────────────────────
export async function processSimCopyTrades(bot: any) {
    const simUsers = await prisma.user.findMany({
        where: { simState: { active: true } },
        include: { copyTrades: { where: { isActive: true } } }
    });

    for (const user of simUsers) {
        for (const copy of user.copyTrades) {
            if (Math.random() < 0.003) {
                const token = await getRealTokenForSimDisplay();
                const isBuy = Math.random() > 0.35;

                if (isBuy && copy.copyBuys !== false) {
                    const tradeSize = copy.maxTradeSizeSol ? Math.min(copy.tradeAmountSol, copy.maxTradeSizeSol) : copy.tradeAmountSol;
                    const randomScore = Math.floor(Math.random() * (84 - 65 + 1)) + 65;
                    const res = await simExecuteSnipe(user.telegramId, token.mint, tradeSize, 'Copy Trade', randomScore, copy.autoTrailingDropPercent || 10, copy.autoTakeProfitPercent || 40);
                    if (res.success) {
                        try {
                            await bot.telegram.sendMessage(
                                user.telegramId,
                                `👥 <b>COPY TRADE: BUY EXECUTED!</b>\nTarget: <code>${copy.targetWallet.substring(0, 8)}...</code>\nToken: <code>${token.mint}</code> ($${token.symbol})\nInvested: <b>${tradeSize} SOL</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    }
                }
            }
        }
    }
}

// ─── SIMULATION AUTO-SNIPER CONTROLLERS ──────────────────
export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        const sessionId = crypto.randomUUID();
        const genId = crypto.randomUUID();
        await redis.set(`sim:autosnipe:gen:${telegramId}`, genId, 'EX', 86400);
        await redis.set(`autosnipe:session_id:sim:${telegramId}`, sessionId, 'EX', 86400);
        await redis.del(`autosnipe:session_spend:sim:${telegramId}`);
        await redis.del(`sim:session_spend:${telegramId}`);
        await redis.del(`sim:session_trades:${sessionId}`);
        if (!activeSimLoops.has(telegramId)) {
            activeSimLoops.add(telegramId);
            runSimAutoSnipeLoop(telegramId, bot, genId).finally(() => activeSimLoops.delete(telegramId));
        }
    } else {
        await redis.del(`sim:autosnipe:gen:${telegramId}`);
        activeSimLoops.delete(telegramId);
    }
    await saveSimulationState(telegramId);
    return newState === 'true';
}

export async function killSimAutoSnipe(telegramId: string): Promise<void> {
    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
    await redis.del(`sim:autosnipe:gen:${telegramId}`);
    activeSimLoops.delete(telegramId);
}

export async function recoverSimAutoSnipeLoops(bot: any) {
    try {
        const keys = await redis.keys('sim:autosnipe:*');
        for (const key of keys) {
            if (key.includes(':gen:')) continue;
            const state = await redis.get(key);
            if (state === 'true') {
                const tgId = key.replace('sim:autosnipe:', '');
                if (!activeSimLoops.has(tgId) && await isSimulationActive(tgId)) {
                    activeSimLoops.add(tgId);
                    let genId = await redis.get(`sim:autosnipe:gen:${tgId}`);
                    if (!genId) {
                        genId = crypto.randomUUID();
                        await redis.set(`sim:autosnipe:gen:${tgId}`, genId, 'EX', 86400);
                    }
                    runSimAutoSnipeLoop(tgId, bot, genId).finally(() => activeSimLoops.delete(tgId));
                    console.log(`🔄 [BOOT RECOVERY] Restarted Sim Auto-Sniper for ${tgId}`);
                }
            }
        }
    } catch (e: any) {
        console.error("🔴 [BOOT RECOVERY] Failed to recover sim sniper loops:", e.message);
    }
}

export async function runSimAutoSnipeLoop(telegramId: string, bot: any, genId?: string) {
    if (!genId) {
        genId = crypto.randomUUID();
        await redis.set(`sim:autosnipe:gen:${telegramId}`, genId, 'EX', 86400);
    }
    const sessionId = await redis.get(`autosnipe:session_id:sim:${telegramId}`);
    let loopCounter = 0;

    while (true) {
        const [active, currentGen] = await Promise.all([
            redis.get(`sim:autosnipe:${telegramId}`),
            redis.get(`sim:autosnipe:gen:${telegramId}`)
        ]);
        if (active !== 'true' || currentGen !== genId) break;
        if (!(await isSimulationActive(telegramId))) break;

        loopCounter++;
        if (loopCounter > 2000) {
            await killSimAutoSnipe(telegramId);
            break;
        }

        const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        if (!config) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        const token = await getRealTokenForSimDisplay();

        const stats: TokenStats = {
            ageMins: Math.floor(Math.random() * 30) + 1,
            volume24h: 20000 + Math.random() * 80000,
            liquidity: 10000 + Math.random() * 40000,
            priceChangeM5: (Math.random() * 50) + 5,
            hasSocials: true,
            isRug: false,
            devRep: { launchCount: Math.floor(Math.random() * 5), avgRugScore: 0, isKnownRugger: false },
            lpLock: { burned: true, locked: true, lockPct: 100 },
            velocity: { growthRate: 35 + Math.random() * 30, uniqueBuyers5m: 20 },
            sellability: { sellable: true, estimatedTaxPct: 0 }
        };

        const scoreRes = computeTokenScore(stats);
        
        // 🟢 Score strictly between 58 and 84
        let score = scoreRes.score;
        if (score <= 0 || score > 84 || score < 58) {
            score = Math.floor(Math.random() * (84 - 58 + 1)) + 58;
        }

        if (config.minScore > 0 && score < config.minScore) {
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        const [activeNow, genNow] = await Promise.all([
            redis.get(`sim:autosnipe:${telegramId}`),
            redis.get(`sim:autosnipe:gen:${telegramId}`)
        ]);
        if (activeNow !== 'true' || genNow !== genId) break;

        const solPrice = cachedSolUsdPrice || 156.93;
        const snipeAmount = calculateDynamicSize(config, score, stats.liquidity, solPrice);

        const currentSpend = await getSessionSpend(telegramId, 'sim');
        const intendedSpend = snipeAmount * (user?.activeWallets || 1);

        if (config.maxBudgetSol && currentSpend + intendedSpend > config.maxBudgetSol) {
            await killSimAutoSnipe(telegramId);
            await sendBudgetExhaustedSummary(bot, telegramId, 'sim', sessionId);
            break;
        }

        const result = await simExecuteSnipe(
            telegramId, 
            token.mint, 
            snipeAmount, 
            'Sniper Engine', 
            score, 
            config.autoTrailingDropPercent || 10, 
            config.autoTakeProfitPercent || 40
        );

        const [activeAfter, genAfter] = await Promise.all([
            redis.get(`sim:autosnipe:${telegramId}`),
            redis.get(`sim:autosnipe:gen:${telegramId}`)
        ]);
        const stillActive = activeAfter === 'true' && genAfter === genId;

        if (result.success) {
            await addSessionSpend(telegramId, result.volumeSpent, 'sim');

            if (stillActive) {
                try {
                    const tpPct = config.autoTakeProfitPercent || 40;
                    const slPct = config.autoTrailingDropPercent || 10;
                    const targetTpPrice = result.entryPriceUsd * (1 + tpPct / 100);
                    const stopLossPrice = result.entryPriceUsd * (1 - slPct / 100);

                    let auditMessage = `🎯 <b>AUTO-SNIPE EXECUTED</b>\n\n`;
                    auditMessage += `Token: <code>${token.mint.substring(0, 8)}...</code> ($${token.symbol})\n`;
                    auditMessage += `Strategy: <b>Sniper Engine</b>\n`;
                    auditMessage += `Score: <b>${score}/100</b> ⭐\n\n`;
                    auditMessage += `<b>Audit Trail:</b>\n`;
                    (result.auditReasons || []).forEach(r => auditMessage += `✅ ${r}\n`);
                    auditMessage += `\n💵 <b>Entry Price:</b> <code>$${result.entryPriceUsd.toFixed(6)}</code>\n`;
                    auditMessage += `🎯 <b>Take Profit (+${tpPct}%):</b> <code>$${targetTpPrice.toFixed(6)}</code>\n`;
                    auditMessage += `🛡️ <b>Trailing Stop (-${slPct}%):</b> <code>$${stopLossPrice.toFixed(6)}</code>\n`;
                    auditMessage += `💰 <b>Invested:</b> <b>${result.volumeSpent.toFixed(4)} SOL</b>\n\n`;
                    auditMessage += `Status: 🟢 Confirmed\n`;
                    auditMessage += `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                    await bot.telegram.sendMessage(telegramId, auditMessage, { 
                        parse_mode: 'HTML', 
                        link_preview_options: { is_disabled: true } 
                    });
                } catch (_) {}
            }
        }

        if (!stillActive) break;

        const organicDelayMs = 500 + Math.random() * 1000;
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
    } catch (e: any) {
        console.error(`[SIM] State persistence failure for ${telegramId}:`, e.message);
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

    const BATCH_SIZE = 100;
    const mappedTrades = trades.slice(0, 2500).map((t: any) => ({
        userId: user.id,
        tokenAddress: t.mint || t.tokenAddress || 'unknown',
        isBuy: t.isBuy,
        amountInSol: t.amountInSol,
        profitPercent: t.profitPercent || 0,
        realizedPnlSol: t.realizedPnlSol || 0,
        createdAt: new Date(t.createdAt)
    }));

    try {
        await prisma.simState.upsert({
            where: { userId: user.id },
            update: {
                balance, startingBalance, volume, credits, active, autoSnipeActive, positions
            },
            create: {
                userId: user.id,
                balance, startingBalance, volume, credits, active, autoSnipeActive, positions
            }
        });

        await prisma.simTrade.deleteMany({ where: { userId: user.id } });

        for (let i = 0; i < mappedTrades.length; i += BATCH_SIZE) {
            const chunk = mappedTrades.slice(i, i + BATCH_SIZE);
            await prisma.simTrade.createMany({
                data: chunk,
                skipDuplicates: true,
            });
        }
    } catch (e: any) {
        console.error("🔴 [SIM DB] Failed to persist simulation state:", e.message);
    }
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
        strategy: 'Sniper Engine',
        slippagePercent: 0.12
    }));
    await redis.set(`sim:trades:${telegramId}`, JSON.stringify(trades));
}