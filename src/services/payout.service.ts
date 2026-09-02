// src/services/payout.service.ts
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';
import { decryptKey } from './vault.service.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js'; // 🟢 FIX: Singleton
import { redlock } from '../lib/redlock.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/redlock.js';

dotenv.config();

const DAILY_PAYOUT_CAP_SOL = parseFloat(process.env.TREASURY_DAILY_PAYOUT_CAP_SOL || '50');
const SINGLE_PAYOUT_ALERT_THRESHOLD_SOL = parseFloat(process.env.PAYOUT_ALERT_THRESHOLD_SOL || '5');

async function getTodaysPayoutTotal(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const val = await redis.get(`treasury:payouts:${today}`);
    return val ? parseFloat(val) : 0;
}

async function recordPayout(amountSol: number): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const key = `treasury:payouts:${today}`;
    await redis.incrbyfloat(key, amountSol);
    await redis.expire(key, 172800); 
}

async function alertAdmins(message: string) {
    try {
        const adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',').filter(Boolean);
        const botToken = process.env.BOT_TOKEN;
        if (!botToken) return;
        for (const id of adminIds) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: id, text: message, parse_mode: 'HTML' })
            }).catch(() => {});
        }
    } catch (_) {}
}

// In src/services/payout.service.ts:


export async function processAffiliatePayout(userId: string): Promise<{ success: boolean; signature?: string; message: string }> {
    const lockKey = `lock:payout:${userId}`;

    return await withLock([lockKey], 60000, async () => {
        let amountToPay = 0;
        let rewardsDebited = false;

        try {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || user.pendingRewardsSol <= 0) throw new Error("No rewards to claim.");
            if (!user.vaultAddress) throw new Error("No vault address found to receive payout.");

            const { getConnectionFor, getTreasuryConfigFor } = await import('../lib/devnet.js');
            const conn = await getConnectionFor(user.telegramId);
            const treasuryCfg = await getTreasuryConfigFor(user.telegramId);

            if (!treasuryCfg.encryptedKey) {
                throw new Error("Platform Error: Treasury Hot Wallet not configured.");
            }

            const treasuryPrivKey = decryptKey(treasuryCfg.encryptedKey);
            if (!treasuryPrivKey) throw new Error("Platform Error: Treasury key decryption failed.");

            amountToPay = user.pendingRewardsSol;
            const lamportsToPay = Math.floor(amountToPay * LAMPORTS_PER_SOL);

            await prisma.user.update({ 
                where: { id: user.id }, 
                data: { 
                    pendingRewardsSol: 0,
                    lifetimeEarnedSol: { increment: amountToPay }
                } 
            });
            rewardsDebited = true; 

            const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryPrivKey));
            const userVaultPubkey = new PublicKey(user.vaultAddress);

            const treasuryBalance = await conn.getBalance(treasuryKeypair.publicKey);
            if (treasuryBalance < lamportsToPay + 500000) {
                await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: amountToPay, lifetimeEarnedSol: { decrement: amountToPay } } });
                rewardsDebited = false;
                throw new Error("Platform Error: Treasury lacks liquidity to process payout.");
            }

            const transferIx = SystemProgram.transfer({
                fromPubkey: treasuryKeypair.publicKey, toPubkey: userVaultPubkey, lamports: lamportsToPay
            });

            const { blockhash } = await conn.getLatestBlockhash('confirmed');
            const messageV0 = new TransactionMessage({
                payerKey: treasuryKeypair.publicKey, recentBlockhash: blockhash, instructions: [transferIx]
            }).compileToV0Message();

            const vTx = new VersionedTransaction(messageV0);
            vTx.sign([treasuryKeypair]);

            const txBuffer = Buffer.from(vTx.serialize());
            const signature = bs58.encode(vTx.signatures[0]);

            await conn.sendRawTransaction(txBuffer, { skipPreflight: true });

            let isConfirmed = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
                if (status?.value && !status.value.err) {
                    isConfirmed = true;
                    break;
                }
            }

            if (!isConfirmed) {
                await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: amountToPay, lifetimeEarnedSol: { decrement: amountToPay } } });
                rewardsDebited = false;
                throw new Error("Network congestion. Transaction dropped. Rewards refunded to balance.");
            }

            return { success: true, signature, message: "Instant Payout Successful." };

        } catch (e: any) {
            if (rewardsDebited && amountToPay > 0) {
                await prisma.user.update({ where: { id: userId }, data: { pendingRewardsSol: { increment: amountToPay }, lifetimeEarnedSol: { decrement: amountToPay } } }).catch(() => {});
            }
            return { success: false, message: e.message };
        }
    });
}