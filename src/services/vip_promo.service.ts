// src/services/vip_promo.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

export type VipSource = 'PROMO' | 'PAID' | 'ADMIN' | 'EXPIRED' | null;

export interface VipPromoResult {
    granted: boolean;
    slotsRemaining: number;
    reason?: 'PROMO_INACTIVE' | 'ALREADY_CLAIMED_TODAY' | 'SLOTS_FULL' |
              'ALREADY_ACTIVE_VIP' | 'PREVIOUSLY_HAD_PROMO' | 'SUCCESS';
}

export interface VipStatus {
    isVip: boolean;
    source: VipSource;
    expiresAt: Date | null;
    isExpired: boolean;
    daysRemaining: number | null;
    badge: string;         
    badgeLabel: string;    
    badgeLine: string;     
}

export function resolveBadge(
    isVip: boolean,
    isExpired: boolean,
    source: VipSource,
    daysRemaining: number | null
): { badge: string; badgeLabel: string; badgeLine: string } {

    // 🟢 BUG 3 FIX: Corrected parenthesisation so custom VIP sources display badges without colliding
    if (isVip && !isExpired && source !== 'PROMO') {
        return {
            badge: '👑',
            badgeLabel: 'SENTRY VIP ELITE',
            badgeLine: '👑 <b>SENTRY VIP ELITE</b> — Lifetime Access'
        };
    }

    if (isVip && !isExpired && source === 'PROMO' && daysRemaining !== null) {
        if (daysRemaining >= 8) {
            return {
                badge: '👑',
                badgeLabel: 'SENTRY VIP ELITE',
                badgeLine: `👑 <b>SENTRY VIP ELITE</b> — ${daysRemaining} days remaining`
            };
        } else if (daysRemaining >= 4) {
            return {
                badge: '⚡',
                badgeLabel: 'SENTRY VIP',
                badgeLine: `⚡ <b>SENTRY VIP</b> — ${daysRemaining} days remaining`
            };
        } else {
            return {
                badge: '🔰',
                badgeLabel: 'SENTRY VIP',
                badgeLine: `🔰 <b>SENTRY VIP</b> — ⚠️ ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining! Renew soon.`
            };
        }
    }

    if (isExpired || source === 'EXPIRED') {
        return {
            badge: '☑️',
            badgeLabel: 'VERIFIED TRADER',
            badgeLine: '☑️ <b>VERIFIED TRADER</b> — Standard member'
        };
    }

    return { badge: '', badgeLabel: '', badgeLine: '' };
}

export async function getVipStatus(telegramId: string): Promise<VipStatus> {
    const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { isVip: true, vipExpiresAt: true, vipSource: true }
    });

    if (!user) {
        const { badge, badgeLabel, badgeLine } = resolveBadge(false, false, null, null);
        return { isVip: false, source: null, expiresAt: null,
                 isExpired: false, daysRemaining: null, badge, badgeLabel, badgeLine };
    }

    const now = new Date();
    const source = (user.vipSource as VipSource) || null;

    if (user.isVip && user.vipExpiresAt && user.vipExpiresAt < now) {
        await prisma.user.update({
            where: { telegramId },
            data: { isVip: false, vipSource: 'EXPIRED' }
        });

        const { badge, badgeLabel, badgeLine } = resolveBadge(false, true, 'EXPIRED', 0);
        return {
            isVip: false, source: 'EXPIRED', expiresAt: user.vipExpiresAt,
            isExpired: true, daysRemaining: 0, badge, badgeLabel, badgeLine
        };
    }

    let daysRemaining: number | null = null;
    if (user.isVip && user.vipExpiresAt) {
        daysRemaining = Math.ceil((user.vipExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    const { badge, badgeLabel, badgeLine } = resolveBadge(user.isVip, false, source, daysRemaining);

    return {
        isVip: user.isVip, source, expiresAt: user.vipExpiresAt || null,
        isExpired: false, daysRemaining, badge, badgeLabel, badgeLine
    };
}

export async function getPromoConfig(): Promise<{ maxSlots: number }> {
    const today = new Date().toISOString().split('T')[0];
    let promo = await prisma.dailyVipPromo.findUnique({ where: { date: today } });
    if (!promo) {
        promo = await prisma.dailyVipPromo.create({ data: { date: today, maxSlots: 10, isActive: true } });
    }
    return { maxSlots: promo.maxSlots };
}

export async function checkAndGrantDailyVip(telegramId: string, referralCode: string): Promise<VipPromoResult> {
    const isActive = await redis.get('vip_promo:active');
    if (isActive !== 'true') return { granted: false, slotsRemaining: 0, reason: 'PROMO_INACTIVE' };

    const lockKey = `vip_promo:claiming:${telegramId}`;
    const isLocked = await redis.set(lockKey, 'LOCKED', 'EX', 10, 'NX');
    if (!isLocked) return { granted: false, slotsRemaining: await getSlotsRemaining(), reason: 'ALREADY_CLAIMED_TODAY' };

    try {
        const user = await prisma.user.findUnique({
            where: { telegramId },
            select: { isVip: true, vipExpiresAt: true, vipSource: true }
        });

        if (!user) return { granted: false, slotsRemaining: 0 };

        const now = new Date();
        if (user.isVip && !user.vipExpiresAt) return { granted: false, slotsRemaining: await getSlotsRemaining(), reason: 'ALREADY_ACTIVE_VIP' };

        const hadPromo = user.vipSource === 'PROMO' || user.vipSource === 'EXPIRED';
        const hasActivePromo = user.isVip && user.vipExpiresAt && user.vipExpiresAt > now;

        if (hadPromo && !hasActivePromo) return { granted: false, slotsRemaining: await getSlotsRemaining(), reason: 'PREVIOUSLY_HAD_PROMO' };
        if (hasActivePromo) return { granted: false, slotsRemaining: await getSlotsRemaining(), reason: 'ALREADY_ACTIVE_VIP' };

        const alreadyClaimedToday = await redis.get(`vip_promo:claimed:${telegramId}`);
        if (alreadyClaimedToday) return { granted: false, slotsRemaining: await getSlotsRemaining(), reason: 'ALREADY_CLAIMED_TODAY' };

        const today = new Date().toISOString().split('T')[0];
        const { maxSlots } = await getPromoConfig();
        const currentCount = await redis.incr(`vip_promo:date:${today}`);

        if (currentCount === 1) await redis.expire(`vip_promo:date:${today}`, 90000); 

        if (currentCount > maxSlots) {
            await redis.decr(`vip_promo:date:${today}`);
            return { granted: false, slotsRemaining: 0, reason: 'SLOTS_FULL' };
        }

        await redis.set(`vip_promo:claimed:${telegramId}`, '1', 'EX', 86400);

        await prisma.user.update({
            where: { telegramId },
            data: {
                isVip: true,
                vipExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), 
                vipSource: 'PROMO'
            }
        });

        await prisma.dailyVipPromo.upsert({
            where: { date: today },
            update: { slotsUsed: { increment: 1 } },
            create: { date: today, slotsUsed: 1, maxSlots: 10, isActive: true }
        }).catch(() => {});

        const slotsRemaining = Math.max(0, maxSlots - currentCount);
        return { granted: true, slotsRemaining, reason: 'SUCCESS' };
    } finally {
        await redis.del(lockKey);
    }
}

export async function getSlotsRemaining(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const used = await redis.get(`vip_promo:date:${today}`);
    const { maxSlots } = await getPromoConfig();
    return Math.max(0, maxSlots - (parseInt(used || '0', 10)));
}

export async function getEffectiveFeePercent(telegramId: string, normalFeePercent: number): Promise<number> {
    const status = await getVipStatus(telegramId);
    if (status.isVip && !status.isExpired) return 0;
    return normalFeePercent;
}

export async function startPromo(): Promise<void> { await redis.set('vip_promo:active', 'true'); }
export async function stopPromo(): Promise<void> { await redis.set('vip_promo:active', 'false'); }

export async function getPromoStats(): Promise<{ isActive: boolean; today: string; slotsUsed: number; slotsRemaining: number; totalVipsGrantedAllTime: number; currentlyActiveVips: number; }> {
    const isActive = (await redis.get('vip_promo:active')) === 'true';
    const today = new Date().toISOString().split('T')[0];
    const used = parseInt(await redis.get(`vip_promo:date:${today}`) || '0', 10);
    const { maxSlots } = await getPromoConfig();

    const [totalAllTime, currentlyActive] = await Promise.all([
        prisma.user.count({ where: { vipSource: { in: ['PROMO', 'EXPIRED'] } } }).catch(() => 0),
        prisma.user.count({ where: { isVip: true, vipSource: 'PROMO', vipExpiresAt: { gt: new Date() } } }).catch(() => 0)
    ]);

    return {
        isActive, today, slotsUsed: Math.min(used, maxSlots), slotsRemaining: Math.max(0, maxSlots - used),
        totalVipsGrantedAllTime: totalAllTime, currentlyActiveVips: currentlyActive
    };
}

export async function sweepExpiredVips() {
    try {
        const now = new Date();
        const expiredUsers = await prisma.user.findMany({
            where: { isVip: true, vipExpiresAt: { lt: now } },
            select: { id: true }
        });
        
        if (expiredUsers.length > 0) {
            await prisma.user.updateMany({
                where: { id: { in: expiredUsers.map(u => u.id) } },
                data: { isVip: false, vipSource: 'EXPIRED' }
            });
            console.log(`🧹 [VIP SWEEP] Demoted ${expiredUsers.length} expired VIPs.`);
        }
    } catch (e: any) {
        console.error("🔴 [VIP SWEEP] Error:", e.message);
    }
}