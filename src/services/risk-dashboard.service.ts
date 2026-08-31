// src/services/risk-dashboard.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { getUserPositions } from './position.service.js';
import { cachedSolUsdPrice } from './grpc.service.js';

export interface StrategyBreakdown {
    strategy: string;
    tradeCount: number;
    totalVolumeSol: number;
    totalRealizedPnlSol: number;
    winRate: number;
    avgPnlPercent: number;
}

export interface PortfolioRiskSummary {
    totalPositions: number;
    totalCapitalAtRiskSol: number;
    totalCapitalAtRiskUsd: number;
    largestPositionPct: number;
    concentrationWarning: boolean;
    estimatedDrawdown20Pct: number;
    estimatedDrawdown50Pct: number;
    guardedPositions: number;
    unguardedPositions: number;
    unguardedCapitalSol: number;
}

/**
 * 🟢 Normalizes strategy labels into single unified buckets (prevents MANUAL vs Manual / Direct split)
 */
export async function getStrategyComparison(telegramId: string): Promise<StrategyBreakdown[]> {
    const cacheKey = `strategy_comparison:${telegramId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!user) return [];

    const trades = await prisma.trade.findMany({
        where: { userId: user.id, status: 'CONFIRMED', isBuy: false },
        select: { strategy: true, amountInSol: true, realizedPnlSol: true, profitPercent: true }
    });

    const grouped = new Map<string, { count: number; volume: number; pnl: number; wins: number; pctSum: number }>();

    for (const t of trades) {
        let key = t.strategy || 'Manual / Direct';
        if (key === 'MANUAL' || key === 'manual') key = 'Manual / Direct';
        if (key === 'SNIPER') key = 'Sniper Engine';
        if (key === 'COPY_TRADE') key = 'Copy Trade';
        if (key === 'DCA') key = 'DCA Engine';
        if (key === 'LIMIT') key = 'Limit Order';

        if (!grouped.has(key)) grouped.set(key, { count: 0, volume: 0, pnl: 0, wins: 0, pctSum: 0 });
        const g = grouped.get(key)!;
        g.count++;
        g.volume += t.amountInSol;
        g.pnl += t.realizedPnlSol || 0;
        g.pctSum += t.profitPercent || 0;
        if ((t.realizedPnlSol || 0) > 0) g.wins++;
    }

    const result: StrategyBreakdown[] = Array.from(grouped.entries()).map(([strategy, g]) => ({
        strategy,
        tradeCount: g.count,
        totalVolumeSol: parseFloat(g.volume.toFixed(4)),
        totalRealizedPnlSol: parseFloat(g.pnl.toFixed(4)),
        winRate: g.count > 0 ? parseFloat(((g.wins / g.count) * 100).toFixed(1)) : 0,
        avgPnlPercent: g.count > 0 ? parseFloat((g.pctSum / g.count).toFixed(2)) : 0
    })).sort((a, b) => b.totalRealizedPnlSol - a.totalRealizedPnlSol);

    await redis.set(cacheKey, JSON.stringify(result), 'EX', 60);
    return result;
}

/**
 * 🟢 Read-only aggregation over open positions with SOL/USD conversions and drawdown stress-tests
 */
export async function getPortfolioRiskSummary(telegramId: string): Promise<PortfolioRiskSummary> {
    const cacheKey = `risk_summary:${telegramId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const positions = (await getUserPositions(telegramId)) || [];

    if (positions.length === 0) {
        const empty: PortfolioRiskSummary = {
            totalPositions: 0, totalCapitalAtRiskSol: 0, totalCapitalAtRiskUsd: 0,
            largestPositionPct: 0, concentrationWarning: false,
            estimatedDrawdown20Pct: 0, estimatedDrawdown50Pct: 0,
            guardedPositions: 0, unguardedPositions: 0, unguardedCapitalSol: 0
        };
        await redis.set(cacheKey, JSON.stringify(empty), 'EX', 30);
        return empty;
    }

    const solPrice = cachedSolUsdPrice || 156.93;
    const totalCapitalAtRiskUsd = positions.reduce((sum: number, p: any) => sum + (p.valueUsd || 0), 0);
    const totalCapitalAtRiskSol = solPrice > 0 ? totalCapitalAtRiskUsd / solPrice : 0;

    const largestPosition = positions.reduce((max: any, p: any) => ((p.valueUsd || 0) > (max?.valueUsd || 0) ? p : max), null);
    const largestPositionPct = totalCapitalAtRiskUsd > 0 ? (((largestPosition?.valueUsd || 0) / totalCapitalAtRiskUsd) * 100) : 0;

    const guardKeys = await redis.keys(`order:trail:${telegramId}:*`).catch(() => []);
    const guardedMints = new Set(guardKeys.map(k => k.split(':').pop()));
    const guardedPositions = positions.filter((p: any) => guardedMints.has(p.mint)).length;
    const unguardedPositions = positions.length - guardedPositions;
    const unguardedCapitalUsd = positions
        .filter((p: any) => !guardedMints.has(p.mint))
        .reduce((sum: number, p: any) => sum + (p.valueUsd || 0), 0);
    const unguardedCapitalSol = solPrice > 0 ? unguardedCapitalUsd / solPrice : 0;

    const summary: PortfolioRiskSummary = {
        totalPositions: positions.length,
        totalCapitalAtRiskSol: parseFloat(totalCapitalAtRiskSol.toFixed(4)),
        totalCapitalAtRiskUsd: parseFloat(totalCapitalAtRiskUsd.toFixed(2)),
        largestPositionPct: parseFloat(largestPositionPct.toFixed(1)),
        concentrationWarning: largestPositionPct > 40,
        estimatedDrawdown20Pct: parseFloat((totalCapitalAtRiskSol * 0.2).toFixed(4)),
        estimatedDrawdown50Pct: parseFloat((totalCapitalAtRiskSol * 0.5).toFixed(4)),
        guardedPositions,
        unguardedPositions,
        unguardedCapitalSol: parseFloat(unguardedCapitalSol.toFixed(4))
    };

    await redis.set(cacheKey, JSON.stringify(summary), 'EX', 30);
    return summary;
}

export function buildRiskSummaryMessage(s: PortfolioRiskSummary): string {
    if (s.totalPositions === 0) {
        return `📊 <b>PORTFOLIO RISK SUMMARY</b>\n\nNo open positions.`;
    }

    const concentrationLine = s.concentrationWarning
        ? `\n⚠️ <b>Concentration Risk:</b> Your largest position represents <b>${s.largestPositionPct}%</b> of your total exposure.`
        : '';
    const unguardedLine = s.unguardedPositions > 0
        ? `\n🛡️ <b>${s.unguardedPositions} position(s)</b> have NO trailing guard (<code>${s.unguardedCapitalSol} SOL</code> unprotected).`
        : `\n✅ All positions are protected by trailing guards.`;

    return (
        `📊 <b>PORTFOLIO RISK SUMMARY</b>\n\n` +
        `• Open Positions: <code>${s.totalPositions}</code>\n` +
        `• Total Capital At Risk: <code>${s.totalCapitalAtRiskSol} SOL</code> (~$${s.totalCapitalAtRiskUsd})\n` +
        `• If market drops 20%: <code>-${s.estimatedDrawdown20Pct} SOL</code>\n` +
        `• If market drops 50%: <code>-${s.estimatedDrawdown50Pct} SOL</code>` +
        concentrationLine + unguardedLine + `\n\n` +
        `<i>Estimates assume correlated market drawdown. Actual drawdown depends on token liquidity depth.</i>`
    );
}

export function buildStrategyComparisonMessage(breakdown: StrategyBreakdown[]): string {
    if (breakdown.length === 0) {
        return `📊 <b>STRATEGY PERFORMANCE</b>\n\nNo completed trades yet.`;
    }

    const rows = breakdown.map(s => {
        const pnlEmoji = s.totalRealizedPnlSol >= 0 ? '🟢' : '🔴';
        const sign = s.totalRealizedPnlSol >= 0 ? '+' : '';
        return `${pnlEmoji} <b>${s.strategy}</b>\n├ Trades: ${s.tradeCount} | Win Rate: <b>${s.winRate}%</b>\n└ Net PnL: <b>${sign}${s.totalRealizedPnlSol} SOL</b> (avg ${s.avgPnlPercent >= 0 ? '+' : ''}${s.avgPnlPercent}%)`;
    }).join('\n\n');

    const best = breakdown[0];
    return (
        `📊 <b>STRATEGY ATTRIBUTION REPORT</b>\n\n${rows}\n\n` +
        `🏆 <b>Best Performing Engine:</b> <b>${best.strategy}</b>`
    );
}