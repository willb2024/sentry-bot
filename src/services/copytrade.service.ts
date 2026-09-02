// src/services/copytrade.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { executeSnipe, executeExit, getCachedTokenPrice } from './engine.service.js'; 
import { addTrailingStopToMemory } from './order.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import { isSimulationActive, simExecuteSnipe, simExecuteExit } from './simulation.service.js';
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
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${tokenAddress}`, { timeout: 1500 });
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

        // Also track wallets of active Social Leaders
        const activeLeaders = await prisma.copyTradeFollow.findMany({
            where: { isActive: true },
            include: { leader: true, follower: true }
        });

        const targetWallets = new Set<string>();
        activeConfigs.forEach(c => targetWallets.add(c.targetWallet));
        activeLeaders.forEach(f => {
            if (f.leader.vaultAddress) targetWallets.add(f.leader.vaultAddress);
        });

        // Tear down dead listeners
        for (const [walletStr, subId] of activeWsListeners.entries()) {
            if (!targetWallets.has(walletStr)) {
                try { 
                    connection.removeOnLogsListener(subId); 
                } catch (_) {}
                activeWsListeners.delete(walletStr);
            }
        }

        // Subscribe to new target wallets
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

                    // Fetch direct custom config copiers
                    const directCopiers = await prisma.copyTradeConfig.findMany({
                        where: { targetWallet: walletStr, isActive: true },
                        include: { user: true }
                    });

                    // Fetch social trade-feed followers
                    const leaderUser = await prisma.user.findFirst({ where: { vaultAddress: walletStr } });
                    const socialFollowers = leaderUser ? await prisma.copyTradeFollow.findMany({
                        where: { leaderId: leaderUser.id, isActive: true },
                        include: { follower: true }
                    }) : [];

                    for (const leg of tradeLegs) {
                        if (leg.type === 'buy') {
                            const entryPrice = await fetchLiveEntryPrice(leg.mint);

                            // Execute direct copiers
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
                                    ).catch(() => {});
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
                                            await addTrailingStopToMemory(
                                                follower.user.telegramId,
                                                leg.mint,
                                                follower.autoTrailingDropPercent,
                                                sizeToTrade,
                                                entryPrice,
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

                            // Execute social followers (default 0.1 SOL unless customized)
                            for (const f of socialFollowers) {
                                const followerTgId = f.follower.telegramId;
                                const isSim = await isSimulationActive(followerTgId);
                                const defaultSize = 0.1;

                                if (isSim) {
                                    simExecuteSnipe(followerTgId, leg.mint, defaultSize, 'Copy Trade', 80, 15, 50).catch(() => {});
                                } else {
                                    executeSnipe(followerTgId, leg.mint, defaultSize, 'buy', undefined, false, undefined, undefined, 0, undefined, 'Copy Trade').then(async (res) => {
                                        if (res.success) {
                                            await addTrailingStopToMemory(followerTgId, leg.mint, 15, defaultSize, entryPrice, 50, undefined, 'Copy Trade').catch(() => {});
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
                            // Execute sells for all copiers
                            for (const follower of directCopiers) {
                                if (follower.copySells === false) continue;
                                const isSim = await isSimulationActive(follower.user.telegramId);

                                if (isSim) {
                                    simExecuteExit(follower.user.telegramId, leg.mint, leg.sellPercentage, undefined, 'Copy Trade').catch(() => {});
                                } else {
                                    executeExit(follower.user.telegramId, leg.mint, leg.sellPercentage, false, 'Copy Trade').catch(() => {});
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