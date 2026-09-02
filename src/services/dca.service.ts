// src/services/dca.service.ts
import { prisma } from '../lib/prisma.js';
import { executeSnipe, getCachedTokenPrice } from './engine.service.js';
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { redlock } from '../lib/redlock.js';
import { logger } from '../lib/logger.js';
import { isSimulationActive, simExecuteSnipe } from './simulation.service.js';

let cachedDcaOrders: any[] = [];

if (global._sentryIntervals) {
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
}

export async function processDcaOrders(bot: any) {
    const executionSnapshot = [...cachedDcaOrders];
    if (executionSnapshot.length === 0) return;

    const now = new Date();

    for (let i = 0; i < executionSnapshot.length; i++) {
        const order = executionSnapshot[i];
        const intervalMs = (order.dcaIntervalMins || 60) * 60 * 1000;
        const timeSinceLastBuy = now.getTime() - new Date(order.updatedAt).getTime();

        if (timeSinceLastBuy < intervalMs) continue;

        const lockKey = `lock:dca_exec:${order.id}`;
        let lock: any = null;

        try {
            lock = await redlock.acquire([lockKey], Math.max(10000, Math.min(intervalMs - 5000, 55000)));
        } catch (_) {
            continue; // Lock busy, will retry next cycle
        }

        try {
            const liveCheck = await prisma.activeOrder.findUnique({ where: { id: order.id } });
            if (!liveCheck || !liveCheck.isActive) {
                cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                continue;
            }

            const buyCountKey = `dca_buy_count:${order.id}`;
            const currentBuys = parseInt(await redis.get(buyCountKey) || '0', 10);
            if (order.maxBuys && currentBuys >= order.maxBuys) {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                try {
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🏁 <b>DCA COMPLETE: Max Buys Reached</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nLimit of ${order.maxBuys} buys reached.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
                continue;
            }

            const intendedSpend = order.amountSol * (order.user?.activeWallets || 1);
            if (order.maxBudgetSol && (order.totalSpentSol + intendedSpend) > order.maxBudgetSol) {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                try {
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🏁 <b>DCA COMPLETE: Max Budget Reached</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nTotal Spent: <b>${order.totalSpentSol.toFixed(4)} SOL</b>`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
                continue;
            }

            // Update timestamp
            await prisma.activeOrder.update({ where: { id: order.id }, data: { updatedAt: new Date() } });
            const idx = cachedDcaOrders.findIndex(o => o.id === order.id);
            if (idx !== -1) cachedDcaOrders[idx].updatedAt = new Date();

            const isSim = await isSimulationActive(order.user.telegramId);
            let snipeResult: any;

            if (isSim) {
                snipeResult = await simExecuteSnipe(
                    order.user.telegramId,
                    order.tokenAddress,
                    order.amountSol,
                    'DCA Engine',
                    75,
                    order.trailingPercent || 20,
                    order.takeProfitPercent || undefined
                );
            } else {
                snipeResult = await executeSnipe(
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
                    'DCA Engine'
                );
            }

            if (snipeResult.success) {
                const spent = snipeResult.volumeSpent || intendedSpend;
                await redis.incr(buyCountKey);

                await prisma.activeOrder.update({
                    where: { id: order.id },
                    data: { totalSpentSol: { increment: spent } }
                });

                if (!isSim) {
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
                        order.takeProfitPercent || undefined,
                        undefined,
                        'DCA Engine'
                    );
                }

                try {
                    const tpText = order.takeProfitPercent ? `+${order.takeProfitPercent}% TP` : '';
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🟢 <b>DCA BUY EXECUTED!${isSim ? ' (SIM)' : ''}</b>\n\n` +
                        `Token: <code>${order.tokenAddress.substring(0, 8)}...</code>\n` +
                        `Invested: <b>${spent.toFixed(4)} SOL</b>\n` +
                        `<i>Guard Armed: -${order.trailingPercent || 20.0}% SL ${tpText ? '| ' + tpText : ''}</i>\n\n` +
                        `🔗 <a href="https://solscan.io/tx/${snipeResult.signature}">View Receipt</a>`,
                        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                    );
                } catch (_) {}
            } else {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                cachedDcaOrders = cachedDcaOrders.filter(o => o.id !== order.id);
                try {
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🔴 <b>DCA SCHEDULE PAUSED</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nReason: ${snipeResult.message}`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
            }
        } finally {
            if (lock) {
                try { await lock.release(); } catch (_) {}
            }
        }
    }
}