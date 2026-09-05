// src/services/payout.service.ts
import { 
    PublicKey, 
    Keypair, 
    SystemProgram, 
    TransactionMessage, 
    VersionedTransaction, 
    LAMPORTS_PER_SOL 
} from '@solana/web3.js';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';
import { decryptKey } from './vault.service.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/redlock.js';

dotenv.config();

const DAILY_PAYOUT_CAP_SOL = parseFloat(process.env.TREASURY_DAILY_PAYOUT_CAP_SOL || '50');
const SINGLE_PAYOUT_ALERT_THRESHOLD_SOL = parseFloat(process.env.PAYOUT_ALERT_THRESHOLD_SOL || '5');

async function alertAdmins(message: string): Promise<void> {
    try {
        const adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',').map(id => id.trim()).filter(Boolean);
        const botToken = process.env.BOT_TOKEN;
        if (!botToken || adminIds.length === 0) return;

        for (const id of adminIds) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: id, text: message, parse_mode: 'HTML' })
            }).catch(() => {});
        }
    } catch (_) {}
}

/** Database-authoritative check across confirmed and in-flight pending records */
export async function getTodaysPayoutTotal(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const agg = await prisma.payoutRecord.aggregate({
        where: {
            createdAt: { gte: startOfDay },
            status: { in: ['PENDING', 'CONFIRMED'] }
        },
        _sum: { amountSol: true }
    });

    return agg._sum.amountSol ? Number(agg._sum.amountSol) : 0;
}

export async function recordPayout(amountSol: number): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const key = `treasury:payouts:${today}`;
    await redis.incrbyfloat(key, amountSol);
    await redis.expire(key, 172800); 
}

/** Safely refunds user rewards and releases reserved cap when a transaction permanently fails */
async function refundPayout(rec: { id: string; userId: string; amountSol: number | any; createdAt: Date }): Promise<void> {
    const amountNum = Number(rec.amountSol);
    const capDay = rec.createdAt.toISOString().split('T')[0];

    await prisma.$transaction([
        prisma.user.update({
            where: { id: rec.userId },
            data: { 
                pendingRewardsSol: { increment: amountNum }, 
                lifetimeEarnedSol: { decrement: amountNum } 
            }
        }),
        prisma.payoutRecord.update({ 
            where: { id: rec.id }, 
            data: { status: 'FAILED' } 
        })
    ]);

    await redis.incrbyfloat(`treasury:payouts:${capDay}`, -amountNum).catch(() => {});
    logger.info(`🔄 [PAYOUT REFUND] Successfully refunded ${amountNum} SOL to user ${rec.userId}`);
}

/** Background reconciler called every 60s from bootEcosystem() */
export async function reconcilePendingPayouts(): Promise<void> {
    const graceStart = new Date(Date.now() - 3 * 60 * 1000); // Only evaluate claims older than 3 minutes
    const pending = await prisma.payoutRecord.findMany({
        where: { 
            status: 'PENDING', 
            createdAt: { lt: graceStart } 
        }
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
                logger.info(`✅ [PAYOUT RECONCILE] Confirmed transaction ${rec.signature} on-chain.`);
            } else if (status?.value?.err) {
                await refundPayout(rec); // Real on-chain failure verified -> restore rewards
            } else if (Date.now() - rec.createdAt.getTime() > 10 * 60 * 1000) {
                await refundPayout(rec); // Dropped by network (>10 minutes without receipt) -> restore rewards
            }
        } catch (e: any) {
            logger.error('🔴 [PAYOUT RECONCILE ERROR]', { id: rec.id, error: e.message });
        }
    }
}

export async function processAffiliatePayout(userId: string): Promise<{ success: boolean; signature?: string; message: string }> {
    const lockKey = `lock:payout:${userId}`;

    return await withLock([lockKey], 90000, async () => {
        let amountToPay = 0;

        try {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || Number(user.pendingRewardsSol) <= 0) throw new Error("No rewards to claim.");
            if (!user.vaultAddress) throw new Error("No vault address found to receive payout.");

            const { getConnectionFor, getTreasuryConfigFor } = await import('../lib/devnet.js');
            const conn = await getConnectionFor(user.telegramId);
            const treasuryCfg = await getTreasuryConfigFor(user.telegramId);

            if (!treasuryCfg.encryptedKey) {
                throw new Error("Platform Error: Treasury Hot Wallet not configured.");
            }

            const treasuryPrivKey = decryptKey(treasuryCfg.encryptedKey);
            if (!treasuryPrivKey) throw new Error("Platform Error: Treasury key decryption failed.");

            amountToPay = Number(user.pendingRewardsSol);

            // 1. Database-Authoritative Daily Payout Cap Check
            const dbTodayTotal = await getTodaysPayoutTotal();
            if (dbTodayTotal + amountToPay > DAILY_PAYOUT_CAP_SOL) {
                await alertAdmins(`🚨 <b>PAYOUT CAP HIT</b>: User ${userId} blocked trying to claim ${amountToPay.toFixed(4)} SOL`);
                return { success: false, message: "Daily payout limit reached platform-wide. Please try again tomorrow or contact support." };
            }

            // 2. Redis Concurrency Reservation
            const today = new Date().toISOString().split('T')[0];
            const capKey = `treasury:payouts:${today}`;
            const projectedRaw = await redis.incrbyfloat(capKey, amountToPay);
            const projected = parseFloat(projectedRaw);
            await redis.expire(capKey, 172800);

            if (projected > DAILY_PAYOUT_CAP_SOL) {
                await redis.incrbyfloat(capKey, -amountToPay);
                return { success: false, message: "Daily payout limit reached platform-wide. Please try again tomorrow." };
            }

            if (amountToPay >= SINGLE_PAYOUT_ALERT_THRESHOLD_SOL) {
                alertAdmins(`⚠️ <b>Large Payout Alert</b>: User ${userId} is claiming ${amountToPay.toFixed(4)} SOL.`);
            }

            // 3. Persist PENDING PayoutRecord in database
            const record = await prisma.payoutRecord.create({
                data: {
                    userId,
                    amountSol: amountToPay,
                    status: 'PENDING'
                }
            });

            // 4. Atomically debit user rewards
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
                logger.warn(`⚠️ [PAYOUT] Broadcast warning for ${signature}:`, { error: sendError.message });
            }

            // 5. Polling on-chain confirmation
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
                // 🟢 FIX: Do NOT call recordPayout(amountToPay) here — Step 2 already reserved and recorded it!
                return { success: true, signature, message: "Instant Payout Successful." };
            }

            // 6. Unconfirmed within window: leave PENDING for background reconciler
            return {
                success: false,
                signature,
                message: "Payout is processing on Solana. It will automatically reconcile in 2-3 minutes. Your rewards are secure."
            };

        } catch (e: any) {
            logger.error(`🔴 [PAYOUT] Execution error for user ${userId}:`, { error: e.message });
            return { success: false, message: e.message };
        }
    });
}