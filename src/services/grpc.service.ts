// src/services/grpc.service.ts
import Client from '@triton-one/yellowstone-grpc';
import { 
    executeSnipe, 
    executeExit, 
    getCachedTokenPrice,
    axiosClient
} from './engine.service.js';
import { 
    addTrailingStopToMemory, 
    getAllActiveGuards, 
    updateHighestSeenFast, 
    cancelAllGuardsForToken, 
    updateEntryPrice, 
    TrailingOrder 
} from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { generatePnlCard } from './image.service.js';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import crypto from 'crypto';
import { getLivePriceSol } from './guard-price-feed.service.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { calculateDynamicSize } from './simulation.service.js';
import pLimit from 'p-limit';

dotenv.config();

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const GRPC_URL = `https://atlas-mainnet.helius-rpc.com`;
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const METEORA_DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const recentlySnipedTokens = new Set<string>();
let pollerStarted = false;
export let isGrpcDisabled = false;
let raydiumWsFallbackStarted = false;
const activeSubscriptions = new Map<string, number>(); 

export let cachedSolUsdPrice = 156.93;
export let isPriceReady = false; 

export const recentNewMints: { mint: string; symbol: string; creator: string; firstSeenAt: number }[] = [];

declare global { var _sentryIntervals: NodeJS.Timeout[]; }
if (!global._sentryIntervals) global._sentryIntervals = [];

function trackNewMint(mint: string, symbol: string = "UNKNOWN", creator: string = "") {
    recentNewMints.push({ mint, symbol, creator, firstSeenAt: Date.now() });
    if (recentNewMints.length > 300) recentNewMints.shift(); 
}

export function getRecentNewMints() {
    const now = Date.now();
    while (recentNewMints.length > 0 && now - recentNewMints[0].firstSeenAt > 30 * 60 * 1000) {
        recentNewMints.shift(); 
    }
    return [...recentNewMints];
}

export async function syncInitialSolPrice() {
    try {
        const res = await axiosClient.get(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4000 });
        const price = res.data?.data?.[WSOL_MINT]?.price;
        if (price && parseFloat(price) > 0) {
            cachedSolUsdPrice = parseFloat(price);
            logger.info(`🟢 [HFT ENGINE] Synchronized SOL boot price: $${cachedSolUsdPrice} USD.`);
        }
    } catch (e) {
        logger.warn("⚠️ [HFT ENGINE] Boot price check timed out, using fallback $156.93.");
    } finally {
        isPriceReady = true; 
    }
}
syncInitialSolPrice();

global._sentryIntervals.push(setInterval(async () => {
    try {
        const res = await axiosClient.get(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4000 });
        const price = res.data?.data?.[WSOL_MINT]?.price;
        if (price && parseFloat(price) > 0) cachedSolUsdPrice = parseFloat(price);
    } catch (_) {}
}, 15_000));

let cachedActiveSnipers: any[] = [];
global._sentryIntervals.push(setInterval(async () => {
    try {
        cachedActiveSnipers = await prisma.autoSnipeConfig.findMany({
            where: { isActive: true }, 
            include: { user: true }
        });
    } catch (_) {}
}, 3_000));

let cachedActiveGuards: TrailingOrder[] = [];
let cachedLimitOrders: any[] = [];

global._sentryIntervals.push(setInterval(async () => {
    try {
        cachedActiveGuards = await getAllActiveGuards();
        cachedLimitOrders = await prisma.activeOrder.findMany({
            where: { orderType: { in: ['LIMIT', 'ALERT'] }, isActive: true },
            include: { user: true }
        });
    } catch (_) {}
}, 500));

function safePublicKey(address: string | undefined | null): PublicKey | null {
    if (!address) return null;
    try { return new PublicKey(address); } catch { return null; }
}

global._sentryIntervals.push(setInterval(async () => {
    await Promise.allSettled(cachedActiveGuards.map(async (guard) => {
        if ((guard as any).isProcessing) return;
        try {
            const { generatePreSignedExitTxMulti } = await import('./engine.service.js');
            const payloads = await generatePreSignedExitTxMulti(guard.telegramId, guard.tokenAddress);
            if (payloads.length > 0) {
                await redis.set(`presigned_exit_multi:${guard.id}`, JSON.stringify(payloads), 'EX', 4);
            }
        } catch (e) {}
    }));
}, 1000));

export function pushGuardToCacheImmediately(guard: TrailingOrder) {
    cachedActiveGuards.push(guard);
}

export async function presignGuardImmediately(guard: TrailingOrder) {
    try {
        const { generatePreSignedExitTxMulti } = await import('./engine.service.js');
        const payloads = await generatePreSignedExitTxMulti(guard.telegramId, guard.tokenAddress);
        if (payloads.length > 0) {
            await redis.set(`presigned_exit_multi:${guard.id}`, JSON.stringify(payloads), 'EX', 4);
        }
    } catch (_) {}
}

export async function releaseGuardSubscription(tokenAddress: string) {
    if (!tokenAddress.toLowerCase().endsWith("pump")) return;
    try {
        const curvePda = getBondingCurveAddress(tokenAddress); 
        const remainingKeys = await redis.keys(`token_guards:*:${tokenAddress}`).catch(() => []);
        const stillActive = cachedLimitOrders.some(l => l.tokenAddress === tokenAddress) || remainingKeys.length > 0;

        if (!stillActive) {
            const subId = activeSubscriptions.get(curvePda);
            if (subId !== undefined) {
                try { connection.removeAccountChangeListener(subId); } catch(e){}
                activeSubscriptions.delete(curvePda);
            }
        }
    } catch (_) {}
}

export async function fetchFreshGuard(guardId: string): Promise<TrailingOrder | null> {
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
        const price = await getCachedTokenPrice(tokenAddress, true);
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

async function triggerInstantExit(guard: TrailingOrder): Promise<{ success: boolean; signature?: string; message?: string }> {
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
                    return { success: true, signature: firstSig, message: `Instant Multi-Wallet Exit Executed` };
                }
            }
        }
    } catch (e) {}

    const { executeExit } = await import('./engine.service.js');
    return await executeExit(guard.telegramId, guard.tokenAddress, 100, false, guard.strategy || 'Manual / Direct');
}

async function checkAndTriggerGuard(guardSnapshot: TrailingOrder, currentPriceNative: number, bot: any) {
    const { isSimulationActive, simExecuteExit, generateSimSignature } = await import('./simulation.service.js');
    const isSim = await isSimulationActive(guardSnapshot.telegramId);

    if ((guardSnapshot as any).isProcessing) return;

    // 🟢 CRITICAL FIX: Redis-backed distributed lock prevents duplicate exits across ticks
    const exitLockKey = `lock:guard_exit:${guardSnapshot.id}`;
    const acquired = await redis.set(exitLockKey, '1', 'EX', 30, 'NX');
    if (!acquired) return;

    (guardSnapshot as any).isProcessing = true;

    try {
        let guard = guardSnapshot;
        if (guard.entryPrice === 0 && currentPriceNative > 0) {
            guard.entryPrice = currentPriceNative;
            await updateEntryPrice(guard.id, currentPriceNative).catch(() => {});
            
            const idx = cachedActiveGuards.findIndex(g => g.id === guard.id);
            if (idx !== -1) cachedActiveGuards[idx].entryPrice = currentPriceNative;
        }
        const entryPrice = guard.entryPrice || currentPriceNative;
        
        if (entryPrice <= 0 || currentPriceNative <= 0) {
            await redis.del(exitLockKey); 
            return;
        }

        // ─────────────────────────────────────────────────────────────
        // 1. Time-Based Exit
        // ─────────────────────────────────────────────────────────────
        if (guard.maxHoldMinutes && guard.createdAt) {
            const ageMinutes = (Date.now() - new Date(guard.createdAt).getTime()) / 60000;
            if (ageMinutes >= guard.maxHoldMinutes) {
                const pnlPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;
                if (isSim) {
                    await simExecuteExit(guard.telegramId, guard.tokenAddress, 100, pnlPercent, guard.strategy || 'Manual / Direct');
                } else {
                    await triggerInstantExit(guard);
                }
                
                (async () => {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    await redis.del(`balance_cache:${guard.telegramId}`);

                    const { recordGuardOutcome } = await import('./guard_ai.service.js');
                    const peakPercent = guard.highestSeenPrice && guard.entryPrice 
                        ? ((guard.highestSeenPrice - guard.entryPrice) / guard.entryPrice) * 100 
                        : pnlPercent;
                    recordGuardOutcome(guard.telegramId, guard.tokenAddress, pnlPercent, peakPercent).catch(() => {});

                    try {
                        await bot.telegram.sendMessage(
                            guard.telegramId, 
                            `⏱️ <b>TIME-BASED EXIT TRIGGERED</b>\n\nToken: <code>${guard.tokenAddress}</code>\nMax hold time of ${guard.maxHoldMinutes}m reached. Position sold at market.\nPnL: <b>${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>`, 
                            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                        );
                    } catch (_) {}
                })();
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 2. Take-Profit Exit
        // ─────────────────────────────────────────────────────────────
        if (guard.takeProfitPercent && entryPrice > 0) {
            const profitPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;
            if (profitPercent >= guard.takeProfitPercent) {
                let exitSig = "";
                if (isSim) {
                    const res = await simExecuteExit(guard.telegramId, guard.tokenAddress, 100, profitPercent, guard.strategy || 'Manual / Direct');
                    exitSig = res.signature || generateSimSignature();
                } else {
                    const res = await triggerInstantExit(guard);
                    exitSig = res.signature || "";
                }

                (async () => {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    await redis.del(`balance_cache:${guard.telegramId}`);

                    const { recordGuardOutcome } = await import('./guard_ai.service.js');
                    recordGuardOutcome(guard.telegramId, guard.tokenAddress, profitPercent, profitPercent).catch(() => {});

                    try {
                        const user = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                        const imageBuffer = await generatePnlCard(guard.tokenAddress, profitPercent, user?.referralCode ?? undefined);
                        const imgId = crypto.randomBytes(8).toString('hex');
                        await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);

                        const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
                        const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;
                        const tweetText = encodeURIComponent(`Just secured a gain of +${profitPercent.toFixed(1)}% on $${guard.tokenAddress.substring(0,6).toUpperCase()} using Sentry Terminal ⚡\n\n${shareUrl}`);
                        const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

                        const caption = `🎯 <b>TAKE PROFIT TRIGGERED!</b>\n\n` +
                            `Token: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n` +
                            `Net Profit: <b>+${profitPercent.toFixed(1)}%</b>\n` +
                            `Status: 🟢 Auto-Sold 100% via Instant Jito Bundle.\n` +
                            `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

                        await bot.telegram.sendPhoto(guard.telegramId, { source: imageBuffer }, { caption, parse_mode: 'HTML', reply_markup: twitterBtn });
                    } catch (e) {}
                })();
                return;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 3. Trailing-Stop Exit (High-Water Mark Peak Tracking)
        // ─────────────────────────────────────────────────────────────
        if (guard.highestSeenPrice === 0 || currentPriceNative > guard.highestSeenPrice) {
            await updateHighestSeenFast(guard.id, currentPriceNative).catch(() => {});
            await redis.del(exitLockKey); // 🟢 Release lock: price is rising, allow next tick
        } else {
            const dropPercent = ((guard.highestSeenPrice - currentPriceNative) / guard.highestSeenPrice) * 100;
            if (dropPercent >= guard.trailingPercent) {
                const totalPnlPercent = ((currentPriceNative - entryPrice) / entryPrice) * 100;
                let exitSig = "";
                if (isSim) {
                    const res = await simExecuteExit(guard.telegramId, guard.tokenAddress, 100, totalPnlPercent, guard.strategy || 'Manual / Direct');
                    exitSig = res.signature || generateSimSignature();
                } else {
                    const res = await triggerInstantExit(guard);
                    exitSig = res.signature || "";
                }

                (async () => {
                    await cancelAllGuardsForToken(guard.telegramId, guard.tokenAddress);
                    await redis.del(`balance_cache:${guard.telegramId}`);

                    const { recordGuardOutcome } = await import('./guard_ai.service.js');
                    const peakPercent = guard.highestSeenPrice && guard.entryPrice 
                        ? ((guard.highestSeenPrice - guard.entryPrice) / guard.entryPrice) * 100 
                        : totalPnlPercent;
                    recordGuardOutcome(guard.telegramId, guard.tokenAddress, totalPnlPercent, peakPercent).catch(() => {});

                    try {
                        const user = await prisma.user.findUnique({ where: { telegramId: guard.telegramId } });
                        const imageBuffer = await generatePnlCard(guard.tokenAddress, totalPnlPercent, user?.referralCode ?? undefined);
                        const imgId = crypto.randomBytes(8).toString('hex');
                        await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);

                        const caption = `🚨 <b>TRAILING GUARD TRIGGERED!</b>\n\n` +
                            `Token: <code>${guard.tokenAddress.substring(0, 8)}...</code>\n` +
                            `Configured Drop: <b>-${guard.trailingPercent}%</b>\n` +
                            `Actual Peak Drop: <b>-${dropPercent.toFixed(1)}%</b>\n` +
                            `Realized PnL: <b>${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(1)}%</b>\n\n` +
                            `Status: 🟢 Auto-Sold 100% via Instant Jito Bundle.\n` +
                            `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

                        await bot.telegram.sendPhoto(guard.telegramId, { source: imageBuffer }, { caption, parse_mode: 'HTML' });
                    } catch (e) {}
                })();
            } else {
                await redis.del(exitLockKey); // 🟢 Release lock: drop threshold not breached yet
            }
        }
    } finally {
        (guardSnapshot as any).isProcessing = false;
    }
}

const bulkPriceLimiter = pLimit(5);

export async function fetchBulkTokenPrices(mints: string[]): Promise<Record<string, number>> {
    if (mints.length === 0) return {};
    const result: Record<string, number> = {};
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += 20) chunks.push(mints.slice(i, i + 20));

    await Promise.all(chunks.map(chunk => bulkPriceLimiter(async () => {
        try {
            const res = await axiosClient.get(`https://lite-api.jup.ag/price/v2?ids=${chunk.join(',')}`, { timeout: 2000 });
            const data = res.data?.data || {};
            for (const mint of chunk) {
                result[mint] = parseFloat(data[mint]?.price || '0');
            }
        } catch (_) {}
    })));
    return result;
}

export async function processGuardOrders(bot: any) {
    try {
        const activeGuards = cachedActiveGuards; 
        if (activeGuards.length === 0) return;

        const { isSimulationActive, walkSimPositionPrices } = await import('./simulation.service.js');
        const guardsByToken = new Map<string, TrailingOrder[]>();
        for (const g of activeGuards) {
            if (!guardsByToken.has(g.tokenAddress)) guardsByToken.set(g.tokenAddress, []);
            guardsByToken.get(g.tokenAddress)!.push(g);
        }

        const tokenMints = Array.from(guardsByToken.keys()).filter(m => getLivePriceSol(m) === null);
        const prices = tokenMints.length > 0 ? await fetchBulkTokenPrices(tokenMints) : {};

        const uniqueTgIds = [...new Set(activeGuards.map(g => g.telegramId))];
        await Promise.all(uniqueTgIds.map(async (id) => {
            const isSim = await isSimulationActive(id);
            if (isSim) walkSimPositionPrices(id).catch(() => {}); 
        }));

        await Promise.allSettled(activeGuards.map(async guard => {
            let livePrice = getLivePriceSol(guard.tokenAddress) ?? prices[guard.tokenAddress];
            if (livePrice == null || livePrice <= 0) {
                const { getCachedTokenPrice } = await import('./engine.service.js');
                // 🟢 SPEED FIX: bypassCache = true ensures price checks aren't delayed by stale 5s cache
                livePrice = await getCachedTokenPrice(guard.tokenAddress, true).catch(() => 0);
            }
            if (livePrice <= 0) return; 
            return checkAndTriggerGuard(guard, livePrice, bot);
        }));
    } catch (e: any) {
        logger.error(`🔴 [GUARD POLLER] Tick failed`, { error: e.message });
    }
}

export function startPumpFunPolling() {
    if (pollerStarted) return;
    pollerStarted = true;
    
    global._sentryIntervals.push(setInterval(async () => {
        try {
            const res = await axiosClient.get(
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
            if (added > 0) logger.info(`🔁 [PUMP POLL] Added ${added} new mints. Buffer: ${recentNewMints.length}`);
        } catch (e: any) { }
    }, 10_000));
}

let isWsConnecting = false;
let wsReconnectDelay = 5000;
let wsHeartbeat: NodeJS.Timeout | null = null;
let lastMessageAt = Date.now();

function connectPumpPortalStream(bot: any) {
    if (isWsConnecting) return;
    isWsConnecting = true;

    try {
        const ws = new WebSocket('wss://pumpportal.fun/api/data', {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://pumpportal.fun' },
            handshakeTimeout: 10000
        });

        ws.on('open', () => {
            isWsConnecting = false;
            wsReconnectDelay = 5000;
            logger.info("🎯 [SNIPER] Connected to PumpPortal new-mint stream!");
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
            }
            
            lastMessageAt = Date.now();
            if (wsHeartbeat) clearInterval(wsHeartbeat);
            wsHeartbeat = setInterval(() => {
                if (Date.now() - lastMessageAt > 90_000) {
                    ws.terminate();
                }
            }, 30_000);
            global._sentryIntervals.push(wsHeartbeat);
        });

        ws.on('unexpected-response', (_req, res) => {
            isWsConnecting = false;
            if (res.statusCode === 429) {
                logger.warn("🟡 [PUMPPORTAL] Rate-limited (429). Backing off for 60 seconds...");
                wsReconnectDelay = 60000;
            }
            ws.removeAllListeners();
            ws.terminate();
            setTimeout(() => connectPumpPortalStream(bot), wsReconnectDelay);
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
                    await triggerAutoSnipes(bot, parsed.mint, parsed.symbol || "UNKNOWN", parsed.initialBuy || 0, 'PUMP');
                }
            } catch (_) {}
        });

        ws.on('error', (err: any) => {
            isWsConnecting = false;
            if (!err.message.includes('429')) {
                logger.warn(`⚠️ [SNIPER] WebSocket error: ${err.message}`);
            }
        });

        ws.on('close', () => {
            isWsConnecting = false;
            if (wsHeartbeat) clearInterval(wsHeartbeat);
            ws.removeAllListeners();
            setTimeout(() => connectPumpPortalStream(bot), wsReconnectDelay);
            wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 120_000);
        });
    } catch (e: any) {
        isWsConnecting = false;
        setTimeout(() => connectPumpPortalStream(bot), 15000);
    }
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
                    trackNewMint(tokenMint, "UNKNOWN"); 
                    await triggerAutoSnipes(bot, tokenMint, "UNKNOWN", 0, 'RAYDIUM', poolId || undefined);
                }
            } catch (_) {}
        }
    }, 'confirmed');
}

function buildSniperAuditMessage(
    mint: string, 
    score: number, 
    stats: any, 
    reasons: string[], 
    invested: number,
    trailingDrop: number, 
    takeProfit: number | string, 
    strategy: string, 
    signature: string,
    entryPriceUsd?: number
): string {
    let audit = `🟢 <b>SNIPE CONFIRMED!</b>\n\n`;
    audit += `Token: <code>${mint.substring(0, 8)}...</code>\n`;
    audit += `Strategy: <b>${strategy}</b>\n`;
    audit += `Score: <b>${score}/100</b> ⭐\n\n`;
    
    audit += `<b>Audit Trail:</b>\n`;
    if (reasons && reasons.length > 0) {
        reasons.forEach(r => audit += `✅ ${r}\n`);
    } else {
        audit += `${stats.ageMins < 60 ? '✅' : '⚠️'} 🕐 Age: ${Math.floor(stats.ageMins || 0)}m\n`;
        audit += `${stats.volume > 20000 ? '✅' : '⚠️'} 💰 Vol: $${((stats.volume || 0) / 1000).toFixed(1)}k\n`;
        audit += `${stats.priceChangeM5 > 15 ? '✅' : '⚠️'} 📈 Mom: ${(stats.priceChangeM5 || 0) >= 0 ? '+' : ''}${(stats.priceChangeM5 || 0).toFixed(1)}%\n`;
        audit += `${stats.liquidity > 20000 ? '✅' : '⚠️'} 💧 Liq: $${((stats.liquidity || 0) / 1000).toFixed(1)}k\n`;
        if (stats.socials) audit += `✅ 🌐 Socials present\n`;
        if (stats.lpLock && (stats.lpLock.burned || stats.lpLock.lockPct > 80)) audit += `✅ 🔒 LP Secured (${stats.lpLock.lockPct.toFixed(0)}% Locked/Burned)\n`;
    }
    
    if (entryPriceUsd && entryPriceUsd > 0) {
        audit += `\n💵 <b>Entry Price:</b> <code>$${entryPriceUsd.toFixed(6)}</code>\n`;
    }
    audit += `💰 <b>Invested:</b> <b>${invested.toFixed(4)} SOL</b>\n`;
    audit += `🛡️ <b>Trailing Drop:</b> <b>-${trailingDrop}%</b>\n`;
    audit += `🎯 <b>Take Profit:</b> <b>${typeof takeProfit === 'number' ? '+' + takeProfit + '%' : takeProfit}</b>\n\n`;
    audit += `Status: 🟢 Confirmed\n`;
    audit += `🔗 <a href="https://solscan.io/tx/${signature}">View on Solscan</a>`;
    return audit;
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
                const sniperLockKey = `lock:autosnipe:${sniper.id}:${mintCa}`;
                const isSnipeLocked = await redis.set(sniperLockKey, '1', 'EX', 86400, 'NX');
                if (!isSnipeLocked) return;

                const liveConfig = await prisma.autoSnipeConfig.findUnique({ 
                    where: { id: sniper.id }, include: { user: true } 
                });
                if (!liveConfig || !liveConfig.isActive) { await redis.del(sniperLockKey); return; }

                if (liveConfig.sniperMode !== mode && liveConfig.sniperMode !== 'BOTH') { await redis.del(sniperLockKey); return; }
                if (mode === 'PUMP' && liveConfig.antiDeadCoin && initialBuySol === 0) { await redis.del(sniperLockKey); return; }

                let score = 0, ageMins = 0, volUsd = 0, liqUsd = 0, priceChangeM5 = 0;
                let auditReasons: string[] = [];
                let auditStats: any = { ageMins: 0, volume: 0, liquidity: 0, priceChangeM5: 0, socials: false, lpLock: { lockPct: 0, burned: false } };

                if (liveConfig.minScore > 0) {
                    try {
                        const { consumeSniperCredit } = await import('./credits.service.js');
                        const creditResult = await consumeSniperCredit(liveConfig.user.telegramId, mintCa);
                        
                        if (!creditResult.success) {
                            const warnKey = `sniper_credits_warn:${liveConfig.user.telegramId}`;
                            if (!(await redis.get(warnKey))) {
                                await redis.set(warnKey, '1', 'EX', 600);
                                await bot.telegram.sendMessage(
                                    liveConfig.user.telegramId,
                                    `⚠️ <b>AI AUTO-SNIPER PAUSED — OUT OF CREDITS</b>\n\n` +
                                    `Your Auto-Sniper requires AI Token Scoring (Min Score: <b>${liveConfig.minScore}+</b>), but your credit balance is <b>0</b>.\n\n` +
                                    `Top up your credits to continue AI-filtered auto-sniping:`,
                                    {
                                        parse_mode: 'HTML',
                                        reply_markup: {
                                            inline_keyboard: [[{ text: '💳 Buy Credits', callback_data: 'menu_credits' }]]
                                        }
                                    }
                                ).catch(() => {});
                            }
                            await redis.del(sniperLockKey);
                            return;
                        }

                        const cachedHotTokens = await redis.get('caller:hot_scored_tokens');
                        let preScoredToken: any = null;
                        if (cachedHotTokens) {
                            try {
                                const hotTokens = JSON.parse(cachedHotTokens);
                                preScoredToken = hotTokens.find((t: any) => t.mint === mintCa);
                            } catch (_) {}
                        }

                        if (preScoredToken && preScoredToken.totalScore !== undefined) {
                            score = preScoredToken.totalScore;
                            volUsd = preScoredToken.volume || 0;
                            liqUsd = preScoredToken.liquidity || 0;
                            priceChangeM5 = preScoredToken.priceChangeM5 || 0;
                            ageMins = preScoredToken.ageMins || 0;

                            auditReasons = preScoredToken.reasons || [];
                            auditStats = {
                                ageMins: preScoredToken.ageMins || 0,
                                volume: preScoredToken.volume || 0,
                                liquidity: preScoredToken.liquidity || 0,
                                priceChangeM5: preScoredToken.priceChangeM5 || 0,
                                socials: preScoredToken.stats?.hasSocials ?? (preScoredToken.socials?.length > 0),
                                lpLock: preScoredToken.stats?.lpLock ?? { lockPct: 100, burned: true }
                            };
                        } else {
                            const { 
                                computeTokenScore, 
                                getModelScore, 
                                getSentimentScore, 
                                getDevReputation, 
                                checkLpLockStatus, 
                                trackHolderVelocity, 
                                simulateSellability 
                            } = await import('./caller.service.js');
                            const { checkTokenRugRisk, checkRecentMevActivity } = await import('./price.service.js');

                            const seen = getRecentNewMints().find((m: any) => m.mint === mintCa);
                            ageMins = seen ? (Date.now() - seen.firstSeenAt) / 60000 : 0;
                            const creatorWallet = seen?.creator || '';

                            if (mode === 'PUMP') {
                                const { getBondingCurveAddress } = await import('./price.service.js');
                                const curvePda = getBondingCurveAddress(mintCa);
                                const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
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
                                const res = await axiosClient.get(`https://api.dexscreener.com/latest/dex/tokens/${mintCa}`, { timeout: 2000 }).catch(() => null);
                                const pair = res?.data?.pairs?.[0];
                                if (pair) { liqUsd = pair.liquidity?.usd || 0; volUsd = pair.volume?.h24 || 0; priceChangeM5 = pair.priceChange?.m5 || 0; }
                            }

                            let isRug = false, hasMev = false;
                            let devRep: any = { launchCount: 0, avgRugScore: 0, isKnownRugger: false };
                            let lpLock: any = { locked: false, burned: false, lockPct: 0 };
                            let velocity: any = { growthRate: 0, uniqueBuyers5m: 0 };
                            let sellability: any = { sellable: true, estimatedTaxPct: 0 };

                            if (liveConfig.useDeepScoring) {
                                const HARD_CAP_MS = 500;
                                const deepCheckPromise = Promise.all([
                                    checkTokenRugRisk(mintCa).catch(() => true),
                                    getDevReputation(creatorWallet).catch(() => ({ isKnownRugger: true, launchCount: 0, avgRugScore: 0 })),
                                    checkRecentMevActivity(mintCa).catch(() => true)
                                ]);
                                const timeoutPromise = new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), HARD_CAP_MS));
            
                                const deepResult = await Promise.race([deepCheckPromise, timeoutPromise]);
            
                                if (deepResult === 'TIMEOUT') {
                                    console.warn(`⚠️ [DEEP-AUDIT TIMEOUT] Skipping snipe on ${mintCa}`);
                                    await redis.del(sniperLockKey);
                                    return;
                                }
            
                                const [isRugRes, devRepRes, hasMevRes] = deepResult as [boolean, any, boolean];
                                if (isRugRes || devRepRes?.isKnownRugger) {
                                    await redis.del(sniperLockKey);
                                    return;
                                }
                                
                                isRug = isRugRes;
                                devRep = devRepRes;
                                hasMev = hasMevRes;
                                
                                const subChecks = await Promise.all([
                                    checkLpLockStatus(mintCa).catch(() => ({ locked: false, burned: false, lockPct: 0 })),
                                    trackHolderVelocity(mintCa).catch(() => ({ growthRate: 0, uniqueBuyers5m: 0 })),
                                    mode === 'PUMP' ? Promise.resolve({ sellable: true, estimatedTaxPct: 0 }) : simulateSellability(mintCa).catch(() => ({ sellable: true, estimatedTaxPct: 0 }))
                                ]);
                                lpLock = subChecks[0];
                                velocity = subChecks[1];
                                sellability = subChecks[2];
                            }

                            const sentiment = await getSentimentScore(symbol);
                            const stats = { ageMins, volume24h: volUsd, liquidity: liqUsd, priceChangeM5, hasSocials: false, isRug, devRep, lpLock, velocity, sellability, sentiment };
                            const heuristicResult = computeTokenScore(stats);
                            score = heuristicResult.score;
                            auditReasons = heuristicResult.reasons || [];
                            auditStats = { ageMins, volume: volUsd, liquidity: liqUsd, priceChangeM5, socials: true, lpLock: lpLock || { lockPct: 100, burned: true } };

                            if (score < liveConfig.minScore) { await redis.del(sniperLockKey); return; }
                            
                            const useML = creditResult.success && !creditResult.fallback;
                            if (useML) {
                                const mlScore = await getModelScore(mintCa, stats);
                                if (mlScore !== null) score = mlScore;
                            }
                        }

                        // 🟢 FIX: Check threshold with raw, unclamped score!
                        const rawScore = score;
                        if (rawScore < liveConfig.minScore) { await redis.del(sniperLockKey); return; } 
                    } catch (e) { await redis.del(sniperLockKey); return; }
                }

                let snipeAmount = liveConfig.amountSol;
                if (liveConfig.enableDynamicScaling) {
                    let liveBal: number | undefined = undefined;
                    if (sniper.user.vaultAddress) {
                        const vaultPub = safePublicKey(sniper.user.vaultAddress);
                        if (vaultPub) {
                            liveBal = (await connection.getBalance(vaultPub).catch(() => 0)) / 1_000_000_000;
                        }
                    }
                    // 🟢 Pass the real, unclamped score to the dynamic scaling math
                    snipeAmount = calculateDynamicSize(liveConfig, score, liqUsd, cachedSolUsdPrice, liveBal);
                }

                const { getSessionSpend, addSessionSpend, sendBudgetExhaustedSummary, checkAndSendBudgetWarning } = await import('./simulation.service.js');
                const sessionId = await redis.get(`autosnipe:session_id:live:${liveConfig.user.telegramId}`);
                const currentSpendFinal = await getSessionSpend(liveConfig.user.telegramId, 'live');
                const intendedSpend = snipeAmount * (liveConfig.user.activeWallets || 1);

                if (liveConfig.maxBudgetSol && currentSpendFinal + intendedSpend > liveConfig.maxBudgetSol) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    await sendBudgetExhaustedSummary(bot, liveConfig.user.telegramId, 'live', sessionId);
                    await redis.del(sniperLockKey);
                    return; 
                }

                if (!isPriceReady) {
                    for (let i = 0; i < 7 && !isPriceReady; i++) await new Promise(r => setTimeout(r, 150));
                }

                const executionSlippage = liveConfig.useDeepScoring ? (liveConfig.user.slippagePercent + 5) : undefined;
                const result = await executeSnipe(
                    liveConfig.user.telegramId, mintCa, snipeAmount, 'buy', 
                    undefined, false, raydiumPoolId, executionSlippage, 0, undefined, 'Sniper Engine',
                    score
                );

                if (result.success) {
                    const spent = result.volumeSpent || intendedSpend;
                    
                    await addSessionSpend(liveConfig.user.telegramId, spent, 'live');
                    if (sessionId) {
                        await redis.rpush(`live:session_trades:${sessionId}`, JSON.stringify({ 
                            mint: mintCa, amountInSol: spent, realizedPnlSol: 0 
                        }));
                    }

                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { totalSpentSol: { increment: spent } } });

                    let entryPrice = await fetchLiveEntryPrice(mintCa);
                    if (entryPrice === 0 && mintCa.toLowerCase().endsWith("pump")) {
                        try {
                            const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
                            const curvePda = getBondingCurveAddress(mintCa);
                            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                            if (accInfo?.data) {
                                entryPrice = decodePumpCurvePrice(accInfo.data.toString('base64'));
                            }
                        } catch (_) {}
                    }

                    const { addTrailingStopToMemory } = await import('./order.service.js');
                    await addTrailingStopToMemory(
                        liveConfig.user.telegramId, mintCa, liveConfig.autoTrailingDropPercent,
                        snipeAmount, entryPrice || 0.00001, liveConfig.autoTakeProfitPercent || undefined,
                        undefined, 'Sniper Engine'
                    );

                    const updatedSpend = await getSessionSpend(liveConfig.user.telegramId, 'live');
                    checkAndSendBudgetWarning(bot, liveConfig.user.telegramId, 'live', updatedSpend, liveConfig.maxBudgetSol).catch(() => {});

                    if (liveConfig.maxBudgetSol && updatedSpend >= liveConfig.maxBudgetSol) {
                        await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                        await sendBudgetExhaustedSummary(bot, liveConfig.user.telegramId, 'live', sessionId);
                    }

                    try {
                        const finalMsg = buildSniperAuditMessage(
                            mintCa, 
                            Math.min(100, Math.max(0, Math.round(score))), // Safe 0-100 display
                            auditStats,
                            auditReasons, 
                            spent, 
                            liveConfig.autoTrailingDropPercent, 
                            liveConfig.autoTakeProfitPercent || 'OFF', 
                            'Sniper Engine',
                            result.signature || ''
                        );
                        await bot.telegram.sendMessage(liveConfig.user.telegramId, finalMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                    } catch (_) {}
                } else {
                    await redis.del(sniperLockKey);
                }
            } catch (e: any) {}
        }, delayMs);
    }
}

export async function igniteYellowstoneStream(bot: any) {
    if (!pollerStarted) {
        connectPumpPortalStream(bot);
        startPumpFunPolling();
        pollerStarted = true;
        logger.info("🟢 [SNIPER] PumpPortal WebSocket stream active.");
    }

    if (process.env.DISABLE_GRPC === 'true' || !HELIUS_KEY || isGrpcDisabled) {
        logger.warn("🟡 [gRPC] Yellowstone skipped. Raydium WS fallback armed.");
        connectRaydiumFallbackWatcher(bot);
        return;
    }

    try {
        const GrpcClient = (Client as any).default || Client;
        const client = new (GrpcClient as any)(GRPC_URL, HELIUS_KEY, {});
        const stream = await client.subscribe();

        stream.on("data", async (data: any) => {
            if (!data.transaction?.transaction) return;
            try {
                const tx = data.transaction.transaction;
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
                            logger.warn(`🚨 [ANTI-RUG] Dev liquidity pull detected on ${tokenMint}! Front-running for ${exposedUsers.length} users.`);
                            for (const order of exposedUsers) {
                                const { executeExit } = await import('./engine.service.js');
                                executeExit(order.user.telegramId, tokenMint, 100, true, 'Anti-Rug Shield');
                                bot.telegram.sendMessage(
                                    order.user.telegramId, 
                                    `🚨 <b>ANTI-RUG SHIELD ACTIVATED!</b>\n\nDeveloper liquidity pull detected on <code>${tokenMint}</code>. Emergency exit broadcasted.`, 
                                    { parse_mode: 'HTML' }
                                ).catch(() => {});
                            }
                        }
                    }
                }
            } catch (_) {}
        });

        stream.on("error", (err: any) => {
            if (err.message.includes("401") || err.message.includes("UNAUTHENTICATED") || err.message.includes("Free Tier")) {
                if (!isGrpcDisabled) {
                    logger.warn("🟡 [HELIUS FREE TIER] Yellowstone gRPC requires Growth plan. Engaging WS fallback.");
                    isGrpcDisabled = true;
                }
                try { stream.destroy(); } catch (_) {}
                connectRaydiumFallbackWatcher(bot);
                return;
            }
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
                pumpfun: { accountInclude: [PUMP_FUN_PROGRAM], accountExclude: [], accountRequired: [] },
                raydium: { accountInclude: [RAYDIUM_AMM_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_dlmm: { accountInclude: [METEORA_DLMM_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_dbc: { accountInclude: [METEORA_DBC_PROGRAM], accountExclude: [], accountRequired: [] },
                meteora_damm: { accountInclude: [METEORA_DAMM_V2_PROGRAM], accountExclude: [], accountRequired: [] }
            },
            transactionsStatus: {}, 
            blocks: {}, 
            blocksMeta: {}, 
            entry: {}, 
            commitment: 1, 
            accountsDataSlice: []
        };

        stream.write(request);
        logger.info("🟢 [gRPC] Yellowstone stream connected — Helius gRPC Active.");

    } catch (e: any) {
        if (!isGrpcDisabled) {
            logger.warn("🟡 [HELIUS gRPC] Initial connection failed. Arming Raydium WS fallback.");
            isGrpcDisabled = true;
            connectRaydiumFallbackWatcher(bot);
        }
    }
}