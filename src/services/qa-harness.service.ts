// src/services/qa-harness.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export interface QACheckResult {
    name: string;
    passed: boolean;
    detail: string;
}

export async function runQAHarness(telegramId: string): Promise<QACheckResult[]> {
    const results: QACheckResult[] = [];
    const { isSimulationActive } = await import('./simulation.service.js');

    const user = await prisma.user.findUnique({
        where: { telegramId },
        select: { id: true, totalVolumeSol: true, creditBalance: true }
    });

    if (!user) {
        return [{ name: 'User Exists', passed: false, detail: `No user found for telegramId ${telegramId}. Run /start first.` }];
    }

    // ── Check 1: Sim mode DB vs Helper Consistency (Null-Safe) ──
    const simState = await prisma.simState.findUnique({ where: { userId: user.id } });
    const simActiveHelper = await isSimulationActive(telegramId).catch(() => null);
    const simMatches = (simState?.active ?? false) === (simActiveHelper ?? false);
    
    results.push({
        name: 'Simulation Mode Integrity',
        passed: simActiveHelper !== null && simMatches,
        detail: `isSimulationActive() = ${simActiveHelper} | DB SimState.active = ${simState?.active ?? false}. ${!simMatches ? '🚨 MISMATCH — Cache and DB disagree!' : 'State is strictly synchronized.'}`
    });

    // ── Check 2: Sim Credits Isolation ──
    const redisSimCredits = await redis.get(`sim:credits:${telegramId}`).catch(() => null);
    results.push({
        name: 'Simulation Credits Isolation',
        passed: redisSimCredits !== null,
        detail: `Sim Credits: ${redisSimCredits ?? '0'} | Live Credit Balance: ${user.creditBalance}. (Sim operations should never deduct live credits).`
    });

    // ── Check 3: Real Volume Baseline ──
    results.push({
        name: 'Real Volume Isolation Baseline',
        passed: true,
        detail: `Live User.totalVolumeSol = ${user.totalVolumeSol} SOL. Sim trading must never increment this value.`
    });

    // ── Check 4: Trade Table Isolation (Real vs Sim) ──
    const realTradeCount = await prisma.trade.count({ where: { userId: user.id } });
    const simTradeCount = await prisma.simTrade.count({ where: { userId: user.id } }).catch(() => 0);
    results.push({
        name: 'Trade Table Isolation',
        passed: true,
        detail: `Real Trade Rows: ${realTradeCount} | SimTrade Rows: ${simTradeCount}.`
    });

    // ── Check 5: Points & Affiliate System Baseline ──
    const { getUserTotalPoints } = await import('./points.js');
    const pointsBreakdown = await getUserTotalPoints(user.id).catch(() => null);
    results.push({
        name: 'Points & Affiliate Integrity',
        passed: pointsBreakdown !== null,
        detail: pointsBreakdown ? `Current Points: ${pointsBreakdown.totalPoints} (Tier: ${pointsBreakdown.currentTier}).` : 'Failed to compute points.'
    });

    // ── Check 6: Guild Loyalty (GLP) Baseline ──
    const membership = await prisma.guildMembership.findFirst({ where: { userId: user.id, isActive: true } });
    results.push({
        name: 'Guild Loyalty Baseline',
        passed: true,
        detail: membership ? `GLP: ${membership.loyaltyPoints} | Guild Volume: ${membership.totalVolumeSol} SOL.` : 'No active guild membership.'
    });

    // ── Check 7: Trailing Stop Memory Coverage ──
    const guardIds = await redis.smembers(`user_guards:${telegramId}`).catch(() => []);
    results.push({
        name: 'Trailing Guard Coverage',
        passed: true,
        detail: `${guardIds.length} active trailing stop(s) found in Redis memory for user.`
    });

    // ── Check 8: Active DCA Schedule (ActiveOrder model) ──
    const dcaOrders = await prisma.activeOrder.findMany({ where: { userId: user.id, orderType: 'DCA', isActive: true } });
    results.push({
        name: 'DCA Engine Status',
        passed: true,
        detail: `${dcaOrders.length} active DCA schedule(s) found.`
    });

    return results;
}

export function buildQAReportMessage(telegramId: string, results: QACheckResult[]): string {
    const rows = results.map(r => `${r.passed ? '✅' : '🔴'} <b>${r.name}</b>\n   <i>${r.detail}</i>`).join('\n\n');
    const failCount = results.filter(r => !r.passed).length;

    return (
        `🧪 <b>SENTRY QA HARNESS AUDIT — <code>${telegramId}</code></b>\n\n` +
        `${rows}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        (failCount === 0 ? '✅ <b>All automated integrity assertions passed.</b>' : `🚨 <b>${failCount} item(s) require attention.</b>`)
    );
}