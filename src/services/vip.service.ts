// src/services/vip.service.ts
import { PrismaClient } from '@prisma/client';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { redis } from '../lib/redis.js';
import { connection } from '../lib/connection.js';
import { getVipStatus as getPromoVipStatus } from './vip_promo.service.js';

const prisma = new PrismaClient();

export const VIP_TIERS = {
    trial: {
        label: '🟡 Trial VIP', durationDays: 7, priceSol: 0.05,
        description: '7-day trial — 0% fees, Turbo Jito priority',
        features: ['0% trading fees', 'Turbo Jito on all trades', 'VIP badge on leaderboard']
    },
    standard: {
        label: '🟢 Standard VIP', durationDays: 30, priceSol: 0.15,
        description: '30-day membership — 0% fees + Alpha Directory access',
        features: ['0% trading fees', 'Turbo Jito on all trades', 'VIP badge', 'Whale Alpha Directory']
    },
    pro: {
        label: '🔵 Pro VIP', durationDays: 90, priceSol: 0.49,
        description: '90-day membership — everything + Dev Suite free',
        features: ['0% trading fees', 'Turbo Jito', 'VIP badge', 'Alpha Directory', 'Dev Suite unlocked free', 'Priority support']
    },
    lifetime: {
        label: '💎 Lifetime VIP', durationDays: 36500, priceSol: 0.99,
        description: 'Lifetime membership — everything forever',
        features: ['0% trading fees forever', 'Turbo Jito forever', 'Permanent VIP badge', 'Alpha Directory', 'Dev Suite free', 'Name permanently on leaderboard', 'Priority support']
    }
} as const;

export type VipTierKey = keyof typeof VIP_TIERS;

export async function checkVipStatus(telegramId: string): Promise<{
    isVip: boolean; tier: VipTierKey | null; expiresAt: Date | null; daysRemaining: number;
}> {
    const promoStatus = await getPromoVipStatus(telegramId);
    const user = await prisma.user.findUnique({ where: { telegramId }, select: { vipTier: true } });
    
    return {
        isVip: promoStatus.isVip,
        tier: (user?.vipTier as VipTierKey) || null,
        expiresAt: promoStatus.expiresAt,
        daysRemaining: promoStatus.daysRemaining || 0
    };
}

export async function grantVip(telegramId: string, tier: VipTierKey, source: string = 'PAID', txSignature?: string): Promise<void> {
    const tierDef = VIP_TIERS[tier];
    const expiresAt = new Date(Date.now() + tierDef.durationDays * 24 * 60 * 60 * 1000);

    await prisma.user.update({
        where: { telegramId },
        data: {
            isVip: true, vipTier: tier, vipExpiresAt: expiresAt, vipSource: source,
            vipTxSignature: txSignature || null, vipPurchasedAt: new Date()
        }
    });

    await redis.set(`vip:${telegramId}`, JSON.stringify({ isVip: true, tier, expiresAt: expiresAt.toISOString() }), 'EX', tierDef.durationDays * 86400);
}

export async function verifyVipPayment(txSignature: string, expectedAmountSol: number, treasuryAddress: string, senderVaultAddress: string): Promise<{ valid: boolean; reason: string }> {
    try {
        const used = await redis.get(`vip:tx:${txSignature}`);
        if (used) return { valid: false, reason: 'Transaction already used for a VIP purchase' };

        const tx = await connection.getParsedTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return { valid: false, reason: 'Transaction not found on-chain' };

        const txTime = tx.blockTime ? tx.blockTime * 1000 : 0;
        if (Date.now() - txTime > 10 * 60 * 1000) return { valid: false, reason: 'Transaction is older than 10 minutes' };

        const instructions = tx.transaction.message.instructions as any[];
        let totalSentToTreasury = 0;

        for (const ix of instructions) {
            if (ix.parsed?.type === 'transfer') {
                const dest = ix.parsed.info?.destination;
                const lamports = ix.parsed.info?.lamports || 0;
                if (dest === treasuryAddress) totalSentToTreasury += lamports / LAMPORTS_PER_SOL;
            }
        }

        if (totalSentToTreasury < expectedAmountSol - 0.001) {
            return { valid: false, reason: `Insufficient payment. Expected ${expectedAmountSol} SOL, received ${totalSentToTreasury.toFixed(4)} SOL` };
        }

        await redis.set(`vip:tx:${txSignature}`, '1', 'EX', 86400 * 30);
        return { valid: true, reason: 'Payment verified' };
    } catch (e: any) { return { valid: false, reason: `Verification error: ${e.message}` }; }
}

export async function getPlatformFeeRate(telegramId: string): Promise<number> {
    const cached = await redis.get(`vip:${telegramId}`);
    if (cached) {
        const data = JSON.parse(cached);
        if (data.isVip && new Date(data.expiresAt) > new Date()) return 0.0; 
    } else {
        // 🟢 FIX C5: DB Fallback on Redis Miss
        const user = await prisma.user.findUnique({ where: { telegramId }, select: { isVip: true, vipExpiresAt: true } });
        if (user?.isVip && (!user.vipExpiresAt || user.vipExpiresAt > new Date())) return 0.0;
    }
    return 0.01; 
}

export function formatVipStatus(status: { isVip: boolean; tier: VipTierKey | null; expiresAt: Date | null; daysRemaining: number; }): string {
    if (!status.isVip || !status.tier) {
        return (
            `👑 <b>VIP STATUS</b>\n\n❌ <b>Not Active</b>\n\nUpgrade to VIP to unlock:\n` +
            `• 0% trading fees (save on every trade)\n• Turbo Jito priority execution\n` +
            `• VIP badge on global leaderboard\n• Whale Alpha Directory access\n\nUse the buttons below to upgrade.`
        );
    }

    const tier = VIP_TIERS[status.tier];
    const expiryStr = status.tier === 'lifetime' ? '♾️ Never' : status.expiresAt?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) || 'Unknown';
    const urgency = status.daysRemaining <= 3 && status.tier !== 'lifetime' ? `\n⚠️ <b>Expiring soon! Renew now to keep your benefits.</b>` : '';

    return (
        `👑 <b>VIP STATUS — ACTIVE</b>\n\n${tier.label}\n📅 Expires: <b>${expiryStr}</b>\n` +
        `⏳ Days Remaining: <b>${status.tier === 'lifetime' ? '∞' : status.daysRemaining}</b>\n\n` +
        `✅ <b>Your Active Benefits:</b>\n` + tier.features.map(f => `• ${f}`).join('\n') + urgency
    );
}