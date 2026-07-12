// src/services/grpc.service.ts
import Client from '@triton-one/yellowstone-grpc';
import { executeSnipe, executeExit, generatePreSignedExitTx, sendToJitoBundle, getCachedTokenPrice } from './engine.service.js';
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
import crypto from 'crypto';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import FormData from 'form-data'; 

dotenv.config();
const prisma = new PrismaClient();
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const GRPC_URL = `https://atlas-mainnet.helius-rpc.com`;
const PUMP_FUN_PROGRAM  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

// 🟢 VERIFIED METEORA PROGRAM IDS
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const METEORA_DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

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

// 🟢 D1 FIX: Live WebSocket In-Memory Ring Buffer for AI Coin Caller
export const recentNewMints: { mint: string, symbol: string, firstSeenAt: number }[] = [];

export function getRecentNewMints() {
    const now = Date.now();
    while(recentNewMints.length > 0 && now - recentNewMints[0].firstSeenAt > 30 * 60 * 1000) {
        recentNewMints.shift(); // Remove mints older than 30 mins
    }
    return [...recentNewMints];
}

function trackNewMint(mint: string, symbol: string = "UNKNOWN") {
    if (!recentlySnipedTokens.has(mint)) {
        recentNewMints.push({ mint, symbol, firstSeenAt: Date.now() });
        if (recentNewMints.length > 300) recentNewMints.shift(); // Keep buffer light
    }
}

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
                const valueToStore = typeof payload === 'string' ? payload : JSON.stringify(payload);
                await redis.set(`presigned_exit:${guard.id}`, valueToStore, 'EX', 10); 
            }
        } catch(e) {}
    }
}, 5_000);

// 🟢 C3 FIX: Prevent WebSocket Memory Leaks
export function releaseGuardSubscription(tokenAddress: string) {
    if (tokenAddress.toLowerCase().endsWith("pump")) {
        const curvePda = getBondingCurveAddress(tokenAddress);
        if (!cachedActiveGuards.some(g => g.tokenAddress === tokenAddress) && !cachedLimitOrders.some(l => l.tokenAddress === tokenAddress)) {
            const subId = activeSubscriptions.get(curvePda);
            if (subId !== undefined) {
                try { connection.removeAccountChangeListener(subId); } catch(e){}
                activeSubscriptions.delete(curvePda);
            }
        }
    }
}

async function sendPriceAlertWithChart(
    telegramId: string, tokenMint: string, symbol: string, currentPrice: number, targetPrice: number, entryPrice: number, bot: any
) {
    try {
        const { fetchDexScreenerCandles } = await import('./price.service.js');
        const { generatePriceAlertChart } = await import('./image.service.js');

        const candles = await fetchDexScreenerCandles(tokenMint);
        const pnlVsEntry = entryPrice > 0 ? (((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2) : null;

        const caption = `🎯 <b>PRICE ALERT TRIGGERED</b>\n\n🪙 Token: <b>${symbol}</b>\n💰 Current: <b>$${currentPrice.toFixed(8)}</b>\n🎯 Your Target: <b>$${targetPrice.toFixed(8)}</b>\n` +
            (pnlVsEntry ? `📈 vs Entry: <b>${parseFloat(pnlVsEntry) >= 0 ? '+' : ''}${pnlVsEntry}%</b>\n` : '') +
            `\n<i>Chart shows last 60 minutes of price action.</i>`;

        const { Markup } = await import('telegraf');
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`⚡ Buy Now`, `quick_buy_${tokenMint}`)],
            [Markup.button.callback(`👀 Add to Watchlist`, `watch_add_${tokenMint}`), Markup.button.callback(`❌ Remove Alert`, `watch_remove_${tokenMint}`)]
        ]);

        if (candles.length > 0) {
            const chartBuffer = await generatePriceAlertChart(symbol, candles, targetPrice, currentPrice);
            await bot.telegram.sendPhoto(telegramId, { source: chartBuffer }, { caption, parse_mode: 'HTML', ...keyboard });
        } else {
            await bot.telegram.sendMessage(telegramId, caption, { parse_mode: 'HTML', ...keyboard });
        }
    } catch (e: any) {
        await bot.telegram.sendMessage(telegramId, `🎯 <b>${symbol}</b> hit your target of $${targetPrice.toFixed(8)}! Current: $${currentPrice.toFixed(8)}`, { parse_mode: 'HTML' });
    }
}

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
        const price = await getCachedTokenPrice(tokenAddress);
        if (price > 0) return price;
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

async function checkAndTriggerGuard(guardSnapshot: TrailingOrder, currentPriceNative: number, bot: any) {

    const { isSimulationActive, generateSimSignature, simExecuteExit, applySimSlippage, getNextSimOutcome } = await import('./simulation.service.js');
    if (await isSimulationActive(guardSnapshot.telegramId)) {
        if (lockedGuards.has(guardSnapshot.id)) return;

        // 🟢 FIX: Track elapsed time so resolution is guaranteed within a realistic window,
        // instead of an infinite flat 50/50 coin flip every poll tick.
        const createdKey = `sim:guard_created:${guardSnapshot.id}`;
        let createdAtStr = await redis.get(createdKey);
        if (!createdAtStr) {
            createdAtStr = Date.now().toString();
            await redis.set(createdKey, createdAtStr, 'EX', 3600);
        }
        const elapsedMs = Date.now() - parseInt(createdAtStr);

        const MIN_DELAY_MS = 3000;   // never resolve before 3 seconds
        const RAMP_WINDOW_MS = 9000; // probability ramps to ~100% by ~12s total

        if (elapsedMs < MIN_DELAY_MS) return;

        const rampProgress = Math.min(1, (elapsedMs - MIN_DELAY_MS) / RAMP_WINDOW_MS);
        const triggerProbability = 0.15 + rampProgress * 0.85; // starts at 15%, climbs to 100%

        if (Math.random() > triggerProbability) return;

        await redis.del(createdKey);
        lockedGuards.add(guardSnapshot.id);

        const isProfit = await getNextSimOutcome(guardSnapshot.telegramId, 'guard');
        const targetPnl = isProfit ? (guardSnapshot.takeProfitPercent || 50) : -Math.abs(guardSnapshot.trailingPercent);
        const pnlPercent = applySimSlippage(targetPnl);

        await simExecuteExit(guardSnapshot.telegramId, guardSnapshot.tokenAddress, 100, pnlPercent);

        try {
            const user = await prisma.user.findUnique({ where: { telegramId: guardSnapshot.telegramId } });
            const imageBuffer = await generatePnlCard(guardSnapshot.tokenAddress, pnlPercent, user?.referralCode ?? undefined);

            const rawSolPnl = guardSnapshot.amountInSol * (pnlPercent / 100);
            const platformFee = (guardSnapshot.amountInSol * (1 + pnlPercent / 100)) * 0.01;
            const jitoTip = 0.0015;
            const solPnl = rawSolPnl - platformFee - jitoTip;

            const imgId = crypto.randomBytes(8).toString('hex');
            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);

            const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
            const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;

            const tweetText = encodeURIComponent(
                `Just secured a verified ${pnlPercent >= 0 ? `gain of +${pnlPercent.toFixed(1)}%` : `loss protection`} on $${guardSnapshot.tokenAddress.substring(0,6).toUpperCase()} using Sentry Terminal ⚡\n\nVerified details: ${shareUrl}`
            );
            const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X (Twitter)', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

            const pnlMessage = pnlPercent >= 0
                ? `💰 <b>Net Profit: +${solPnl.toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
                : `🩸 <b>Incurred Loss: -${Math.abs(solPnl).toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;

            const captionText = `${pnlPercent >= 0 ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'} 🎮\n\nToken: <code>${guardSnapshot.tokenAddress.substring(0,8)}...</code>\n${pnlPercent < 0 ? `📉 <b>Peak Drop: -${guardSnapshot.trailingPercent.toFixed(1)}%</b>\n` : ''}${pnlMessage}\nStatus: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n🔗 <a href="https://solscan.io/tx/${generateSimSignature()}">View on Solscan</a>`;

            const form = new FormData();
            form.append('chat_id', guardSnapshot.telegramId);
            form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
            form.append('caption', captionText);
            form.append('parse_mode', 'HTML');
            form.append('reply_markup', JSON.stringify(twitterBtn));

            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form as any, headers: form.getHeaders() });

            await cancelAllGuardsForToken(guardSnapshot.telegramId, guardSnapshot.tokenAddress);
        } catch (e: any) {}
        setTimeout(() => lockedGuards.delete(guardSnapshot.id), 15_000);
        return;
    }

    // ...rest of the function (live-mode logic) stays exactly as-is below this point

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
            if (guard.trailingPercent > maxDropAllowed && maxDropAllowed > 0) guard.trailingPercent = maxDropAllowed; 
        }
    }

    if (guard.takeProfitPercent && entryPrice > 0) {
        const profitPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;
        if (profitPercent >= guard.takeProfitPercent) {
            lockedGuards.add(guard.id);

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);
                        try {
                            const user = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const multiplier = user?.activeWallets || 1;
                            const profitSol  = (guard.amountInSol * (profitPercent / 100)) * multiplier;
                            
                            const imgId = crypto.randomBytes(8).toString('hex');
                            const imageBuffer = await generatePnlCard(guard.tokenAddress, profitPercent, user?.referralCode ?? undefined);
                            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200); 
                            
                            const tradeStartRaw = await redis.get(`trade_time:${guard.telegramId}:${guard.tokenAddress}`);
                            let timeString = "";
                            if (tradeStartRaw) {
                                const diffMs = Date.now() - parseInt(tradeStartRaw);
                                const mins = Math.floor(diffMs / 60000);
                                const secs = Math.floor((diffMs % 60000) / 1000);
                                timeString = `in ${mins > 0 ? `${mins}m ` : ''}${secs}s`;
                            }

                            const tweetText = encodeURIComponent(`Just exited $${guard.tokenAddress.substring(0,4).toUpperCase()} on Sentry Terminal ⚡\n+${profitPercent.toFixed(1)}% ${timeString}\nJito MEV bundle — zero sandwich attacks\n🔗 solscan.io/tx/${result.signature}\nt.me/${process.env.BOT_USERNAME || 'SentryTerminalBot'}?start=${user?.referralCode || ''}`);
                            const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X (Twitter)', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

                            const captionText = `🎯 <b>TAKE PROFIT TRIGGERED!</b>\n\nToken: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n💰 <b>Net Profit: +${profitSol.toFixed(4)} SOL</b> (+${profitPercent.toFixed(1)}%)\nStatus: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                            const form = new FormData();
                            form.append('chat_id', guard.telegramId);
                            form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
                            form.append('caption', captionText);
                            form.append('parse_mode', 'HTML');
                            form.append('reply_markup', JSON.stringify(twitterBtn));
                            
                            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form as any, headers: form.getHeaders() });
                        } catch (e: any) {}
                    }
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                } else {
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                }
            }).catch(() => {});
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
                    
                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);

                        try {
                            const user          = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const multiplier    = user?.activeWallets || 1;
                            const totalPnlPercent = entryPrice > 0 ? ((currentPriceNative - entryPrice) / entryPrice) * 100 : 0;
                            const pnlSol        = (guard.amountInSol * (Math.abs(totalPnlPercent) / 100)) * multiplier;

                            const imgId = crypto.randomBytes(8).toString('hex');
                            const imageBuffer = await generatePnlCard(guard.tokenAddress, totalPnlPercent, user?.referralCode ?? undefined);
                            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200); 
                            
                            const tradeStartRaw = await redis.get(`trade_time:${guard.telegramId}:${guard.tokenAddress}`);
                            let timeString = "";
                            if (tradeStartRaw) {
                                const diffMs = Date.now() - parseInt(tradeStartRaw);
                                const mins = Math.floor(diffMs / 60000);
                                const secs = Math.floor((diffMs % 60000) / 1000);
                                timeString = `in ${mins > 0 ? `${mins}m ` : ''}${secs}s`;
                            }

                            const tweetText = encodeURIComponent(`Just exited $${guard.tokenAddress.substring(0,4).toUpperCase()} on Sentry Terminal ⚡\n${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(1)}% ${timeString}\nJito MEV bundle — zero sandwich attacks\n🔗 solscan.io/tx/${result.signature}\nt.me/${process.env.BOT_USERNAME || 'SentryTerminalBot'}?start=${user?.referralCode || ''}`);
                            const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share Guard to X (Twitter)', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

                            const pnlMessage = totalPnlPercent >= 0
                                ? `💰 <b>Net Profit: +${pnlSol.toFixed(4)} SOL</b> (+${totalPnlPercent.toFixed(1)}%)`
                                : `🩸 <b>Incurred Loss: -${pnlSol.toFixed(4)} SOL</b> (${totalPnlPercent.toFixed(1)}%)`;

                            const captionText = `🚨 <b>TRAILING GUARD TRIGGERED!</b>\n\nToken: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n📉 <b>Peak Drop: -${dropPercent.toFixed(1)}%</b>\n${pnlMessage}\nStatus: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                            const form = new FormData();
                            form.append('chat_id', guard.telegramId);
                            form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
                            form.append('caption', captionText);
                            form.append('parse_mode', 'HTML');
                            form.append('reply_markup', JSON.stringify(twitterBtn));
                            
                            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form as any, headers: form.getHeaders() });
                        } catch (e: any) {}
                    }
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                } else {
                    setTimeout(() => lockedGuards.delete(guard.id), 15_000);
                }
            }).catch(() => {});
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
                    const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${chunk}&vsToken=${WSOL_MINT}`, { timeout: 2000 });
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
                    for (let i = 0; i < zeroMints.length; i += 30) chunksOfThirty.push(zeroMints.slice(i, i + 30));
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

            await Promise.all(activeLimitOrders.map(async (limit) => {
                if (lockedLimitOrders.has(limit.id)) return;

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
                    if (currentPriceNative === 0) currentPriceNative = livePricesNative[limit.tokenAddress]?.price || 0;
                } else {
                    currentPriceNative = livePricesNative[limit.tokenAddress]?.price || 0;
                }

                if (currentPriceNative <= 0 || !limit.targetPriceUsd) return;

                const currentPriceUsd = currentPriceNative * assumedSolUsdPrice;

                if (limit.orderType === 'ALERT') {
                    if (currentPriceUsd >= limit.targetPriceUsd) {
                        lockedLimitOrders.add(limit.id);
                        await prisma.activeOrder.update({ where: { id: limit.id }, data: { isActive: false } });
                        try {
                            await bot.telegram.sendMessage(limit.user.telegramId,
                                `🔔 <b>PRICE ALERT TRIGGERED!</b>\n\nToken: <code>${limit.tokenAddress}</code>\nYour target of <b>$${limit.targetPriceUsd}</b> has been reached.\nCurrent price: <b>$${currentPriceUsd.toFixed(6)}</b>\n\n<i>Reply with the CA to buy now.</i>`, { parse_mode: 'HTML' }
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
                                try { await bot.telegram.sendMessage(limit.user.telegramId, `🎯 <b>LIMIT ORDER EXECUTED!</b>\n\nToken: <code>${limit.tokenAddress.substring(0, 8)}...</code>\nTarget Met: <b>$${currentPriceUsd.toFixed(6)}</b>\nInvested: <b>${limit.amountSol} SOL</b>\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); } catch (_) {}
                            } else {
                                try { await bot.telegram.sendMessage(limit.user.telegramId, `🔴 <b>LIMIT ORDER FAILED</b>\nToken: <code>${limit.tokenAddress}</code>\n${result.message}`, { parse_mode: 'HTML' }); } catch (_) {}
                            }
                            lockedLimitOrders.delete(limit.id);
                        }).catch(() => lockedLimitOrders.delete(limit.id));
                    }
                }
            }));

            const pendingRpcGuards: Array<{ guard: TrailingOrder; curvePda: string }> = [];

            await Promise.all(activeGuards.map(async (guard) => {
                if (lockedGuards.has(guard.id)) return;

                const { isSimulationActive } = await import('./simulation.service.js');
                if (await isSimulationActive(guard.telegramId)) {
                    await checkAndTriggerGuard(guard, 0, bot);
                    return;
                }

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
                                            const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${freshSnapshot.tokenAddress}&vsToken=${WSOL_MINT}`, { timeout: 3000 });
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

    setInterval(async () => {
        try {
            let cursor = '0';
            const allWatchedMints = new Set<string>();
            const userWatchlists: Record<string, any> = {};

            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'watchlist:*', 'COUNT', 100);
                cursor = nextCursor;
                for (const key of keys) {
                    const tgId = key.split(':')[1];
                    const watchedTokens = await redis.hgetall(key);
                    userWatchlists[tgId] = watchedTokens;
                    Object.keys(watchedTokens).forEach(ca => allWatchedMints.add(ca));
                }
            } while (cursor !== '0');

            if (allWatchedMints.size === 0) return;

            const livePricesNative: Record<string, number> = {};
            const uniqueMints = [...allWatchedMints];
            const assumedSolUsdPrice = cachedSolUsdPrice;
            
            const chunks: string[] = [];
            for (let i = 0; i < uniqueMints.length; i += 100) {
                chunks.push(uniqueMints.slice(i, i + 100).join(','));
            }

            await Promise.all(chunks.map(async (chunk) => {
                try {
                    const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${chunk}&vsToken=${WSOL_MINT}`, { timeout: 3000 });
                    if (res.data?.data) {
                        for (const [mint, info] of Object.entries(res.data.data as Record<string, any>)) {
                            livePricesNative[mint] = parseFloat((info as any).price) || 0;
                        }
                    }
                } catch (_) {}
            }));

            for (const [tgId, watchedTokens] of Object.entries(userWatchlists)) {
                for (const [ca, dataStr] of Object.entries(watchedTokens as Record<string, string>)) {
                    const data = JSON.parse(dataStr);
                    if (data.targetPrice > 0) {
                        const currentPriceNative = livePricesNative[ca] || 0;
                        const currentPriceUsd = currentPriceNative * assumedSolUsdPrice;

                        const cooldownKey = `alert_cooldown:${tgId}:${ca}`;
                        const isOnCooldown = await redis.get(cooldownKey);

                        if (!isOnCooldown && currentPriceUsd > 0 && currentPriceUsd >= data.targetPrice) {
                            await redis.set(cooldownKey, '1', 'EX', 3600); 
                            try {
                                await sendPriceAlertWithChart(tgId, ca, "Watched Token", currentPriceUsd, data.targetPrice, data.addedPrice || 0, bot);
                            } catch (_) {}
                        }
                    }
                }
            }
        } catch (e: any) {
            console.error("⚠️ [WATCHLIST SCAN FAULT]:", e.message);
        }
    }, 10000); 
}

// src/services/grpc.service.ts (Replace this function)

let isWsConnecting = false;
let wsHeartbeat: NodeJS.Timeout | null = null;
let lastMessageAt = Date.now();

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
        
        lastMessageAt = Date.now();
        if (wsHeartbeat) clearInterval(wsHeartbeat);
        
        // 🟢 B.1 FIX: 30-second Proof-of-life heartbeat
        wsHeartbeat = setInterval(() => {
            const secondsSinceLastMsg = Math.floor((Date.now() - lastMessageAt) / 1000);
            console.log(`💓 [PUMP WS] Alive check. Last msg ${secondsSinceLastMsg}s ago. Buffer size: ${recentNewMints.length}`);
            if (Date.now() - lastMessageAt > 90_000) {
                console.warn("⚠️ [PUMP WS] No messages in 90s — forcing reconnect.");
                ws.terminate();
            }
        }, 30_000);
    });

    ws.on('message', async (data: WebSocket.RawData) => {
        lastMessageAt = Date.now();
        try {
            const parsed = JSON.parse(data.toString());
            if (parsed.mint && !recentlySnipedTokens.has(parsed.mint)) {
                if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                recentlySnipedTokens.add(parsed.mint);
                setTimeout(() => recentlySnipedTokens.delete(parsed.mint), 60_000);
                
                trackNewMint(parsed.mint, parsed.symbol); 

                const devInitialBuySol = parsed.initialBuy || 0;
                await triggerAutoSnipes(bot, parsed.mint, parsed.symbol || "UNKNOWN", devInitialBuySol, 'PUMP');
            }
        } catch (_) {}
    });

    ws.on('error', (err: any) => { console.warn(`⚠️ [PUMP WS] Error: ${err.message}`); });
    
    ws.on('close', () => {
        isWsConnecting = false;
        if (wsHeartbeat) clearInterval(wsHeartbeat);
        console.warn("⚠️ [PUMP WS] Dropped. Reconnecting in 30s to avoid 429 IP bans...");
        setTimeout(() => connectPumpPortalStream(bot), 30_000);
    });
}

function connectRaydiumFallbackWatcher(bot: any) {
    if (raydiumWsFallbackStarted) return;
    raydiumWsFallbackStarted = true;

    const RAYDIUM_PUBLIC_KEY = new PublicKey(RAYDIUM_AMM_PROGRAM);

    connection.onLogs(RAYDIUM_PUBLIC_KEY, async (logs) => {
        if (logs.err) return;
        
        if (logs.logs.some((l: string) => l.includes("initialize2"))) {
            try {
                const tx = await connection.getParsedTransaction(logs.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
                if (!tx?.meta) return;

                const tokenMint = tx.meta.postTokenBalances?.find((b: any) => b.mint !== WSOL_MINT)?.mint;

                if (tokenMint && !recentlySnipedTokens.has(tokenMint)) {
                    if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                    recentlySnipedTokens.add(tokenMint);
                    setTimeout(() => recentlySnipedTokens.delete(tokenMint), 60_000);

                    const { extractPoolIdFromTx } = await import('./raydium.service.js');
                    const poolId = await extractPoolIdFromTx(logs.signature);

                    console.log(`🧪 [RAYDIUM WS] New Pool: ${tokenMint} (Pool ID: ${poolId})`);
                    
                    // 🟢 BUG 1 FIX: Actually feed the caller buffer!
                    trackNewMint(tokenMint, "UNKNOWN"); 
                    
                    await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM', poolId || undefined);
                }
            } catch (_) {}
            return;
        }

        if (logs.logs.some((l: string) => l.includes("Instruction: Swap"))) {
            try {
                if (cachedActiveGuards.length > 0 || cachedLimitOrders.length > 0) {
                    if (!isPolling) {
                        isPolling = true;
                        setImmediate(() => { isPolling = false; }); 
                    }
                }
            } catch (_) {}
        }
    }, 'confirmed');

    console.log("🟡 [RAYDIUM] WebSocket push watcher armed for instant execution.");
}

async function triggerAutoSnipes(
    bot: any, mintCa: string, symbol: string, initialBuySol: number, mode: 'PUMP' | 'RAYDIUM', raydiumPoolId?: string
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
                    try {
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintCa}`, { timeout: 1500 });
                        const pairs = dexRes.data?.pairs || [];
                        const hasSocials = pairs.some((p: any) => p.info?.socials && p.info.socials.length > 0);
                        if (!hasSocials) {
                            console.warn(`⚠️ [AUTO-SNIPE] Social Check Failed for ${mintCa}. Shield bypassed purchase.`);
                            return; 
                        }
                    } catch (e: any) {
                        console.warn(`⚠️ [AUTO-SNIPE] Profile API Timeout on ${mintCa}, proceeding aggressively to preserve block priority.`);
                    }
                }

                const intendedSpend = liveConfig.amountSol * liveConfig.user.activeWallets;
                if (liveConfig.maxBudgetSol && (liveConfig.totalSpentSol + intendedSpend) > liveConfig.maxBudgetSol) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    try {
                        await bot.telegram.sendMessage(liveConfig.user.telegramId,
                            `✅ <b>AUTO-SNIPER COMPLETE: Max Budget Reached</b>\n\nYour sniper has spent a total of <b>${liveConfig.totalSpentSol.toFixed(4)} SOL</b> and has automatically powered down.`, { parse_mode: 'HTML' }
                        );
                    } catch (_) {}
                    return;
                }

                if (!isPriceReady) await new Promise(r => setTimeout(r, 1000)); 

                const sniperLockKey = `lock:autosnipe:${liveConfig.id}:${mintCa}`;
                const isSnipeLocked = await redis.set(sniperLockKey, '1', 'EX', 86400, 'NX');
                if (!isSnipeLocked) return;

                const result = await executeSnipe(liveConfig.user.telegramId, mintCa, liveConfig.amountSol, 'buy', undefined, false, raydiumPoolId);

                if (result.success) {
                    const spent = result.volumeSpent || intendedSpend;
                    await prisma.autoSnipeConfig.update({
                        where: { id: liveConfig.id },
                        data:  { totalSpentSol: { increment: spent } }
                    });

                    const entryPrice = await fetchLiveEntryPrice(mintCa);
                    await addTrailingStopToMemory(
                        liveConfig.user.telegramId, mintCa, liveConfig.autoTrailingDropPercent,
                        liveConfig.amountSol, entryPrice, liveConfig.autoTakeProfitPercent || undefined
                    );

                    try {
                        const modeText = mode === 'PUMP' ? "Trench Sniper (Pump.fun)" : "Raydium LP Sniper";
                        await bot.telegram.sendMessage(liveConfig.user.telegramId,
                            `🎯 <b>AUTO-SNIPE SUCCESSFUL!</b>\n\n<b>Engine:</b> ${modeText}\n<b>Token:</b> <code>${mintCa}</code>\n<b>Invested:</b> <b>${spent.toFixed(4)} SOL</b>\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                        );
                    } catch (_) {}

                } else {
                    if (result.message.includes("Insufficient Funds") || result.message.includes("Custom\":1") || result.message.includes("InsufficientFundsForRent")) {
                        await prisma.autoSnipeConfig.update({ where: { id: sniper.id }, data: { isActive: false } });
                        try { await bot.telegram.sendMessage(sniper.user.telegramId, `🛑 <b>AUTO-SNIPER DISABLED</b>\n\nYour wallet is out of SOL. Auto-Sniper paused.`, { parse_mode: 'HTML' }); } catch (_) {}
                    }
                }
            } catch (_) {}
        }, delayMs);
    }
}

// Polling-based pump.fun source — independent of the WebSocket entirely.
// Runs on a plain interval, so even if the WS is banned/dead, this keeps working.
let pollingStarted = false;
function startPumpFunPolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    console.log("🔁 [PUMP POLL] Starting REST polling fallback (10s interval).");

    setInterval(async () => {
        try {
            const res = await axios.get(
                'https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false',
                { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } }
            );
            if (!Array.isArray(res.data)) return;

            let added = 0;
            for (const coin of res.data) {
                if (coin.mint && !recentlySnipedTokens.has(coin.mint)) {
                    trackNewMint(coin.mint, coin.symbol || "UNKNOWN");
                    added++;
                }
            }
            if (added > 0) console.log(`🔁 [PUMP POLL] Added ${added} new mints via REST poll. Buffer size: ${recentNewMints.length}`);
        } catch (e: any) {
            console.warn(`⚠️ [PUMP POLL] Fetch failed: ${e.message}`);
        }
    }, 10_000);
}

export async function igniteYellowstoneStream(bot: any) {
    if (!pollerStarted) {
        connectPumpPortalStream(bot);
        startPumpFunPolling();          // ← ADD THIS LINE
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

                if (logs.some((log: string) => log.includes("Program log: Instruction: Create") || log.includes("initialize2"))) {
                    const postBalances = tx.meta?.postTokenBalances || [];
                    const tokenMint = postBalances.find((b: any) => b.mint !== WSOL_MINT)?.mint;

                    if (tokenMint && !recentlySnipedTokens.has(tokenMint)) {
                        if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                        recentlySnipedTokens.add(tokenMint);
                        setTimeout(() => recentlySnipedTokens.delete(tokenMint), 60_000);
                        
                        console.log(`☄️ [METEORA gRPC] New Meteora Pool Detected: ${tokenMint}`);
                        
                        // 🟢 BUG 2 FIX: Actually feed the caller buffer!
                        trackNewMint(tokenMint, "UNKNOWN"); 
                        
                        await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM');
                    }
                }

                if (logs.some((log: string) => log.includes("Instruction: InitializeCustomizablePermissionlessConstantProductPool") || log.includes("Instruction: InitializeReward") || log.includes("Instruction: InitializePool"))) {
                    const postBalances = tx.meta?.postTokenBalances || [];
                    const tokenMint = postBalances.find((b: any) => b.mint !== WSOL_MINT)?.mint;

                    if (tokenMint && !recentlySnipedTokens.has(tokenMint)) {
                        if (recentlySnipedTokens.size > 500) recentlySnipedTokens.clear();
                        recentlySnipedTokens.add(tokenMint);
                        setTimeout(() => recentlySnipedTokens.delete(tokenMint), 60_000);
                        console.log(`☄️ [METEORA gRPC] New Meteora Pool Detected: ${tokenMint}`);
                        
                        await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM');
                    }
                }
            } catch (_) {}
        });

        stream.on("error", (err: any) => {
            if (err.message.includes("401") || err.message.includes("UNAUTHENTICATED") || err.message.includes("Free Tier") || err.message.includes("403")) {
                console.warn("🟡 [HELIUS PAYWALL] Free tier — gRPC disabled. Arming Raydium WS fallback.");
                isGrpcDisabled = true;
                stream.destroy();
                connectRaydiumFallbackWatcher(bot);
                return;
            }

            if (err.message.includes("EADDRNOTAVAIL")) {
                stream.destroy(); setTimeout(() => igniteYellowstoneStream(bot), 3_000); return;
            }

            stream.destroy(); setTimeout(() => igniteYellowstoneStream(bot), 3_000);
        });

        stream.on("end", () => {
            if (isGrpcDisabled) return;
            setTimeout(() => igniteYellowstoneStream(bot), 3_000);
        });

        const request = {
            accounts: {}, slots: {},
            transactions: {
                pumpfun: { accountInclude: [PUMP_FUN_PROGRAM], accountExclude: [], accountRequired: [] },
                raydium: { accountInclude: [RAYDIUM_AMM_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_dlmm: { accountInclude: [METEORA_DLMM_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_dbc: { accountInclude: [METEORA_DBC_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_damm: { accountInclude: [METEORA_DAMM_V2_PROGRAM], accountExclude: [], accountRequired: [] }
            },
            transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, commitment: 1, accountsDataSlice: []
        };

        stream.write(request);
        console.log("🟢 [gRPC] Yellowstone stream connected — Pump.fun + Raydium + Meteora enabled.");

    } catch (e: any) {
        if (!isGrpcDisabled) setTimeout(() => igniteYellowstoneStream(bot), 5_000);
    }
}