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

export async function processAffiliatePayout(userId: string): Promise<{ success: boolean; signature?: string; message: string }> {
    const lockKey = `lock:payout:${userId}`;
    let lock;
    try {
        lock = await redlock.acquire([lockKey], 90000); 
    } catch (e) {
        return { success: false, message: "Payout already processing. Please wait 90 seconds." };
    }

    let amountToPay = 0;
    let rewardsDebited = false;

    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.pendingRewardsSol <= 0) throw new Error("No rewards to claim.");
        if (!user.vaultAddress) throw new Error("No vault address found to receive payout.");

        const treasuryPrivKeyEncrypted = process.env.TREASURY_PRIVATE_KEY_ENCRYPTED;
        if (!treasuryPrivKeyEncrypted) throw new Error("Platform Error: Treasury Hot Wallet not configured.");

        const treasuryPrivKey = decryptKey(treasuryPrivKeyEncrypted);
        if (!treasuryPrivKey) throw new Error("Platform Error: Treasury key decryption failed.");

        amountToPay = user.pendingRewardsSol;
        
        const todaysTotal = await getTodaysPayoutTotal();
        if (todaysTotal + amountToPay > DAILY_PAYOUT_CAP_SOL) {
            await alertAdmins(`🚨 <b>PAYOUT CAP HIT</b>\n\nUser ${userId} tried to claim ${amountToPay.toFixed(4)} SOL.\nBlocked.`);
            return { success: false, message: "Daily payout limit reached platform-wide. Please try again tomorrow or contact support." };
        }

        if (amountToPay >= SINGLE_PAYOUT_ALERT_THRESHOLD_SOL) {
            alertAdmins(`⚠️ <b>Large Payout</b>\n\nUser ${userId} claiming ${amountToPay.toFixed(4)} SOL. Signature will follow.`);
        }

        const lamportsToPay = Math.floor(amountToPay * LAMPORTS_PER_SOL);
        await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: 0 } });
        rewardsDebited = true; 

        const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryPrivKey));
        const userVaultPubkey = new PublicKey(user.vaultAddress);

        const treasuryBalance = await connection.getBalance(treasuryKeypair.publicKey);
        if (treasuryBalance < lamportsToPay + 500000) {
            await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: amountToPay } });
            rewardsDebited = false;
            throw new Error("Platform Error: Treasury temporarily lacks liquidity to process payout.");
        }

        const transferIx = SystemProgram.transfer({
            fromPubkey: treasuryKeypair.publicKey, toPubkey: userVaultPubkey, lamports: lamportsToPay
        });

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: treasuryKeypair.publicKey, recentBlockhash: blockhash, instructions: [transferIx]
        }).compileToV0Message();

        const vTx = new VersionedTransaction(messageV0);
        vTx.sign([treasuryKeypair]);

        const txBuffer = Buffer.from(vTx.serialize());
        const signature = bs58.encode(vTx.signatures[0]);

        try {
            await connection.sendRawTransaction(txBuffer, { skipPreflight: true });
        } catch (sendError: any) {
            logger.warn(`⚠️ [PAYOUT] RPC threw error, but Tx might land. Polling ${signature}...`, { error: sendError.message });
        }

        let isConfirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) {
                isConfirmed = true;
                break;
            }
        }

        if (!isConfirmed) {
            await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: amountToPay } });
            rewardsDebited = false;
            throw new Error("Network congestion. Transaction dropped. Your rewards have been refunded to your balance.");
        }

        await recordPayout(amountToPay);
        return { success: true, signature: signature, message: "Instant Payout Successful." };

    } catch (e: any) {
        logger.error(`🔴 [PAYOUT] Execution failed for user ${userId}`, { error: e.message });
        if (rewardsDebited && amountToPay > 0) {
            try {
                await prisma.user.update({ where: { id: userId }, data: { pendingRewardsSol: { increment: amountToPay } } });
            } catch (refundErr: any) {
                logger.error(`🔴 [CRITICAL] Failed to refund payout for user ${userId}`, { error: refundErr.message });
            }
        }
        return { success: false, message: e.message };
    } finally {
        if (lock) await (lock as any).release();
    }
}