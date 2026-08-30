// src/services/credits.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export const CREDIT_PACKS = {
    starter: { name: 'Micro',   priceSol: null, priceUsd: 12,  credits: 150 },
    growth:  { name: 'Starter', priceSol: null, priceUsd: 29,  credits: 500 },
    pro:     { name: 'Pro',     priceSol: null, priceUsd: 59,  credits: 1500 },
    whale:   { name: 'Whale',   priceSol: null, priceUsd: 99,  credits: 4000 }
} as const;

export type CreditPackKey = keyof typeof CREDIT_PACKS;

export async function getCreditBalance(telegramId: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { telegramId }, select: { creditBalance: true } });
    return user?.creditBalance || 0;
}

// 🟢 FIX: 1 Atomic UPDATE...RETURNING for consumeCredit
export async function consumeCredit(
    telegramId: string,
    type: 'CONSUME_SCAN' | 'CONSUME_CALLER' | 'CONSUME_SNIPER_SCORE',
    tokenMint: string
): Promise<{ success: boolean; remaining: number }> {
    
    // Check if simulation is active first
    const { isSimulationActive } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        const currentSimCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
        if (currentSimCredits <= 0) return { success: false, remaining: 0 };
        
        const newSimCredits = currentSimCredits - 1;
        await redis.set(`sim:credits:${telegramId}`, newSimCredits.toString());
        return { success: true, remaining: newSimCredits };
    }

    let result: { id: string; creditBalance: number }[];
    try {
        result = await prisma.$queryRaw<{ id: string; creditBalance: number }[]>`
            UPDATE "User"
            SET "creditBalance" = "creditBalance" - 1
            WHERE "telegramId" = ${telegramId} AND "creditBalance" > 0
            RETURNING id, "creditBalance"
        `;
    } catch (e) {
        return { success: false, remaining: 0 };
    }

    if (!result || result.length === 0) {
        return { success: false, remaining: 0 };
    }

    const { id: userId, creditBalance } = result[0];

    // Fire-and-forget non-blocking audit logging
    prisma.creditTransaction.create({
        data: {
            userId,
            type,
            amount: -1,
            balanceAfter: creditBalance,
            tokenMint
        }
    }).catch(() => {});

    return { success: true, remaining: creditBalance };
}

// 🟢 FIX: Collapsed 4 sequential DB round-trips into 1 atomic UPDATE...RETURNING with non-blocking audit write
export async function consumeSniperCredit(
    telegramId: string,
    tokenMint: string
): Promise<{ success: boolean; remaining: number; fallback: boolean }> {

    // Check if simulation is active
    const { isSimulationActive } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        const currentSimCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
        if (currentSimCredits <= 0) return { success: false, remaining: 0, fallback: true };
        
        const newSimCredits = currentSimCredits - 1;
        await redis.set(`sim:credits:${telegramId}`, newSimCredits.toString());
        return { success: true, remaining: newSimCredits, fallback: false };
    }

    let result: { id: string; creditBalance: number }[];
    try {
        result = await prisma.$queryRaw<{ id: string; creditBalance: number }[]>`
            UPDATE "User"
            SET "creditBalance" = "creditBalance" - 1
            WHERE "telegramId" = ${telegramId} AND "creditBalance" > 0
            RETURNING id, "creditBalance"
        `;
    } catch (e) {
        return { success: false, remaining: 0, fallback: true };
    }

    if (!result || result.length === 0) {
        return { success: false, remaining: 0, fallback: true };
    }

    const { id: userId, creditBalance } = result[0];

    // Fire-and-forget non-blocking audit write
    prisma.creditTransaction.create({
        data: {
            userId,
            type: 'CONSUME_SNIPER_SCORE',
            amount: -1,
            balanceAfter: creditBalance,
            tokenMint
        }
    }).catch(() => {});

    return { success: true, remaining: creditBalance, fallback: false };
}

export async function addCredits(
    telegramId: string, 
    packKey: CreditPackKey, 
    txSignature?: string
): Promise<{ success: boolean; newBalance: number }> {
    const pack = CREDIT_PACKS[packKey];
    const user = await prisma.user.findUnique({ 
        where: { telegramId },
        include: { referredBy: true }
    });
    if (!user) return { success: false, newBalance: 0 };

    const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
            creditBalance: { increment: pack.credits },
            lifetimeCredits: { increment: pack.credits }
        }
    });

    await prisma.creditTransaction.create({
        data: {
            userId: user.id, 
            type: 'PURCHASE', 
            amount: pack.credits,
            balanceAfter: updated.creditBalance, 
            packName: pack.name, 
            txSignature
        }
    });

    // 🟢 40% AFFILIATE REVENUE SHARE ON AI CREDITS
    if (user.referredById) {
        try {
            const { cachedSolUsdPrice } = await import('./grpc.service.js');
            const solRate = cachedSolUsdPrice || 156.93;
            const packPriceSol = pack.priceUsd / solRate;
            const commissionSol = parseFloat((packPriceSol * 0.40).toFixed(4));

            if (commissionSol > 0) {
                await prisma.user.update({
                    where: { id: user.referredById },
                    data: {
                        pendingRewardsSol: { increment: commissionSol }
                    }
                });
                await redis.incrbyfloat(`affiliate:credit_revenue:${user.referredById}`, commissionSol);
            }
        } catch (affErr: any) {
            console.error("🔴 [CREDITS AFFILIATE] Commission calculation error:", affErr.message);
        }
    }

    return { success: true, newBalance: updated.creditBalance };
}

export async function getUsageStats(telegramId: string, days: number = 30) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return null;

    const since = new Date(Date.now() - days * 86400000);
    const txs = await prisma.creditTransaction.findMany({
        where: { userId: user.id, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' }
    });

    const scanConsumed = txs.filter(t => t.type === 'CONSUME_SCAN').length;
    const callerConsumed = txs.filter(t => t.type === 'CONSUME_CALLER').length;
    const sniperConsumed = txs.filter(t => t.type === 'CONSUME_SNIPER_SCORE').length;
    const purchased = txs.filter(t => t.type === 'PURCHASE').reduce((s, t) => s + t.amount, 0);

    return {
        currentBalance: user.creditBalance,
        lifetimeCredits: user.lifetimeCredits,
        scanConsumed, 
        callerConsumed, 
        sniperConsumed,
        totalConsumed: scanConsumed + callerConsumed + sniperConsumed,
        purchasedInWindow: purchased,
        recentTxs: txs.slice(0, 20)
    };
}