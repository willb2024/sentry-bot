// src/services/copytrade.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { PrismaClient } from '@prisma/client';
import { executeSnipe, getCachedTokenPrice } from './engine.service.js'; // 🟢 FIX: Import cached price helper
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { redis } from '../lib/redis.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const activeWsListeners = new Map<string, number>();

export function shutdownCopyTradeWatchers() {
    console.log("🛑 [COPY-TRADE] Cleaning up orphaned WebSocket listeners...");
    for (const [walletStr, subId] of activeWsListeners.entries()) {
        try {
            connection.removeOnLogsListener(subId);
        } catch (e) {}
        activeWsListeners.delete(walletStr);
    }
}

async function fetchLiveEntryPrice(tokenAddress: string): Promise<number> {
    // 🟢 FIX: Use fast redis cached lookup instead of raw Jupiter API calls
    try {
        const cachedPrice = await getCachedTokenPrice(tokenAddress);
        if (cachedPrice > 0) return cachedPrice;
    } catch (e: any) {
        console.warn(`⚠️ [COPY-TRADE] Cached price fetch failed for ${tokenAddress}: ${e.message}`);
    }

    if (tokenAddress.toLowerCase().endsWith("pump")) {
        try {
            const curvePda = getBondingCurveAddress(tokenAddress);
            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
            if (accInfo?.data) {
                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                const curvePrice = decodePumpCurvePrice(buf.toString('base64'));
                if (curvePrice > 0) return curvePrice;
            }
        } catch (e: any) {
            console.warn(`⚠️ [COPY-TRADE] Pump curve read failed for ${tokenAddress}: ${e.message}`);
        }
    }
    return 0;
}

// Replace this function in src/services/copytrade.service.ts
export async function syncCopyTradeListeners(bot: any) {
    try {
        const activeConfigs = await prisma.copyTradeConfig.findMany({
            where: { isActive: true },
            include: { user: true }
        });
        const targetWallets = [...new Set(activeConfigs.map(c => c.targetWallet))];

        for (const walletStr of targetWallets) {
            if (!activeWsListeners.has(walletStr)) {
                const pubKey = new PublicKey(walletStr);

                const subId = connection.onLogs(pubKey, async (logs) => {
                    if (logs.err) return;

                    const signature = logs.signature;
                    const txDetails = await connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0
                    }).catch(() => null);

                    if (!txDetails || !txDetails.meta || txDetails.meta.err) return;

                    const preBalances = txDetails.meta.preTokenBalances || [];
                    const postBalances = txDetails.meta.postTokenBalances || [];
                    
                    let targetTokenMint: string | null = null;
                    let tradeType: 'buy' | 'sell' | null = null;
                    let sellPercentage = 0;

                    for (const post of postBalances) {
                        if (post.owner === walletStr) {
                            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                            const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount) : 0;
                            const postAmt = Number(post.uiTokenAmount.uiAmount);
                            
                            if (postAmt > preAmt) {
                                tradeType = 'buy';
                                targetTokenMint = post.mint;
                                break;
                            } else if (postAmt < preAmt && preAmt > 0) {
                                tradeType = 'sell';
                                targetTokenMint = post.mint;
                                sellPercentage = ((preAmt - postAmt) / preAmt) * 100;
                                break;
                            }
                        }
                    }

                    if (targetTokenMint && targetTokenMint !== "So11111111111111111111111111111111111111112") {
                        const freshConfigs = await prisma.copyTradeConfig.findMany({
                            where: { targetWallet: walletStr, isActive: true },
                            include: { user: true }
                        });

                        // 🟢 FIX: Handle Buy Mirroring
                        if (tradeType === 'buy') {
                            console.log(`🎯 [COPY-TRADE] Whale ${walletStr.substring(0,6)} BOUGHT: ${targetTokenMint}.`);
                            const entryPrice = await fetchLiveEntryPrice(targetTokenMint);

                            for (const follower of freshConfigs) {
                                executeSnipe(follower.user.telegramId, targetTokenMint, follower.tradeAmountSol)
                                    .then(async (res) => {
                                        if (res.success) {
                                            try {
                                                await addTrailingStopToMemory(
                                                    follower.user.telegramId, targetTokenMint!,
                                                    follower.autoTrailingDropPercent, follower.tradeAmountSol,
                                                    entryPrice, follower.autoTakeProfitPercent || undefined
                                                );
                                            } catch (guardErr) {}
                                            
                                            try {
                                                await bot.telegram.sendMessage(follower.user.telegramId,
                                                    `👥 <b>COPY TRADE: BUY SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nBought Token: <code>${targetTokenMint}</code>\nInvested: <b>${follower.tradeAmountSol} SOL</b>\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                );
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                            }
                        } 
                        // 🟢 NEW: Handle Sell Mirroring
                        else if (tradeType === 'sell' && sellPercentage >= 1) {
                            console.log(`🎯 [COPY-TRADE] Whale ${walletStr.substring(0,6)} SOLD ${sellPercentage.toFixed(1)}% of: ${targetTokenMint}.`);
                            
                            // Dynamically import executeExit to avoid circular dependency
                            const { executeExit } = await import('./engine.service.js');

                            for (const follower of freshConfigs) {
                                executeExit(follower.user.telegramId, targetTokenMint, sellPercentage)
                                    .then(async (res) => {
                                        if (res.success) {
                                            try {
                                                await bot.telegram.sendMessage(follower.user.telegramId,
                                                    `👥 <b>COPY TRADE: SELL SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nWhale Sold: <b>${sellPercentage.toFixed(1)}%</b> of <code>${targetTokenMint}</code>\n<i>Sentry has automatically mirrored this exit.</i>\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                );
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                            }
                        }
                    }
                }, 'processed');

                activeWsListeners.set(walletStr, subId);
            }
        }

        // Cleanup orphaned listeners
        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.includes(walletStr)) {
                try { connection.removeOnLogsListener(subId); } catch (e) {}
                finally { activeWsListeners.delete(walletStr); }
            }
        }
    } catch (e: any) {
        console.error(`🔴 [COPY-TRADE] Sync Listeners Fault: ${e.message}`);
    }
}

export async function startCopyTradeWatcher(bot: any) {
    console.log("👀 [COPY-TRADE] Zero-RPC WebSocket Watcher Initialized.");
    await syncCopyTradeListeners(bot);
    setInterval(() => {
        syncCopyTradeListeners(bot);
    }, 30000);
}

export async function scoreWallet(walletAddress: string): Promise<{ score: number, isBot: boolean, message: string }> {
    try {
        const apiKey = process.env.HELIUS_API_KEY;
        if (!apiKey) return { score: 50, isBot: false, message: "Helius API key missing. Score estimated." };

        const res = await axios.get(`https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=20&type=SWAP`, { timeout: 4000 });
        const txs = res.data;

        if (!txs || txs.length < 5) {
            return { score: 30, isBot: false, message: "Low activity. This wallet rarely trades." };
        }

        let totalTimeDiff = 0;
        let rapidTrades = 0;

        for (let i = 0; i < txs.length - 1; i++) {
            const timeDiff = txs[i].timestamp - txs[i+1].timestamp;
            totalTimeDiff += timeDiff;
            if (timeDiff < 15) rapidTrades++; 
        }

        const avgHoldTime = totalTimeDiff / (txs.length - 1);
        const isBot = rapidTrades > 10 || avgHoldTime < 30;

        let score = 100;
        if (isBot) score -= 80;
        else if (avgHoldTime > 3600) score -= 10;

        return {
            score: Math.max(10, score),
            isBot,
            message: isBot 
                ? "⚠️ HIGH BOT PROBABILITY: Average trade gap is under 30s. Copying this wallet may result in MEV sandwich losses."
                : "✅ HUMAN TRADER: Transaction pacing looks organic."
        };
    } catch (e) {
        return { score: 50, isBot: false, message: "Could not fetch deep analytics." };
    }
}