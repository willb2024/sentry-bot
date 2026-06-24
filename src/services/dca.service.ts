// src/services/dca.service.ts
import { PrismaClient } from '@prisma/client';
import { executeSnipe } from './engine.service.js';
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { PublicKey } from '@solana/web3.js';
import axios from 'axios';
import dotenv from 'dotenv';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';

dotenv.config();
const prisma = new PrismaClient();

let isDcaChecking = false;
let cachedDcaOrders: any[] = [];

setInterval(async () => {
    try {
        cachedDcaOrders = await prisma.activeOrder.findMany({
            where: { orderType: 'DCA', isActive: true },
            include: { user: true }
        });
    } catch (e: any) {
        console.error("🔴 DCA Cache Sync Error:", e.message);
    }
}, 10000);

export function startDcaEngine(bot: any) {
    console.log("⏱️ [DCA ENGINE] TWAP / DCA Native RAM-Cached Loop initialized.");

    setInterval(async () => {
        if (isDcaChecking) return;
        isDcaChecking = true;

        try {
            if (cachedDcaOrders.length === 0) return;
            const now = new Date();

            for (let i = 0; i < cachedDcaOrders.length; i++) {
                const order = cachedDcaOrders[i];

                const intervalMs = (order.dcaIntervalMins || 60) * 60 * 1000;
                const timeSinceLastBuy = now.getTime() - new Date(order.updatedAt).getTime();

                if (timeSinceLastBuy >= intervalMs) {

                    const lockTtlSeconds = Math.max(60, Math.floor((intervalMs / 1000) - 5));
                    const lockKey = `lock:dca_exec:${order.id}`;
                    const isLocked = await redis.set(lockKey, 'LOCKED', 'EX', lockTtlSeconds, 'NX'); 
                    if (!isLocked) continue;

                    const liveCheck = await prisma.activeOrder.findUnique({ where: { id: order.id } });
                    if (!liveCheck || !liveCheck.isActive) {
                        const idx = cachedDcaOrders.findIndex(o => o.id === order.id);
                        if (idx !== -1) cachedDcaOrders.splice(idx, 1);
                        await redis.del(lockKey); 
                        continue;
                    }

                    const intendedSpend = order.amountSol * order.user.activeWallets;

                    // 🟢 CRITICAL BUG 6 FIX: Track inflight pre-allocations in Redis to prevent race conditions 
                    // during slow Jito confirmations where parallel ticks might read stale totalSpentSol database values.
                    const allocKey = `dca_allocated:${order.id}`;
                    const rawAllocated = await redis.get(allocKey);
                    const currentAllocated = rawAllocated ? parseFloat(rawAllocated) : 0;

                    if (order.maxBudgetSol && (order.totalSpentSol + currentAllocated + intendedSpend) > order.maxBudgetSol) {
                        await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                        const idx = cachedDcaOrders.findIndex(o => o.id === order.id);
                        if (idx !== -1) cachedDcaOrders.splice(idx, 1);
                        try {
                            await bot.telegram.sendMessage(
                                order.user.telegramId,
                                `✅ <b>DCA COMPLETE: Max Budget Reached</b>\n\nToken: <code>${order.tokenAddress.substring(0, 8)}...</code>\nTotal Spent: <b>${order.totalSpentSol.toFixed(4)} SOL</b>\n<i>This DCA schedule has successfully finished its allocation and powered down.</i>`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) {}
                        await redis.del(lockKey);
                        continue;
                    }

                    // Log inflight allocation in memory before firing async trade
                    await redis.set(allocKey, (currentAllocated + intendedSpend).toString(), 'EX', 120);

                    const idx = cachedDcaOrders.findIndex(o => o.id === order.id);
                    if (idx !== -1) cachedDcaOrders[idx].updatedAt = new Date();
                    await prisma.activeOrder.update({ where: { id: order.id }, data: { updatedAt: new Date() } });

                    const capturedOrderId = order.id;
                    const capturedTokenAddress = order.tokenAddress;
                    const capturedTelegramId = order.user.telegramId;
                    const capturedAmountSol = order.amountSol;
                    const capturedSlPercent = order.trailingPercent || 20.0;
                    const capturedTpPercent = order.takeProfitPercent || undefined;

                    executeSnipe(capturedTelegramId, capturedTokenAddress, capturedAmountSol).then(async (result) => {
                        // Clean up inflight allocation memory block
                        const activeAlloc = parseFloat(await redis.get(allocKey) || '0');
                        await redis.set(allocKey, Math.max(0, activeAlloc - intendedSpend).toString(), 'EX', 120);

                        if (result.success) {
                            const spent = result.volumeSpent || intendedSpend;

                            const activeIdx = cachedDcaOrders.findIndex(o => o.id === capturedOrderId);
                            if (activeIdx !== -1) cachedDcaOrders[activeIdx].totalSpentSol += spent;

                            await prisma.activeOrder.update({
                                where: { id: capturedOrderId },
                                data: { totalSpentSol: { increment: spent } }
                            });

                            let initialPriceNative = 0;
                            try {
                                const priceRes = await axios.get(
                                    `https://lite-api.jup.ag/price/v2?ids=${capturedTokenAddress}`
                                ).catch(() => null);
                                initialPriceNative = priceRes?.data?.data?.[capturedTokenAddress]?.price || 0;

                                if (initialPriceNative === 0 && capturedTokenAddress.toLowerCase().endsWith("pump")) {
                                    const curvePda = getBondingCurveAddress(capturedTokenAddress);
                                    const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                                    if (accInfo?.data) {
                                        initialPriceNative = decodePumpCurvePrice(accInfo.data.toString('base64'));
                                    }
                                }
                            } catch (_) {}

                            await addTrailingStopToMemory(
                                capturedTelegramId,
                                capturedTokenAddress,
                                capturedSlPercent,
                                capturedAmountSol,
                                initialPriceNative,
                                capturedTpPercent
                            );

                            try {
                                const tpText = capturedTpPercent ? `+${capturedTpPercent}% TP` : '';
                                await bot.telegram.sendMessage(
                                    capturedTelegramId,
                                    `🟢 <b>DCA BUY EXECUTED!</b>\n\nToken: <code>${capturedTokenAddress.substring(0, 8)}...</code>\nInvested: <b>${spent.toFixed(4)} SOL</b>\nStatus: 🟢 Trade Confirmed.\n\n<i>Guard Armed: -${capturedSlPercent}% SL | ${tpText}</i>\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                );
                            } catch (_) {}
                        } else {
                            const activeIdx = cachedDcaOrders.findIndex(o => o.id === capturedOrderId);
                            if (activeIdx !== -1) cachedDcaOrders.splice(activeIdx, 1);
                            await prisma.activeOrder.update({
                                where: { id: capturedOrderId },
                                data: { isActive: false }
                            });
                            try {
                                await bot.telegram.sendMessage(
                                    capturedTelegramId,
                                    `🔴 <b>DCA BUY FAILED & PAUSED</b>\n\nToken: <code>${capturedTokenAddress.substring(0, 8)}...</code>\nReason: ${result.message}\n\n<i>This DCA schedule has been paused to protect your wallet.</i>`,
                                    { parse_mode: 'HTML' }
                                );
                            } catch (_) {}
                        }
                    }).catch(async (e: any) => {
                        // Safe rollback of pre-allocation if execution crashes
                        const activeAlloc = parseFloat(await redis.get(allocKey) || '0');
                        await redis.set(allocKey, Math.max(0, activeAlloc - intendedSpend).toString(), 'EX', 120);
                        console.error("🔴 DCA Snipe Exception:", e.message);
                    });
                }
            }
        } catch (error: any) {
            console.error("🔴 Fatal DCA Loop Error:", error.message);
        } finally {
            isDcaChecking = false;
        }
    }, 1000);
}