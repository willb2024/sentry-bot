// src/services/payout.service.ts
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';
import { decryptKey } from './vault.service.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js'; // 🟢 FIX: Singleton
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

// src/services/payout.service.ts
export async function processAffiliatePayout(userId: string): Promise<{ success: boolean; signature?: string; message: string }> {
    const lockKey = `lock:payout:${userId}`;

    return await withLock([lockKey], 90000, async () => {
        let amountToPay = 0;

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

            // 1. Atomic Daily Cap Reservation with string-to-number parse
            const today = new Date().toISOString().split('T')[0];
            const capKey = `treasury:payouts:${today}`;
            const projectedRaw = await redis.incrbyfloat(capKey, amountToPay);
            const projected = parseFloat(projectedRaw);
            await redis.expire(capKey, 172800);

            if (projected > DAILY_PAYOUT_CAP_SOL) {
                await redis.incrbyfloat(capKey, -amountToPay); // Roll back reservation
                await alertAdmins(`🚨 <b>PAYOUT CAP HIT</b>: User ${userId} blocked trying to claim ${amountToPay.toFixed(4)} SOL`);
                return { success: false, message: "Daily payout limit reached platform-wide. Please try again tomorrow or contact support." };
            }

            // 2. Persist PENDING PayoutRecord in database
            const record = await prisma.payoutRecord.create({
                data: {
                    userId,
                    amountSol: amountToPay,
                    status: 'PENDING'
                }
            });

            // 3. Atomically debit user balance
            await prisma.user.update({
                where: { id: user.id },
                data: {
                    pendingRewardsSol: 0,
                    lifetimeEarnedSol: { increment: amountToPay }
                }
            });

            const lamportsToPay = Math.floor(amountToPay * LAMPORTS_PER_SOL);
            const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryPrivKey));
            const userVaultPubkey = new PublicKey(user.vaultAddress);

            const treasuryBalance = await conn.getBalance(treasuryKeypair.publicKey);
            if (treasuryBalance < lamportsToPay + 500000) {
                await redis.incrbyfloat(capKey, -amountToPay);
                await prisma.user.update({
                    where: { id: user.id },
                    data: { pendingRewardsSol: amountToPay, lifetimeEarnedSol: { decrement: amountToPay } }
                });
                await prisma.payoutRecord.update({
                    where: { id: record.id },
                    data: { status: 'FAILED' }
                });
                throw new Error("Platform Error: Treasury temporarily lacks liquidity to process payout.");
            }

            const transferIx = SystemProgram.transfer({
                fromPubkey: treasuryKeypair.publicKey,
                toPubkey: userVaultPubkey,
                lamports: lamportsToPay
            });

            const { blockhash } = await conn.getLatestBlockhash('confirmed');
            const messageV0 = new TransactionMessage({
                payerKey: treasuryKeypair.publicKey,
                recentBlockhash: blockhash,
                instructions: [transferIx]
            }).compileToV0Message();

            const vTx = new VersionedTransaction(messageV0);
            vTx.sign([treasuryKeypair]);

            const txBuffer = Buffer.from(vTx.serialize());
            const signature = bs58.encode(vTx.signatures[0]);

            await prisma.payoutRecord.update({
                where: { id: record.id },
                data: { signature }
            });

            try {
                await conn.sendRawTransaction(txBuffer, { skipPreflight: true });
            } catch (sendError: any) {
                logger.warn(`⚠️ [PAYOUT] RPC broadcast warning for ${signature}:`, { error: sendError.message });
            }

            // 4. Poll on-chain confirmation
            let isConfirmed = false;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
                if (status?.value?.err) break;
                if (status?.value && !status.value.err) {
                    isConfirmed = true;
                    break;
                }
            }

            if (isConfirmed) {
                await prisma.payoutRecord.update({
                    where: { id: record.id },
                    data: { status: 'CONFIRMED' }
                });
                return { success: true, signature, message: "Instant Payout Successful." };
            }

            // 5. Release cap if unconfirmed within window; leave PENDING for cron reconciliation
            await redis.incrbyfloat(capKey, -amountToPay);
            return {
                success: false,
                signature,
                message: "Payout is processing on Solana. If your transaction does not confirm in 2 minutes, it will automatically reconcile. Your rewards are secure."
            };

        } catch (e: any) {
            logger.error(`🔴 [PAYOUT] Execution error for user ${userId}:`, { error: e.message });
            return { success: false, message: e.message };
        }
    });
}

// src/services/payout.service.ts

async function refundPayout(rec: { id: string; userId: string; amountSol: number; createdAt: Date }) {
    const capDay = rec.createdAt.toISOString().split('T')[0];
    await prisma.$transaction([
        prisma.user.update({
            where: { id: rec.userId },
            data: { 
                pendingRewardsSol: { increment: rec.amountSol }, 
                lifetimeEarnedSol: { decrement: rec.amountSol } 
            }
        }),
        prisma.payoutRecord.update({ 
            where: { id: rec.id }, 
            data: { status: 'FAILED' } 
        })
    ]);
    await redis.incrbyfloat(`treasury:payouts:${capDay}`, -rec.amountSol).catch(() => {});
}

export async function reconcilePendingPayouts(): Promise<void> {
    const graceStart = new Date(Date.now() - 3 * 60 * 1000); // Do not evaluate records younger than 3 minutes
    const pending = await prisma.payoutRecord.findMany({
        where: { status: 'PENDING', createdAt: { lt: graceStart } }
    }).catch(() => []);

    for (const rec of pending) {
        try {
            if (!rec.signature) { 
                await refundPayout(rec); 
                continue; 
            }

            const status = await connection
                .getSignatureStatus(rec.signature, { searchTransactionHistory: true })
                .catch(() => null);

            const landed = status?.value && !status.value.err &&
                (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized');

            if (landed) {
                await prisma.payoutRecord.update({ 
                    where: { id: rec.id }, 
                    data: { status: 'CONFIRMED' } 
                });
            } else if (status?.value?.err) {
                await refundPayout(rec); // On-chain failure verified -> safely refund
            } else if (Date.now() - rec.createdAt.getTime() > 10 * 60 * 1000) {
                await refundPayout(rec); // Dropped by validators (>10 minutes) -> safely refund
            }
        } catch (e: any) {
            logger.error('🔴 [PAYOUT RECONCILE ERROR]', { id: rec.id, error: e.message });
        }
    }
}