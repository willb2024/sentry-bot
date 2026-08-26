// src/services/order.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { subscribeToMintPrice, unsubscribeFromMintPrice } from './guard-price-feed.service.js';
import { prisma } from '../lib/prisma.js';
import { generatePreSignedExitTxMulti } from './engine.service.js';
import { pushGuardToCacheImmediately, presignGuardImmediately } from './grpc.service.js';

export const ORDER_TYPES = {
    DCA: 'DCA',
    LIMIT: 'LIMIT',
    GUARD: 'GUARD',
    ALERT: 'ALERT'
};

export interface TrailingOrder {
    id: string;
    telegramId: string;
    tokenAddress: string;
    trailingPercent: number;
    highestSeenPrice: number;
    amountInSol: number;
    entryPrice: number;           
    takeProfitPercent?: number; 
    maxHoldMinutes?: number; 
    createdAt?: number;
    strategy?: string;
    isProcessing?: boolean; // 🟢 In-memory guard execution lock
}

export async function syncGuardsFromDb() {
    console.log("🔄 [DB] Restoring active Trailing Guards into RAM...");
    try {
        const dbGuards = await prisma.activeOrder.findMany({ 
            where: { orderType: ORDER_TYPES.GUARD, isActive: true }, 
            include: { user: true } 
        });
        
        for (const g of dbGuards) {
            const maxHold = (g as any).maxHoldMinutes as number | null | undefined;
            const order: TrailingOrder = {
                id: g.id,
                telegramId: g.user.telegramId,
                tokenAddress: g.tokenAddress,
                trailingPercent: g.trailingPercent || 20,
                highestSeenPrice: g.targetPriceUsd || 0,
                amountInSol: g.amountSol,
                entryPrice: g.targetPriceUsd || 0,
                takeProfitPercent: g.takeProfitPercent || undefined,
                maxHoldMinutes: maxHold === null || maxHold === undefined ? undefined : maxHold,
                createdAt: g.createdAt.getTime(),
                strategy: (g as any).strategy || 'Manual / Direct'
            };
            
            await redis.set(`order:trail:${g.id}`, JSON.stringify(order));
            await redis.sadd(`active_guards_global`, g.id); 
            await redis.sadd(`user_guards:${g.user.telegramId}`, g.id);
            await redis.sadd(`token_guards:${g.user.telegramId}:${g.tokenAddress}`, g.id); 

            await subscribeToMintPrice(g.tokenAddress, g.id).catch(() => {});
        }
        console.log(`✅ [DB] Successfully restored ${dbGuards.length} guards.`);
    } catch (e: any) {
        console.error("🔴 [DB] Failed to sync guards:", e.message);
    }
}

async function updateGuardSafe(orderId: string, mutateFn: (order: TrailingOrder) => void) {
    const key = `order:trail:${orderId}`;
    const maxRetries = 5;

    for (let i = 0; i < maxRetries; i++) {
        await redis.watch(key); 
        const raw = await redis.get(key);
        
        if (!raw) {
            await redis.unwatch();
            return;
        }

        const order: TrailingOrder = JSON.parse(raw);
        mutateFn(order); 

        const multi = redis.multi();
        multi.set(key, JSON.stringify(order));
        const execResult = await multi.exec();

        if (execResult !== null) return; 
        
        await redis.unwatch();
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
}

export async function getAllActiveGuards(): Promise<TrailingOrder[]> {
    try {
        const orderIds = await redis.smembers(`active_guards_global`);
        if (orderIds.length === 0) return [];
        const rawOrders = await redis.mget(orderIds.map(id => `order:trail:${id}`));
        return rawOrders.filter((o): o is string => o !== null).map(o => JSON.parse(o) as TrailingOrder);
    } catch (e: any) {
        console.error(`🔴 [REDIS] Failed to fetch active guards: ${e.message}`);
        return [];
    }
}

export async function updateHighestSeenFast(orderId: string, newHigh: number) {
    try {
        const key = `order:trail:${orderId}`;
        const raw = await redis.get(key);
        if (!raw) return;
        const order: TrailingOrder = JSON.parse(raw);
        order.highestSeenPrice = newHigh;
        await redis.set(key, JSON.stringify(order));
    } catch (_) {}
}

export async function updateHighestSeen(orderId: string, newHigh: number) {
    await updateHighestSeenFast(orderId, newHigh);
}

export async function updateGuardSize(orderId: string, newAmountInSol: number) {
    await updateGuardSafe(orderId, (order) => { order.amountInSol = newAmountInSol; });
}

export async function updateEntryPrice(orderId: string, entryPrice: number) {
    await updateGuardSafe(orderId, (order) => { order.entryPrice = entryPrice; });
}

export async function addTrailingStopToMemory(
    telegramId: string, tokenAddress: string, trailingPercent: number, 
    amountInSol: number, currentPrice: number, takeProfitPercent?: number,
    maxHoldMinutes?: number,
    strategy: string = 'Manual / Direct'
): Promise<string> {
    const orderId = crypto.randomUUID();
    const order: TrailingOrder = { 
        id: orderId, telegramId, tokenAddress, trailingPercent, 
        highestSeenPrice: currentPrice, amountInSol, entryPrice: currentPrice, takeProfitPercent,
        maxHoldMinutes, createdAt: Date.now(),
        strategy
    };

    // 🟢 SIM FIX: This now executes identically for Simulation users, placing
    // real guards in memory tracking real token prices!
    await redis.set(`order:trail:${orderId}`, JSON.stringify(order));
    await redis.sadd(`active_guards_global`, orderId); 
    await redis.sadd(`user_guards:${telegramId}`, orderId);
    await redis.sadd(`token_guards:${telegramId}:${tokenAddress}`, orderId); 

    await subscribeToMintPrice(tokenAddress, orderId).catch(() => {});

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (user) {
            await prisma.activeOrder.create({
                data: {
                    id: orderId, userId: user.id, tokenAddress, orderType: ORDER_TYPES.GUARD,
                    amountSol: amountInSol, trailingPercent, takeProfitPercent: takeProfitPercent || null,
                    targetPriceUsd: currentPrice, isActive: true, maxHoldMinutes: maxHoldMinutes || null
                } as any
            });
        }
    } catch (e: any) {}

    pushGuardToCacheImmediately(order);
    presignGuardImmediately(order).catch(() => {});

    return orderId;
}

export async function removeOrderFromMemory(orderId: string, telegramId: string, tokenAddress: string) {
    try {
        await Promise.all([
            redis.del(`order:trail:${orderId}`),
            redis.del(`presigned_exit_multi:${orderId}`),
            redis.srem(`active_guards_global`, orderId),
            redis.srem(`user_guards:${telegramId}`, orderId),
            redis.srem(`token_guards:${telegramId}:${tokenAddress}`, orderId)
        ]);

        try {
            await unsubscribeFromMintPrice(tokenAddress, orderId);
        } catch (e) {}

        await prisma.activeOrder.updateMany({
            where: { id: orderId, orderType: ORDER_TYPES.GUARD },
            data: { isActive: false }
        });

        const remainingGuards = await redis.smembers(`token_guards:${telegramId}:${tokenAddress}`);
        if (remainingGuards.length === 0) {
            const { releaseGuardSubscription } = await import('./grpc.service.js');
            releaseGuardSubscription(tokenAddress);
        }
    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to remove order ${orderId}: ${e.message}`);
    }
}

export async function cancelAllGuardsForToken(telegramId: string, tokenAddress: string) {
    try {
        const orderIds = await redis.smembers(`token_guards:${telegramId}:${tokenAddress}`);
        await Promise.all(orderIds.map(async (id) => {
            const raw = await redis.get(`order:trail:${id}`);
            if (raw) {
                await removeOrderFromMemory(id, telegramId, tokenAddress);
            } else {
                await Promise.all([
                    redis.del(`presigned_exit_multi:${id}`),
                    redis.srem(`active_guards_global`, id),
                    redis.srem(`user_guards:${telegramId}`, id),
                    redis.srem(`token_guards:${telegramId}:${tokenAddress}`, id)
                ]);
            }
        }));
    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to cancel guards for token ${tokenAddress}: ${e.message}`);
    }
}

export async function cancelAllUserGuards(telegramId: string): Promise<number> {
    try {
        const userOrderIds = await redis.smembers(`user_guards:${telegramId}`);
        if (userOrderIds.length === 0) return 0;
        
        await Promise.all(userOrderIds.map(async (orderId) => {
            const raw = await redis.get(`order:trail:${orderId}`);
            if (raw) {
                try {
                    const order: TrailingOrder = JSON.parse(raw);
                    await removeOrderFromMemory(orderId, telegramId, order.tokenAddress);
                } catch (e) {
                    await Promise.all([
                        redis.del(`order:trail:${orderId}`),
                        redis.del(`presigned_exit_multi:${orderId}`),
                        redis.srem(`active_guards_global`, orderId),
                        redis.srem(`user_guards:${telegramId}`, orderId)
                    ]);
                }
            } else {
                await Promise.all([
                    redis.del(`presigned_exit_multi:${orderId}`),
                    redis.srem(`active_guards_global`, orderId),
                    redis.srem(`user_guards:${telegramId}`, orderId)
                ]);
            }
        }));
        return userOrderIds.length;
    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to cancel all user guards: ${e.message}`);
        return 0;
    }
}