// src/services/analytics.service.ts
import { prisma } from '../lib/prisma.js';

export interface AdvancedStats {
    sharpeRatio: number;
    maxDrawdown: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    averageWin: number;
    averageLoss: number;
    profitFactor: number;
    totalPnlSol: number;
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

    const emptyStats = { sharpeRatio: 0, maxDrawdown: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, averageWin: 0, averageLoss: 0, profitFactor: 0, totalPnlSol: 0 };
    if (trades.length === 0) return emptyStats;

    const sells = trades.filter(t => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined);
    if (sells.length === 0) return { ...emptyStats, totalTrades: trades.length };

    const pnlArray = sells.map(t => t.realizedPnlSol as number);
    const totalPnl = pnlArray.reduce((a, b) => a + b, 0);
    const wins = pnlArray.filter(p => p > 0);
    const losses = pnlArray.filter(p => p < 0);

    const winningTrades = wins.length;
    const losingTrades = losses.length;
    const averageWin = winningTrades > 0 ? wins.reduce((a, b) => a + b, 0) / winningTrades : 0;
    const averageLoss = losingTrades > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0)) / losingTrades : 0;
    const profitFactor = averageLoss > 0 ? averageWin / averageLoss : (winningTrades > 0 ? 999 : 0);

    const mean = totalPnl / sells.length;
    const stdDev = Math.sqrt(pnlArray.reduce((sum, p) => sum + (p - mean) ** 2, 0) / sells.length);
    const sharpeRatio = stdDev > 0 ? mean / stdDev : 0;

    let peak = 0;
    let drawdown = 0;
    let maxDrawdown = 0;
    let runningSum = 0;
    for (const p of pnlArray) {
        runningSum += p;
        if (runningSum > peak) peak = runningSum;
        drawdown = peak - runningSum;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return {
        sharpeRatio, maxDrawdown, totalTrades: trades.length, winningTrades, losingTrades,
        averageWin, averageLoss, profitFactor: isFinite(profitFactor) ? profitFactor : 0, totalPnlSol: totalPnl
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