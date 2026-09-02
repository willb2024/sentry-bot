// src/services/points.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export interface UserPointsBreakdown {
    totalPoints: number;
    selfPoints: number;
    recruitPoints: number;
    copierPoints: number;
    currentTier: 'Bronze' | 'Silver' | 'Gold';
    currentRate: number;
    nextTier: string;
    nextTierPoints: number;
}

export const TIER_CONFIG = {
    BRONZE: { name: 'Bronze' as const, rate: 0.50, minPoints: 0, nextTier: 'Silver', nextPoints: 5_000_000 },
    SILVER: { name: 'Silver' as const, rate: 0.60, minPoints: 5_000_000, nextTier: 'Gold', nextPoints: 25_000_000 },
    GOLD:   { name: 'Gold' as const,   rate: 0.70, minPoints: 25_000_000, nextTier: 'Max Rank', nextPoints: 25_000_000 }
};

export async function refreshPointsCache(userId: string): Promise<UserPointsBreakdown> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            _count: { select: { recruits: true } },
            followedBy: {
                where: { isActive: true },
                include: {
                    follower: {
                        include: {
                            trades: {
                                where: { strategy: 'Copy Trade', status: 'CONFIRMED' },
                                select: { amountInSol: true }
                            }
                        }
                    }
                }
            }
        }
    });

    if (!user) {
        return {
            totalPoints: 0,
            selfPoints: 0,
            recruitPoints: 0,
            copierPoints: 0,
            currentTier: 'Bronze',
            currentRate: 0.50,
            nextTier: 'Silver',
            nextTierPoints: 5_000_000 // 🟢 Fixed: nextTierPoints
        };
    }

    const selfPoints = Math.floor((user.totalVolumeSol || 0) * 10_000);
    const recruitPoints = (user._count?.recruits || 0) * 2_000;

    let totalCopierVolSol = 0;
    user.followedBy.forEach((f) => {
        (f.follower.trades || []).forEach((t) => {
            totalCopierVolSol += (t.amountInSol || 0);
        });
    });

    const copierPoints = Math.floor((user.followedBy.length * 5_000) + (totalCopierVolSol * 5_000));
    const totalPoints = selfPoints + recruitPoints + copierPoints;

    let currentTier: 'Bronze' | 'Silver' | 'Gold' = 'Bronze';
    let currentRate: number = TIER_CONFIG.BRONZE.rate;
    let nextTier: string = TIER_CONFIG.BRONZE.nextTier;
    let nextTierPoints: number = TIER_CONFIG.BRONZE.nextPoints;

    if (totalPoints >= TIER_CONFIG.GOLD.minPoints) {
        currentTier = 'Gold';
        currentRate = TIER_CONFIG.GOLD.rate;
        nextTier = TIER_CONFIG.GOLD.nextTier;
        nextTierPoints = TIER_CONFIG.GOLD.nextPoints;
    } else if (totalPoints >= TIER_CONFIG.SILVER.minPoints) {
        currentTier = 'Silver';
        currentRate = TIER_CONFIG.SILVER.rate;
        nextTier = TIER_CONFIG.SILVER.nextTier;
        nextTierPoints = TIER_CONFIG.SILVER.nextPoints;
    }

    const result: UserPointsBreakdown = {
        totalPoints,
        selfPoints,
        recruitPoints,
        copierPoints,
        currentTier,
        currentRate,
        nextTier,
        nextTierPoints
    };

    if (user.telegramId) {
        await redis.zadd('global_points_lb', totalPoints, user.telegramId);
    }
    await redis.set(`user_points_breakdown:${userId}`, JSON.stringify(result), 'EX', 300);

    return result;
}

export async function getUserTotalPoints(userId: string): Promise<UserPointsBreakdown> {
    const cached = await redis.get(`user_points_breakdown:${userId}`);
    if (cached) {
        return JSON.parse(cached);
    }
    return await refreshPointsCache(userId);
}

export async function getDynamicAffiliateRate(referrerId: string): Promise<number> {
    try {
        const breakdown = await getUserTotalPoints(referrerId);
        return breakdown.currentRate;
    } catch {
        return 0.50;
    }
}

export async function invalidateUserPointsCache(userId: string): Promise<void> {
    try {
        await redis.del(`user_points_breakdown:${userId}`);
    } catch (_) {}
}