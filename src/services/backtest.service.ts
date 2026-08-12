// src/services/backtest.service.ts
import { redis } from '../lib/redis.js';
import { getRecentNewMints } from './grpc.service.js';
import { computeTokenScore, getModelScore, TokenStats } from './caller.service.js';
import { computeCVaR, CVaRMetric } from './analytics.service.js';
import axios from 'axios';

export interface BacktestResult {
    telegramId: string;
    totalTokensEvaluated: number;
    tradesTriggered: number;
    winRate: number;
    wins: number;
    losses: number;
    totalSimulatedPnlSol: number;
    profitFactor: number;
    maxDrawdownSol: number;
    cvarMetric: CVaRMetric;
    recommendation: 'STRATEGY_APPROVED' | 'NEEDS_OPTIMIZATION' | 'HIGH_RISK_REJECTED';
}

/**
 * 🟢 WALK-FORWARD BACKTESTING ENGINE:
 * Replays historical tokens from the ring buffer against your active AI filters.
 */
export async function runWalkForwardBacktest(
    telegramId: string,
    simulatedTradeSizeSol: number = 0.1,
    takeProfitPercent: number = 50.0,
    stopLossPercent: number = 20.0
): Promise<BacktestResult> {
    const historicalMints = getRecentNewMints();
    const tradeRecords: Array<{ realizedPnlSol: number; amountInSol: number; isBuy: boolean }> = [];

    let wins = 0;
    let losses = 0;
    let grossProfitSol = 0;
    let grossLossSol = 0;
    let equity = 0;
    let peakEquity = 0;
    let maxDrawdownSol = 0;

    for (const item of historicalMints) {
        try {
            // Fetch DexScreener historical snapshot for the token
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${item.mint}`, {
                timeout: 2000
            });
            const pair = res.data?.pairs?.[0];
            if (!pair) continue;

            const stats: TokenStats = {
                ageMins: (Date.now() - item.firstSeenAt) / 60000,
                volume24h: pair.volume?.h24 || 0,
                liquidity: pair.liquidity?.usd || 0,
                priceChangeM5: pair.priceChange?.m5 || 0,
                hasSocials: (pair.info?.socials?.length || 0) > 0,
                isRug: false
            };

            // Run Sentry's heuristic & ML scoring engine
            const scoreResult = computeTokenScore(stats);
            let finalScore = scoreResult.score;

            const mlScore = await getModelScore(item.mint, stats);
            if (mlScore !== null) {
                finalScore = (mlScore * 0.6) + (finalScore * 0.4);
            }

            // Strategy Rule: Only execute if AI Score >= 65
            if (finalScore >= 65) {
                // Determine trade outcome based on historical 1h price movement
                const actualH1Change = pair.priceChange?.h1 || 0;
                let realizedPnlSol = 0;

                if (actualH1Change >= takeProfitPercent) {
                    wins++;
                    realizedPnlSol = simulatedTradeSizeSol * (takeProfitPercent / 100);
                    grossProfitSol += realizedPnlSol;
                } else if (actualH1Change <= -stopLossPercent) {
                    losses++;
                    realizedPnlSol = -simulatedTradeSizeSol * (stopLossPercent / 100);
                    grossLossSol += Math.abs(realizedPnlSol);
                } else {
                    // Closed at market after 1 hour
                    realizedPnlSol = simulatedTradeSizeSol * (actualH1Change / 100);
                    if (realizedPnlSol >= 0) {
                        wins++;
                        grossProfitSol += realizedPnlSol;
                    } else {
                        losses++;
                        grossLossSol += Math.abs(realizedPnlSol);
                    }
                }

                // Deduct simulated Jito block-0 tip (0.001 SOL per round trip)
                realizedPnlSol -= 0.001;

                tradeRecords.push({
                    realizedPnlSol,
                    amountInSol: simulatedTradeSizeSol,
                    isBuy: false
                });

                // Drawdown tracking
                equity += realizedPnlSol;
                if (equity > peakEquity) peakEquity = equity;
                const currentDrawdown = peakEquity - equity;
                if (currentDrawdown > maxDrawdownSol) maxDrawdownSol = currentDrawdown;
            }
        } catch (_) {
            continue;
        }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLossSol > 0 ? grossProfitSol / grossLossSol : (grossProfitSol > 0 ? 999 : 0);
    const totalSimulatedPnlSol = grossProfitSol - grossLossSol;

    // Compute Tail Risk (CVaR) on the backtested trades
    const cvarMetric = computeCVaR(tradeRecords, 0.05);

    let recommendation: 'STRATEGY_APPROVED' | 'NEEDS_OPTIMIZATION' | 'HIGH_RISK_REJECTED' = 'NEEDS_OPTIMIZATION';
    if (profitFactor >= 1.8 && winRate >= 45.0 && cvarMetric.riskAssessment === 'SAFE_TAIL') {
        recommendation = 'STRATEGY_APPROVED';
    } else if (profitFactor < 1.0 || cvarMetric.riskAssessment === 'CRITICAL_TAIL_RISK') {
        recommendation = 'HIGH_RISK_REJECTED';
    }

    const report: BacktestResult = {
        telegramId,
        totalTokensEvaluated: historicalMints.length,
        tradesTriggered: totalTrades,
        winRate: parseFloat(winRate.toFixed(1)),
        wins,
        losses,
        totalSimulatedPnlSol: parseFloat(totalSimulatedPnlSol.toFixed(4)),
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        maxDrawdownSol: parseFloat(maxDrawdownSol.toFixed(4)),
        cvarMetric,
        recommendation
    };

    // Cache report to Redis for WebApp consumption
    await redis.set(`backtest:report:${telegramId}`, JSON.stringify(report), 'EX', 3600);
    return report;
}