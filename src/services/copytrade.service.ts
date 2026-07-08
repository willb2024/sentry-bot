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
                    let purchasedTokenMint: string | null = null;

                    for (const post of postBalances) {
                        if (post.owner === walletStr) {
                            const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                            const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount) : 0;
                            const postAmt = Number(post.uiTokenAmount.uiAmount);
                            if (postAmt > preAmt) {
                                purchasedTokenMint = post.mint;
                                break;
                            }
                        }
                    }

                    if (purchasedTokenMint && purchasedTokenMint !== "So11111111111111111111111111111111111111112") {
                        console.log(`🎯 [COPY-TRADE] Whale ${walletStr.substring(0,6)} bought: ${purchasedTokenMint}.`);

                        const freshConfigs = await prisma.copyTradeConfig.findMany({
                            where: { targetWallet: walletStr, isActive: true },
                            include: { user: true }
                        });

                        const entryPrice = await fetchLiveEntryPrice(purchasedTokenMint);

                        const channelId = process.env.WHALE_ALERT_CHANNEL_ID;
                        if (channelId) {
                            const cooldownKey = `ct_alert_cooldown:${walletStr}`;
                            const isOnCooldown = await redis.get(cooldownKey);

                            if (!isOnCooldown) {
                                await redis.set(cooldownKey, '1', 'EX', 60);

                                const botUsername = bot.botInfo?.username || 'lightningsnipe_bot';
                                const message =
                                    `🚨 <b>SMART MONEY WHALE ALERT [SOL]</b> 🚨\n\n` +
                                    `🐋 <b>Whale Wallet:</b> <code>${walletStr}</code>\n` +
                                    `🪙 <b>Bought Token:</b> <code>${purchasedTokenMint}</code>\n` +
                                    `⚡ <b>Transaction:</b> <a href="https://solscan.io/tx/${signature}">View on Solscan</a>`;

                                await bot.telegram.sendMessage(channelId, message, {
                                    parse_mode: 'HTML',
                                    link_preview_options: { is_disabled: true },
                                    reply_markup: {
                                        inline_keyboard: [[
                                            { 
                                                text: '⚡ Copy This Whale Automatically', 
                                                url: `https://t.me/${botUsername}?start=ct_${walletStr}` 
                                            }
                                        ]]
                                    }
                                }).catch((e: any) => console.warn(`⚠️ [COPY-TRADE] Whale alert send failed: ${e.message}`));
                            }
                        }

                        for (const follower of freshConfigs) {
                            executeSnipe(follower.user.telegramId, purchasedTokenMint!, follower.tradeAmountSol)
                                .then(async (res) => {
                                    if (res.success) {
                                        try {
                                            await addTrailingStopToMemory(
                                                follower.user.telegramId,
                                                purchasedTokenMint!,
                                                follower.autoTrailingDropPercent,
                                                follower.tradeAmountSol,
                                                entryPrice,
                                                follower.autoTakeProfitPercent || undefined
                                            );
                                        } catch (guardErr: any) {
                                            console.error(`🔴 [COPY-TRADE] Failed to arm guard for ${follower.user.telegramId}: ${guardErr.message}`);
                                            await bot.telegram.sendMessage(
                                                follower.user.telegramId,
                                                `⚠️ <b>Copy trade filled but Guard failed to arm!</b>\nPlease set a stop-loss manually for <code>${purchasedTokenMint}</code>.`,
                                                { parse_mode: 'HTML' }
                                            ).catch(() => null);
                                        }
                                        
                                        try {
                                            await bot.telegram.sendMessage(
                                                follower.user.telegramId,
                                                `👥 <b>COPY TRADE SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nBought Token: <code>${purchasedTokenMint}</code>\nInvested: <b>${follower.tradeAmountSol} SOL</b>${entryPrice > 0 ? `\nEntry Price: <b>${entryPrice.toFixed(8)} SOL</b>` : ''}\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                            );
                                        } catch (_) {}
                                    }
                                })
                                .catch((e: any) => console.error(`🔴 [COPY-TRADE] Snipe failed for follower ${follower.user.telegramId}: ${e.message}`));
                        }
                    }
                }, 'processed');

                activeWsListeners.set(walletStr, subId);
            }
        }

        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.includes(walletStr)) {
                try {
                    connection.removeOnLogsListener(subId);
                } catch (e: any) {
                    console.warn(`⚠️ [COPY-TRADE] Failed to remove listener for ${walletStr}: ${e.message}`);
                } finally {
                    activeWsListeners.delete(walletStr);
                }
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