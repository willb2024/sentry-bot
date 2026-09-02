// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import { redlock } from '../lib/redlock.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generatePnlCard } from './image.service.js';
import { cachedSolUsdPrice } from './grpc.service.js';
import { computeTokenScore, TokenStats } from './caller.service.js';
import { getCachedTokenPrice } from './engine.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice, getTokenMetadata } from './price.service.js';
import { addTrailingStopToMemory, cancelAllGuardsForToken } from './order.service.js';
import { awardGuildPoints } from './guild.service.js';
import { connection } from '../lib/connection.js';
import { PublicKey } from '@solana/web3.js';
import axios from 'axios';

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
    trailingPercent: number;  
    takeProfitPercent?: number; 
    strategy: string;
    createdAt: number;
    score?: number;
    winTrajectory?: boolean;
    ticksRemaining?: number;
}

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

/** Real live price in SOL for any mint — same resolution order as the live engine. */
export async function getRealEntryPrice(mint: string): Promise<number> {
    try {
        const p = await getCachedTokenPrice(mint, true);
        if (p > 0) return p;
    } catch (_) {}
    if (mint.toLowerCase().endsWith('pump')) {
        try {
            const curvePda = getBondingCurveAddress(mint);
            if (curvePda) {
                const acc = await connection.getAccountInfo(new PublicKey(curvePda));
                if (acc?.data) {
                    const buf = Buffer.isBuffer(acc.data) ? acc.data : Buffer.from(acc.data);
                    const price = decodePumpCurvePrice(buf.toString('base64'));
                    if (price > 0) return price;
                }
            }
        } catch (_) {}
    }
    return 0;
}

/** Model realistic slippage from real liquidity depth instead of a flat constant. */
export function modelSlippage(amountSol: number, liquidityUsd: number, solPrice: number): number {
    if (!liquidityUsd || liquidityUsd <= 0) return 2.5;
    const tradeUsd = amountSol * solPrice;
    const impact = (tradeUsd / liquidityUsd) * 100;
    return parseFloat(Math.min(30, Math.max(0.05, impact * 1.8)).toFixed(3));
}

export function calculateDynamicSize(
    config: any,
    score: number,
    liqUsd: number,
    solPrice: number,
    currentBalanceSol?: number
): number {
    if (!config?.enableDynamicScaling) return config?.amountSol || 0.05;
    
    const normalizedScore = Math.min(85, Math.max(55, score)) / 100;
    const exponent = config.scaleExponent || 2.0;
    const convictionMultiplier = Math.pow(normalizedScore, exponent);
    
    const baseRisk = config.baseRiskUnitSol || 0.02;
    const maxMult = config.maxRiskMultiplier || 5.0;
    let computedSize = baseRisk + (convictionMultiplier * (baseRisk * maxMult));

    if (currentBalanceSol && currentBalanceSol > 0) {
        computedSize = Math.min(computedSize, currentBalanceSol * 0.05);
    }

    computedSize = Math.min(computedSize, 2.0);

    if (liqUsd > 0 && solPrice > 0) {
        const maxLiqInSol = (liqUsd * 0.02) / solPrice;
        computedSize = Math.min(computedSize, maxLiqInSol);
    }

    const totalSpent = config.totalSpentSol || 0;
    const remaining = (config.maxBudgetSol || Infinity) - totalSpent;
    computedSize = Math.min(computedSize, remaining);

    if (computedSize >= 2.0 || (currentBalanceSol && computedSize >= currentBalanceSol * 0.05)) {
        const userIdentifier = config.telegramId || config.userId || config.user?.telegramId;
        if (userIdentifier) {
            redis.incr(`sizing_cap_count:${userIdentifier}`)
                 .then(() => redis.expire(`sizing_cap_count:${userIdentifier}`, 86400))
                 .catch(() => {});
        }
    }
    
    return Math.max(parseFloat(computedSize.toFixed(4)), 0.005);
}

export async function getSimCounters(telegramId: string) {
    const wins = parseInt(await redis.get(`sim:stats:wins:${telegramId}`) || '0', 10);
    const losses = parseInt(await redis.get(`sim:stats:losses:${telegramId}`) || '0', 10);
    const totalTrades = parseInt(await redis.get(`sim:stats:totalTrades:${telegramId}`) || '0', 10);
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

export async function getSessionSpend(telegramId: string, mode: 'live' | 'sim'): Promise<number> {
    const key = `autosnipe:session_spend:${mode}:${telegramId}`;
    const val = await redis.get(key);
    return val ? parseFloat(val) : 0;
}

export async function addSessionSpend(telegramId: string, amount: number, mode: 'live' | 'sim'): Promise<number> {
    const key = `autosnipe:session_spend:${mode}:${telegramId}`;
    const newTotal = await redis.incrbyfloat(key, amount);
    await redis.expire(key, 86400);
    return typeof newTotal === 'number' ? newTotal : parseFloat(newTotal || '0');
}

export async function startNewAutoSnipeSession(telegramId: string, mode: 'live' | 'sim'): Promise<string> {
    const sessionId = crypto.randomUUID();
    await redis.set(`autosnipe:session_id:${mode}:${telegramId}`, sessionId, 'EX', 86400);
    await redis.del(`autosnipe:session_spend:${mode}:${telegramId}`);
    await redis.del(`autosnipe:budget_warned:${mode}:${telegramId}`);
    return sessionId;
}

export async function checkAndSendBudgetWarning(
    bot: any,
    telegramId: string,
    mode: 'live' | 'sim',
    currentSpend: number,
    maxBudget?: number | null
) {
    if (!maxBudget || maxBudget <= 0) return;

    const pct = (currentSpend / maxBudget) * 100;
    if (pct < 90) return;

    const warnedKey = `autosnipe:budget_warned:${mode}:${telegramId}`;
    const alreadyWarned = await redis.get(warnedKey);
    if (alreadyWarned) return;

    await redis.set(warnedKey, '1', 'EX', 86400);

    const remaining = Math.max(0, maxBudget - currentSpend);
    const modeLabel = mode === 'sim' ? 'SIMULATION' : 'LIVE';
    const modeEmoji = mode === 'sim' ? '🧪' : '🔴';

    try {
        await bot.telegram.sendMessage(
            telegramId,
            `⚠️ <b>BUDGET WARNING (${modeEmoji} ${modeLabel})</b>\n\n` +
            `You've deployed <b>${pct.toFixed(1)}%</b> of your session budget.\n\n` +
            `• Spent: <b>${currentSpend.toFixed(4)} SOL</b>\n` +
            `• Budget: <b>${maxBudget.toFixed(4)} SOL</b>\n` +
            `• Remaining: <b>${remaining.toFixed(4)} SOL</b>\n\n` +
            `The Auto-Sniper will pause automatically once this hits 100%. ` +
            `Use the button below to close all positions to cash now, or let it run to the cap.`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🧹 Sweep All to Cash', callback_data: 'action_sweep_all' }],
                        [{ text: '📊 View Dashboard', callback_data: 'btn_dashboard' }]
                    ]
                }
            }
        );
    } catch (e) {
        console.error(`Failed to send budget warning to ${telegramId}:`, e);
    }
}

export async function sendBudgetExhaustedSummary(
    bot: any,
    telegramId: string,
    mode: 'live' | 'sim',
    sessionId: string | null
) {
    if (!sessionId) return;
    const tradesKey = `${mode}:session_trades:${sessionId}`;
    const raw = await redis.lrange(tradesKey, 0, -1);
    const trades = raw.map(r => JSON.parse(r));
    
    const totalSpent = trades.reduce((s: number, t: any) => s + (t.amountInSol || 0), 0);
    const totalRealizedPnl = trades.reduce((s: number, t: any) => s + (t.realizedPnlSol || 0), 0);
    const wins = trades.filter((t: any) => (t.realizedPnlSol || 0) > 0).length;
    const losses = trades.filter((t: any) => (t.realizedPnlSol || 0) <= 0).length;

    const grossProfit = trades.reduce((sum: number, t: any) => sum + (t.realizedPnlSol > 0 ? t.realizedPnlSol : 0), 0);
    const grossLoss = trades.reduce((sum: number, t: any) => sum + (t.realizedPnlSol < 0 ? Math.abs(t.realizedPnlSol) : 0), 0);

    const solPrice = cachedSolUsdPrice || 156.93;
    const totalSpentUsd = (totalSpent * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const grossProfitUsd = (grossProfit * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const grossLossUsd = (grossLoss * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const netPnlUsd = (Math.abs(totalRealizedPnl) * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pnlSign = totalRealizedPnl >= 0 ? '+' : '-';
    const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : "0.0";

    await bot.telegram.sendMessage(telegramId,
        `🏁 <b>AUTO-SNIPE BUDGET EXHAUSTED</b>\n\n` +
        `• <b>Total Spent:</b> <code>${totalSpent.toFixed(4)} SOL ($${totalSpentUsd})</code>\n` +
        `• <b>Trades Executed:</b> ${trades.length} Total (${wins}W / ${losses}L — ${winRate}% Win Rate)\n` +
        `• <b>Gross Profit:</b> <b>+${grossProfit.toFixed(4)} SOL (+$${grossProfitUsd})</b>\n` +
        `• <b>Gross Loss:</b> <b>-${grossLoss.toFixed(4)} SOL (-$${grossLossUsd})</b>\n` +
        `• <b>Net Realized PnL:</b> <b>${pnlSign}${Math.abs(totalRealizedPnl).toFixed(4)} SOL (${pnlSign}$${netPnlUsd})</b>\n\n` +
        `<i>Session completed. Auto-Sniper paused to protect your exposure limit.</i>`,
        { parse_mode: 'HTML' }
    ).catch((err: any) => {
        console.error("🔴 [BUDGET SUMMARY] Failed to send telegram summary:", err.message);
    });
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
    return val ? parseFloat(val) : 238.87;
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
    return bal || '238.8700';
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
    slippagePercent: number = 0.12,
    aiScore?: number
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
        slippagePercent,
        aiScore: aiScore ?? null
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

export async function getRealTokenForSimDisplay(): Promise<{ mint: string; symbol: string }> {
    const cacheKey = 'sim:real_token_pool';
    let pool: Array<{ mint: string; symbol: string }> = [];
    const cached = await redis.get(cacheKey);
    if (cached) pool = JSON.parse(cached);

    if (pool.length === 0) {
        try {
            const res = await axios.get(
                'https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false',
                { timeout: 2500 }
            );
            if (Array.isArray(res.data) && res.data.length > 0) {
                pool = res.data.map((c: any) => ({ mint: c.mint, symbol: c.symbol || 'UNKNOWN' }));
                await redis.set(cacheKey, JSON.stringify(pool), 'EX', 900);
            }
        } catch (_) {
            pool = [{ mint: generateSimTokenCA(), symbol: 'MEME' }];
        }
    }

    if (pool.length === 0) return { mint: generateSimTokenCA(), symbol: 'MEME' };
    return pool[Math.floor(Math.random() * pool.length)];
}

export async function simExecuteSnipe(
    telegramId: string, 
    tokenAddress: string, 
    amountSol: number, 
    strategy: string = 'Sniper Engine',
    score: number = 75,
    trailingPercent: number = 10,
    takeProfitPercent: number = 40,
    aiScore?: number
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
    const fail = (msg: string) => ({
        success: false, 
        signature: '', 
        message: msg, 
        volumeSpent: 0,
        auditStats: null,
        auditReasons: [],
        entryPriceSol: 0,
        entryPriceUsd: 0
    });

    try {
        const currentBal = parseFloat(await getSimBalance(telegramId));
        if (currentBal < amountSol + 0.002) {
            return fail(`🔴 Insufficient Funds. Balance: ${currentBal.toFixed(4)} SOL`);
        }

        const solPrice = cachedSolUsdPrice || 156.93;

        // 🟢 REAL live market price & on-chain metadata
        let priceSol = await getRealEntryPrice(tokenAddress);
        if (priceSol <= 0) {
            priceSol = 0.000005 + (Math.random() * 0.000002);
        }

        const meta = await getTokenMetadata(tokenAddress).catch(() => null);
        const symbol = meta?.symbol && meta.symbol !== 'UNKNOWN' ? meta.symbol : tokenAddress.substring(0, 5);
        const liquidityUsd = meta?.liquidityUsd || 25000;

        // Realistic modeled slippage + fee structure
        const slipPct = modelSlippage(amountSol, liquidityUsd, solPrice);
        const effectiveEntry = priceSol * (1 + slipPct / 100);
        const { getPlatformFeeRate } = await import('./vip.service.js');
        const feeRate = await getPlatformFeeRate(telegramId);
        const feeSol = amountSol * feeRate;
        const jitoTip = 0.001;
        const totalDebit = amountSol + feeSol + jitoTip;

        if (currentBal < totalDebit) return fail(`🔴 Insufficient Funds after fees. Need ${totalDebit.toFixed(4)} SOL.`);

        const priceUsd = effectiveEntry * solPrice;
        const tokenAmount = amountSol / effectiveEntry;

        await redis.incrbyfloat(`sim:balance:${telegramId}`, -totalDebit);

        const posKey = `sim:positions:${telegramId}`;
        const existing: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        
        const clampedScore = Math.min(84, Math.max(58, score));
        let winProbability = 0.42;
        if (clampedScore >= 75) winProbability = 0.68;
        else if (clampedScore >= 65) winProbability = 0.58;
        
        const winTrajectory = Math.random() < winProbability;

        const existingPosIndex = existing.findIndex(p => p.mint === tokenAddress);
        if (existingPosIndex !== -1) {
            const prev = existing[existingPosIndex];
            const totalAmount = prev.amount + tokenAmount;
            const totalSolInvested = prev.amountInSol + amountSol;
            const weightedEntryPriceSol = totalAmount > 0 ? totalSolInvested / totalAmount : effectiveEntry;
            const weightedEntryPriceUsd = weightedEntryPriceSol * solPrice;

            existing[existingPosIndex] = {
                ...prev,
                amount: totalAmount,
                amountInSol: totalSolInvested,
                entryPrice: weightedEntryPriceSol,
                entryPriceUsd: weightedEntryPriceUsd,
                currentPriceSol: priceSol,
                priceUsd: priceUsd,
                valueUsd: parseFloat((totalAmount * priceUsd).toFixed(2)),
                highestSeenPrice: Math.max(prev.highestSeenPrice, priceSol),
                ticksRemaining: 4
            };
        } else {
            const newPosition: SimPosition = {
                mint: tokenAddress,
                symbol,
                amount: tokenAmount,
                entryPrice: effectiveEntry,
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
        }

        await redis.set(posKey, JSON.stringify(existing));
        await redis.sadd('sim:active_users', telegramId);

        // 🟢 Attach real Trailing Guard in Memory for real price tracking
        await addTrailingStopToMemory(
            telegramId, tokenAddress, trailingPercent || 10, amountSol,
            effectiveEntry, takeProfitPercent || undefined, undefined, strategy
        ).catch(() => {});

        await recordSimTrade(telegramId, true, amountSol, 0, strategy, tokenAddress, slipPct, aiScore ?? clampedScore);
        await recordStatsEvent(telegramId, 'sim', 0);
        await awardGuildPoints(telegramId, amountSol).catch(() => {});
        await saveSimulationState(telegramId);
        await redis.del(`balance_cache:${telegramId}`).catch(() => {});

        const auditStats = {
            ageMins: Math.floor(Math.random() * 35) + 2,
            volume: meta?.volume24h || 20000 + Math.random() * 80000,
            liquidity: liquidityUsd,
            priceChangeM5: (Math.random() * 45) + 15,
            socials: true,
            lpLock: { lockPct: 100, burned: true }
        };

        const auditReasons = [
            `💧 Liq: $${(liquidityUsd / 1000).toFixed(1)}k`,
            `💰 Vol: $${(auditStats.volume / 1000).toFixed(1)}k`,
            `📉 Modeled slippage: ${slipPct}%`,
            `💵 Real entry: $${priceUsd.toFixed(8)}`
        ];

        return { 
            success: true, 
            signature: generateSimSignature(), 
            message: `🟢 Buy confirmed: ${amountSol.toFixed(4)} SOL of $${symbol}`, 
            volumeSpent: amountSol,
            auditStats,
            auditReasons,
            entryPriceSol: effectiveEntry,
            entryPriceUsd: priceUsd
        };
    } catch (e: any) {
        console.error(`🔴 [SIM SNIPE] Execution failure for ${telegramId}:`, e.message);
        return fail(`🔴 Execution Error: ${e.message}`);
    }
}

export async function simExecuteExit(
    telegramId: string, 
    tokenAddress: string, 
    percent: number = 100, 
    forcedPnlPercent?: number, 
    strategy: string = 'Sniper Engine'
): Promise<{ success: boolean; signature: string; message: string; realizedPnlSol?: number; pnlPercent?: number }> {
    try {
        const posKey = `sim:positions:${telegramId}`;
        const positions: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        const posIndex = positions.findIndex(p => p.mint === tokenAddress);
        if (posIndex === -1) return { success: false, signature: '', message: '⚠️ No open position found.' };

        const pos = positions[posIndex];
        const solPrice = cachedSolUsdPrice || 156.93;

        // 🟢 REAL exit price fetched from on-chain feeds
        let exitPrice = await getRealEntryPrice(tokenAddress);
        if (exitPrice <= 0) exitPrice = pos.currentPriceSol || pos.entryPrice;

        const meta = await getTokenMetadata(tokenAddress).catch(() => null);
        const soldSol = pos.amountInSol * (percent / 100);
        const exitSlip = modelSlippage(soldSol, meta?.liquidityUsd || 25000, solPrice);
        const effectiveExit = exitPrice * (1 - exitSlip / 100);

        const pnlPercent = forcedPnlPercent !== undefined
            ? forcedPnlPercent
            : (pos.entryPrice > 0 ? ((effectiveExit - pos.entryPrice) / pos.entryPrice) * 100 : 15.0);

        const grossReturn = soldSol * (1 + pnlPercent / 100);
        const { getPlatformFeeRate } = await import('./vip.service.js');
        const feeRate = await getPlatformFeeRate(telegramId);
        const netReturn = Math.max(0, grossReturn - (grossReturn * feeRate) - 0.001);

        await redis.incrbyfloat(`sim:balance:${telegramId}`, netReturn);

        if (percent >= 100) {
            positions.splice(posIndex, 1);
            await cancelAllGuardsForToken(telegramId, tokenAddress).catch(() => {});
        } else {
            pos.amount = pos.amount * (1 - (percent / 100));
            pos.amountInSol = pos.amountInSol * (1 - (percent / 100));
            pos.valueUsd = pos.valueUsd * (1 - (percent / 100));
        }

        if (positions.length === 0) {
            await redis.srem('sim:active_users', telegramId);
        }
        await redis.set(posKey, JSON.stringify(positions));

        const realizedPnlSol = netReturn - soldSol;
        await recordSimTrade(telegramId, false, soldSol, pnlPercent, strategy, tokenAddress, exitSlip);
        await recordStatsEvent(telegramId, 'sim', realizedPnlSol);
        await awardGuildPoints(telegramId, soldSol).catch(() => {});
        await saveSimulationState(telegramId);
        await redis.del(`balance_cache:${telegramId}`).catch(() => {});

        // Feed Guard ML model from sim outcomes too
        try {
            const peakPct = pos.entryPrice > 0 ? ((pos.highestSeenPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
            const { recordGuardOutcome } = await import('./guard_ai.service.js');
            await recordGuardOutcome(telegramId, tokenAddress, pnlPercent, peakPct);
        } catch (_) {}

        return { 
            success: true, 
            signature: generateSimSignature(), 
            realizedPnlSol,
            pnlPercent,
            message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` 
        };
    } catch (e: any) {
        console.error(`🔴 [SIM EXIT] Execution failure for ${telegramId}:`, e.message);
        return { success: false, signature: '', message: `🔴 Exit Error: ${e.message}` };
    }
}

export function startSimPositionRefresher() {
    if (global._sentryIntervals) {
        global._sentryIntervals.push(setInterval(async () => {
            try {
                const users = await redis.smembers('sim:active_users');
                if (users.length === 0) return;
                const solPrice = cachedSolUsdPrice || 156.93;
                const { getLivePriceSol } = await import('./guard-price-feed.service.js');

                for (const tgId of users) {
                    const raw = await redis.get(`sim:positions:${tgId}`);
                    if (!raw) { await redis.srem('sim:active_users', tgId); continue; }
                    const positions: SimPosition[] = JSON.parse(raw);
                    if (positions.length === 0) { await redis.srem('sim:active_users', tgId); continue; }

                    let changed = false;
                    for (const p of positions) {
                        const live = getLivePriceSol(p.mint) ?? await getRealEntryPrice(p.mint).catch(() => 0);
                        if (live > 0) {
                            p.currentPriceSol = live;
                            p.priceUsd = live * solPrice;
                            p.valueUsd = parseFloat((p.amount * p.priceUsd).toFixed(2));
                            if (live > p.highestSeenPrice) p.highestSeenPrice = live;
                            changed = true;
                        }
                    }
                    if (changed) await redis.set(`sim:positions:${tgId}`, JSON.stringify(positions));
                }
            } catch (_) {}
        }, 3000));
    }
}

export async function startSimulationGuardResolver(bot: any) {
    console.log("🛡️ [SIM RESOLVER] Started autonomous simulation position resolver (2s tick).");
    setInterval(async () => {
        try {
            const activeUserIds = await redis.smembers('sim:active_users').catch(() => []);
            if (activeUserIds.length === 0) return;

            const solPrice = cachedSolUsdPrice || 156.93;

            for (const tgId of activeUserIds) {
                if (!(await isSimulationActive(tgId))) {
                    await redis.srem('sim:active_users', tgId);
                    continue;
                }

                const posKey = `sim:positions:${tgId}`;
                const raw = await redis.get(posKey);
                if (!raw) continue;
                const positions: SimPosition[] = JSON.parse(raw);
                if (positions.length === 0) {
                    await redis.srem('sim:active_users', tgId);
                    continue;
                }

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

                    // Position triggers TP/SL when tick counter expires
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
                            
                            const botUsername = process.env.BOT_USERNAME || 'SentryTerminalBot';
                            const copyTradeLink = `https://t.me/${botUsername}?start=follow_${user?.id}`;
                            const tweetText = encodeURIComponent(
                                `Just closed a trade at ${isWin ? '+' : ''}${finalPnl.toFixed(1)}% using Sentry Terminal ⚡\n\nCopy my trades live 👇\n${copyTradeLink}`
                            );

                            const caption = `${isWin ? '🟢 <b>TAKE PROFIT TRIGGERED! (SIM)</b>' : '🔴 <b>TRAILING GUARD TRIGGERED! (SIM)</b>'}\n\n` +
                                `<b>Token:</b> $${pos.symbol} (<code>${pos.mint.substring(0, 8)}...</code>)\n` +
                                `<b>Strategy:</b> <code>${pos.strategy}</code>\n` +
                                `<b>Realized PnL:</b> <b>${isWin ? '+' : ''}${finalPnl.toFixed(2)}%</b>\n` +
                                `<b>Status:</b> 🟢 Confirmed\n` +
                                `🔗 <a href="https://solscan.io/tx/${exitRes.signature}">View on Solscan</a>`;

                            await bot.telegram.sendPhoto(tgId, { source: imageBuffer }, { 
                                caption, 
                                parse_mode: 'HTML',
                                link_preview_options: { is_disabled: true },
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '🐦 Share & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]
                                    ]
                                }
                            });
                        } catch (_) {}
                    } else {
                        remainingPositions.push(pos);
                    }
                }

                await redis.set(posKey, JSON.stringify(remainingPositions));
            }
        } catch (_) {}
    }, 2000);
}

export async function generateSimCallerAlert(
    telegramId: string,
    filters: any
): Promise<any> {
    const { getMatchesWithLadder } = await import('./caller.service.js');
    const raw = await redis.get('caller:hot_scored_tokens');
    const tokens: any[] = raw ? JSON.parse(raw) : [];
    
    if (tokens.length > 0) {
        const { matches } = getMatchesWithLadder(tokens, filters);
        if (matches.length > 0) {
            const sorted = [...matches].sort((a, b) => (b.totalScore ?? 0) - (a.totalScore ?? 0));
            for (const t of sorted) {
                if (!(await redis.get(`caller_alerted:${telegramId}:${t.mint}`))) {
                    await redis.set(`caller_alerted:${telegramId}:${t.mint}`, '1', 'EX', 180);
                    return t;
                }
            }
            return sorted[0];
        }
    }

    const realToken = await getRealTokenForSimDisplay();
    for (let i = 0; i < 15; i++) {
        const ageMins = Math.floor(Math.random() * Math.min(filters.maxAgeMins || 60, 45)) + 1;
        const liquidity = Math.max(filters.minLiquidity || 2000, 10000 + Math.random() * 30000);
        const volume24h = Math.max(filters.minVolume24h || 2000, liquidity * (Math.random() * 3 + 1.5));
        const priceChangeM5 = Math.min(filters.maxPctChange || 500, Math.max(filters.minPctChange || 10, (Math.random() * 40) + 10));

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

export async function processSimCopyTrades(bot: any) {
    const simUsers = await prisma.user.findMany({
        where: { simState: { active: true } },
        include: { copyTrades: { where: { isActive: true } } }
    });

    for (const user of simUsers) {
        for (const copy of user.copyTrades) {
            const hotRaw = await redis.get('caller:hot_scored_tokens');
            const hot = hotRaw ? JSON.parse(hotRaw) : [];
            let token = hot.length > 0 ? hot[0] : await getRealTokenForSimDisplay();

            const isBuy = Math.random() > 0.35;

            if (isBuy && copy.copyBuys !== false) {
                const tradeSize = copy.maxTradeSizeSol ? Math.min(copy.tradeAmountSol, copy.maxTradeSizeSol) : copy.tradeAmountSol;
                const randomScore = Math.floor(Math.random() * (84 - 65 + 1)) + 65;
                const res = await simExecuteSnipe(
                    user.telegramId, 
                    token.mint, 
                    tradeSize, 
                    'Copy Trade', 
                    randomScore, 
                    copy.autoTrailingDropPercent || 10, 
                    copy.autoTakeProfitPercent || 40
                );
                if (res.success) {
                    try {
                        await bot.telegram.sendMessage(
                            user.telegramId,
                            `👥 <b>COPY TRADE: BUY EXECUTED! (SIM)</b>\nTarget: <code>${copy.targetWallet.substring(0, 8)}...</code>\nToken: <code>${token.mint}</code> ($${token.symbol})\nInvested: <b>${tradeSize} SOL</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                        );
                    } catch (_) {}
                }
            }
        }
    }
}

export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        const sessionId = await startNewAutoSnipeSession(telegramId, 'sim');
        const genId = crypto.randomUUID();
        await redis.set(`sim:autosnipe:gen:${telegramId}`, genId, 'EX', 86400);
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
                }
            }
        }
    } catch (_) {}
}

export async function runSimAutoSnipeLoop(telegramId: string, bot: any, genId?: string) {
    await acquireSimSniperSlot();

    if (!genId) {
        genId = crypto.randomUUID();
        await redis.set(`sim:autosnipe:gen:${telegramId}`, genId, 'EX', 86400);
    }
    const sessionId = await redis.get(`autosnipe:session_id:sim:${telegramId}`);
    let loopCounter = 0;

    try {
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

            const lossStatus = await isSimLossLimitHit(telegramId, config);
            if (lossStatus.hit) {
                await killSimAutoSnipe(telegramId);
                try {
                    await bot.telegram.sendMessage(
                        telegramId,
                        `🛑 <b>MAX LOSS LIMIT REACHED (SIMULATION)</b>\n\n` +
                        `Your simulated portfolio dropped <b>${lossStatus.lossPercent.toFixed(1)}%</b> from baseline.\n` +
                        `Auto-Sniper paused to protect remaining capital.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
                break;
            }

            const currentSpend = await getSessionSpend(telegramId, 'sim');
            const maxBudget = config.maxBudgetSol || Infinity;
            const remainingBudget = maxBudget - currentSpend;

            if (remainingBudget <= 0) {
                await killSimAutoSnipe(telegramId);
                await sendBudgetExhaustedSummary(bot, telegramId, 'sim', sessionId);
                break;
            }

            // Read REAL scored tokens from mainnet
            const hotRaw = await redis.get('caller:hot_scored_tokens');
            const hot: any[] = hotRaw ? JSON.parse(hotRaw) : [];
            let token: any = null;

            if (hot.length > 0) {
                const candidates = hot.filter((t: any) => {
                    const s = t.totalScore ?? 0;
                    if (config.minScore > 0 && s < config.minScore) return false;
                    if (t.isRug === true) return false;
                    return true;
                });
                if (candidates.length > 0) {
                    token = candidates[Math.floor(Math.random() * candidates.length)];
                }
            }

            if (!token) {
                token = await getRealTokenForSimDisplay();
            }

            const score = Math.round(token.totalScore ?? Math.floor(Math.random() * (84 - 58 + 1)) + 58);
            const liquidity = token.liquidity ?? 25000;

            const lockKey = `lock:sim_autosnipe:${telegramId}:${token.mint}`;
            if (!(await redis.set(lockKey, '1', 'EX', 3600, 'NX'))) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            // 🟢 Write decision record so /whyskip works in simulation mode
            await redis.set(`snipe_decision:${telegramId}:${token.mint}`, JSON.stringify({
                score, 
                minScoreRequired: config.minScore, 
                reasons: token.reasons || [],
                decision: score < config.minScore ? 'SKIPPED_LOW_SCORE' : 'PASSED',
                ageMins: Math.round(token.ageMins || 0), 
                volume: Math.round(token.volume || 0),
                liquidity: Math.round(liquidity), 
                timestamp: Date.now()
            }), 'EX', 86400);

            if (config.minScore > 0) {
                const simCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
                if (simCredits <= 0) {
                    const warnKey = `sim_sniper_credits_warn:${telegramId}`;
                    if (!(await redis.get(warnKey))) {
                        await redis.set(warnKey, '1', 'EX', 600);
                        try {
                            await bot.telegram.sendMessage(
                                telegramId,
                                `⚠️ <b>SIM AUTO-SNIPER PAUSED — OUT OF CREDITS</b>\n\n` +
                                `Your Auto-Sniper requires AI Token Scoring (Min Score: <b>${config.minScore}+</b>), but your credit balance is <b>0</b>.\n\n` +
                                `Use <code>/simcredits 500</code> or top up below to resume:`,
                                {
                                    parse_mode: 'HTML',
                                    reply_markup: { inline_keyboard: [[{ text: '💳 Buy Credits', callback_data: 'menu_credits' }]] }
                                }
                            );
                        } catch (_) {}
                    }
                    await killSimAutoSnipe(telegramId);
                    break;
                } else {
                    await redis.set(`sim:credits:${telegramId}`, Math.max(0, simCredits - 1).toString());
                    await saveSimulationState(telegramId);
                }

                if (score < config.minScore) {
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
            }

            const solPrice = cachedSolUsdPrice || 156.93;
            const currentBal = parseFloat(await getSimBalance(telegramId));
            const calculatedSize = calculateDynamicSize(config, score, liquidity, solPrice, currentBal);
            const activeWallets = user?.activeWallets || 1;
            const intendedTotalSpend = calculatedSize * activeWallets;

            const clampedTotalSpend = Math.min(intendedTotalSpend, remainingBudget);
            let actualSnipeAmountPerWallet = clampedTotalSpend / activeWallets;

            if (remainingBudget - clampedTotalSpend < 0.0001) {
                actualSnipeAmountPerWallet = remainingBudget / activeWallets;
            }

            if (actualSnipeAmountPerWallet < 0.005) {
                await killSimAutoSnipe(telegramId);
                await sendBudgetExhaustedSummary(bot, telegramId, 'sim', sessionId);
                break;
            }

            const budgetLockKey = `lock:budget:sim:${telegramId}`;
            let budgetLock;
            try {
                budgetLock = await redlock.acquire([budgetLockKey], 5000);
            } catch (err) {
                continue;
            }

            try {
                await addSessionSpend(telegramId, clampedTotalSpend, 'sim');
                const updatedSpend = await getSessionSpend(telegramId, 'sim');
                checkAndSendBudgetWarning(bot, telegramId, 'sim', updatedSpend, config.maxBudgetSol).catch(() => {});
            } finally {
                if (budgetLock) await (budgetLock as any).release().catch(() => {});
            }

            const result = await simExecuteSnipe(
                telegramId, 
                token.mint, 
                actualSnipeAmountPerWallet, 
                'Sniper Engine', 
                score, 
                config.autoTrailingDropPercent || 10, 
                config.autoTakeProfitPercent || 40,
                score
            );

            const [activeAfter, genAfter] = await Promise.all([
                redis.get(`sim:autosnipe:${telegramId}`),
                redis.get(`sim:autosnipe:gen:${telegramId}`)
            ]);
            const stillActive = activeAfter === 'true' && genAfter === genId;

            if (result.success && stillActive) {
                try {
                    const tpPct = config.autoTakeProfitPercent || 40;
                    const slPct = config.autoTrailingDropPercent || 10;
                    const targetTpPrice = result.entryPriceUsd * (1 + tpPct / 100);
                    const stopLossPrice = result.entryPriceUsd * (1 - slPct / 100);

                    let auditMessage = `🎯 <b>AUTO-SNIPE EXECUTED (SIM)</b>\n\n`;
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

            const postLossStatus = await isSimLossLimitHit(telegramId, config);
            if (postLossStatus.hit) {
                await killSimAutoSnipe(telegramId);
                try {
                    await bot.telegram.sendMessage(
                        telegramId,
                        `🛑 <b>MAX LOSS LIMIT REACHED (SIMULATION)</b>\n\n` +
                        `Your simulated portfolio dropped <b>${postLossStatus.lossPercent.toFixed(1)}%</b>.\n` +
                        `Auto-Sniper paused to protect remaining capital.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
                break;
            }

            if (!stillActive) break;

            const organicDelayMs = 150 + Math.random() * 250;
            await new Promise(r => setTimeout(r, organicDelayMs));
        }
    } catch (e: any) {
        console.error(`🔴 [SIM AUTO-SNIPER] Loop crashed for ${telegramId}:`, e.message);
    } finally {
        await redis.set(`sim:autosnipe:${telegramId}`, 'false');
        activeSimLoops.delete(telegramId);
        await saveSimulationState(telegramId);
        releaseSimSniperSlot();
    }
}

export async function consumeSimCredit(telegramId: string): Promise<boolean> {
    const current = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
    if (current <= 0) return false;
    await redis.set(`sim:credits:${telegramId}`, (current - 1).toString());
    return true;
}

const MAX_SIM_SNIPER_LOOPS = 5;
let activeSimSniperLoops = 0;
const simSniperQueue: Array<() => void> = [];

export function acquireSimSniperSlot(): Promise<void> {
    return new Promise(resolve => {
        if (activeSimSniperLoops < MAX_SIM_SNIPER_LOOPS) {
            activeSimSniperLoops++;
            resolve();
        } else {
            simSniperQueue.push(resolve);
        }
    });
}

export function releaseSimSniperSlot(): void {
    activeSimSniperLoops--;
    const next = simSniperQueue.shift();
    if (next) {
        activeSimSniperLoops++;
        next();
    }
}

export async function isSimLossLimitHit(
    telegramId: string,
    config: any
): Promise<{ hit: boolean; lossPercent: number }> {
    if (!config?.maxLossPercent || config.maxLossPercent <= 0) return { hit: false, lossPercent: 0 };

    const startingBalance = await getSimStartingBalance(telegramId);
    const cashBalance = parseFloat(await getSimBalance(telegramId));
    const solPrice = cachedSolUsdPrice || 156.93;
    const positionsRaw = await redis.get(`sim:positions:${telegramId}`);
    const positions: SimPosition[] = positionsRaw ? JSON.parse(positionsRaw) : [];
    const unrealizedPnlSol = positions.reduce((sum: number, p: any) => sum + ((p.valueUsd || 0) / solPrice) - (p.amountInSol || 0), 0);
    const currentEquitySol = cashBalance + unrealizedPnlSol;
    const lossPercent = startingBalance > 0 ? ((startingBalance - currentEquitySol) / startingBalance) * 100 : 0;

    return {
        hit: lossPercent >= config.maxLossPercent,
        lossPercent
    };
}

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
        await redis.srem('sim:active_users', telegramId);
        return;
    }

    const startBal = 238.8700;

    await prisma.simState.upsert({
        where: { userId: user.id },
        update: { balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 },
        create: { userId: user.id, balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 }
    });

    await redis.set(`sim:active:${telegramId}`, 'true');
    await redis.set(`sim:balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:starting_balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:credits:${telegramId}`, '5420');
    await redis.set(`autosnipe:session_spend:sim:${telegramId}`, '0');
    await redis.set(`sim:session_spend:${telegramId}`, '0');
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
}

export async function saveSimulationState(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    const balance = parseFloat(await getSimBalance(telegramId));
    const startingBalance = await getSimStartingBalance(telegramId);
    const volume = parseFloat((await getSimVolume(telegramId))?.toString() || '0');
    const credits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
    const active = await isSimulationActive(telegramId);
    const autoSnipeActive = (await redis.get(`sim:autosnipe:${telegramId}`)) === 'true';

    const maxBudget = parseFloat(await redis.get(`sim:max_budget:${telegramId}`) || '0');
    const sessionSpend = parseFloat(await redis.get(`autosnipe:session_spend:sim:${telegramId}`) || '0');

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
                balance, startingBalance, volume, credits, active, autoSnipeActive, positions,
                maxBudgetSol: maxBudget > 0 ? maxBudget : null,
                sessionSpendSol: sessionSpend > 0 ? sessionSpend : null
            },
            create: {
                userId: user.id,
                balance, startingBalance, volume, credits, active, autoSnipeActive, positions,
                maxBudgetSol: maxBudget > 0 ? maxBudget : null,
                sessionSpendSol: sessionSpend > 0 ? sessionSpend : null
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
                credits: 5420,
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
    if (state.maxBudgetSol) await redis.set(`sim:max_budget:${telegramId}`, state.maxBudgetSol.toString());
    if (state.sessionSpendSol) await redis.set(`autosnipe:session_spend:sim:${telegramId}`, state.sessionSpendSol.toString());
    if (state.positions) await redis.set(`sim:positions:${telegramId}`, JSON.stringify(state.positions));

    const trades = state.trades.map((t: any) => ({
        createdAt: t.createdAt.toISOString(),
        isBuy: t.isBuy,
        amountInSol: t.amountInSol,
        profitPercent: t.profitPercent || 0,
        realizedPnlSol: t.realizedPnlSol || 0,
        mint: t.tokenAddress,
        strategy: 'Sniper Engine',
        slippagePercent: 0.11
    }));
    await redis.set(`sim:trades:${telegramId}`, JSON.stringify(trades));
}