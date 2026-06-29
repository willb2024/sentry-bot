// src/services/grpc.service.ts
import Client from '@triton-one/yellowstone-grpc';
import { executeSnipe, executeExit, generatePreSignedExitTx, sendToJitoBundle } from './engine.service.js';
import { addTrailingStopToMemory, getAllActiveGuards, updateHighestSeen, cancelAllGuardsForToken, updateEntryPrice, TrailingOrder } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { generatePnlCard } from './image.service.js';
import { scoreTokens } from './caller.service.js'; 
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';

dotenv.config();
const prisma = new PrismaClient();
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const GRPC_URL = `https://atlas-mainnet.helius-rpc.com`;
const PUMP_FUN_PROGRAM  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const recentlySnipedTokens = new Set<string>();
let pollerStarted  = false;
let isGrpcDisabled = false;
let raydiumWsFallbackStarted = false;

const lockedGuards      = new Set<string>();
const lockedLimitOrders = new Set<string>();
const activeSubscriptions = new Map<string, number>(); 
let isPolling = false;
let globalCurvePdas = new Set<string>(); 

export let cachedSolUsdPrice = 150.0;
let isPriceReady = false; 

export async function syncInitialSolPrice() {
    try {
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4000 });
        const price = res.data?.data?.[WSOL_MINT]?.price;
        if (price && price > 0) {
            cachedSolUsdPrice = parseFloat(price);
            console.log(`🟢 [gRPC] Successfully synchronized boot price: $${cachedSolUsdPrice} USD.`);
        }
    } catch (e) {
        console.warn("⚠️ [gRPC] Stale boot price check failed, seeding default $150.0.");
    } finally {
        isPriceReady = true; 
    }
}
syncInitialSolPrice();

setInterval(async () => {
    try {
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4000 });
        const price = res.data?.data?.[WSOL_MINT]?.price;
        if (price && price > 0) cachedSolUsdPrice = parseFloat(price);
    } catch (_) {}
}, 15_000);

let cachedActiveSnipers: any[] = [];
setInterval(async () => {
    try {
        cachedActiveSnipers = await prisma.autoSnipeConfig.findMany({
            where: { isActive: true },
            include: { user: true }
        });
    } catch (_) {}
}, 3_000);

let cachedActiveGuards: TrailingOrder[] = [];
let cachedLimitOrders: any[] = [];
setInterval(async () => {
    try {
        cachedActiveGuards = await getAllActiveGuards();
        cachedLimitOrders  = await prisma.activeOrder.findMany({
            where: { orderType: { in: ['LIMIT', 'ALERT'] }, isActive: true },
            include: { user: true }
        });
    } catch (_) {}
}, 2_000);

setInterval(async () => {
    for (const guard of cachedActiveGuards) {
        if (lockedGuards.has(guard.id)) continue;
        try {
            const payload = await generatePreSignedExitTx(guard.telegramId, guard.tokenAddress);
            if (payload) {
                await redis.set(`presigned_exit:${guard.id}`, payload, 'EX', 25); 
            }
        } catch(e) {}
    }
}, 20_000);

async function fetchFreshGuard(guardId: string): Promise<TrailingOrder | null> {
    try {
        const raw = await redis.get(`order:trail:${guardId}`);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function isBondingCurveGraduated(data: Buffer): boolean {
    return data.length > 2 && data[2] === 1;
}

async function fetchLiveEntryPrice(tokenAddress: string): Promise<number> {
    try {
        const priceRes = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${tokenAddress}`, { timeout: 4000 });
        const price = priceRes?.data?.data?.[tokenAddress]?.price;
        if (price && parseFloat(price) > 0) return parseFloat(price);
    } catch (_) {}

    if (tokenAddress.toLowerCase().endsWith("pump")) {
        try {
            const curvePda = getBondingCurveAddress(tokenAddress);
            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
            if (accInfo?.data) {
                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                if (!isBondingCurveGraduated(buf)) {
                    const curvePrice = decodePumpCurvePrice(buf.toString('base64'));
                    if (curvePrice > 0) return curvePrice;
                }
            }
        } catch (_) {}
    }
    return 0;
}

async function triggerInstantExit(guard: TrailingOrder): Promise<{ success: boolean, signature?: string, message?: string }> {
    try {
        const cachedPayload = await redis.get(`presigned_exit:${guard.id}`);
        if (cachedPayload) {
            const { swapBase64, tipBase64 } = JSON.parse(cachedPayload);
            const swapTx = VersionedTransaction.deserialize(Buffer.from(swapBase64, 'base64'));
            const tipTx = VersionedTransaction.deserialize(Buffer.from(tipBase64, 'base64'));
            
            const bundleOk = await sendToJitoBundle(swapTx, tipTx);
            if (bundleOk) return { success: true, signature: bs58.encode(swapTx.signatures[0]), message: "Instant Exit Executed" };
        }
    } catch (e) {}

    return await executeExit(guard.telegramId, guard.tokenAddress, 100);
}

async function checkAndTriggerGuard(
    guardSnapshot: TrailingOrder,
    currentPriceNative: number,
    bot: any
) {

    // --- 🎮 SIMULATION INTERCEPT ---
    const { isSimulationActive, generateSimSignature, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(guardSnapshot.telegramId)) {
        // High trigger rate so you don't wait forever to see the result
        if (Math.random() > 0.5) {
            lockedGuards.add(guardSnapshot.id);
            
            // EXACT PNL LOGIC: Strictly use the numbers you typed in!
            const pnlPercent = guardSnapshot.takeProfitPercent 
                ? guardSnapshot.takeProfitPercent 
                : -Math.abs(guardSnapshot.trailingPercent);
                
            const isProfit = pnlPercent >= 0;
            
            await simExecuteExit(guardSnapshot.telegramId, guardSnapshot.tokenAddress, 100, pnlPercent);
            
            try {
                const user = await prisma.user.findUnique({ where: { telegramId: guardSnapshot.telegramId } });
                const imageBuffer = await generatePnlCard(guardSnapshot.tokenAddress, pnlPercent, user?.referralCode);

                const solPnl = guardSnapshot.amountInSol * Math.abs(pnlPercent / 100);
                
                // NO "Simulated" text anywhere!
                const pnlMessage = isProfit
                    ? `💰 <b>Net Profit: +${solPnl.toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
                    : `🩸 <b>Incurred Loss: -${solPnl.toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;
                
                const captionText = `${isProfit ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'} 🎮\n\n` +
                            `Token: <code>${guardSnapshot.tokenAddress.substring(0,8)}...</code>\n` +
                            `${!isProfit ? `📉 <b>Peak Drop: -${guardSnapshot.trailingPercent.toFixed(1)}%</b>\n` : ''}` +
                            `${pnlMessage}\n` +
                            `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
                            `🔗 <a href="https://solscan.io/tx/${generateSimSignature()}">View on Solscan</a>`;
                
                // @ts-ignore
                const fetch = (await import('node-fetch')).default;
                // @ts-ignore
                const FormData = (await import('form-data')).default;
                
                const form = new FormData();
                form.append('chat_id', guardSnapshot.telegramId);
                form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
                form.append('caption', captionText);
                form.append('parse_mode', 'HTML');
                
                await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
                
                await cancelAllGuardsForToken(guardSnapshot.telegramId, guardSnapshot.tokenAddress);
            } catch (_) {}
            lockedGuards.delete(guardSnapshot.id);
        }
        return; 
    }
    // --- END SIMULATION INTERCEPT ---

    if (lockedGuards.has(guardSnapshot.id)) return;

    let guard = guardSnapshot;
    if (guardSnapshot.entryPrice === 0) {
        const fresh = await fetchFreshGuard(guardSnapshot.id);
        if (!fresh) return;
        guard = fresh;
    }

    if (lockedGuards.has(guard.id)) return;

    if (guard.entryPrice === 0 && currentPriceNative > 0) {
        guard.entryPrice = currentPriceNative;
        updateEntryPrice(guard.id, currentPriceNative).catch(() => {});
    }
    const entryPrice = guard.entryPrice || currentPriceNative;

    if (entryPrice > 0) {
        const currentProfitPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;
        if (currentProfitPercent >= 50.0) {
            const minSafePrice = entryPrice * 1.05; 
            const maxDropAllowed = ((currentPriceNative - minSafePrice) / currentPriceNative) * 100;
            if (guard.trailingPercent > maxDropAllowed && maxDropAllowed > 0) {
                guard.trailingPercent = maxDropAllowed; 
            }
        }
    }

    if (guard.takeProfitPercent && entryPrice > 0) {
        const profitPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;

        if (profitPercent >= guard.takeProfitPercent) {
            lockedGuards.add(guard.id);

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    lockedGuards.delete(guard.id);

                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);
                        
                        try {
                            const user = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const multiplier = user?.activeWallets || 1;
                            const profitSol  = (guard.amountInSol * (profitPercent / 100)) * multiplier;
                            const captionText =
                                `🎯 <b>TAKE PROFIT TRIGGERED!</b>\n\n` +
                                `Token: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n` +
                                `💰 <b>Net Profit: +${profitSol.toFixed(4)} SOL</b> (+${profitPercent.toFixed(1)}%)\n` +
                                `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
                                `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                            try {
                                const imageBuffer = await generatePnlCard(guard.tokenAddress, profitPercent, user?.referralCode);
                                const tweetText = encodeURIComponent(
                                    `Just secured +${profitPercent.toFixed(1)}% on ${guard.tokenAddress.substring(0, 8)} using Sentry Terminal ⚡\n\n` +
                                    `100% MEV Protected & Lightning Fast.\n\n` +
                                    `Copy my trades: https://t.me/${bot.botInfo?.username || 'SentryBot'}?start=${user?.referralCode}`
                                );
                                const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X (Twitter)', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };
                                
                                await bot.telegram.sendPhoto(
                                    guard.telegramId,
                                    { source: imageBuffer },
                                    { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
                                );

                                const whaleChannelId = process.env.WHALE_ALERT_CHANNEL_ID;
                                if (whaleChannelId && profitPercent > 0) {
                                    const botUsername = bot.botInfo?.username || 'lightningsnipe_bot';
                                    await bot.telegram.sendPhoto(
                                        whaleChannelId,
                                        { source: imageBuffer },
                                        {
                                            caption:
                                                `🔥 <b>SENTRY TERMINAL PROFIT ALERT</b>\n\n` +
                                                `A trader just secured gains using Jito MEV protection.\n\n` +
                                                `👉 Copy their strategy: https://t.me/${botUsername}`,
                                            parse_mode: 'HTML'
                                        }
                                    ).catch(() => null);
                                }

                            } catch (_) {
                                await bot.telegram.sendMessage(guard.telegramId, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                            }
                        } catch (_) {}
                    }
                } else {
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                }
            }).catch((e: any) => console.error("🔴 TP Execution Error:", e.message));

            return; 
        }
    }

    if (guard.highestSeenPrice === 0 || currentPriceNative > guard.highestSeenPrice) {
        updateHighestSeen(guard.id, currentPriceNative).catch(() => {});
    } else {
        const dropPercent = ((guard.highestSeenPrice - currentPriceNative) / guard.highestSeenPrice) * 100;

        if (dropPercent >= guard.trailingPercent) {
            lockedGuards.add(guard.id);

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    lockedGuards.delete(guard.id);

                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);

                        try {
                            const user          = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const multiplier    = user?.activeWallets || 1;
                            const totalPnlPercent = entryPrice > 0 ? ((currentPriceNative - entryPrice) / entryPrice) * 100 : 0;
                            const pnlSol        = (guard.amountInSol * (Math.abs(totalPnlPercent) / 100)) * multiplier;

                            const pnlMessage = totalPnlPercent >= 0
                                ? `💰 <b>Net Profit: +${pnlSol.toFixed(4)} SOL</b> (+${totalPnlPercent.toFixed(1)}%)`
                                : `🩸 <b>Incurred Loss: -${pnlSol.toFixed(4)} SOL</b> (${totalPnlPercent.toFixed(1)}%)`;

                            const captionText =
                                `🚨 <b>TRAILING GUARD TRIGGERED!</b>\n\n` +
                                `Token: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n` +
                                `📉 <b>Peak Drop: -${dropPercent.toFixed(1)}%</b>\n` +
                                `${pnlMessage}\n` +
                                `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
                                `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                            try {
                                const imageBuffer = await generatePnlCard(guard.tokenAddress, totalPnlPercent, user?.referralCode);
                                const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share Guard to X (Twitter)', url: `https://twitter.com/intent/tweet?text=Sentry%20Terminal` }]] };
                                
                                await bot.telegram.sendPhoto(
                                    guard.telegramId,
                                    { source: imageBuffer },
                                    { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
                                );

                                const whaleChannelId = process.env.WHALE_ALERT_CHANNEL_ID;
                                if (whaleChannelId && totalPnlPercent > 0) {
                                    const botUsername = bot.botInfo?.username || 'lightningsnipe_bot';
                                    await bot.telegram.sendPhoto(
                                        whaleChannelId,
                                        { source: imageBuffer },
                                        {
                                            caption:
                                                `🔥 <b>SENTRY TERMINAL PROFIT ALERT</b>\n\n` +
                                                `A trader just secured gains using Jito MEV protection.\n\n` +
                                                `👉 Copy their strategy: https://t.me/${botUsername}`,
                                            parse_mode: 'HTML'
                                        }
                                    ).catch(() => null);
                                }

                            } catch (_) {
                                await bot.telegram.sendMessage(guard.telegramId, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                            }
                        } catch (_) {}
                    }
                } else {
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                }
            }).catch((e: any) => console.error("🔴 SL Execution Error:", e.message));
        }
    }
}

export function startUniversalGuardPoller(bot: any) {
    console.log("🛡️ [GUARD ENGINE] Instant Pre-Signed RAM-Cached Poller Initialized.");

    setInterval(async () => {
        if (isPolling) return;
        isPolling = true;

        try {
            const activeGuards      = [...cachedActiveGuards];
            const activeLimitOrders = [...cachedLimitOrders];
            const currentCurvePdas  = new Set<string>();

            if (activeGuards.length === 0 && activeLimitOrders.length === 0) {
                globalCurvePdas = currentCurvePdas; 
                return;
            }

            const uniqueMints = [...new Set([
                ...activeGuards.map(g => g.tokenAddress),
                ...activeLimitOrders.map(l => l.tokenAddress)
            ])];

            const livePricesNative: Record<string, { price: number }> = {};
            const chunks: string[] = [];
            for (let i = 0; i < uniqueMints.length; i += 100) {
                chunks.push(uniqueMints.slice(i, i + 100).join(','));
            }

            await Promise.all(chunks.map(async (chunk) => {
                try {
                    const res = await axios.get(
                        `https://lite-api.jup.ag/price/v2?ids=${chunk}&vsToken=${WSOL_MINT}`,
                        { timeout: 2000 }
                    );
                    if (res.data?.data) {
                        for (const [mint, info] of Object.entries(res.data.data as Record<string, any>)) {
                            livePricesNative[mint] = { price: parseFloat((info as any).price) || 0 };
                        }
                    }
                } catch (_) {}
            }));

            const zeroMints = uniqueMints.filter(m => !livePricesNative[m] || livePricesNative[m].price === 0);
            if (zeroMints.length > 0) {
                try {
                    const chunksOfThirty: string[][] = [];
                    for (let i = 0; i < zeroMints.length; i += 30) {
                        chunksOfThirty.push(zeroMints.slice(i, i + 30));
                    }
                    await Promise.all(chunksOfThirty.map(async (chunkArr) => {
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunkArr.join(',')}`, { timeout: 1500 });
                        dexRes.data?.pairs?.forEach((pair: any) => {
                            const mint = pair.baseToken.address;
                            if (!livePricesNative[mint] || livePricesNative[mint].price === 0) {
                                const solPrice = parseFloat(pair.priceNative || '0');
                                if (solPrice > 0) livePricesNative[mint] = { price: solPrice };
                            }
                        });
                    }));
                } catch (_) {}
            }

            const assumedSolUsdPrice = cachedSolUsdPrice;

            for (const limit of activeLimitOrders) {
                if (lockedLimitOrders.has(limit.id)) continue;

                let currentPriceNative = 0;
                const isPump = limit.tokenAddress.toLowerCase().endsWith("pump");

                if (isPump) {
                    try {
                        const curvePda = getBondingCurveAddress(limit.tokenAddress);
                        const accInfo  = await connection.getAccountInfo(new PublicKey(curvePda)).catch(() => null);
                        if (accInfo?.data) {
                            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                            if (!isBondingCurveGraduated(buf)) {
                                currentPriceNative = decodePumpCurvePrice(buf.toString('base64'));
                            }
                        }
                    } catch (_) {}
                    if (currentPriceNative === 0) {
                        currentPriceNative = livePricesNative[limit.tokenAddress]?.price || 0;
                    }
                } else {
                    currentPriceNative = livePricesNative[limit.tokenAddress]?.price || 0;
                }

                if (currentPriceNative <= 0 || !limit.targetPriceUsd) continue;

                const currentPriceUsd = currentPriceNative * assumedSolUsdPrice;

                if (limit.orderType === 'ALERT') {
                    if (currentPriceUsd >= limit.targetPriceUsd) {
                        lockedLimitOrders.add(limit.id);
                        await prisma.activeOrder.update({ where: { id: limit.id }, data: { isActive: false } });
                        try {
                            await bot.telegram.sendMessage(
                                limit.user.telegramId,
                                `🔔 <b>PRICE ALERT TRIGGERED!</b>\n\n` +
                                `Token: <code>${limit.tokenAddress}</code>\n` +
                                `Your target of <b>$${limit.targetPriceUsd}</b> has been reached.\n` +
                                `Current price: <b>$${currentPriceUsd.toFixed(6)}</b>\n\n` +
                                `<i>Reply with the CA to buy now.</i>`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) {}
                        lockedLimitOrders.delete(limit.id);
                    }
                } else {
                    if (currentPriceUsd <= limit.targetPriceUsd) {
                        lockedLimitOrders.add(limit.id);
                        await prisma.activeOrder.update({ where: { id: limit.id }, data: { isActive: false } });

                        executeSnipe(limit.user.telegramId, limit.tokenAddress, limit.amountSol).then(async (result) => {
                            if (result.success) {
                                try {
                                    await bot.telegram.sendMessage(
                                        limit.user.telegramId,
                                        `🎯 <b>LIMIT ORDER EXECUTED!</b>\n\n` +
                                        `Token: <code>${limit.tokenAddress.substring(0, 8)}...</code>\n` +
                                        `Target Met: <b>$${currentPriceUsd.toFixed(6)}</b>\n` +
                                        `Invested: <b>${limit.amountSol} SOL</b>\n\n` +
                                        `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                                        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                    );
                                } catch (_) {}
                            } else {
                                try {
                                    await bot.telegram.sendMessage(
                                        limit.user.telegramId,
                                        `🔴 <b>LIMIT ORDER FAILED</b>\nToken: <code>${limit.tokenAddress}</code>\n${result.message}`,
                                        { parse_mode: 'HTML' }
                                    );
                                } catch (_) {}
                            }
                            lockedLimitOrders.delete(limit.id);
                        }).catch(() => lockedLimitOrders.delete(limit.id));
                    }
                }
            }

            const pendingRpcGuards: Array<{ guard: TrailingOrder; curvePda: string }> = [];

            await Promise.all(activeGuards.map(async (guard) => {
                if (lockedGuards.has(guard.id)) return;

                // --- 🎮 SIMULATION INTERCEPT ---
                const { isSimulationActive } = await import('./simulation.service.js');
                if (await isSimulationActive(guard.telegramId)) {
                    await checkAndTriggerGuard(guard, 0, bot);
                    return;
                }
                // --- END SIMULATION INTERCEPT ---

                const isPump = guard.tokenAddress.toLowerCase().endsWith("pump");

                if (isPump) {
                    const curvePda = getBondingCurveAddress(guard.tokenAddress);
                    currentCurvePdas.add(curvePda);

                    if (!activeSubscriptions.has(curvePda)) {
                        const guardIdSnapshot = guard.id;

                        const subId = connection.onAccountChange(new PublicKey(curvePda), async (accInfo) => {
                            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);

                            if (isBondingCurveGraduated(buf)) {
                                const freshSnapshot = cachedActiveGuards.find(g => g.id === guardIdSnapshot);
                                if (freshSnapshot) {
                                    const jupPrice = livePricesNative[freshSnapshot.tokenAddress]?.price;
                                    if (jupPrice && jupPrice > 0) {
                                        await checkAndTriggerGuard(freshSnapshot, jupPrice, bot);
                                    } else {
                                        try {
                                            const res = await axios.get(
                                                `https://lite-api.jup.ag/price/v2?ids=${freshSnapshot.tokenAddress}&vsToken=${WSOL_MINT}`,
                                                { timeout: 3000 }
                                            );
                                            const p = parseFloat(res.data?.data?.[freshSnapshot.tokenAddress]?.price);
                                            if (p > 0) await checkAndTriggerGuard(freshSnapshot, p, bot);
                                        } catch (_) {}
                                    }
                                }
                                return;
                            }

                            const priceInSol = decodePumpCurvePrice(buf.toString('base64'));
                            if (priceInSol <= 0) return;
                            const freshSnapshot = cachedActiveGuards.find(g => g.id === guardIdSnapshot);
                            if (freshSnapshot) await checkAndTriggerGuard(freshSnapshot, priceInSol, bot);
                        }, 'processed');

                        activeSubscriptions.set(curvePda, subId);
                        pendingRpcGuards.push({ guard, curvePda });
                    } else {
                        const jupPrice = livePricesNative[guard.tokenAddress]?.price;
                        if (jupPrice && jupPrice > 0) {
                            await checkAndTriggerGuard(guard, jupPrice, bot);
                        }
                    }
                } else {
                    const jupPrice = livePricesNative[guard.tokenAddress]?.price;
                    if (jupPrice && jupPrice > 0) {
                        await checkAndTriggerGuard(guard, jupPrice, bot);
                    }
                }
            }));

            globalCurvePdas = currentCurvePdas; 

            if (pendingRpcGuards.length > 0) {
                Promise.all(
                    pendingRpcGuards.map(async ({ guard, curvePda }) => {
                        try {
                            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                            if (accInfo?.data) {
                                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                                if (isBondingCurveGraduated(buf)) {
                                    const jupPrice = livePricesNative[guard.tokenAddress]?.price;
                                    if (jupPrice && jupPrice > 0) await checkAndTriggerGuard(guard, jupPrice, bot);
                                } else {
                                    const priceInSol = decodePumpCurvePrice(buf.toString('base64'));
                                    if (priceInSol > 0) await checkAndTriggerGuard(guard, priceInSol, bot);
                                }
                            }
                        } catch (_) {}
                    })
                ).catch(() => {});
            }

        } catch (_) {
        } finally {
            isPolling = false;
        }
    }, 1000); 
}

async function triggerAutoSnipes(
    bot: any,
    mintCa: string,
    symbol: string,
    initialBuySol: number,
    mode: 'PUMP' | 'RAYDIUM',
    raydiumPoolId?: string
) {
    const activeSnipers = [...cachedActiveSnipers];
    if (activeSnipers.length === 0) return;

    for (const sniper of activeSnipers) {
        if (!sniper.user.vaultAddress) continue;

        const delayMs = (sniper.snipeDelaySeconds ?? 0) * 1000;
        setTimeout(async () => {
            try {
                const liveConfig = cachedActiveSnipers.find(s => s.id === sniper.id);
                if (!liveConfig || !liveConfig.isActive) return;

                if (liveConfig.sniperMode !== mode && liveConfig.sniperMode !== 'BOTH') return;

                if (mode === 'PUMP' && liveConfig.antiDeadCoin && initialBuySol === 0) return;

                if (mode === 'PUMP' && initialBuySol > 0 && liveConfig.maxDevBuyPercent > 0) {
                    try {
                        const curvePda = getBondingCurveAddress(mintCa);
                        const accInfo  = await connection.getAccountInfo(new PublicKey(curvePda));
                        if (accInfo?.data) {
                            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                            const virtualTokenReserves = Number(buf.readBigUInt64LE(8));
                            const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                            const totalAmountToSell = 1_000_000_000.0; 

                            const devTokensBought = (initialBuySol * virtualTokenReserves) / (virtualSolReserves + initialBuySol);
                            const devPercentage   = (devTokensBought / totalAmountToSell) * 100;
                            if (devPercentage > liveConfig.maxDevBuyPercent) return;
                        }
                    } catch (_) {}
                }

                if (mode === 'PUMP') {
                    try {
                        const curvePda = getBondingCurveAddress(mintCa);
                        const accInfo  = await connection.getAccountInfo(new PublicKey(curvePda));
                        if (accInfo?.data) {
                            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                            const priceInSol = decodePumpCurvePrice(buf.toString('base64'));
                            const currentMc  = (priceInSol * 1_000_000_000) * cachedSolUsdPrice;
                            if (currentMc > liveConfig.maxMarketCap || currentMc < liveConfig.minMarketCap) return;
                        }
                    } catch (_) {}
                }

                if (liveConfig.requireSocials) {
                    let hasSocials = false;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintCa}`, { timeout: 2000 });
                            const pairs = dexRes.data?.pairs || [];
                            hasSocials = pairs.some((p: any) => p.info?.socials && p.info.socials.length > 0);
                            if (hasSocials) break;
                        } catch (e: any) {
                            console.warn(`⚠️ [AUTO-SNIPE] Profile Timeout on ${mintCa} (Attempt ${attempt + 1}): ${e.message}`);
                        }
                        if (!hasSocials && attempt < 2) await new Promise(r => setTimeout(r, 2000));
                    }
                    
                    if (!hasSocials) {
                        console.warn(`⚠️ [AUTO-SNIPE] Social Check Failed for ${mintCa}. Safety shields bypassed purchase.`);
                        return; 
                    }
                }

                const intendedSpend = liveConfig.amountSol * liveConfig.user.activeWallets;
                if (liveConfig.maxBudgetSol && (liveConfig.totalSpentSol + intendedSpend) > liveConfig.maxBudgetSol) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    try {
                        await bot.telegram.sendMessage(
                            liveConfig.user.telegramId,
                            `✅ <b>AUTO-SNIPER COMPLETE: Max Budget Reached</b>\n\n` +
                            `Your sniper has spent a total of <b>${liveConfig.totalSpentSol.toFixed(4)} SOL</b> and has automatically powered down.`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (_) {}
                    return;
                }

                if (!isPriceReady) await new Promise(r => setTimeout(r, 1000)); 

                const sniperLockKey = `lock:autosnipe:${liveConfig.id}:${mintCa}`;
                const isSnipeLocked = await redis.set(sniperLockKey, '1', 'EX', 86400, 'NX');
                if (!isSnipeLocked) return;

                const result = await executeSnipe(
                    liveConfig.user.telegramId,
                    mintCa,
                    liveConfig.amountSol,
                    'buy',
                    undefined,
                    false,
                    raydiumPoolId
                );

                if (result.success) {
                    const spent = result.volumeSpent || intendedSpend;
                    await prisma.autoSnipeConfig.update({
                        where: { id: liveConfig.id },
                        data:  { totalSpentSol: { increment: spent } }
                    });

                    const entryPrice = await fetchLiveEntryPrice(mintCa);
                    await addTrailingStopToMemory(
                        liveConfig.user.telegramId,
                        mintCa,
                        liveConfig.autoTrailingDropPercent,
                        liveConfig.amountSol,
                        entryPrice,
                        liveConfig.autoTakeProfitPercent || undefined
                    );

                    try {
                        const modeText = mode === 'PUMP' ? "Trench Sniper (Pump.fun)" : "Raydium LP Sniper";
                        await bot.telegram.sendMessage(
                            liveConfig.user.telegramId,
                            `🎯 <b>AUTO-SNIPE SUCCESSFUL!</b>\n\n` +
                            `<b>Engine:</b> ${modeText}\n` +
                            `<b>Token:</b> <code>${mintCa}</code>\n` +
                            `<b>Invested:</b> <b>${spent.toFixed(4)} SOL</b>\n\n` +
                            `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                        );
                    } catch (_) {}

                } else {
                    if (
                        result.message.includes("Insufficient Funds") ||
                        result.message.includes("Custom\":1") ||
                        result.message.includes("InsufficientFundsForRent")
                    ) {
                        await prisma.autoSnipeConfig.update({ where: { id: sniper.id }, data: { isActive: false } });
                        try {
                            await bot.telegram.sendMessage(
                                sniper.user.telegramId,
                                `🛑 <b>AUTO-SNIPER DISABLED</b>\n\nYour wallet is out of SOL. Auto-Sniper paused.`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        }, delayMs);
    }
}

let isWsConnecting = false;

function connectPumpPortalStream(bot: any) {
    if (isWsConnecting) return;
    isWsConnecting = true;

    const ws = new WebSocket('wss://pumpportal.fun/api/data', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://pumpportal.fun' }
    });

    ws.on('open', () => {
        isWsConnecting = false;
        console.log("🎯 [SNIPER] Connected to PumpPortal new-mint stream!");
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', async (data: WebSocket.RawData) => {
        try {
            const parsed = JSON.parse(data.toString());
            if (parsed.mint && !recentlySnipedTokens.has(parsed.mint)) {
                if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                recentlySnipedTokens.add(parsed.mint);
                setTimeout(() => recentlySnipedTokens.delete(parsed.mint), 60_000);
                
                scoreTokens().catch(() => {});

                const devInitialBuySol = parsed.initialBuy || 0;
                await triggerAutoSnipes(bot, parsed.mint, parsed.symbol || "UNKNOWN", devInitialBuySol, 'PUMP');
            }
        } catch (_) {}
    });

    ws.on('error', () => {});
    ws.on('close', () => {
        isWsConnecting = false;
        setTimeout(() => connectPumpPortalStream(bot), 5_000);
    });
}

function connectRaydiumFallbackWatcher(bot: any) {
    if (raydiumWsFallbackStarted) return;
    raydiumWsFallbackStarted = true;

    const RAYDIUM_PUBLIC_KEY = new PublicKey(RAYDIUM_AMM_PROGRAM);

    connection.onLogs(RAYDIUM_PUBLIC_KEY, async (logs) => {
        if (logs.err) return;
        if (!logs.logs.some((l: string) => l.includes("initialize2"))) return;

        try {
            const tx = await connection.getParsedTransaction(logs.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            }).catch(() => null);

            if (!tx?.meta) return;

            const tokenMint = tx.meta.postTokenBalances?.find(
                (b: any) => b.mint !== WSOL_MINT
            )?.mint;

            if (tokenMint && !recentlySnipedTokens.has(tokenMint)) {
                if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                recentlySnipedTokens.add(tokenMint);
                setTimeout(() => recentlySnipedTokens.delete(tokenMint), 60_000);

                const { extractPoolIdFromTx } = await import('./raydium.service.js');
                const poolId = await extractPoolIdFromTx(logs.signature);

                console.log(`🧪 [RAYDIUM WS FALLBACK] New Pool: ${tokenMint} (Pool ID: ${poolId})`);
                await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM', poolId || undefined);
            }
        } catch (_) {}
    }, 'confirmed');

    console.log("🟡 [RAYDIUM] WebSocket fallback watcher armed (free-tier compatible).");
}

export async function igniteYellowstoneStream(bot: any) {
    if (!pollerStarted) {
        connectPumpPortalStream(bot);
        startUniversalGuardPoller(bot);
        pollerStarted = true;
        console.log("🟢 [SNIPER] PumpPortal WebSocket stream active.");
    }

    if (process.env.DISABLE_GRPC === 'true') {
        console.log("🟡 [gRPC] DISABLE_GRPC=true — Yellowstone skipped. Raydium WS fallback armed.");
        connectRaydiumFallbackWatcher(bot);
        return;
    }

    if (!HELIUS_KEY || isGrpcDisabled) {
        connectRaydiumFallbackWatcher(bot);
        return;
    }

    try {
        const GrpcClient = (Client as any).default || Client;
        const client     = new (GrpcClient as any)(GRPC_URL, HELIUS_KEY, {});
        const stream     = await client.subscribe();

        stream.on("data", async (data: any) => {
            if (!data.transaction?.transaction) return;
            try {
                const tx   = data.transaction.transaction;
                const logs = tx.meta?.logMessages || [];

                if (logs.some((log: string) => log.includes("Program log: Instruction: Create"))) {
                    const accountKeys = tx.transaction.message.accountKeys.map(
                        (k: any) => bs58.encode(Buffer.from(k))
                    );
                    const newCoinCA = accountKeys[2];
                    if (newCoinCA && !recentlySnipedTokens.has(newCoinCA)) {
                        if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                        recentlySnipedTokens.add(newCoinCA);
                        setTimeout(() => recentlySnipedTokens.delete(newCoinCA), 60_000);
    
                        await triggerAutoSnipes(bot, newCoinCA, "UNKNOWN", 0, 'PUMP');
                    }
                }

                if (logs.some((log: string) => log.includes("initialize2"))) {
                    const postBalances = tx.meta?.postTokenBalances || [];
                    const tokenMint    = postBalances.find(
                        (b: any) => b.mint !== WSOL_MINT
                    )?.mint;

                    if (tokenMint && !recentlySnipedTokens.has(tokenMint)) {
                        if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                        recentlySnipedTokens.add(tokenMint);
                        setTimeout(() => recentlySnipedTokens.delete(tokenMint), 60_000);
                        
                        let poolId: string | undefined = undefined;
                        try {
                            const accountKeys = tx.transaction.message.accountKeys.map(
                                (k: any) => bs58.encode(Buffer.from(k))
                            );
                            if (accountKeys.length > 4) {
                                poolId = accountKeys[4];
                            }
                        } catch (_) {}

                        console.log(`🧪 [RAYDIUM gRPC] New Pool: ${tokenMint} (Pool ID: ${poolId})`);
                        await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM', poolId || undefined);
                    }
                }
            } catch (_) {}
        });

        stream.on("error", (err: any) => {
            if (
                err.message.includes("401") ||
                err.message.includes("UNAUTHENTICATED") ||
                err.message.includes("Free Tier") ||
                err.message.includes("403")
            ) {
                console.warn("🟡 [HELIUS PAYWALL] Free tier — gRPC disabled. Arming Raydium WS fallback.");
                isGrpcDisabled = true;
                stream.destroy();
                connectRaydiumFallbackWatcher(bot);
                return;
            }

            if (err.message.includes("EADDRNOTAVAIL")) {
                stream.destroy();
                setTimeout(() => igniteYellowstoneStream(bot), 3_000);
                return;
            }

            console.error(`🔴 [gRPC Error]: ${err.message}. Reconnecting in 3 s...`);
            stream.destroy();
            setTimeout(() => igniteYellowstoneStream(bot), 3_000);
        });

        stream.on("end", () => {
            if (isGrpcDisabled) return;
            setTimeout(() => igniteYellowstoneStream(bot), 3_000);
        });

        const request = {
            accounts: {},
            slots: {},
            transactions: {
                pumpfun: { accountInclude: [PUMP_FUN_PROGRAM],    accountExclude: [], accountRequired: [] },
                raydium: { accountInclude: [RAYDIUM_AMM_PROGRAM], accountExclude: [], accountRequired: [] }
            },
            transactionsStatus: {},
            blocks: {},
            blocksMeta: {},
            entry: {},
            commitment: 1,
            accountsDataSlice: []
        };

        stream.write(request);
        console.log("🟢 [gRPC] Yellowstone stream connected — Pump.fun + Raydium enabled.");

    } catch (e: any) {
        if (!isGrpcDisabled) {
            setTimeout(() => igniteYellowstoneStream(bot), 5_000);
        }
    }
}