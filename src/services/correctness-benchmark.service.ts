// src/services/correctness-benchmark.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export interface FeeCorrectnessResult {
    sampleSize: number;
    expectedRate: number;
    mismatchCount: number;
    mismatches: { tradeId: string; expectedFee: number; actualFee: number; deltaPct: number }[];
    avgEffectiveRate: number;
}

/**
 * 🟢 Verifies that feeChargedSol matches amountInSol * platform rate on real trades
 */
export async function runFeeCorrectnessCheck(expectedRate: number = 0.01, sampleSize: number = 100): Promise<FeeCorrectnessResult> {
    const trades = await prisma.trade.findMany({
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
        take: sampleSize,
        select: { id: true, amountInSol: true, feeChargedSol: true }
    });

    const mismatches: FeeCorrectnessResult['mismatches'] = [];
    let totalEffectiveRate = 0;
    let validCount = 0;

    for (const t of trades) {
        if (t.amountInSol <= 0) continue;
        const expectedFee = t.amountInSol * expectedRate;
        const actualFee = t.feeChargedSol ?? 0;
        const deltaPct = expectedFee > 0 ? Math.abs((actualFee - expectedFee) / expectedFee) * 100 : 0;

        totalEffectiveRate += actualFee / t.amountInSol;
        validCount++;

        if (deltaPct > 5) {
            mismatches.push({ 
                tradeId: t.id, 
                expectedFee: parseFloat(expectedFee.toFixed(6)), 
                actualFee: parseFloat(actualFee.toFixed(6)), 
                deltaPct: parseFloat(deltaPct.toFixed(2)) 
            });
        }
    }

    return {
        sampleSize: trades.length,
        expectedRate,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 10),
        avgEffectiveRate: validCount > 0 ? parseFloat(((totalEffectiveRate / validCount) * 100).toFixed(4)) : 0
    };
}

export interface PositionCorrectnessResult {
    checkedUsers: number;
    divergentPositions: { telegramId: string; mint: string; webappEntry: number; telegramEntry: number }[];
}

// In src/services/correctness-benchmark.service.ts:
export async function runPositionCorrectnessCheck(sampleUserCount: number = 20): Promise<PositionCorrectnessResult> {
    const users = await prisma.user.findMany({ 
        select: { id: true, telegramId: true }, 
        take: sampleUserCount 
    });

    const divergent: PositionCorrectnessResult['divergentPositions'] = [];
    const { cachedSolUsdPrice } = await import('./grpc.service.js');
    const solRate = cachedSolUsdPrice || 156.93;

    for (const u of users) {
        const guardIds = await redis.smembers(`user_guards:${u.telegramId}`).catch(() => []);
        if (guardIds.length === 0) continue;

        const raws = await redis.mget(guardIds.map(id => `order:trail:${id}`));
        for (const guardRaw of raws) {
            if (!guardRaw) continue;
            let guard: any;
            try { guard = JSON.parse(guardRaw); } catch { continue; }

            const mint = guard.tokenAddress;
            if (!mint) continue;

            const lastBuy = await prisma.trade.findFirst({
                where: { userId: u.id, tokenAddress: mint, isBuy: true, status: 'CONFIRMED' },
                orderBy: { createdAt: 'desc' }
            }).catch(() => null);

            const webappEntryUsd = (lastBuy as any)?.executedPriceUsd ?? 0;
            // 🟢 NEW-6 FIX: Convert SOL-denominated guard price to USD before comparison
            const telegramEntryUsd = guard.entryPriceUsd ?? ((guard.entryPrice ?? 0) * solRate);

            if (webappEntryUsd > 0 && telegramEntryUsd > 0) {
                const deltaPct = Math.abs((webappEntryUsd - telegramEntryUsd) / webappEntryUsd) * 100;
                if (deltaPct > 1) {
                    divergent.push({ telegramId: u.telegramId, mint, webappEntry: webappEntryUsd, telegramEntry: telegramEntryUsd });
                }
            }
        }
    }

    return { checkedUsers: users.length, divergentPositions: divergent };
}