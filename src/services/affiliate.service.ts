// src/services/affiliate.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export type AffiliateSource = 'TRADE_FEE' | 'CREDIT' | 'COPY';

export interface CreditAffiliateInput {
  referrerId: string;
  amountSol: number;
  source: AffiliateSource;
  fromUserId?: string;
}

export async function creditAffiliate(input: CreditAffiliateInput): Promise<boolean> {
  const { referrerId, source, fromUserId } = input;
  if (!referrerId) return false;

  const amt = parseFloat((input.amountSol || 0).toFixed(6));
  if (!(amt > 0)) return false;

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: referrerId },
        data: { pendingRewardsSol: { increment: amt } },
      }),
      prisma.affiliateEarning.create({
        data: { userId: referrerId, amountSol: amt, source, fromUser: fromUserId ?? null },
      }),
    ]);

    if (source === 'CREDIT') {
      await redis.incrbyfloat(`affiliate:credit_revenue:${referrerId}`, amt).catch(() => {});
    }

    await redis.del(`user_points_breakdown:${referrerId}`).catch(() => {});
    return true;
  } catch (e: any) {
    logger.error('🔴 [AFFILIATE] creditAffiliate failed:', { referrerId, source, amt, error: e.message });
    return false;
  }
}

export async function distributeTradeFee(input: {
  feeSol: number;
  payerUserId: string;
  referredById?: string | null;
  strategy: string;
}): Promise<{ affiliateCutSol: number }> {
  const feeLamports = BigInt(Math.round((input.feeSol || 0) * 1e9));
  if (feeLamports <= 0n) return { affiliateCutSol: 0 };

  let remaining = feeLamports;
  let affiliateCutSol = 0;

  // 1. Social Copy Leader: 50%
  if (input.strategy === 'Copy Trade') {
    try {
      const follow = await prisma.copyTradeFollow.findFirst({
        where: { followerId: input.payerUserId, isActive: true },
        select: { leaderId: true },
      });
      if (follow?.leaderId) {
        const leaderCut = (remaining * 50n) / 100n;
        remaining -= leaderCut;
        await creditAffiliate({
          referrerId: follow.leaderId,
          amountSol: Number(leaderCut) / 1e9,
          source: 'COPY',
          fromUserId: input.payerUserId,
        });
      }
    } catch (e: any) {
      logger.error('🔴 [AFFILIATE] Leader cut failed:', { error: e.message });
    }
  }

  // 2. Referrer: Tiered 50%-70% of remaining fee
  if (remaining > 0n && input.referredById) {
    try {
      const { getDynamicAffiliateRate } = await import('./points.js');
      const rate = await getDynamicAffiliateRate(input.referredById);
      const bps = BigInt(Math.round(rate * 10000));
      const affCut = (remaining * bps) / 10000n;
      remaining -= affCut;
      affiliateCutSol = Number(affCut) / 1e9;
      await creditAffiliate({
        referrerId: input.referredById,
        amountSol: affiliateCutSol,
        source: 'TRADE_FEE',
        fromUserId: input.payerUserId,
      });
    } catch (e: any) {
      logger.error('🔴 [AFFILIATE] Referrer cut failed:', { error: e.message });
    }
  }

  // 3. Guild Owner: 40% of remaining fee
  if (remaining > 0n) {
    try {
      const membership = await prisma.guildMembership.findFirst({
        where: { userId: input.payerUserId, isActive: true },
        include: { guild: { select: { ownerId: true } } },
      });
      if (membership?.guild?.ownerId) {
        const guildCut = (remaining * 40n) / 100n;
        await creditAffiliate({
          referrerId: membership.guild.ownerId,
          amountSol: Number(guildCut) / 1e9,
          source: 'TRADE_FEE',
          fromUserId: input.payerUserId,
        });
      }
    } catch (e: any) {
      logger.error('🔴 [AFFILIATE] Guild cut failed:', { error: e.message });
    }
  }

  return { affiliateCutSol: parseFloat(affiliateCutSol.toFixed(6)) };
}

export async function getAffiliateTotals(userId: string, sinceDate?: Date): Promise<{
  windowSol: number;
  lifetimeSol: number;
}> {
  const [windowAgg, lifetimeAgg] = await Promise.all([
    sinceDate
      ? prisma.affiliateEarning.aggregate({ where: { userId, createdAt: { gte: sinceDate } }, _sum: { amountSol: true } })
      : Promise.resolve({ _sum: { amountSol: 0 } } as any),
    prisma.affiliateEarning.aggregate({ where: { userId }, _sum: { amountSol: true } }),
  ]);

  return {
    windowSol: parseFloat((windowAgg._sum.amountSol || 0).toFixed(6)),
    lifetimeSol: parseFloat((lifetimeAgg._sum.amountSol || 0).toFixed(6)),
  };
}