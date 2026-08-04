// src/services/analytics.service.ts
import { prisma } from '../lib/prisma.js';

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
    
    // 🟢 BACKWARD COMPATIBILITY FIELDS
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

export async function getAdvancedStats(telegramId: string): Promise<AdvancedStats | null> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return null;

    const trades = await prisma.trade.findMany({
        where: { userId: user.id, status: 'CONFIRMED' },
        orderBy: { createdAt: 'asc' }
    });

    const emptyStats = { 
        sharpeRatio: 0, consistencyScore: 0, maxDrawdown: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, 
        averageWin: 0, averageLoss: 0, profitFactor: 0, totalPnlSol: 0, totalPnl: 0, totalVolume: 0, winRate: 0, wins: 0, losses: 0 
    };
    if (trades.length === 0) return emptyStats;

    const totalVolume = trades.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);
    const sells = trades.filter(t => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined);
    
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
        totalPnl, totalVolume, winRate, wins: winningTrades, losses: losingTrades
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
    const emptyStats = { 
        sharpeRatio: 0, consistencyScore: 0, maxDrawdown: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, 
        averageWin: 0, averageLoss: 0, profitFactor: 0, totalPnlSol: 0, totalPnl: 0, totalVolume: 0, winRate: 0, wins: 0, losses: 0 
    };
    if (!trades || trades.length === 0) return emptyStats;

    const totalVolume = trades.reduce((sum, t) => sum + (Number(t.amountInSol) || 0), 0);
    const sells = trades.filter(t => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined);
    
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
    if (dailyReturns.length >= 2) {
        const dailyMean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
        const dailyStd = Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - dailyMean) ** 2, 0) / dailyReturns.length);
        if (dailyStd > 0) sharpeRatio = (dailyMean / dailyStd) * Math.sqrt(365);
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
        totalPnl, totalVolume, winRate, wins: winningTrades, losses: losingTrades
    };
}

export async function getCombinedAdvancedStats(telegramId: string) {
    const trades = await getCombinedTrades(telegramId);
    return computeCombinedStats(trades);
}

export async function getCombinedHourlyPerformance(telegramId: string) {
    const trades = await getCombinedTrades(telegramId);
    const hourlyMap: Map<number, { count: number; wins: number; pnl: number }> = new Map();
    for (let h = 0; h < 24; h++) hourlyMap.set(h, { count: 0, wins: 0, pnl: 0 });

    for (const t of trades) {
        if (t.isBuy) continue;
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

    return { profitFactor, maxDrawdown: Math.abs(maxDrawdown), sharpeRatio };
}