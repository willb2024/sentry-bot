// src/services/copytrade.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { prisma } from '../lib/prisma.js';
import { executeSnipe, executeExit, getCachedTokenPrice } from './engine.service.js'; 
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { logger } from '../lib/logger.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const activeWsListeners = new Map<string, number>();

export function shutdownCopyTradeWatchers() {
    console.log("🛑 [COPY-TRADE] Cleaning up orphaned WebSocket listeners...");
    for (const [walletStr, subId] of activeWsListeners.entries()) {
        try {
            connection.removeOnLogsListener(subId);
        } catch (e: any) {}
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

        const targetWallets = [...new Set(activeConfigs.map(c => c.targetWallet))];

        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.includes(walletStr)) {
                try { 
                    connection.removeOnLogsListener(subId); 
                } catch (e: any) {
                    console.warn(`⚠️ [COPY-TRADE] Failed to teardown subId ${subId}:`, e.message);
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

                        const relevantPrograms = ['pump', 'Raydium', 'whirlpool', 'Meteora', 'Jupiter', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'];
                        const isRelevant = logs.logs.some(l => relevantPrograms.some(p => l.toLowerCase().includes(p.toLowerCase())));
                        if (!isRelevant) return;

                        const signature = logs.signature;
                        const txDetails = await connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        }).catch(() => null);

                        if (!txDetails || !txDetails.meta || txDetails.meta.err) return;

                        const preBalances = txDetails.meta.preTokenBalances || [];
                        const postBalances = txDetails.meta.postTokenBalances || [];
                        
                        const tradeLegs: Array<{ mint: string; type: 'buy' | 'sell'; sellPercentage: number }> = [];

                        for (const post of postBalances) {
                            if (post.owner === walletStr) {
                                if (post.mint === "So11111111111111111111111111111111111111112") continue;

                                const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
                                const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount) : 0;
                                const postAmt = Number(post.uiTokenAmount.uiAmount);
                                
                                if (postAmt > preAmt) {
                                    tradeLegs.push({ mint: post.mint, type: 'buy', sellPercentage: 0 });
                                } else if (postAmt < preAmt && preAmt > 0) {
                                    const sellPercentage = ((preAmt - postAmt) / preAmt) * 100;
                                    tradeLegs.push({ mint: post.mint, type: 'sell', sellPercentage });
                                }
                            }
                        }

                        if (tradeLegs.length === 0) return;

                        const freshConfigs = await prisma.copyTradeConfig.findMany({
                            where: { targetWallet: walletStr, isActive: true },
                            include: { user: true }
                        });

                        for (const leg of tradeLegs) {
                            if (leg.type === 'buy') {
                                const entryPrice = await fetchLiveEntryPrice(leg.mint);

                                for (const follower of freshConfigs) {
                                    const f: any = follower; 
                                    if (f.copyBuys === false) continue;
                                    const sizeToTrade = f.maxTradeSizeSol ? Math.min(f.tradeAmountSol, f.maxTradeSizeSol) : f.tradeAmountSol;

                                    executeSnipe(
                                        follower.user.telegramId,
                                        leg.mint,
                                        sizeToTrade,
                                        'buy',
                                        undefined,
                                        false,
                                        undefined,
                                        f.slippagePercent || undefined,
                                        0,
                                        undefined,
                                        'Copy Trade'
                                    ).then(async (res) => {
                                        if (res.success) {
                                            try {
                                                await addTrailingStopToMemory(
                                                    follower.user.telegramId,
                                                    leg.mint,
                                                    follower.autoTrailingDropPercent,
                                                    sizeToTrade,
                                                    entryPrice,
                                                    follower.autoTakeProfitPercent || undefined,
                                                    undefined,
                                                    'Copy Trade'
                                                );
                                            } catch (guardErr) {}
                                            try { 
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId, 
                                                    `👥 <b>COPY TRADE: BUY SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nToken: <code>${leg.mint}</code>\nInvested: <b>${sizeToTrade} SOL</b>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, 
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                ); 
                                            } catch (_) {}
                                        }
                                    }).catch((err) => {
                                        logger.error('Copy-trade buy execution threw unexpectedly', { error: err.message, wallet: walletStr, telegramId: follower.user.telegramId });
                                    });
                                }
                            } 
                            else if (leg.type === 'sell' && leg.sellPercentage >= 1) {
                                for (const follower of freshConfigs) {
                                    const f: any = follower; 
                                    if (f.copySells === false) continue;

                                    executeExit(
                                        follower.user.telegramId,
                                        leg.mint,
                                        leg.sellPercentage,
                                        false,
                                        'Copy Trade'
                                    ).then(async (res) => {
                                        if (res.success) {
                                            try { 
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId, 
                                                    `👥 <b>COPY TRADE: SELL SUCCESSFUL!</b>\nTarget: <code>${walletStr.substring(0, 8)}...</code>\nWhale Sold: <b>${leg.sellPercentage.toFixed(1)}%</b> of <code>${leg.mint}</code>\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, 
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