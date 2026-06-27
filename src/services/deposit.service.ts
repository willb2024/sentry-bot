// src/services/deposit.service.ts
import { PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { connection } from '../lib/connection.js';

const prisma = new PrismaClient();

const activeListeners = new Map<string, { subId: number, lastBalance: number }>();

export async function startDepositWatcher(bot: any) {
    console.log("👛 [DEPOSIT WATCHER] Real-time Multi-Wallet WebSocket monitor initialized.");

    setInterval(async () => {
        try {
            // Fetch all users with a vault regardless of 7-day update activity
            const activeUsers = await prisma.user.findMany({
                where: {
                    vaultAddress: { not: null }
                }
            });

            const addressToUserMap = new Map<string, { user: any, label: string }>();

            for (const u of activeUsers) {
                if (u.vaultAddress) addressToUserMap.set(u.vaultAddress, { user: u, label: 'W1 (Main)' });
                if (u.activeWallets >= 2 && u.vault2) addressToUserMap.set(u.vault2, { user: u, label: 'W2' });
                if (u.activeWallets >= 3 && u.vault3) addressToUserMap.set(u.vault3, { user: u, label: 'W3' });
                if (u.activeWallets >= 4 && u.vault4) addressToUserMap.set(u.vault4, { user: u, label: 'W4' });
                if (u.activeWallets >= 5 && u.vault5) addressToUserMap.set(u.vault5, { user: u, label: 'W5' });
            }

            const activeAddresses = new Set(addressToUserMap.keys());

            for (const [address, data] of activeListeners.entries()) {
                if (!activeAddresses.has(address)) {
                    try {
                        await connection.removeAccountChangeListener(data.subId);
                    } catch (e: any) {
                        console.warn(`⚠️ [DEPOSIT] Failed to remove listener for ${address}: ${e.message}`);
                    } finally {
                        activeListeners.delete(address);
                    }
                }
            }

            for (const [address, meta] of addressToUserMap.entries()) {
                if (!activeListeners.has(address)) {
                    const pubKey = new PublicKey(address);

                    const initialBalanceLamports = await connection.getBalance(pubKey).catch((e) => {
                        console.error(`⚠️ [DEPOSIT] Init Fetch Failed for ${address}: ${e.message}`);
                        return null;
                    });

                    if (initialBalanceLamports === null) continue;

                    const initialBalanceSol = initialBalanceLamports / 1_000_000_000;

                    let subId: number;
                    try {
                        subId = connection.onAccountChange(pubKey, async (accountInfo) => {
                            const newBalanceSol = accountInfo.lamports / 1_000_000_000;
                            const cachedData = activeListeners.get(address);

                            if (cachedData) {
                                const oldBalanceSol = cachedData.lastBalance;

                                if (newBalanceSol > oldBalanceSol) {
                                    const depositAmount = newBalanceSol - oldBalanceSol;
                                    
                                    // Ignore micro-deposits from rent refunds (<0.001 SOL)
                                    if (depositAmount < 0.001) {
                                        activeListeners.set(address, { subId: cachedData.subId, lastBalance: newBalanceSol });
                                        return;
                                    }
                                    
                                    console.log(`👛 [DEPOSIT DETECTED] +${depositAmount.toFixed(4)} SOL into ${address} (${meta.label})`);

                                    try {
                                        await bot.telegram.sendMessage(meta.user.telegramId,
                                            `👛 <b>DEPOSIT CONFIRMED!</b>\n\n` +
                                            `Received: <b>+${depositAmount.toFixed(4)} SOL</b> into <b>${meta.label}</b>.\n` +
                                            `Wallet Balance: <b>${newBalanceSol.toFixed(4)} SOL</b>.\n\n` +
                                            `<i>Ready to trade! Send a Token Address (CA) into this chat to buy, or open the dashboard with /start.</i>`,
                                            { parse_mode: 'HTML' }
                                        );
                                    } catch (e: any) {
                                        console.error(`🔴 [DEPOSIT] Telegram Notification Failed for ${address}: ${e.message}`);
                                    }
                                }

                                activeListeners.set(address, { subId: cachedData.subId, lastBalance: newBalanceSol });
                            }
                        }, 'confirmed');
                    } catch (e: any) {
                        console.error(`🔴 [DEPOSIT] Failed to subscribe for ${address}: ${e.message}`);
                        continue; 
                    }

                    activeListeners.set(address, { subId, lastBalance: initialBalanceSol });
                }
            }
        } catch (error: any) {
            console.error("🔴 [DEPOSIT] Watcher Sync Error:", error.message);
        }
    }, 30000);
}