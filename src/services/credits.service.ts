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

export async function consumeCredit(
    telegramId: string,
    type: 'CONSUME_SCAN' | 'CONSUME_CALLER' | 'CONSUME_SNIPER_SCORE',
    tokenMint: string
): Promise<{ success: boolean; remaining: number }> {
    
    // 🟢 SIM FIX: Check if simulation is active first
    const { isSimulationActive } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        const currentSimCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
        if (currentSimCredits <= 0) return { success: false, remaining: 0 };
        
        const newSimCredits = currentSimCredits - 1;
        await redis.set(`sim:credits:${telegramId}`, newSimCredits.toString());
        return { success: true, remaining: newSimCredits };
    }

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return { success: false, remaining: 0 };

    const updateResult = await prisma.user.updateMany({
        where: { id: user.id, creditBalance: { gt: 0 } },
        data: { creditBalance: { decrement: 1 } }
    });

    if (updateResult.count === 0) return { success: false, remaining: 0 };

    const updated = await prisma.user.findUnique({ where: { id: user.id }, select: { creditBalance: true } });

    await prisma.creditTransaction.create({
        data: {
            userId: user.id, 
            type, 
            amount: -1,
            balanceAfter: updated!.creditBalance, 
            tokenMint
        }
    });

    return { success: true, remaining: updated!.creditBalance };
}

export async function consumeSniperCredit(
    telegramId: string,
    tokenMint: string
): Promise<{ success: boolean; remaining: number; fallback: boolean }> {

    // 🟢 SIM FIX: Check if simulation is active
    const { isSimulationActive } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        const currentSimCredits = parseInt(await redis.get(`sim:credits:${telegramId}`) || '0', 10);
        if (currentSimCredits <= 0) return { success: false, remaining: 0, fallback: true };
        
        const newSimCredits = currentSimCredits - 1;
        await redis.set(`sim:credits:${telegramId}`, newSimCredits.toString());
        return { success: true, remaining: newSimCredits, fallback: false };
    }

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return { success: false, remaining: 0, fallback: true };

    const updateResult = await prisma.user.updateMany({
        where: { id: user.id, creditBalance: { gt: 0 } },
        data: { creditBalance: { decrement: 1 } }
    });

    if (updateResult.count === 0) {
        return { success: false, remaining: 0, fallback: true };
    }

    const updated = await prisma.user.findUnique({ where: { id: user.id }, select: { creditBalance: true } });

    await prisma.creditTransaction.create({
        data: {
            userId: user.id,
            type: 'CONSUME_SNIPER_SCORE',
            amount: -1,
            balanceAfter: updated!.creditBalance,
            tokenMint
        }
    });

    return { success: true, remaining: updated!.creditBalance, fallback: false };
}

export async function addCredits(
    telegramId: string, 
    packKey: CreditPackKey, 
    txSignature?: string
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
            userId: user.id, 
            type: 'PURCHASE', 
            amount: pack.credits,
            balanceAfter: updated.creditBalance, 
            packName: pack.name, 
            txSignature
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