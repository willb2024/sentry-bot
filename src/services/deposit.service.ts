// src/services/deposit.service.ts
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import { connection } from '../lib/connection.js';

const activeListeners = new Map<string, { subId: number; lastBalance: number }>();

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

export async function startDepositWatcher(bot: any) {
    console.log("👛 [DEPOSIT WATCHER] Batched Multi-Wallet monitor initialized (60s cycle).");

    setInterval(async () => {
        try {
            const activeUsers = await prisma.user.findMany({
                where: {
                    vaultAddress: { not: null }
                },
                select: {
                    telegramId: true,
                    vaultAddress: true,
                    vault2: true,
                    vault3: true,
                    vault4: true,
                    vault5: true,
                    activeWallets: true
                }
            });

            const addressToUserMap = new Map<string, { user: any; label: string }>();

            for (const u of activeUsers) {
                if (u.vaultAddress) addressToUserMap.set(u.vaultAddress, { user: u, label: 'W1 (Main)' });
                if (u.activeWallets >= 2 && u.vault2) addressToUserMap.set(u.vault2, { user: u, label: 'W2' });
                if (u.activeWallets >= 3 && u.vault3) addressToUserMap.set(u.vault3, { user: u, label: 'W3' });
                if (u.activeWallets >= 4 && u.vault4) addressToUserMap.set(u.vault4, { user: u, label: 'W4' });
                if (u.activeWallets >= 5 && u.vault5) addressToUserMap.set(u.vault5, { user: u, label: 'W5' });
            }

            const allAddresses = Array.from(addressToUserMap.keys());
            if (allAddresses.length === 0) return;

            // Batch fetch balances in chunks of 100 to stay within Solana RPC limits
            const addressChunks = chunkArray(allAddresses, 100);
            const balanceMap = new Map<string, number>();

            for (const chunk of addressChunks) {
                try {
                    const pubkeys = chunk.map(addr => new PublicKey(addr));
                    const accounts = await connection.getMultipleAccountsInfo(pubkeys).catch(() => null);
                    if (accounts) {
                        accounts.forEach((acc, idx) => {
                            const balanceSol = acc ? acc.lamports / 1_000_000_000 : 0;
                            balanceMap.set(chunk[idx], balanceSol);
                        });
                    }
                } catch (chunkErr: any) {
                    console.warn("⚠️ [DEPOSIT] Batch RPC fetch warning:", chunkErr.message);
                }
            }

            // Process balance changes
            for (const [address, meta] of addressToUserMap.entries()) {
                const newBalanceSol = balanceMap.get(address);
                if (newBalanceSol === undefined) continue;

                const cached = activeListeners.get(address);

                if (cached) {
                    const oldBalanceSol = cached.lastBalance;

                    if (newBalanceSol > oldBalanceSol + 0.001) {
                        const depositAmount = newBalanceSol - oldBalanceSol;
                        console.log(`👛 [DEPOSIT DETECTED] +${depositAmount.toFixed(4)} SOL into ${address} (${meta.label})`);

                        try {
                            await bot.telegram.sendMessage(meta.user.telegramId,
                                `👛 <b>DEPOSIT CONFIRMED!</b>\n\n` +
                                `Received: <b>+${depositAmount.toFixed(4)} SOL</b> into <b>${meta.label}</b>.\n` +
                                `Wallet Balance: <b>${newBalanceSol.toFixed(4)} SOL</b>.\n\n` +
                                `<i>Ready to trade! Send a Token Address (CA) into this chat to buy, or open the dashboard with /start.</i>`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (tgErr: any) {
                            console.error(`🔴 [DEPOSIT] Telegram Notification Failed for ${address}:`, tgErr.message);
                        }
                    }
                    activeListeners.set(address, { subId: cached.subId, lastBalance: newBalanceSol });
                } else {
                    activeListeners.set(address, { subId: 0, lastBalance: newBalanceSol });
                }
            }
        } catch (error: any) {
            console.error("🔴 [DEPOSIT] Watcher Sync Error:", error.message);
        }
    }, 60000);
}

export function getLiveWalletBalance(walletAddress: string): number | null {
    const cachedData = activeListeners.get(walletAddress);
    return cachedData ? cachedData.lastBalance : null;
}