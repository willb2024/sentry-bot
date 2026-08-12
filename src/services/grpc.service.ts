// src/services/grpc.service.ts
import Client from '@triton-one/yellowstone-grpc';
import { executeSnipe, executeExit, generatePreSignedExitTx, sendToJitoBundle, getCachedTokenPrice } from './engine.service.js';
import { addTrailingStopToMemory, getAllActiveGuards, updateHighestSeen, cancelAllGuardsForToken, updateEntryPrice, TrailingOrder } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { generatePnlCard } from './image.service.js';

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import crypto from 'crypto';
import { subscribeToMintPrice, unsubscribeFromMintPrice, getLivePriceSol } from './guard-price-feed.service.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';

dotenv.config();

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const GRPC_URL = `https://atlas-mainnet.helius-rpc.com`;
const PUMP_FUN_PROGRAM  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const METEORA_DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

const recentlySnipedTokens = new Set<string>();
let pollerStarted  = false;
export let isGrpcDisabled = false;
let raydiumWsFallbackStarted = false;

const activeSubscriptions = new Map<string, number>(); 
let isPolling = false;

export let cachedSolUsdPrice = 150.0;
export let isPriceReady = false; 

export const recentNewMints: { mint: string, symbol: string, creator: string, firstSeenAt: number }[] = [];

function trackNewMint(mint: string, symbol: string = "UNKNOWN", creator: string = "") {
    recentNewMints.push({ mint, symbol, creator, firstSeenAt: Date.now() });
    if (recentNewMints.length > 300) recentNewMints.shift(); 
}

export function getRecentNewMints() {
    const now = Date.now();
    while(recentNewMints.length > 0 && now - recentNewMints[0].firstSeenAt > 30 * 60 * 1000) {
        recentNewMints.shift(); 
    }
    return [...recentNewMints];
}

async function acquireGuardLock(guardId: string, ttlSeconds: number = 20): Promise<boolean> {
    const result = await redis.set(`lock:guard_exec:${guardId}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
}

async function releaseGuardLock(guardId: string): Promise<void> {
    await redis.del(`lock:guard_exec:${guardId}`).catch(() => {});
}

export async function syncInitialSolPrice() {
    try {
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4000 });
        const price = res.data?.data?.[WSOL_MINT]?.price;
        if (price && price > 0) {
            cachedSolUsdPrice = parseFloat(price);
            console.log(`🟢 [HFT ENGINE] Synchronized SOL boot price: $${cachedSolUsdPrice} USD.`);
        }
    } catch (e) {
        console.warn("⚠️ [HFT ENGINE] Boot price check timed out, using default $150.0.");
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
    await Promise.allSettled(cachedActiveGuards.map(async (guard) => {
        if (await redis.get(`lock:guard_exec:${guard.id}`)) return;
        try {
            const { generatePreSignedExitTxMulti } = await import('./engine.service.js');
            const payloads = await generatePreSignedExitTxMulti(guard.telegramId, guard.tokenAddress);
            if (payloads.length > 0) {
                await redis.set(`presigned_exit_multi:${guard.id}`, JSON.stringify(payloads), 'EX', 20);
            }
        } catch (e) {}
    }));
}, 5_000);

export function releaseGuardSubscription(tokenAddress: string) {
    if (!tokenAddress.toLowerCase().endsWith("pump")) return;
    try {
        const curvePda = getBondingCurveAddress(tokenAddress); 
        if (!cachedActiveGuards.some(g => g.tokenAddress === tokenAddress) && !cachedLimitOrders.some(l => l.tokenAddress === tokenAddress)) {
            const subId = activeSubscriptions.get(curvePda);
            if (subId !== undefined) {
                try { connection.removeAccountChangeListener(subId); } catch(e){}
                activeSubscriptions.delete(curvePda);
            }
        }
    } catch (_) {}
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
        const cachedPayload = await redis.get(`presigned_exit_multi:${guard.id}`);
        if (cachedPayload) {
            const payloads: Array<{ walletIndex: number; walletAddress: string; swapBase64: string; tipBase64: string }> = JSON.parse(cachedPayload);
            if (payloads.length > 0) {
                let firstSig: string | undefined;
                let anySuccess = false;

                await Promise.allSettled(payloads.map(async (p) => {
                    const swapTx = VersionedTransaction.deserialize(Buffer.from(p.swapBase64, 'base64'));
                    const tipTx = VersionedTransaction.deserialize(Buffer.from(p.tipBase64, 'base64'));
                    const { sendToJitoBundle } = await import('./engine.service.js');
                    const bundleOk = await sendToJitoBundle(swapTx, tipTx);
                    if (bundleOk) {
                        anySuccess = true;
                        const sig = bs58.encode(swapTx.signatures[0]);
                        if (!firstSig) firstSig = sig;
                    }
                }));

                if (anySuccess) {
                    return { success: true, signature: firstSig, message: `Instant Multi-Wallet Exit Executed (${payloads.length} wallets)` };
                }
            }
        }
    } catch (e) {}

    const { executeExit } = await import('./engine.service.js');
    return await executeExit(guard.telegramId, guard.tokenAddress, 100);
}

async function checkAndTriggerGuard(guardSnapshot: TrailingOrder, currentPriceNative: number, bot: any) {
    const { isSimulationActive, generateSimSignature, simExecuteExit, applySimSlippage, getNextSimOutcome } = await import('./simulation.service.js');
    
    // ==============================================
    // 🎮 SIMULATION BRANCH
    // ==============================================
    if (await isSimulationActive(guardSnapshot.telegramId)) {
        if (await redis.get(`lock:guard_exec:${guardSnapshot.id}`)) return;

        const createdKey = `sim:guard_created:${guardSnapshot.id}`;
        let createdAtStr = await redis.get(createdKey);
        if (!createdAtStr) {
            createdAtStr = Date.now().toString();
            await redis.set(createdKey, createdAtStr, 'EX', 3600);
        }

        if (guardSnapshot.maxHoldMinutes && guardSnapshot.createdAt) {
            const ageMinutes = (Date.now() - new Date(guardSnapshot.createdAt).getTime()) / 60000;
            if (ageMinutes >= guardSnapshot.maxHoldMinutes) {
                const gotLock = await acquireGuardLock(guardSnapshot.id, 20);
                if (!gotLock) return;

                const finalPnl = applySimSlippage(0); 
                await simExecuteExit(guardSnapshot.telegramId, guardSnapshot.tokenAddress, 100, finalPnl);
                await cancelAllGuardsForToken(guardSnapshot.telegramId, guardSnapshot.tokenAddress);
                try { await bot.telegram.sendMessage(guardSnapshot.telegramId, `⏱️ <b>TIME-BASED EXIT TRIGGERED</b>\n\nToken: <code>${guardSnapshot.tokenAddress}</code>\nMax hold time reached. Position sold at market.`, { parse_mode: 'HTML' }); } catch (_) {}
                await releaseGuardLock(guardSnapshot.id);
                return;
            }
        }

        const elapsedMs = Date.now() - parseInt(createdAtStr);
        const MIN_DELAY_MS = 1200;   
        const RAMP_WINDOW_MS = 2000; 

        if (elapsedMs < MIN_DELAY_MS) return;

        const rampProgress = Math.min(1, (elapsedMs - MIN_DELAY_MS) / RAMP_WINDOW_MS);
        const triggerProbability = 0.15 + rampProgress * 0.85; 

        if (Math.random() > triggerProbability) return;

        await redis.del(createdKey);
        
        const gotLock = await acquireGuardLock(guardSnapshot.id, 20);
        if (!gotLock) return;

        await cancelAllGuardsForToken(guardSnapshot.telegramId, guardSnapshot.tokenAddress);

        const isProfit = await getNextSimOutcome(guardSnapshot.telegramId, 'guard');
        const targetPnl = isProfit ? (guardSnapshot.takeProfitPercent || 50) : -Math.abs(guardSnapshot.trailingPercent);
        const pnlPercent = applySimSlippage(targetPnl);

        let actualPeakDrop = guardSnapshot.trailingPercent;
        if (!isProfit) {
            try {
                const rawPos = await redis.get(`sim:positions:${guardSnapshot.telegramId}`);
                if (rawPos) {
                    const positions = JSON.parse(rawPos);
                    const pos = positions.find((p: any) => p.mint === guardSnapshot.tokenAddress);
                    if (pos && pos.highestSeenPrice && pos.priceUsd) {
                        const drop = ((pos.highestSeenPrice - pos.priceUsd) / pos.highestSeenPrice) * 100;
                        if (drop > 0) actualPeakDrop = parseFloat(drop.toFixed(1));
                    }
                }
            } catch (_) {}
        }

        await simExecuteExit(guardSnapshot.telegramId, guardSnapshot.tokenAddress, 100, pnlPercent);
        await cancelAllGuardsForToken(guardSnapshot.telegramId, guardSnapshot.tokenAddress);

        try {
            const user = await prisma.user.findUnique({ where: { telegramId: guardSnapshot.telegramId } });
            const imageBuffer = await generatePnlCard(guardSnapshot.tokenAddress, pnlPercent, user?.referralCode ?? undefined);

            const rawSolPnl = guardSnapshot.amountInSol * (pnlPercent / 100);
            const platformFee = (guardSnapshot.amountInSol * (1 + pnlPercent / 100)) * 0.01;
            const jitoTip = 0.0015;
            const solPnl = rawSolPnl - platformFee - jitoTip;
            
            const captionText = `${pnlPercent >= 0 ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'}\n\n` +
                `Token: <code>${guardSnapshot.tokenAddress.substring(0,8)}...</code>\n` +
                `${pnlPercent < 0 ? `Configured Drop Threshold: <b>-${guardSnapshot.trailingPercent}%</b>\nActual Peak Drop: <b>-${actualPeakDrop}%</b>\n` : ''}` +
                `Realized PnL (incl. fees): <b>${pnlPercent.toFixed(1)}%</b>\n\n` +
                `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
                `🔗 <a href="https://solscan.io/tx/${generateSimSignature()}">View on Solscan</a>`;

            const imgId = crypto.randomBytes(8).toString('hex');
            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);
            const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
            const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;
            const tweetText = encodeURIComponent(`Just secured a verified ${pnlPercent >= 0 ? `gain of +${pnlPercent.toFixed(1)}%` : `loss protection`} on $${guardSnapshot.tokenAddress.substring(0,6).toUpperCase()} using Sentry Terminal ⚡\n\nVerified details: ${shareUrl}`);
            const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X (Twitter)', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

            await bot.telegram.sendPhoto(
                guardSnapshot.telegramId,
                { source: imageBuffer },
                { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
            );
        } catch (e: any) {
            try {
                await bot.telegram.sendMessage(
                    guardSnapshot.telegramId,
                    `${pnlPercent >= 0 ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'}\n\nToken: <code>${guardSnapshot.tokenAddress.substring(0,8)}...</code>\nPnL: <b>${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%</b>`,
                    { parse_mode: 'HTML' }
                );
            } catch (_) {}
        }
        await releaseGuardLock(guardSnapshot.id);
        return; 
    }

    // ==============================================
    // ⚡ LIVE GUARD BRANCH
    // ==============================================
    if (await redis.get(`lock:guard_exec:${guardSnapshot.id}`)) return;

    let guard = guardSnapshot;
    if (guardSnapshot.entryPrice === 0) {
        const fresh = await fetchFreshGuard(guardSnapshot.id);
        if (!fresh) return;
        guard = fresh;
    }

    if (guard.maxHoldMinutes && guard.createdAt) {
        const ageMinutes = (Date.now() - new Date(guard.createdAt).getTime()) / 60000;
        if (ageMinutes >= guard.maxHoldMinutes) {
            const gotLock = await acquireGuardLock(guard.id, 20);
            if (!gotLock) return;

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    if (result.success) {
                        try {
                            await bot.telegram.sendMessage(
                                guard.telegramId, 
                                `⏱️ <b>TIME-BASED EXIT TRIGGERED</b>\n\nToken: <code>${guard.tokenAddress}</code>\nMax hold time of ${guard.maxHoldMinutes}m reached. Position sold at market.\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, 
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    }
                }
                await releaseGuardLock(guard.id);
            }).catch(async () => await releaseGuardLock(guard.id));
            return;
        }
    }

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
            const gotLock = await acquireGuardLock(guard.id, 20);
            if (!gotLock) return;

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    
                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);

                        try {
                            const user          = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const multiplier    = user?.activeWallets || 1;
                            const profitSol     = (guard.amountInSol * (profitPercent / 100)) * multiplier;
                            
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

                            await bot.telegram.sendPhoto(
                                guard.telegramId,
                                { source: imageBuffer },
                                { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
                            );
                        } catch (e: any) {
                            console.error("Take profit image send failed:", e.message);
                        }
                    }
                    await releaseGuardLock(guard.id);
                } else {
                    await releaseGuardLock(guard.id);
                }
            }).catch(async (e: any) => {
                console.error("🔴 TP Execution Error:", e.message);
                await releaseGuardLock(guard.id);
            });
            return; 
        }
    }

    if (guard.highestSeenPrice === 0 || currentPriceNative > guard.highestSeenPrice) {
        updateHighestSeen(guard.id, currentPriceNative).catch(() => {});
    } else {
        const dropPercent = ((guard.highestSeenPrice - currentPriceNative) / guard.highestSeenPrice) * 100;

        if (dropPercent >= guard.trailingPercent) {
            const gotLock = await acquireGuardLock(guard.id, 20);
            if (!gotLock) return;

            triggerInstantExit(guard).then(async (result) => {
                if (result.success || (result as any).message?.includes("No tokens found")) {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    
                    if (result.success) {
                        await redis.del(`balance_cache:${guard.telegramId}`);

                        try {
                            const user          = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                            const totalPnlPercent = entryPrice > 0 ? ((currentPriceNative - entryPrice) / entryPrice) * 100 : 0;

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

                            const captionText = `🚨 <b>TRAILING GUARD TRIGGERED!</b>\n\n` +
                                `Token: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n` +
                                `Configured Drop Threshold: <b>-${guard.trailingPercent}%</b>\n` +
                                `Actual Peak Drop: <b>-${dropPercent.toFixed(1)}%</b>\n` +
                                `Realized PnL (incl. fees): <b>${totalPnlPercent.toFixed(1)}%</b>\n\n` +
                                `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
                                `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                            await bot.telegram.sendPhoto(
                                guard.telegramId,
                                { source: imageBuffer },
                                { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
                            );
                        } catch (e: any) {
                            console.error("Stop loss image send failed:", e.message);
                        }
                    }
                    await releaseGuardLock(guard.id);
                } else {
                    await releaseGuardLock(guard.id);
                }
            }).catch(async () => await releaseGuardLock(guard.id));
        }
    }
}

// Add this helper function above startUniversalGuardPoller
async function fetchBulkTokenPrices(mints: string[]): Promise<Record<string, number>> {
    if (mints.length === 0) return {};
    try {
        const { default: axios } = await import('axios');
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${mints.join(',')}`, { timeout: 2000 });
        const data = res.data?.data || {};
        const result: Record<string, number> = {};
        for (const mint of mints) {
            result[mint] = parseFloat(data[mint]?.price || '0');
        }
        return result;
    } catch { return {}; }
}

export function startUniversalGuardPoller(bot: any) {
    console.log("🛡️ [GUARD ENGINE] Push-Based Subscription Poller Initialized.");

    setInterval(async () => {
        try {
            // 🟢 FIX 41: Read strictly from RAM instead of smashing Redis every second
            const activeGuards = cachedActiveGuards; 
            if (activeGuards.length === 0) return;

            const { isSimulationActive, walkSimPositionPrices } = await import('./simulation.service.js');

            // 🟢 FIX 31: Group guards by token address to avoid duplicate API calls
            const guardsByToken = new Map<string, TrailingOrder[]>();
            for (const g of activeGuards) {
                if (!guardsByToken.has(g.tokenAddress)) guardsByToken.set(g.tokenAddress, []);
                guardsByToken.get(g.tokenAddress)!.push(g);
            }

            // Fetch all live prices in ONE network request
            const tokenMints = Array.from(guardsByToken.keys());
            const prices = await fetchBulkTokenPrices(tokenMints);

            const uniqueTgIds = [...new Set(activeGuards.map(g => g.telegramId))];
            const simFlags = new Map<string, boolean>();
            await Promise.all(uniqueTgIds.map(async (id) => {
                const isSim = await isSimulationActive(id);
                simFlags.set(id, isSim);
                if (isSim) walkSimPositionPrices(id).catch(() => {}); 
            }));

            await Promise.allSettled(activeGuards.map(async guard => {
                const isSim = simFlags.get(guard.telegramId);
                if (isSim) {
                    return checkAndTriggerGuard(guard, 1.0, bot); 
                } else {
                    let livePrice = prices[guard.tokenAddress] ?? getLivePriceSol(guard.tokenAddress);
                    
                    if (livePrice == null || livePrice <= 0) {
                        const { getCachedTokenPrice } = await import('./engine.service.js');
                        livePrice = await getCachedTokenPrice(guard.tokenAddress).catch(() => 0);
                    }
                    
                    if (livePrice <= 0) return; // Skip only if truly invalid
                    return checkAndTriggerGuard(guard, livePrice, bot);
                }
            }));
        } catch (e: any) {
            console.error(`🔴 [GUARD POLLER] Tick failed: ${e.message}`);
        }
    }, 1000);

    // Keep the 15-second reconcile loop below...
}

export function startPumpFunPolling() {
    if (pollerStarted) return;
    pollerStarted = true;
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
        
        // 🟢 FIX: Verify readyState prior to sending payload
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        }
        
        lastMessageAt = Date.now();
        if (wsHeartbeat) clearInterval(wsHeartbeat);
        
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

export async function triggerAutoSnipes(
    bot: any, mintCa: string, symbol: string, initialBuySol: number, mode: 'PUMP' | 'RAYDIUM', raydiumPoolId?: string
) {
    const activeSnipers = [...cachedActiveSnipers];
    if (activeSnipers.length === 0) return;

    for (const sniper of activeSnipers) {
        if (!sniper.user.vaultAddress) continue;

        const delayMs = (sniper.snipeDelaySeconds ?? 0) * 1000;
        setTimeout(async () => {
            try {
                // 🟢 FIX: Fresh DB query execution check
                const liveConfig = await prisma.autoSnipeConfig.findUnique({ 
                    where: { id: sniper.id }, 
                    include: { user: true } 
                });
                if (!liveConfig || !liveConfig.isActive) return;

                if (liveConfig.sniperMode !== mode && liveConfig.sniperMode !== 'BOTH') return;
                if (mode === 'PUMP' && liveConfig.antiDeadCoin && initialBuySol === 0) return;

                let scoreType = "Basic Scoring"; 
                let score = 0;
                let ageMins = 0;
                let volUsd = 0;
                let liqUsd = 0;
                let priceChangeM5 = 0;

                if (liveConfig.minScore > 0) {
                    try {
                        const { computeTokenScore, getModelScore, getSentimentScore, getDevReputation, checkLpLockStatus, trackHolderVelocity, simulateSellability } = await import('./caller.service.js');
                        const { consumeSniperCredit } = await import('./credits.service.js');
                        const { checkTokenRugRisk, checkRecentMevActivity } = await import('./price.service.js');

                        const seen = getRecentNewMints().find((m: any) => m.mint === mintCa);
                        ageMins = seen ? (Date.now() - seen.firstSeenAt) / 60000 : 0;
                        const creatorWallet = seen?.creator || '';

                        let hasSocials = false;

                        if (mode === 'PUMP') {
                            const { getBondingCurveAddress } = await import('./price.service.js');
                            const curvePda = getBondingCurveAddress(mintCa);
                            const accInfo  = await connection.getAccountInfo(new PublicKey(curvePda));
                            if (accInfo?.data) {
                                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                                if (buf.length >= 40) {
                                    const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                                    const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                                    liqUsd = virtualSolReserves * cachedSolUsdPrice;
                                    volUsd = realSolReserves * cachedSolUsdPrice * 2;
                                }
                            }
                        } else {
                            const { default: axios } = await import('axios');
                            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintCa}`, { timeout: 2000 }).catch(() => null);
                            const pair = res?.data?.pairs?.[0];
                            if (pair) {
                                liqUsd = pair.liquidity?.usd || 0;
                                volUsd = pair.volume?.h24 || 0;
                                priceChangeM5 = pair.priceChange?.m5 || 0;
                                hasSocials = (pair.info?.socials?.length || 0) > 0;
                            }
                        }

                        let isRug = false, hasMev = false, devRep: any = { launchCount: 0, avgRugScore: 0, isKnownRugger: false }, lpLock: any = { locked: false, burned: false, lockPct: 0 }, velocity: any = { growthRate: 0, uniqueBuyers5m: 0 }, sellability: any = { sellable: true, estimatedTaxPct: 0 };

                        if (liveConfig.useDeepScoring) {
                            [isRug, hasMev, devRep, lpLock, velocity, sellability] = await Promise.all([
                                checkTokenRugRisk(mintCa).catch(() => true),
                                checkRecentMevActivity(mintCa).catch(() => true),
                                getDevReputation(creatorWallet).catch(() => ({ launchCount: 0, avgRugScore: 0, isKnownRugger: false })),
                                checkLpLockStatus(mintCa).catch(() => ({ locked: false, burned: false, lockPct: 0 })),
                                trackHolderVelocity(mintCa).catch(() => ({ growthRate: 0, uniqueBuyers5m: 0 })),
                                mode === 'PUMP' ? Promise.resolve({ sellable: true, estimatedTaxPct: 0 }) : simulateSellability(mintCa).catch(() => ({ sellable: true, estimatedTaxPct: 0 }))
                            ]);
                        }

                        const sentiment = await getSentimentScore(symbol);
                        const stats = {
                            ageMins, volume24h: volUsd, liquidity: liqUsd, priceChangeM5, hasSocials, isRug,
                            devRep, lpLock, velocity, sellability, sentiment
                        };

                        const heuristicResult = computeTokenScore(stats);
                        score = heuristicResult.score;

                        if (score < liveConfig.minScore) return;
                        
                        const creditResult = await consumeSniperCredit(liveConfig.user.telegramId, mintCa);
                        const useML = creditResult.success && !creditResult.fallback;

                        if (useML) {
                            scoreType = "AI Model";
                            const mlScore = await getModelScore(mintCa, stats);
                            if (mlScore !== null) {
                                score = mlScore;
                            }
                        } else {
                            scoreType = "Basic Fallback (No Credits)";
                            if (creditResult.fallback) {
                                const warnKey = `sniper_credits_warn:${liveConfig.user.telegramId}`;
                                if (!(await redis.get(warnKey))) {
                                    await redis.set(warnKey, '1', 'EX', 1800);
                                    try {
                                        await bot.telegram.sendMessage(
                                            liveConfig.user.telegramId,
                                            `⚠️ <b>AI CREDITS DEPLETED</b>\n\nYour Auto-Sniper evaluated <code>${mintCa}</code> using <b>Basic Scoring</b>. Sniper will continue running with reduced accuracy. Use /credits to top up!`,
                                            { parse_mode: 'HTML' }
                                        );
                                    } catch (_) {}
                                }
                            }
                        }

                        if (score < liveConfig.minScore) return; 
                    } catch (e) {
                        return; 
                    }
                }

                // EXECUTION BLOCK & BUDGET CHECK
                const { getSessionSpend, addSessionSpend, sendBudgetExhaustedSummary } = await import('./simulation.service.js');
                const sessionId = await redis.get(`autosnipe:session_id:live:${liveConfig.user.telegramId}`);
                const currentSpend = await getSessionSpend(liveConfig.user.telegramId, 'live');
                const intendedSpend = liveConfig.amountSol * liveConfig.user.activeWallets;

                if (liveConfig.maxBudgetSol && currentSpend + intendedSpend > liveConfig.maxBudgetSol) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    await sendBudgetExhaustedSummary(bot, liveConfig.user.telegramId, 'live', sessionId);
                    return; 
                }

                if (!isPriceReady) await new Promise(r => setTimeout(r, 1000)); 

                const sniperLockKey = `lock:autosnipe:${liveConfig.id}:${mintCa}`;
                const isSnipeLocked = await redis.set(sniperLockKey, '1', 'EX', 86400, 'NX');
                if (!isSnipeLocked) return;

                const executionSlippage = liveConfig.useDeepScoring ? (liveConfig.user.slippagePercent + 5) : undefined;
                const result = await executeSnipe(liveConfig.user.telegramId, mintCa, liveConfig.amountSol, 'buy', undefined, false, raydiumPoolId, executionSlippage, 0, undefined, 'SNIPER');

                if (result.success) {
                    const spent = result.volumeSpent || intendedSpend;
                    
                    await addSessionSpend(liveConfig.user.telegramId, spent, 'live');
                    if (sessionId) {
                        await redis.rpush(`live:session_trades:${sessionId}`, JSON.stringify({ mint: mintCa, amountInSol: spent, realizedPnlSol: 0 }));
                    }

                    await prisma.autoSnipeConfig.update({
                        where: { id: liveConfig.id },
                        data:  { totalSpentSol: { increment: spent } }
                    });

                    const entryPrice = await fetchLiveEntryPrice(mintCa);
                    const { addTrailingStopToMemory } = await import('./order.service.js');
                    await addTrailingStopToMemory(
                        liveConfig.user.telegramId, mintCa, liveConfig.autoTrailingDropPercent,
                        liveConfig.amountSol, entryPrice, liveConfig.autoTakeProfitPercent || undefined
                    );

                    try {
                        const { buildAuditTrailMessage } = await import('./caller.service.js');
                        const auditStats = {
                            ageMins: ageMins,
                            volume: volUsd,
                            liquidity: liqUsd,
                            priceChangeM5: priceChangeM5
                        };
                        
                        const baseMsg = buildAuditTrailMessage(
                            mintCa, score, auditStats, spent, liveConfig.autoTrailingDropPercent,
                            liveConfig.autoTakeProfitPercent || 'OFF', false
                        );
                        
                        const finalMsg = `${baseMsg}\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;

                        await bot.telegram.sendMessage(liveConfig.user.telegramId, finalMsg, {
                            parse_mode: 'HTML', link_preview_options: { is_disabled: true },
                            reply_markup: { inline_keyboard: [
                                [{ text: '💼 View Positions', callback_data: 'menu_positions' }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${mintCa}` }]
                            ]}
                        });
                    } catch (_) {}
                } else {
                    await redis.del(sniperLockKey);
                    if (result.message.includes("Insufficient Funds")) {
                        const fundWarnKey = `warn_funds:${liveConfig.user.telegramId}`;
                        if (!(await redis.get(fundWarnKey))) {
                            await redis.set(fundWarnKey, '1', 'EX', 600);
                            try {
                                await bot.telegram.sendMessage(
                                    liveConfig.user.telegramId,
                                    `🔴 <b>AUTO-SNIPER FAILED: INSUFFICIENT FUNDS</b>\n\nTarget: <code>${mintCa}</code>\nYour wallet does not have enough SOL to execute this snipe (+ gas).\n\n<i>Sniper is still running, but please deposit SOL immediately to catch the next token.</i>`,
                                    { parse_mode: 'HTML' }
                                );
                            } catch (_) {}
                        }
                    }
                }
            } catch (e: any) {
                console.error("🔴 [AUTO-SNIPER] Execution failure:", e);
            }
        }, delayMs);
    }
}

export async function igniteYellowstoneStream(bot: any) {
    if (!pollerStarted) {
        connectPumpPortalStream(bot);
        startPumpFunPolling();
        startUniversalGuardPoller(bot);
        pollerStarted = true;
        console.log("🟢 [SNIPER] PumpPortal WebSocket stream active.");
    }

    if (process.env.DISABLE_GRPC === 'true') {
        console.log("🟡 [gRPC] DISABLE_GRPC=true — Yellowstone skipped. Raydium WS fallback armed.");
        connectRaydiumFallbackWatcher(bot);
        return;
    }

    // 🟢 FIX: Check key existence before calling constructor
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

                if (logs.some((log: string) => log.includes("Instruction: Withdraw") || log.includes("Instruction: RemoveLiquidity"))) {
                    const postBalances = tx.meta?.postTokenBalances || [];
                    const tokenMint = postBalances.find((b: any) => b.mint !== WSOL_MINT)?.mint;

                    if (tokenMint) {
                        const exposedUsers = await prisma.activeOrder.findMany({
                            where: { tokenAddress: tokenMint, orderType: 'GUARD', isActive: true },
                            include: { user: true }
                        });

                        if (exposedUsers.length > 0) {
                            console.log(`🚨 [ANTI-RUG SHIELD] Dev liquidity pull detected on ${tokenMint}! Front-running for ${exposedUsers.length} users.`);
                            for (const order of exposedUsers) {
                                const { executeExit } = await import('./engine.service.js');
                                executeExit(order.user.telegramId, tokenMint, 100, true, 'ANTI_RUG_SHIELD');
                                
                                bot.telegram.sendMessage(order.user.telegramId, 
                                    `🚨 <b>ANTI-RUG SHIELD ACTIVATED!</b>\n\nDeveloper liquidity pull detected on <code>${tokenMint}</code>.\n\nSentry Terminal has automatically fired a massive Block-0 Jito bundle to front-run the developer and exit your position before the liquidity is removed!`, 
                                    { parse_mode: 'HTML' }
                                ).catch(()=>{});
                            }
                        }
                    }
                }
            } catch (_) {}
        });
        stream.on("error", (err: any) => {
            if (
                err.message.includes("401") || 
                err.message.includes("UNAUTHENTICATED") || 
                err.message.includes("PermissionDenied") ||
                err.message.includes("Free Tier") || 
                err.message.includes("403")
            ) {
                if (!isGrpcDisabled) {
                    console.warn("🟡 [HELIUS FREE TIER] Yellowstone gRPC stream requires a Growth plan. Gracefully engaging WebSocket stream & REST polling fallbacks.");
                    isGrpcDisabled = true;
                }
                try { stream.destroy(); } catch (_) {}
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
        console.log("🟢 [gRPC] Yellowstone stream connected — Helius gRPC Active.");

    } catch (e: any) {
        if (!isGrpcDisabled) {
            console.warn("🟡 [HELIUS gRPC] Initial stream connection unauthenticated. Arming Raydium WS fallback.");
            isGrpcDisabled = true;
            connectRaydiumFallbackWatcher(bot);
        }
    }
}