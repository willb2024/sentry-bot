// src/services/weekly_report.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';

const prisma = new PrismaClient();

export interface WeeklyStats {
    telegramId: string;
    username: string;
    totalVolumeSol: number;
    winRate: number;
    wins: number;
    losses: number;
    bestTrade: { token: string; pnlPercent: number } | null;
    worstTrade: { token: string; pnlPercent: number } | null;
    totalFeesPaidSol: number;
    affiliateEarnedSol: number;
    sentryPoints: number;
    pointsRank: number;
    totalUsers: number;
    weeklyPnlSol: number;
}

// 🟢 FIX: Added precomputedRank and totalUsersCount to parameters
export async function computeWeeklyStats(telegramId: string, precomputedRank?: number, totalUsersCount?: number): Promise<WeeklyStats | null> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.findUnique({
        where: { telegramId },
        include: {
            trades: {
                where: { createdAt: { gte: cutoff } },
                orderBy: { createdAt: 'desc' }
            },
            recruits: {
                include: {
                    trades: {
                        where: { createdAt: { gte: cutoff } }
                    }
                }
            }
        }
    });

    if (!user) return null;

    const weekTrades = user.trades || [];
    const sellTrades = weekTrades.filter(t => !t.isBuy);

    const totalVolumeSol = weekTrades.reduce((sum, t) => sum + t.amountInSol, 0);

    let wins = 0, losses = 0, weeklyPnlSol = 0;
    let bestTrade: { token: string; pnlPercent: number } | null = null;
    let worstTrade: { token: string; pnlPercent: number } | null = null;

    sellTrades.forEach(t => {
        const pnl = t.profitPercent || 0;
        const realizedSol = t.realizedPnlSol || 0;
        weeklyPnlSol += realizedSol;

        if (pnl > 0.5) wins++;
        else if (pnl < -0.5) losses++;

        if (!bestTrade || pnl > bestTrade.pnlPercent) {
            bestTrade = { token: t.tokenAddress, pnlPercent: pnl };
        }
        if (!worstTrade || pnl < worstTrade.pnlPercent) {
            worstTrade = { token: t.tokenAddress, pnlPercent: pnl };
        }
    });

    const totalClosed = wins + losses;
    const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;

    const totalFeesPaidSol = sellTrades.reduce((sum, t) => sum + (t.amountInSol * 0.01), 0);

    let affiliateEarnedSol = 0;
    user.recruits.forEach(r => {
        r.trades.forEach(t => {
            affiliateEarnedSol += t.affiliateCutSol || 0;
        });
    });

    const basePoints = Math.floor((user.totalVolumeSol || 0) * 10000);
    const recruitBonus = user.recruits.length * 2000;
    const welcomeBonus = user.referredById ? 10000 : 0;
    const sentryPoints = basePoints + recruitBonus + welcomeBonus;

    let pointsRank = precomputedRank;
    let totalUsers = totalUsersCount;

    // Fallback if called manually via /stats command
    if (pointsRank === undefined || totalUsers === undefined) {
        const allUsers = await prisma.user.findMany({ select: { telegramId: true, totalVolumeSol: true } });
        const sorted = allUsers
            .map(u => ({ telegramId: u.telegramId, points: Math.floor((u.totalVolumeSol || 0) * 10000) }))
            .sort((a, b) => b.points - a.points);
        pointsRank = sorted.findIndex(u => u.telegramId === telegramId) + 1;
        totalUsers = allUsers.length;
    }

    return {
        telegramId,
        username: user.username || user.telegramId,
        totalVolumeSol: parseFloat(totalVolumeSol.toFixed(4)),
        winRate: parseFloat(winRate.toFixed(1)),
        wins,
        losses,
        bestTrade,
        worstTrade,
        totalFeesPaidSol: parseFloat(totalFeesPaidSol.toFixed(4)),
        affiliateEarnedSol: parseFloat(affiliateEarnedSol.toFixed(4)),
        sentryPoints,
        pointsRank,
        totalUsers,
        weeklyPnlSol: parseFloat(weeklyPnlSol.toFixed(4))
    };
}

export function formatWeeklyReport(stats: WeeklyStats): string {
    const weekOf = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const pnlSign = stats.weeklyPnlSol >= 0 ? '+' : '';
    const pnlEmoji = stats.weeklyPnlSol >= 0 ? '📈' : '📉';
    const winEmoji = stats.winRate >= 60 ? '🔥' : stats.winRate >= 40 ? '⚡' : '📊';

    let tierLabel = '🥉 Bronze';
    if (stats.sentryPoints >= 1000000) tierLabel = '💎 Diamond';
    else if (stats.sentryPoints >= 250000) tierLabel = '🥇 Gold';
    else if (stats.sentryPoints >= 50000) tierLabel = '🥈 Silver';

    const bestLine = stats.bestTrade
        ? `• Best Trade: <code>${stats.bestTrade.token.substring(0, 8)}...</code> <b>${stats.bestTrade.pnlPercent >= 0 ? '+' : ''}${stats.bestTrade.pnlPercent.toFixed(1)}%</b>`
        : '• Best Trade: No closed positions';

    const worstLine = stats.worstTrade && stats.worstTrade.pnlPercent < 0
        ? `• Worst Trade: <code>${stats.worstTrade.token.substring(0, 8)}...</code> <b>${stats.worstTrade.pnlPercent.toFixed(1)}%</b>`
        : '• Worst Trade: No losses this week 🎯';

    return (
        `⚡ <b>SENTRY WEEKLY REPORT</b>\n` +
        `<i>Week of ${weekOf}</i>\n\n` +
        `👤 <b>Operator:</b> @${stats.username}\n` +
        `🏆 <b>Global Rank:</b> #${stats.pointsRank} of ${stats.totalUsers}\n` +
        `${tierLabel} · <b>${stats.sentryPoints.toLocaleString()} PTS</b>\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 <b>TRADING PERFORMANCE</b>\n\n` +
        `${pnlEmoji} Weekly PnL: <b>${pnlSign}${stats.weeklyPnlSol.toFixed(4)} SOL</b>\n` +
        `${winEmoji} Win Rate: <b>${stats.winRate}%</b> (${stats.wins}W / ${stats.losses}L)\n` +
        `💹 Volume Traded: <b>${stats.totalVolumeSol.toFixed(4)} SOL</b>\n` +
        `💸 Fees Paid: <b>${stats.totalFeesPaidSol.toFixed(4)} SOL</b>\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 <b>TOP TRADES</b>\n\n` +
        `${bestLine}\n` +
        `${worstLine}\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💰 <b>AFFILIATE EARNINGS</b>\n\n` +
        `• This Week: <b>+${stats.affiliateEarnedSol.toFixed(4)} SOL</b>\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `<i>Keep trading to climb the ranks. Next report in 7 days.</i>\n` +
        `<i>Type /stats for live stats anytime.</i>`
    );
}

export async function sendWeeklyReportsToAll(bot: any): Promise<void> {
    console.log('📬 [WEEKLY REPORT] Starting weekly report dispatch...');

    const allUsers = await prisma.user.findMany({ select: { telegramId: true, totalVolumeSol: true } });
    const sorted = [...allUsers].sort((a, b) => (b.totalVolumeSol || 0) - (a.totalVolumeSol || 0));
    const rankMap = new Map(sorted.map((u, i) => [u.telegramId, i + 1]));

    let sent = 0, failed = 0;

    for (const u of allUsers) {
        try {
            await new Promise(r => setTimeout(r, 50));
            const stats = await computeWeeklyStats(u.telegramId, rankMap.get(u.telegramId) || 0, allUsers.length);
            if (!stats) continue;

            if (stats.totalVolumeSol === 0 && stats.affiliateEarnedSol === 0) continue;

            const message = formatWeeklyReport(stats);
            await bot.telegram.sendMessage(u.telegramId, message, { parse_mode: 'HTML' });
            sent++;
        } catch (e: any) {
            failed++;
        }
    }

    console.log(`📬 [WEEKLY REPORT] Done. Sent: ${sent}, Failed/Skipped: ${failed}`);
}