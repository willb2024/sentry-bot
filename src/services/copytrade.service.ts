// src/services/copytrade.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { prisma } from '../lib/prisma.js';
import { executeSnipe, executeExit, getCachedTokenPrice } from './engine.service.js'; 
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { redis } from '../lib/redis.js';
import axios from 'axios';
import dotenv from 'dotenv';
import { isSimulationActive } from './simulation.service.js';

dotenv.config();

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
    try {
        const cachedPrice = await getCachedTokenPrice(tokenAddress);
        if (cachedPrice > 0) return cachedPrice;
    } catch (_) {}

    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 2000 });
        const pair = res.data?.pairs?.[0];
        if (pair?.priceUsd) {
            return parseFloat(pair.priceUsd);
        }
    } catch (_) {}

    if (tokenAddress.toLowerCase().endsWith("pump")) {
        try {
            const curvePda = getBondingCurveAddress(tokenAddress);
            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
            if (accInfo?.data) {
                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                const curvePrice = decodePumpCurvePrice(buf.toString('base64'));
                if (curvePrice > 0) return curvePrice;
            }
        } catch (_) {}
    }
    return 0;
}

export async function syncCopyTradeListeners(bot: any) {
    try {
        const activeConfigs = await prisma.copyTradeConfig.findMany({
            where: { isActive: true },
            include: { user: true }
        });

        // 🟢 FIX: Filter out users who are in SIMULATION MODE to protect live funds
        const filteredConfigs = [];
        for (const config of activeConfigs) {
            if (!(await isSimulationActive(config.user.telegramId))) {
                filteredConfigs.push(config);
            }
        }

        const targetWallets = [...new Set(filteredConfigs.map(c => c.targetWallet))];

        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.includes(walletStr)) {
                try { 
                    connection.removeOnLogsListener(subId); 
                } catch (e) {
                    console.warn(`⚠️ [COPY-TRADE] Failed to teardown subId ${subId}:`, e);
                }
                activeWsListeners.delete(walletStr);
            }
        }

        for (const walletStr of targetWallets) {
            if (!activeWsListeners.has(walletStr)) {
                try {
                    const pubKey = new PublicKey(walletStr);

                    const subId = connection.onLogs(pubKey, async (logs) => {
                        if (logs.err) return;

                        const signature = logs.signature;
                        const txDetails = await connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
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

                            if (tradeType === 'buy') {
                                const entryPrice = await fetchLiveEntryPrice(targetTokenMint);

                                for (const follower of freshConfigs) {
                                    if (await isSimulationActive(follower.user.telegramId)) continue;
                                    const f: any = follower; 
                                    if (f.copyBuys === false) continue;
                                    const sizeToTrade = f.maxTradeSizeSol ? Math.min(f.tradeAmountSol, f.maxTradeSizeSol) : f.tradeAmountSol;

                                    executeSnipe(follower.user.telegramId, targetTokenMint, sizeToTrade, 'buy', undefined, false, undefined, f.slippagePercent || undefined, 0, undefined, 'Copy Trade'// 🟢 Exact match
                                    ).then(async (res) =>{
                                        if (res.success) {
                                            try {
                                                await addTrailingStopToMemory(
                                                    follower.user.telegramId,
                                                    targetTokenMint!,
                                                    follower.autoTrailingDropPercent,
                                                    sizeToTrade,
                                                    entryPrice,
                                                    follower.autoTakeProfitPercent || undefined,
                                                    undefined,
                                                    'Copy Trade' // 🟢 Pass 'Copy Trade'
                                                );
                                            } catch (guardErr) {}
                                            try { 
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId, 
                                                    `👥 <b>COPY TRADE: BUY SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nToken: <code>${targetTokenMint}</code>\nInvested: <b>${sizeToTrade} SOL</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, 
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                ); 
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                                }
                            } 
                            else if (tradeType === 'sell' && sellPercentage >= 1) {
                                for (const follower of freshConfigs) {
                                    if (await isSimulationActive(follower.user.telegramId)) continue;
                                    const f: any = follower; 
                                    if (f.copySells === false) continue;

                                    executeExit(follower.user.telegramId, targetTokenMint, sellPercentage, false, 'Copy Trade' // 🟢 Exact match
                                    ).then(async (res) => {
                                        if (res.success) {
                                            try { 
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId, 
                                                    `👥 <b>COPY TRADE: SELL SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nWhale Sold: <b>${sellPercentage.toFixed(1)}%</b> of <code>${targetTokenMint}</code>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, 
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
                } catch (e: any) {
                    console.error(`[COPYTRADE] Failed to subscribe to ${walletStr}:`, e.message);
                }
            }
        }
    } catch (e: any) { 
        console.error(`🔴 [COPY-TRADE] Sync Fault: ${e.message}`); 
    }
}

export async function startCopyTradeWatcher(bot: any) {
    console.log("👀 [COPY-TRADE] Zero-RPC WebSocket Watcher Initialized.");
    await syncCopyTradeListeners(bot);
    setInterval(() => {
        syncCopyTradeListeners(bot);
    }, 30000);
}