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
    winTrajectory?: boolean;  // 🟢 FIX: Added missing type
    ticksRemaining?: number;  // 🟢 FIX: Added missing type
}

const activeSimLoops = new Set<string>();

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
    saveSimulationState(telegramId); // 🟢 Background execution, no await
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

// 🟢 COMPLETELY SYNTHETIC EXECUTE SNIPE (No RPC Dependency, Super Fast)
export async function simExecuteSnipe(
    telegramId: string, tokenAddress: string, amountSol: number, strategy: string = 'Sniper Engine',
    score: number = 75, trailingPercent: number = 10, takeProfitPercent: number = 40
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

        const priceSol = 0.000005 + (Math.random() * 0.000002);
        const priceUsd = priceSol * 160;

        await redis.incrbyfloat(`sim:balance:${telegramId}`, -(amountSol + 0.001));
        const posKey = `sim:positions:${telegramId}`;
        const existing: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        
        const clampedScore = Math.min(84, Math.max(58, score));
        const winTrajectory = Math.random() < (clampedScore >= 75 ? 0.68 : 0.42);

        existing.push({
            mint: tokenAddress, symbol: 'SIM_TKN', amount: Math.floor(amountSol / priceSol),
            entryPrice: priceSol, entryPriceUsd: priceUsd, priceUsd: priceUsd, valueUsd: amountSol * 160,
            amountInSol: amountSol, highestSeenPrice: priceSol, currentPriceSol: priceSol,
            trailingPercent: trailingPercent || 10, takeProfitPercent: takeProfitPercent || 40,
            strategy, score: clampedScore, winTrajectory, ticksRemaining: 4, createdAt: Date.now()
        });

        await redis.set(posKey, JSON.stringify(existing));
        await recordSimTrade(telegramId, true, amountSol, 0, strategy, tokenAddress, 0.12, clampedScore);
        
        saveSimulationState(telegramId); // 🟢 FIX: Background process, no await

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

// 🟢 COMPLETELY SYNTHETIC EXECUTE EXIT
export async function simExecuteExit(
    telegramId: string, tokenAddress: string, percent: number = 100, forcedPnlPercent?: number, strategy: string = 'Sniper Engine'
): Promise<{ success: boolean; signature: string; message: string }> {
    try {
        const posKey = `sim:positions:${telegramId}`;
        const positions: SimPosition[] = JSON.parse(await redis.get(posKey) || '[]');
        const posIndex = positions.findIndex(p => p.mint === tokenAddress);
        if (posIndex === -1) return { success: false, signature: '', message: '⚠️ No open position found.' };

        const pos = positions[posIndex];
        let pnlPercent = forcedPnlPercent ?? (((pos.currentPriceSol - pos.entryPrice) / pos.entryPrice) * 100);
        
        const soldSol = pos.amountInSol * (percent / 100);
        const netReturnSol = soldSol * (1 + pnlPercent / 100);
        await redis.incrbyfloat(`sim:balance:${telegramId}`, netReturnSol);

        if (percent >= 100) positions.splice(posIndex, 1);
        else {
            pos.amount *= (1 - (percent / 100));
            pos.amountInSol *= (1 - (percent / 100));
            pos.valueUsd *= (1 - (percent / 100));
        }
        
        await redis.set(posKey, JSON.stringify(positions));
        await recordSimTrade(telegramId, false, soldSol, pnlPercent, strategy, tokenAddress, 0.12);
        
        saveSimulationState(telegramId); // 🟢 FIX: Background process, no await

        return { success: true, signature: generateSimSignature(), message: `🟢 Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` };
    } catch (e: any) { return { success: false, signature: '', message: `🔴 Exit Error: ${e.message}` }; }
}

export async function addSessionSpend(telegramId: string, amount: number, mode: 'live' | 'sim'): Promise<number> {
    const key = `autosnipe:session_spend:${mode}:${telegramId}`;
    const newTotal = await redis.incrbyfloat(key, amount);
    await redis.expire(key, 86400);
    return parseFloat(newTotal as any);
}

// 🟢 FAST SYNTHETIC AUTO-SNIPER LOOP
export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        const genId = crypto.randomUUID();
        await redis.set(`sim:autosnipe:gen:${telegramId}`, genId, 'EX', 86400);
        if (!activeSimLoops.has(telegramId)) {
            activeSimLoops.add(telegramId);
            runSimAutoSnipeLoop(telegramId, bot, genId).finally(() => activeSimLoops.delete(telegramId));
        }
    } else {
        activeSimLoops.delete(telegramId);
    }
    
    saveSimulationState(telegramId); // 🟢 FIX: Background process, no await
    return newState === 'true';
}

export async function killSimAutoSnipe(telegramId: string): Promise<void> {
    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

export async function runSimAutoSnipeLoop(telegramId: string, bot: any, genId: string) {
    while (true) {
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true' || await redis.get(`sim:autosnipe:gen:${telegramId}`) !== genId || !(await isSimulationActive(telegramId))) break;
        
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        if (!config) break;

        const score = Math.floor(Math.random() * (85 - 58 + 1)) + 58;
        if (score >= config.minScore) {
            const result = await simExecuteSnipe(telegramId, generateSimTokenCA(), config.amountSol, 'Sniper Engine', score, config.autoTrailingDropPercent || 10, config.autoTakeProfitPercent || 40);
            if (result.success) {
                try {
                    await bot.telegram.sendMessage(telegramId, `🎯 <b>AUTO-SNIPE (SIM)</b>\nScore: ${score}\nInvested: ${config.amountSol} SOL\n🔗 <a href="https://solscan.io/tx/${result.signature}">Receipt</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                } catch (_) {}
            }
        }
        await new Promise(r => setTimeout(r, 4000));
    }
    activeSimLoops.delete(telegramId);
}

// 🟢 SYNTHETIC CALLER ALERTS
export async function generateSimCallerAlert(telegramId: string, filters: any) {
    const simScore = Math.floor(Math.random() * (84 - 58 + 1)) + 58;
    if (simScore >= (filters.minScore || 55)) {
        return { mint: generateSimTokenCA(), symbol: "SIM_TKN", totalScore: simScore, ageMins: 5, priceChangeM5: 25, liquidity: 15000, volume: 45000, isReshow: false };
    }
    return null;
}

// 🟢 SYNTHETIC COPY TRADES
export async function processSimCopyTrades(bot: any) {
    const users = await prisma.user.findMany({ where: { simState: { active: true } }, include: { copyTrades: { where: { isActive: true } } } });
    for (const user of users) {
        for (const copy of user.copyTrades) {
            if (Math.random() < 0.05 && copy.copyBuys !== false) {
                const res = await simExecuteSnipe(user.telegramId, generateSimTokenCA(), copy.tradeAmountSol, 'Copy Trade', 75, copy.autoTrailingDropPercent || 10, copy.autoTakeProfitPercent || 40);
                if (res.success) {
                    try { await bot.telegram.sendMessage(user.telegramId, `👥 <b>COPY TRADE (SIM)</b>\nInvested: ${copy.tradeAmountSol} SOL\n🔗 Receipt: ${res.signature}`, { parse_mode: 'HTML' }); } catch (_) {}
                }
            }
        }
    }
}

// 🟢 SYNTHETIC GUARD RESOLVER
export function startSimulationGuardResolver(bot: any) {
    setInterval(async () => {
        try {
            const simKeys = await redis.keys('sim:positions:*');
            for (const key of simKeys) {
                const tgId = key.replace('sim:positions:', '');
                if (!(await isSimulationActive(tgId))) continue;
                let positions: SimPosition[] = JSON.parse(await redis.get(key) || '[]');
                const remaining = [];
                for (const pos of positions) {
                    pos.ticksRemaining = (pos.ticksRemaining || 4) - 1;
                    const targetPnl = pos.winTrajectory ? (pos.takeProfitPercent || 40) : -(pos.trailingPercent || 10);
                    if (pos.ticksRemaining <= 0) {
                        const exitRes = await simExecuteExit(tgId, pos.mint, 100, targetPnl, pos.strategy);
                        try { await bot.telegram.sendMessage(tgId, `${targetPnl > 0 ? '🟢 TP' : '🔴 SL'} TRIGGERED (SIM)\nPnL: ${targetPnl}%\n🔗 ${exitRes.signature}`); } catch (_) {}
                    } else remaining.push(pos);
                }
                await redis.set(key, JSON.stringify(remaining));
            }
        } catch (_) {}
    }, 4000);
}

export async function isSimLossLimitHit(
    telegramId: string,
    config: any
): Promise<{ hit: boolean; lossPercent: number }> {
    if (!config?.maxLossPercent || config.maxLossPercent <= 0) return { hit: false, lossPercent: 0 };

    const startingBalance = await getSimStartingBalance(telegramId);
    const cashBalance = parseFloat(await getSimBalance(telegramId));
    const solPrice = 160; 
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
        // 🟢 FIX: Run deletion in the background so turning off Sim Mode is instant (0ms wait)
        (async () => {
            await prisma.simState.update({ where: { userId: user.id }, data: { active: false } }).catch(()=>{});
            await prisma.simTrade.deleteMany({ where: { userId: user.id } }).catch(()=>{});
        })();
        killSimAutoSnipe(telegramId);
        await redis.set(`sim:active:${telegramId}`, 'false');
        return;
    }

    const startBal = 238.8700;
    
    // 🟢 FIX: Run creation in the background so turning on Sim Mode is instant
    (async () => {
        try {
            await prisma.simState.upsert({
                where: { userId: user.id },
                update: { balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 },
                create: { userId: user.id, balance: startBal, startingBalance: startBal, active: true, maxBudgetSol: 350, sessionSpendSol: 0 }
            });
        } catch (e) {}
    })();

    await redis.set(`sim:active:${telegramId}`, 'true');
    await redis.set(`sim:balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:starting_balance:${telegramId}`, startBal.toFixed(4));
    await redis.set(`sim:credits:${telegramId}`, '5420');
    await redis.set(`autosnipe:session_spend:sim:${telegramId}`, '0'); 
    await redis.set(`sim:session_spend:${telegramId}`, '0');
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
}

// 🟢 PERFORMANCE FIX: Fire-and-Forget Database Persistence.
// This function used to freeze the bot for 5 seconds by awaiting massive database inserts.
// Now, it returns immediately and executes the DB sync silently in the background.
export async function saveSimulationState(telegramId: string) {
    (async () => {
        try {
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

            // ⚠️ This is the operation that caused the lag. Now isolated in the background.
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

            await prisma.simTrade.deleteMany({ where: { userId: user.id } });

            for (let i = 0; i < mappedTrades.length; i += BATCH_SIZE) {
                const chunk = mappedTrades.slice(i, i + BATCH_SIZE);
                await prisma.simTrade.createMany({
                    data: chunk,
                    skipDuplicates: true,
                });
            }
        } catch (e: any) {}
    })();
}

export async function loadSimulationState(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { simState: true } });
    if (user?.simState) {
        await redis.set(`sim:active:${telegramId}`, user.simState.active ? 'true' : 'false');
        await redis.set(`sim:balance:${telegramId}`, user.simState.balance.toString());
    }
}

export async function recoverSimAutoSnipeLoops(bot: any) { return; }