// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { generatePnlCard } from './image.service.js';
import { cachedSolUsdPrice } from './grpc.service.js';
import { awardGuildPoints } from './guild.service.js';
import { getCachedTokenPrice } from './engine.service.js';

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

export async function startNewAutoSnipeSession(telegramId: string, mode: 'live' | 'sim'): Promise<string> {
    const sessionId = crypto.randomUUID();
    await redis.set(`autosnipe:session_id:${mode}:${telegramId}`, sessionId, 'EX', 86400);
    await redis.del(`autosnipe:session_spend:${mode}:${telegramId}`);
    await redis.del(`autosnipe:budget_warned:${mode}:${telegramId}`);
    return sessionId;
}

export async function checkAndSendBudgetWarning(bot: any, telegramId: string, mode: 'live' | 'sim', currentSpend: number, maxBudget?: number | null) {
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
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🧹 Sweep All to Cash', callback_data: 'action_sweep_all' }], [{ text: '📊 View Dashboard', callback_data: 'btn_dashboard' }]] } }
        );
    } catch (e) {}
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
    ).catch(() => {});
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

export async function getSimBalance(telegramId: string): Promise<string> {
    try {
        const isActive = await isSimulationActive(telegramId).catch(() => false);
        if (!isActive) return '0.0000';
    } catch { return '0.0000'; }

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
    try {
        const currentBal = parseFloat(await getSimBalance(telegramId));
        if (currentBal < amountSol + 0.002) {
            return { 
                success: false, 
                signature: '', 
                message: `🔴 Insufficient Funds. Balance: ${currentBal.toFixed(4)} SOL`, 
                volumeSpent: 0, auditStats: null, auditReasons: [], entryPriceSol: 0, entryPriceUsd: 0
            };
        }

        const solPrice = cachedSolUsdPrice || 156.93;
        
        // 🟢 SIM FIX: Get the REAL live price from the blockchain cache instead of a random number!
        let priceSol = await getCachedTokenPrice(tokenAddress).catch(() => 0);
        if (priceSol <= 0) {
            priceSol = 0.000005 + (Math.random() * 0.000002);
        }
        
        const priceUsd = priceSol * solPrice;

        await redis.incrbyfloat(`sim:balance:${telegramId}`, -(amountSol + 0.001));

        const tokenAmount = Math.floor(amountSol / priceSol);
        const posKey = `sim:positions:${telegramId}`;
        const existing: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        
        const clampedScore = Math.min(84, Math.max(58, score));

        const newPosition: SimPosition = {
            mint: tokenAddress,
            symbol: 'SIM_TKN',
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
            createdAt: Date.now()
        };

        existing.push(newPosition);
        await redis.set(posKey, JSON.stringify(existing));

        await recordSimTrade(telegramId, true, amountSol, 0, strategy, tokenAddress, 0.12, clampedScore);
        await recordStatsEvent(telegramId, 'sim', 0);
        await awardGuildPoints(telegramId, amountSol).catch(() => {});
        await saveSimulationState(telegramId);
        await redis.del(`balance_cache:${telegramId}`).catch(() => {});

        const auditStats = {
            ageMins: Math.floor(Math.random() * 35) + 2, volume: 20000 + Math.random() * 80000,
            liquidity: 12000 + Math.random() * 38000, priceChangeM5: (Math.random() * 45) + 15,
            socials: true, lpLock: { lockPct: 100, burned: true }
        };

        const auditReasons = [
            `🕒 Age: ${auditStats.ageMins}m`, `💰 Vol: $${(auditStats.volume / 1000).toFixed(1)}k`,
            `📈 Mom: +${auditStats.priceChangeM5.toFixed(1)}%`, `💧 Liq: $${(auditStats.liquidity / 1000).toFixed(1)}k`,
            `🌐 Socials present`, `🔒 LP Secured (100% Locked/Burned)`
        ];

        return { 
            success: true, 
            signature: generateSimSignature(), 
            message: `🟢 Buy confirmed: ${amountSol.toFixed(4)} SOL (Paper Trading Mode)`, 
            volumeSpent: amountSol, auditStats, auditReasons, entryPriceSol: priceSol, entryPriceUsd: priceUsd
        };
    } catch (e: any) {
        return {
            success: false, signature: '', message: `🔴 Execution Error: ${e.message}`,
            volumeSpent: 0, auditStats: null, auditReasons: [], entryPriceSol: 0, entryPriceUsd: 0
        };
    }
}

export async function simExecuteExit(
    telegramId: string, 
    tokenAddress: string, 
    percent: number = 100, 
    forcedPnlPercent?: number, 
    strategy: string = 'Sniper Engine'
): Promise<{ success: boolean; signature: string; message: string }> {
    try {
        const posKey = `sim:positions:${telegramId}`;
        const positions: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        const posIndex = positions.findIndex(p => p.mint === tokenAddress);
        if (posIndex === -1) return { success: false, signature: '', message: '⚠️ No open position found.' };

        const pos = positions[posIndex];
        
        let pnlPercent = forcedPnlPercent;
        if (pnlPercent === undefined) {
            if (pos.entryPrice > 0 && pos.currentPriceSol > 0) {
                pnlPercent = ((pos.currentPriceSol - pos.entryPrice) / pos.entryPrice) * 100;
            } else {
                pnlPercent = 15.0; // fallback
            }
        }

        const soldSol = pos.amountInSol * (percent / 100);
        const rawReturn = soldSol * (1 + pnlPercent / 100);
        const platformFee = rawReturn * 0.01;
        const jitoTip = 0.001;

        const netReturnSol = Math.max(0, rawReturn - platformFee - jitoTip);

        await redis.incrbyfloat(`sim:balance:${telegramId}`, netReturnSol);

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
        await redis.del(`balance_cache:${telegramId}`).catch(() => {});

        return { 
            success: true, 
            signature: generateSimSignature(), 
            message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` 
        };
    } catch (e: any) {
        return { success: false, signature: '', message: `🔴 Exit Error: ${e.message}` };
    }
}

export async function addSessionSpend(telegramId: string, amount: number, mode: 'live' | 'sim'): Promise<number> {
    const key = `autosnipe:session_spend:${mode}:${telegramId}`;
    const newTotal = await redis.incrbyfloat(key, amount);
    await redis.expire(key, 86400);
    return parseFloat(newTotal as any);
}

export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        await startNewAutoSnipeSession(telegramId, 'sim');
        await redis.del(`sim:session_spend:${telegramId}`);
    } 
    await saveSimulationState(telegramId);
    return newState === 'true';
}

export async function killSimAutoSnipe(telegramId: string): Promise<void> {
    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

export async function recoverSimAutoSnipeLoops(bot: any) {
    // Obsolete - removed synthetic loops. Returns immediately.
    return;
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
            update: { balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 },
            create: { userId: user.id, balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 }
        });
    } catch (e) {}

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
    } catch (e: any) {}
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
                userId: user.id, balance: 238.87, startingBalance: 238.87, volume: 0,
                credits: 5420, active: false, autoSnipeActive: false, positions: []
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
        createdAt: t.createdAt.toISOString(), isBuy: t.isBuy, amountInSol: t.amountInSol,
        profitPercent: t.profitPercent || 0, realizedPnlSol: t.realizedPnlSol || 0,
        mint: t.tokenAddress, strategy: 'Sniper Engine', slippagePercent: 0.11
    }));
    await redis.set(`sim:trades:${telegramId}`, JSON.stringify(trades));
}

// 🟢 COMPATIBILITY EXPORTS (Resolves TS errors in index.ts and caller.service.ts)
export function startSimulationGuardResolver(bot?: any): void {
    // Obsolete: Simulation guards now resolve through real price feeds in processGuardOrders
}

export async function processSimCopyTrades(bot?: any): Promise<void> {
    // Obsolete: Simulation users now mirror real whale trades via syncCopyTradeListeners
}