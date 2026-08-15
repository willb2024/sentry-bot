// src/services/dca.service.ts
import { prisma } from '../lib/prisma.js';
import { executeSnipe, getCachedTokenPrice } from './engine.service.js';
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { redlock } from '../lib/redlock.js';
import { logger } from '../lib/logger.js';

dotenv.config();

let cachedDcaOrders: any[] = [];

declare global { var _sentryIntervals: NodeJS.Timeout[]; }
if (!global._sentryIntervals) global._sentryIntervals = [];

global._sentryIntervals.push(setInterval(async () => {
    try {
        cachedDcaOrders = await prisma.activeOrder.findMany({
            where: { orderType: 'DCA', isActive: true },
            include: { user: true }
        });
    } catch (e: any) {
        logger.error("🔴 [DCA CACHE] Sync Error", { error: e.message });
    }
}, 10000));

export async function processDcaOrders(bot: any) {
    const executionSnapshot = [...cachedDcaOrders];
    if (executionSnapshot.length === 0) return;

    const now = new Date();

    for (let i = 0; i < executionSnapshot.length; i++) {
        const order = executionSnapshot[i];
        const intervalMs = (order.dcaIntervalMins || 60) * 60 * 1000;
        const timeSinceLastBuy = now.getTime() - new Date(order.updatedAt).getTime();

        if (timeSinceLastBuy >= intervalMs) {
            const lockKey = `lock:dca_exec:${order.id}`;
            let lock;
            try {
                lock = await redlock.acquire([lockKey], Math.max(60000, intervalMs - 5000));
            } catch (e) { 
                continue; 
            }

            try {
                const liveCheck = await prisma.activeOrder.findUnique({ where: { id: order.id } });
                if (!liveCheck || !liveCheck.isActive) {
                    cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                    continue;
                }

                const buyCountKey = `dca_buy_count:${order.id}`;
                const currentBuys = parseInt(await redis.get(buyCountKey) || '0');
                if (order.maxBuys && currentBuys >= order.maxBuys) {
                    await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                    cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                    try {
                        await bot.telegram.sendMessage(
                            order.user.telegramId,
                            `✅ <b>DCA COMPLETE: Max Buys Reached</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nLimit of ${order.maxBuys} buys reached.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (_) {}
                    continue;
                }

                const intendedSpend = order.amountSol * (order.user?.activeWallets || 1);
                const allocKey = `dca_allocated:${order.id}`;
                const luaAlloc = `
                    local key = KEYS[1]
                    local add = tonumber(ARGV[1])
                    local ttl = tonumber(ARGV[2])
                    local current = redis.call('get', key) or '0'
                    local new = tonumber(current) + add
                    redis.call('set', key, new, 'EX', ttl)
                    return tostring(new)
                `;

                const newAllocated = parseFloat(await redis.eval(luaAlloc, 1, allocKey, intendedSpend.toString(), '120') as string);

                if (order.maxBudgetSol && (order.totalSpentSol + newAllocated) > order.maxBudgetSol) {
                    await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                    cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                    try {
                        await bot.telegram.sendMessage(
                            order.user.telegramId,
                            `✅ <b>DCA COMPLETE: Max Budget Reached</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nTotal Spent: <b>${order.totalSpentSol.toFixed(4)} SOL</b>`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (_) {}
                    continue;
                }

                const idx = cachedDcaOrders.findIndex(o => o.id === order.id);
                if (idx !== -1) cachedDcaOrders[idx].updatedAt = new Date();
                await prisma.activeOrder.update({ where: { id: order.id }, data: { updatedAt: new Date() } });

                // 🟢 FIX: Explicitly set strategy to 'DCA'
                executeSnipe(
                    order.user.telegramId,
                    order.tokenAddress,
                    order.amountSol,
                    'buy',
                    undefined,
                    false,
                    undefined,
                    undefined,
                    0,
                    undefined,
                    'DCA'
                ).then(async (result) => {
                    const activeAlloc = parseFloat(await redis.get(allocKey) || '0');
                    await redis.set(allocKey, Math.max(0, activeAlloc - intendedSpend).toString(), 'EX', 120);

                    if (result.success) {
                        const spent = result.volumeSpent || intendedSpend;
                        await redis.incr(buyCountKey);

                        const activeIdx = cachedDcaOrders.findIndex(o => o.id === order.id);
                        if (activeIdx !== -1) cachedDcaOrders[activeIdx].totalSpentSol += spent;

                        await prisma.activeOrder.update({
                            where: { id: order.id },
                            data: { totalSpentSol: { increment: spent } }
                        });

                        let initialPriceNative = 0;
                        try {
                            initialPriceNative = await getCachedTokenPrice(order.tokenAddress);
                            if (initialPriceNative === 0 && order.tokenAddress.toLowerCase().endsWith("pump")) {
                                const curvePda = getBondingCurveAddress(order.tokenAddress);
                                const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                                if (accInfo?.data) {
                                    initialPriceNative = decodePumpCurvePrice(accInfo.data.toString('base64'));
                                }
                            }
                        } catch (_) {}

                        await addTrailingStopToMemory(
                            order.user.telegramId,
                            order.tokenAddress,
                            order.trailingPercent || 20.0,
                            order.amountSol,
                            initialPriceNative,
                            order.takeProfitPercent || undefined
                        );

                        try {
                            const tpText = order.takeProfitPercent ? `+${order.takeProfitPercent}% TP` : '';
                            await bot.telegram.sendMessage(
                                order.user.telegramId,
                                `🟢 <b>DCA BUY EXECUTED!</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nInvested: <b>${spent.toFixed(4)} SOL</b>\nStatus: 🟢 Trade Confirmed.\n\n<i>Guard Armed: -${order.trailingPercent || 20.0}% SL | ${tpText}</i>\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    } else {
                        const activeIdx = cachedDcaOrders.findIndex(o => o.id === order.id);
                        if (activeIdx !== -1) cachedDcaOrders.splice(activeIdx, 1);
                        await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                        try {
                            await bot.telegram.sendMessage(
                                order.user.telegramId,
                                `🔴 <b>DCA BUY FAILED & PAUSED</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nReason: ${result.message}\n\n<i>This DCA schedule has been paused to protect your wallet.</i>`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) {}
                    }
                }).catch(async (e: any) => {
                    const activeAlloc = parseFloat(await redis.get(allocKey) || '0');
                    await redis.set(allocKey, Math.max(0, activeAlloc - intendedSpend).toString(), 'EX', 120);
                    logger.error("🔴 [DCA] Snipe Exception", { error: e.message });
                });

            } finally {
                if (lock) await (lock as any).release().catch(() => {});
            }
        }
    }
}