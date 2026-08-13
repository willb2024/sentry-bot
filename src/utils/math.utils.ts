export interface TradeRecord {
    isBuy: boolean;
    amountInSol: number;
    realizedPnlSol?: number | null;
    profitPercent?: number | null;
    slippagePercent?: number | null;
}

export interface ComputedStats {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalVolumeSol: number;
    totalPnLSol: number;
    netProfitPercent: number;
}

export function computeUniversalStats(trades: TradeRecord[]): ComputedStats {
    let wins = 0;
    let losses = 0;
    let totalVolumeSol = 0;
    let totalPnLSol = 0;
    let totalInvestedSol = 0;

    for (const t of trades) {
        totalVolumeSol += (t.amountInSol || 0);

        if (!t.isBuy) {
            const pnl = t.realizedPnlSol || 0;
            const invested = t.amountInSol || 0;
            
            totalPnLSol += pnl;
            totalInvestedSol += invested;

            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;
        }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const netProfitPercent = totalInvestedSol > 0 ? (totalPnLSol / totalInvestedSol) * 100 : 0;

    return {
        totalTrades,
        wins,
        losses,
        winRate: parseFloat(winRate.toFixed(1)),
        totalVolumeSol: parseFloat(totalVolumeSol.toFixed(4)),
        totalPnLSol: parseFloat(totalPnLSol.toFixed(4)),
        netProfitPercent: parseFloat(netProfitPercent.toFixed(2))
    };
}


// src/utils/math.utils.ts
export interface TradeRecord {
    isBuy: boolean;
    amountInSol: number;
    realizedPnlSol?: number | null;
    profitPercent?: number | null;
    slippagePercent?: number | null;
}

export interface ComputedStats {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalVolumeSol: number;
    totalPnLSol: number;
    netProfitPercent: number;
}

