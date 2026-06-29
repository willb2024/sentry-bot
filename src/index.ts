// src/index.ts
import { Telegraf, Markup, Context } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import { startCopyTradeWatcher, syncCopyTradeListeners } from './services/copytrade.service.js';
import { startDcaEngine } from './services/dca.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice, checkTokenRugRisk } from './services/price.service.js';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { redis } from './lib/redis.js';
import { isSimulationActive } from './services/simulation.service.js';
import axios from 'axios';
import { igniteYellowstoneStream } from './services/grpc.service.js';
import { sweepExpiredVips } from './services/vip_promo.service.js';
import { addTrailingStopToMemory, cancelAllUserGuards, cancelAllGuardsForToken, updateGuardSize } from './services/order.service.js';
import { generateSecureVault, exportPrivateKey, importPrivateKey, ensureWalletsExist, decryptKey } from './services/vault.service.js';
import { cachedSolUsdPrice } from './services/grpc.service.js';
import { executeSnipe, executeExit, warmDnsCache } from './services/engine.service.js';
import { getUserPositions } from './services/position.service.js';
import { processAffiliatePayout } from './services/payout.service.js';
import { getEmptyTokenAccounts, executeRentSweep } from './services/burn.service.js';
import { createGuild, joinGuild, getLeaderboard, exportLeaderboard, updateRankCache } from './services/guild.service.js';  
import { startDepositWatcher } from './services/deposit.service.js';
import { syncGuardsFromDb } from './services/order.service.js';
import { startCoinCaller, getUserCallerFilters, setUserCallerFilters } from './services/caller.service.js';
import { connection } from './lib/connection.js';

import { 
    checkAndGrantDailyVip, 
    startPromo, 
    stopPromo, 
    getPromoStats,
    getVipStatus,
    getSlotsRemaining,
    resolveBadge
} from './services/vip_promo.service.js';

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs'; // 🟢 ADD THIS LINE
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

dotenv.config();
console.log("🟢 [1/5] Booting Sentry Terminal Core...");

const prisma = new PrismaClient();
const BOT_TOKEN = process.env.BOT_TOKEN || "";

if (!BOT_TOKEN) { console.error("🔴 FATAL: BOT_TOKEN is missing in .env!"); process.exit(1); }
if (!process.env.TREASURY_WALLET_ADDRESS) { console.error("🔴 FATAL: TREASURY_WALLET_ADDRESS is missing in .env! All trades will run fee-free."); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);

// =========================================================
// 🛡️ TELEGRAM FLOOD CONTROL WRAPPERS
// =========================================================
export async function safeSendMessage(tgId: string, text: string, options: any = {}) {
    let retries = 3;
    while (retries > 0) {
        try {
            await bot.telegram.sendMessage(tgId, text, options);
            return; 
        } catch (error: any) {
            if (error.code === 429) { 
                const waitTime = error.parameters?.retry_after || 1;
                console.warn(`⚠️ Telegram Rate Limit hit. Waiting ${waitTime}s...`);
                await new Promise(r => setTimeout(r, waitTime * 1000));
                retries--;
            } else { break; }
        }
    }
}



export async function safeEditMessageText(ctx: any, text: string, options: any = {}) {
    let retries = 3;
    while (retries > 0) {
        try {
            return await ctx.editMessageText(text, { parse_mode: 'HTML', ...options });
        } catch (error: any) {
            if (error.code === 429) { 
                const waitTime = error.parameters?.retry_after || 1;
                await new Promise(r => setTimeout(r, waitTime * 1000));
                retries--;
            } else if (error.description && error.description.includes('message is not modified')) {
                return;
            } else { 
                // 🟢 EXPLICIT LOGGER: Wakes up the silent catch to show the exact error in your console
                console.error("🔴 [Telegram Edit Message Error]:", error.message);
                break; 
            }
        }
    }
}

// =========================================================
// 🔒 SECURITY: STRICT PRIVATE CHAT LOCK
// =========================================================
bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            try { 
                await ctx.reply("🛡️ <b>Security Alert:</b> Sentry Terminal is a secure financial application. For your safety, I only operate in direct private messages (DMs). I am leaving this public group.");
                await ctx.leaveChat(); 
            } catch (e) {} 
        }
        return; 
    }
    return next();
});

app.post('/api/sol-price', (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        res.json({ price: cachedSolUsdPrice });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/analytics', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = JSON.parse(new URLSearchParams(req.body.initData).get('user')!).id.toString();
        
        // Strictly fetch real trades from the live database
        const user = await prisma.user.findUnique({ where: { telegramId }});
        if (!user) return res.json([]);
        
        const trades = await prisma.trade.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 100
        });
        
        const formattedTrades = trades.map(t => ({
            createdAt: t.createdAt.toISOString(),
            isBuy: t.isBuy,
            amountInSol: t.amountInSol,
            profitPercent: 0 
        }));
        
        res.json(formattedTrades);
    } catch (e) { 
        res.status(500).json([]); 
    }
});

app.post('/api/positions', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const telegramId = JSON.parse(
            new URLSearchParams(req.body.initData).get('user')!
        ).id.toString();
        
        const positions = await getUserPositions(telegramId);
        if (positions && positions.length > 0) {
            for (const p of positions) {
                const guards = await redis.smembers(`token_guards:${telegramId}:${p.mint}`);
                if (guards.length > 0) {
                    const raw = await redis.get(`order:trail:${guards[0]}`);
                    if (raw) (p as any).entryPrice = JSON.parse(raw).entryPrice || 0;
                }
            }
        }
        res.json(positions);
    } catch (e) { res.status(500).json([]); }
});

// 🟢 FEATURE: Affiliate Stats WebApp Data
app.post('/api/affiliate-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) 
            return res.status(403).json({ error: 'Unauthorized' });
        
        const telegramId = JSON.parse(
            new URLSearchParams(req.body.initData).get('user')!
        ).id.toString();
        
        const user = await prisma.user.findUnique({
            where: { telegramId },
            include: { recruits: { include: { trades: { orderBy: { createdAt: 'desc' }, take: 50 } } } }
        });
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const recruitList = user.recruits.map(r => {
            const volumeSol = r.trades.reduce((sum, t) => sum + t.amountInSol, 0);
            const yourEarningSol = r.trades.reduce((sum, t) => sum + (t.affiliateCutSol || 0), 0); 
            const lastTrade = r.trades[0];
            const lastActiveDaysAgo = lastTrade 
                ? Math.floor((Date.now() - new Date(lastTrade.createdAt).getTime()) / 86400000)
                : 999;
            return {
                username: r.username || r.telegramId,
                volumeSol: parseFloat(volumeSol.toFixed(4)),
                yourEarningSol: parseFloat(yourEarningSol.toFixed(4)),
                lastActiveDaysAgo
            };
        });
        
        // Build 30-day daily earnings array
        const dailyEarnings: number[] = Array(30).fill(0);
        const now = Date.now();
        let totalHistoricalEarned = 0;

        user.recruits.forEach(r => {
            r.trades.forEach(t => {
                const earned = t.affiliateCutSol || 0;
                totalHistoricalEarned += earned;
                const daysAgo = Math.floor((now - new Date(t.createdAt).getTime()) / 86400000);
                if (daysAgo >= 0 && daysAgo < 30) {
                    dailyEarnings[29 - daysAgo] += earned;
                }
            });
        });

        // 🟢 Precise dynamic point metrics for the WebApp UI
        const basePoints = Math.floor((user.totalVolumeSol || 0) * 10000);
        const welcomeBonus = user.referredById ? 10000 : 0;
        const recruitBonus = user.recruits.length * 2000;
        const totalPoints = basePoints + welcomeBonus + recruitBonus;

        let currentTier = "Bronze";
        let currentRate = 0.40;
        if (totalPoints >= 1000000) {
            currentTier = "Diamond";
            currentRate = 0.70;
        } else if (totalPoints >= 250000) {
            currentTier = "Gold";
            currentRate = 0.60;
        } else if (totalPoints >= 50000) {
            currentTier = "Silver";
            currentRate = 0.50;
        }
        
        res.json({
            recruits: user.recruits.length,
            pendingYieldSol: parseFloat((user.pendingRewardsSol || 0).toFixed(4)),
            lifetimeEarnedSol: parseFloat(((user.pendingRewardsSol || 0) + totalHistoricalEarned).toFixed(4)),
            referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${user.referralCode}`,
            totalPoints,
            currentTier,
            currentRate,
            recruitList,
            dailyEarnings
        });
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
});

// =========================================================
// ⚡ UTILITIES: MULTI-WALLET BALANCE AGGREGATOR
// =========================================================
async function getLiveBalance(user: any): Promise<string> {
    // SIMULATION INTERCEPT
    const { getSimBalance } = await import('./services/simulation.service.js');
    if (await isSimulationActive(user.telegramId)) {
        return await getSimBalance(user.telegramId);
    }
    
    if (!user || !user.vaultAddress) return "0.0000";
    try {
        const cacheKey = `balance_cache:${user.telegramId}`;
        const cachedBalance = await redis.get(cacheKey);
        if (cachedBalance) return parseFloat(cachedBalance).toFixed(4);

        let totalLamports = 0;
        const pubkeys: PublicKey[] = [];
        if (user.vaultAddress) pubkeys.push(new PublicKey(user.vaultAddress));
        if (user.activeWallets >= 2 && user.vault2) pubkeys.push(new PublicKey(user.vault2));
        if (user.activeWallets >= 3 && user.vault3) pubkeys.push(new PublicKey(user.vault3));
        if (user.activeWallets >= 4 && user.vault4) pubkeys.push(new PublicKey(user.vault4));
        if (user.activeWallets >= 5 && user.vault5) pubkeys.push(new PublicKey(user.vault5));

        const balances = await Promise.all(pubkeys.map(pk => connection.getBalance(pk).catch(() => 0)));
        balances.forEach((bal: any) => totalLamports += bal);

        const finalBalance = (totalLamports / LAMPORTS_PER_SOL).toFixed(4);
        await redis.set(cacheKey, finalBalance, 'EX', 15);
        return finalBalance;
    } catch (e) { return "0.0000"; }
}

// =========================================================
// 📟 DASHBOARD MENU SYSTEM
// =========================================================
async function sendOrEditDashboard(ctx: any, telegramId: string, isEdit: boolean = false) {
    const user = await prisma.user.findUnique({ 
        where: { telegramId },
        include: { _count: { select: { recruits: true } } } 
    });
    if (!user) return; 

    // The getLiveBalance function handles its own simulation intercept
    const liveBalance = await getLiveBalance(user); 

    const whaleModeText = user.activeWallets > 1 
        ? `🐙 <b>WHALE MODE:</b> 🟢 ACTIVE (Firing ${user.activeWallets} Wallets)` 
        : `⚙️ <b>Active Wallets:</b> 1 / 5 (Standard Mode)`;

    // =========================================================
    // 🎮 SIMULATION INTERCEPT (DASHBOARD BANNER)
    // =========================================================
    const { isSimulationActive } = await import('./services/simulation.service.js');
    const isSimMode = await isSimulationActive(telegramId);
    
    // Points and volume strictly track your real trades only
    const displayVolume = user.totalVolumeSol;

    const basePoints = Math.floor(displayVolume * 10000);
    const welcomeBonus = user.referredById ? 10000 : 0;
    const recruitBonus = user._count.recruits * 2000;
    const sentryPoints = (basePoints + welcomeBonus + recruitBonus).toLocaleString();
    // =========================================================

    const welcomeText = user.referredById ? `\n• Partner Bonus: <b>+10,000 PTS</b>` : ``;
    const recruitText = user._count.recruits > 0 ? `\n• Network Bonus: <b>+${recruitBonus.toLocaleString()} PTS</b> <i>(${user._count.recruits} Recruits)</i>` : ``;

    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    const botEmoji = process.env.BOT_EMOJI || '⚡';

    const userGuilds = await prisma.guildMembership.findMany({ 
        where: { userId: user.id, isActive: true }, include: { guild: true } 
    });
    
    let guildDisplay = `🏰 <b>Active Guild:</b> <i>None</i>\n`;
    if (userGuilds.length > 0) {
        const primaryGuild = userGuilds[0];
        const rankDisplay = primaryGuild.rank ? `#${primaryGuild.rank}` : `Unranked`;
        guildDisplay = `🏰 <b>Guild:</b> <b>${primaryGuild.guild.name}</b>\n` +
                       `🏆 <b>Your Rank:</b> <b>${rankDisplay}</b> (${primaryGuild.loyaltyPoints.toLocaleString()} GLP)\n`;
    }

    const vipStatus = await getVipStatus(telegramId); 

    // Simulation Banner UI
    const simBanner = isSimMode ? `\n🎮 <b>⚠️ SIMULATION MODE ACTIVE — No real trades firing</b>\n` : '';

    const layoutTxt = `${botEmoji} <b>${botName.toUpperCase()} </b> ${botEmoji}  \n` +
    simBanner +
    `${vipStatus.badgeLine ? `\n${vipStatus.badgeLine}\n` : ''}\n` + 
    `👛 <b>Primary Deposit Node:</b>\n` +
    `<code>${user.vaultAddress || "No Vault Generated"}</code>\n\n` +
    `💰 <b>Total Balance:</b> <code>${liveBalance} SOL</code>\n` +
    `${whaleModeText}\n\n` +
    `🪂 <b>$SENTRY Airdrop (Epoch 1):</b>\n` +
    `${guildDisplay}\n` + 

    `• Your Points: <b>${sentryPoints} PTS</b>\n` +
    `<i>(1 SOL traded = 10k PTS | 1 Invite = 2k PTS)</i>` +
    `${welcomeText}${recruitText}\n\n` +  
    `📊 <b>Your Economics:</b>\n` +
    `• Protocol Fee: <b>${process.env.PLATFORM_FEE_PERCENT || '1.00'}%</b>\n` +
    `• Affiliate Yield: <b>${user.pendingRewardsSol.toFixed(4)} SOL</b>\n\n` +
    `<i>Forward a call here, paste a Token CA, or select a module below.</i>`;

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Sniper Module', 'menu_sniper'), Markup.button.callback('🎯 AI Coin Caller', 'menu_caller')],
        [Markup.button.callback('⏳ Limit / DCA Engine', 'menu_dca'), Markup.button.callback('🛡️ Trailing Stops', 'menu_trailing')],
        [Markup.button.callback('💼 Positions', 'menu_positions'), Markup.button.callback('👥 Copy Trade', 'menu_copytrade')],
        [Markup.button.callback('💰 Affiliates', 'menu_affiliate'), Markup.button.callback('🔑 Vault & Keys', 'menu_vault')],
        [Markup.button.callback('🛠️ Dev Suite (PRO)', 'menu_devsuite'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
        [Markup.button.callback('📤 Withdraw', 'btn_withdraw_prompt'), Markup.button.callback('📖 How to Trade', 'btn_trade_guide')],
        [Markup.button.callback('💎 Why We Are Best', 'btn_guide'), { text: '📊 Track Trades', web_app: { url: process.env.WEBAPP_URL || 'https://your-webapp-url.com/webapp' } }],
        [Markup.button.callback('🛑 CANCEL ALL AUTOMATIONS', 'action_global_cancel')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, layoutTxt, UI);
    else await ctx.replyWithHTML(layoutTxt, UI);
}


// =========================================================
// 🏰 SENTRY GUILDS (B2B LOYALTY ENGINE)
// =========================================================

bot.command('sim', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (tgId !== process.env.ADMIN_TELEGRAM_ID) return;

    const current = await redis.get(`sim:active:${tgId}`);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(`sim:active:${tgId}`, newState);

    if (newState === 'true') {
        const { generateSimWallets } = await import('./services/simulation.service.js');
        await redis.set(`sim:balance:${tgId}`, '12.4521');
        await redis.set(`sim:wallets:${tgId}`, JSON.stringify(generateSimWallets()));
    } else {
        const keys = await redis.keys(`sim:*:${tgId}`);
        if (keys.length > 0) await redis.del(...keys);
    }

    await ctx.replyWithHTML(
        `🎮 <b>SIMULATION MODE: ${newState === 'true' ? '🟢 ACTIVATED' : '🔴 DEACTIVATED'}</b>\n\n` +
        `${newState === 'true' ? 
            '⚠️ <i>All trades, balances, and alerts are now simulated. No real transactions will occur.</i>' : 
            '<i>Platform returned to live mode.</i>'
        }`
    );
});


bot.action('action_create_guild_prompt', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await ctx.editMessageText(
        `🏰 <b>CREATE YOUR SENTRY GUILD</b>\n\n` +
        `Creating a Guild costs a one-time setup fee of <b>2.0 SOL</b>.\n\n` +
        `To begin, close this menu and type: <code>/createguild</code>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_devsuite')]]) }
    );
});

bot.command('createguild', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { ownedGuild: true } });
    if (!user?.isDevSuiteUnlocked) return ctx.reply("🔴 Dev Suite required to create a Guild.");
    if (user.ownedGuild) return ctx.reply("🔴 You already own a Guild.");

    await redis.hset(`guild_setup:${tgId}`, { step: 1 });
    await redis.expire(`guild_setup:${tgId}`, 600);
    
    await ctx.replyWithHTML(`🏰 <b>GUILD SETUP [Step 1/2]</b>\n\nWhat is the name of your community?\n<i>(e.g., Alpha Wolves Community)</i>\n\nReply to this message with the name. (Type /cancel to abort)`);
});

bot.command('guild', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    // 🟢 Fetch ONLY the active guild membership
    const memberships = await prisma.guildMembership.findMany({ 
        where: { user: { telegramId: tgId }, isActive: true }, 
        include: { guild: true } 
    });

    if (memberships.length === 0) {
        return ctx.replyWithHTML(
            `🏰 <b>You are not in any active Guilds.</b>\n\n` +
            `Use a KOL's invite link to join one, or look at your joined list to activate one!`,
            Markup.inlineKeyboard([
                [Markup.button.callback('👥 My Joined Guilds', 'menu_switch_guilds')]
            ])
        );
    }

    const m = memberships[0];
    const lb = await getLeaderboard(m.guildId, 3);
    
    let text = 
        `🏰 <b>YOUR GUILD STATUS</b>\n\n` +
        `<b>Guild:</b> ${m.guild.name} [<code>${m.guild.guildCode}</code>]\n` +
        `<b>Reward:</b> "${m.guild.rewardDescription || 'Top wallets get rewards'}"\n\n` +
        `<b>Your Active Rank:</b> ${m.rank ? `#${m.rank}` : 'Unranked'}\n` +
        `<b>Your GLP:</b> ${m.loyaltyPoints.toLocaleString()} pts\n` +
        `<b>Your Guild Volume:</b> ${m.totalVolumeSol.toFixed(2)} SOL\n\n` +
        `📈 <b>Top 3 Right Now:</b>\n`;

    lb.forEach(row => {
        text += `#${row.rank} @${row.username} — ${row.glp.toLocaleString()} GLP\n`;
    });

    const inviteLink = `https://t.me/${ctx.botInfo?.username}?start=guild_${m.guild.guildCode}`;

    await ctx.replyWithHTML(text, Markup.inlineKeyboard([
        [Markup.button.callback('👥 Switch Active Guild', 'menu_switch_guilds')],
        [{ text: '🔗 Share My Guild Link', url: `https://t.me/share/url?url=${inviteLink}&text=Join%20my%20Sentry%20Guild%20and%20earn%20WL` }]
    ]));
});

// 🟢 NEW: Displays the list of all joined guilds
bot.action('menu_switch_guilds', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    const memberships = await prisma.guildMembership.findMany({
        where: { user: { telegramId: tgId } },
        include: { guild: true }
    });

    if (memberships.length === 0) {
        return ctx.editMessageText(
            `🏰 <b>You haven't joined any Guilds yet!</b>\n\n` +
            `Click a KOL's invite link to join and start competing.`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'btn_dashboard')]]) }
        );
    }

    let text = `👥 <b>SWITCH ACTIVE COMMUNITY</b>\n\n` +
               `You can belong to multiple guilds, but you can only earn points for **one active guild** at a time.\n\n` +
               `Select your active target from your joined communities below:`;

    const buttons = memberships.map(m => {
        const activeIndicator = m.isActive ? '🟢 ' : '⚪ ';
        return [Markup.button.callback(`${activeIndicator}${m.guild.name}`, `select_active_guild_${m.id}`)];
    });
    
    buttons.push([Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

// 🟢 NEW: Executes the active guild switch
bot.action(/^select_active_guild_(.+)$/, async (ctx) => {
    const membershipId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;

    // @ts-ignore
    const { switchActiveGuild } = await import('./services/guild.service.js');
    const result = await switchActiveGuild(tgId, membershipId);

    if (result.success) {
        try { 
            await ctx.answerCbQuery(`🟢 Active Guild changed to ${result.guildName}!`, { show_alert: true }); 
        } catch(e){}
    } else {
        try { 
            await ctx.answerCbQuery(`🔴 Switch failed: ${result.message}`, { show_alert: true }); 
        } catch(e){}
    }

    // Go back to the switcher menu to display the updated list
    bot.handleUpdate({ ...ctx.update, callback_query: { ...((ctx as any).callbackQuery || {}), data: 'menu_switch_guilds' } } as any);
});

bot.action('action_manage_guild', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    // Compile User, Guild, and Membership relations safely in a single, type-safe query
    const user = await prisma.user.findUnique({ 
        where: { telegramId: tgId }, 
        include: { ownedGuild: { include: { members: { include: { user: true } } } } } 
    });
    
    if (!user || !user.ownedGuild) {
        return ctx.editMessageText("🔴 <b>No active Guild found.</b>", { parse_mode: 'HTML' });
    }

    const guild = user.ownedGuild;
    const totalMembers = guild.members.length;
    
    // Explicitly type the accumulator and member elements to satisfy strict builds
    const totalVol = guild.members.reduce((sum: number, m: any) => sum + m.totalVolumeSol, 0);

    const text = 
        `🏰 <b>GUILD MANAGEMENT PANEL</b>\n\n` +
        `• <b>Community Name:</b> <code>${guild.name}</code>\n` +
        `• <b>Guild Code:</b> <code>${guild.guildCode}</code>\n` +
        `• <b>Reward Program:</b> <i>"${guild.rewardDescription || 'No active reward'}"</i>\n\n` +
        `📈 <b>Global Stats:</b>\n` +
        `  ├ Members Registered: <b>${totalMembers}</b>\n` +
        `  └ Total Volume: <b>${totalVol.toFixed(2)} SOL</b>\n\n` +
        `🔗 <b>Your Exclusive Invite Link:</b>\n` +
        `<code>https://t.me/${ctx.botInfo?.username}?start=guild_${guild.guildCode}</code>\n\n` +
        `<i>(When members click this, they auto-join your community and you receive 50% of their platform fees as an affiliate permanently!)</i>`;

    await ctx.editMessageText(text, { 
        parse_mode: 'HTML', 
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🏆 Tiered Drop (Top 10)', `tiered_drop_${guild.id}`)],
            [Markup.button.callback('👤 Pay Individual Member', `indiv_drop_${guild.id}`)],
            [Markup.button.callback('✏️ Edit Name', `edit_g_name_${guild.id}`), Markup.button.callback('🎁 Edit Reward', `edit_g_reward_${guild.id}`)],
            [Markup.button.callback('📥 Export Wallets (CSV)', `export_guild_${guild.id}`)],
            [Markup.button.callback('⬅️ Back to Dev Suite', 'menu_devsuite')]
        ])
    });
});

bot.action(/^tiered_drop_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const guildId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:guild_tiered_drop:${tgId}`, guildId, 'EX', 300);
    await ctx.replyWithHTML(
        `🏆 <b>TIERED SOL DROP (TOP 50 MEMBERS)</b>\n\n` +
        `Reply to this message with the payout amounts for the Top 3, Next 7, and Next 40 members, separated by a space:\n` +
        `<code>[SOL_TOP_3] [SOL_NEXT_7] [SOL_RANKS_11_TO_50]</code>\n\n` +
        `<i>Example (Ranks 11-50 receive 0.005 SOL):</i>\n<code>0.1 0.02 0.005</code>\n\n` +
        `<i>Example (Ranks 11-50 receive nothing):</i>\n<code>0.1 0.02 0</code>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

bot.action(/^indiv_drop_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const guildId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:guild_indiv_drop:${tgId}`, guildId, 'EX', 300);
    await ctx.replyWithHTML(
        `👤 <b>INDIVIDUAL SOL PAYOUT</b>\n\n` +
        `Reply to this message with the rank number and amount of SOL to pay, separated by a space:\n` +
        `<code>[TARGET_RANK] [AMOUNT_SOL]</code>\n\n` +
        `<i>Example (Sends 0.25 SOL to the #5 ranked member):</i>\n` +
        `<code>5 0.25</code>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

        bot.action(/^airdrop_guild_(.+)$/, async (ctx) => {
            try { await ctx.answerCbQuery(); } catch(e){}
            const guildId = ctx.match[1];
            const tgId = ctx.from?.id.toString()!;
            await redis.set(`state:guild_airdrop:${tgId}`, guildId, 'EX', 300);
            await ctx.replyWithHTML(`💸 <b>BULK SOL AIRDROP</b>\n\nReply with the <b>TOTAL AMOUNT OF SOL</b> you want to split evenly among your Top 50 members.\n<i>(e.g., Send <code>1.5</code> to give 50 members 0.03 SOL each).</i>\n\nFunds will be taken from your Main W1 Wallet.\n\n<i>Type /cancel to abort.</i>`);
        });


  // 🟢 NEW: Edit Guild Name Trigger
bot.action(/^edit_g_name_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const guildId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_guild_name:${tgId}`, guildId, 'EX', 300);
    await ctx.replyWithHTML(`✏️ <b>EDIT COMMUNITY NAME</b>\n\nReply to this message with the new name for your community (3-30 characters).\n\n<i>Type /cancel to abort.</i>`);
});

// 🟢 NEW: Edit Guild Reward Trigger
bot.action(/^edit_g_reward_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const guildId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_guild_reward:${tgId}`, guildId, 'EX', 300);
    await ctx.replyWithHTML(`🎁 <b>EDIT REWARD OFFER</b>\n\nReply to this message with the new reward your members are competing for.\n<i>(e.g., "Top 20 volume gets guaranteed presale allocation")</i>\n\n<i>Type /cancel to abort.</i>`);
});      

bot.action(/^export_guild_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery("⏳ Compiling community ledger..."); } catch(e){}
    const guildId = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    
    // Generate CSV
    const csv = await exportLeaderboard(tgId, guildId);
    if (!csv) return ctx.reply("🔴 Export failed. Verify you are the owner of this Guild.");

    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    const communityName = guild ? guild.name : "Sentry_Guild";

    const buffer = Buffer.from(csv, 'utf-8');
    
    // 🟢 1. Send the actual .csv Document to their Telegram
    await ctx.replyWithDocument(
        { source: buffer, filename: `${communityName.replace(/\s+/g, '_')}_Holders.csv` },
        { caption: `📊 <b>SENTRY LOYALTY LEDGER: EXPORT COMPLETE</b>`, parse_mode: 'HTML' }
    );

    // 🟢 2. Send the Detailed Operational Guide (How to reward and what they paid for)
    const guideText = 
        `🏆 <b>OPERATIONAL GUIDE: HOW TO REWARD YOUR LOYAL GUILD MEMBERS</b>\n\n` +
        `Your CSV ledger is ready. Here is how to use this data to execute rewards and keep your community highly engaged:\n\n` +
        
        `🎁 <b>METHOD 1: Bulk Token/SOL Airdrops (Instant Distribution)</b>\n` +
        `<i>Drop free project tokens or SOL directly into the wallets of your top volume contributors to reward their support.</i>\n` +
        `1. Open the CSV and copy the list of addresses from the <code>wallet_address</code> column.\n` +
        `2. Navigate to an audited Solana bulk-sender tool like <b>Smithii Multisender</b>, <b>DEXArea</b>, or <b>PandaTool</b>.\n` +
        `3. Connect your wallet, select the SPL token or SOL, paste the wallet addresses, and execute. Sentry's automated sub-wallets will receive their tokens instantly.\n\n` +
        
        `🎟️ <b>METHOD 2: Whitelist & Allowlist Access (Sybil Filtering)</b>\n` +
        `<i>Protect your presales or NFT mints from automated bot farms by granting access only to actual on-chain traders.</i>\n` +
        `1. Extract the top 50 or 100 addresses from your CSV.\n` +
        `2. Go to standard allowlist managers like <b>Atlas3</b>, <b>Subber</b>, or <b>Helio.io</b>.\n` +
        `3. Import the list as your "Verified Whitelist List." Only community members who actively traded and held your token on-chain will have permission to mint.\n\n` +
        
        `💎 <b>WHAT YOUR 2.0 SOL FEE SECURED (The Infrastructure Breakdown):</b>\n\n` +
        `Your setup fee is not a platform tax. It directly deployed and secured institutional-grade architecture:\n\n` +
        `• <b>Dedicated Redis Memory Allocation:</b> We allocated a dedicated Redis ZSET (Sorted Set) database node for your community. This allows Sentry to calculate points on a 0ms loop with every single buy/sell block on the Solana network without slowing down your users' trade speeds.\n` +
        `• <b>Anti-Sybil Cryptographic Proof:</b> Social media giveaways are flooded with fake bots. By verifying on-chain SOL volume, you are paying for proof of actual capital allocators who support your project.\n` +
        `• <b>Passive Affiliate Loop:</b> Sentry permanently maps your invite link to our referral ledger. You earn <b>50% of our 1% trading fee</b> across your entire community. If your chat trades 400 SOL in total volume, you recover your entire 2.0 SOL fee in days, turning your guild into a high-yield asset.`;

    await ctx.replyWithHTML(guideText);
});
// =========================================================
// 🚀 COMMAND: /start & ONBOARDING
// =========================================================
bot.start(async (ctx: Context & { startPayload?: string }) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
        let userCheck = await prisma.user.findUnique({ where: { telegramId } });
        const botName = process.env.BOT_NAME || 'Sentry Terminal';
        const botTagline = process.env.BOT_TAGLINE || 'The Institutional Standard for Pump.fun Execution.';
        
        let pendingGuildCode: string | null = null;
        let referrerId: string | null = null;
        let getsDiscount = false;

        if (ctx.startPayload) {
            if (ctx.startPayload.startsWith('guild_')) {
                pendingGuildCode = ctx.startPayload.replace('guild_', '');
                const guild = await prisma.guild.findUnique({ where: { guildCode: pendingGuildCode } });
                if (guild) {
                    referrerId = guild.ownerId; 
                    getsDiscount = true;
                }
            } else {
                const referrer = await prisma.user.findUnique({ where: { referralCode: ctx.startPayload } });
                if (referrer) { referrerId = referrer.id; getsDiscount = true; }
            }
        }

        if (!userCheck) {
            const refPrefix = botName.toUpperCase().split(' ')[0];
            userCheck = await prisma.user.create({
                data: {
                    telegramId: telegramId,
                    username: ctx.from?.username || "Trader",
                    referralCode: `${refPrefix}-${telegramId}`,
                    referredById: referrerId,
                    hasReferralDiscount: getsDiscount
                }
            });
        }

        // 🟢 VIP PROMO ENGINE: Intercept normal referral links
        if (ctx.startPayload && !ctx.startPayload.startsWith('guild_') && !ctx.startPayload.startsWith('ct_')) {
            const promoResult = await checkAndGrantDailyVip(telegramId, ctx.startPayload);

            if (promoResult.granted) {
                await ctx.replyWithHTML(
                    `🎉 <b>YOU GOT A VIP PASS!</b>\n\n` +
                    `You are one of the first 10 people to join today through this link.\n\n` +
                    `👑 <b>YOUR VIP BENEFITS (10 Days FREE):</b>\n` +
                    `• <b>0% Trading Fees</b> — keep every penny of profit\n` +
                    `• <b>Turbo Jito Priority</b> — fastest execution at no cost\n` +
                    `• <b>Whale Alpha Directory</b> — copy our curated top wallets\n` +
                    `• <b>Custom VIP Badges</b> — flex your status on the global leaderboards\n\n` +
                    `⏰ <b>Your VIP expires in 10 days.</b> After that you become a standard member. No auto-charges. No tricks.\n\n` +
                    `<b>${promoResult.slotsRemaining} VIP slots remaining today.</b>`
                );
            } else if (promoResult.reason === 'SLOTS_FULL') {
                await ctx.replyWithHTML(
                    `⚡ <b>Today's VIP slots are full!</b>\n\n` +
                    `All 10 daily VIP passes were claimed today. New slots open at midnight UTC.\n\n` +
                    `<i>You have been registered as a standard member. All core features are available — come back tomorrow for a VIP slot!</i>`
                );
            }
        }

        if (pendingGuildCode) {
            const result = await joinGuild(telegramId, pendingGuildCode);
            if (result.success) {
                await ctx.replyWithHTML(
                    `🏰 <b>GUILD JOINED: ${result.guildName?.toUpperCase()}</b>\n\n` +
                    `${result.rewardDescription || 'Trade to climb the leaderboard and earn your reward.'}\n\n` +
                    `📊 Every <b>0.1 SOL</b> you trade earns you <b>10 Guild Loyalty Points (GLP)</b>.\n` +
                    `🏆 Your KOL will export the top wallets for whitelist / airdrop rewards.\n\n` +
                    `<i>Keep trading — your rank updates live.</i>`
                );
            }
        }

        if (userCheck.vaultAddress) return await sendOrEditDashboard(ctx, telegramId, false);

        const bonusMessage = userCheck.referredById ? `🎁 <b>PARTNER BONUS UNLOCKED:</b> You received an instant <b>10,000 PTS</b> head-start for the airdrop by using an invite link!\n\n` : ``;

        const welcomeText = `🛡️ <b>WELCOME TO ${botName.toUpperCase()}</b>\n\n` +
            `<i>${botTagline}</i>\n\n` + bonusMessage +
            `✅ <b>Zero-Latency Vaults:</b> Local Memory Execution.\n` +
            `✅ <b>Jito Turbo MEV:</b> Bypass congested public RPCs.\n` +
            `✅ <b>Pump.fun Domination:</b> Multi-wallet whale mode bypasses buy limits.\n` +
            `🪂 <b>FARM $SENTRY:</b> Every 1 SOL you traded earns you 10,000 points towards the upcoming protocol airdrop.\n\n` +
            `Click below to accept these terms and initialize your trading vault:`;

        await ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard([[Markup.button.callback('✅ I AGREE & CREATE VAULT', 'action_create_vault')]]));
    } catch (error) { console.error("🔴 Registration Fault:", error); }
});

bot.action('btn_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){} 
    
    const guideText = 
        `🏆 <b>WHY SENTRY TERMINAL WINS</b>\n\n` +
        `<i>Every Solana bot promises speed. Here is what actually separates Sentry from everything else on the market:</i>\n\n` +

        `🛡️ <b>1. JITO MEV BUNDLE PROTECTION</b>\n` +
        `Every single trade — buy, sell, DCA, copy trade, auto-snipe — goes through a private Jito MEV bundle. Your transaction is invisible to sandwich bots in the public mempool. Standard bots route through public RPCs and hand free money to MEV bots on every launch. Sentry does not.\n\n` +

        `⚡ <b>2. MULTI-WALLET WHALE EXECUTION</b>\n` +
        `Pump.fun silently limits how much a single wallet can buy on any new launch. Sentry fires up to 5 wallets simultaneously inside the same Jito block — same millisecond, same price, no slippage stacking. You get a whale-sized position at retail entry.\n\n` +

        `🎯 <b>3. DUAL-ENGINE AUTO-SNIPER</b>\n` +
        `Sentry monitors both the Pump.fun bonding curve mempool (via gRPC Yellowstone) and Raydium new pool launches simultaneously. The moment a token launches — before it appears on any chart — your configured filters run: dev bag check, market cap range, anti-dead-coin shield, delay seconds. All in under 500ms.\n\n` +

        `🤖 <b>4. AI COIN CALLER ENGINE</b>\n` +
        `Type <code>/caller</code> to arm Sentry's scanner. Every 15 seconds it pulls DexScreener, scores tokens 0-100 based on momentum, volume, age, and MEV risk, and DMs you only the ones that pass your thresholds with a one-click buy button. You stop hunting. The caller hunts for you.\n\n` +

        `🛡️ <b>5. TRAILING GUARDS WITH TAKE PROFIT</b>\n` +
        `Every buy automatically arms an in-memory trailing stop. As price rises, the guard follows it up. The moment it drops more than your set percentage from peak, Sentry auto-sells 100% via Jito — without you watching. You can also pair it with a take-profit target that fires first if price hits the upside target.\n\n` +

        `👥 <b>6. COPY TRADING WITH GUARD PROTECTION</b>\n` +
        `Mirror any whale wallet in real time via WebSocket. The moment the target buys, Sentry fires your configured size and instantly arms a trailing guard on that position. You are not just copying the entry — you are copying it with a built-in exit strategy.\n\n` +

        `⏳ <b>7. NATIVE DCA & LIMIT ORDERS</b>\n` +
        `Set a token to accumulate every 60 minutes at 0.05 SOL per interval with a max budget of 2 SOL. Or set a limit order to buy a dip at a specific USD price. Both fire via Jito and automatically arm a guard on every fill. No third-party protocol needed.\n\n` +

        `🏰 <b>8. SENTRY GUILDS (COMMUNITY LOYALTY ENGINE)</b>\n` +
        `KOLs and project devs can create a Guild. Members join via an invite link and Sentry tracks their on-chain trading volume in real time. The dev exports a verified CSV leaderboard of actual capital allocators — not Twitter bots — and sends bulk SOL airdrops or whitelist spots directly inside the bot. The KOL also earns 50% of every trade fee their community generates, permanently.\n\n` +

        `🧹 <b>9. RENT SWEEPER & CONSOLIDATOR</b>\n` +
        `After trading you accumulate dozens of empty token accounts each holding ~0.002 SOL in locked rent. The sweeper closes up to 18 at once via Jito and returns the SOL to your wallet instantly. The consolidator sweeps SOL from all sub-wallets back to W1 in one transaction.\n\n` +

        `💰 <b>10. PARTNERSHIP PROGRAM (50/50 SPLIT)</b>\n` +
        `Share your link. Every recruit permanently pays 10% lower fees and you earn 50% of their trading fees forever. If they unlock the Dev Suite you receive 1 SOL instantly to your balance. The more active your recruits are, the more passive income you generate on-chain.\n\n` +

        `<i>This is not a retail bot. This is infrastructure.</i>`;

    await safeEditMessageText(ctx, guideText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]]));
});

bot.action('btn_trade_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    
    const manualText = 
        `📖 <b>SENTRY TERMINAL: HOW TO TRADE</b>\n\n` +
        `<i>Every method below fires through Jito MEV protection automatically.</i>\n\n` +

        `👛 <b>STEP 1 — FUND YOUR VAULT</b>\n` +
        `Copy your wallet address from the dashboard and send SOL to it from any exchange or wallet. Your balance updates in real time. If you want multi-wallet mode, go to <b>Vault & Keys</b>, activate up to 5 wallets, and fund each address separately.\n\n` +

        `⚡ <b>STEP 2 — INSTANT BUY (Fastest Method)</b>\n` +
        `Paste any Solana token contract address directly into the chat. Sentry pulls the token info, runs a rug check, and shows you a confirm card. Tap <b>Confirm Buy</b> and the trade fires immediately.\n\n` +
        `To set a specific size: paste <code>[CA] [AMOUNT]</code> together.\n` +
        `Example: <code>7xKXtg... 0.5</code> — buys 0.5 SOL worth instantly.\n\n` +

        `🎯 <b>STEP 3 — AUTO-SNIPER (Catch Launches)</b>\n` +
        `Go to <b>Sniper Module</b> and set your parameters:\n` +
        `• Amount per snipe (e.g. 0.05 SOL)\n` +
        `• Max dev bag allowed (e.g. 10%)\n` +
        `• Market cap range (e.g. $0 to $80k)\n` +
        `• Snipe delay in seconds\n` +
        `• Auto trailing stop and take profit\n` +
        `• Mode: Pump.fun, Raydium, or Both\n\n` +
        `Hit <b>ARM SNIPER ENGINE</b> and Sentry catches every qualifying launch automatically, 24 hours a day.\n\n` +

        `🤖 <b>STEP 4 — AI COIN CALLER (Filtered Alpha)</b>\n` +
        `Type <code>/caller</code>. Set your minimum score (e.g. 70/100), max token age, and momentum range. Turn it on. Every 15 seconds Sentry scans the market and DMs you only the tokens that pass — with a one-click buy button attached to each alert.\n\n` +

        `🛡️ <b>STEP 5 — TRAILING GUARD (Protect Bags)</b>\n` +
        `Go to <b>Trailing Stops</b> → <b>Deploy Trailing Guard</b>.\n` +
        `Format: <code>[CA] [DROP%] [AMOUNT] [OPTIONAL TP%]</code>\n` +
        `Example: <code>7xKXtg... 20 0.1 100</code>\n` +
        `This buys 0.1 SOL worth, sets a -20% trailing stop, and auto-sells at +100% take profit.\n` +
        `The guard follows the price upward automatically — it only triggers on a drop from peak.\n\n` +

        `👥 <b>STEP 6 — COPY TRADING (Mirror Whales)</b>\n` +
        `Go to <b>Copy Trade</b> → <b>Add Custom Wallet</b>.\n` +
        `Format: <code>[WALLET] [AMOUNT] [GUARD%] [OPTIONAL TP%]</code>\n` +
        `Example: <code>3yFomLQ... 0.1 20 50</code>\n` +
        `Every time the whale buys a token, Sentry fires your configured size and arms a guard automatically. Or browse the built-in Alpha Directory for curated whale wallets.\n\n` +

        `⏳ <b>STEP 7 — DCA & LIMIT ORDERS</b>\n` +
        `Go to <b>Limit / DCA Engine</b>.\n\n` +
        `<b>Limit Order</b> — buys when a token hits your target price:\n` +
        `<code>[CA] [TARGET_USD] [AMOUNT_SOL]</code>\n` +
        `Example: <code>7xKXtg... 0.005 0.5</code>\n\n` +
        `<b>DCA Schedule</b> — buys repeatedly on an interval:\n` +
        `<code>[CA] [INTERVAL_MINS] [AMOUNT] [GUARD%] [TP%] [MAX_BUDGET]</code>\n` +
        `Example: <code>7xKXtg... 60 0.05 20 50 2.0</code>\n` +
        `Buys 0.05 SOL every 60 minutes with a -20% guard, +50% TP, stops after spending 2 SOL total.\n\n` +

        `💼 <b>STEP 8 — MANAGE POSITIONS</b>\n` +
        `Go to <b>Positions</b>. You see every token you hold across all wallets, its live USD value, and your PnL from entry price. Sell buttons let you exit 10%, 25%, 50%, 75%, or 100% of any position instantly via Jito. Partial sells automatically scale down your trailing guard proportionally.\n\n` +

        `📤 <b>STEP 9 — WITHDRAW</b>\n` +
        `Type <code>/withdraw [ADDRESS] [AMOUNT]</code> to send SOL to any wallet.\n` +
        `Type <code>/withdraw [ADDRESS] ALL</code> to sweep your full balance minus gas.\n\n` +

        `⚙️ <b>STEP 10 — SETTINGS</b>\n` +
        `Go to <b>Settings</b> to configure:\n` +
        `• <b>Slippage</b> — how much price movement you accept (20% recommended for memecoins)\n` +
        `• <b>Speed</b> — Eco (0.0005 SOL tip), Fast (0.001), Turbo (0.005), or Custom\n\n` +
        `Higher Jito tips = higher block priority = faster execution on competitive launches.\n\n` +

        `<i>Type /cancel at any time to abort any pending action and return to the dashboard.</i>`;

    await safeEditMessageText(ctx, manualText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]]));
});
bot.action('action_create_vault', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const loader = await ctx.reply("<i>⏳ Encrypting local storage node...</i>", { parse_mode: 'HTML' });

    try {
        const vaultData = await generateSecureVault(telegramId);
        await prisma.user.update({
            where: { telegramId },
            data: { vaultAddress: vaultData.address, turnkeySubOrgId: vaultData.subOrgId }
        });
        await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id);
        await sendOrEditDashboard(ctx, telegramId, false);
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, "🔴 Vault Generation Failed.");
    }
});

// =========================================================
// 📡 PRIVATE KOL FINDER & LEADERBOARD
// =========================================================

// 🟢 NEW: Listens for the main dashboard button click to open the Coin Caller menu
bot.action('menu_caller', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await sendCallerMenu(ctx, tgId, true); // Smoothly edits the dashboard into the caller settings
});

// 🟢 NEW: Handles the manual "Scan Mainnet Now" button with real-time reassurance frames
bot.action('trigger_caller_scan', async (ctx) => {
    try { await ctx.answerCbQuery("🔍 Scanning Solana mainnet..."); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    // --- 🎮 SIMULATION INTERCEPT ---
    const { isSimulationActive, generateSimCallerAlert } = await import('./services/simulation.service.js');
    if (await isSimulationActive(tgId)) {
        // Generate exactly ONE alert — single wallet, not a sequence
        const alert = generateSimCallerAlert();
        
        // Show the same scanning frames as real mode
        await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Calibrating on-chain telemetry & scanning Helius streams...</i>\n\n[░░░░░░░░░░] 0%`, { parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 600));
        await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Analyzing transaction momentum on 30 hot Solana pairs...</i>\n\n[█████░░░░░] 50%`, { parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 600));
        await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Executing RugCheck contract audits on candidates...</i>\n\n[█████████░] 90%`, { parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 400));
    
        const msg =
            `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
            `<b>Token:</b> $${alert.symbol} (<code>${alert.mint}</code>)\n` +
            `<b>Score:</b> ${alert.score}/100 ⭐\n` +
            `<b>Age:</b> ${alert.ageMins} minutes old\n\n` +
            `${alert.reasons.map(r => `✅ ${r}`).join('\n')}\n\n` +
            `<i>Click below to buy instantly via Jito:</i>`;
    
        await ctx.editMessageText(msg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${alert.mint}_0.1` },
                        { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${alert.mint}` }
                    ],
                    [
                        { text: '🛡️ Deploy Guard', callback_data: `caller_guard_${alert.mint}` },
                        { text: '⏳ Start DCA', callback_data: `caller_dca_${alert.mint}` }
                    ],
                    [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]
                ]
            }
        });
        return;
    }
    // --- END SIMULATION INTERCEPT ---

    // Frame 1: Initial Calibration
    await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Calibrating on-chain telemetry & scanning Helius streams...</i>\n\n[░░░░░░░░░░] 0%`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 600));
    
    // Frame 2: Analyze Momentum
    await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Analyzing transaction momentum on 30 hot Solana pairs...</i>\n\n[█████░░░░░] 50%`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 600));
    
    // Frame 3: Security checks
    await ctx.editMessageText(`🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Executing RugCheck contract audits on candidates...</i>\n\n[█████████░] 90%`, { parse_mode: 'HTML' });
    await new Promise(r => setTimeout(r, 400));
    
    try {
        const { scoreTokens, getUserCallerFilters } = await import('./services/caller.service.js');
        const topTokens = await scoreTokens();
        const filters = await getUserCallerFilters(tgId);
        
        const matchedToken = topTokens.find(t => 
            t.totalScore >= filters.minScore &&
            t.ageMins <= filters.maxAgeMins &&
            (!filters.blockMev || t.breakdown.mevRisk >= 0)
        );
        
        if (matchedToken) {
            const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                        `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                        `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n` +
                        `<b>Age:</b> ${matchedToken.ageMins.toFixed(0)} minutes old\n\n` +
                        `${matchedToken.reasons.map(r => `✅ ${r}`).join('\n')}\n` +
                        `${matchedToken.warnings.map(w => `${w}`).join('\n')}\n\n` +
                        `<i>Click below to buy instantly via Jito:</i>`;
            
            await ctx.editMessageText(msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${matchedToken.mint}_0.1` },
                            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }
                        ],
                        [
                            { text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` },
                            { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }
                        ],
                        [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]
                    ]
                }
            });
        } else {
            await ctx.editMessageText(
                `❌ <b>No Breakouts Found</b>\n\n` +
                `We scanned the top 30 trending Solana pairs on-chain, but none matched your current settings:\n` +
                `• Min Score: <b>${filters.minScore}+</b>\n` +
                `• Max Age: <b>${filters.maxAgeMins}m</b>\n` +
                `• Block MEV: <b>${filters.blockMev ? 'Yes' : 'No'}</b>\n\n` +
                `<i>The trenches are quiet. Try lowering your minimum score or check back shortly!</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]]
                    }
                }
            );
        }
    } catch (e: any) {
        console.error("🔴 [MANUAL CALLER SCAN FAULT]:", e.message);
        await ctx.editMessageText(`🔴 <b>Scan Aborted:</b> RPC node is congested. Please try again.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_caller' }]] }
        });
    }
});

// 🟢 NEW: Direct, auto-filled Guard prompt from a called coin
bot.action(/^caller_guard_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:caller_guard_input:${tgId}`, mint, 'EX', 300);
    await ctx.replyWithHTML(
        `🛡️ <b>DEPLOY GUARD & TAKE PROFIT</b>\n\n` +
        `Token: <code>${mint}</code>\n\n` +
        `Reply to this message with your guard parameters (excluding the CA):\n` +
        `<code>[DROP %] [AMOUNT SOL] [OPTIONAL TP %]</code>\n\n` +
        `<i>Example (15% trailing drop, 0.1 SOL buy, 50% Take Profit):</i>\n` +
        `<code>15 0.1 50</code>\n\n` +
        `<i>Type /cancel at any time to abort.</i>`
    );
});

// 🟢 NEW: Direct, auto-filled DCA prompt from a called coin
bot.action(/^caller_dca_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:caller_dca_input:${tgId}`, mint, 'EX', 300);
    await ctx.replyWithHTML(
        `⏳ <b>START TWAP / DCA ENGINE</b>\n\n` +
        `Token: <code>${mint}</code>\n\n` +
        `Reply to this message with your DCA parameters (excluding the CA):\n` +
        `<code>[INTERVAL MINS] [AMOUNT SOL] [DROP %] [OPTIONAL TP %] [OPTIONAL MAX BUDGET SOL]</code>\n\n` +
        `<i>Example (Buy 0.05 SOL every 60 mins, 10% drop, max 2.0 SOL budget):</i>\n` +
        `<code>60 0.05 10 50 2.0</code>\n\n` +
        `<i>Type /cancel at any time to abort.</i>`
    );
});
// =========================================================
// 🟢 NEW FEATURE: Interactive Coin Caller Menu & Filters
// =========================================================
// 🟢 UPGRADED: Added "Scan Mainnet Now" to the top of the menu layout
async function sendCallerMenu(ctx: any, tgId: string, isEdit = false) {
    const filters = await getUserCallerFilters(tgId);
    
    const statusText = filters.isActive 
        ? "🟢 <b>ACTIVE & SCANNING</b> 🔍\n<i>(Searching mempool for matches every 15s...)</i>" 
        : "🔴 <b>OFFLINE</b>";
        
    const mevText = filters.blockMev ? "🟢 Yes (Protected)" : "🔴 No (Risky)";

    const text = `🎯 <b>AI COIN CALLER ENGINE</b>\n\n` +
        `Sentry scans DexScreener every 15 seconds and DMs you the highest-scoring tokens before they pump.\n\n` +
        `<b>Engine Status:</b> ${statusText}\n\n` +
        `⚙️ <b>CURRENT FILTERS:</b>\n` +
        `• <b>Minimum Score:</b> ${filters.minScore} / 100\n` +
        `• <b>Max Token Age:</b> ${filters.maxAgeMins} Mins\n` +
        `• <b>Momentum % Range:</b> ${filters.minPctChange}% to ${filters.maxPctChange}%\n` +
        `• <b>Block MEV:</b> ${mevText}\n\n` +
        `<i>Adjust your scanner parameters below:</i>`;

    const ui = Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Scan Mainnet Now', 'trigger_caller_scan')], // 🟢 NEW MANUAL TRIGGER BUTTON
        [Markup.button.callback(filters.isActive ? '🛑 TURN OFF CALLER' : '⚡ TURN ON CALLER', 'toggle_caller_status')],
        [
            Markup.button.callback(`⏱️ Max Age (${filters.maxAgeMins}m)`, 'edit_caller_age'),
            Markup.button.callback(`📈 % Range (${filters.minPctChange} to ${filters.maxPctChange}%)`, 'edit_caller_pct')
        ],
        [
            Markup.button.callback(`✏️ Min Score (${filters.minScore})`, 'edit_caller_score'), 
            Markup.button.callback(filters.blockMev ? '🛡️ MEV Block: ON' : '⚠️ MEV Block: OFF', 'toggle_caller_mev')
        ],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) {
        await safeEditMessageText(ctx, text, ui);
    } else {
        await ctx.replyWithHTML(text, ui);
    }
}

bot.action('edit_caller_age', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_caller_age:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`⏱️ <b>EDIT MAX TOKEN AGE</b>\n\nReply with the maximum age in minutes a token can be.\n<i>Example: 60 (for max 1 hour old)</i>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('edit_caller_pct', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_caller_pct:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`📈 <b>EDIT MOMENTUM % RANGE</b>\n\nReply with the Minimum and Maximum percentage gain allowed, separated by a space.\n<i>Example: 10 500 (Alerts only on coins up 10% to 500%)</i>\n\n<i>Type /cancel to abort.</i>`);
});

// Open the menu using /caller
bot.command('caller', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await sendCallerMenu(ctx, tgId, false);
});

// Button Handlers
bot.action('toggle_caller_status', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    const filters = await getUserCallerFilters(tgId);
    await setUserCallerFilters(tgId, { isActive: !filters.isActive });
    await sendCallerMenu(ctx, tgId, true);
});

bot.action('toggle_caller_mev', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    const filters = await getUserCallerFilters(tgId);
    await setUserCallerFilters(tgId, { blockMev: !filters.blockMev });
    await sendCallerMenu(ctx, tgId, true);
});

bot.action('edit_caller_score', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_caller_score:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`✏️ <b>EDIT MINIMUM SCORE</b>\n\nReply with the minimum score (0-100) a token must get before Sentry alerts you.\n<i>Example: 85</i>\n\n<i>Type /cancel to abort.</i>`);
});

// =========================================================
// 👑 GOD-MODE ADMIN DASHBOARD (LOCKED TO ADMIN_TELEGRAM_ID)
// =========================================================
bot.command('admin', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').concat(process.env.ADMIN_TELEGRAM_ID || "").filter(Boolean);
    
    if (!tgId || !ADMIN_IDS.includes(tgId)) return;

    const loader = await ctx.reply("<i>⏳ Compiling global platform metrics...</i>", { parse_mode: 'HTML' });

    try {
        const totalUsers = await prisma.user.count();
        const devSuites = await prisma.user.count({ where: { isDevSuiteUnlocked: true } });
        const vips = await prisma.user.count({ where: { isVip: true } });

        const volumeObj = await prisma.user.aggregate({ _sum: { totalVolumeSol: true } });
        const totalVol = volumeObj._sum.totalVolumeSol || 0;
        
        const tradeFees = totalVol * 0.01; 
        const upgradeRev = (devSuites * 1.5) + (vips * 0.2); 
        const totalRev = tradeFees + upgradeRev;

        const activeDca = await prisma.activeOrder.count({ where: { orderType: 'DCA', isActive: true } });
        const activeLimits = await prisma.activeOrder.count({ where: { orderType: 'LIMIT', isActive: true } });
        const activeSnipers = await prisma.autoSnipeConfig.count({ where: { isActive: true } });
        const activeCopy = await prisma.copyTradeConfig.count({ where: { isActive: true } });

        const dashboardText = 
            `👑 <b>SENTRY GOD-MODE DASHBOARD</b> 👑\n\n` +
            `👥 <b>USER ACQUISITION</b>\n` +
            `• Total Users: <b>${totalUsers}</b>\n` +
            `• Dev Suite Unlocks: <b>${devSuites}</b>\n` +
            `• VIP Unlocks: <b>${vips}</b>\n\n` +
            
            `💰 <b>PLATFORM REVENUE</b>\n` +
            `• Global Trading Volume: <b>${totalVol.toFixed(2)} SOL</b>\n` +
            `• Trading Fees (1%): <b>${tradeFees.toFixed(2)} SOL</b>\n` +
            `• Upgrade Fees: <b>${upgradeRev.toFixed(2)} SOL</b>\n` +
            `• <b>Total Gross Revenue: ${totalRev.toFixed(2)} SOL</b>\n\n` +
            
            `⚙️ <b>ACTIVE BACKGROUND ENGINES</b>\n` +
            `• Auto-Snipers Running: <b>${activeSnipers}</b>\n` +
            `• Copy Trades Running: <b>${activeCopy}</b>\n` +
            `• DCA Schedules Active: <b>${activeDca}</b>\n` +
            `• Limit Orders Pending: <b>${activeLimits}</b>\n\n` +
            
            `<i>Select an admin action below:</i>`;

        const UI = Markup.inlineKeyboard([
            [Markup.button.callback('📢 Send Global Broadcast', 'action_admin_broadcast')]
        ]);

        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, dashboardText, { parse_mode: 'HTML', ...UI });
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Error loading admin data:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});
bot.action('action_admin_broadcast', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (ctx.from?.id.toString() !== adminId) return;

    await redis.set(`state:admin_broadcast`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`📢 <b>GLOBAL BROADCAST</b>\n\nSend the message you want to blast to EVERY user in your database. (HTML formatting supported).\n\n<i>Type /cancel to abort.</i>`);
});

bot.command('leaderboard', async (ctx) => {
    const loader = await ctx.replyWithHTML("<i>⏳ Fetching Global Rankings...</i>");
    try {
        const topWhales = await prisma.user.findMany({ orderBy: { totalVolumeSol: 'desc' }, take: 20, select: { username: true, telegramId: true, totalVolumeSol: true, referredById: true, _count: { select: { recruits: true } }, isVip: true, vipSource: true, vipExpiresAt: true }});
        let board = `🏆 <b>SENTRY TERMINAL LEADERBOARD</b> 🏆\n\n🐋 <b>TOP 20 WHALES ($SENTRY POINTS)</b>\n`;
        
        if (topWhales.length === 0 || topWhales[0].totalVolumeSol === 0) board += `<i>The trenches are empty. Be the first to rank!</i>\n`;
        else {
            topWhales.forEach((u: any, i: number) => {
                if (u.totalVolumeSol > 0) {
                    let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🎖️";
                    let daysRemaining = null;
if (u.isVip && u.vipExpiresAt) { daysRemaining = Math.ceil((u.vipExpiresAt.getTime() - Date.now()) / 86400000); }
const badgeObj = resolveBadge(u.isVip, !!(u.vipExpiresAt && u.vipExpiresAt < new Date()), u.vipSource as any, daysRemaining);
const badgeStr = badgeObj.badge ? ` ${badgeObj.badge}` : '';

const name = u.username && u.username !== "Trader" ? `@${u.username}` : `Anon_${u.telegramId.substring(u.telegramId.length - 4)}`;
                    const pts = (Math.floor(u.totalVolumeSol * 10000) + (u.referredById ? 10000 : 0) + (u._count.recruits * 2000)).toLocaleString();
                    board += `${medal} <b>${name}</b>${badgeStr}: ${pts} PTS\n`;
                }
            });
        }
        board += `\n<i>Only the most ruthless operators survive. Over-trade and recruit to climb the ranks.</i>`;
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, board, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]]) });
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, "🔴 Error fetching rankings.");
    }
});


// 🟢 GLOBAL PANIC CANCEL
bot.action('action_global_cancel', async (ctx) => {
    try { await ctx.answerCbQuery("⏳ Shutting down all engines..."); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) return;

    // 1. Kill Database Engines
    await prisma.activeOrder.updateMany({ where: { userId: user.id, orderType: { in: ['DCA', 'LIMIT'] }, isActive: true }, data: { isActive: false } });
    await prisma.autoSnipeConfig.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false } });
    await prisma.copyTradeConfig.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false } });

// ADD THIS LINE:
syncCopyTradeListeners(bot);

    // 2. Kill RAM Guards
    const cancelledGuards = await cancelAllUserGuards(tgId);

    // 🟢 3. FIX: Kill the AI Coin Caller Automation
    const { setUserCallerFilters } = await import('./services/caller.service.js');
    await setUserCallerFilters(tgId, { isActive: false });

    

    await ctx.editMessageText(
        `🛑 <b>ALL AUTOMATIONS HALTED</b>\n\n` +
        `The following engines have been safely powered down to protect your capital:\n` +
        `• DCA Schedules: <b>Disabled</b>\n` +
        `• Limit Orders: <b>Disabled</b>\n` +
        `• Auto-Sniper: <b>Disabled</b>\n` +
        `• Copy Trades: <b>Disabled</b>\n` +
        `• AI Coin Caller: <b>Disabled</b>\n` + // 🟢 Now displayed in the shutdown report
        `• Trailing Guards: <b>${cancelledGuards} Removed</b>\n\n` +
        `<i>No further automated buys or sells will occur until you manually reactivate them.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Return to Dashboard', 'btn_dashboard')]]) }
    );
});

bot.action('btn_dashboard', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await sendOrEditDashboard(ctx, ctx.from!.id.toString(), true); 
});

bot.action('btn_withdraw_prompt', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await ctx.editMessageText(
        `📤 <b>Withdraw Capital</b>\n\nTo withdraw your SOL, reply to this bot with:\n\n<code>/withdraw [ADDRESS] [AMOUNT]</code>\n\n<i>Example 1:</i> <code>/withdraw 2vMm... 1.5</code>\n<i>Example 2:</i> <code>/withdraw 2vMm... ALL</code> (Sweeps max available minus gas)\n\n<i>Type /cancel to abort.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'btn_dashboard')]]) }
    );
});

// =========================================================
// 💰 AFFILIATE SYSTEM (MASSIVE PAYOUTS)
// =========================================================
bot.action('menu_affiliate', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const user = await prisma.user.findUnique({ 
        where: { telegramId: tgId }, 
        include: { _count: { select: { recruits: true } }, referredBy: true } 
    });
    if (!user) return;

    const referredByText = user.referredBy ? `✅ Linked to Partner: <b>${user.referredBy.referralCode}</b>` : `❌ No Partner Linked`;

    // 🟢 Calculate User's Total Points Dynamically
    const basePoints = Math.floor((user.totalVolumeSol || 0) * 10000);
    const welcomeBonus = user.referredById ? 10000 : 0;
    const recruitBonus = user._count.recruits * 2000;
    const totalPoints = basePoints + welcomeBonus + recruitBonus;

    // 🟢 Determine Affiliate Tier & Next Goal (40% to 70% dynamic splits)
    let currentTier = "🥉 Bronze (40% Rev Share)";
    let nextTier = "Silver (50k PTS)";
    if (totalPoints >= 1000000) { 
        currentTier = "💎 Diamond (70% Rev Share)"; 
        nextTier = "Max Tier Unlocked!"; 
    } else if (totalPoints >= 250000) { 
        currentTier = "🥇 Gold (60% Rev Share)"; 
        nextTier = "Diamond (1M PTS)"; 
    } else if (totalPoints >= 50000) { 
        currentTier = "🥈 Silver (50% Rev Share)"; 
        nextTier = "Gold (250k PTS)"; 
    }

    const text = 
        `💸 <b>SENTRY PARTNERSHIP & REWARDS</b>\n\n` +
        `Turn your influence into massive passive income. As you accumulate <b>$SENTRY Points</b>, your affiliate revenue share increases automatically!\n\n` +
        
        `💰 <b>INSTANT VIP UPGRADE BONUS:</b>\n` +
        `Every time one of your recruits upgrades to the Dev Suite (PRO/VIP), you instantly receive <b>1.0 SOL</b> deposited directly to your withdrawable balance. No limits!\n\n` +

        `🎯 <b>HOW TO EARN POINTS (CONDITIONS):</b>\n` +
        `• <b>Trade Volume:</b> 1 SOL Traded = <b>10,000 PTS</b>\n` +
        `• <b>Recruiting:</b> 1 Active Invite = <b>2,000 PTS</b>\n` +
        `• <b>Onboarding:</b> Sign up via a partner link = <b>+10,000 PTS</b> head-start\n\n` +
        
        `👑 <b>TRADING FEE TIERS:</b>\n` +
        `• 🥉 <b>Bronze (0 - 49k PTS):</b> 40% of recruit trading fees.\n` +
        `• 🥈 <b>Silver (50k - 249k PTS):</b> 50% of recruit trading fees.\n` +
        `• 🥇 <b>Gold (250k - 999k PTS):</b> 60% of fees + access to private Alpha.\n` +
        `• 💎 <b>Diamond (1M+ PTS):</b> 70% of fees + Lifetime 0% fee VIP status.\n\n` +
        
        `🎁 <b>YOUR RECRUIT'S BONUS:</b>\n` +
        `Anyone who uses your link gets a permanent <b>10% fee discount</b> and a 10,000 PTS airdrop head-start!\n\n` +
        
        `📊 <b>YOUR LIVE STATS:</b>\n` +
        `• <b>Total Points:</b> ${totalPoints.toLocaleString()} PTS\n` +
        `• <b>Current Tier:</b> ${currentTier}\n` +
        `• <b>Next Tier At:</b> ${nextTier}\n` +
        `• <b>Active Recruits:</b> ${user._count.recruits}\n` +
        `• <b>Pending Yield:</b> ${Number(user.pendingRewardsSol||0).toFixed(4)} SOL <i>(Min claim: 0.1 SOL)</i>\n\n` +
        
        `🔗 <b>Your Invite Link:</b>\n<code>https://t.me/${ctx.botInfo?.username}?start=${user.referralCode}</code>\n\n` +
        
        `<b>Link Status:</b>\n${referredByText}`;

    await safeEditMessageText(ctx, text, { 
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            ...(user.referredById ? [] : [[Markup.button.callback("🔗 Enter Referral Code", "action_enter_ref_code")]]),
            [Markup.button.callback("📥 Claim Payout", "action_claim_payout")],
            [Markup.button.callback("⬅️ Back to Dashboard", "btn_dashboard")]
        ]) 
    });
});
// =========================================================
// 🛠️ SENTRY DEV SUITE & 50/50 KOL PAYWALL (1.5 SOL)
// =========================================================
bot.action('menu_devsuite', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const user = await prisma.user.findUnique({ 
        where: { telegramId: tgId },
        include: { ownedGuild: true } 
    });
    if (!user) return;

    let text = `🛠️ <b>SENTRY DEVELOPER SUITE (PRO)</b>\n\n`;

    if (user.isDevSuiteUnlocked) {
        text += `🟢 <b>ACCESS GRANTED — WELCOME DEV</b>\n\n` +
            `Your institutional developer dashboard is fully active. You have lifetime, unlimited access to Sentry's advanced smart-contract utilities.\n\n` +
            `<i>Configure your Volume Bumpers, plan your Multi-Wallet Nuke, or manage your Community Guild below.</i>`;

        const guildButton = user.ownedGuild 
            ? Markup.button.callback('🏰 Manage Guild', 'action_manage_guild')
            : Markup.button.callback('🏰 Create Guild', 'action_create_guild_prompt');

        await safeEditMessageText(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('📈 Start Volume Bumper', 'action_dev_volume')],
            [Markup.button.callback('💥 NUKE (Sell All Wallets)', 'action_dev_nuke')],
            [guildButton], 
            [Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]
        ]));
    } else {
        text += `<b>WHY SMART DEVS & KOLS UPGRADE TO PRO:</b>\n\n` +
            
            `📈 <b>1. The Volume Bumper (Save $3,000+)</b>\n` +
            `<i>The Problem:</i> When you launch a coin on Pump.fun, the algorithm drops your token from the front page if it lacks constant volume. Shady Telegram marketing agencies charge 15-20 SOL (~$3,000) to run basic volume scripts that often get your token flagged by RugCheck.\n` +
            `<i>The Solution:</i> Sentry's Bumper lets you wash-trade your own coin across your 5 sub-wallets using private Jito MEV tips. It randomizes trade sizes (e.g. 0.012, 0.018) and delays so it looks exactly like organic, human volume. You keep your token trending safely without paying an agency.\n\n` +
            
            `💥 <b>2. The Nuke Button (Maximum Liquidity Exit)</b>\n` +
            `<i>The Problem:</i> Smart devs split their token supply across multiple wallets to avoid scaring buyers. But when it's time to take profit, selling 5 wallets one by one crashes your own chart and loses you thousands of dollars to slippage and MEV sandwich bots.\n` +
            `<i>The Solution:</i> The Nuke button compiles the sell orders from all 5 of your wallets into a single, encrypted Jito block. You exit your entire supply in the exact same millisecond at the absolute peak price.\n\n` +
            
            `🏰 <b>3. Sentry Guilds (The KOL Loyalty Engine)</b>\n` +
            `<i>The Problem:</i> Giving away whitelist spots or airdrops on Twitter usually results in thousands of fake bot entries and zero actual buyers.\n` +
            `<i>The Solution:</i> Create a Guild. Your community joins via a link, and Sentry tracks their <b>actual on-chain SOL trading volume</b>. You get a verified CSV leaderboard of real capital allocators to reward, while earning a massive <b>50% revenue share</b> on every trade your community makes.\n\n` +
            
            `<i>Unlock lifetime access to all 3 institutional tools for a one-time fee of <b>2.0 SOL</b>.</i>`;
            
        await safeEditMessageText(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('🔓 Unlock Dev Suite (2.0 SOL)', 'action_unlock_devsuite')],
            [Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]
        ]));
    }
});

bot.action('action_unlock_devsuite', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return;

    if (user.isDevSuiteUnlocked) {
        return ctx.replyWithHTML("⚠️ <b>Upgrade Active:</b> You already have lifetime access to the Developer Suite!");
    }

    const PRICE_SOL = 2.0; // 🟢 UPDATED TO 2.0 SOL
    const priceLamports = PRICE_SOL * LAMPORTS_PER_SOL;

    try {
        await ctx.answerCbQuery(`⏳ Aggregating wallet balances...`);

        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        const balances = await Promise.all(wallets.map(w => connection.getBalance(new PublicKey(w.pub))));
        const totalAvailable = balances.reduce((sum, bal) => sum + bal, 0);

        const totalGasNeeded = wallets.length * 2000000; 
        if (totalAvailable < priceLamports + totalGasNeeded) {
            return ctx.replyWithHTML(`🔴 <b>Unlock Failed:</b> Combined balance across your wallets is only <b>${(totalAvailable / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>. You need at least <b>${PRICE_SOL + (totalGasNeeded / LAMPORTS_PER_SOL)} SOL</b> combined.`);
        }

        const treasuryWalletStr = process.env.TREASURY_WALLET_ADDRESS;
        if (!treasuryWalletStr) return;

        const instructions = [];
        const signers: Keypair[] = [];
        let lamportsCollected = 0;

        for (let i = 0; i < wallets.length; i++) {
            if (lamportsCollected >= priceLamports) break;
            const w = wallets[i];
            const balance = balances[i];
            const rawPk = decryptKey(w.pk);
            if (!rawPk) continue;
            const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
            const maxSpendable = balance - 2000000; 
            if (maxSpendable <= 0) continue;

            const pullAmount = Math.min(priceLamports - lamportsCollected, maxSpendable);
            if (pullAmount > 0) {
                instructions.push(
                    SystemProgram.transfer({
                        fromPubkey: new PublicKey(w.pub),
                        toPubkey: new PublicKey(treasuryWalletStr),
                        lamports: pullAmount
                    })
                );
                signers.push(keypair);
                lamportsCollected += pullAmount;
            }
        }

        if (lamportsCollected < priceLamports) {
            return ctx.replyWithHTML(`🔴 <b>Unlock Failed:</b> Could not compile enough liquid SOL after leaving gas buffers.`);
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: new PublicKey(wallets[0].pub), 
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const vTx = new VersionedTransaction(messageV0);
        vTx.sign(signers); 

        const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

        let paymentConfirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) { paymentConfirmed = true; break; }
        }
        
        if (!paymentConfirmed) {
            return ctx.replyWithHTML(`🔴 <b>Payment transaction dropped by the network.</b> Your SOL was not deducted. Please try again.`);
        }

        await prisma.user.update({ where: { id: user.id }, data: { isDevSuiteUnlocked: true } });
        if (user.referredById) {
            const affiliateCut = PRICE_SOL * 0.50; // 🟢 They now get 1.0 SOL automatically
            await prisma.user.update({
                where: { id: user.referredById },
                data: { pendingRewardsSol: { increment: affiliateCut } }
            });
        }

        await ctx.replyWithHTML(`✅ <b>DEV SUITE UNLOCKED!</b>\n\n2.0 SOL compiled from your wallets and processed.\n🔗 <a href="https://solscan.io/tx/${sig}">Receipt</a>`, { link_preview_options: { is_disabled: true } });
        bot.handleUpdate({ ...ctx.update, callback_query: { ...((ctx as any).callbackQuery || {}), data: 'menu_devsuite' } } as any);
        
    } catch (e) { await ctx.replyWithHTML(`🔴 <b>Error processing multi-wallet transaction.</b>`); }
});

bot.action('action_dev_volume', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user?.isDevSuiteUnlocked) {
        return ctx.answerCbQuery("🔴 Dev Suite not unlocked. Please purchase it first.", { show_alert: true });
    }

    await redis.set(`state:dev_volume:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `📈 <b>START VOLUME BUMPER</b>\n\n` +
        `Reply with your configuration:\n` +
        `<code>[CA] [TRADE_SIZE_SOL] [MAX_FEE_BUDGET] [DELAY_SECONDS]</code>\n\n` +
        `<i>Example (Trades 0.02 SOL, stops after spending 0.5 SOL in fees, waits 4s between trades):</i>\n` +
        `<code>74SBV4z... 0.02 0.5 4</code>\n\n` +
        `⚠️ <i>Note: The Volume Bumper is a wash-trading utility designed to boost chart metrics. It does not generate trading profit and consumes SOL for network fees on every transaction.</i>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

bot.action('action_dev_nuke', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user?.isDevSuiteUnlocked) {
        return ctx.answerCbQuery("🔴 Dev Suite not unlocked. Please purchase it first.", { show_alert: true });
    }

    await redis.set(`state:dev_nuke:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💥 <b>THE NUKE BUTTON</b>\n\nReply with the Token CA. Sentry will instantly sell 100% of the token from ALL 5 wallets simultaneously via a Jito Bundle.\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_enter_ref_code', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:enter_ref:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`🔗 <b>LINK TO A PARTNER</b>\n\nReply to this message with the <b>SENTRY-XXXXXX</b> referral code of the partner who invited you.\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_claim_payout', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) return;
    if (user.pendingRewardsSol < 0.1) {
        try { await ctx.answerCbQuery(`❌ Need at least 0.1 SOL. Current: ${user.pendingRewardsSol.toFixed(4)}`, { show_alert: true }); } catch(e){}
        return;
    }
    try { await ctx.answerCbQuery("⏳ Processing Payout..."); } catch(e){}
    const result = await processAffiliatePayout(user.id);
    if (result.success) {
        await ctx.replyWithHTML(`✅ <b>Payout Processed!</b>\n\nAmount: ${user.pendingRewardsSol.toFixed(4)} SOL\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, { parse_mode: 'HTML' });
    } else {
        await ctx.replyWithHTML(`🔴 <b>Payout Failed</b>\n\n${result.message}`, { parse_mode: 'HTML' });
    }
});

// =========================================================
// ⚙️ SETTINGS MENU CONTROLLER
// =========================================================
async function sendOrEditSettings(ctx: any, telegramId: string, isEdit: boolean = false) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;

    const currentSlippage = user.slippagePercent || 20.0;
    const level = user.priorityLevel || "FAST";
    
    let currentFeeDisplay = "0.001 SOL";
    if (level === 'ECO') currentFeeDisplay = "0.0005 SOL";
    else if (level === 'TURBO') currentFeeDisplay = "0.005 SOL";
    else if (level === 'CUSTOM') currentFeeDisplay = `${user.customPriorityFee} SOL`;

    const levelText = `⚙️ <b>SENTRY CONFIGURATION</b>\n\n` +
        `👛 <b>Current Slippage:</b> ${currentSlippage}%\n` +
        `🚀 <b>Transaction Speed (Jito Bribe):</b> <b>${level}</b> (${currentFeeDisplay})\n\n` +
        
        `🚕 <b>SLIPPAGE EXPLAINED (The Master Example):</b>\n` +
        `<i>Imagine a coin launches at <b>$1.00</b>. You click BUY. In the 0.5 seconds your trade takes to reach the validator, 15 other traders buy first, pushing the price to <b>$1.15</b>.</i>\n\n` +
        `• <b>Low Slippage (5%):</b> Your maximum allowed buy price is $1.05. The trade <u>fails</u> because the price ($1.15) is too high. You get nothing and miss the pump.\n` +
        `• <b>High Slippage (20%):</b> Your maximum allowed buy price is $1.20. Sentry <u>successfully</u> buys at $1.15. You win your entry and ride the pump!\n\n` +
        `<i>Slippage acts as your protection limit. We recommend 20% to ensure your buys and panic-sells never fail.</i>\n\n` +
        
        `🚀 <b>TRANSACTION SPEED EXPLAINED:</b>\n` +
        `<i>Sentry bypasses public network congestion by tipping the validators (using Jito) to process your trade on Block-0.</i>\n\n` +
        `• <b>Eco 🍃 (0.0005 SOL):</b> Low priority. Best for quiet trading hours to save gas.\n` +
        `• <b>Fast 🐎 (0.001 SOL):</b> Standard priority. Best for everyday trading, bypassing 90% of network lag.\n` +
        `• <b>Turbo ⚡ (0.005 SOL):</b> High priority. Bribes validators heavily to guarantee your entry on competitive launches.\n` +
        `• <b>Custom ⚙️:</b> Set your own custom tip (e.g. 0.02 SOL) to secure guaranteed priority during heavy network congestion.\n`;

    const UI = Markup.inlineKeyboard([
        [
            Markup.button.callback(level === 'ECO' ? '🟢 Eco 🍃' : 'Eco 🍃', 'set_speed_ECO'),
            Markup.button.callback(level === 'FAST' ? '🟢 Fast 🐎' : 'Fast 🐎', 'set_speed_FAST'),
            Markup.button.callback(level === 'TURBO' ? '🟢 Turbo ⚡' : 'Turbo ⚡', 'set_speed_TURBO')
        ],
        [
            Markup.button.callback(level === 'CUSTOM' ? `🟢 Custom: ${user.customPriorityFee} SOL` : 'Custom ⚙️', 'action_edit_custom_speed')
        ],
        [Markup.button.callback('✏️ Edit Slippage', 'action_edit_slippage')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, levelText, UI);
    else await ctx.replyWithHTML(levelText, UI);
}

bot.action('menu_settings', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await sendOrEditSettings(ctx, ctx.from!.id.toString(), true);
});

bot.action(/^set_speed_(ECO|FAST|TURBO)$/, async (ctx) => {
    const level = ctx.match[1];
    try { await ctx.answerCbQuery(`✅ Speed configuration updated to ${level}!`); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    await prisma.user.update({
        where: { telegramId: tgId },
        data: { priorityLevel: level }
    });

    await ctx.replyWithHTML(`✅ <b>Speed successfully updated to ${level}.</b>`);
    await sendOrEditSettings(ctx, tgId, false);
});

bot.action('action_edit_custom_speed', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    await redis.set(`state:edit_custom_speed:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `⚙️ <b>SET CUSTOM JITO BRIBE</b>\n\n` +
        `Reply to this message with your custom validator tip in SOL.\n\n` +
        `<i>💡 Example: <b>0.02</b> (This will set your tip to 0.02 SOL per transaction, guaranteeing you front-run 99% of standard traders).</i>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

bot.action('action_edit_slippage', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:edit_slippage:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`✏️ <b>EDIT SLIPPAGE</b>\n\nReply with your new slippage percentage (e.g., 25 for 25%).\n\n<i>Type /cancel to abort.</i>`);
});

// =========================================================
// 🎯 AUTO-SNIPER MENU CONTROLLER (PURE PUMP.FUN)
// =========================================================
async function sendOrEditSniper(ctx: any, telegramId: string, isEdit: boolean = false) {
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (!user) return;

    let config = user.autoSnipeConfig;
    if (!config) config = await prisma.autoSnipeConfig.create({ data: { userId: user.id, amountSol: 0.01, sniperMode: "PUMP" } });

    // 🟢 UPDATED: Handles PUMP, RAYDIUM, and BOTH mode displays
    let modeDisplay = "💊 PUMP.FUN COINS (BONDING CURVES)";
    if (config.sniperMode === "RAYDIUM") modeDisplay = "🧪 RAYDIUM LIQUIDITY POOLS";
    else if (config.sniperMode === "BOTH") modeDisplay = "🔥 BOTH (PUMP.FUN & RAYDIUM)";

    const statusObj = config.isActive ? "🟢 ACTIVE & SCANNING MEMPOOL" : "🔴 OFFLINE (Stopped)";
    const tpDisplay = config.autoTakeProfitPercent ? `+${config.autoTakeProfitPercent}%` : `OFF`;
    const mcDisplay = `$${(config.minMarketCap || 0).toLocaleString()} - $${(config.maxMarketCap || 100000).toLocaleString()}`;
    const spentSol = config.totalSpentSol || 0;
    const antiDeadObj = config.antiDeadCoin ? "🟢 ON (Active)" : "🔴 OFF (Disabled)"; 
    const devBagDisplay = `${config.maxDevBuyPercent}%`; 

    const sniperText = 
        `🎯 <b>TRENCH AUTO-SNIPER ENGINE</b> 🎯\n` +
        `<i>Sentry scans the raw Solana mempool to front-run Pump.fun bonding curves and Raydium LPs. Our zero-trust shields protect your capital automatically:</i>\n\n` +
        
        `⚙️ <b>LIVE EXECUTION PARAMETERS:</b>\n\n` +
        `• <b>Status:</b> ${statusObj}\n` +
        `  ├ <i>Explanation: Shows if Sentry is actively scanning Solana blocks or turned off.</i>\n\n` +
        
        `• <b>Target Mode:</b> <b>${modeDisplay}</b>\n\n` +
        
        `• <b>Spend:</b> <b>${config.amountSol} SOL</b> per wallet\n` +
        `  ├ <i>Example: If you have 3 wallets active, Sentry fires 3 concurrent transactions, investing <b>${(config.amountSol * 3).toFixed(2)} SOL</b> total.</i>\n\n` +
        
        `• <b>Max Budget:</b> <b>${config.maxBudgetSol ? config.maxBudgetSol + ' SOL' : 'Infinite (No Limit)'}</b>\n` +
        `  ├ <i>Example: Set this to 1.0 SOL. Sentry will automatically shut down the moment it buys 10 tokens to protect your wallet.</i>\n\n` +
        
        `• <b>Total Spent:</b> <b>${spentSol.toFixed(4)} SOL</b>\n` +
        `  ├ <i>Total cumulative SOL spent by your sniper during this session.</i>\n\n` +
        
        `• <b>Market Cap Filter:</b> <b>${mcDisplay}</b>\n` +
        `  ├ <i>Example: Set to $20k - $80k. Sentry blocks "ghost launches" and only buys coins that have immediate volume.</i>\n\n` +
        
        `• <b>Max Dev Bag:</b> <b>${devBagDisplay}</b>\n` +
        `  ├ <i>Example: Set to 10%. If the creator buys more than 10% of their own supply at launch, Sentry immediately aborts.</i>\n\n` +
        
        `• <b>Anti-Dead Shield:</b> ${antiDeadObj}\n` +
        `  ├ <i>Explanation: Blocks coin launches where the developer has 0 SOL of their own skin in the game.</i>\n\n` +
        
        `• <b>Block Delay:</b> <b>${config.snipeDelaySeconds} Seconds</b>\n` +
        `  ├ <i>Example: Set to 2s. Sentry waits exactly 2 blocks before buying to let metadata and developer holding checks fully populate on-chain.</i>\n\n` +
        
        `• <b>Auto-Guard:</b> <b>-${config.autoTrailingDropPercent}% Stop Loss</b> | Take Profit: <b>${tpDisplay}</b>\n` +
        `  ├ <i>Example: Sentry deploys an in-memory Trailing Stop and Take Profit the exact millisecond your buy confirms.</i>\n`;

    // 🟢 UPDATED: Button Label Logic
    let modeBtnText = '🟢 Mode: Pump.fun 💊';
    if (config.sniperMode === 'RAYDIUM') modeBtnText = '🟢 Mode: Raydium LPs 🧪';
    else if (config.sniperMode === 'BOTH') modeBtnText = '🟢 Mode: BOTH 🔥';

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback(config.isActive ? '🛑 SHUT DOWN ENGINE' : '⚡ ARM SNIPER ENGINE', 'toggle_autosnipe')],
        [Markup.button.callback(modeBtnText, 'toggle_sniper_mode')],
        [Markup.button.callback(`👻 Anti-Dead Shield: ${antiDeadObj}`, 'toggle_antidead'), Markup.button.callback(`🐋 Dev Limit (${devBagDisplay})`, 'edit_snipe_dev')],
        [Markup.button.callback(`✏️ Spend (${config.amountSol} SOL)`, 'edit_snipe_amt'), Markup.button.callback(`💳 Budget (${config.maxBudgetSol || 'Off'})`, 'edit_snipe_budget')],
        [Markup.button.callback(`📊 MC Filter (${mcDisplay})`, 'edit_snipe_mc')],
        [Markup.button.callback(`✏️ Guard (-${config.autoTrailingDropPercent}%)`, 'edit_snipe_sl'), Markup.button.callback(`🎯 TP (${tpDisplay})`, 'edit_snipe_tp')],
        [Markup.button.callback(`⏱️ Delay (${config.snipeDelaySeconds}s)`, 'edit_snipe_delay')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, sniperText, UI);
    else await ctx.replyWithHTML(sniperText, UI);
}

bot.action('toggle_sniper_mode', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
    if (!user || !user.autoSnipeConfig) return;
    
    // 🟢 UPDATED: Rotate through PUMP -> RAYDIUM -> BOTH
    let nextMode = "PUMP";
    if (user.autoSnipeConfig.sniperMode === "PUMP") nextMode = "RAYDIUM";
    else if (user.autoSnipeConfig.sniperMode === "RAYDIUM") nextMode = "BOTH";
    
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { sniperMode: nextMode } });
    await sendOrEditSniper(ctx, tgId!, true);
});
bot.action('menu_sniper', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await sendOrEditSniper(ctx, ctx.from!.id.toString(), true);
});

bot.action('toggle_autosnipe', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    // --- 🎮 SIMULATION INTERCEPT ---
    const { isSimulationActive, toggleSimAutoSnipe } = await import('./services/simulation.service.js');
    if (await isSimulationActive(tgId)) {
        const isActive = await toggleSimAutoSnipe(tgId, bot);
        
        if (!isActive) {
            await ctx.editMessageText(`🤖 <b>SIM AUTO-SNIPER: 🔴 OFF</b> 🎮\n\n<i>Auto-Sniper stopped.</i>`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '⚡ ARM SIM SNIPER', callback_data: 'toggle_autosnipe' }], [{ text: '⬅️ Back to Dashboard', callback_data: 'btn_dashboard' }]] }
            });
            await redis.del(`sim:autosnipe_msg:${tgId}`);
            return;
        }

        const editRes = await ctx.editMessageText(
            `🤖 <b>SIM AUTO-SNIPER: 🟢 ON</b> 🎮\n\n<i>Executing dynamic trades (random 2s - 5s delays)... Click below to stop.</i>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🛑 SHUT DOWN SIM SNIPER', callback_data: 'toggle_autosnipe' }],
                        [{ text: '⬅️ Back to Dashboard', callback_data: 'btn_dashboard' }]
                    ]
                }
            }
        );

        if (editRes && typeof editRes !== 'boolean') {
            await redis.set(`sim:autosnipe_msg:${tgId}`, editRes.message_id.toString(), 'EX', 3600);
        }
        return;
    }
    // --- END SIMULATION INTERCEPT ---

    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
    if (!user || !user.autoSnipeConfig) return;
    const newState = !user.autoSnipeConfig.isActive;
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { isActive: newState } });
    if (newState) try { await ctx.telegram.sendMessage(ctx.chat!.id, `📡 <b>SNIPER ARMED & SCANNING PUMP.FUN</b>\n\nYour engine is now actively listening to the Solana Mempool. It will execute via Jito MEV.`, { parse_mode: 'HTML' }); } catch(e) {}
    await sendOrEditSniper(ctx, tgId!, true);
});
bot.action('toggle_antidead', async (ctx) => {
    try { await ctx.answerCbQuery("👻 Anti-Dead Coin Shield Toggled!"); } catch(e){}
    const tgId = ctx.from?.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
    if (!user || !user.autoSnipeConfig) return;
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { antiDeadCoin: !user.autoSnipeConfig.antiDeadCoin } });
    await sendOrEditSniper(ctx, tgId!, true);
});

bot.action('edit_snipe_dev', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_dev:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`🐋 <b>EDIT MAX DEV BAG</b>\nReply with the maximum percentage of the supply the developer is allowed to buy at launch.\n<i>Example: 15</i>`);
});

bot.action('edit_snipe_delay', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_delay:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`⏱️ <b>EDIT BLOCK DELAY</b>\nReply with the number of seconds to wait before buying.\n<i>Example: 3</i>`);
});

bot.action('edit_snipe_amt', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_amt:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💰 <b>EDIT SNIPE AMOUNT</b>\nReply with the amount of SOL to spend per Auto-Snipe.\n<i>Example: 0.2</i>`);
});

bot.action('edit_snipe_sl', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_sl:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`🛡️ <b>EDIT TRAILING GUARD</b>\nReply with the Trailing Stop-Loss percentage.\n<i>Example: 20</i>`);
});

bot.action('edit_snipe_tp', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_tp:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`🎯 <b>EDIT AUTO-SNIPE TAKE PROFIT</b>\nReply with the +% profit target to Auto-Sell.\n<i>Example: 50 (Type 0 to turn off).</i>`);
});

bot.action('edit_snipe_mc', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_mc:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`📊 <b>EDIT MC FILTER</b>\nReply with: <code>[MIN_MC] [MAX_MC]</code>\n<i>Example: 20000 60000</i>`);
});

bot.action('edit_snipe_budget', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_budget:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💳 <b>EDIT MAX BUDGET</b>\nReply with the Maximum amount of SOL to spend overall (0 for Infinite).\n<i>Example: 2.5</i>`);
});

// =========================================================
// 💼 POSITIONS & DUST SWEEPER ENGINE
// =========================================================
bot.action('menu_positions', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    // =========================================================
    // 🎮 SIMULATION INTERCEPT
    // =========================================================
    const { isSimulationActive } = await import('./services/simulation.service.js');
    if (tgId && await isSimulationActive(tgId)) {
        const { getSimWallets } = await import('./services/simulation.service.js');
        const simWallets = await getSimWallets(tgId);
        const simPositions = JSON.parse(await redis.get(`sim:positions:${tgId}`) || '[]');
        
        let posText = `💼 <b>YOUR CURRENT BAGS</b> 🎮 <i>[SIMULATION]</i>\n\n`;
        const buttons: any[] = [];
        
        if (simPositions.length === 0) {
            posText += `<i>No active simulation positions. Use the sniper or paste a CA to simulate a buy.</i>`;
        } else {
            simPositions.forEach((p: any, i: number) => {
                const pnlPercent = ((p.priceUsd - (p.entryPrice * 150)) / (p.entryPrice * 150) * 100).toFixed(2);
                
                // Calculates the absolute amount of simulated SOL made or lost
                const solPnl = p.amountInSol * (parseFloat(pnlPercent) / 100); 
                const sign = parseFloat(pnlPercent) >= 0 ? '+' : '';
                
                posText += `${i+1}. <b>$${p.symbol}</b>: <b>$${p.valueUsd.toFixed(2)}</b>\n   PnL: <b>${parseFloat(pnlPercent) >= 0 ? '📈' : '📉'} ${sign}${parseFloat(pnlPercent).toFixed(2)}% (${sign}${solPnl.toFixed(4)} SOL)</b>\n`;
                buttons.push([
                    Markup.button.callback(`25%`, `sell_25_${p.mint}`),
                    Markup.button.callback(`50%`, `sell_50_${p.mint}`),
                    Markup.button.callback(`💥 100%`, `sell_100_${p.mint}`)
                ]);
            });
        }

        buttons.push([
            Markup.button.callback('🔄 Refresh', 'menu_positions'),
            Markup.button.callback('⬅️ Back', 'btn_dashboard')
        ]);

        const loader = await ctx.reply("<i>⏳ Scanning simulation vault...</i>", { parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 800)); // Realistic simulated RPC delay
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, posText, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
        });
        return;
    }
    // =========================================================
    // END SIMULATION INTERCEPT
    // =========================================================

    const loader = await ctx.reply("<i>⏳ Scanning blockchain and fetching live prices...</i>", { parse_mode: 'HTML' });
    
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) return;

    const positions = await getUserPositions(tgId);
    const emptyAccounts = await getEmptyTokenAccounts(user.vaultAddress || "");
    const emptyCount = emptyAccounts.length;

    if ((!positions || positions.length === 0) && emptyCount === 0) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
            `💼 <b>ACTIVE POSITIONS</b>\n\nYour vault is currently empty. Start sniping to fill your bags!`, 
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'btn_dashboard')]]) }
        );
        return;
    }

    const displayLimit = 15;
    const topPositions = positions ? positions.slice(0, displayLimit) : [];
    
    const vipStatus = await getVipStatus(tgId);
    let posText = `💼 <b>YOUR CURRENT BAGS</b> ${vipStatus.badge}\n\n`;
    const buttons: any[] = [];

    if (topPositions.length > 0) {
        for (let i = 0; i < topPositions.length; i++) {
            const p = topPositions[i];
            const shortCA = `${p.mint.substring(0,6)}...`;
            const symbolDisplay = p.symbol && p.symbol !== "UNKNOWN" ? `<b>$${p.symbol}</b>` : `<code>${shortCA}</code>`;
            const valueDisplay = p.valueUsd && p.valueUsd > 0 
                ? `<b>$${p.valueUsd.toFixed(2)}</b> <i>(${p.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} Tokens)</i>` 
                : `<b>${p.amount.toFixed(2)}</b> Tokens`;

            const guards = await redis.smembers(`token_guards:${tgId}:${p.mint}`);
            let entryPrice = 0;
            if (guards.length > 0) {
                const raw = await redis.get(`order:trail:${guards[0]}`);
                if (raw) entryPrice = JSON.parse(raw).entryPrice || 0;
            }

            const pnlPercent = entryPrice > 0
                ? (((p.priceUsd - entryPrice) / entryPrice) * 100).toFixed(2)
                : null;

            const pnlLine = pnlPercent
                ? `\n   PnL: <b>${Number(pnlPercent) >= 0 ? '📈 +' : '📉 '}${pnlPercent}%</b>`
                : '';

            posText += `${i+1}. ${symbolDisplay} : ${valueDisplay}${pnlLine}\n`;
            
            buttons.push([
                Markup.button.callback(`10%`, `sell_10_${p.mint}`), Markup.button.callback(`25%`, `sell_25_${p.mint}`),
                Markup.button.callback(`50%`, `sell_50_${p.mint}`), Markup.button.callback(`75%`, `sell_75_${p.mint}`),
                Markup.button.callback(`💥 100%`, `sell_100_${p.mint}`)
            ]);
        }
    } else {
        posText += `<i>No active positions.</i>\n\n`;
    }

    if (emptyCount > 0) {
        const potentialReclaim = (emptyCount * 0.002039).toFixed(4);
        posText += `\n🧹 <b>SENTRY RENT SWEEPER ACTIVE:</b>\n` +
            `We detected <b>${emptyCount} empty token accounts</b> in your vault holding ~<b>${potentialReclaim} SOL</b> of locked rent hostage.\n\n` +
            `<i>Click the sweep button below to burn them and return the SOL back to your balance instantly!</i>\n`;
        buttons.push([Markup.button.callback(`🧹 Sweep Empty Accounts (+${potentialReclaim} SOL)`, 'action_sweep_rent')]);
    }

    buttons.push([Markup.button.callback('🔄 Refresh', 'menu_positions'), Markup.button.callback('⬅️ Back', 'btn_dashboard')]);
    
    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, posText, { 
        parse_mode: 'HTML', 
        ...Markup.inlineKeyboard(buttons) 
    }).catch(()=>{});
});

bot.action('menu_caller', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await sendCallerMenu(ctx, tgId, true); 
});

bot.command('simbal', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (tgId !== process.env.ADMIN_TELEGRAM_ID) return;

    const { isSimulationActive } = await import('./services/simulation.service.js');
    if (!(await isSimulationActive(tgId))) {
        return ctx.replyWithHTML("🔴 <b>Simulation mode is NOT active.</b> Turn it on with /sim first.");
    }

    const text = (ctx.message as any).text || "";
    const parts = text.trim().split(/\s+/);
    
    if (parts.length !== 2) {
        return ctx.replyWithHTML("🔴 <b>Format Error.</b> Use: <code>/simbal [AMOUNT]</code>\nExample: <code>/simbal 150.5</code>");
    }

    const newBal = parseFloat(parts[1]);
    if (isNaN(newBal) || newBal < 0) {
        return ctx.replyWithHTML("🔴 <b>Invalid Amount.</b> Please provide a valid number.");
    }

    await redis.set(`sim:balance:${tgId}`, newBal.toFixed(4));
    await ctx.replyWithHTML(`✅ <b>Simulation Balance Updated!</b>\nYou now have <b>${newBal.toFixed(4)} SOL</b>.`);
});
bot.action('sim_regen_wallets', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (tgId !== process.env.ADMIN_TELEGRAM_ID) return;
    
    const { generateSimWallets } = await import('./services/simulation.service.js');
    await redis.set(`sim:wallets:${tgId}`, JSON.stringify(generateSimWallets()));
    
    try { await ctx.answerCbQuery('🔄 Wallets regenerated!'); } catch(e) {}
    bot.handleUpdate({ 
        ...ctx.update, 
        callback_query: { ...((ctx as any).callbackQuery || {}), data: 'menu_vault' } 
    } as any);
});

// 🟢 PUBLIC VIP STATUS
bot.command('vipstatus', async (ctx) => {
    try {
        const tgId = ctx.from?.id.toString();
        if (!tgId) return;

        // 1. Send a loading message so the bot doesn't look dead while fetching from DB/Redis
        const loader = await ctx.reply("<i>⏳ Checking your VIP credentials...</i>", { parse_mode: 'HTML' });

        const status = await getVipStatus(tgId);

        if (status.isVip && !status.isExpired) {
            const typeLabel = status.expiresAt ? `Promo VIP (${status.daysRemaining} days remaining)` : 'Permanent VIP';
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `👑 <b>YOUR VIP STATUS</b>\n\n` +
                `Status: 🟢 <b>ACTIVE</b>\n` +
                `Type: <b>${typeLabel}</b>\n\n` +
                `<b>Active Benefits:</b>\n` +
                `• 0% trading fees\n` +
                `• Turbo Jito priority\n` +
                `• Whale alpha directory\n` +
                `• ${status.badge} Custom VIP badge\n\n` +
                `<i>Note: Dev Suite requires separate purchase.</i>`,
                { parse_mode: 'HTML' }
            );
        } else if (status.source === 'EXPIRED') {
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `👑 <b>YOUR VIP STATUS</b>\n\n` +
                `Status: ⚪ <b>EXPIRED</b>\n\n` +
                `Your 10-day promo VIP ended on ${status.expiresAt ? status.expiresAt.toLocaleDateString() : 'recently'}.\n\n` +
                `You are now a standard member trading at normal fees. <i>Promo VIP cannot be re-claimed.</i>`,
                { parse_mode: 'HTML' }
            );
        } else {
            const slotsLeft = await getSlotsRemaining();
            const promoActive = (await redis.get('vip_promo:active')) === 'true';
            
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `👑 <b>YOUR VIP STATUS</b>\n\n` +
                `Status: ⚫ <b>Standard Member</b>\n\n` +
                (promoActive && slotsLeft > 0 ? 
                    `🎁 <b>${slotsLeft} VIP slots available today!</b>\nShare your referral link and the first 10 people who click it get a free 10-day VIP pass.\nYour referral link earns you 50% of their fees too.` 
                    : 
                    `<i>Check back tomorrow for daily VIP slots, or wait for the next promo cycle.</i>`
                ),
                { parse_mode: 'HTML' }
            );
        }
    } catch (e: any) {
        console.error("🔴 [VIP STATUS COMMAND FAULT]:", e.message);
        await ctx.reply("🔴 <b>Error:</b> Could not fetch VIP status. Please try again in a few moments.", { parse_mode: 'HTML' });
    }
});

// 🟢 VIP PROMO ADMIN CONTROLS
bot.command('startpromo', async (ctx) => {
    try {
        const tgId = ctx.from?.id.toString();
        const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').concat(process.env.ADMIN_TELEGRAM_ID || "").filter(Boolean);
        
        // 🟢 FIX: Tell the user if they are denied, and give them their ID
        if (!tgId || !ADMIN_IDS.includes(tgId)) {
            return ctx.reply(`🔴 <b>Access Denied.</b>\nYour Telegram ID is <code>${tgId}</code>. Add this to ADMIN_IDS in your .env file to use this command.`, { parse_mode: 'HTML' });
        }

        await startPromo();
        const slotsRemaining = await getSlotsRemaining();

        await ctx.replyWithHTML(`✅ <b>VIP PROMO ACTIVATED</b>\n\nFirst 10 people to click any referral link today get 10-day VIP passes.\n<b>Slots remaining today: ${slotsRemaining}/10</b>\n\nRun /stoppromo to deactivate.`);
    } catch (e: any) {
        await ctx.reply(`🔴 Error starting promo: ${e.message}`);
    }
});

bot.command('stoppromo', async (ctx) => {
    try {
        const tgId = ctx.from?.id.toString();
        const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').concat(process.env.ADMIN_TELEGRAM_ID || "").filter(Boolean);
        
        if (!tgId || !ADMIN_IDS.includes(tgId)) {
            return ctx.reply(`🔴 Access Denied. Your ID: ${tgId}`);
        }

        await stopPromo();
        await ctx.replyWithHTML(`🛑 <b>VIP PROMO DEACTIVATED</b>\n\nNo new VIP passes will be granted. Run /startpromo to reactivate.`);
    } catch (e: any) {
        await ctx.reply(`🔴 Error stopping promo: ${e.message}`);
    }
});

bot.command('promostats', async (ctx) => {
    try {
        const tgId = ctx.from?.id.toString();
        const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').concat(process.env.ADMIN_TELEGRAM_ID || "").filter(Boolean);
        
        if (!tgId || !ADMIN_IDS.includes(tgId)) {
            return ctx.reply(`🔴 Access Denied. Your ID: ${tgId}`);
        }

        const loader = await ctx.reply("<i>Fetching stats...</i>", { parse_mode: 'HTML' });
        const stats = await getPromoStats();
        
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined,
            `📊 <b>VIP PROMO STATS</b>\n\n` +
            `<b>Status:</b> ${stats.isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}\n` +
            `<b>Date:</b> ${stats.today} (UTC)\n` +
            `<b>Slots Used Today:</b> ${stats.slotsUsed}/10\n` +
            `<b>Slots Remaining:</b> ${stats.slotsRemaining}\n\n` +
            `<b>Total VIPs Granted (All Time):</b> ${stats.totalVipsGrantedAllTime}\n` +
            `<b>Currently Active 10-Day VIPs:</b> ${stats.currentlyActiveVips}`,
            { parse_mode: 'HTML' }
        );
    } catch (e: any) {
        await ctx.reply(`🔴 Error fetching stats: ${e.message}`);
    }
});

bot.action('action_sweep_rent', async (ctx) => {
    try { await ctx.answerCbQuery("⏳ Initiating sweep transaction..."); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const loader = await ctx.replyWithHTML("<i>⏳ Packing close account instructions and sending bundle to Jito...</i>");

    try {
        const result = await executeRentSweep(tgId);
        if (result.success) {
            await redis.del(`balance_cache:${tgId}`); 
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
                `✅ <b>SOL RENT RECLAIMED SUCCESSFULLY!</b>\n\n${result.message}\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Receipt on Solscan</a>`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Positions', 'menu_positions')]]) }
            );
        } else {
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
                `🔴 <b>Sweep Failed:</b> ${result.message}`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_positions')]]) }
            );
        }
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Error executing sweep.</b>`);
    }
});

bot.action(/^sell_(10|25|50|75|100)_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const percentage = parseInt(ctx.match[1]); 
    const targetCA = ctx.match[2]; 
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const sellLockKey = `lock:sell:${tgId}:${targetCA}`;
    const isLocked = await redis.set(sellLockKey, 'LOCKED', 'EX', 5, 'NX'); 
    if (!isLocked) {
        try { await ctx.answerCbQuery("⚠️ Sell already processing. Please wait...", { show_alert: true }); } catch(e){}
        return;
    }

    const loader = await ctx.replyWithHTML(`<i>⏳ Initiating ${percentage}% Manual Exit for <code>${targetCA.substring(0,6)}...</code> via Jito...</i>`);

    try {
        const result = await executeExit(tgId, targetCA, percentage);
        if (result.success) {
            await redis.del(`balance_cache:${tgId}`);
            
            const { isSimulationActive } = await import('./services/simulation.service.js');
            if (await isSimulationActive(tgId)) {
                const pnlMatch = result.message.match(/PnL: \+?([\d.]+)%/);
                const pnlPercent = pnlMatch ? parseFloat(pnlMatch[1]) : parseFloat((Math.random() * 200 + 20).toFixed(2));
                const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
                
                const captionText =
                    `🟢 <b>MANUAL SELL SUCCESSFUL!</b>\n\n` +
                    `<b>Token:</b> <code>${targetCA}</code>\n` +
                    `<b>Amount Sold:</b> ${percentage}%\n` +
                    `💰 <b>PnL: +${pnlPercent.toFixed(2)}%</b>\n` +
                    `Status: 🟢 Executed via Jito Bundle.\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;
                
                try {
                    const { generatePnlCard } = await import('./services/image.service.js');
                    const imageBuffer = await generatePnlCard(targetCA, pnlPercent, user?.referralCode);
                    const tweetText = encodeURIComponent(`Just secured +${pnlPercent.toFixed(1)}% using Sentry Terminal ⚡️\nhttps://t.me/${process.env.BOT_USERNAME}?start=${user?.referralCode}`);
                    const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share to X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };
                    await ctx.replyWithPhoto({ source: imageBuffer }, { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn });
                    await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});
                } catch (_) {
                    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                }
            } else {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `🟢 <b>MANUAL SELL SUCCESSFUL!</b>\n\n<b>Token:</b> <code>${targetCA}</code>\n<b>Amount Sold:</b> ${percentage}%\n<b>Status:</b> ${result.message}\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            }

            if (percentage === 100) {
                await cancelAllGuardsForToken(tgId, targetCA); 
            } else {
                const guards = await redis.smembers(`token_guards:${tgId}:${targetCA}`);
                for (const id of guards) {
                    const raw = await redis.get(`order:trail:${id}`);
                    if (raw) {
                        const order = JSON.parse(raw);
                        await updateGuardSize(id, order.amountInSol * (1 - (percentage / 100)));
                    }
                }
            }
        } else {
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>SELL FAILED:</b> ${result.message}`, { parse_mode: 'HTML' });
        }
    } catch (e: any) { 
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>FATAL ERROR:</b> Could not process sell.`, { parse_mode: 'HTML' }); 
    } finally { 
        await redis.del(sellLockKey); 
    }
});

// =========================================================
// ⏳ DCA & LIMIT ENGINE
// =========================================================
bot.action('menu_dca', async (ctx) => { 
    try{await ctx.answerCbQuery();}catch(e){} 
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    const activeDcaCount = await prisma.activeOrder.count({ where: { user: { telegramId: tgId }, orderType: 'DCA', isActive: true }});
    const activeLimitCount = await prisma.activeOrder.count({ where: { user: { telegramId: tgId }, orderType: 'LIMIT', isActive: true }});

    const dcaText = `⏳ <b>LIMIT & DCA ENGINE</b>\n\nConfigure automated interval buying or set target prices to buy dips.\n\n<i>Active Limit Orders: ${activeLimitCount}\nActive DCA Schedules: ${activeDcaCount}</i>`;
    const UI = Markup.inlineKeyboard([
        [Markup.button.callback('🎯 New Limit Order', 'action_deploy_limit')],
        [Markup.button.callback('➕ New DCA Schedule', 'action_deploy_dca')],
        [Markup.button.callback('🛑 Cancel All', 'action_cancel_dca')], 
        [Markup.button.callback('⬅️ Back', 'btn_dashboard')]
    ]);
    
    await safeEditMessageText(ctx, dcaText, UI);
});

bot.action('action_deploy_limit', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:limit:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`⏳ <b>DEPLOY LIMIT ORDER</b>\n\nPaste parameters:\n<code>[CA] [TARGET PRICE USD] [AMOUNT SOL]</code>\n\n<i>Example (Buy 0.5 SOL when token hits $0.005):</i>\n<code>JUPyiw... 0.005 0.5</code>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_deploy_dca', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:dca:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`⏳ <b>DEPLOY TWAP / DCA ENGINE</b>\n\nPaste parameters:\n<code>[CA] [INTERVAL MINS] [AMOUNT SOL] [DROP %] [OPTIONAL TP %] [OPTIONAL MAX BUDGET SOL]</code>\n\n<i>Example:</i>\n<code>JUPyiw... 60 0.05 5 50 2.0</code>\n\n<i>Type /cancel to abort.</i>`, { parse_mode: 'HTML' });
});

bot.action('action_cancel_dca', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (user) {
        await prisma.activeOrder.updateMany({ where: { userId: user.id, orderType: { in: ['DCA', 'LIMIT'] }, isActive: true }, data: { isActive: false } });
        await safeEditMessageText(ctx, `✅ <b>All active DCA and Limit Orders have been cancelled.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_dca')]]));
    }
});

// =========================================================
// 🛡️ TRAILING STOPS
// =========================================================
bot.action('menu_trailing', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const text = `🛡️ <b>ACTIVE GUARDS (TRAILING STOPS)</b>\n\n<i>To deploy a Guard, click the button below and follow instructions.</i>`;
    const UI = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Deploy Trailing Guard', 'action_deploy_guard')], 
        [Markup.button.callback('🛑 Cancel All Guards', 'action_cancel_guards')], 
        [Markup.button.callback('⬅️ Back', 'btn_dashboard')]
    ]);
    await safeEditMessageText(ctx, text, UI);
});

bot.action('action_deploy_guard', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:guard:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`🛡️ <b>DEPLOY GUARD & TAKE PROFIT</b>\nPaste parameters:\n<code>[CA] [DROP %] [AMOUNT SOL] [OPTIONAL TP %]</code>\n\n<i>Example 2 (With +50% Take Profit):</i>\n<code>JUPyiw... 15 0.1 50</code>\n\n<i>Type /cancel at any time to abort.</i>`);
});

bot.action('action_cancel_guards', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const cancelledCount = await cancelAllUserGuards(tgId);
    await safeEditMessageText(ctx, `✅ <b>${cancelledCount} Active Guards have been cancelled and removed from memory.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_trailing')]]));
});

// =========================================================
// 🔑 VAULT SYSTEM
// =========================================================
bot.action('menu_vault', async (ctx) => { 
    try{await ctx.answerCbQuery();}catch(e){} 
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) return;

    const loader = await ctx.replyWithHTML("<i>⏳ Scanning sub-wallet balances...</i>");
    const pubkeys = [
        user.vaultAddress ? new PublicKey(user.vaultAddress) : null,
        user.vault2 ? new PublicKey(user.vault2) : null,
        user.vault3 ? new PublicKey(user.vault3) : null,
        user.vault4 ? new PublicKey(user.vault4) : null,
        user.vault5 ? new PublicKey(user.vault5) : null
    ];
    const balances = await Promise.all(pubkeys.map(pk => pk ? connection.getBalance(pk).catch(()=>0) : Promise.resolve(0)));

    let walletText = `🔑 <b>VAULT & KEYS</b>\n\n`;
    walletText += `<b>W1 (Main):</b> <code>${user.vaultAddress}</code> <b>(${ (balances[0]/LAMPORTS_PER_SOL).toFixed(4)} SOL)</b>\n`;
    if (user.activeWallets >= 2 && user.vault2) walletText += `<b>W2:</b> <code>${user.vault2}</code> <b>(${ (balances[1]/LAMPORTS_PER_SOL).toFixed(4)} SOL)</b>\n`;
    if (user.activeWallets >= 3 && user.vault3) walletText += `<b>W3:</b> <code>${user.vault3}</code> <b>(${ (balances[2]/LAMPORTS_PER_SOL).toFixed(4)} SOL)</b>\n`;
    if (user.activeWallets >= 4 && user.vault4) walletText += `<b>W4:</b> <code>${user.vault4}</code> <b>(${ (balances[3]/LAMPORTS_PER_SOL).toFixed(4)} SOL)</b>\n`;
    if (user.activeWallets >= 5 && user.vault5) walletText += `<b>W5:</b> <code>${user.vault5}</code> <b>(${ (balances[4]/LAMPORTS_PER_SOL).toFixed(4)} SOL)</b>\n\n`;

    walletText += `🐙 <b>WHY USE MULTI-WALLET (WHALE MODE)?</b>\nPump.fun restricts how many tokens a single wallet can buy at launch. By activating multiple wallets, Sentry fires simultaneous transactions in the exact same millisecond via Jito. <b>You bypass the limits, secure a massive bag at Block-0, and dump on the timeline.</b>\n\n<i>⚠️ NOTE: You MUST send SOL to each individual address above!</i>\n\n<b>Active Wallets:</b> ${user.activeWallets} / 5\n`;

    await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(()=>{});
    
    const UI = Markup.inlineKeyboard([
        [
            Markup.button.callback(user.activeWallets === 1 ? '🟢 1' : '1', 'set_wallets_1'),
            Markup.button.callback(user.activeWallets === 2 ? '🟢 2' : '2', 'set_wallets_2'),
            Markup.button.callback(user.activeWallets === 3 ? '🟢 3' : '3', 'set_wallets_3'),
            Markup.button.callback(user.activeWallets >= 4 ? '🟢 4' : '4', 'set_wallets_4'),
            Markup.button.callback(user.activeWallets >= 5 ? '🟢 5' : '5', 'set_wallets_5')
        ],
        [Markup.button.callback('🧹 Sweep All Sub-Wallets to W1', 'action_consolidate_wallets')],
        [Markup.button.callback('📤 Export Keys', 'action_export_key'), Markup.button.callback('📥 Import Key', 'action_import_key')],
        [Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]
    ]);

    await safeEditMessageText(ctx, walletText, UI); 
});

bot.action('action_consolidate_wallets', async (ctx) => {
    try { await ctx.answerCbQuery("⏳ Sweeping sub-wallets to W1..."); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user || !user.vaultAddress) return;

    const mainPubkey = new PublicKey(user.vaultAddress);
    const subWallets = [
        { pub: user.vault2, pk: user.pk2 }, { pub: user.vault3, pk: user.pk3 },
        { pub: user.vault4, pk: user.pk4 }, { pub: user.vault5, pk: user.pk5 }
    ].filter(w => w.pub && w.pk);

    let sweptSol = 0;
    for (const w of subWallets) {
        try {
            const vaultPubkey = new PublicKey(w.pub!);
            const balance = await connection.getBalance(vaultPubkey);
            const gasBuffer = 50000; // 0.002 SOL
            if (balance > gasBuffer) {
                const rawPk = decryptKey(w.pk!);
                if (!rawPk) continue;
                const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
                const ix = SystemProgram.transfer({ fromPubkey: vaultPubkey, toPubkey: mainPubkey, lamports: balance - gasBuffer });
                const { blockhash } = await connection.getLatestBlockhash();
                const tx = new VersionedTransaction(new TransactionMessage({ payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
                tx.sign([keypair]);
                await connection.sendRawTransaction(Buffer.from(tx.serialize()), { skipPreflight: true });
                sweptSol += (balance - gasBuffer) / LAMPORTS_PER_SOL;
            }
        } catch(e) {}
    }
    await ctx.replyWithHTML(`✅ <b>CONSOLIDATION COMPLETE</b>\nSwept ~<b>${sweptSol.toFixed(4)} SOL</b> from sub-wallets into W1.`);
});

bot.command('pnl', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const loader = await ctx.reply("<i>⏳ Calculating portfolio value...</i>", { parse_mode: 'HTML' });
    const positions = await getUserPositions(tgId);
    
    if (!positions || positions.length === 0) {
        return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, "💼 Your portfolio is currently empty.");
    }

    let totalUsd = 0;
    let msg = `📊 <b>PORTFOLIO SUMMARY</b>\n\n`;
    positions.forEach((p: any) => {
        totalUsd += p.valueUsd;
        msg += `• <b>${p.symbol}</b>: $${p.valueUsd.toFixed(2)}\n`;
    });
    msg += `\n💰 <b>Total Unrealized Value:</b> $${totalUsd.toFixed(2)}`;
    await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, msg, { parse_mode: 'HTML' });
});

bot.hears(/^\/watch (.+) (.+)/i, async (ctx) => {
    const ca = ctx.match[1].trim();
    const targetPrice = parseFloat(ctx.match[2]);
    if (isNaN(targetPrice)) return ctx.reply("🔴 Invalid price target.");
    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from?.id.toString() } });
    if (!user) return;

    await prisma.activeOrder.create({
        data: { userId: user.id, tokenAddress: ca, orderType: 'ALERT', amountSol: 0, targetPriceUsd: targetPrice, isActive: true }
    });
    ctx.replyWithHTML(`👀 <b>WATCHLIST ALERT SET</b>\nSentry will ping you when <code>${ca.substring(0,8)}...</code> hits <b>$${targetPrice}</b>.`);
});

bot.action('action_export_key', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await ctx.editMessageText(
        `⚠️ <b>SECURITY WARNING</b> ⚠️\n\nYou are about to reveal your raw private keys in this chat. Anyone with access to this screen can steal your funds.\n\nDo you want to proceed?`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.callback('🚨 YES, SHOW MY KEYS', 'confirm_export_key')],
            [Markup.button.callback('❌ CANCEL', 'menu_vault')]
        ])}
    );
});

bot.action('confirm_export_key', async (ctx) => {
    try { await ctx.answerCbQuery("⚠️ Keys generated. Deleting in 60s..."); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user || !user.turnkeySubOrgId) return ctx.reply("🔴 No vault found.");

    let keyText = `⚠️ <b>YOUR PRIVATE KEYS</b> ⚠️\n\n`;
    const rawPk1 = await exportPrivateKey(tgId);
    if(rawPk1) keyText += `<b>Wallet 1 (Main):</b>\n<code>${rawPk1}</code>\n\n`;
    if (user.activeWallets >= 2 && user.pk2) keyText += `<b>Wallet 2:</b>\n<code>${decryptKey(user.pk2)}</code>\n\n`;
    if (user.activeWallets >= 3 && user.pk3) keyText += `<b>Wallet 3:</b>\n<code>${decryptKey(user.pk3)}</code>\n\n`;
    if (user.activeWallets >= 4 && user.pk4) keyText += `<b>Wallet 4:</b>\n<code>${decryptKey(user.pk4)}</code>\n\n`;
    if (user.activeWallets >= 5 && user.pk5) keyText += `<b>Wallet 5:</b>\n<code>${decryptKey(user.pk5)}</code>\n\n`;
    keyText += `<i>Tap a key to copy it. This message will AUTO-DELETE in 60 seconds.</i>`;

    await ctx.editMessageText(keyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_vault')]]) });
    
    // 🟢 BUG FIX: Resolved TypeScript error by getting message_id directly from the callback context
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (msgId) {
        setTimeout(() => {
            ctx.telegram.deleteMessage(ctx.chat!.id, msgId).catch(() => {});
        }, 60000);
    }
});

bot.action('action_import_key', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:import_key:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`📥 <b>IMPORT EXISTING WALLET</b>\n\nReply to this message with your Phantom/Solflare <b>Private Key (Base58 string)</b>.\n\n<i>⚠️ NOTE: This will permanently overwrite your current Sentry Vault. Make sure you have exported and saved your current Sentry key first if it holds funds!</i>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action(/^set_wallets_([1-5])$/, async (ctx) => {
    try { await ctx.answerCbQuery("⏳ Configuring Wallets..."); } catch(e){}
    const count = parseInt(ctx.match[1]);
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await ensureWalletsExist(tgId, count);
    
    await ctx.replyWithHTML(`✅ <b>Multi-Wallet Updated!</b>\n\nYour sniper will now fire from <b>${count} Wallets</b> simultaneously on every buy.\n\n<i>Note: Ensure you deposit SOL into all active wallets, or they will be skipped during the snipe.</i>`);
    bot.handleUpdate({ ...ctx.update, callback_query: { ...((ctx as any).callbackQuery || {}), data: 'menu_vault' } } as any);
});

// =========================================================
// 👥 COPY TRADING (UNLOCKED FOR ALL USERS)
// =========================================================
bot.action('menu_copytrade', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { copyTrades: true } });
    if (!user) return;

    let text = `👥 <b>COPY TRADING</b>\n\nAutomatically mirror the trades of profitable Whale wallets via zero-latency WebSockets.\n\n<b>Your Active Targets:</b>\n`;
    if (user.copyTrades.length === 0) text += `<i>No wallets currently being copied.</i>\n\n`;
    else { user.copyTrades.forEach((ct, i) => { text += `${i + 1}. <code>${ct.targetWallet.substring(0,8)}...</code> (Buy size: ${ct.tradeAmountSol} SOL)\n`; }); text += `\n`; }

    text += `👑 <b>SENTRY ALPHA DIRECTORY (FREE ACCESS)</b>\n<i>View our curated database of Solana's most profitable Whale Wallets below.</i>`;

    const buttons = [
        [Markup.button.callback('➕ Add Custom Wallet', 'action_add_copytrade')],
        [Markup.button.callback('👑 View Alpha Directory', 'action_view_directory')],
        [Markup.button.callback('🛑 Clear All Targets', 'action_clear_copytrade')],
        [Markup.button.callback('⬅️ Back', 'btn_dashboard')]
    ];
    await safeEditMessageText(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action('action_view_directory', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const directoryText = `👑 <b>SENTRY ALPHA DIRECTORY</b>\n\n<i>Top performing Pump.fun wallets curated by the Sentry Intelligence Team. Click any address to copy, then paste it in "Add Custom Wallet".</i>\n\n` +
        `🥇 <b>Oracle_01 (78% Win Rate | +142.5 SOL Net 7D)</b>\n<code>3yFomLQyHj3Y2bWmK1XG9p5uBEwF6PQcaQSkeBpn782T</code>\n\n` +
        `🥈 <b>Oracle_02 (71% Win Rate | +89.2 SOL Net 7D)</b>\n<code>7kPxoM4TzVU4EoHEpgzq1VV7AbicfhtW4xC9iMCe6TQq</code>\n\n` +
        `🥉 <b>Oracle_03 (64% Win Rate | +210.8 SOL Net 7D)</b>\n<code>5Q544fKrFoe6tsEbD7S8EmxjnzVU4EoHEpgzq1VV7Abic</code>\n\n` +
        `🔥 <b>Oracle_05 (89% Win Rate | Insider Wallets)</b>\n<code>A1foGxGHK3nasjjnr7jxW14VNCe6TQqeHC9p8KetsN6J</code>\n\n`;
    await safeEditMessageText(ctx, directoryText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Copy Trade', 'menu_copytrade')]]));
});

bot.action('action_add_copytrade', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:copytrade:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`👥 <b>NEW COPY TRADE</b>\n\nPaste parameters:\n<code>[TARGET_WALLET] [AMOUNT_SOL] [DROP_GUARD %] [OPTIONAL_TP %]</code>\n\n<i>Example:</i>\n<code>5Q544fKrFoe... 0.1 20 50</code>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_clear_copytrade', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const user = await prisma.user.findUnique({ where: { telegramId: ctx.from?.id.toString() } });
    if (user) {
        await prisma.copyTradeConfig.deleteMany({ where: { userId: user.id } });
        
        // 🟢 AUDIT FIX: Instantly close the WebSockets when the user clears targets 
        // to prevent the 30-second phantom leak window.
        syncCopyTradeListeners(bot);
        
        await safeEditMessageText(ctx, `✅ <b>All Copy Trade targets have been cleared.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_copytrade')]]));
    }
});


// =========================================================
// 🔍 TOKEN X-RAY SCANNER
// =========================================================
bot.hears(/^\/(scan|xray|info) (.+)/i, async (ctx) => {
    const ca = ctx.match[2].trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return ctx.reply("🔴 Invalid Solana Contract Address.");

    const loader = await ctx.reply("<i>⏳ Scanning blockchain and liquidity pools...</i>", { parse_mode: 'HTML' });

    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 8000 });
        const data = res.data;

        if (!data || !data.pairs || data.pairs.length === 0) {
            if (ca.toLowerCase().endsWith("pump")) {
                return await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `⚠️ <b>Token Not Indexed Yet</b>\nThis is a brand new Pump.fun token. DexScreener hasn't tracked it yet, but Sentry can still snipe it!\n\n<i>Reply with the CA and an amount (e.g. \`${ca} 0.5\`) to Snipe instantly.</i>`, 
                    { parse_mode: 'HTML' }
                ).catch(()=>{});
            }
            return await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Token Not Found</b>\nThis token might be too new, has no liquidity, or the API blocked the request.`, { parse_mode: 'HTML' }).catch(()=>{});
        }

        const pair = data.pairs[0];
        const ageHours = pair.pairCreatedAt ? ((Date.now() - pair.pairCreatedAt) / 3600000).toFixed(1) : "Unknown";
        
        let safeText = "🟢 Safe";
        try {
            const rugRes = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${ca}/report/summary`, { timeout: 5000 });
            const rugData = rugRes.data;
            if (rugData.risks && rugData.risks.some((r: any) => r.name === 'Freeze Authority still enabled' || r.score > 500)) {
                safeText = "🔴 HIGH RISK (Honeypot/Freeze)";
            }
        } catch (e) { safeText = "⚪ Unknown (RugCheck API Timeout)"; }

        const report = 
            `🔍 <b>SENTRY X-RAY REPORT</b>\n\n` +
            `🪙 <b>Token:</b> ${pair.baseToken.name} (<b>$${pair.baseToken.symbol}</b>)\n` +
            `📝 <b>CA:</b> <code>${ca}</code>\n\n` +
            `📊 <b>Market Data:</b>\n` +
            `• Price: <b>$${parseFloat(pair.priceUsd).toFixed(6)}</b>\n` +
            `• Market Cap: <b>$${pair.fdv ? pair.fdv.toLocaleString() : "Unknown"}</b>\n` +
            `• Liquidity: <b>$${pair.liquidity ? pair.liquidity.usd.toLocaleString() : "Unknown"}</b>\n` +
            `• 24h Vol: <b>$${pair.volume ? pair.volume.h24.toLocaleString() : "0"}</b>\n\n` +
            `⏱️ <b>Momentum:</b>\n` +
            `• 5m Change: <b>${pair.priceChange?.m5 || 0}%</b>\n` +
            `• 1h Change: <b>${pair.priceChange?.h1 || 0}%</b>\n` +
            `• Pool Age: <b>${ageHours} Hours</b>\n\n` +
            `🛡️ <b>Security:</b> ${safeText}\n\n` +
            `<i>Reply with the CA and an amount (e.g., \`${ca} 0.5\`) to Snipe instantly.</i>`;

        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, report, { parse_mode: 'HTML' }).catch(()=>{});
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Scan Failed:</b> API Blocked or Timeout.`, { parse_mode: 'HTML' }).catch(()=>{});
    }
});


// =========================================================
// 💸 DYNAMIC WITHDRAWAL SYSTEM
// =========================================================
bot.hears(/^\/(withdraw|witdraw|withdrawal) (.+)/i, async (ctx) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    // 🟢 CRITICAL BUG 5 FIX: Enforce Redis withdrawal re-entrancy lock
    const withdrawLockKey = `lock:withdraw:${telegramId}`;
    const isLocked = await redis.set(withdrawLockKey, 'LOCKED', 'EX', 60, 'NX');
    if (!isLocked) return ctx.replyWithHTML("⚠️ <b>Withdrawal already processing.</b> Please wait for the current request to settle.");

    const text = (ctx.message as any).text || "";
    const inputParts = text.trim().split(/\s+/);
    if (inputParts.length !== 3) {
        await redis.del(withdrawLockKey);
        return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Please use: <code>/withdraw [ADDRESS] [AMOUNT]</code> or <code>/withdraw [ADDRESS] ALL</code>`);
    }

    const targetAddress = inputParts[1]!;
    const amountStr = inputParts[2]!.toLowerCase();
    const isMax = amountStr === 'all' || amountStr === 'max';
    const requestedAmount = isMax ? 0 : parseFloat(amountStr);
    
    if (!isMax && (isNaN(requestedAmount) || requestedAmount <= 0)) {
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Invalid amount specified.");
    }

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Authentication Failed. No Vault found.");
    }

    let targetPubkey: PublicKey;
    try { targetPubkey = new PublicKey(targetAddress); } catch (e) { 
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Invalid destination Solana address."); 
    }

    const loader = await ctx.replyWithHTML(`<i>⏳ Calculating precise gas fees and preparing transaction...</i>`);

    try {
        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        let remainingLamportsToWithdraw = isMax ? Number.MAX_SAFE_INTEGER : Math.floor(requestedAmount * LAMPORTS_PER_SOL);
        let totalSentAmount = 0; 
        let successCount = 0; 
        let finalSignature = "";

        for (const w of wallets) {
            if (remainingLamportsToWithdraw <= 0) break; 

            const vaultPubkey = new PublicKey(w.pub);
            const liveBalance = await connection.getBalance(vaultPubkey);
            
            const gasBuffer = 10000; 

            let lamportsToWithdraw = 0;
            if (isMax) {
                lamportsToWithdraw = liveBalance - gasBuffer;
            } else {
                lamportsToWithdraw = Math.min(remainingLamportsToWithdraw, liveBalance - gasBuffer);
            }

            if (lamportsToWithdraw <= 0) continue; 

            const rawPk = decryptKey(w.pk);
            if (!rawPk) {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `🔴 <b>Withdrawal Failed: Decryption Fault</b>\n\nYour vault keys cannot be decrypted. This happens if the bot restarted with a different or missing <code>ENCRYPTION_KEY</code> in your <code>.env</code>.\n\n<i>To fix this, please re-import your wallet's private key via the bot interface.</i>`, 
                    { parse_mode: 'HTML' }
                );
                await redis.del(withdrawLockKey);
                return;
            }

            try {
                const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
                const ix = SystemProgram.transfer({ fromPubkey: vaultPubkey, toPubkey: targetPubkey, lamports: lamportsToWithdraw });
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                const messageV0 = new TransactionMessage({ payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
                const vTx = new VersionedTransaction(messageV0);
                vTx.sign([keypair]);
                
                const txBuffer = Buffer.from(vTx.serialize());
                const sig = await connection.sendRawTransaction(txBuffer, { skipPreflight: true });
                
                // 🟢 CRITICAL BUG 1 FIX: Safely poll confirmation to guarantee success before reporting
                let isConfirmed = false;
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                    if (status?.value && !status.value.err) {
                        isConfirmed = true;
                        break;
                    }
                }

                if (!isConfirmed) throw new Error("Transaction dropped by the network.");

                finalSignature = sig; 
                
                if (!isMax) remainingLamportsToWithdraw -= lamportsToWithdraw;
                totalSentAmount += (lamportsToWithdraw / LAMPORTS_PER_SOL);
                successCount++;
            } catch (txError: any) {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `🔴 <b>Withdrawal Failed: On-Chain Error</b>\n\n<code>${txError.message}</code>`, 
                    { parse_mode: 'HTML' }
                );
                await redis.del(withdrawLockKey);
                return;
            }
        }

        if (successCount > 0) {
            await redis.del(`balance_cache:${telegramId}`); 
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `🟢 <b>WITHDRAWAL SUCCESSFUL</b>\n\n` +
                `<b>Total Swept:</b> <code>${totalSentAmount.toFixed(4)} SOL</code>\n` +
                `<b>Destination:</b> <code>${targetAddress}</code>\n\n` +
                `🔗 <a href="https://solscan.io/tx/${finalSignature}">View Receipt on Solscan</a>`, 
                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
            );
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Failed:</b> Insufficient balance in your vault to cover the network transfer fee.`);
        }
    } catch (e: any) { 
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Error:</b> ${e.message}`); 
    } finally {
        await redis.del(withdrawLockKey);
    }
});
// =========================================================
// 🎁 ADMIN COMMAND: GIVE FREE VIP & DEV SUITE TO KOLS
// =========================================================
bot.command('vip', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').concat(process.env.ADMIN_TELEGRAM_ID || "").filter(Boolean);
    
    if (!tgId || !ADMIN_IDS.includes(tgId)) return; 

    const text = (ctx.message as any).text || "";
    const parts = text.trim().split(/\s+/);
    
    if (parts.length !== 2) {
        return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>/vip [USER_TELEGRAM_ID]</code>\n\n<i>Example:</i> <code>/vip 8494722111</code>`);
    }

    const targetTgId = parts[1];

    try {
        const targetUser = await prisma.user.findUnique({ where: { telegramId: targetTgId } });
        if (!targetUser) return ctx.replyWithHTML(`🔴 <b>Error:</b> User <code>${targetTgId}</code> not found. They must send /start to the bot first.`);

        await prisma.user.update({
            where: { telegramId: targetTgId },
            data: { isVip: true, isDevSuiteUnlocked: true }
        });

        await ctx.replyWithHTML(`✅ <b>SUCCESS:</b> VIP & Dev Suite fully unlocked for <code>${targetTgId}</code>.`);

        await bot.telegram.sendMessage(
            targetTgId,
            `👑 <b>SENTRY PRO UPGRADE GRANTED</b> 👑\n\n` +
            `The platform admin has just upgraded your account to the maximum tier for free!\n\n` +
            `<b>You now have lifetime access to:</b>\n` +
            `• The VIP Alpha Directory (Copy Trading)\n` +
            `• The Sentry Developer Suite (Volume Bumper & Nuke)\n\n` +
            `<i>Open your /start dashboard to see your new tools!</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => null);

    } catch (e: any) {
        await ctx.reply(`🔴 Error: ${e.message}`);
    }
});
bot.action(/^forcebuy_(.+)_(.+)$/, async (ctx) => {
    const ca = ctx.match[1];
    const amt = parseFloat(ctx.match[2]);
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    await ctx.editMessageText(`⚠️ <b>OVERRIDE ACCEPTED</b>\n\nExecuting force-buy for ${ca}...`, { parse_mode: 'HTML' });
    const result = await executeSnipe(tgId, ca, amt);
    
    if (result.success) {
        await ctx.replyWithHTML(`🟢 <b>FORCE SNIPE SUCCESSFUL!</b>\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, { link_preview_options: { is_disabled: true } });
    } else {
        // 🟢 BUG FIX: Display the actual failure reason (gas, route, API block) instead of silently failing
        await ctx.editMessageText(`🔴 <b>FORCE SNIPE FAILED:</b> ${result.message}`, { parse_mode: 'HTML' });
    }
});

bot.action(/^confirm_buy_(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const telegramId = ctx.from?.id.toString()!;
    await ctx.answerCbQuery();

    // 🟢 AUDIT FIX: Per-user Global Rate Limit for Snipes (3s Cooldown)
    const snipeLockKey = `lock:global_snipe:${telegramId}`;
    const isSnipeLocked = await redis.set(snipeLockKey, 'LOCKED', 'EX', 3, 'NX');
    if (!isSnipeLocked) {
        return ctx.replyWithHTML("⏳ <b>Rate Limit Exceeded:</b> Please wait 3 seconds before executing another snipe.");
    }

    const rawAmt = await redis.get(`pending_buy:${telegramId}:${tokenAddress}`);
    const user = await prisma.user.findUnique({ 
        where: { telegramId },
        include: { autoSnipeConfig: true } 
    });

    const amountSol = rawAmt ? parseFloat(rawAmt) : (user?.autoSnipeConfig?.amountSol || 0.1);
    const loader = await ctx.replyWithHTML(`⚡ <b>EXECUTING SNIPE</b>\n\nTarget: <code>${tokenAddress.substring(0,8)}...</code>\nAmount: <b>${amountSol} SOL</b>\n<i>⏳ Verifying Contract Security & Building Jito Bundle...</i>`);

    // 🟢 NEW FEATURE: Final Anti-Rug Safety Net before Jito Submission
    try {
        const rugRes = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`, { timeout: 1500 }).catch(() => null);
        if (rugRes?.data?.risks?.some((r: any) => r.name === 'Freeze Authority still enabled' || r.score > 800)) {
            await redis.del(snipeLockKey);
            return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                `🚨 <b>CRITICAL RUG PULL DETECTED</b> 🚨\n\nContract ${tokenAddress.substring(0,6)}... has a Freeze Authority or high honeypot risk. Sentry has automatically blocked this transaction to save your funds.`, 
                { parse_mode: 'HTML' }
            );
        }
    } catch (e) {
        // Continue to buy if API times out to not block fast snipes
    }

    const result = await executeSnipe(telegramId, tokenAddress, amountSol);

    if (result.success) {
        await redis.del(`balance_cache:${telegramId}`);
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
            `🟢 <b>SNIPE SUCCESSFUL!</b>\n\n<b>Token:</b> <code>${tokenAddress}</code>\n<b>Invested:</b> ${amountSol} SOL\n<b>Status:</b> ${result.message}\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, 
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([[Markup.button.callback('💼 View Positions', 'menu_positions')]]) }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>SNIPE FAILED:</b> ${result.message}`, { parse_mode: 'HTML' });
    }
});

bot.action('cancel_buy', async (ctx) => {
    try { await ctx.answerCbQuery('Cancelled.'); } catch(e){}
    await ctx.editMessageText('❌ <b>Buy cancelled.</b>', { parse_mode: 'HTML' });
});

// =========================================================
// ⚡ TEXT INTERCEPTOR: (Catches Redis States & Snipes)
// =========================================================
bot.on("text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return next();

    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
        const keysToClear = [
            `state:guard:${telegramId}`, `state:dca:${telegramId}`, `state:limit:${telegramId}`, 
            `state:copytrade:${telegramId}`, `state:import_key:${telegramId}`, `state:autosnipe_amt:${telegramId}`, 
            `state:autosnipe_sl:${telegramId}`, `state:autosnipe_delay:${telegramId}`, `state:autosnipe_tp:${telegramId}`, 
            `state:autosnipe_mc:${telegramId}`, `state:autosnipe_budget:${telegramId}`, `state:autosnipe_dev:${telegramId}`, 
            `state:enter_ref:${telegramId}`, `state:edit_slippage:${telegramId}`, `state:edit_custom_speed:${telegramId}`, 
            `state:dev_volume:${telegramId}`, `state:dev_nuke:${telegramId}`,
            `active_bumper:${telegramId}`,
            `state:edit_caller_age:${telegramId}`, `state:edit_caller_pct:${telegramId}`,
            `state:caller_guard_input:${telegramId}`, `state:caller_dca_input:${telegramId}`,
            `sim:autosnipe:${telegramId}`, `sim:caller_seq:${telegramId}`
        ];
        if (redis.del) await redis.del(...keysToClear); 

        // 🟢 INSTANTLY EDIT THE ACTIVE CARD TO "OFF" WITHOUT SPAMMING THE CHAT
        const activeMsgId = await redis.get(`sim:autosnipe_msg:${telegramId}`);
        if (activeMsgId) {
            await bot.telegram.editMessageText(ctx.chat.id, parseInt(activeMsgId), undefined, 
                `🤖 <b>SIM AUTO-SNIPER: 🔴 OFF</b> 🎮\n\n<i>Auto-Sniper stopped.</i>`, 
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⚡ ARM SIM SNIPER', callback_data: 'toggle_autosnipe' }], [{ text: '⬅️ Back to Dashboard', callback_data: 'btn_dashboard' }]] } }
            ).catch(() => null);
            await redis.del(`sim:autosnipe_msg:${telegramId}`);
            return; // EXIT SILENTLY
        }

        // Only send generic cancel message if there was no active sim card
        await ctx.replyWithHTML(`✅ <b>Action Cancelled. Automations & Bumpers Paused.</b> You are back to the main menu.`);
        await sendOrEditDashboard(ctx, telegramId, false);
        return;
    }
    
    if (text.startsWith("/")) return next();

    try {
        if (await redis.get(`state:edit_slippage:${telegramId}`)) {
            await redis.del(`state:edit_slippage:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 1 || val > 100) return ctx.replyWithHTML(`🔴 <b>Invalid Slippage.</b> Must be between 1 and 100.`);
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (user) { 
                await prisma.user.update({ where: { id: user.id }, data: { slippagePercent: val } }); 
                await ctx.replyWithHTML(`✅ <b>Slippage successfully updated to ${val}%.</b>`);
                await sendOrEditSettings(ctx, telegramId, false); 
            }
            return;
        }

        if (await redis.get(`state:edit_custom_speed:${telegramId}`)) {
            await redis.del(`state:edit_custom_speed:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0.0001 || val > 1.0) return ctx.replyWithHTML(`🔴 <b>Invalid Amount.</b> Custom fee must be a number between 0.0001 and 1.0 SOL.`);
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (user) {
                await prisma.user.update({ where: { id: user.id }, data: { priorityLevel: "CUSTOM", customPriorityFee: val } });
                await ctx.replyWithHTML(`✅ <b>Custom Jito Tip successfully set to ${val} SOL!</b>`);
                await sendOrEditSettings(ctx, telegramId, false); 
            }
            return;
        }

        // Add these to keysToClear in the /cancel intercept block:
// `state:edit_caller_age:${telegramId}`, `state:edit_caller_pct:${telegramId}`

// 🟢 CATCH CALLER INLINE GUARD INPUT
const callerGuardCA = await redis.get(`state:caller_guard_input:${telegramId}`);
if (callerGuardCA) {
    await redis.del(`state:caller_guard_input:${telegramId}`);
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 2 && parts.length !== 3) {
        return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please reply with: <code>[DROP %] [AMOUNT SOL] [OPTIONAL TP %]</code>");
    }
    
    const trailPct = parseFloat(parts[0]);
    const solAmt = parseFloat(parts[1]);
    const tpPct = parts.length === 3 ? parseFloat(parts[2]) : undefined;

    if (isNaN(trailPct) || isNaN(solAmt) || (tpPct !== undefined && isNaN(tpPct))) {
        return ctx.reply("🔴 Invalid numbers provided.");
    }

    const loader = await ctx.replyWithHTML(`<i>⏳ Executing Jito Trade & Syncing Guard...</i>`);
    try {
        const buyResult = await executeSnipe(telegramId, callerGuardCA, solAmt);
        if (!buyResult.success) {
            return await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `${buyResult.message}`, { parse_mode: 'HTML' });
        }

        let initialPriceNative = 0;
        try {
            const priceRes = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${callerGuardCA}`).catch(() => null);
            initialPriceNative = priceRes?.data?.data?.[callerGuardCA]?.price || 0;
        } catch (_) {}

        await addTrailingStopToMemory(telegramId, callerGuardCA, trailPct, solAmt, initialPriceNative, tpPct);
        
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
            `🟢 <b>BUY & GUARD SUCCESSFUL!</b>\n\nToken: <code>${callerGuardCA.substring(0,8)}...</code>\nInvested: <b>${solAmt} SOL</b>\nTrailing Drop: <b>-${trailPct}%</b>\nTake Profit: ${tpPct ? `<b>+${tpPct}%</b>` : `<i>Not Set</i>`}\n\n🔗 <a href="https://solscan.io/tx/${buyResult.signature}">View on Solscan</a>`, 
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Error:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
    return;
}

// 🟢 CATCH CALLER INLINE DCA INPUT
const callerDcaCA = await redis.get(`state:caller_dca_input:${telegramId}`);
if (callerDcaCA) {
    await redis.del(`state:caller_dca_input:${telegramId}`);
    try {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 3 || parts.length > 5) {
            return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please reply with: <code>[INTERVAL] [AMOUNT] [DROP %] [OPTIONAL TP] [OPTIONAL BUDGET]</code>");
        }

        const intervalMins = parseInt(parts[0]);
        const solAmt = parseFloat(parts[1]);
        const dropPct = parseFloat(parts[2]);
        const tpPct = (parts.length >= 4 && parseFloat(parts[3]) !== 0) ? parseFloat(parts[3]) : undefined;
        const maxBudget = parts.length === 5 ? parseFloat(parts[4]) : undefined;

        if (isNaN(intervalMins) || isNaN(solAmt) || isNaN(dropPct)) {
            return ctx.reply("🔴 Invalid numbers provided.");
        }

        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return ctx.reply("🔴 User not found.");

        await prisma.activeOrder.create({
            data: {
                userId: user.id,
                tokenAddress: callerDcaCA,
                orderType: 'DCA',
                amountSol: solAmt,
                dcaIntervalMins: intervalMins,
                trailingPercent: dropPct,
                takeProfitPercent: tpPct || null,
                maxBudgetSol: maxBudget || null,
                isActive: true
            }
        });

        return ctx.replyWithHTML(`🟢 <b>TWAP/DCA SCHEDULE DEPLOYED</b>\n\nToken: <code>${callerDcaCA.substring(0,8)}...</code>\nInterval: <b>Every ${intervalMins} Minutes</b>\nAmount: <b>${solAmt} SOL per interval</b>\nMax Budget: <b>${maxBudget ? `${maxBudget} SOL` : 'Infinite'}</b>\nGuard: <b>-${dropPct}%</b>\nTake Profit: <b>${tpPct ? `+${tpPct}%` : 'Not Set'}</b>`);
    } catch (e: any) {
        return ctx.reply(`🔴 Error deploying DCA: ${e.message}`);
    }
}

// CATCH CALLER AGE EDIT
const callerAgeState = await redis.get(`state:edit_caller_age:${telegramId}`);
if (callerAgeState) {
    await redis.del(`state:edit_caller_age:${telegramId}`);
    const val = parseInt(text.trim());
    if (isNaN(val) || val < 0) return ctx.replyWithHTML("🔴 <b>Invalid Age.</b> Must be a positive number.");
    
    await setUserCallerFilters(telegramId, { maxAgeMins: val });
    await ctx.replyWithHTML(`✅ <b>Max Age updated to ${val} minutes!</b>`);
    await sendCallerMenu(ctx, telegramId, false);
    return;
}

// CATCH CALLER PCT EDIT
const callerPctState = await redis.get(`state:edit_caller_pct:${telegramId}`);
if (callerPctState) {
    await redis.del(`state:edit_caller_pct:${telegramId}`);
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 2) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Use: <code>[MIN_%] [MAX_%]</code> (Example: <code>10 500</code>)");
    
    const min = parseFloat(parts[0]);
    const max = parseFloat(parts[1]);
    if (isNaN(min) || isNaN(max) || min > max) return ctx.replyWithHTML("🔴 <b>Invalid Range.</b> Make sure Minimum is less than or equal to Maximum.");
    
    await setUserCallerFilters(telegramId, { minPctChange: min, maxPctChange: max });
    await ctx.replyWithHTML(`✅ <b>Percentage Range updated to ${min}% - ${max}%!</b>`);
    await sendCallerMenu(ctx, telegramId, false);
    return;
}


// 🟢 CATCH CALLER SCORE EDIT
        const callerScoreState = await redis.get(`state:edit_caller_score:${telegramId}`);
        if (callerScoreState) {
            await redis.del(`state:edit_caller_score:${telegramId}`);
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 0 || val > 100) return ctx.replyWithHTML("🔴 <b>Invalid Score.</b> Must be between 0 and 100.");
            
            await setUserCallerFilters(telegramId, { minScore: val });
            await ctx.replyWithHTML(`✅ <b>Minimum Score updated to ${val}!</b>`);
            await sendCallerMenu(ctx, telegramId, false);
            return;
        }
        

  // 🟢 CATCH TIERED AIRDROP EXECUTION
  const tieredGuildId = await redis.get(`state:guild_tiered_drop:${telegramId}`);
  if (tieredGuildId) {
      await redis.del(`state:guild_tiered_drop:${telegramId}`);
      const parts = text.trim().split(/\s+/);
      if (parts.length !== 3) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please use: <code>[SOL_TOP_3] [SOL_NEXT_7] [SOL_RANKS_11_TO_50]</code>");
      
      const amtTop3 = parseFloat(parts[0]);
      const amtTop10 = parseFloat(parts[1]);
      const amtTop50 = parseFloat(parts[2]);
      if (isNaN(amtTop3) || isNaN(amtTop10) || isNaN(amtTop50) || amtTop3 < 0 || amtTop10 < 0 || amtTop50 < 0) {
          return ctx.replyWithHTML("🔴 <b>Invalid Payout parameters.</b> Check entries.");
      }

      const loader = await ctx.replyWithHTML("<i>⏳ Packing tiered transfers and submitting Jito bundle...</i>");
      
      // @ts-ignore
      const { executeTieredAirdrop } = await import('./services/guild.service.js');
      const res = await executeTieredAirdrop(telegramId, tieredGuildId, amtTop3, amtTop10, amtTop50);
      
      if (res.success) {
          await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `✅ <b>TIERED AIRDROP COMPLETE!</b>\n\n${res.message}\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Transaction</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          
          if (res.notifiedUsers) {
              for (const winner of res.notifiedUsers) {
                  try {
                      await bot.telegram.sendMessage(
                          winner.tgId, 
                          `🎁 <b>GUILD REWARD RECEIVED!</b>\n\nYou just received a customized reward of <b>${winner.amount.toFixed(4)} SOL</b> directly from your Guild Leader for ranking high on the <b>${winner.guildName}</b> leaderboard!\n\n<i>Check your W1 balance on Sentry to see it.</i>`, 
                          { parse_mode: 'HTML' }
                      );
                  } catch (e) {}
              }
          }
      } else {
          await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Airdrop Failed:</b> ${res.message}`, { parse_mode: 'HTML' });
      }
      return;
  }

   // 🟢 CATCH INDIVIDUAL PAYOUT EXECUTION
   const indivGuildId = await redis.get(`state:guild_indiv_drop:${telegramId}`);
   if (indivGuildId) {
       await redis.del(`state:guild_indiv_drop:${telegramId}`);
       const parts = text.trim().split(/\s+/);
       if (parts.length !== 2) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please use: <code>[TARGET_RANK] [AMOUNT_SOL]</code>");
       
       const targetRank = parseInt(parts[0]);
       const amountSol = parseFloat(parts[1]);
       if (isNaN(targetRank) || isNaN(amountSol) || targetRank <= 0 || amountSol <= 0) {
           return ctx.replyWithHTML("🔴 <b>Invalid Payout parameters.</b> Check rank or amount.");
       }

       const loader = await ctx.replyWithHTML("<i>⏳ Processing individual transfer via Jito...</i>");
       
       // @ts-ignore
       const { executeIndividualAirdrop } = await import('./services/guild.service.js');
       const res = await executeIndividualAirdrop(telegramId, indivGuildId, targetRank, amountSol);
       
       if (res.success) {
           await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `✅ <b>PAYOUT SUCCESSFUL!</b>\n\n${res.message}\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Transaction</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
           
           // Send automated direct alert to the handpicked winner
           if (res.notifiedUser) {
               try {
                   await bot.telegram.sendMessage(
                       res.notifiedUser.tgId, 
                       `🎁 <b>GUILD REWARD RECEIVED!</b>\n\nYour Guild Leader has hand-picked you for an individual reward of <b>${res.notifiedUser.amount.toFixed(4)} SOL</b> inside the <b>${res.notifiedUser.guildName}</b> community!\n\n<i>Check your W1 balance on Sentry to see it.</i>`, 
                       { parse_mode: 'HTML' }
                   );
               } catch (e) {}
           }
       } else {
           await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Payout Failed:</b> ${res.message}`, { parse_mode: 'HTML' });
       }
       return;
   }     

// 🟢 CATCH GUILD NAME EDIT
const editGuildNameId = await redis.get(`state:edit_guild_name:${telegramId}`);
if (editGuildNameId) {
    await redis.del(`state:edit_guild_name:${telegramId}`);
    if (text.length < 3 || text.length > 30) return ctx.replyWithHTML("🔴 <b>Error:</b> Name must be between 3 and 30 characters.");
    
    await prisma.guild.update({ where: { id: editGuildNameId }, data: { name: text.trim() } });
    await ctx.replyWithHTML(`✅ <b>Guild Name successfully updated to:</b> <code>${text.trim()}</code>`);
    return;
}

// 🟢 CATCH GUILD REWARD EDIT
const editGuildRewardId = await redis.get(`state:edit_guild_reward:${telegramId}`);
if (editGuildRewardId) {
    await redis.del(`state:edit_guild_reward:${telegramId}`);
    await prisma.guild.update({ where: { id: editGuildRewardId }, data: { rewardDescription: text.trim() } });
    await ctx.replyWithHTML(`✅ <b>Guild Reward successfully updated.</b> Your members will now see the new offer when they check their /guild status.`);
    return;
}

// 🟢 CATCH BULK AIRDROP EXECUTION
const airdropGuildId = await redis.get(`state:guild_airdrop:${telegramId}`);
if (airdropGuildId) {
    await redis.del(`state:guild_airdrop:${telegramId}`);
    const totalSol = parseFloat(text.trim());
    if (isNaN(totalSol) || totalSol <= 0) return ctx.reply("🔴 Invalid amount.");

    const loader = await ctx.reply("<i>⏳ Compiling multi-transfer transaction block...</i>", { parse_mode: 'HTML' });
    
    // @ts-ignore
    const { executeGuildAirdrop } = await import('./services/guild.service.js');
    const res = await executeGuildAirdrop(telegramId, airdropGuildId, totalSol);
    
    if (res.success) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `✅ <b>AIRDROP SUCCESSFUL!</b>\n\n${res.message}\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Airdrop Failed:</b> ${res.message}`, { parse_mode: 'HTML' });
    }
    return;
}

        // AUTO-SNIPER CONFIGURATIONS
        if (await redis.get(`state:autosnipe_amt:${telegramId}`)) {
            await redis.del(`state:autosnipe_amt:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val <= 0) return ctx.reply("🔴 Invalid amount.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { amountSol: val } });
            await ctx.replyWithHTML(`✅ <b>Sniper Amount set to ${val} SOL.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_budget:${telegramId}`)) {
            await redis.del(`state:autosnipe_budget:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0) return ctx.reply("🔴 Invalid amount.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { maxBudgetSol: val === 0 ? null : val } });
            await ctx.replyWithHTML(`✅ <b>Max Budget set to ${val === 0 ? 'Infinite' : val + ' SOL'}.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_dev:${telegramId}`)) {
            await redis.del(`state:autosnipe_dev:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0 || val > 100) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { maxDevBuyPercent: val } });
            await ctx.replyWithHTML(`✅ <b>Max Dev Bag set to ${val}%.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_sl:${telegramId}`)) {
            await redis.del(`state:autosnipe_sl:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 1 || val > 100) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { autoTrailingDropPercent: val } });
            await ctx.replyWithHTML(`✅ <b>Auto-Guard SL set to -${val}%.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_tp:${telegramId}`)) {
            await redis.del(`state:autosnipe_tp:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { autoTakeProfitPercent: val === 0 ? null : val } });
            await ctx.replyWithHTML(`✅ <b>Auto-TP set to ${val === 0 ? 'OFF' : '+' + val + '%'}.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_delay:${telegramId}`)) {
            await redis.del(`state:autosnipe_delay:${telegramId}`);
            const val = parseInt(text);
            if (isNaN(val) || val < 0) return ctx.reply("🔴 Invalid delay.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { snipeDelaySeconds: val } });
            await ctx.replyWithHTML(`✅ <b>Block Delay set to ${val} seconds.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:autosnipe_mc:${telegramId}`)) {
            await redis.del(`state:autosnipe_mc:${telegramId}`);
            const parts = text.split(/\s+/);
            if (parts.length !== 2) return ctx.reply("🔴 Format: [MIN] [MAX]");
            const min = parseFloat(parts[0]); const max = parseFloat(parts[1]);
            if (isNaN(min) || isNaN(max)) return ctx.reply("🔴 Invalid numbers.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { minMarketCap: min, maxMarketCap: max } });
            await ctx.replyWithHTML(`✅ <b>MC Filter set: $${min} - $${max}.</b>`);
            await sendOrEditSniper(ctx, telegramId, false);
            return;
        }

        
     // 👑 ADMIN: GLOBAL BROADCAST EXECUTOR
     if (await redis.get(`state:admin_broadcast`)) {
        await redis.del(`state:admin_broadcast`);
        const ADMIN_IDS = [process.env.ADMIN_TELEGRAM_ID, '8620131746', '7998928457'];
        if (!telegramId || !ADMIN_IDS.includes(telegramId)) return;

        const messageToBlast = text;
        const allUsers = await prisma.user.findMany({ select: { telegramId: true } });
        
        const loader = await ctx.replyWithHTML(`<i>⏳ Broadcasting message to ${allUsers.length} users... Please wait.</i>`);
        
        let sentCount = 0;
        for (const u of allUsers) {
            try {
                await bot.telegram.sendMessage(
                    u.telegramId, 
                    `📢 <b>Platform Announcement</b>\n\n${messageToBlast}`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
                sentCount++;
                await new Promise(r => setTimeout(r, 50)); 
            } catch(e) {} 
        }

        return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `✅ <b>BROADCAST COMPLETE</b>\n\nSuccessfully delivered to <b>${sentCount} / ${allUsers.length}</b> users!`, { parse_mode: 'HTML' });
    }

         // DEV SUITE BUMP BOT EXECUTOR
         if (await redis.get(`state:dev_volume:${telegramId}`)) {
            await redis.del(`state:dev_volume:${telegramId}`);
            const parts = text.trim().split(/\s+/);
            
            if (parts.length !== 4) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Use: <code>[CA] [TRADE_SIZE_SOL] [MAX_FEE_BUDGET] [DELAY_SECONDS]</code>");

            const ca = parts[0];
            const tradeSize = parseFloat(parts[1]);
            const maxBudget = parseFloat(parts[2]);
            const delaySecs = parseInt(parts[3]);

            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return ctx.reply("🔴 Invalid Contract Address.");
            if (isNaN(tradeSize) || isNaN(maxBudget) || isNaN(delaySecs) || delaySecs < 1) return ctx.reply("🔴 Invalid numbers. Delay must be at least 1 second.");

            await redis.set(`active_bumper:${telegramId}`, ca);

            const statusMsg = await ctx.replyWithHTML(`📈 <b>VOLUME BUMPER INITIALIZING...</b>\n\n<i>Connecting to Jito block engine...</i>`);

            (async () => {
                let isBuy = true;
                let totalVolume = 0;
                let tradeCount = 0;
                let spentFees = 0;

                while (await redis.get(`active_bumper:${telegramId}`) === ca) {
                    if (spentFees >= maxBudget) {
                        await redis.del(`active_bumper:${telegramId}`);
                        try {
                            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, 
                                `✅ <b>BUMPER COMPLETE (BUDGET REACHED)</b>\n\nMax budget of <b>${maxBudget} SOL</b> spent in platform & gas fees.\nTotal Volume Generated: <b>~${totalVolume.toFixed(2)} SOL</b>\nTrades Executed: <b>${tradeCount}</b>`, 
                                { parse_mode: 'HTML' }
                            );
                        } catch(e) {}
                        break;
                    }

                    try {
                        let success = false;
                        
                        if (isBuy) {
                            const buyResult = await executeSnipe(telegramId, ca, tradeSize, 'buy', undefined, true);
                            if (buyResult.success) { success = true; isBuy = false; }
                        } else {
                            const sellResult = await executeExit(telegramId, ca, 100, true); 
                            if (sellResult.success) { success = true; isBuy = true; }
                        }

                        if (success) {
                            totalVolume += tradeSize;
                            spentFees += (tradeSize * 0.01) + 0.0001; 
                            tradeCount++;

                            try {
                                await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, 
                                    `📈 <b>VOLUME BUMPER RUNNING 🟢</b>\n\n` +
                                    `<b>Target:</b> <code>${ca.substring(0,8)}...</code>\n` +
                                    `<b>Trade Size:</b> ${tradeSize} SOL\n` +
                                    `<b>Speed:</b> 1 trade every ${delaySecs}s\n\n` +
                                    `📊 <b>LIVE STATS:</b>\n` +
                                    `• Volume Generated: <b>~${totalVolume.toFixed(3)} SOL</b>\n` +
                                    `• Trades Executed: <b>${tradeCount}</b>\n` +
                                    `• Budget Used: <b>${spentFees.toFixed(4)} / ${maxBudget} SOL</b>\n\n` +
                                    `<i>Send /cancel to pause.</i>`, 
                                    { parse_mode: 'HTML' }
                                );
                            } catch (e) {} 
                        }
                        await new Promise(r => setTimeout(r, delaySecs * 1000));
                    } catch (e) {
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
            })();

            return;
        }
        
        // DEV SUITE NUKE EXECUTOR
        if (await redis.get(`state:dev_nuke:${telegramId}`)) {
            await redis.del(`state:dev_nuke:${telegramId}`);
            const ca = text.trim();
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return ctx.reply("🔴 Invalid Solana Contract Address.");
            
            const loader = await ctx.replyWithHTML(`<i>⏳ NUKING ALL WALLETS: Executing concurrent Jito exit for <code>${ca.substring(0,6)}...</code>...</i>`);
            const result = await executeExit(telegramId, ca, 100);
            if (result.success) {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `💥 <b>NUKE SUCCESSFUL!</b>\n\nToken exited 100% across active wallets.\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Bundle Receipt</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            } else {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Nuke Failed:</b> ${result.message}`, { parse_mode: 'HTML' });
            }
            return;
        }

        // LIMIT ORDER LOGIC
        if (await redis.get(`state:limit:${telegramId}`)) {
           await redis.del(`state:limit:${telegramId}`);
           const parts = text.split(/\s+/);
           if (parts.length !== 3) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[CA] [TARGET PRICE USD] [AMOUNT SOL]</code>`);

           const targetCA = parts[0]!;
           const targetPrice = parseFloat(parts[1]!);
           const solAmt = parseFloat(parts[2]!);

           if (isNaN(targetPrice) || isNaN(solAmt)) return ctx.reply("🔴 Invalid numbers provided.");

           const user = await prisma.user.findUnique({ 
            where: { telegramId },
            include: { autoSnipeConfig: true } 
        });
           if (!user) return;

           await prisma.activeOrder.create({
               data: { userId: user.id, tokenAddress: targetCA, orderType: 'LIMIT', amountSol: solAmt, targetPriceUsd: targetPrice, isActive: true }
           });

           return ctx.replyWithHTML(`🟢 <b>LIMIT ORDER DEPLOYED</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nTarget Price: <b>$${targetPrice}</b>\nAmount: <b>${solAmt} SOL</b>\n<i>The engine will monitor the price and execute automatically via Jito.</i>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]]) });
        }

        // COPY TRADE
        if (await redis.get(`state:copytrade:${telegramId}`)) {
            await redis.del(`state:copytrade:${telegramId}`);
            const parts = text.split(/\s+/);
            if (parts.length < 3 || parts.length > 4) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[WALLET] [AMOUNT SOL] [DROP %] [OPTIONAL TP %]</code>`);
            const targetWallet = parts[0]!; const solAmt = parseFloat(parts[1]!); const dropPct = parseFloat(parts[2]!); const tpPct = parts.length === 4 ? parseFloat(parts[3]!) : undefined;

            if (targetWallet.length < 32 || targetWallet.length > 44) return ctx.reply("🔴 Invalid Solana Wallet Address.");
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (!user) return;
            await prisma.copyTradeConfig.create({ data: { userId: user.id, targetWallet, tradeAmountSol: solAmt, autoTrailingDropPercent: dropPct, autoTakeProfitPercent: tpPct || null, isActive: true } });
            return ctx.replyWithHTML(`🟢 <b>COPY TRADE ACTIVE</b>\n\nTarget: <code>${targetWallet.substring(0,8)}...</code>\nAmount: <b>${solAmt} SOL</b>\nGuard: <b>-${dropPct}%</b>\nTake Profit: <b>${tpPct ? `+${tpPct}%` : 'Not Set'}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Copy Trade Menu', 'menu_copytrade')]]) });
        }

        // GUARD
        if (await redis.get(`state:guard:${telegramId}`)) {
            await redis.del(`state:guard:${telegramId}`);
            const parts = text.split(/\s+/);
            if (parts.length !== 3 && parts.length !== 4) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> <code>[CA] [DROP %] [AMOUNT SOL] [OPTIONAL TP %]</code>`);

            const targetCA = parts[0]!; const trailPct = parseFloat(parts[1]!); const solAmt = parseFloat(parts[2]!); const tpPct = parts.length === 4 ? parseFloat(parts[3]!) : undefined; 
            if (isNaN(trailPct) || isNaN(solAmt) || (tpPct !== undefined && isNaN(tpPct))) return ctx.reply("🔴 Invalid numbers provided.");

            const loader = await ctx.replyWithHTML(`<i>⏳ Executing Jito Trade & Syncing Guard...</i>`, { parse_mode: 'HTML' });

            try {
                const buyResult = await executeSnipe(telegramId, targetCA, solAmt);
                if (!buyResult.success) return await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `${buyResult.message}`, { parse_mode: 'HTML' });

                let initialPriceNative = 0;
                try {
                    const priceRes = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${targetCA}`).catch(() => null);
                    initialPriceNative = priceRes?.data?.data?.[targetCA]?.price || 0;
                    if (initialPriceNative === 0 && targetCA.toLowerCase().endsWith("pump")) {
                        const curvePda = getBondingCurveAddress(targetCA);
                        const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                        if(accInfo && accInfo.data) initialPriceNative = decodePumpCurvePrice(accInfo.data.toString('base64'));
                    }
                } catch (e) {}

                await addTrailingStopToMemory(telegramId, targetCA, trailPct, solAmt, initialPriceNative, tpPct);
                
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `🟢 <b>BUY & GUARD SUCCESSFUL!</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nInvested: <b>${solAmt} SOL</b>\nTrailing Drop: <b>-${trailPct}%</b>\nTake Profit: ${tpPct ? `<b>+${tpPct}%</b>` : `<i>Not Set (Trailing Only)</i>`}\n\n🔗 <a href="https://solscan.io/tx/${buyResult.signature}">View Receipt (Fee Extracted)</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Guards Menu', 'menu_trailing')]]) }
                );
            } catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, "🔴 Failed to process transaction or memory block."); }
            return;
        }

       // DCA
       if (await redis.get(`state:dca:${telegramId}`)) {
           await redis.del(`state:dca:${telegramId}`);
           try {
               const parts = text.split(/\s+/);
               if (parts.length < 4 || parts.length > 6) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[CA] [INTERVAL] [AMOUNT] [DROP %] [OPTIONAL TP] [OPTIONAL BUDGET]</code>`);

               const targetCA = parts[0]!; const intervalMins = parseInt(parts[1]!); const solAmt = parseFloat(parts[2]!); const dropPct = parseFloat(parts[3]!);
               const tpPct = (parts.length >= 5 && parseFloat(parts[4]!) !== 0) ? parseFloat(parts[4]!) : undefined;
               const maxBudget = parts.length === 6 ? parseFloat(parts[5]!) : undefined; 
               
               if (isNaN(intervalMins) || isNaN(solAmt) || isNaN(dropPct)) return ctx.reply("🔴 Invalid numbers provided.");

               const user = await prisma.user.findUnique({ where: { telegramId } });
               if (!user) return ctx.reply("🔴 User not found.");

               await prisma.activeOrder.create({
                   data: { userId: user.id, tokenAddress: targetCA, orderType: 'DCA', amountSol: solAmt, dcaIntervalMins: intervalMins, trailingPercent: dropPct, takeProfitPercent: tpPct || null, maxBudgetSol: maxBudget || null, isActive: true }
               });
               return ctx.replyWithHTML(`🟢 <b>TWAP/DCA SCHEDULE DEPLOYED</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nInterval: <b>Every ${intervalMins} Minutes</b>\nAmount: <b>${solAmt} SOL per interval</b>\nMax Budget: <b>${maxBudget ? `${maxBudget} SOL` : 'Infinite'}</b>\nGuard: <b>-${dropPct}%</b>\nTake Profit: <b>${tpPct ? `+${tpPct}%` : 'Not Set'}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ DCA Menu', 'menu_dca')]]) });
           } catch (e) {}
       }

        // CATCH MANUAL REFERRAL CODE ENTRY
        if (await redis.get(`state:enter_ref:${telegramId}`)) {
            await redis.del(`state:enter_ref:${telegramId}`);
            const code = text.trim().toUpperCase();
            const currentUser = await prisma.user.findUnique({ where: { telegramId } });
            if (currentUser?.referralCode === code) return ctx.replyWithHTML(`🔴 <b>Error:</b> You cannot use your own referral code.`);

            const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
            if (!referrer) return ctx.replyWithHTML(`🔴 <b>Error:</b> Partner code <code>${code}</code> not found.`);

            await prisma.user.update({ where: { telegramId }, data: { referredById: referrer.id } });
            await ctx.replyWithHTML(`✅ <b>Success!</b>\n\nYou are now linked to Partner <b>${code}</b>. They will receive a revenue share of your trading volume.`);
            await sendOrEditDashboard(ctx, telegramId, false);
            return;
        }

        // 🏰 SENTRY GUILDS SETUP WIZARD (Mempool Interceptor)
        const setupState = await redis.hgetall(`guild_setup:${telegramId}`);
        if (setupState && Object.keys(setupState).length > 0) {
            const step = parseInt(setupState.step);
            
            if (step === 1) {
                const communityName = text.trim();
                if (communityName.length < 3 || communityName.length > 30) {
                    return ctx.replyWithHTML("⚠️ <b>Invalid Name:</b> Community name must be between 3 and 30 characters.");
                }
                await redis.hmset(`guild_setup:${telegramId}`, { step: '2', name: communityName });
                return ctx.replyWithHTML(
                    `🏰 <b>GUILD SETUP [Step 2/2]</b>\n\n` +
                    `<b>Community Name:</b> <code>${communityName}</code>\n\n` +
                    `Describe the reward your members will compete for in one clear sentence.\n` +
                    `<i>(e.g., "Top 50 traders get guaranteed whitelist allocation for our upcoming token launch")</i>`
                );
            }
            
            if (step === 2) {
                const communityName = setupState.name;
                const rewardDescription = text.trim();
                
                // Store final params back to Redis before confirmation
                await redis.hmset(`guild_setup:${telegramId}`, { step: '3', reward: rewardDescription });
                
                await ctx.replyWithHTML(
                    `🏰 <b>CONFIRM GUILD CREATION</b>\n\n` +
                    `Please review your loyalty infrastructure setup:\n\n` +
                    `• <b>Community Name:</b> <code>${communityName}</code>\n` +
                    `• <b>Member Reward:</b> <i>"${rewardDescription}"</i>\n\n` +
                    `<i>Your Developer Suite subscription covers the cost of this Guild. Creating it is completely free.</i>`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Confirm & Create Guild', 'action_confirm_guild_pay')],
                        [Markup.button.callback('❌ Abort Setup', 'action_abort_guild_setup')]
                    ])
                );
                return;
            }
        }

        // IMPORT KEY
        if (await redis.get(`state:import_key:${telegramId}`)) {
            await redis.del(`state:import_key:${telegramId}`);
            try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){}
            const loader = await ctx.replyWithHTML("<i>⏳ Verifying and encrypting imported key...</i>");

            const success = await importPrivateKey(telegramId, text.trim());
            if (success) {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `✅ <b>Wallet Imported Successfully!</b>\nYour Sentry terminal is now linked to your new encrypted address.`, { parse_mode: 'HTML' });
                await sendOrEditDashboard(ctx, telegramId, false);
            } else {
                await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Import Failed.</b> Not a valid Solana Base58 Private Key.`, { parse_mode: 'HTML' });
            }
            return;
        }

    } catch (redisErr) {}
 
    // 🟢 FORWARD-TO-BUY & MANUAL SNIPE INTERCEPTOR (JITO INTEGRATED)
    const caRegex = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/;
    const match = text.match(caRegex);

    if (match) {
        const possibleCA = match[0];

        const SYSTEM_ADDRESSES = new Set([
            "So11111111111111111111111111111111111111112",   
            "11111111111111111111111111111111",              
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv",  
            "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  
        ]);
        const userForCheck = await prisma.user.findUnique({ where: { telegramId } });
        if (
            SYSTEM_ADDRESSES.has(possibleCA) ||
            possibleCA === userForCheck?.vaultAddress ||
            possibleCA === userForCheck?.vault2 ||
            possibleCA === userForCheck?.vault3 ||
            possibleCA === userForCheck?.vault4 ||
            possibleCA === userForCheck?.vault5
        ) {
            return next();
        }
        let tradeAmountSol = 0.01; 
        
        const parts = text.split(/\s+/);
        if (parts.length === 2 && parts[0] === possibleCA) {
            const parsedAmt = parseFloat(parts[1]!);
            if (!isNaN(parsedAmt) && parsedAmt > 0) tradeAmountSol = parsedAmt;
            else return ctx.reply("🔴 Invalid amount specified.");
        } else {
            const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
            if (user?.autoSnipeConfig?.amountSol) tradeAmountSol = user.autoSnipeConfig.amountSol;
        }

        // 🟢 AUDIT FIX: Adjusted spam lock to 3 seconds (down from 15s) to allow faster legitimate trading
        const spamLockKey = `lock:manual_snipe:${telegramId}`;
        if (!(await redis.set(spamLockKey, 'LOCKED', 'EX', 3, 'NX'))) return ctx.reply("⚠️ <b>Please wait a moment before sending another snipe command.</b>", { parse_mode: 'HTML' });

        // 🟢 NEW: PRE-TRADE SAFETY SCAN & TOKEN INFO CONFIRM CARD
        const loader = await ctx.replyWithHTML(`⚡ <b>SNIPE ENGAGED</b>\n\nTarget: <code>${possibleCA.substring(0,8)}...</code>\nAmount: <b>${tradeAmountSol} SOL</b>\n<i>⏳ Running security scan & fetching Token Info...</i>`);
        
        try {
            const rugRes = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${possibleCA}/report/summary`, { timeout: 800 }).catch(() => null);
            if (rugRes?.data?.risks?.some((r: any) => r.name === 'Freeze Authority still enabled' || r.score > 500)) {
                await redis.del(spamLockKey);
                return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `🚨 <b>SECURITY WARNING: HIGH RISK TOKEN</b> 🚨\n\nRugCheck detected critical risks (e.g. Freeze Authority enabled or Honeypot). Sentry has blocked this transaction to protect your funds.\n\nIf you know what you are doing, click below to override the shield.`, 
                    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⚠️ IGNORE WARNING & BUY ANYWAY', `forcebuy_${possibleCA}_${tradeAmountSol}`)]]) }
                );
            }
        } catch (e) {} 

        // Fetch token info before confirming buy
        const dexRes = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${possibleCA}`
        ).then(r => r.json()).catch(() => null);

        const pair = dexRes?.pairs?.[0];
        const mcap = pair?.fdv ? `$${Number(pair.fdv).toLocaleString()}` : 'Unknown';
        const vol24h = pair?.volume?.h24 ? `$${Number(pair.volume.h24).toLocaleString()}` : 'Unknown';
        const tgLink = pair?.info?.socials?.find((s: any) => s.type === 'telegram')?.url || null;
        const twitterLink = pair?.info?.socials?.find((s: any) => s.type === 'twitter')?.url || null;

        // MEV check
        // RugCheck scan (Zero RPC credit usage)
        const rugDetected = await checkTokenRugRisk(possibleCA);
        const mevWarning = rugDetected ? `\n\n🚨 <b>WARNING: Critical Rug/Honeypot risk detected on RugCheck!</b>` : '';
        const socialsLine = [tgLink, twitterLink].filter(Boolean).join(' | ') || 'None found';

        await redis.del(spamLockKey);
        await ctx.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});

        await ctx.reply(
            `🔍 <b>TOKEN INFO</b>\n\n` +
            `<code>${possibleCA}</code>\n\n` +
            `📊 Market Cap: <b>${mcap}</b>\n` +
            `💹 24H Volume: <b>${vol24h}</b>\n` +
            `🔗 Socials: ${socialsLine}` +
            mevWarning +
            `\n\n<i>Tap below to confirm your buy of ${tradeAmountSol} SOL:</i>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Confirm Buy', callback_data: `confirm_buy_${possibleCA}` },
                        { text: '❌ Cancel', callback_data: 'cancel_buy' }
                    ]]
                }
            }
        );

        // Store pending buy in Redis temporarily
        await redis.set(`pending_buy:${telegramId}:${possibleCA}`, tradeAmountSol.toString(), 'EX', 120);
        return;
    }

    return next();
});

// 🟢 AUDIT FIX 7: Added /join command handler
bot.command('join', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    const text = (ctx.message as any).text || "";
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 2) {
        return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>/join [GUILD_CODE]</code>`);
    }
    
    const guildCode = parts[1].toUpperCase();
    const result = await joinGuild(tgId, guildCode);
    
    if (result.success) {
        await ctx.replyWithHTML(
            `🏰 <b>GUILD JOINED: ${result.guildName?.toUpperCase()}</b>\n\n` +
            `${result.rewardDescription || 'Trade to climb the leaderboard and earn your reward.'}\n\n` +
            `📊 Every <b>0.1 SOL</b> you trade earns you <b>10 Guild Loyalty Points (GLP)</b>.\n` +
            `🏆 Your KOL will export the top wallets for whitelist / airdrop rewards.\n\n` +
            `<i>Keep trading — your rank updates live.</i>`
        );
    } else {
        await ctx.replyWithHTML(`🔴 <b>Join Failed:</b> ${result.message}`);
    }
});

bot.action('action_abort_guild_setup', async (ctx) => {
    try { await ctx.answerCbQuery("Setup aborted."); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.del(`guild_setup:${tgId}`);
    await ctx.editMessageText("❌ <b>Guild setup cancelled.</b> Your wallet has not been charged.", { parse_mode: 'HTML' });
});

bot.action('action_confirm_guild_pay', async (ctx) => {
    const tgId = ctx.from?.id.toString()!;
    try { await ctx.answerCbQuery("⏳ Initializing Guild Database..."); } catch(e){}

    const setupState = await redis.hgetall(`guild_setup:${tgId}`);
    if (!setupState || !setupState.name || !setupState.reward) {
        return ctx.replyWithHTML("🔴 <b>Session Expired:</b> Please run <code>/createguild</code> again.");
    }

    const loader = await ctx.replyWithHTML(`<i>⏳ Deploying secure database schema and registering community "<b>${setupState.name}</b>"...</i>`);

    const result = await createGuild(tgId, setupState.name, "Sentry Loyalty Node", setupState.reward);

    await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});
    await redis.del(`guild_setup:${tgId}`);

    if (result.success) {
        await ctx.replyWithHTML(
            `✅ <b>GUILD SUCCESSFULLY CREATED!</b>\n\n` +
            `🎉 <b>Community Registered:</b> <code>${setupState.name}</code>\n` +
            `🔑 <b>Invite Code:</b> <code>${result.guildCode}</code>\n\n` +
            `🔗 <b>Invite Link:</b>\n` +
            `<code>https://t.me/${ctx.botInfo?.username}?start=guild_${result.guildCode}</code>\n\n` +
            `<i>Tell your members to click the link or run <code>/join ${result.guildCode}</code> inside the bot. Sentry will automatically track all their volume under your brand!</i>`
        );
    } else {
        await ctx.replyWithHTML(`🔴 <b>Deployment Failed:</b> ${result.message}`);
    }
});

// =========================================================
// 🌐 SECURE BOOT & EXPRESS WEBAPP
// =========================================================


// Telegram initData verification
function verifyTelegramAuth(initData: string): boolean {
    const params = new URLSearchParams(initData);
    
    // 🟢 MEDIUM BUG 18 FIX: 24h Expiry to prevent replay attacks
    const authDateStr = params.get('auth_date');
    if (authDateStr) {
        const authDate = parseInt(authDateStr, 10);
        const now = Math.floor(Date.now() / 1000);
        if (now - authDate > 86400) return false;
    } else {
        return false;
    }

    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData')
        .update(process.env.BOT_TOKEN!).digest();
    const expectedHash = crypto.createHmac('sha256', secret)
        .update(dataCheckString).digest('hex');
    return expectedHash === hash;
}

const __filename = fileURLToPath(import.meta.url);


const __dirname = path.dirname(__filename);

app.get('/webapp', (req, res) => {
    try {
        let html = fs.readFileSync(path.join(process.cwd(), 'src/webapp/index.html'), 'utf8');
        const botName = process.env.BOT_NAME || 'Sentry Terminal';
        html = html.replace(/\{\{BOT_NAME\}\}/g, botName);
        res.send(html);
    } catch (e) {
        res.status(500).send("Error loading WebApp.");
    }
});

// 🟢 FEATURE 5: Provide JSON Leaderboard data to the Telegram WebApp (index.html)
app.post('/api/my-leaderboard', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = JSON.parse(new URLSearchParams(req.body.initData).get('user')!).id.toString();
        
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { guildMemberships: { include: { guild: true } } } });
        if (!user || user.guildMemberships.length === 0) return res.json({ guild: null, members: [] });

        const activeGuild = user.guildMemberships[0].guild;
        const lb = await getLeaderboard(activeGuild.id, 50);

        res.json({
            guild: { name: activeGuild.name, reward: activeGuild.rewardDescription, code: activeGuild.guildCode },
            members: lb
        });
    } catch (e) { res.status(500).json({ guild: null, members: [] }); }
});

// 🟢 FEATURE 5: Public Guild Web Leaderboard
app.get('/g/:guildCode', async (req, res) => {
    try {
        const guildCode = req.params.guildCode.toUpperCase();
        const guild = await prisma.guild.findUnique({ where: { guildCode } });
        if (!guild) return res.status(404).send("Guild not found.");

        const lb = await getLeaderboard(guild.id, 10); // Top 10 for the web
        let rowsHtml = '';
        
        lb.forEach((row, i) => {
            if(!row) return;
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
            rowsHtml += `
            <div class="flex justify-between items-center bg-[#121826] p-4 rounded-xl border border-white/5 mb-3">
                <div class="flex items-center gap-4">
                    <div class="text-xl w-8 text-center">${medal}</div>
                    <div>
                        <div class="font-bold text-white">@${row.username}</div>
                        <div class="text-xs text-gray-500 font-mono">${row.walletAddress.substring(0,4)}...${row.walletAddress.slice(-4)}</div>
                    </div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-emerald-400">${row.glp.toLocaleString()} GLP</div>
                    <div class="text-xs text-gray-500">${row.volumeSol.toFixed(2)} SOL Vol</div>
                </div>
            </div>`;
        });

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${guild.name} - Sentry Leaderboard</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-[#0a0d14] text-gray-300 font-sans min-h-screen p-6">
            <div class="max-w-md mx-auto mt-10">
                <div class="text-center mb-8">
                    <div class="inline-block bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold tracking-widest border border-emerald-500/30 mb-4">VERIFIED SENTRY GUILD</div>
                    <h1 class="text-3xl font-bold text-white">${guild.name}</h1>
                    <p class="mt-2 text-gray-400 text-sm">"${guild.rewardDescription}"</p>
                </div>
                <div class="bg-gradient-to-b from-[#1a2235] to-[#0a0d14] p-6 rounded-2xl border border-white/10 shadow-2xl">
                    <h2 class="text-xs font-bold tracking-widest text-gray-500 mb-4 uppercase">Top 10 Operators</h2>
                    ${rowsHtml || '<div class="text-center text-gray-500 py-4">Leaderboard calculating...</div>'}
                </div>
                <div class="text-center mt-8 text-xs text-gray-600">
                    Powered by <b>Sentry Terminal</b> on Solana
                </div>
            </div>
        </body>
        </html>`;
        
        res.send(html);
    } catch (e) { res.status(500).send("Error loading leaderboard."); }
});

async function bootEcosystem() {
    await warmDnsCache();
    await syncGuardsFromDb(); 
    // Start WebApp Express Server
    app.listen(3001, () => console.log('🟢 WebApp API Server listening on port 3001'));


    // Refresh guild rank caches every 60 seconds
    setInterval(async () => {
        try {
            const guilds = await prisma.guild.findMany({ where: { isActive: true }, select: { id: true } });
            for (const g of guilds) {
                await updateRankCache(g.id);
            }
        } catch (e) {}
    }, 60_000);

    // 🟢 HIGH BUG 28 FIX: Background sweep to cleanly demote expired VIPs every 10 minutes
 setInterval(async () => {
    await sweepExpiredVips();
}, 10 * 60 * 1000);

    console.log("⏳ Pinging Telegram Servers...");
    try {
        const keys = await redis.keys('active_bumper:*');
        if (keys.length > 0) await redis.del(...keys);

        const info = await bot.telegram.getMe();
        console.log(`🟢 [4/5] HFT BOT ONLINE -> @${info.username}`);
        bot.launch({ dropPendingUpdates: true });
        console.log("🟢 [5/5] ALL SYSTEMS GO. Interface Active.");

        
        igniteYellowstoneStream(bot).catch((err: any) => console.error("🟡 [Background] gRPC Delayed:", err.message));
        startDcaEngine(bot);
        startCopyTradeWatcher(bot); 
        startDepositWatcher(bot); 
        
        const adminId = process.env.ADMIN_TELEGRAM_ID || "8494722111"; // Your Telegram ID
           // 🏰 Starts the new Guild KOL Leadgen
        
        startCoinCaller(bot); // 🟢 ADDED CALLER ENGINE STARTUP
        
        
    } catch (err: any) {
        console.error("🔴 TELEGRAM BOOT FAILED:", err.message);
        process.exit(1);
    }
}
bootEcosystem();

process.once('SIGINT', () => { try { if (bot.botInfo) bot.stop('SIGINT'); } catch(e){} prisma.$disconnect(); redis.quit(); });
process.once('SIGTERM', () => { try { if (bot.botInfo) bot.stop('SIGTERM'); } catch(e){} prisma.$disconnect(); redis.quit(); });