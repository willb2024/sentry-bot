// src/services/payout.service.ts
import { PrismaClient } from '@prisma/client';
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

export async function processAffiliatePayout(userId: string): Promise<{ success: boolean; signature?: string; message: string }> {
    const lockKey = `lock:payout:${userId}`;
    const isLocked = await redis.set(lockKey, 'LOCKED', 'EX', 90, 'NX');
    if (!isLocked) return { success: false, message: "Payout already processing. Please wait 90 seconds." };

    let amountToPay = 0;
    let rewardsDebited = false;

    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.pendingRewardsSol <= 0) throw new Error("No rewards to claim.");
        if (!user.vaultAddress) throw new Error("No vault address found to receive payout.");

        const treasuryPrivKey = process.env.TREASURY_PRIVATE_KEY;
        if (!treasuryPrivKey) throw new Error("Platform Error: Treasury Hot Wallet not configured.");

        amountToPay = user.pendingRewardsSol;
        const lamportsToPay = Math.floor(amountToPay * LAMPORTS_PER_SOL);

       // 🟢 PART 2.8 FIX: Atomic decrement prevents erasing mid-flight affiliate earnings
       await prisma.user.update({ where: { id: user.id }, data: { pendingRewardsSol: { decrement: amountToPay } } });
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
            console.warn(`⚠️ [PAYOUT] RPC threw error, but Tx might land. Polling ${signature}... Error: ${sendError.message}`);
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

        await redis.del(lockKey);
        return { success: true, signature: signature, message: "Instant Payout Successful." };

    } catch (e: any) {
        console.error(`🔴 [PAYOUT] Execution failed for user ${userId}: ${e.message}`);
        if (rewardsDebited && amountToPay > 0) {
            try {
                await prisma.user.update({ where: { id: userId }, data: { pendingRewardsSol: { increment: amountToPay } } });
            } catch (refundErr: any) {
                console.error(`🔴 [CRITICAL] Failed to refund payout for user ${userId}: ${refundErr.message}`);
            }
        }
        await redis.del(lockKey);
        return { success: false, message: e.message };
    }
}