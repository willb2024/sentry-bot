// src/utils/math.utils.ts

// 🟢 NEW-4 FIX: Complete DDE injection + newline + comma sanitization
export function sanitizeCsvField(value: string | null | undefined): string {
    if (value === null || value === undefined) return '';
    let str = String(value).replace(/[\r\n]+/g, ' ').trim();
    if (/^[=+\-@\t|%]/.test(str)) {
        str = `'${str}`;
    }
    if (/[",]/.test(str)) {
        str = `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export interface TradeRecord {
    isBuy: boolean;
    amountInSol: number;
    realizedPnlSol?: number | null;
    profitPercent?: number | null;
    slippagePercent?: number | null;
    strategy?: string;
    createdAt?: string | Date;
}

export interface ComputedStats {
    totalTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalVolumeSol: number;
    totalPnLSol: number;
    totalInvestedSol: number;
    netProfitPercent: number;
}

export function computeUniversalStats(trades: TradeRecord[]): ComputedStats {
    let wins = 0, losses = 0, breakeven = 0;
    let totalVolumeSol = 0, totalPnLSol = 0, totalInvestedSol = 0;
    let executionCount = 0;

    for (const t of trades) {
        executionCount++;
        totalVolumeSol += (t.amountInSol || 0);

        if (!t.isBuy) {
            const pnl = t.realizedPnlSol ?? null;
            if (pnl === null) continue;
            totalPnLSol += pnl;
            totalInvestedSol += (t.amountInSol || 0);
            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;
            else breakeven++;
        }
    }

    const closedTrades = wins + losses + breakeven;
    const decided = wins + losses;
    const winRate = decided > 0 ? (wins / decided) * 100 : 0;
    const netProfitPercent = totalInvestedSol > 0 ? (totalPnLSol / totalInvestedSol) * 100 : 0;

    return {
        totalTrades: executionCount,
        closedTrades,
        wins,
        losses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalVolumeSol: parseFloat(totalVolumeSol.toFixed(4)),
        totalPnLSol: parseFloat(totalPnLSol.toFixed(4)),
        totalInvestedSol: parseFloat(totalInvestedSol.toFixed(4)),
        netProfitPercent: parseFloat(netProfitPercent.toFixed(2))
    };
}

// 🟢 NEW-3 FIX: Defensive Number.isFinite to prevent Infinity / NaN returns
export function computeSharpeRatio(trades: TradeRecord[]): number {
    const returns = trades
        .filter(t => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined && t.amountInSol > 0)
        .map(t => (t.realizedPnlSol || 0) / t.amountInSol)
        .filter(r => Number.isFinite(r));

    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);

    if (sd === 0 || !Number.isFinite(sd)) return 0;
    return parseFloat(((mean / sd) * Math.sqrt(252)).toFixed(2));
}

export function computeRiskScore(input: {
    unguardedRatio: number;
    concentration: number;
    budgetUtil: number;
    drawdownRatio: number;
}): number {
    const score = (input.unguardedRatio * 40)
                + (input.concentration * 25)
                + (input.budgetUtil * 20)
                + (Math.min(1, input.drawdownRatio) * 15);
                
    return Math.round(Math.min(100, Math.max(0, score)));
}