// src/services/order.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// BUG 8 FIX: Export ORDER_TYPES constant and use it across the service
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
}

export async function syncGuardsFromDb() {
    console.log("🔄 [DB] Restoring active Trailing Guards into RAM...");
    try {
        const dbGuards = await prisma.activeOrder.findMany({ 
            where: { orderType: ORDER_TYPES.GUARD, isActive: true }, 
            include: { user: true } 
        });
        
        for (const g of dbGuards) {
            const order: TrailingOrder = {
                id: g.id,
                telegramId: g.user.telegramId,
                tokenAddress: g.tokenAddress,
                trailingPercent: g.trailingPercent || 20,
                highestSeenPrice: g.targetPriceUsd || 0,
                amountInSol: g.amountSol,
                entryPrice: g.targetPriceUsd || 0,
                takeProfitPercent: g.takeProfitPercent || undefined
            };
            
            await redis.set(`order:trail:${g.id}`, JSON.stringify(order));
            await redis.sadd(`active_guards_global`, g.id); 
            await redis.sadd(`user_guards:${g.user.telegramId}`, g.id);
            await redis.sadd(`token_guards:${g.user.telegramId}:${g.tokenAddress}`, g.id); 
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
    }
    console.error(`🔴 [REDIS] Race condition blocked. Failed to update order ${orderId} after ${maxRetries} retries.`);
}

export async function addTrailingStopToMemory(
    telegramId: string, tokenAddress: string, trailingPercent: number, 
    amountInSol: number, currentPrice: number, takeProfitPercent?: number
): Promise<string> {
    const orderId = crypto.randomUUID();
    const order: TrailingOrder = { 
        id: orderId, telegramId, tokenAddress, trailingPercent, 
        highestSeenPrice: currentPrice, amountInSol, entryPrice: currentPrice, takeProfitPercent 
    };

    await redis.set(`order:trail:${orderId}`, JSON.stringify(order));
    await redis.sadd(`active_guards_global`, orderId); 
    await redis.sadd(`user_guards:${telegramId}`, orderId);
    await redis.sadd(`token_guards:${telegramId}:${tokenAddress}`, orderId); 

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (user) {
            await prisma.activeOrder.create({
                data: {
                    id: orderId,
                    userId: user.id,
                    tokenAddress,
                    orderType: ORDER_TYPES.GUARD,
                    amountSol: amountInSol,
                    trailingPercent,
                    takeProfitPercent: takeProfitPercent || null,
                    targetPriceUsd: currentPrice,
                    isActive: true
                }
            });
        }
    } catch (e: any) {
        console.error(`⚠️ [DB] Non-fatal DB write error for guard ${orderId}: ${e.message}`);
    }

    console.log(`🛡️ [REDIS] Guard Active | CA: ${tokenAddress.substring(0,6)}`);
    return orderId;
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

export async function updateHighestSeen(orderId: string, newHigh: number) {
    await updateGuardSafe(orderId, (order) => { order.highestSeenPrice = newHigh; });
}

export async function updateGuardSize(orderId: string, newAmountInSol: number) {
    await updateGuardSafe(orderId, (order) => { order.amountInSol = newAmountInSol; });
}

export async function updateEntryPrice(orderId: string, entryPrice: number) {
    await updateGuardSafe(orderId, (order) => { order.entryPrice = entryPrice; });
}


// Update the function:
export async function removeOrderFromMemory(orderId: string, telegramId: string, tokenAddress: string) {
    try {
        await redis.del(`order:trail:${orderId}`);
        await redis.srem(`active_guards_global`, orderId);
        await redis.srem(`user_guards:${telegramId}`, orderId);
        await redis.srem(`token_guards:${telegramId}:${tokenAddress}`, orderId);

        await prisma.activeOrder.updateMany({
            where: { id: orderId, orderType: ORDER_TYPES.GUARD },
            data: { isActive: false }
        });

        // 🟢 CLAUDE FIX C.3: Check if token has zero guards left, and clean up the WebSocket.
        const remainingGuards = await redis.smembers(`token_guards:${telegramId}:${tokenAddress}`);
        if (remainingGuards.length === 0) {
            // 🟢 TS FIX: Use dynamic import inside the function to prevent circular dependency crashes!
            const { releaseGuardSubscription } = await import('./grpc.service.js');
            releaseGuardSubscription(tokenAddress);
        }

    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to remove order ${orderId} from memory: ${e.message}`);
    }
}

export async function cancelAllGuardsForToken(telegramId: string, tokenAddress: string) {
    try {
        const orderIds = await redis.smembers(`token_guards:${telegramId}:${tokenAddress}`);
        for (const id of orderIds) {
            await removeOrderFromMemory(id, telegramId, tokenAddress);
        }
    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to cancel guards for token ${tokenAddress}: ${e.message}`);
    }
}

export async function cancelAllUserGuards(telegramId: string): Promise<number> {
    try {
        const userOrderIds = await redis.smembers(`user_guards:${telegramId}`);
        if (userOrderIds.length === 0) return 0;
        
        for (const orderId of userOrderIds) {
            const raw = await redis.get(`order:trail:${orderId}`);
            if (raw) {
                try {
                    const order: TrailingOrder = JSON.parse(raw);
                    await removeOrderFromMemory(orderId, telegramId, order.tokenAddress);
                } catch (e) {
                    await redis.del(`order:trail:${orderId}`);
                    await redis.srem(`active_guards_global`, orderId);
                    await redis.srem(`user_guards:${telegramId}`, orderId);
                }
            }
        }
        return userOrderIds.length;
    } catch (e: any) {
        console.error(`🔴 [GUARD] Failed to cancel all user guards: ${e.message}`);
        return 0;
    }
}