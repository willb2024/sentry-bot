// src/services/copytrade.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { executeSnipe, executeExit, getCachedTokenPrice } from './engine.service.js'; 
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { isSimulationActive, simExecuteSnipe, simExecuteExit } from './simulation.service.js';
import { keepAliveHttpsAgent } from '../lib/http-agent.js';
import { logger } from '../lib/logger.js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export const activeWsListeners = new Map<string, number>();

export function shutdownCopyTradeWatchers() {
    for (const [walletStr, subId] of activeWsListeners.entries()) {
        try {
            connection.removeOnLogsListener(subId);
        } catch (_) {}
        activeWsListeners.delete(walletStr);
    }
}

async function fetchLiveEntryPrice(tokenAddress: string): Promise<number> {
    try {
        const cachedPrice = await getCachedTokenPrice(tokenAddress);
        if (cachedPrice > 0) return cachedPrice;
    } catch (_) {}

    try {
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${tokenAddress}`, { 
            timeout: 1500,
            httpsAgent: keepAliveHttpsAgent
        });
        const p = res.data?.data?.[tokenAddress]?.price;
        if (p) return parseFloat(p);
    } catch (_) {}

    if (tokenAddress.toLowerCase().endsWith("pump")) {
        try {
            const curvePda = getBondingCurveAddress(tokenAddress);
            const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
            if (accInfo?.data) {
                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                return decodePumpCurvePrice(buf.toString('base64'));
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

        // Track all multi-wallets (W1-W5) of active Social Leaders
        const activeLeaders = await prisma.copyTradeFollow.findMany({
            where: { isActive: true },
            include: {
                leader: { 
                    select: { 
                        id: true, 
                        username: true, 
                        vaultAddress: true, 
                        vault2: true, 
                        vault3: true, 
                        vault4: true, 
                        vault5: true, 
                        activeWallets: true 
                    } 
                },
                follower: true
            }
        });

        const targetWallets = new Set<string>();
        activeConfigs.forEach(c => targetWallets.add(c.targetWallet));
        
        activeLeaders.forEach(f => {
            const l = f.leader;
            const n = l.activeWallets ?? 1;
            if (l.vaultAddress) targetWallets.add(l.vaultAddress);
            if (n >= 2 && l.vault2) targetWallets.add(l.vault2);
            if (n >= 3 && l.vault3) targetWallets.add(l.vault3);
            if (n >= 4 && l.vault4) targetWallets.add(l.vault4);
            if (n >= 5 && l.vault5) targetWallets.add(l.vault5);
        });

        // Tear down listeners for inactive targets
        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.has(walletStr)) {
                try { 
                    connection.removeOnLogsListener(subId); 
                } catch (_) {}
                activeWsListeners.delete(walletStr);
            }
        }

        // Subscribe to all target wallets
        for (const walletStr of targetWallets) {
            if (activeWsListeners.has(walletStr)) continue;

            try {
                const pubKey = new PublicKey(walletStr);

                const subId = connection.onLogs(pubKey, async (logs) => {
                    if (logs.err) return;

                    const relevantPrograms = ['pump', 'Raydium', 'whirlpool', 'Meteora', 'Jupiter', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'];
                    const isRelevant = logs.logs.some(l => relevantPrograms.some(p => l.toLowerCase().includes(p.toLowerCase())));
                    if (!isRelevant) return;

                    const signature = logs.signature;
                    const dedupeKey = `lock:copytrade_sig:${signature}`;
                    const isFirstProcess = await redis.set(dedupeKey, '1', 'EX', 120, 'NX');
                    if (!isFirstProcess) return;

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

                    // Direct custom config copiers
                    const directCopiers = await prisma.copyTradeConfig.findMany({
                        where: { targetWallet: walletStr, isActive: true },
                        include: { user: true }
                    });

                    // Match leader across any of their active multi-wallets
                    const leaderUser = await prisma.user.findFirst({
                        where: {
                            OR: [
                                { vaultAddress: walletStr },
                                { vault2: walletStr },
                                { vault3: walletStr },
                                { vault4: walletStr },
                                { vault5: walletStr }
                            ]
                        }
                    });

                    const socialFollowers = leaderUser ? await prisma.copyTradeFollow.findMany({
                        where: { leaderId: leaderUser.id, isActive: true },
                        include: { follower: true }
                    }) : [];

                    for (const leg of tradeLegs) {
                        if (leg.type === 'buy') {
                            // 1. Mirror Direct Custom Copiers
                            for (const follower of directCopiers) {
                                if (follower.copyBuys === false) continue;
                                const sizeToTrade = follower.maxTradeSizeSol 
                                    ? Math.min(follower.tradeAmountSol, follower.maxTradeSizeSol) 
                                    : follower.tradeAmountSol;

                                const isSim = await isSimulationActive(follower.user.telegramId);

                                if (isSim) {
                                    simExecuteSnipe(
                                        follower.user.telegramId,
                                        leg.mint,
                                        sizeToTrade,
                                        'Copy Trade',
                                        80,
                                        follower.autoTrailingDropPercent,
                                        follower.autoTakeProfitPercent || undefined
                                    ).then(async (res) => {
                                        if (res.success) {
                                            try {
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId,
                                                    `👥 <b>COPY TRADE: BUY CONFIRMED! (SIM)</b>\n` +
                                                    `Target: <code>${walletStr.substring(0, 8)}...</code>\n` +
                                                    `Token: <code>${leg.mint}</code>\n` +
                                                    `Invested: <b>${sizeToTrade} SOL</b>\n` +
                                                    `🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`,
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                );
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                                } else {
                                    executeSnipe(
                                        follower.user.telegramId,
                                        leg.mint,
                                        sizeToTrade,
                                        'buy',
                                        undefined,
                                        false,
                                        undefined,
                                        follower.slippagePercent || undefined,
                                        0,
                                        undefined,
                                        'Copy Trade'
                                    ).then(async (res) => {
                                        if (res.success) {
                                            const followerEntry = (res as any).executedPriceUsd
                                                ?? (res as any).avgPriceNative
                                                ?? await fetchLiveEntryPrice(leg.mint);

                                            await addTrailingStopToMemory(
                                                follower.user.telegramId,
                                                leg.mint,
                                                follower.autoTrailingDropPercent,
                                                sizeToTrade,
                                                followerEntry,
                                                follower.autoTakeProfitPercent || undefined,
                                                undefined,
                                                'Copy Trade'
                                            ).catch(() => {});
                                            
                                            try { 
                                                await bot.telegram.sendMessage(
                                                    follower.user.telegramId, 
                                                    `👥 <b>COPY TRADE: BUY CONFIRMED!</b>\n` +
                                                    `Target: <code>${walletStr.substring(0, 8)}...</code>\n` +
                                                    `Token: <code>${leg.mint}</code>\n` +
                                                    `Invested: <b>${sizeToTrade} SOL</b>\n` +
                                                    `🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, 
                                                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                                                ); 
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                                }
                            }

                            // 2. Mirror Social Feed Followers
                            for (const f of socialFollowers) {
                                const followerTgId = f.follower.telegramId;
                                const isSim = await isSimulationActive(followerTgId);
                                const defaultSize = 0.1;
                                const followerSlippage = f.follower.slippagePercent || 20.0;

                                if (isSim) {
                                    simExecuteSnipe(followerTgId, leg.mint, defaultSize, 'Copy Trade', 80, 15, 50).then(async (res) => {
                                        if (res.success) {
                                            try {
                                                await bot.telegram.sendMessage(
                                                    followerTgId,
                                                    `📡 <b>LEADER TRADE COPIED! (SIM)</b>\nLeader: @${leaderUser?.username || 'Trader'}\nToken: <code>${leg.mint}</code>\nInvested: <b>${defaultSize} SOL</b>`,
                                                    { parse_mode: 'HTML' }
                                                );
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                                } else {
                                    executeSnipe(
                                        followerTgId, 
                                        leg.mint, 
                                        defaultSize, 
                                        'buy', 
                                        undefined, 
                                        false, 
                                        undefined, 
                                        followerSlippage, 
                                        0, 
                                        undefined, 
                                        'Copy Trade'
                                    ).then(async (res) => {
                                        if (res.success) {
                                            const followerEntry = (res as any).executedPriceUsd
                                                ?? (res as any).avgPriceNative
                                                ?? await fetchLiveEntryPrice(leg.mint);

                                            await addTrailingStopToMemory(followerTgId, leg.mint, 15, defaultSize, followerEntry, 50, undefined, 'Copy Trade').catch(() => {});
                                            try {
                                                await bot.telegram.sendMessage(
                                                    followerTgId,
                                                    `📡 <b>LEADER TRADE COPIED!</b>\nLeader: @${leaderUser?.username || 'Trader'}\nToken: <code>${leg.mint}</code>\nInvested: <b>${defaultSize} SOL</b>`,
                                                    { parse_mode: 'HTML' }
                                                );
                                            } catch (_) {}
                                        }
                                    }).catch(() => {});
                                }
                            }
                        } else if (leg.type === 'sell' && leg.sellPercentage >= 1) {
                            // Mirror sells to Direct Copiers
                            for (const follower of directCopiers) {
                                if (follower.copySells === false) continue;
                                const isSim = await isSimulationActive(follower.user.telegramId);

                                if (isSim) {
                                    simExecuteExit(follower.user.telegramId, leg.mint, leg.sellPercentage, undefined, 'Copy Trade').catch(() => {});
                                } else {
                                    executeExit(follower.user.telegramId, leg.mint, leg.sellPercentage, false, 'Copy Trade').catch(() => {});
                                }
                            }

                            // Mirror sells to Social Followers
                            for (const f of socialFollowers) {
                                const followerTgId = f.follower.telegramId;
                                const isSim = await isSimulationActive(followerTgId);

                                if (isSim) {
                                    simExecuteExit(followerTgId, leg.mint, leg.sellPercentage, undefined, 'Copy Trade').catch(() => {});
                                } else {
                                    executeExit(followerTgId, leg.mint, leg.sellPercentage, false, 'Copy Trade').catch(() => {});
                                }
                            }
                        }
                    }
                }, 'processed');

                activeWsListeners.set(walletStr, subId);
            } catch (e: any) {
                logger.error(`[COPYTRADE] Failed to subscribe to ${walletStr}:`, { error: e.message });
            }
        }
    } catch (e: any) { 
        logger.error(`🔴 [COPY-TRADE] Sync Fault: ${e.message}`); 
    }
}

export async function startCopyTradeWatcher(bot: any) {
    console.log("👀 [COPY-TRADE] Zero-RPC WebSocket Watcher Initialized.");
    await syncCopyTradeListeners(bot);
    if (global._sentryIntervals) {
        global._sentryIntervals.push(setInterval(() => {
            syncCopyTradeListeners(bot);
        }, 30000));
    }
}