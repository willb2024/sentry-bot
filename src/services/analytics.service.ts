// src/services/analytics.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export interface AdvancedStats {
    sharpeRatio: number;
    consistencyScore: number;
    maxDrawdown: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
    totalPnlSol: number;
    totalInvestedSol: number; 
    
    // BACKWARD COMPATIBILITY
    totalPnl: number;
    totalVolume: number;
    winRate: number;
    wins: number;
    losses: number;
}

export interface HourlyStats {
    hour: number;        
    tradeCount: number;
    winCount: number;
    lossCount: number;
    totalPnlSol: number;
    winRate: number;
    averagePnl: number;
}

const emptyStats: AdvancedStats = { 
    sharpeRatio: 0, consistencyScore: 0, maxDrawdown: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, 
    averageWin: 0, averageLoss: 0, profitFactor: 0, totalPnlSol: 0, totalInvestedSol: 0, totalPnl: 0, totalVolume: 0, winRate: 0, wins: 0, losses: 0 
};

// 🟢 BUG 4 FIX: Uses Prisma Aggregations instead of pulling all rows into memory
export async function getAdvancedStats(telegramId: string): Promise<AdvancedStats> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return emptyStats;

    const sells = await prisma.trade.findMany({
        where: { userId: user.id, isBuy: false, realizedPnlSol: { not: null } },
        select: { realizedPnlSol: true, amountInSol: true, createdAt: true },
        orderBy: { createdAt: 'asc' }
    });

    if (sells.length === 0) return emptyStats;

    const totalTradesCount = await prisma.trade.count({ where: { userId: user.id, status: 'CONFIRMED' } });
    
    const totalVolumeAgg = await prisma.trade.aggregate({
        where: { userId: user.id, status: 'CONFIRMED' },
        _sum: { amountInSol: true }
    });
    
    const totalVolume = totalVolumeAgg._sum.amountInSol || 0;
    const totalInvestedSol = sells.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);
    const totalPnl = sells.reduce((sum, t) => sum + (Number(t.realizedPnlSol) || 0), 0);

    const winsArray = sells.filter(t => (t.realizedPnlSol || 0) > 0).map(t => t.realizedPnlSol!);
    const lossesArray = sells.filter(t => (t.realizedPnlSol || 0) < 0).map(t => t.realizedPnlSol!);

    const winningTrades = winsArray.length;
    const losingTrades = lossesArray.length;
    const averageWin = winningTrades > 0 ? winsArray.reduce((a, b) => a + b, 0) / winningTrades : 0;
    const averageLoss = losingTrades > 0 ? Math.abs(lossesArray.reduce((a, b) => a + b, 0)) / losingTrades : 0;
    const profitFactor = averageLoss > 0 ? averageWin / averageLoss : (winningTrades > 0 ? 999 : 0);

    const mean = totalPnl / sells.length;
    const stdDev = Math.sqrt(sells.reduce((sum, t) => sum + ((t.realizedPnlSol || 0) - mean) ** 2, 0) / sells.length);
    const consistencyScore = stdDev > 0 ? mean / stdDev : 0;

    const dailyPnlMap = new Map<string, number>();
    sells.forEach(t => {
        const day = t.createdAt.toISOString().split('T')[0];
        dailyPnlMap.set(day, (dailyPnlMap.get(day) || 0) + (Number(t.realizedPnlSol) || 0));
    });
    const dailyReturns = Array.from(dailyPnlMap.values());

    let sharpeRatio = 0;
    if (dailyReturns.length >= 2) {
        const dailyMean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const dailyStd = Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - dailyMean) ** 2, 0) / dailyReturns.length);
        const RISK_FREE_DAILY = 0; 
        if (dailyStd > 0) {
            const dailySharpe = (dailyMean - RISK_FREE_DAILY) / dailyStd;
            sharpeRatio = dailySharpe * Math.sqrt(365);
        }
    }

    let peak = 0, drawdown = 0, maxDrawdown = 0, runningSum = 0;
    for (const t of sells) {
        runningSum += (t.realizedPnlSol || 0);
        if (runningSum > peak) peak = runningSum;
        drawdown = peak - runningSum;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const winRate = (winningTrades + losingTrades) > 0 ? (winningTrades / (winningTrades + losingTrades)) * 100 : 0;

    return {
        sharpeRatio, consistencyScore, maxDrawdown, totalTrades: totalTradesCount, winningTrades, losingTrades,
        averageWin, averageLoss, profitFactor: isFinite(profitFactor) ? profitFactor : 0, totalPnlSol: totalPnl,
        totalInvestedSol, totalPnl, totalVolume, winRate, wins: winningTrades, losses: losingTrades
    };
}

export async function getHourlyPerformance(telegramId: string): Promise<HourlyStats[]> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return [];

    const trades = await prisma.trade.findMany({
        where: { userId: user.id, status: 'CONFIRMED', isBuy: false },
        select: { createdAt: true, realizedPnlSol: true }
    });

    const hourlyMap: Map<number, { count: number; wins: number; pnl: number }> = new Map();
    for (let h = 0; h < 24; h++) hourlyMap.set(h, { count: 0, wins: 0, pnl: 0 });

    for (const t of trades) {
        const hour = new Date(t.createdAt).getUTCHours();
        const entry = hourlyMap.get(hour)!;
        entry.count += 1;
        const pnl = t.realizedPnlSol || 0;
        entry.pnl += pnl;
        if (pnl > 0) entry.wins += 1;
    }

    const result: HourlyStats[] = [];
    for (let h = 0; h < 24; h++) {
        const data = hourlyMap.get(h)!;
        result.push({
            hour: h, tradeCount: data.count, winCount: data.wins, lossCount: data.count - data.wins,
            totalPnlSol: data.pnl, winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
            averagePnl: data.count > 0 ? data.pnl / data.count : 0
        });
    }
    return result;
}

export async function exportTradesToCsv(telegramId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return null;

    const trades = await prisma.trade.findMany({
        where: { userId: user.id, status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' }
    });

    if (trades.length === 0) return null;

    let csv = 'Date,Token,Type,Amount SOL,Fee SOL,Affiliate Cut,Profit %,PnL SOL,Strategy,Tx Signature\n';
    for (const t of trades) {
        const type = t.isBuy ? 'BUY' : 'SELL';
        const row = [
            t.createdAt.toISOString(), t.tokenAddress, type, t.amountInSol.toFixed(6),
            (t.feeChargedSol || 0).toFixed(6), (t.affiliateCutSol || 0).toFixed(6),
            (t.profitPercent || 0).toFixed(2), (t.realizedPnlSol || 0).toFixed(6),
            t.strategy || 'MANUAL', t.txSignature || ''
        ];
        csv += row.join(',') + '\n';
    }
    return csv;
}

export async function getCombinedTrades(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return [];

    const trades = await prisma.trade.findMany({ where: { userId: user.id, status: 'CONFIRMED' } });
    const simTrades = await prisma.simTrade.findMany({ where: { userId: user.id } });
    
    const combined = [...trades, ...simTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return combined;
}

export function computeCombinedStats(trades: any[]): AdvancedStats {
    if (!trades || trades.length === 0) return emptyStats;

    const totalVolume = trades.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);
    const sells = trades.filter(t => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined);
    
    const totalInvestedSol = sells.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);

    if (sells.length === 0) return { ...emptyStats, totalTrades: trades.length, totalVolume };

    const pnlArray = sells.map(t => Number(t.realizedPnlSol) || 0);
    const totalPnl = pnlArray.reduce((a, b) => a + b, 0);
    const winsArray = pnlArray.filter(p => p > 0);
    const lossesArray = pnlArray.filter(p => p < 0);

    const winningTrades = winsArray.length;
    const losingTrades = lossesArray.length;
    const averageWin = winningTrades > 0 ? winsArray.reduce((a, b) => a + b, 0) / winningTrades : 0;
    const averageLoss = losingTrades > 0 ? Math.abs(lossesArray.reduce((a, b) => a + b, 0)) / losingTrades : 0;
    const profitFactor = averageLoss > 0 ? averageWin / averageLoss : (winningTrades > 0 ? 999 : 0);

    const mean = totalPnl / sells.length;
    const stdDev = Math.sqrt(pnlArray.reduce((sum, p) => sum + (p - mean) ** 2, 0) / sells.length);
    const consistencyScore = stdDev > 0 ? mean / stdDev : 0;

    const dailyPnlMap = new Map<string, number>();
    sells.forEach(t => {
        const day = new Date(t.createdAt).toISOString().split('T')[0];
        dailyPnlMap.set(day, (dailyPnlMap.get(day) || 0) + (Number(t.realizedPnlSol) || 0));
    });
    const dailyReturns = Array.from(dailyPnlMap.values());

    let sharpeRatio = 0;
    // 🟢 FIX: Added conditional boundaries to completely mitigate Division by Zero and NaN
    if (dailyReturns.length >= 2) {
        const dailyMean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const dailyStd = Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - dailyMean) ** 2, 0) / dailyReturns.length);
        if (dailyStd > 0) {
            sharpeRatio = (dailyMean / dailyStd) * Math.sqrt(365);
        }
    }

    let peak = 0, drawdown = 0, maxDrawdown = 0, runningSum = 0;
    for (const p of pnlArray) {
        runningSum += p;
        if (runningSum > peak) peak = runningSum;
        drawdown = peak - runningSum;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const winRate = (winningTrades + losingTrades) > 0 ? (winningTrades / (winningTrades + losingTrades)) * 100 : 0;

    return {
        sharpeRatio, consistencyScore, maxDrawdown, totalTrades: trades.length, winningTrades, losingTrades,
        averageWin, averageLoss, profitFactor: isFinite(profitFactor) ? profitFactor : 0, totalPnlSol: totalPnl,
        totalInvestedSol, totalPnl, totalVolume, winRate, wins: winningTrades, losses: losingTrades
    };
}

export function computeSimTradeStats(trades: any[]) {
    const sells = trades.filter(t => !t.isBuy);
    const wins = sells.filter(t => (t.realizedPnlSol || 0) > 0);
    const losses = sells.filter(t => (t.realizedPnlSol || 0) <= 0);
    const grossWin = wins.reduce((s, t) => s + (t.realizedPnlSol || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.realizedPnlSol || 0), 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

    let equity = 0, peak = 0, maxDrawdown = 0;
    const sorted = [...sells].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const t of sorted) {
        equity += (t.realizedPnlSol || 0);
        peak = Math.max(peak, equity);
        maxDrawdown = Math.min(maxDrawdown, equity - peak);
    }

    const dailyPnlMap = new Map<string, number>();
    sells.forEach(t => {
        const day = new Date(t.createdAt).toISOString().split('T')[0];
        dailyPnlMap.set(day, (dailyPnlMap.get(day) || 0) + (t.realizedPnlSol || 0));
    });
    const dailyReturns = Array.from(dailyPnlMap.values());
    let sharpeRatio = 0;
    if (dailyReturns.length >= 2) {
        const dailyMean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const dailyStd = Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - dailyMean) ** 2, 0) / dailyReturns.length);
        if (dailyStd > 0) sharpeRatio = (dailyMean / dailyStd) * Math.sqrt(365);
    }

    const totalInvestedSol = sells.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);

    return { profitFactor, maxDrawdown: Math.abs(maxDrawdown), sharpeRatio, totalInvestedSol };
}

export async function getCombinedAdvancedStats(telegramId: string): Promise<AdvancedStats> {
    const trades = await getCombinedTrades(telegramId);
    return computeCombinedStats(trades);
}

export async function getCombinedHourlyPerformance(telegramId: string) {
    const { isSimulationActive } = await import('./simulation.service.js');
    const isSim = await isSimulationActive(telegramId);
    
    let trades: any[] = [];

    if (isSim) {
        // 🟢 FIX: Reads the actual live simulation trades array directly
        const simTradesRaw = await redis.get(`sim:trades:${telegramId}`);
        trades = simTradesRaw ? JSON.parse(simTradesRaw) : [];
    } else {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return [];
        trades = await prisma.trade.findMany({ where: { userId: user.id } });
    }

    // Aggregate strictly by the last 24 hours (UTC) from live trades
    const hourlyMap: Map<number, { count: number; wins: number; pnl: number }> = new Map();
    for (let h = 0; h < 24; h++) hourlyMap.set(h, { count: 0, wins: 0, pnl: 0 });

    for (const t of trades) {
        if (t.isBuy) continue; // Only sells generate PnL
        const hour = new Date(t.createdAt).getUTCHours();
        const entry = hourlyMap.get(hour)!;
        entry.count += 1;
        const pnl = t.realizedPnlSol || 0;
        entry.pnl += pnl;
        if (pnl > 0) entry.wins += 1;
    }

    const result = [];
    for (let h = 0; h < 24; h++) {
        const data = hourlyMap.get(h)!;
        result.push({
            hour: h, tradeCount: data.count, winCount: data.wins, lossCount: data.count - data.wins,
            totalPnlSol: data.pnl, winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
            averagePnl: data.count > 0 ? data.pnl / data.count : 0
        });
    }
    return result;
}


export interface CVaRMetric {
    cvarSol: number;
    cvarPercent: number;
    tailTradeCount: number;
    worstSingleLossSol: number;
    riskAssessment: 'SAFE_TAIL' | 'MODERATE_TAIL' | 'CRITICAL_TAIL_RISK';
}

export function computeCVaR(
    trades: Array<{ realizedPnlSol?: number | null; amountInSol: number; isBuy: boolean }>,
    percentile: number = 0.05
): CVaRMetric {
    const defaultResult: CVaRMetric = { cvarSol: 0, cvarPercent: 0, tailTradeCount: 0, worstSingleLossSol: 0, riskAssessment: 'SAFE_TAIL' };

    const losingSells = trades.filter(t => !t.isBuy && (t.realizedPnlSol || 0) < 0);
    if (losingSells.length === 0) return defaultResult;

    const sortedLosses = losingSells.sort((a, b) => (a.realizedPnlSol || 0) - (b.realizedPnlSol || 0));
    const tailCount = Math.max(1, Math.floor(sortedLosses.length * percentile));
    const tailTrades = sortedLosses.slice(0, tailCount);

    const totalTailLossSol = tailTrades.reduce((sum, t) => sum + Math.abs(t.realizedPnlSol || 0), 0);
    const totalTailInvestedSol = tailTrades.reduce((sum, t) => sum + (t.amountInSol || 0), 0);

    const cvarSol = totalTailLossSol / tailCount;
    const cvarPercent = totalTailInvestedSol > 0 ? (totalTailLossSol / totalTailInvestedSol) * 100 : 0;
    const worstSingleLossSol = Math.abs(sortedLosses[0]?.realizedPnlSol || 0);

    let riskAssessment: 'SAFE_TAIL' | 'MODERATE_TAIL' | 'CRITICAL_TAIL_RISK' = 'SAFE_TAIL';
    if (cvarPercent >= 65.0 || cvarSol >= 3.0) riskAssessment = 'CRITICAL_TAIL_RISK';
    else if (cvarPercent >= 35.0 || cvarSol >= 1.0) riskAssessment = 'MODERATE_TAIL';

    return {
        cvarSol: parseFloat(cvarSol.toFixed(4)),
        cvarPercent: parseFloat(cvarPercent.toFixed(1)),
        tailTradeCount: tailCount,
        worstSingleLossSol: parseFloat(worstSingleLossSol.toFixed(4)),
        riskAssessment
    };
}