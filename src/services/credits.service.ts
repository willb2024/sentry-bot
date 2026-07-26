// src/services/credits.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';

const prisma = new PrismaClient();


// 🟢 Pricing tiers — flattened curve, cheaper entry point
export const CREDIT_PACKS = {
    starter: { name: 'Starter', priceSol: null, priceUsd: 20,  credits: 140  }, // $0.143/credit
    growth:  { name: 'Growth',  priceSol: null, priceUsd: 40,  credits: 300  }, // $0.133/credit
    pro:     { name: 'Pro',     priceSol: null, priceUsd: 60,  credits: 480  }, // $0.125/credit
    whale:   { name: 'Whale',   priceSol: null, priceUsd: 100, credits: 2000 }  // $0.05/credit — unchanged
} as const;

export type CreditPackKey = keyof typeof CREDIT_PACKS;

export async function getCreditBalance(telegramId: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { telegramId }, select: { creditBalance: true } });
    return user?.creditBalance || 0;
}

// 🟢 Called ONLY when a real, deliverable token match is found
export async function consumeCredit(
    telegramId: string,
    type: 'CONSUME_SCAN' | 'CONSUME_CALLER',
    tokenMint: string
): Promise<{ success: boolean; remaining: number }> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return { success: false, remaining: 0 };

    if (user.creditBalance <= 0) return { success: false, remaining: 0 };

    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { creditBalance: { decrement: 1 } }
    });

    await prisma.creditTransaction.create({
        data: {
            userId: user.id, type, amount: -1,
            balanceAfter: updated.creditBalance, tokenMint
        }
    });

    return { success: true, remaining: updated.creditBalance };
}

export async function addCredits(
    telegramId: string, packKey: CreditPackKey, txSignature?: string
): Promise<{ success: boolean; newBalance: number }> {
    const pack = CREDIT_PACKS[packKey];
    const user = await prisma.user.findUnique({ where: { telegramId } });
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
            userId: user.id, type: 'PURCHASE', amount: pack.credits,
            balanceAfter: updated.creditBalance, packName: pack.name, txSignature
        }
    });

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
    const purchased = txs.filter(t => t.type === 'PURCHASE').reduce((s, t) => s + t.amount, 0);

    return {
        currentBalance: user.creditBalance,
        lifetimeCredits: user.lifetimeCredits,
        scanConsumed, callerConsumed,
        totalConsumed: scanConsumed + callerConsumed,
        purchasedInWindow: purchased,
        recentTxs: txs.slice(0, 20)
    };
}