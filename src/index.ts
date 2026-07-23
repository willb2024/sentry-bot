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
import FormData from 'form-data';
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
import cron from 'node-cron';
import { sendWeeklyReportsToAll, computeWeeklyStats, formatWeeklyReport } from './services/weekly_report.service.js';
import { VIP_TIERS, VipTierKey, checkVipStatus, grantVip, verifyVipPayment, getPlatformFeeRate, formatVipStatus } from './services/vip.service.js';
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
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',');

if (!BOT_TOKEN) { console.error("🔴 FATAL: BOT_TOKEN is missing in .env!"); process.exit(1); }
if (!process.env.TREASURY_WALLET_ADDRESS) { console.error("🔴 FATAL: TREASURY_WALLET_ADDRESS is missing in .env! All trades will run fee-free."); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);


// Add this helper function near the top of index.ts
function isAdmin(tgId: string | undefined): boolean {
    if (!tgId) return false;
    const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',').filter(Boolean);
    return ADMIN_IDS.includes(tgId);
}

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


export function maskAddress(address: string | null | undefined, hidden: boolean): string {
    if (!address) return "None";
    if (hidden && address.length > 8) return `${address.substring(0, 4)}...${address.slice(-4)}`;
    return address;
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

// 🟢 ADD THIS HELPER FUNCTION
function extractTelegramId(initData: string): string | null {
    try {
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) {
            const user = JSON.parse(userStr);
            return user.id ? user.id.toString() : null;
        }
    } catch (e) {
        return null;
    }
    return null;
}

function maskWallet(address: string | null | undefined, hide: boolean): string {
    if (!address) return "None";
    if (hide) return `${address.substring(0, 4)}••••••••••••••••••••••••••••${address.slice(-4)}`;
    return address;
}

// 🟢 NEW: Global Currency Converter (Allows buying in $USD or SOL)
function parseSolAmount(input: string, allowZero = false): number | null {
    if (input === undefined || input === null) return null;
    const trimmed = input.trim().replace(/,/g, ''); 
    
    if (trimmed === '0' && allowZero) return 0;

    if (trimmed.startsWith('$')) {
        const usdVal = parseFloat(trimmed.substring(1));
        if (isNaN(usdVal) || (!allowZero && usdVal <= 0)) return null;
        if (!cachedSolUsdPrice || cachedSolUsdPrice <= 0) return null; // Failsafe
        return parseFloat((usdVal / cachedSolUsdPrice).toFixed(4));
    }
    
    const solVal = parseFloat(trimmed);
    if (isNaN(solVal) || (!allowZero && solVal <= 0)) return null;
    return solVal;
}

app.post('/api/analytics', async (req, res) => {
    const initData = req.body.initData;
    if (!initData) return res.status(401).json({ error: "No initData" });
    const tgId = extractTelegramId(initData);
    if (!tgId) return res.status(401).json({ error: "Invalid initData" });

    try {
        const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (!user) return res.json([]);

        const trades = await prisma.trade.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 100
        });

        const mappedTrades = trades.map((t: any) => ({
            createdAt: t.createdAt,
            isBuy: t.isBuy,
            amountInSol: t.amountInSol,
            // 🟢 FIX: Send actual realized data instead of hardcoded 0
            profitPercent: t.profitPercent || 0,
            realizedPnlSol: t.realizedPnlSol || 0
        }));
        
        res.json(mappedTrades);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// 🟢 GAP 2 FIX: Serves the raw binary PNG of the PnL card from Redis cache
app.get('/pnl-img/:imgId', async (req, res) => {
    try {
        const imgId = req.params.imgId;
        const base64 = await redis.get(`pnl_img:${imgId}`);
        if (!base64) return res.status(404).send("Not found");
        
        const buffer = Buffer.from(base64, 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buffer.length
        });
        res.end(buffer);
    } catch (e) {
        res.status(500).send("Error serving image");
    }
});

// 🟢 GAP 2 FIX: Serves a dynamic OpenGraph meta-tag index page that automatically
// unfurls in X/Twitter, then instantly redirects visitors to Sentry Terminal on TG
app.get('/share/:imgId', async (req, res) => {
    try {
        const imgId = req.params.imgId;
        const botName = process.env.BOT_NAME || 'Sentry Terminal';
        const botUsername = process.env.BOT_USERNAME || 'SentryTerminalBot';
        
        // Appends the referral code to the redirection string to map recruits seamlessly
        const referralCode = req.query.ref ? `?start=${req.query.ref}` : '';
        const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="twitter:card" content="summary_large_image">
            <meta name="twitter:title" content="${botName} — Trade Executed Successfully">
            <meta name="twitter:description" content="Secured block execution using zero-latency Jito bundle protection.">
            <meta name="twitter:image" content="${hostUrl}/pnl-img/${imgId}">
            <meta property="og:title" content="${botName} — Trade Executed Successfully">
            <meta property="og:description" content="Secured block execution using zero-latency Jito bundle protection.">
            <meta property="og:image" content="${hostUrl}/pnl-img/${imgId}">
            <meta property="og:type" content="website">
            <title>${botName}</title>
            <script>
                setTimeout(() => {
                    window.location.href = "https://t.me/${botUsername}${referralCode}";
                }, 100);
            </script>
        </head>
        <body style="background:#0a0d14; color:#fff; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh;">
            <div style="text-align:center;">
                <p>Redirecting to Sentry Terminal on Telegram...</p>
            </div>
        </body>
        </html>`;
        
        res.send(html);
    } catch (e) {
        res.status(500).send("Error generating share page");
    }
});

// 🎮 SIMULATION INTERCEPT: Fetch simulated trades for Flow Analytics
app.post('/api/sim-trades', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData))
            return res.status(403).json({ error: 'Unauthorized' });

        const telegramId = JSON.parse(
            new URLSearchParams(req.body.initData).get('user')!
        ).id.toString();

        // Strict security: Only the admin can access simulated trades
        if (telegramId !== process.env.ADMIN_TELEGRAM_ID)
            return res.status(403).json({ error: 'Admin only' });

        const { isSimulationActive } = await import('./services/simulation.service.js');
        if (!await isSimulationActive(telegramId))
            return res.json([]);

        const raw = await redis.get(`sim:trades:${telegramId}`);
        const trades = raw ? JSON.parse(raw) : [];
        res.json(trades);
    } catch (e: any) {
        res.status(500).json([]);
    }
});

// 🎮 SIMULATION INTERCEPT: Fetch simulated balance, volume, positions, and win/loss rates
// 🎮 SIMULATION INTERCEPT: Fetch simulated balance, volume, positions, and win/loss rates
app.post('/api/sim-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = JSON.parse(new URLSearchParams(req.body.initData).get('user')!).id.toString();
        if (telegramId !== process.env.ADMIN_TELEGRAM_ID) return res.status(403).json({ error: 'Admin only' });

        const { isSimulationActive, getSimBalance, getSimVolume, getSimStartingBalance } = await import('./services/simulation.service.js');
        if (!await isSimulationActive(telegramId)) return res.json({ isActive: false });

        const balance = await getSimBalance(telegramId);
        const startingBalance = await getSimStartingBalance(telegramId); // 🟢 NEW
        const volume = await getSimVolume(telegramId);
        const posRaw = await redis.get(`sim:positions:${telegramId}`);
        const positions = posRaw ? JSON.parse(posRaw) : [];
        const tradesRaw = await redis.get(`sim:trades:${telegramId}`);
        const trades = tradesRaw ? JSON.parse(tradesRaw) : [];

        let wins = 0, losses = 0;
        trades.filter((t: any) => !t.isBuy).forEach((t: any) => {
            if (t.profitPercent > 0) wins++; else losses++;
        });

        res.json({
            isActive: true, balance: parseFloat(balance), startingBalance, // 🟢 NEW
            volume, positions, trades, wins, losses,
            winRate: (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : "0.0"
        });
    } catch (e: any) { res.status(500).json({ isActive: false }); }
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
    const { getSimBalance } = await import('./services/simulation.service.js');
    if (await isSimulationActive(user.telegramId)) {
        return await getSimBalance(user.telegramId);
    }
    
    if (!user || !user.vaultAddress) return "0.0000";
    try {
        const cacheKey = `balance_cache:${user.telegramId}`;
        const cachedBalance = await redis.get(cacheKey);
        if (cachedBalance) return parseFloat(cachedBalance).toFixed(4);

        const pubkeys: PublicKey[] = [];
        if (user.vaultAddress) pubkeys.push(new PublicKey(user.vaultAddress));
        if (user.activeWallets >= 2 && user.vault2) pubkeys.push(new PublicKey(user.vault2));
        if (user.activeWallets >= 3 && user.vault3) pubkeys.push(new PublicKey(user.vault3));
        if (user.activeWallets >= 4 && user.vault4) pubkeys.push(new PublicKey(user.vault4));
        if (user.activeWallets >= 5 && user.vault5) pubkeys.push(new PublicKey(user.vault5));

        // 🟢 FIX: Batch the RPC request into a single call instead of 5 concurrent calls
        let totalLamports = 0;
        try {
            const accounts = await connection.getMultipleAccountsInfo(pubkeys);
            accounts.forEach(acc => {
                if (acc) totalLamports += acc.lamports;
            });
        } catch (rpcErr) {
            return "0.0000"; // Fail gracefully if RPC times out
        }

        const finalBalance = (totalLamports / LAMPORTS_PER_SOL).toFixed(4);
        await redis.set(cacheKey, finalBalance, 'EX', 15);
        
        return finalBalance;
    } catch (e) { return "0.0000"; }
}


// =========================================================
// 📟 DASHBOARD MENU SYSTEM (CLEAN & AESTHETIC STYLE)
// =========================================================
async function sendOrEditDashboard(ctx: any, telegramId: string, isEdit: boolean = false) {
    const userPromise = prisma.user.findUnique({ 
        where: { telegramId }, include: { _count: { select: { recruits: true } } } 
    });
    
    const [user, vipStatus, isSimMode] = await Promise.all([
        userPromise, getVipStatus(telegramId), import('./services/simulation.service.js').then(m => m.isSimulationActive(telegramId))
    ]);
    if (!user) return; 

    const [liveBalance, userGuilds, newVipStatus] = await Promise.all([
        getLiveBalance(user), prisma.guildMembership.findMany({ where: { userId: user.id, isActive: true }, include: { guild: true } }), checkVipStatus(user.telegramId)
    ]);

    // 🟢 CLAUDE FIX 3: Check hide wallets setting
    const hideWallets = await redis.get(`user_settings:hide_wallets:${telegramId}`) === 'true';

    const whaleModeText = user.activeWallets > 1 ? `🐙 <b>WHALE MODE:</b> 🟢 ACTIVE (Firing ${user.activeWallets} Wallets)` : `⚙️ <b>Active Wallets:</b> 1 / 5 (Standard Mode)`;

    const { getSimVolume } = await import('./services/simulation.service.js');
    let displayVolume = user.totalVolumeSol;
    if (isSimMode) displayVolume += await getSimVolume(telegramId);

    const basePoints = Math.floor(displayVolume * 10000);
    const welcomeBonus = user.referredById ? 10000 : 0;
    const recruitBonus = user._count.recruits * 2000;
    const sentryPoints = (basePoints + welcomeBonus + recruitBonus).toLocaleString();

    const welcomeText = user.referredById ? `\n• Partner Bonus: <b>+10,000 PTS</b>` : ``;
    const recruitText = user._count.recruits > 0 ? `\n• Network Bonus: <b>+${recruitBonus.toLocaleString()} PTS</b> <i>(${user._count.recruits} Recruits)</i>` : ``;

    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    
    let guildDisplay = `🏰 <b>Active Guild:</b> <i>None</i>\n`;
    if (userGuilds.length > 0) {
        const primaryGuild = userGuilds[0];
        const rankDisplay = primaryGuild.rank ? `#${primaryGuild.rank}` : `Unranked`;
        guildDisplay = `🏰 <b>Guild:</b> <b>${primaryGuild.guild.name}</b>\n🏆 <b>Your Rank:</b> <b>${rankDisplay}</b> (${primaryGuild.loyaltyPoints.toLocaleString()} GLP)\n`;
    }

    const balanceNum = parseFloat(liveBalance) || 0;
    const usdValue = balanceNum * cachedSolUsdPrice;
    const usdBalanceFormatted = usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const layoutTxt = 
        `⚡ <b>${botName.toUpperCase()}</b> ⚡\n\n` +
        
        `👛 <b>Primary Deposit Node:</b>\n` +
        `<code>${maskAddress(user.vaultAddress, hideWallets)}</code>\n\n` +
        
        `💰 <b>Total Balance:</b> <code>${liveBalance} SOL ($${usdBalanceFormatted})</code>\n` +
        `└ ${whaleModeText}\n\n` +
        
        `🪂 <b>$SENTRY Airdrop (Epoch 1):</b>\n` +
        `${guildDisplay}` + 
        `• Your Points: <b>${sentryPoints} PTS</b> <i>(1 SOL = 10k PTS)</i>${welcomeText}${recruitText}\n\n` +  
        
        `📊 <b>Your Economics:</b>\n` +
        `• Protocol Fee: <b>${process.env.PLATFORM_FEE_PERCENT || '1.00'}%</b>\n` +
        `• Affiliate Yield: <b>${user.pendingRewardsSol.toFixed(4)} SOL</b>\n\n` +
        
        `<i>Forward a call, paste a Token CA, or select a module below.\n(All inputs accept SOL or $USD).</i>`;

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Sniper Module', 'menu_sniper'), Markup.button.callback('🎯 AI Coin Caller', 'menu_caller')],
        [Markup.button.callback('⏳ Limit / DCA Engine', 'menu_dca'), Markup.button.callback('🛡️ Trailing Stops', 'menu_trailing')],
        [Markup.button.callback('💼 Positions', 'menu_positions'), Markup.button.callback('👥 Copy Trade', 'menu_copytrade')],
        [Markup.button.callback('💰 Affiliates', 'menu_affiliate'), Markup.button.callback('🔑 Vault & Keys', 'menu_vault')],
        [Markup.button.callback('🏰 Sentry Guilds', 'action_guild_menu'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
        [Markup.button.callback('📤 Withdraw', 'btn_withdraw_prompt'), Markup.button.callback('📖 How to Trade', 'btn_trade_guide')],
        [Markup.button.callback('🚀 Launch Token', 'menu_token_launcher'), Markup.button.callback('🛑 Cancel All Automations', 'action_global_cancel')],
        [{ text: '📊 Track Trades', web_app: { url: process.env.WEBAPP_URL || 'https://your-webapp-url.com/webapp' } }]
    ]);

    if (isEdit) await safeEditMessageText(ctx, layoutTxt, UI);
    else await ctx.replyWithHTML(layoutTxt, UI);
}


// =========================================================
// 🚀 THE SENTRY LAUNCHPAD HANDLERS (COMPLIANT UTILITY FRAMING)
// =========================================================
const handleLaunchPadMenu = async (ctx: any) => {
    try {
        try { await ctx.answerCbQuery(); } catch(e){}
        const tgId = ctx.from?.id.toString()!;
        
        await deleteKeysPattern(`token_launch:${tgId}:*`);

        const msg = `🚀 <b>SENTRY LAUNCHPAD</b> 🚀\n\n` +
                    `<i>Secure token deployment via Jito Block-0 routing.</i>\n\n` +
                    `🟢 <b>Utility & Risk Management Features:</b>\n` +
                    `• <b>Defensive Jito Bundling:</b> Your token deployment and initial allocation are routed in a single Jito bundle, shielding your entry transaction from front-running snipers.\n` +
                    `• <b>Portfolio Allocation:</b> Distribute your purchase across up to 4 distinct wallets concurrently within Block-0 to split execution risk.\n` +
                    `• <b>Downside Risk Controls:</b> Configure an automatic stop-loss guard on your initial allocation to help manage capital risk if market conditions drop.\n` +
                    `• <b>Transparency Audits:</b> Verify post-launch distribution metrics instantly to analyze the top holder landscape for due diligence.\n\n` +
                    `💳 <b>Platform Fee:</b> 0.04 SOL (+ 0.02 SOL Pump.fun fee)\n\n` +
                    `<i>The platform fee directly funds Sentry's defensive Jito block-building infrastructure.</i>`;

        await safeEditMessageText(ctx, msg, Markup.inlineKeyboard([
            [Markup.button.callback('🚀 START LAUNCH WIZARD', 'start_token_wizard')],
            [Markup.button.callback('📂 MY LAUNCH PORTFOLIO', 'menu_my_launches')],
            [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
        ]));
    } catch (err: any) {
        console.error("🔴 [LAUNCHPAD MENU CRASH]:", err.message);
    }
};

// Map both namespaces to catch either callback cleanly
bot.action('menu_token_launcher', handleLaunchPadMenu);
bot.action('action_launch_token_start', handleLaunchPadMenu);

bot.action('start_token_wizard', async (ctx) => {
    try {
        try { await ctx.answerCbQuery(); } catch(e){}
        const tgId = ctx.from?.id.toString()!;
        
        await redis.set(`token_launch:${tgId}:step`, 'AWAITING_NAME', 'EX', 900);
        
        await safeEditMessageText(ctx, 
            `🚀 <b>THE SENTRY LAUNCHPAD WIZARD</b>\n\n` +
            `<b>Step 1/8:</b> What is the <b>Name</b> of your token?\n` +
            `<i>(e.g., Doge Killer)</i>\n\n` +
            `<i>Type /cancel at any time to abort.</i>`,
            Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'action_abort_token_launch')]])
        );
    } catch (err: any) {
        console.error("🔴 [WIZARD INITIATION CRASH]:", err.message);
    }
});


async function sendOrEditVaultMenu(ctx: any, telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;
    
    let liveBalance = await getLiveBalance(user);
    const hideWallets = await redis.get(`user_settings:hide_wallets:${telegramId}`) === 'true';

    let walletText = `🔑 <b>VAULT & KEYS</b>\n\n<b>Total Balance:</b> <code>${liveBalance} SOL</code>\n\n`;
    walletText += `<b>W1 (Main):</b> <code>${maskAddress(user.vaultAddress, hideWallets)}</code>\n`;
    if (user.activeWallets >= 2 && user.vault2) walletText += `<b>W2:</b> <code>${maskAddress(user.vault2, hideWallets)}</code>\n`;
    if (user.activeWallets >= 3 && user.vault3) walletText += `<b>W3:</b> <code>${maskAddress(user.vault3, hideWallets)}</code>\n`;
    if (user.activeWallets >= 4 && user.vault4) walletText += `<b>W4:</b> <code>${maskAddress(user.vault4, hideWallets)}</code>\n`;
    if (user.activeWallets >= 5 && user.vault5) walletText += `<b>W5:</b> <code>${maskAddress(user.vault5, hideWallets)}</code>\n\n`;
    walletText += `🐙 <b>WHY USE MULTI-WALLET (WHALE MODE)?</b>\nPump.fun restricts how many tokens a single wallet can buy at launch. By activating multiple wallets, Sentry fires simultaneous transactions in the exact same millisecond via Jito. <b>You bypass the limits, secure a massive bag at Block-0, and dump on the timeline.</b>\n\n<i>⚠️ NOTE: You MUST send SOL to each individual address above!</i>\n\n<b>Active Wallets:</b> ${user.activeWallets} / 5\n`;

    const UI = Markup.inlineKeyboard([
        [
            Markup.button.callback(user.activeWallets === 1 ? '🟢 1' : '1', 'set_wallets_1'),
            Markup.button.callback(user.activeWallets === 2 ? '🟢 2' : '2', 'set_wallets_2'),
            Markup.button.callback(user.activeWallets === 3 ? '🟢 3' : '3', 'set_wallets_3'),
            Markup.button.callback(user.activeWallets >= 4 ? '🟢 4' : '4', 'set_wallets_4'),
            Markup.button.callback(user.activeWallets >= 5 ? '🟢 5' : '5', 'set_wallets_5')
        ],
        [Markup.button.callback('🧹 Sweep All Sub-Wallets to W1', 'action_consolidate_wallets')],
        [Markup.button.callback('📤 Export Keys', 'action_export_key'),
             Markup.button.callback('📥 Import Key', 'action_import_key')],
             [Markup.button.callback('🔒 Set Withdrawal PIN', 'action_set_pin')],
        [Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]
    ]);

    await safeEditMessageText(ctx, walletText, UI); 
}


// =========================================================
// 🏰 SENTRY GUILDS (B2B LOYALTY ENGINE)
// =========================================================

bot.command('sim', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;
    try {
        const current = await redis.get(`sim:active:${tgId}`);
        const newState = current === 'true' ? 'false' : 'true';
        await redis.set(`sim:active:${tgId}`, newState);

        if (newState === 'true') {
            const { setSimStartingBalance, generateSimWallets } = await import('./services/simulation.service.js');
            const existing = await redis.get(`sim:balance:${tgId}`);
            const startBal = existing ? parseFloat(existing) : 1000;
            if (!existing) await redis.set(`sim:balance:${tgId}`, startBal.toFixed(4));
            await setSimStartingBalance(tgId, startBal); // 🟢 baseline ALWAYS matches actual starting balance

            const wallets = generateSimWallets();
            await redis.set(`sim:wallets:${tgId}`, JSON.stringify(wallets));
        } else {
            const keys = await redis.keys(`sim:*:${tgId}`);
            if (keys.length > 0) await redis.del(...keys);
        }

        const displayBal = await redis.get(`sim:balance:${tgId}`) || '1000';
        await ctx.replyWithHTML(
            `🎮 <b>SIMULATION MODE: ${newState === 'true' ? '🟢 ACTIVATED' : '🔴 DEACTIVATED'}</b>\n\n` +
            `${newState === 'true'
                ? `⚠️ <i>All trades, balances, and alerts are now simulated.</i>\n\n` +
                  `💰 Starting balance: <b>${displayBal} SOL</b>\n` +  // 🟢 dynamic now, no more mismatch
                  `🎯 Type <code>/simbal [amount]</code> to change it (also resets your PnL% baseline).`
                : `<i>Platform returned to live mode. All sim data cleared.</i>`
            }`
        );
    } catch (e: any) {
        await ctx.replyWithHTML(`🔴 <b>SIM ERROR:</b> ${e.message}`);
    }
});


// =========================================================
// 👑 VIP MENU SYSTEM
// =========================================================
bot.command('vipstatus', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;
    const status = await checkVipStatus(tgId);
    const msg = formatVipStatus(status);
    await ctx.replyWithHTML(msg, buildVipMenuKeyboard(status.isVip));
});

bot.action('menu_vip', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;
    const status = await checkVipStatus(tgId);
    const msg = formatVipStatus(status);
    await safeEditMessageText(ctx, msg, buildVipMenuKeyboard(status.isVip));
});

function buildVipMenuKeyboard(isVip: boolean) {
    if (isVip) {
        return Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Extend / Upgrade Plan', 'vip_upgrade_menu')],
            [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
        ]);
    }
    return Markup.inlineKeyboard([
        [Markup.button.callback(`${VIP_TIERS.trial.label} — ${VIP_TIERS.trial.priceSol} SOL / ${VIP_TIERS.trial.durationDays}D`, 'vip_select_trial')],
        [Markup.button.callback(`${VIP_TIERS.standard.label} — ${VIP_TIERS.standard.priceSol} SOL / ${VIP_TIERS.standard.durationDays}D`, 'vip_select_standard')],
        [Markup.button.callback(`${VIP_TIERS.pro.label} — ${VIP_TIERS.pro.priceSol} SOL / ${VIP_TIERS.pro.durationDays}D`, 'vip_select_pro')],
        [Markup.button.callback(`${VIP_TIERS.lifetime.label} — ${VIP_TIERS.lifetime.priceSol} SOL`, 'vip_select_lifetime')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);
}



bot.action('vip_upgrade_menu', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await safeEditMessageText(ctx,
        `🔄 <b>UPGRADE OR EXTEND YOUR VIP</b>\n\nSelect a new plan. Your existing time will be replaced with the new plan starting now.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('🟡 Trial — 0.1 SOL / 7 Days', 'vip_select_trial')],
            [Markup.button.callback('🟢 Standard — 0.3 SOL / 30 Days', 'vip_select_standard')],
            [Markup.button.callback('🔵 Pro — 1.0 SOL / 90 Days', 'vip_select_pro')],
            [Markup.button.callback('💎 Lifetime — 3.0 SOL', 'vip_select_lifetime')],
            [Markup.button.callback('⬅️ Back', 'menu_vip')]
        ])
    );
});

async function showVipPaymentInstructions(ctx: any, tier: VipTierKey) {
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;

    const tierDef = VIP_TIERS[tier];
    const treasury = process.env.TREASURY_WALLET_ADDRESS!;

    await redis.set(
        `vip:pending:${tgId}`,
        JSON.stringify({ tier, priceSol: tierDef.priceSol, initiatedAt: Date.now() }),
        'EX', 600
    );

    const msg =
        `${tierDef.label}\n\n` +
        `📋 <b>PAYMENT INSTRUCTIONS</b>\n\n` +
        `Send exactly <b>${tierDef.priceSol} SOL</b> to:\n` +
        `<code>${treasury}</code>\n\n` +
        `⏱️ You have <b>10 minutes</b> to complete the payment.\n\n` +
        `After sending, tap <b>✅ I've Paid</b> and paste your transaction signature.\n\n` +
        `<i>Your W1 wallet address must be the sender. The bot will verify on-chain automatically.</i>\n\n` +
        `🔒 Payment is non-refundable once VIP is activated.`;

    await safeEditMessageText(ctx, msg,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ I\'ve Paid — Submit TX', `vip_submit_tx_${tier}`)],
            [Markup.button.callback('❌ Cancel', 'menu_vip')]
        ])
    );
}

bot.action('vip_select_trial', async (ctx) => { try { await ctx.answerCbQuery(); } catch(e){} await showVipPaymentInstructions(ctx, 'trial'); });
bot.action('vip_select_standard', async (ctx) => { try { await ctx.answerCbQuery(); } catch(e){} await showVipPaymentInstructions(ctx, 'standard'); });
bot.action('vip_select_pro', async (ctx) => { try { await ctx.answerCbQuery(); } catch(e){} await showVipPaymentInstructions(ctx, 'pro'); });
bot.action('vip_select_lifetime', async (ctx) => { try { await ctx.answerCbQuery(); } catch(e){} await showVipPaymentInstructions(ctx, 'lifetime'); });

bot.action(/^vip_submit_tx_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tier = ctx.match[1] as VipTierKey;
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;

    await redis.set(`vip:awaiting_tx:${tgId}`, tier, 'EX', 600);

    await safeEditMessageText(ctx,
        `✅ <b>SUBMIT TRANSACTION SIGNATURE</b>\n\n` +
        `Paste your transaction signature below.\n\n` +
        `You can find it in your wallet's transaction history or on Solscan.\n\n` +
        `<i>Example: 5KtP9x...abc123</i>`,
        Markup.inlineKeyboard([
            [Markup.button.callback('❌ Cancel', 'menu_vip')]
        ])
    );
});

bot.command('adminvip', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.replyWithHTML(`Usage: <code>/adminvip [telegramId] [tier]</code>\nTiers: trial | standard | pro | lifetime`);

    const targetId = parts[1];
    const tier = parts[2] as VipTierKey;

    if (!VIP_TIERS[tier]) return ctx.replyWithHTML(`❌ Invalid tier.`);

    await grantVip(targetId, tier, 'ADMIN'); // 🟢 FIX: Uppercase 'ADMIN'
    await ctx.replyWithHTML(`✅ Granted <b>${VIP_TIERS[tier].label}</b> to user <code>${targetId}</code>`);
    try { await bot.telegram.sendMessage(targetId, `👑 <b>VIP ACTIVATED BY ADMIN</b>\n\n${VIP_TIERS[tier].label} has been granted to your account.`, { parse_mode: 'HTML' }); } catch(e) {}
});

// QUICK ACTIONS
bot.action(/^quick_buy_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery('⚡ Loading token...'); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id?.toString();
    if (!tgId || !mint) return;
    
    // 🟢 FIX E3: Avoid spoofing bot.handleUpdate which lacks message_id metadata
    await executeManualSnipePrompt(ctx, tgId, mint);
});

// Extract this helper function:
async function executeManualSnipePrompt(ctx: any, telegramId: string, possibleCA: string) {
    let tradeAmountSol = 0.01; 
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (user?.autoSnipeConfig?.amountSol) tradeAmountSol = user.autoSnipeConfig.amountSol;

    const spamLockKey = `lock:manual_snipe:${telegramId}`;
    if (!(await redis.set(spamLockKey, 'LOCKED', 'EX', 3, 'NX'))) return ctx.reply("⚠️ <b>Please wait a moment before sending another snipe command.</b>", { parse_mode: 'HTML' });

    const loader = await ctx.replyWithHTML(`⚡ <b>SNIPE ENGAGED</b>\n\nTarget: <code>${possibleCA.substring(0,8)}...</code>\nAmount: <b>${tradeAmountSol} SOL</b>\n<i>⏳ Fetching Info...</i>`);
    // ... rest of your token info / confirm_buy block goes here ...
    await redis.set(`pending_buy:${telegramId}:${possibleCA}`, tradeAmountSol.toString(), 'EX', 120);
}

bot.action(/^watch_remove_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery('❌ Alert removed'); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;
    await redis.hdel(`watchlist:${tgId}`, mint);
    await ctx.replyWithHTML(`✅ Alert removed for <code>${mint}</code>`);
});

// 🟢 CLAUDE FIX 4: Rolling time window stats for live & sim


bot.command('simedit', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length !== 5) {
        return ctx.replyWithHTML('<b>Usage:</b> <code>/simedit [WINS] [LOSSES] [TOTAL_VOLUME_SOL] [DAYS_ACTIVE]</code>\n\n<i>Example:</i>\n<code>/simedit 185 64 1250 42</code>');
    }

    const wins = parseInt(parts[1]);
    const losses = parseInt(parts[2]);
    const totalVol = parseFloat(parts[3]);
    const daysActive = parseInt(parts[4]);
    if (isNaN(wins) || isNaN(losses) || isNaN(totalVol) || isNaN(daysActive) || daysActive < 1) {
        return ctx.reply("🔴 Invalid numbers provided.");
    }

    const fakeTrades = [];
    const volPerTrade = totalVol / ((wins + losses) || 1);
    const now = Date.now();
    let totalRealizedPnl = 0; // 🟢 track so balance stays consistent with the forged wins/losses

    for (let i = 0; i < wins; i++) {
        const pnlPercent = Math.random() * 150 + 15;
        const realizedPnlSol = volPerTrade * (pnlPercent / 100);
        totalRealizedPnl += realizedPnlSol;
        fakeTrades.push({
            createdAt: new Date(now - Math.random() * daysActive * 86400000).toISOString(),
            isBuy: false, amountInSol: volPerTrade, profitPercent: pnlPercent, realizedPnlSol
        });
    }
    for (let i = 0; i < losses; i++) {
        const pnlPercent = -(Math.random() * 35 + 5);
        const realizedPnlSol = volPerTrade * (pnlPercent / 100);
        totalRealizedPnl += realizedPnlSol;
        fakeTrades.push({
            createdAt: new Date(now - Math.random() * daysActive * 86400000).toISOString(),
            isBuy: false, amountInSol: volPerTrade, profitPercent: pnlPercent, realizedPnlSol
        });
    }

    if (fakeTrades.length > 0) fakeTrades[0].createdAt = new Date(now - daysActive * 86400000).toISOString();
    fakeTrades.sort(() => Math.random() - 0.5);

    await redis.set(`sim:trades:${tgId}`, JSON.stringify(fakeTrades), 'EX', 86400 * 30);
    await redis.set(`sim:volume:${tgId}`, totalVol.toString());

    // 🟢 THE FIX: forged trades now actually move the balance the dashboard reads
    const { getSimStartingBalance } = await import('./services/simulation.service.js');
    const startBal = await getSimStartingBalance(tgId);
    const newBalance = Math.max(0, startBal + totalRealizedPnl);
    await redis.set(`sim:balance:${tgId}`, newBalance.toFixed(4));

    await ctx.replyWithHTML(
        `✅ <b>Simulated Stats Forged & Aligned!</b>\n\n` +
        `Wins: <b>${wins}</b> | Losses: <b>${losses}</b>\n` +
        `Volume: <b>${totalVol} SOL</b> | Days: <b>${daysActive}</b>\n` +
        `Win Rate: <b>${((wins/(wins+losses))*100).toFixed(1)}%</b>\n` +
        `New Balance: <b>${newBalance.toFixed(4)} SOL</b>\n\n` +
        `<i>Dashboard PnL, Net Worth, and Win Rate are now fully consistent.</i>`
    );
});


bot.action('action_abort_token_launch', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    // 🟢 D4 FIX
    await deleteKeysPattern(`token_launch:${tgId}:*`);
    await safeEditMessageText(ctx, `❌ <b>Token launch cancelled.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'btn_dashboard')]]));
});

bot.command('simbal', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.replyWithHTML('Usage: <code>/simbal 50</code> or <code>/simbal $1000</code>');
    const amount = parseSolAmount(parts[1], true);
    if (amount === null || amount <= 0) return ctx.replyWithHTML('🔴 Invalid amount.');

    await redis.set(`sim:balance:${tgId}`, amount.toFixed(4));
    const { setSimStartingBalance } = await import('./services/simulation.service.js');
    await setSimStartingBalance(tgId, amount); // 🟢 resets baseline — PnL% now reads 0% from this point
    await ctx.replyWithHTML(`🎮 Sim balance set to <b>${amount.toFixed(4)} SOL</b> and PnL baseline reset to match.`);
});





// 🟢 NEW FEATURE: Interactive Coin Caller Menu & Filters
async function sendCallerMenu(ctx: any, tgId: string, isEdit = false) {
    const filters = await getUserCallerFilters(tgId);
    
    const statusText = filters.isActive 
        ? "🟢 <b>ACTIVE & SCANNING</b> 🔍\n<i>(Searching mempool for matches every 15s...)</i>" 
        : "🔴 <b>OFFLINE</b>";
        
    const mevText = filters.blockMev ? "🟢 Yes (Protected)" : "🔴 No (Risky)";

    const text = `🎯 <b>AI COIN CALLER ENGINE</b>\n\n` +
        `Sentry scans DexScreener every 15 seconds and DMs you the highest-scoring tokens before they pump.\n\n` +
        
        `🧠 <b>HOW THE SCORE WORKS (0 - 100):</b>\n` +
        `• <b>High Score (75-100):</b> High liquidity, strong volume, high momentum, young age. Safer, higher potential.\n` +
        `• <b>Low Score (0-50):</b> Low liquidity, dead volume, or aging token. High risk of failure.\n` +
        `• <b>RugCheck:</b> Any honeypot or freeze authority instantly scores -100 (Blocked).\n\n` +
        
        `💡 <b>STRATEGY GUIDE ($500 - $1,000 Bankroll):</b>\n` +
        `• <b>Spend:</b> 0.1 to 0.2 SOL per trade (approx $15 - $30). This allows you to spread risk across 20+ tokens instead of gambling on just one.\n` +
        `• <b>Stop-Loss:</b> -20% to -30%. Gives the coin room to breathe through normal trench volatility without getting fully rugged.\n` +
        `• <b>Take-Profit:</b> +50% to +100%. Don't be greedy. Compounding small 50% wins builds bankrolls faster than waiting for a 100x.\n\n` +

        `<b>Engine Status:</b> ${statusText}\n\n` +
        `⚙️ <b>CURRENT FILTERS:</b>\n` +
        `• <b>Minimum Score:</b> ${filters.minScore} / 100\n` +
        `• <b>Max Token Age:</b> ${filters.maxAgeMins} Mins\n` +
        `• <b>Momentum % Range:</b> ${filters.minPctChange}% to ${filters.maxPctChange}%\n` +
        `• <b>Min Liquidity:</b> $${filters.minLiquidity.toLocaleString()}\n` +
        `• <b>Min 24h Volume:</b> $${filters.minVolume24h.toLocaleString()}\n` +
        `• <b>Block MEV:</b> ${mevText}\n\n` +
        `<i>Adjust your scanner parameters below:</i>`;

    const ui = Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Scan Mainnet Now', 'trigger_caller_scan')], 
        [Markup.button.callback(filters.isActive ? '🛑 TURN OFF CALLER' : '⚡ TURN ON CALLER', 'toggle_caller_status')],
        [
            Markup.button.callback(`⏱️ Max Age (${filters.maxAgeMins}m)`, 'edit_caller_age'),
            Markup.button.callback(`📈 % Range (${filters.minPctChange} - ${filters.maxPctChange}%)`, 'edit_caller_pct')
        ],
        [
            Markup.button.callback(`💧 Min Liq ($${(filters.minLiquidity/1000).toFixed(0)}k)`, 'edit_caller_liq'),
            Markup.button.callback(`📊 Min Vol ($${(filters.minVolume24h/1000).toFixed(0)}k)`, 'edit_caller_vol')
        ],
        [
            Markup.button.callback(`✏️ Min Score (${filters.minScore})`, 'edit_caller_score'), 
            Markup.button.callback(filters.blockMev ? '🛡️ MEV Block: ON' : '⚠️ MEV Block: OFF', 'toggle_caller_mev')
        ],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, text, ui);
    else await ctx.replyWithHTML(text, ui);
}

bot.action('action_create_guild_prompt', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    
    const msg = `🏰 <b>SENTRY GUILDS: BUILD A LOYAL COMMUNITY</b>\n\n` +
                `<b>What is a Guild?</b>\n` +
                `A Guild is your own private, on-chain loyalty engine inside Sentry. It transforms your passive audience into an organized, volume-generating army.\n\n` +
                `<b>Why build a Guild?</b>\n` +
                `Stop giving whitelist spots or airdrops to fake Twitter accounts and bots. A Sentry Guild automatically tracks the <i>actual on-chain SOL volume</i> of every member who joins via your invite link.\n\n` +
                `You get a verified, rank-ordered leaderboard of the people actually buying your bags, allowing you to reward your truest, most loyal supporters.\n\n` +
                `<b>The Ultimate Perk (50% Rev-Share):</b>\n` +
                `By bringing your community to Sentry, you earn <b>50% of the platform fees</b> on every single trade your members make, forever. Your loyal community becomes a passive income stream.\n\n` +
                `<i>Your Developer Suite subscription covers the infrastructure cost. Launching your Guild today is completely free.</i>`;
    
    await safeEditMessageText(ctx, msg, Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Start Guild Setup Wizard', 'action_start_guild_wizard')],
        [Markup.button.callback('⬅️ Back', 'action_guild_menu')]
    ]));
});

// 🟢 NEW: Endpoint to sync WebApp toggle with Backend Simulation state
app.post('/api/toggle-sim', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: "Invalid initData" });
        
        const newState = req.body.active ? 'true' : 'false';
        await redis.set(`sim:active:${tgId}`, newState);

        if (newState === 'true') {
            const existing = await redis.get(`sim:balance:${tgId}`);
            if (!existing) await redis.set(`sim:balance:${tgId}`, '12.4521');
            const { generateSimWallets } = await import('./services/simulation.service.js');
            const wallets = generateSimWallets();
            await redis.set(`sim:wallets:${tgId}`, JSON.stringify(wallets));
        } else {
            const keys = await redis.keys(`sim:*:${tgId}`);
            if (keys.length > 0) await redis.del(...keys);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

bot.action('action_start_guild_wizard', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { ownedGuild: true } });
    if (user?.ownedGuild) {
        return ctx.replyWithHTML("🔴 <b>Limit Reached:</b> You already own a Guild.");
    }

    await redis.hset(`guild_setup:${tgId}`, { step: 1 });
    await redis.expire(`guild_setup:${tgId}`, 600);
    
    await safeEditMessageText(ctx, 
        `🏰 <b>GUILD SETUP [Step 1/2]</b>\n\n` +
        `Let's build your empire.\n\n` +
        `What is the <b>Name</b> of your community?\n` +
        `<i>(e.g., Alpha Wolves Community)</i>\n\n` +
        `Reply to this message with your desired name.`,
        Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Setup', 'action_abort_guild_setup')]])
    );
});


// 🟢 CLAUDE FIX 4.9: Pipe-Delimited Guild Creation
bot.command('createguild', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { ownedGuild: true } });
    if (user?.ownedGuild) return ctx.reply("🔴 You already own a Guild.");

    const text = (ctx.message as any).text.replace('/createguild', '').trim();
    
    // If they provided the exact pipe-delimited syntax, skip the wizard and deploy instantly
    if (text) {
        const parts = text.split('|').map((p: string) => p.trim());
        if (parts.length === 3) {
            const [name, desc, reward] = parts;
            if (name.length < 3 || name.length > 30) return ctx.reply("⚠️ Name must be between 3 and 30 characters.");
            
            const loader = await ctx.reply("<i>⏳ Initializing Guild Database...</i>", { parse_mode: 'HTML' });
            const { createGuild } = await import('./services/guild.service.js');
            const res = await createGuild(tgId, name, desc, reward);
            
            if (res.success) {
                return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                    `✅ <b>GUILD SUCCESSFULLY CREATED!</b>\n\nInvite Code: <code>${res.guildCode}</code>\n\n🔗 <b>Invite Link:</b>\n<code>https://t.me/${ctx.botInfo?.username}?start=guild_${res.guildCode}</code>`, 
                    { parse_mode: 'HTML' });
            } else {
                return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Creation Failed:</b> ${res.message}`, { parse_mode: 'HTML' });
            }
        }
    }

    // Otherwise, push them into the interactive wizard
    await redis.hset(`guild_setup:${tgId}`, { step: 1 });
    await redis.expire(`guild_setup:${tgId}`, 600);
    await ctx.replyWithHTML(`🏰 <b>GUILD SETUP [Step 1/2]</b>\n\nWhat is the name of your community?\n<i>(e.g., Alpha Wolves Community)</i>\n\nReply to this message with the name. (Type /cancel to abort)`);
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

    const user = await prisma.user.findUnique({ 
        where: { telegramId: tgId }, 
        include: { ownedGuild: { include: { members: { include: { user: true } } } } } 
    });
    
    if (!user) return;

    // 🟢 D2 FIX: Removed the 2.0 SOL price reference from the UI.
    if (!user.ownedGuild) {
        const createMsg = 
            `🏰 <b>SENTRY GUILDS: COMMAND YOUR COMMUNITY</b>\n\n` +
            `<b>What is a Sentry Guild?</b>\n` +
            `A Sentry Guild is your private, on-chain loyalty and monetization engine. It transforms your passive audience into a highly coordinated trading powerhouse under your brand.\n\n` +
            `<b>Why You Need It & Its Benefits:</b>\n` +
            `• <b>Filter Fake Bots (Sybil Protection):</b> Giveaway channels are plagued by automated bot farms. A Sentry Guild tracks <i>actual on-chain volume</i>, proving who is genuinely supporting your project with skin in the game.\n` +
            `• <b>Real-Time Leadership Gamification:</b> Sentry computes a live-updating leaderboard of your members. Keep your chat highly competitive and run active trading contests natively.\n` +
            `• <b>Passive Revenue Generation:</b> You earn <b>50% of our platform fee</b> on every trade executed by your Guild members—forever. Your community becomes a compounding passive yield generator.\n` +
            `• <b>Direct KOL Custom Whitelisting:</b> Export highly-qualified, ranked wallets to whitelist or issue customized rewards cleanly via CSV.\n\n` +
            `💳 <b>Cost:</b> Free — Included with your Sentry account.\n\n` +
            `Use the command below to launch your Guild:\n` +
            `<code>/createguild [Name] | [Description] | [Reward]</code>`;
        
        return ctx.editMessageText(createMsg, { 
            parse_mode: 'HTML', 
            reply_markup: { 
                inline_keyboard: [
                    [Markup.button.callback('🚀 Start Guild Setup Wizard', 'action_start_guild_wizard')],
                    [ { text: '⬅️ Back', callback_data: 'action_guild_menu' } ]
                ] 
            } 
        }).catch(() => {});
    }

    const guild = user.ownedGuild;
    const totalMembers = guild.members.length;
    const totalVol = guild.members.reduce((sum: number, m: any) => sum + m.totalVolumeSol, 0);

    const text = `🏰 <b>GUILD MANAGEMENT PANEL</b>\n\n• <b>Community Name:</b> <code>${guild.name}</code>\n• <b>Guild Code:</b> <code>${guild.guildCode}</code>\n• <b>Reward Program:</b> <i>"${guild.rewardDescription || 'No active reward'}"</i>\n\n📈 <b>Global Stats:</b>\n  ├ Members Registered: <b>${totalMembers}</b>\n  └ Total Volume: <b>${totalVol.toFixed(2)} SOL</b>\n\n🔗 <b>Your Exclusive Invite Link:</b>\n<code>https://t.me/${ctx.botInfo?.username}?start=guild_${guild.guildCode}</code>\n\n<i>(When members click this, they auto-join your community and you receive 50% of their platform fees as an affiliate permanently!)</i>`;

    await ctx.editMessageText(text, { 
        parse_mode: 'HTML', 
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🏆 Tiered Drop (Top 10)', `tiered_drop_${guild.id}`)],
            [Markup.button.callback('👤 Pay Individual Member', `indiv_drop_${guild.id}`)],
            [Markup.button.callback('✏️ Edit Name', `edit_g_name_${guild.id}`), Markup.button.callback('🎁 Edit Reward', `edit_g_reward_${guild.id}`)],
            [Markup.button.callback('📥 Export Wallets (CSV)', `export_guild_${guild.id}`)],
            [Markup.button.callback('⬅️ Back to Guilds', 'action_guild_menu')]
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
    
    const csv = await exportLeaderboard(tgId, guildId);
    if (!csv) return ctx.reply("🔴 Export failed. Verify you are the owner of this Guild.");

    const guild = await prisma.guild.findUnique({ where: { id: guildId } });
    const communityName = guild ? guild.name : "Sentry_Guild";
    const buffer = Buffer.from(csv, 'utf-8');
    
    await ctx.replyWithDocument(
        { source: buffer, filename: `${communityName.replace(/\s+/g, '_')}_Holders.csv` },
        { caption: `📊 <b>SENTRY LOYALTY LEDGER: EXPORT COMPLETE</b>`, parse_mode: 'HTML' }
    );

    const guideText = 
        `🏆 <b>OPERATIONAL GUIDE: HOW TO REWARD YOUR LOYAL GUILD MEMBERS</b>\n\n` +
        `Your CSV ledger is ready. Here is how to use this data to execute rewards and keep your community highly engaged:\n\n` +
        `🎁 <b>METHOD 1: Bulk Token/SOL Airdrops (Instant Distribution)</b>\n` +
        `<i>Drop free project tokens or SOL directly into the wallets of your top volume contributors to reward their support.</i>\n` +
        `1. Open the CSV and copy the list of addresses from the <code>wallet_address</code> column.\n` +
        `2. Navigate to an audited Solana bulk-sender tool like <b>Smithii Multisender</b>, <b>DEXArea</b>, or <b>PandaTool</b>.\n` +
        `3. Connect your wallet, select the SPL token or SOL, paste the wallet addresses, and execute.\n\n` +
        `🎟️ <b>METHOD 2: Whitelist & Allowlist Access (Sybil Filtering)</b>\n` +
        `<i>Protect your presales or NFT mints from automated bot farms by granting access only to actual on-chain traders.</i>\n` +
        `1. Extract the top 50 or 100 addresses from your CSV.\n` +
        `2. Go to standard allowlist managers like <b>Atlas3</b>, <b>Subber</b>, or <b>Helio.io</b>.\n` +
        `3. Import the list as your "Verified Whitelist List." Only community members who actively traded will have permission to mint.`;

    await ctx.replyWithHTML(guideText);
});

// =========================================================
// 🚀 COMMAND: /start & ONBOARDING (COMPLIANT RISK AGREEMENT)
// =========================================================
bot.start(async (ctx: Context) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    try {
        let userCheck = await prisma.user.findUnique({ where: { telegramId } });
        const botName = process.env.BOT_NAME || 'Sentry Terminal';
        
        let pendingGuildCode: string | undefined = undefined;
        let referrerId: string | null = null;
        let getsDiscount = false;

        // @ts-ignore
        const payload = ctx.payload || '';

        if (payload) {
            if (payload.startsWith('guild_')) {
                pendingGuildCode = payload.replace('guild_', '') || undefined;
                const guild = await prisma.guild.findUnique({ where: { guildCode: pendingGuildCode } });
                if (guild) { referrerId = guild.ownerId; getsDiscount = true; }
            } else {
                const referrer = await prisma.user.findUnique({ where: { referralCode: payload } });
                if (referrer) { referrerId = referrer.id; getsDiscount = true; }
            }
        }

        if (!userCheck) {
            const refPrefix = botName.toUpperCase().split(' ')[0];
            userCheck = await prisma.user.create({
                data: {
                    telegramId: telegramId, username: ctx.from?.username || "Trader",
                    referralCode: `${refPrefix}-${telegramId}`, referredById: referrerId,
                    hasReferralDiscount: getsDiscount
                }
            });

            // 🟢 CLAUDE FIX 2.7: Trigger Daily VIP Promo for new users
            if (payload && !payload.startsWith('guild_')) {
                const result = await checkAndGrantDailyVip(telegramId, payload);
                if (result.granted) {
                    await ctx.replyWithHTML(`🎉 <b>PROMO VIP GRANTED!</b>\n\nYou received a free 10-Day VIP Pass via your referral link!`);
                }
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

        const welcomeText = `🛡️ <b>WELCOME TO ${botName.toUpperCase()}</b>\n\n` +
            `Sentry is a secure, high-efficiency programmatic developer utility interface for decentralized markets. ` +
            `All trades are routed defensive-only via private Jito Block-0 validator paths to prevent public mempool exploitation.\n\n` +
            `✅ <b>Zero-Latency Memory Execution:</b> Localized non-custodial parameters.\n` +
            `✅ <b>Jito MEV Shield:</b> Bypass congested nodes to protect cost basis.\n` +
            `✅ <b>Risk Controls:</b> Multi-wallet balance delegation and trailing stop-losses.\n\n` +
            `⚠️ <b>REGULATORY & RISK DISCLAIMER:</b>\n` +
            `By proceeding, you agree that Sentry is a decentralized self-custodial software tool. You retain exclusive control over your generated private keys. ` +
            `The operators of this software do not hold user funds, do not provide financial advice, and make no guarantees of trading returns or token launch outcomes. ` +
            `Trading cryptocurrencies carries a high risk of financial loss. You are solely responsible for compliance with the laws of your local jurisdiction.\n\n` +
            `<i>Click below to authorize vault creation and agree to these self-custodial terms:</i>`;

        await ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard([[Markup.button.callback('✅ I AGREE & CREATE VAULT', 'action_create_vault')]]));
    } catch (error) { console.error("🔴 Registration Fault:", error); }
});

// =========================================================
// 🟢 FEATURES 3 & 4: WATCHLIST & CALENDAR COMMANDS
// =========================================================

bot.command('calendar', async (ctx) => {
    
    const raw = await redis.get('calendar:launches');
    const launches = raw ? JSON.parse(raw) : [];

    if (launches.length === 0) return ctx.replyWithHTML("<i>📅 No verified launches in the last 2 hours. Try again shortly.</i>");

    for (const p of launches) {
        const ageMins = Math.floor((Date.now() - p.pairCreatedAt) / 60000);
        await ctx.replyWithHTML(
            `🚀 <b>$${p.baseToken.symbol}</b>\n` +
            `<code>${p.baseToken.address}</code>\n\n` +
            `⏱️ <b>Age:</b> ${ageMins} mins\n` +
            `💰 <b>Vol:</b> $${p.volume.h24.toLocaleString()}\n` +
            `💦 <b>Liq:</b> $${p.liquidity.usd.toLocaleString()}`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🎯 Snipe This', `caller_guard_${p.baseToken.address}`)],
                [Markup.button.url('📊 Chart', p.url)]
            ])
        );
    }
});

// 🟢 CLAUDE FIX 3.3: Single unified /watch regex that strictly uses Redis
bot.hears(/^\/watch (.+)/i, async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const parts = ctx.match[1].trim().split(' ');
    const ca = parts[0];
    const targetPrice = parts.length > 1 ? parseFloat(parts[1]) : 0;

    let currentPrice = 0;
    try {
        const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${ca}`);
        currentPrice = res.data?.data?.[ca]?.price || 0;
    } catch (e) {}

    const watchData = { addedPrice: currentPrice, targetPrice: targetPrice, addedAt: Date.now() };
    await redis.hset(`watchlist:${tgId}`, ca, JSON.stringify(watchData));
    
    ctx.replyWithHTML(`👀 <b>Added to Persistent Watchlist!</b>\nToken: <code>${ca.substring(0,8)}...</code>\nAdded at Price: <b>$${currentPrice}</b>\nAlert Target: ${targetPrice > 0 ? `<b>$${targetPrice}</b>` : '<i>None</i>'}`);
});

bot.command('unwatch', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    const ca = ctx.message.text.split(' ')[1];
    if (!tgId || !ca) return;
    
    await redis.hdel(`watchlist:${tgId}`, ca);
    ctx.reply(`✅ Removed ${ca} from watchlist.`);
});

bot.command('clearwatch', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    await redis.del(`watchlist:${tgId}`);
    ctx.reply(`✅ Watchlist cleared.`);
});

bot.command('watchlist', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    
    const items = await redis.hgetall(`watchlist:${tgId}`);
    const cas = Object.keys(items);
    if (cas.length === 0) return ctx.reply("👀 Your watchlist is empty. Use /watch [CA] to add tokens.");

    const loader = await ctx.reply("<i>⏳ Fetching live prices...</i>", { parse_mode: 'HTML' });
    
    let msg = `👀 <b>YOUR WATCHLIST</b>\n\n`;
    for (const ca of cas) {
        const data = JSON.parse(items[ca]);
        let currentPrice = 0;
        try {
            const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${ca}`);
            currentPrice = res.data?.data?.[ca]?.price || 0;
        } catch (e) {}

        const diff = data.addedPrice > 0 ? (((currentPrice - data.addedPrice) / data.addedPrice) * 100).toFixed(2) : '0.00';
        msg += `• <code>${ca.substring(0,6)}...</code>\n`;
        msg += `   Live: <b>$${currentPrice}</b> (${Number(diff) >= 0 ? '+' : ''}${diff}%)\n`;
        if (data.targetPrice > 0) msg += `   Target Alert: <b>$${data.targetPrice}</b>\n`;
        msg += `\n`;
    }

    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, msg, { parse_mode: 'HTML' });
});

// =========================================================
// 🏆 WHY WE ARE THE BEST (GUIDE)
// =========================================================
bot.action('btn_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){} 
    
    const guideText = 
        `🏆 <b>SENTRY TERMINAL — INSTITUTIONAL SUPERIORITY</b>\n\n` +
        `<i>Retail bots are built for convenience, but they leave your capital vulnerable. Sentry Terminal is engineered to protect your trades, optimize speed, and automate your lifecycle. Here is the technical breakdown of why Sentry wins:</i>\n\n` +

        `🚀 <b>1. ELITE TOKEN LAUNCHPAD</b>\n` +
        `We feature a native Pump.fun launcher. We mine a custom **Vanity Contract Address** (e.g. <code>CAT...pump</code>) and split your dev buy across up to 4 sub-wallets simultaneously. The launch, the stealth buys, and the Jito tip are packaged in a single, un-snipeable **Block-0 Jito Bundle**.\n\n` +

        `🛡️ <b>2. JITO MEV PRIVATE BUNDLE ROUTING</b>\n` +
        `Every trade on Sentry—buy, sell, DCA, copy trade, auto-sniper—bypasses the public mempool. We wrap your transaction inside a private Jito Bundle. Your transaction is invisible to MEV sandwich bots until it is securely executed.\n\n` +

        `⚡ <b>3. MULTI-WALLET WHALE EXECUTION</b>\n` +
        `Pump.fun limits how much a single wallet can buy. Sentry fires up to 5 wallets simultaneously inside the same Jito block — same millisecond, same price, no slippage stacking. You get a whale-sized position at retail entry.\n\n` +

        `📅 <b>4. SOLANA TOKEN LAUNCH CALENDAR</b>\n` +
        `Type <code>/calendar</code> to access a live feed of the newest verified token launches. Sentry pulls DexScreener, filters for tokens under 2 hours old with active socials, and lets you target and snipe them in one tap.\n\n` +

        `🤖 <b>5. AI COIN CALLER ENGINE</b>\n` +
        `Type <code>/caller</code> to arm Sentry's scanner. Every 15 seconds it scores tokens 0-100 based on momentum, volume, age, and MEV risk, and DMs you only the ones that pass your thresholds with a one-click buy button.\n\n` +

        `👥 <b>6. COPY TRADING WITH HELIUS AUDITING</b>\n` +
        `Mirror any whale wallet via WebSockets. Before you confirm a target, Sentry scans their last 20 transactions via Helius, scoring their trading frequency to warn you if they are an MEV bot.\n\n` +

        `👀 <b>7. PERSISTENT WATCHLISTS & ALERTS</b>\n` +
        `Type <code>/watch [CA] [TARGET_PRICE]</code> to save tokens to a persistent Redis watchlist. Type <code>/watchlist</code> to check their performance, live prices, and alert status.\n\n` +

        `⏳ <b>8. NATIVE DCA & LIMIT ORDERS</b>\n` +
        `Set a token to accumulate on a TWAP schedule or set a limit order to buy a dip. Both fire via Jito and automatically arm a trailing guard on every fill.\n\n` +

        `🧹 <b>9. RENT SWEEPER & CONSOLIDATOR</b>\n` +
        `Sentry's sweeper closes up to 18 empty token accounts at once via Jito and returns the locked SOL to your wallet instantly. The consolidator sweeps SOL from all sub-wallets back to W1 in one transaction.`;

    await safeEditMessageText(ctx, guideText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]]));
});

// =========================================================
// 📖 HOW TO TRADE MANUAL (PAGINATED)
// =========================================================
const TRADE_GUIDE_PAGES: string[] = [
    // PAGE 1: Getting Started + Instant Trading
    `📖 <b>SENTRY TERMINAL — OPERATIONS MANUAL</b> <i>(1/4)</i>\n\n` +
    `<i>Every method below fires through Jito MEV protection automatically.</i>\n\n` +

    `👛 <b>STEP 1 — FUND YOUR VAULT</b>\n` +
    `Copy your W1 wallet address from the dashboard and send SOL to it. For multi-wallet mode, go to <b>Vault & Keys</b>, activate up to 5 wallets, and fund each address separately.\n\n` +

    `⚡ <b>STEP 2 — INSTANT BUY</b>\n` +
    `Paste any Solana token contract address (CA) directly into the chat. Sentry pulls the token info, runs a rug check, and shows you a confirm card.\n` +
    `• <i>Custom Size Snipe:</i> Paste <code>[CA] [AMOUNT]</code>. You can trade using SOL or the $USD equivalent! (e.g. <code>7xKXtg... 0.5</code> or <code>7xKXtg... $50</code>)\n\n` +

    `🔍 <b>STEP 3 — X-RAY SCANNER</b>\n` +
    `Type <code>/scan [CA]</code> for a full market cap, volume, momentum, and rug-risk report before you commit.\n\n` +

    `📤 <b>WITHDRAW</b>\n` +
    `<code>/withdraw [ADDRESS] [AMOUNT]</code> or use <code>ALL</code> to sweep your full balance minus gas. If you've set a Withdrawal PIN, you'll be prompted for it.\n\n` +

    `🔒 <b>SECURITY PIN</b>\n` +
    `Go to <b>Vault & Keys → Set Withdrawal PIN</b> to require a 4–6 digit code on every withdrawal, protecting you from Telegram session hijacking.`,

    // PAGE 2: Automation Engines
    `📖 <b>OPERATIONS MANUAL — AUTOMATION</b> <i>(2/4)</i>\n\n` +

    `🎯 <b>AUTO-SNIPER</b>\n` +
    `Go to <b>Sniper Module</b>. Configure spend per wallet, market cap filters, max dev bag %, anti-dead-coin shield, and block delay. Sentry scans Pump.fun/Raydium mempool 24/7 and buys instantly.\n\n` +

    `🤖 <b>AI COIN CALLER</b>\n` +
    `Type <code>/caller</code> to arm Sentry's scanner. Every 15 seconds it scores tokens 0–100 on momentum, volume, age, and MEV risk, and DMs you the ones that clear your thresholds with a one-click buy button.\n\n` +

    `👥 <b>COPY TRADING</b>\n` +
    `Go to <b>Copy Trade → Add Custom Wallet</b>.\n` +
    `<i>Syntax:</i> <code>[WALLET] [AMOUNT] [GUARD%] [OPTIONAL TP%]</code>\n` +
    `Sentry audits the wallet's last 20 trades via Helius and scores it before you start mirroring.\n\n` +

    `⏳ <b>DCA & LIMIT ORDERS</b>\n` +
    `Go to <b>Limit / DCA Engine</b>.\n` +
    `• <i>Limit:</i> <code>[CA] [TARGET_USD] [AMOUNT_SOL]</code>\n` +
    `• <i>DCA:</i> <code>[CA] [INTERVAL_MINS] [AMOUNT] [GUARD%] [TP%] [MAX_BUDGET]</code>`,

    // PAGE 3: Risk Management + Tracking
    `📖 <b>OPERATIONS MANUAL — RISK & TRACKING</b> <i>(3/4)</i>\n\n` +

    `🛡️ <b>TRAILING GUARDS</b>\n` +
    `Go to <b>Trailing Stops → Deploy Trailing Guard</b>.\n` +
    `<i>Syntax:</i> <code>[CA] [DROP%] [AMOUNT] [OPTIONAL TP%]</code>\n` +
    `<i>Example:</i> <code>7xKXtg... 15 0.1 50</code> — buys 0.1 SOL, sets a -15% trailing stop, auto-sells at +50% profit.\n\n` +

    `💼 <b>POSITIONS</b>\n` +
    `Go to <b>Positions</b> to view live holdings. Exit 10/25/50/75/100% instantly via Jito. Every sell generates a shareable PnL card.\n\n` +

    `👀 <b>WATCHLISTS & ALERTS</b>\n` +
    `• Add: <code>/watch [CA] [TARGET_PRICE_USD]</code>\n` +
    `• View: <code>/watchlist</code>\n` +
    `• Remove: <code>/unwatch [CA]</code>\n` +
    `• Clear: <code>/clearwatch</code>\n\n` +

    `📅 <b>LAUNCH CALENDAR</b>\n` +
    `Type <code>/calendar</code> for a live feed of newest verified token launches with age, liquidity, and volume — snipe directly from the card.\n\n` +

    `🧹 <b>RENT SWEEPER</b>\n` +
    `Inside <b>Positions</b>, use the sweep button to close empty token accounts and reclaim locked SOL rent instantly.\n\n` +

    `🛑 <b>PANIC CANCEL</b>\n` +
    `Tap <b>Cancel All Automations</b> on your dashboard to instantly disable every sniper, DCA, limit order, copy trade, caller, and guard.`,

    // PAGE 4: Launchpad + Community + Account
    `📖 <b>OPERATIONS MANUAL — LAUNCHPAD & COMMUNITY</b> <i>(4/4)</i>\n\n` +

    `🚀 <b>SENTRY LAUNCHPAD</b>\n` +
    `Tap <b>Launch Token</b>. Enter name, ticker, description, optional vanity prefix, dev buy size, wallet split (1–4), and optional stop-loss guard, then upload a logo. Sentry deploys in one un-snipeable Jito bundle.\n\n` +

    `📂 <b>LAUNCH PORTFOLIO</b>\n` +
    `Manage deployed tokens: check holder distribution, or execute a consolidated multi-wallet exit.\n\n` +

    `🏰 <b>SENTRY GUILDS</b>\n` +
    `Create your own loyalty community with <code>/createguild [Name] | [Description] | [Reward]</code>, or join one with <code>/join [CODE]</code>. Earn 50% of your members' trading fees forever.\n\n` +

    `💰 <b>AFFILIATES</b>\n` +
    `Share your invite link from <b>Affiliates</b>. Earn 40–70% of your recruits' fees depending on your $SENTRY Points tier (Bronze → Diamond).\n\n` +

    `👑 <b>VIP</b>\n` +
    `Type <code>/vipstatus</code> to view or upgrade — 0% trading fees, Turbo Jito priority, and Alpha Directory access.\n\n` +

    `⚙️ <b>SETTINGS</b>\n` +
    `Adjust slippage and Jito priority speed (Eco/Fast/Turbo/Custom) anytime from <b>Settings</b>.\n\n` +

    `<i>Type /cancel at any time to abort any active wizard and return safely to your dashboard.</i>`
];

function buildGuideKeyboard(page: number) {
    const buttons = [];
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Back', `trade_guide_page_${page - 1}`));
    if (page < TRADE_GUIDE_PAGES.length - 1) navRow.push(Markup.button.callback('Next ➡️', `trade_guide_page_${page + 1}`));
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]);
    return Markup.inlineKeyboard(buttons);
}

bot.action('btn_trade_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await safeEditMessageText(ctx, TRADE_GUIDE_PAGES[0], buildGuideKeyboard(0));
});

bot.action(/^trade_guide_page_(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const page = parseInt(ctx.match[1]);
    if (page < 0 || page >= TRADE_GUIDE_PAGES.length) return;
    await safeEditMessageText(ctx, TRADE_GUIDE_PAGES[page], buildGuideKeyboard(page));
});


bot.action('action_create_vault', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const loader = await ctx.reply("<i>⏳ Encrypting local storage node...</i>", { parse_mode: 'HTML' });

    try {
        const vaultData = await generateSecureVault(telegramId);
        
        await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id);

        const step1Text = 
            `👛 <b>STEP 1/3: FUND YOUR VAULT</b>\n\n` +
            `Your secure, zero-latency trading vault has been generated and encrypted on-chain!\n\n` +
            `To prepare your trading capital and gas buffers, deposit SOL into your primary address:\n` +
            `<code>${vaultData.address}</code>\n\n` +
            `<i>Sentry is 100% MEV-protected. When you are ready, click below to set up your speed and slippage.</i>`;

        await ctx.replyWithHTML(step1Text, Markup.inlineKeyboard([[Markup.button.callback('➡️ STEP 2: SETTINGS', 'onboard_step2')]]));
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, "🔴 Vault Generation Failed.");
    }
});

bot.action('onboard_step2', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    
    const step2Text = 
        `⚙️ <b>STEP 2/3: OPTIMAL DEFAULTS</b>\n\n` +
        `To ensure your buy and sell transactions never fail, Sentry applies pre-configured, optimized parameters:\n\n` +
        `• <b>Default Slippage:</b> 20%\n` +
        `  ├ <i>Why?</i> Protects your transactions from failing during high-volatility token launches.\n` +
        `• <b>Priority Fee:</b> Fast 🐎 (0.001 SOL Jito Tip)\n` +
        `  ├ <i>Why?</i> Bypasses public network congestion to guarantee you land in the very next block.\n\n` +
        `<i>You can customize both settings at any time in the Settings menu. Click below to continue.</i>`;

    await ctx.replyWithHTML(step2Text, Markup.inlineKeyboard([[Markup.button.callback('➡️ STEP 3: HOW TO TRADE', 'onboard_step3')]]));
});

bot.action('onboard_step3', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    
    const step3Text = 
        `🎯 <b>STEP 3/3: READY TO SNIPE</b>\n\n` +
        `You are fully prepared to trade. To execute your first transaction:\n\n` +
        `1. Locate any Solana token Contract Address (CA).\n` +
        `2. <b>Paste the CA directly into this chat.</b>\n\n` +
        `<i>Click below to launch your main dashboard and initialize the terminal!</i>`;

    await ctx.replyWithHTML(step3Text, Markup.inlineKeyboard([[Markup.button.callback('🚀 LAUNCH DASHBOARD', 'btn_dashboard')]]));
});





// =========================================================
// 📡 PRIVATE KOL FINDER & LEADERBOARD
// =========================================================


// 🟢 AI PROJECTION CALCULATOR
function calculateAIProjection(token: any) {
    const score = token.score || token.totalScore || 50;
    const liq = token.liquidity || 5000;
    const mom = token.priceChangeM5 || 10;
    const age = token.ageMins || 10;

    // 1. Volatility Index
    let volIndex = "Extreme 🌪️";
    if (liq > 20000) volIndex = "High 🌊";
    if (liq > 50000) volIndex = "Moderate 📊";

    // 2. Peak Calculation (Lower liq + higher score = higher multiplier)
    let baseMultiplier = (score / 100) * 4.5; 
    let liqMultiplier = Math.max(0.5, 20000 / Math.max(liq, 1000)); 
    let momMultiplier = 1 + (Math.min(mom, 300) / 100); 

    let minPeak = baseMultiplier * liqMultiplier * momMultiplier * 100;
    
    // Add some organic variance
    minPeak = minPeak * (0.8 + (Math.random() * 0.4));
    let maxPeak = minPeak * (1.3 + Math.random() * 0.5); 

    // Cap ridiculous numbers to keep it realistic
    if (minPeak > 5000) minPeak = 3500 + Math.random() * 1000;
    if (maxPeak > 10000) maxPeak = 7000 + Math.random() * 2000;
    if (minPeak < 20) { minPeak = 20; maxPeak = 50 + Math.random() * 50; }

    // 3. Timeframe
    let timeframe = "1 - 4 Hours";
    if (age < 15 && mom > 50) timeframe = "10 - 30 Minutes";
    else if (age < 60) timeframe = "30 - 90 Minutes";
    else if (liq > 50000) timeframe = "12 - 24 Hours";

    return {
        target: `+${Math.floor(minPeak).toLocaleString()}% to +${Math.floor(maxPeak).toLocaleString()}%`,
        timeframe,
        volatility: volIndex
    };
}



// 🟢 Handles the manual "Scan Mainnet Now" button with real-time reassurance frames
bot.action('trigger_caller_scan', async (ctx) => {
    try { await ctx.answerCbQuery("🔍 Scanning Solana mainnet..."); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    try {
        const { getCalibratedProjection } = await import('./services/caller.service.js');

        // --- 🎮 SIMULATION INTERCEPT ---
        const { isSimulationActive } = await import('./services/simulation.service.js');
        if (await isSimulationActive(tgId)) {
            await safeEditMessageText(ctx, `🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Calibrating on-chain telemetry & scanning Helius streams...</i>\n\n[░░░░░░░░░░] 0%`, { parse_mode: 'HTML' });
            
            await new Promise(r => setTimeout(r, 600 + Math.random() * 500)); 

            const { getUserCallerFilters } = await import('./services/caller.service.js');
            const { generateSimCallerAlert } = await import('./services/simulation.service.js');
            const filters = await getUserCallerFilters(tgId);
            
            let matchedToken = null;
            
            const cachedHighStr = await redis.get(`sim:high_scorer:${tgId}`);
            if (cachedHighStr) {
                const cachedData = JSON.parse(cachedHighStr);
                if (cachedData.repeatsLeft > 0) {
                    matchedToken = cachedData.token;
                    cachedData.repeatsLeft -= 1;
                    await redis.set(`sim:high_scorer:${tgId}`, JSON.stringify(cachedData), 'EX', 300);
                } else {
                    await redis.del(`sim:high_scorer:${tgId}`);
                }
            }

            if (!matchedToken) {
                matchedToken = await generateSimCallerAlert(tgId, filters); 
                if (matchedToken && matchedToken.score >= 80 && matchedToken.score <= 95) {
                    const repeats = Math.floor(Math.random() * 2) + 1; 
                    await redis.set(`sim:high_scorer:${tgId}`, JSON.stringify({ token: matchedToken, repeatsLeft: repeats }), 'EX', 300);
                }
            }

            if (matchedToken) {
                const projection = await getCalibratedProjection(matchedToken); 
                const projLabel = projection.sampleSize >= 8 ? '🔮 <b>AI PROJECTION (Calibrated)</b>' : '🔮 <b>AI PROJECTION (Uncalibrated Estimate)</b>';

                const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                    `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                    `<b>Score:</b> ${matchedToken.score}/100 ⭐\n\n` +
                    `${projLabel}\n` +
                    `• Confidence: <b>${projection.volatility}</b>\n` +
                    `• Target Peak: <b>${projection.target}</b>\n` +
                    `• Est. Timeframe: <b>${projection.timeframe}</b>\n\n` +
                    `<b>Audit Trail:</b>\n` +
                    `${matchedToken.reasons.map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
                    `<i>Click below to buy instantly via Jito:</i>`;

                return safeEditMessageText(ctx, msg, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [{ text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${matchedToken.mint}_0.1` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
                        [{ text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` }, { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }],
                        [{ text: '🔍 Scan Again', callback_data: 'trigger_caller_scan' }],
                        [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]
                    ]}
                });
            } else {
                return safeEditMessageText(ctx,
                    `⏳ <b>Waiting for fresh blocks...</b>\n\n` +
                    `The simulated pool captured fresh mints, but you have either reviewed them all or none cleared your strict filters.\n\n` +
                    `<i>Sentry is scanning the mempool. Tap 'Scan Again' shortly!</i>\n` +
                    `<code>Last checked: ${new Date().toLocaleTimeString()}</code>`, 
                    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Again', callback_data: 'trigger_caller_scan' }], [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]] } }
                );
            }
        }
        // --- END SIMULATION INTERCEPT ---

        await safeEditMessageText(ctx, `🔍 <b>SENTRY RADAR ACTIVE</b>\n\n<i>Calibrating on-chain telemetry & scanning Helius streams...</i>\n\n[░░░░░░░░░░] 0%`, { parse_mode: 'HTML' });
        
        const { getUserCallerFilters, scoreTokens } = await import('./services/caller.service.js');
        const filters = await getUserCallerFilters(tgId);
        
        // 🟢 FASTER SCANNING: Fetch the background-cached "Hot Tokens" FIRST to avoid API delays
        let topTokens = await redis.get('caller:hot_scored_tokens').then(res => res ? JSON.parse(res) : []);
        
        if (topTokens.length === 0) {
            const scanPromise = scoreTokens();
            const timeoutPromise = new Promise<any>((resolve) => setTimeout(() => resolve('TIMEOUT'), 6000)); 
            const result = await Promise.race([scanPromise, timeoutPromise]);
            if (result === 'TIMEOUT') {
                return safeEditMessageText(ctx, `🔴 <b>Scan Timed Out</b>\n\nThe scanner is taking longer than expected. Try again in a moment.`, {
                    parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_caller' }]] }
                });
            }
            topTokens = result;
        }

        // Standard strict filter
        let matchingTokens = topTokens.filter((t: any) =>
            t.totalScore >= filters.minScore &&
            t.ageMins <= filters.maxAgeMins &&
            (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange)) &&
            ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) || 
             (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
            t.liquidity >= filters.minLiquidity &&
            (!filters.blockMev || (t.breakdown && t.breakdown.mevRisk >= 0))
        );

        // 🟢 FIX 8: Progressive Relaxation - loosen if nothing strictly matches
        let isRelaxed = false;
        if (matchingTokens.length === 0) {
            const relaxedFilters = {
                ...filters,
                minScore: Math.max(20, filters.minScore - 15),
                maxAgeMins: filters.maxAgeMins * 1.5,
                minLiquidity: filters.minLiquidity * 0.5,
                minVolume24h: filters.minVolume24h * 0.5
            };
            matchingTokens = topTokens.filter((t: any) => 
                t.totalScore >= relaxedFilters.minScore &&
                t.ageMins <= relaxedFilters.maxAgeMins &&
                (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= relaxedFilters.minPctChange && t.priceChangeM5 <= relaxedFilters.maxPctChange)) &&
                ((t.sourceQuality !== 'onchain-only' && t.volume >= relaxedFilters.minVolume24h) || 
                 (t.sourceQuality === 'onchain-only' && t.liquidity >= relaxedFilters.minLiquidity)) &&
                t.liquidity >= filters.minLiquidity &&
                (!relaxedFilters.blockMev || (t.breakdown && t.breakdown.mevRisk >= 0))
            );
            if (matchingTokens.length > 0) isRelaxed = true;
        }

        // Sort them highest score first to ensure "gems" pop up instantly
        matchingTokens.sort((a: any, b: any) => b.totalScore - a.totalScore);

        let matchedToken = null;
        for (const t of matchingTokens) {
            const seenKey = `caller_alerted:${tgId}:${t.mint}`;
            const seen = await redis.get(seenKey);
            if (!seen) {
                matchedToken = t;
                await redis.set(seenKey, '1', 'EX', 180); // 🟢 FIX 1: 3 minute cooldown instead of 1 hour
                break;
            }
        }

        // 🟢 FIX 5: Graceful degrade - re-show best match if all matched are seen
        let isReshow = false;
        if (!matchedToken && matchingTokens.length > 0) {
            matchedToken = matchingTokens[0]; // Re-show top scored seen match
            isReshow = true;
        }

        if (matchedToken) {
            const projection = await getCalibratedProjection(matchedToken); 
            
            // 🟢 Store projection history for accuracy loop tracking
            const historyData = {
                mint: matchedToken.mint, symbol: matchedToken.symbol, score: matchedToken.totalScore,
                priceAtAlert: matchedToken.price, alertedAt: Date.now(), tokenAgeAtAlertMins: matchedToken.ageMins,
                predictedRangeLow: projection.rawLow, predictedRangeHigh: projection.rawHigh, predictedTimeframeMins: projection.rawTimeMins
            };
            await redis.hset(`caller_history`, matchedToken.mint, JSON.stringify(historyData));

            const projLabel = projection.sampleSize >= 8 ? '🔮 <b>AI PROJECTION (Calibrated)</b>' : '🔮 <b>AI PROJECTION (Uncalibrated Estimate)</b>';
            const relaxNote = isRelaxed ? `⚠️ <i>Filters temporarily relaxed to find this match.</i>\n\n` : '';
            const reshowNote = isReshow ? `⚠️ <i>Showing previously seen top match (waiting for new tokens).</i>\n\n` : '';

            const msg = `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
                reshowNote +
                relaxNote +
                `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
                `<b>Score:</b> ${matchedToken.totalScore}/100 ⭐\n\n` +
                `${projLabel}\n` +
                `• Confidence: <b>${projection.volatility}</b>\n` +
                `• Target Peak: <b>${projection.target}</b>\n` +
                `• Est. Timeframe: <b>${projection.timeframe}</b>\n\n` +
                `<b>Audit Trail:</b>\n${matchedToken.reasons.map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
                `<i>Click below to buy instantly via Jito:</i>`;

            await safeEditMessageText(ctx, msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${matchedToken.mint}_0.1` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
                        [{ text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` }, { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }],
                        [{ text: '🔍 Scan Again', callback_data: 'trigger_caller_scan' }],
                        [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]
                    ]
                }
            });
        } else {
            await safeEditMessageText(ctx,
                `❌ <b>No Breakouts Found</b>\n\n` +
                `Scanned ${topTokens.length} tokens but none cleared your filters:\n` +
                `• Min Score: <b>${filters.minScore}+</b>\n` +
                `• Max Age: <b>${filters.maxAgeMins}m</b>\n` +
                `• Min Liq/Vol: <b>$${filters.minLiquidity.toLocaleString()} / $${filters.minVolume24h.toLocaleString()}</b>\n\n` +
                `<i>Try lowering your minimums, or check back shortly!</i>\n` +
                `<code>Last checked: ${new Date().toLocaleTimeString()}</code>`, 
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Again', callback_data: 'trigger_caller_scan' }], [{ text: '⬅️ Back to Caller Menu', callback_data: 'menu_caller' }]] } }
            );
        }

    } catch (e: any) {
        console.error("🔴 [CALLER SCAN] Unhandled failure:", e.message);
        try {
            await safeEditMessageText(ctx, `🔴 <b>Scan Aborted:</b> Engine hiccup, please tap again.`, {
                parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_caller' }]] }
            });
        } catch (_) {}
    }
});

bot.command('projectionstats', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;

    const hits = parseInt(await redis.get('projection:hits') || '0');
    const misses = parseInt(await redis.get('projection:misses') || '0');
    const total = hits + misses;

    const accuracy = total > 0 ? ((hits / total) * 100).toFixed(1) : '0.0';

    await ctx.replyWithHTML(
        `🔮 <b>AI PROJECTION CALIBRATION STATS</b>\n\n` +
        `<i>Measures how often the actual peak price lands exactly inside our projected target range.</i>\n\n` +
        `• <b>Total Finalized Projections:</b> ${total}\n` +
        `• <b>Hits (Inside Range):</b> ${hits}\n` +
        `• <b>Misses (Outside Range):</b> ${misses}\n\n` +
        `🎯 <b>Model Accuracy: ${accuracy}%</b>`
    );
});


bot.action('action_deploy_limit', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:limit:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`⏳ <b>DEPLOY LIMIT ORDER</b>\n\nPaste parameters:\n<code>[CA] [TARGET PRICE USD] [AMOUNT SOL OR $USD]</code>\n\n<i>Example (Buy $50 when token hits $0.005):</i>\n<code>JUPyiw... 0.005 $50</code>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_deploy_dca', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:dca:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`⏳ <b>DEPLOY TWAP / DCA ENGINE</b>\n\nPaste parameters:\n<code>[CA] [INTERVAL MINS] [AMOUNT SOL OR $USD] [DROP %] [OPTIONAL TP %] [OPTIONAL MAX BUDGET]</code>\n\n<i>Example (Buy $15 every 60 mins):</i>\n<code>JUPyiw... 60 $15 5 50 $200</code>\n\n<i>Type /cancel to abort.</i>`, { parse_mode: 'HTML' });
});

bot.action(/^caller_dca_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:caller_dca_input:${tgId}`, mint, 'EX', 300);
    await ctx.replyWithHTML(
        `⏳ <b>START TWAP / DCA ENGINE</b>\n\n` +
        `Token: <code>${mint}</code>\n\n` +
        `Reply to this message with your DCA parameters (excluding the CA):\n` +
        `<code>[INTERVAL MINS] [AMOUNT SOL OR $USD] [DROP %] [OPTIONAL TP %] [OPTIONAL MAX BUDGET]</code>\n\n` +
        `<i>Example (Buy $10 every 60 mins, 10% drop, max $100 budget):</i>\n` +
        `<code>60 $10 10 50 $100</code>\n\n` +
        `<i>Type /cancel at any time to abort.</i>`
    );
});



// 🟢 NEW BUTTON ACTIONS: Add these right below your other edit_caller_* actions
bot.action('edit_caller_liq', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_caller_liq:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💧 <b>EDIT MINIMUM LIQUIDITY</b>\n\nReply with the minimum Liquidity (in USD) a token must have.\n<i>Example: 15000 (for $15k minimum liq)</i>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('edit_caller_vol', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:edit_caller_vol:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`📊 <b>EDIT MINIMUM VOLUME</b>\n\nReply with the minimum 24h Volume (in USD) a token must have.\n<i>Example: 50000 (for $50k minimum volume)</i>\n\n<i>Type /cancel to abort.</i>`);
});

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
    if (!isAdmin(tgId)) return;

    const loader = await ctx.reply("<i>⏳ Compiling global platform metrics...</i>", { parse_mode: 'HTML' });

    try {
        const totalUsers = await prisma.user.count();
        const devSuites = await prisma.user.count({ where: { isDevSuiteUnlocked: true } });
        const vips = await prisma.user.count({ where: { isVip: true } });

        const volumeObj = await prisma.user.aggregate({ _sum: { totalVolumeSol: true } });
        const totalVol = volumeObj._sum.totalVolumeSol || 0;
        
        // 🟢 FIX B1: Measure REAL historically charged fees instead of 1% estimate
        const feeAgg = await prisma.trade.aggregate({ _sum: { feeChargedSol: true } });
        const tradeFees = feeAgg._sum.feeChargedSol || 0; 
        const upgradeRev = (devSuites * 6.2) + (vips * 0.2); 
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
    const tgId = ctx.from?.id.toString();
    if (!isAdmin(tgId)) return;

    await redis.set(`state:admin_broadcast`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`📢 <b>GLOBAL BROADCAST</b>\n\nSend the message you want to blast to EVERY user in your database. (HTML formatting supported).\n\n<i>Type /cancel to abort.</i>`);
});

// 🟢 CLAUDE FIX 4.8: Sync Leaderboard Points Logic with Dashboard
bot.command('leaderboard', async (ctx) => {
    const loader = await ctx.replyWithHTML("<i>⏳ Fetching Global Rankings...</i>");
    try {
        const topWhales = await prisma.user.findMany({ 
            orderBy: { totalVolumeSol: 'desc' }, 
            take: 30, 
            select: { username: true, telegramId: true, totalVolumeSol: true, referredById: true, _count: { select: { recruits: true } }, isVip: true, vipSource: true, vipExpiresAt: true }
        });
        
        let board = `🏆 <b>SENTRY TERMINAL LEADERBOARD</b> 🏆\n\n🐋 <b>TOP 20 WHALES ($SENTRY POINTS)</b>\n`;
        
        if (topWhales.length === 0 || topWhales[0].totalVolumeSol === 0) {
            board += `<i>The trenches are empty. Be the first to rank!</i>\n`;
        } else {
            // Sort by actual points formula instead of just volume
            const sortedWhales = topWhales.map((u: any) => {
                const basePoints = Math.floor((u.totalVolumeSol || 0) * 10000);
                const welcomeBonus = u.referredById ? 10000 : 0;
                const recruitBonus = (u._count.recruits || 0) * 2000;
                const pts = basePoints + welcomeBonus + recruitBonus;
                return { ...u, pts };
            }).sort((a, b) => b.pts - a.pts).slice(0, 20);

            sortedWhales.forEach((u: any, i: number) => {
                if (u.pts > 0) {
                    let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🎖️";
                    let daysRemaining = null;
                    if (u.isVip && u.vipExpiresAt) { daysRemaining = Math.ceil((u.vipExpiresAt.getTime() - Date.now()) / 86400000); }
                    const badgeObj = resolveBadge(u.isVip, !!(u.vipExpiresAt && u.vipExpiresAt < new Date()), u.vipSource as any, daysRemaining);
                    const badgeStr = badgeObj.badge ? ` ${badgeObj.badge}` : '';

                    const name = u.username && u.username !== "Trader" ? `@${u.username}` : `Anon_${u.telegramId.substring(u.telegramId.length - 4)}`;
                    board += `${medal} <b>${name}</b>${badgeStr}: ${u.pts.toLocaleString()} PTS\n`;
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
        where: { telegramId: tgId }
    });
    if (!user) return;

    let text = `🛠️ <b>SENTRY DEVELOPER SUITE (PRO)</b>\n\n`;

    if (user.isDevSuiteUnlocked) {
        text += `🟢 <b>ACCESS GRANTED — WELCOME DEV</b>\n\n` +
            `Your institutional developer dashboard is fully active. You have lifetime, unlimited access to Sentry's advanced smart-contract utilities.\n\n` +
            `<i>Configure your Volume Bumpers or plan your Multi-Wallet Nuke below.</i>`;

        await safeEditMessageText(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('📈 Start Volume Bumper', 'action_dev_volume')],
            [Markup.button.callback('💥 NUKE (Sell All Wallets)', 'action_dev_nuke')],
            [Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]
        ]));
    } else {
        text += `<b>WHY SMART DEVS & KOLS UPGRADE TO PRO:</b>\n\n` +
            `📈 <b>1. The Volume Bumper (Save $3,000+)</b>\n` +
            `<i>The Problem:</i> When you launch a coin, the algorithm drops your token from the front page if it lacks constant volume. Shady marketing agencies charge 15-20 SOL to run scripts that get your token flagged by RugCheck.\n` +
            `<i>The Solution:</i> Sentry's Bumper executes automated wash-trading across ALL of your active sub-wallets concurrently within private Jito MEV bundles. It coordinates massive, un-snipeable volume spikes that keep your token trending safely without paying an agency.\n\n` +
            `💥 <b>2. The Nuke Button (Maximum Liquidity Exit)</b>\n` +
            `<i>The Problem:</i> Smart devs split their token supply across multiple wallets. But selling 5 wallets one by one crashes your own chart and loses you thousands to slippage and sandwich bots.\n` +
            `<i>The Solution:</i> The Nuke button compiles the sell orders from all 5 of your wallets into a single, encrypted Jito block. You exit your entire supply in the exact same millisecond at the absolute peak price.\n\n` +
            `<i>Unlock lifetime access to both institutional tools for a one-time fee of <b>6.2 SOL</b>.</i>`;
            
        await safeEditMessageText(ctx, text, Markup.inlineKeyboard([
            [Markup.button.callback('🔓 Unlock Dev Suite (6.2 SOL)', 'action_unlock_devsuite')],
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

    const PRICE_SOL = 6.2; // 🟢 UPDATED TO 6.2 SOL
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

        const payerRawPk = wallets[0].pk ? decryptKey(wallets[0].pk) : null;
        if (!payerRawPk) return;
        const payerKeypair = Keypair.fromSecretKey(bs58.decode(payerRawPk));
        signers.push(payerKeypair); 

        for (let i = 0; i < wallets.length; i++) {
            if (lamportsCollected >= priceLamports) break;
            const w = wallets[i];
            if (!w.pub || !w.pk) continue;
            
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
                        fromPubkey: new PublicKey(w.pub), toPubkey: new PublicKey(treasuryWalletStr), lamports: pullAmount
                    })
                );
                if (i !== 0) signers.push(keypair);
                lamportsCollected += pullAmount;
            }
        }

        if (lamportsCollected < priceLamports) {
            return ctx.replyWithHTML(`🔴 <b>Unlock Failed:</b> Could not compile enough liquid SOL after leaving gas buffers.`);
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: new PublicKey(wallets[0].pub), recentBlockhash: blockhash, instructions
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

        try {
            // 🟢 UPDATED: Only unlocks Dev Suite. No more affiliate increment block here.
            await prisma.user.update({ where: { id: user.id }, data: { isDevSuiteUnlocked: true } });
            
            await ctx.replyWithHTML(`✅ <b>DEV SUITE UNLOCKED!</b>\n\n6.2 SOL compiled from your wallets and processed.\n🔗 <a href="https://solscan.io/tx/${sig}">Receipt</a>`, { link_preview_options: { is_disabled: true } });
            bot.handleUpdate({ ...ctx.update, callback_query: { ...((ctx as any).callbackQuery || {}), data: 'menu_devsuite' } } as any);
        } catch (e: any) {
            console.error("CRITICAL DB WRITE ERROR AFTER PAYMENT:", e.message);
            await ctx.replyWithHTML(`⚠️ <b>Payment Confirmed but Activation Failed!</b>\n\nYour 6.2 SOL payment succeeded, but the database update failed. Please contact support immediately and provide this signature:\n<code>${sig}</code>`);
        }
        
    } catch (e) { await ctx.replyWithHTML(`🔴 <b>Error processing multi-wallet transaction.</b>`); }
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

    const hideWallets = await redis.get(`user_settings:hide_wallets:${telegramId}`) === 'true';

    const levelText = `⚙️ <b>SENTRY CONFIGURATION</b>\n\n` +
        `👛 <b>Current Slippage:</b> ${currentSlippage}%\n` +
        `🚀 <b>Transaction Speed (Jito Bribe):</b> <b>${level}</b> (${currentFeeDisplay})\n\n` +
        `🚕 <b>SLIPPAGE EXPLAINED:</b>\n` +
        `<i>Slippage acts as your protection limit. We recommend 20% to ensure your buys and panic-sells never fail during high volatility.</i>\n\n` +
        `🚀 <b>TRANSACTION SPEED EXPLAINED:</b>\n` +
        `<i>Sentry bypasses public network congestion by tipping the validators (using Jito) to process your trade on Block-0.</i>\n`;

        const UI = Markup.inlineKeyboard([
            [
                Markup.button.callback(level === 'ECO' ? '🟢 Eco 🍃' : 'Eco 🍃', 'set_speed_ECO'),
                Markup.button.callback(level === 'FAST' ? '🟢 Fast 🐎' : 'Fast 🐎', 'set_speed_FAST'),
                Markup.button.callback(level === 'TURBO' ? '🟢 Turbo ⚡' : 'Turbo ⚡', 'set_speed_TURBO')
            ],
            [
                Markup.button.callback(level === 'CUSTOM' ? `🟢 Custom: ${user.customPriorityFee} SOL` : 'Custom ⚙️', 'action_edit_custom_speed'),
                Markup.button.callback(hideWallets ? '👁️ Show Wallets' : '🙈 Hide Wallets', 'toggle_hide_wallets')
            ],
            [Markup.button.callback('✏️ Edit Slippage', 'action_edit_slippage')],
            [Markup.button.callback('🛠️ Pro Tools (Volume Bumper / Nuke)', 'menu_devsuite')],
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

bot.action('toggle_hide_wallets', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const current = await redis.get(`user_settings:hide_wallets:${tgId}`);
    await redis.set(`user_settings:hide_wallets:${tgId}`, current === 'true' ? 'false' : 'true');
    await sendOrEditSettings(ctx, tgId, true);
});
// =========================================================
// 🎯 AUTO-SNIPER MENU CONTROLLER (PURE PUMP.FUN)
// =========================================================
async function sendOrEditSniper(ctx: any, telegramId: string, isEdit: boolean = false) {
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (!user) return;

    let config = user.autoSnipeConfig;
    if (!config) config = await prisma.autoSnipeConfig.create({ data: { userId: user.id, amountSol: 0.01, sniperMode: "PUMP" } });

    const { isSimulationActive } = await import('./services/simulation.service.js');
    const isSimMode = await isSimulationActive(telegramId);
    const isSimActive = isSimMode && (await redis.get(`sim:autosnipe:${telegramId}`) === 'true');
    
    const isCurrentlyActive = isSimMode ? isSimActive : config.isActive;
    const statusObj = isCurrentlyActive ? "🟢 ACTIVE & SCANNING MEMPOOL" : "🔴 OFFLINE (Stopped)";

    let modeDisplay = "💊 PUMP.FUN COINS";
    if (config.sniperMode === "RAYDIUM") modeDisplay = "🧪 RAYDIUM LIQUIDITY POOLS";
    else if (config.sniperMode === "BOTH") modeDisplay = "🔥 BOTH (PUMP.FUN & RAYDIUM)";

    const tpDisplay = config.autoTakeProfitPercent ? `+${config.autoTakeProfitPercent}%` : `OFF`;
    const mcDisplay = `$${(config.minMarketCap || 0).toLocaleString()} - $${(config.maxMarketCap || 100000).toLocaleString()}`;
    const spentSol = config.totalSpentSol || 0;
    const antiDeadObj = config.antiDeadCoin ? "🟢 ON (Active)" : "🔴 OFF (Disabled)"; 
    const devBagDisplay = `${config.maxDevBuyPercent}%`; 
    const scoreDisplay = config.minScore > 0 ? `${config.minScore}/100 ⭐` : `OFF`;

    const sniperText = 
        `🎯 <b>TRENCH AUTO-SNIPER ENGINE</b> 🎯\n` +
        `<i>Sentry scans raw block transitions to front-run listings. Operational parameters explained:</i>\n\n` +
        
        `• <b>Status:</b> ${statusObj}\n` +
        `  ├ <i>Controls active mempool monitoring and execution.</i>\n\n` +

        `• <b>Target Mode:</b> <b>${modeDisplay}</b>\n` +
        `  ├ <i>Specifies listing venues to check (Pump.fun curve, Raydium pool, or both).</i>\n\n` +

        `• <b>Spend Amount:</b> <b>${config.amountSol} SOL</b> per wallet\n` +
        `  ├ <i>Capital spent per node. Multi-wallet mode fires this concurrently.</i>\n\n` +

        `• <b>Max Budget:</b> <b>${config.maxBudgetSol ? config.maxBudgetSol + ' SOL' : 'Infinite (No Limit)'}</b>\n` +
        `  ├ <i>Safety cap that automatically turns off the sniper to prevent draining your wallet.</i>\n\n` +

        `• <b>Total Spent:</b> <b>${spentSol.toFixed(4)} SOL</b>\n` +
        `  ├ <i>Total cumulative SOL deployed by Sentry during your current session.</i>\n\n` +

        `• <b>AI Score Filter:</b> <b>${scoreDisplay}</b>\n` +
        `  ├ <i>Evaluates token stats (liq, volume, age, socials) and blocks trigger if score is too low.</i>\n\n` +

        `• <b>Market Cap Filter:</b> <b>${mcDisplay}</b>\n` +
        `  ├ <i>Valuation limits to avoid buying highly inflated launches or ghost pools.</i>\n\n` +

        `• <b>Max Dev Bag (Dev Limit):</b> <b>${devBagDisplay}</b>\n` +
        `  ├ <i>Aborts snipe if developer buys more than this token supply % in the launch block.</i>\n\n` +

        `• <b>Anti-Dead Shield:</b> ${antiDeadObj}\n` +
        `  ├ <i>Filters out lazy launches where the creator did not buy any of their own supply at mint.</i>\n\n` +

        `• <b>Block Delay:</b> <b>${config.snipeDelaySeconds} Seconds</b>\n` +
        `  ├ <i>Time Sentry waits post-mint to allow on-chain distribution checks to settle.</i>\n\n` +

        `• <b>Auto-Guard:</b> <b>-${config.autoTrailingDropPercent}% Stop Loss</b> | Take Profit: <b>${tpDisplay}</b>\n` +
        `  ├ <i>Deploys cost-basis tracking stop-loss and take-profit targets instantly via Jito.</i>\n`;

    let modeBtnText = '🟢 Mode: Pump.fun 💊';
    if (config.sniperMode === 'RAYDIUM') modeBtnText = '🟢 Mode: Raydium LPs 🧪';
    else if (config.sniperMode === 'BOTH') modeBtnText = '🟢 Mode: BOTH 🔥';

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback(isCurrentlyActive ? '🛑 SHUT DOWN ENGINE' : '⚡ ARM SNIPER ENGINE', 'toggle_autosnipe')],
        [Markup.button.callback(modeBtnText, 'toggle_sniper_mode')],
        [Markup.button.callback(`⭐ AI Min Score (${scoreDisplay})`, 'edit_snipe_score')],
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
        await toggleSimAutoSnipe(tgId, bot);
        await sendOrEditSniper(ctx, tgId!, true); // Smoothly refreshes the real dashboard UI
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

bot.action('edit_snipe_score', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_score:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`⭐ <b>EDIT AI MINIMUM SCORE</b>\nReply with the minimum score (0-100) a token must hit for the sniper to execute. <i>(Type 0 to disable AI filtering)</i>\n<i>Example: 75</i>`);
});

bot.action('edit_snipe_delay', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_delay:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`⏱️ <b>EDIT BLOCK DELAY</b>\nReply with the number of seconds to wait before buying.\n<i>Example: 3</i>`);
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

bot.action('edit_snipe_amt', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_amt:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💰 <b>EDIT SNIPE AMOUNT</b>\nReply with the amount of SOL (e.g. <code>0.2</code>) or USD (e.g. <code>$50</code>) to spend per Auto-Snipe.`);
});

bot.action('edit_snipe_budget', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:autosnipe_budget:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💳 <b>EDIT MAX BUDGET</b>\nReply with the Maximum amount of SOL or USD to spend overall (0 for Infinite).\n<i>Example: 2.5 or $500</i>`);
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
        
        let posText = `💼 <b>YOUR CURRENT BAGS</i>\n\n`;
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

// =========================================================
// 🏰 SENTRY GUILDS (B2B LOYALTY ENGINE)
// =========================================================

bot.action('action_guild_menu', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const text = 
        `🏰 <b>SENTRY GUILDS</b>\n\n` +
        `Trade together, climb leaderboards, and earn revenue shares or WL spots from top KOLs.\n\n` +
        `<i>Select an option below to manage your Guilds:</i>`;

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback('📊 View My Active Guild Status', 'menu_guild_status')],
        [Markup.button.callback('👥 Switch Active Guild', 'menu_switch_guilds')],
        [Markup.button.callback('🛠️ Create / Manage My Own Guild', 'action_manage_guild')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    await safeEditMessageText(ctx, text, UI);
});


// 🟢 Unified Guild Status Display Logic
async function showGuildStatus(ctx: any, isEdit: boolean = false) {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    // Fetch ONLY the active guild membership
    const memberships = await prisma.guildMembership.findMany({ 
        where: { user: { telegramId: tgId }, isActive: true }, 
        include: { guild: true } 
    });

    if (memberships.length === 0) {
        const emptyMsg = `🏰 <b>You are not in any active Guilds.</b>\n\nUse a KOL's invite link to join one, or look at your joined list to activate one!`;
        const emptyKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('👥 My Joined Guilds', 'menu_switch_guilds')],
            [Markup.button.callback('⬅️ Back', 'action_guild_menu')]
        ]);
        
        if (isEdit) return await safeEditMessageText(ctx, emptyMsg, emptyKeyboard);
        return await ctx.replyWithHTML(emptyMsg, emptyKeyboard);
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

    lb.forEach((row: any) => {
        text += `#${row.rank} @${row.username} — ${row.glp.toLocaleString()} GLP\n`;
    });

    const inviteLink = `https://t.me/${ctx.botInfo?.username}?start=guild_${m.guild.guildCode}`;

    const activeKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('👥 Switch Active Guild', 'menu_switch_guilds')],
        [{ text: '🔗 Share My Guild Link', url: `https://t.me/share/url?url=${inviteLink}&text=Join%20my%20Sentry%20Guild%20and%20earn%20WL` }],
        [Markup.button.callback('⬅️ Back', 'action_guild_menu')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, text, activeKeyboard);
    else await ctx.replyWithHTML(text, activeKeyboard);
}

// 🟢 Triggers when a user types /guild
bot.command('guild', async (ctx) => {
    await showGuildStatus(ctx, false);
});

// 🟢 Triggers when a user clicks the "View My Active Guild Status" button
bot.action('menu_guild_status', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await showGuildStatus(ctx, true);
});

bot.action('menu_caller', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await sendCallerMenu(ctx, tgId, true); 
});



// 🟢 CLAUDE FIX 3.1 & 3.6: Unified VIP Handler


// 🟢 VIP PROMO ADMIN CONTROLS
bot.command('startpromo', async (ctx) => {
    try {
        const tgId = ctx.from?.id?.toString();
        if (!isAdmin(tgId)) {
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
        const tgId = ctx.from?.id?.toString();
        if (!isAdmin(tgId)) {
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
        const tgId = ctx.from?.id?.toString();
        if (!isAdmin(tgId)) {
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
                const pnlMatch = result.message.match(/PnL: (-?\+?[\d.]+)%/);
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
                    const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };
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
    await sendOrEditVaultMenu(ctx, ctx.from!.id.toString());
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
    msg += `\n💰 <b>Total Position Value:</b> $${totalUsd.toFixed(2)}`;
    await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, msg, { parse_mode: 'HTML' });
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
    
    // 🟢 FIX: Safely grab the message ID to avoid TypeScript union errors
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (msgId) {
        await redis.zadd('pending_key_deletions', Date.now() + 60000, `${ctx.chat!.id}:${msgId}`);
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
    await sendOrEditVaultMenu(ctx, tgId); // 🟢 FIX: Removes slow fake bot.handleUpdate re-render
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

bot.action('action_deploy_guard', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await redis.set(`state:guard:${tgId}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`🛡️ <b>DEPLOY GUARD & TAKE PROFIT</b>\nPaste parameters:\n<code>[CA] [DROP %] [AMOUNT SOL OR $USD] [OPTIONAL TP %]</code>\n\n<i>Example (Buy $50 with +50% Take Profit):</i>\n<code>JUPyiw... 15 $50 50</code>\n\n<i>Type /cancel at any time to abort.</i>`);
});

bot.action(/^caller_guard_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const mint = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:caller_guard_input:${tgId}`, mint, 'EX', 300);
    await ctx.replyWithHTML(
        `🛡️ <b>DEPLOY GUARD & TAKE PROFIT</b>\n\n` +
        `Token: <code>${mint}</code>\n\n` +
        `Reply to this message with your guard parameters (excluding the CA):\n` +
        `<code>[DROP %] [AMOUNT SOL OR $USD] [OPTIONAL TP %]</code>\n\n` +
        `<i>Example (15% trailing drop, $25 buy, 50% Take Profit):</i>\n` +
        `<code>15 $25 50</code>\n\n` +
        `<i>Type /cancel at any time to abort.</i>`
    );
});

bot.action('action_add_copytrade', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await redis.set(`state:copytrade:${ctx.from?.id.toString()}`, 'AWAITING', 'EX', 300);
    await ctx.replyWithHTML(`👥 <b>NEW COPY TRADE</b>\n\nPaste parameters:\n<code>[TARGET_WALLET] [AMOUNT SOL OR $USD] [DROP_GUARD %] [OPTIONAL_TP %]</code>\n\n<i>Example:</i>\n<code>5Q544fKrFoe... $50 20 50</code>\n\n<i>Type /cancel to abort.</i>`);
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
        // 🟢 FIX: Add Redis Caching to prevent DexScreener IP bans
        let data: any = null;
        const cachedDs = await redis.get(`ds_cache:${ca}`);
        
        if (cachedDs) {
            data = JSON.parse(cachedDs);
        } else {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 8000 });
            data = res.data;
            if (data?.pairs) {
                await redis.set(`ds_cache:${ca}`, JSON.stringify(data), 'EX', 30); // 30s cache
            }
        }

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
        const isRug = await checkTokenRugRisk(ca);
        if (isRug) safeText = "🔴 HIGH RISK (Honeypot/Freeze)";

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


// 🟢 UPDATED: Secured Withdrawal Command
bot.hears(/^\/(withdraw|witdraw|withdrawal) (.+)/i, async (ctx) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const lockout = await redis.get(`withdraw_lockout:${telegramId}`);
    if (lockout) {
        return ctx.replyWithHTML(`🚨 <b>SECURITY LOCKOUT ACTIVE</b>\n\nToo many failed PIN attempts. Withdrawals are locked for 60 minutes to protect your funds.`);
    }

    const withdrawLockKey = `lock:withdraw:${telegramId}`;
    const isLocked = await redis.set(withdrawLockKey, 'LOCKED', 'EX', 60, 'NX');
    if (!isLocked) return ctx.replyWithHTML("⚠️ <b>Withdrawal already processing.</b> Please wait for the current request to settle.");

    const text = (ctx.message as any).text || "";
    const inputParts = text.trim().split(/\s+/);

    // 🟢 SECURITY FIX: Reject the 4th argument entirely to prevent chat-history leakage
    if (inputParts.length !== 3) {
        await redis.del(withdrawLockKey);
        return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Please use: <code>/withdraw [ADDRESS] [AMOUNT]</code> or <code>/withdraw [ADDRESS] ALL</code>`);
    }

    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Authentication Failed. No Vault found.");
    }

    const targetAddress = inputParts[1]!;
    const amountStr = inputParts[2]!.toLowerCase();
    const isMax = amountStr === 'all' || amountStr === 'max';
    const requestedAmount = isMax ? 0 : parseFloat(amountStr);
    
    if (!isMax && (isNaN(requestedAmount) || requestedAmount <= 0)) {
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Invalid amount specified.");
    }

    try { new PublicKey(targetAddress); } 
    catch (e) { await redis.del(withdrawLockKey); return ctx.reply("🔴 Invalid destination Solana address."); }

    if (user.withdrawalPin) {
        await redis.set(`state:withdraw_pin:${telegramId}`, JSON.stringify({ targetAddress, isMax, requestedAmount }), 'EX', 120);
        return ctx.replyWithHTML(`🔒 <b>PIN REQUIRED</b>\n\nPlease reply with your 4 to 6 digit security PIN to authorize this withdrawal.\n\n<i>This message sequence will self-destruct for security.</i>`);
    }

    await executeWithdrawalProcess(user, targetAddress, requestedAmount, isMax, telegramId, ctx, withdrawLockKey);
});

// Helper function to handle the actual sending logic
// Helper function to handle the actual sending logic
async function executeWithdrawalProcess(user: any, targetAddress: string, requestedAmount: number, isMax: boolean, telegramId: string, ctx: any, withdrawLockKey: string) {
    
    // --- 🎮 SIMULATION INTERCEPT ---
    const { isSimulationActive, getSimBalance } = await import('./services/simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        const loader = await ctx.replyWithHTML(`<i>⏳ Submitting transaction to Solana validators. Sweeping in progress...</i>`);
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000)); // Fake network delay
        
        const currentBal = parseFloat(await getSimBalance(telegramId));
        const gasBuffer = 0.00005; // tiny fake gas buffer
        
        let withdrawAmount = isMax ? currentBal - gasBuffer : requestedAmount;
        
        // Check simulated balance limits
        if (withdrawAmount <= 0 || withdrawAmount > currentBal) {
            await redis.del(withdrawLockKey);
            return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Failed:</b> Insufficient balance in your vault to cover the network transfer fee.`, { parse_mode: 'HTML' });
        }
        
        // Deduct from simulated balance
        const newBal = (currentBal - withdrawAmount).toFixed(4);
        await redis.set(`sim:balance:${telegramId}`, newBal);
        
        const { generateSimSignature } = await import('./services/simulation.service.js');
        
        // Exact replica of the real success message (No simulation tags)
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
            `🟢 <b>WITHDRAWAL INITIATED</b>\n\n<b>Total Swept:</b> ~<code>${withdrawAmount.toFixed(4)} SOL</code>\n<b>Destination:</b> <code>${targetAddress}</code>\n\n🔗 <a href="https://solscan.io/tx/${generateSimSignature()}">View Latest Receipt on Solscan</a>`, 
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
        
        await redis.del(withdrawLockKey);
        return;
    }
    // --- END SIMULATION INTERCEPT ---

    const targetPubkey = new PublicKey(targetAddress);
    const loader = await ctx.replyWithHTML(`<i>⏳ Submitting transaction to Solana validators. Sweeping in progress...</i>`);

    try {
        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        let totalSentAmount = 0; 
        let successCount = 0; 
        let finalSignature = "";
        let remainingLamportsToWithdraw = isMax ? Number.MAX_SAFE_INTEGER : Math.floor(requestedAmount * LAMPORTS_PER_SOL);

        for (const w of wallets) {
            if (remainingLamportsToWithdraw <= 0) break;
            if (!w.pub || !w.pk) continue;
            
            const vaultPubkey = new PublicKey(w.pub);
            const liveBalance = await connection.getBalance(vaultPubkey);
            const gasBuffer = 10000; 

            let lamportsToWithdraw = isMax ? liveBalance - gasBuffer : Math.min(remainingLamportsToWithdraw, liveBalance - gasBuffer);
            if (lamportsToWithdraw <= 0) continue; 

            const rawPk = decryptKey(w.pk);
            if (!rawPk) continue;
            
            try {
                const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
                const ix = SystemProgram.transfer({ fromPubkey: vaultPubkey, toPubkey: targetPubkey, lamports: lamportsToWithdraw });
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                const messageV0 = new TransactionMessage({ payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
                const vTx = new VersionedTransaction(messageV0);
                vTx.sign([keypair]);
                
                const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
                
                let isConfirmed = false;
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                    if (status?.value && !status.value.err) { isConfirmed = true; break; }
                }

                if (isConfirmed) {
                    finalSignature = sig;
                    if (!isMax) remainingLamportsToWithdraw -= lamportsToWithdraw;
                    totalSentAmount += (lamportsToWithdraw / LAMPORTS_PER_SOL);
                    successCount++;
                }
            } catch (txError) {}
        }

        if (successCount > 0) {
            await redis.del(`balance_cache:${telegramId}`); 
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `🟢 <b>WITHDRAWAL INITIATED</b>\n\n<b>Total Swept:</b> ~<code>${totalSentAmount.toFixed(4)} SOL</code>\n<b>Destination:</b> <code>${targetPubkey.toBase58()}</code>\n\n🔗 <a href="https://solscan.io/tx/${finalSignature}">View Latest Receipt on Solscan</a>`, 
                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
            );
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Failed:</b> Insufficient balance in your vault to cover the network transfer fee or transaction was dropped.`);
        }
    } catch (e: any) { 
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Error:</b> ${e.message}`); 
    } finally {
        await redis.del(withdrawLockKey);
    }
}

// =========================================================
// 🎁 ADMIN COMMAND: GIVE FREE VIP & DEV SUITE TO KOLS
// =========================================================
bot.command('vip', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return; 

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

// 🟢 P0 FIX #3: AI Caller Instant Buy Button execution
bot.action(/^forcebuy_(.+)_([\d.]+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const amountSol = parseFloat(ctx.match[2]);
    const telegramId = ctx.from?.id.toString()!;
    await ctx.answerCbQuery();

    const snipeLockKey = `lock:global_snipe:${telegramId}`;
    if (!(await redis.set(snipeLockKey, 'LOCKED', 'EX', 3, 'NX'))) {
        return ctx.replyWithHTML("⏳ <b>Rate Limit Exceeded:</b> Please wait 3 seconds before executing another snipe.");
    }

    const loader = await ctx.replyWithHTML(`⚡ <b>EXECUTING SNIPE</b>\n\nTarget: <code>${tokenAddress.substring(0,8)}...</code>\nAmount: <b>${amountSol} SOL</b>`);
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

bot.action(/^confirm_buy_(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const telegramId = ctx.from?.id.toString()!;
    await ctx.answerCbQuery();

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

    // 🟢 C5 FIX: The redundant rug check has been safely removed here!

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
// 🚀 PHOTO CONFIGURATION INTERCEPTOR (BUMPER-FREE CONFIRMATION)
// =========================================================
bot.on('photo', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    
    const launchStep = await redis.get(`token_launch:${tgId}:step`);

    if (launchStep === 'AWAITING_IMAGE') {
        const loader = await ctx.replyWithHTML(`<i>⏳ Uploading metadata configuration and preparing deployment payload...</i>`);
        
        try {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const fileLink = await ctx.telegram.getFileLink(photo.file_id);
            
            const imageRes = await fetch(fileLink.href);
            const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
            
            const { uploadImageToIpfs, TOKEN_LAUNCH_PLATFORM_FEE_SOL } = await import('./services/token_launch.service.js');
            const imageUrl = await uploadImageToIpfs(imageBuffer, `${tgId}_token.png`);
            if (!imageUrl) throw new Error("IPFS upload failed.");
            
            await redis.set(`token_launch:${tgId}:imageUrl`, imageUrl, 'EX', 900);
            await redis.set(`token_launch:${tgId}:step`, 'READY_TO_LAUNCH', 'EX', 900);
            
            const name = await redis.get(`token_launch:${tgId}:name`);
            const symbol = await redis.get(`token_launch:${tgId}:symbol`);
            const description = await redis.get(`token_launch:${tgId}:description`);
            const devBuy = parseFloat(await redis.get(`token_launch:${tgId}:devbuy`) || '0');
            const wallets = parseInt(await redis.get(`token_launch:${tgId}:wallets`) || '1');
            const guard = parseFloat(await redis.get(`token_launch:${tgId}:guard`) || '0');

            // Waive platform fees cleanly for admins
            const isAdminUser = isAdmin(tgId);
            const displayFee = isAdminUser ? 0 : TOKEN_LAUNCH_PLATFORM_FEE_SOL;
            const totalCost = (0.02 + displayFee + devBuy).toFixed(3);

            let featuresTxt = "";
            if (guard > 0) featuresTxt += `🛡️ Auto-Guard: <b>-${guard}% Stop Loss</b>\n`;

            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                `🚀 <b>CONFIRM SECURE DEPLOYMENT</b>\n\n` +
                `• <b>Token Name:</b> ${name}\n` +
                `• <b>Symbol/Ticker:</b> $${symbol}\n` +
                `• <b>Description:</b> ${description}\n` +
                `• <b>Dev Buy Size:</b> ${devBuy} SOL\n` +
                `• <b>Portfolio Allocation:</b> ${wallets} separate wallet nodes\n\n` +
                `${featuresTxt ? `<b>Risk Protection Active:</b>\n${featuresTxt}\n` : ''}` +
                `💳 <b>ESTIMATED COST:</b>\n` +
                `  <code>0.02 SOL</code> (Pump.fun curve fee)\n` +
                `  <code>${displayFee} SOL</code> (Sentry Deployment Fee${isAdminUser ? ' [WAIVED]' : ''})\n` +
                `  <code>${devBuy} SOL</code> (Your Initial Buy)\n` +
                `  <b>~${totalCost} SOL Total</b> (Plus network gas/Jito Tip)\n\n` +
                `<i>Ready to broadcast deployment securely via Block-0 Jito Bundle?</i>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 DEPLOY TOKEN NOW', callback_data: 'action_confirm_token_launch' }],
                            [{ text: '❌ Cancel', callback_data: 'action_abort_token_launch' }]
                        ]
                    }
                }
            );
        } catch (e: any) {
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Error:</b> ${e.message}\nPlease try sending the image again.`, { parse_mode: 'HTML' });
        }
    }
});

// =========================================================
// 🚀 DEPLOYMENT EXECUTOR (SECURE DB SYNC & CARD GENERATION)
// =========================================================
bot.action('action_confirm_token_launch', async (ctx) => {
    const tgId = ctx.from?.id.toString()!;
    const { uploadMetadataToIpfs, launchTokenOnPumpFun } = await import('./services/token_launch.service.js');

    const step = await redis.get(`token_launch:${tgId}:step`);
    if (step !== 'READY_TO_LAUNCH') return ctx.answerCbQuery("Launch session expired.", { show_alert: true });

    const name = await redis.get(`token_launch:${tgId}:name`) || 'Unknown';
    const symbol = await redis.get(`token_launch:${tgId}:symbol`) || 'UNK';
    const description = await redis.get(`token_launch:${tgId}:description`);
    const imageUrl = await redis.get(`token_launch:${tgId}:imageUrl`);
    const vanity = await redis.get(`token_launch:${tgId}:vanity`);
    const devBuy = parseFloat(await redis.get(`token_launch:${tgId}:devbuy`) || '0');
    const wallets = parseInt(await redis.get(`token_launch:${tgId}:wallets`) || '1');
    const guard = parseFloat(await redis.get(`token_launch:${tgId}:guard`) || '0');

    const loader = await ctx.replyWithHTML(`<i>⏳ Submitting setup parameters to IPFS & building custom Jito Block-0 bundle...</i>`);

    await deleteKeysPattern(`token_launch:${tgId}:*`);

    const metadataUri = await uploadMetadataToIpfs(name, symbol, description!, imageUrl!);
    if (!metadataUri) {
        return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Metadata Upload Failed.</b> Please try again.`, { parse_mode: 'HTML' }); 
    }

    const result = await launchTokenOnPumpFun(tgId, name, symbol, description!, metadataUri, devBuy, vanity!, wallets);

    if (result.success && result.tokenAddress) {
        // Write Launch Token row to Prisma DB so it shows in user's Portfolio dashboard
        const launchUser = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (launchUser) {
            await prisma.launchedToken.create({
                data: {
                    userId: launchUser.id,
                    tokenAddress: result.tokenAddress,
                    name,
                    symbol,
                    devBuySol: devBuy,
                    walletCount: wallets
                }
            }).catch(() => {});
        }

        let guardArmed = false;
        if (devBuy > 0 && guard > 0) {
            try {
                let entryPrice = 0.00000003; 
                const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./services/price.service.js');
                const curvePda = getBondingCurveAddress(result.tokenAddress);
                const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                if (accInfo?.data) {
                    entryPrice = decodePumpCurvePrice(accInfo.data.toString('base64'));
                }
                await addTrailingStopToMemory(tgId, result.tokenAddress, guard, devBuy, entryPrice, undefined);
                guardArmed = true;
            } catch (e) {}
        }

        try {
            const { generateLaunchCard } = await import('./services/image.service.js');
            const imageBuffer = await generateLaunchCard(name, symbol, result.tokenAddress, devBuy, wallets);
            const imgId = crypto.randomBytes(8).toString('hex');
            await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200);
            
            const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
            const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
            const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;
            
            // 🟢 UPGRADE: Share to Earn Text & Button
            const tweetText = encodeURIComponent(`Just deployed $${symbol} seamlessly via Sentry Terminal ⚡\n\nJito MEV Protected. Concurrent Whale Routing Active.\n\nJoin my community and trade this token early here 👇\n${shareUrl}`);
            
            const captionText = `✅ <b>TOKEN DEPLOYED SUCCESSFULLY!</b> 🚀\n\n` +
                `• <b>Token Name:</b> ${name} ($${symbol})\n` +
                `• <b>Contract (CA):</b> <code>${result.tokenAddress}</code>\n\n` +
                `${guardArmed ? `🛡️ <b>Auto-Guard Armed:</b> -${guard}% Stop Loss\n` : ''}` +
                `🔗 <a href="https://pump.fun/${result.tokenAddress}">View on Pump.fun</a>\n` +
                `🔗 <a href="https://solscan.io/tx/${result.signature}">View Receipt on Solscan</a>\n\n` +
                `<i>Configure your allocations anytime from your Launch Portfolio.</i>`;

            const form = new FormData();
            form.append('chat_id', tgId);
            form.append('photo', imageBuffer, { filename: 'launch.png', contentType: 'image/png' });
            form.append('caption', captionText);
            form.append('parse_mode', 'HTML');
            form.append('reply_markup', JSON.stringify({
                inline_keyboard: [
                    [{ text: '🐦 Share Launch & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }],
                    [{ text: '📂 Manage Launch Portfolio', callback_data: 'menu_my_launches' }],
                    [{ text: '⬅️ Dashboard', callback_data: 'btn_dashboard' }]
                ]
            }));

            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { 
                method: 'POST', body: form as any, headers: form.getHeaders()
            });
            await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
                `✅ <b>TOKEN DEPLOYED SUCCESSFULLY!</b> 🚀\n\n` +
                `• <b>Contract (CA):</b> <code>${result.tokenAddress}</code>\n` +
                `🔗 <a href="https://pump.fun/${result.tokenAddress}">View on Pump.fun</a>`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📂 Manage Launch Portfolio', callback_data: 'menu_my_launches' }]] } }
            );
        }
    } else {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
            `🔴 <b>Launch Failed:</b>\n<code>${result.message}</code>\n\nCheck that you have enough SOL in your Main Wallet (W1).`,
            { parse_mode: 'HTML' }
        );
    }
});


// 🟢 CLAUDE FIX 4.2: Use `isDevSuiteUnlocked` instead of `isAdmin`
bot.action('action_dev_volume', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }});
    if (!user || !user.isDevSuiteUnlocked) return ctx.answerCbQuery("🔴 Access Restricted. Unlock Dev Suite.", { show_alert: true });

    await redis.set(`state:dev_volume:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `📈 <b>AUTOMATED TRADING UTILITY</b>\n\n` +
        `Reply with your configuration:\n` +
        `<code>[CA] [TRADE_SIZE_SOL] [MAX_FEE_BUDGET] [DELAY_SECONDS]</code>\n\n` +
        `<i>Example:</i>\n` +
        `<code>74SBV4z... 0.02 0.5 4</code>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

bot.action('action_dev_nuke', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }});
    if (!user || !user.isDevSuiteUnlocked) return ctx.answerCbQuery("🔴 Access Restricted. Unlock Dev Suite.", { show_alert: true });

    await redis.set(`state:dev_nuke:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`💥 <b>CONSOLIDATED EXIT</b>\n\nReply with the Token CA. Sentry will execute a concurrent exit across all active wallets simultaneously.\n\n<i>Type /cancel to abort.</i>`);
});

bot.action(/^launch_vol_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const ca = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }});
    if (!user || !user.isDevSuiteUnlocked) return ctx.answerCbQuery("🔴 Access Restricted. Unlock Dev Suite.", { show_alert: true });

    await redis.set(`state:dev_volume:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `📈 <b>AUTOMATED TRADING UTILITY</b>\n\n` +
        `Reply with your configuration for <code>${ca}</code>:\n` +
        `<code>${ca} [TRADE_SIZE_SOL] [MAX_FEE_BUDGET] [DELAY_SECONDS]</code>\n\n` +
        `<i>Example (Trades 0.02 SOL, stops after 0.5 SOL fees, waits 4s):</i>\n` +
        `<code>${ca} 0.02 0.5 4</code>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});




// =========================================================
// 📂 LAUNCH PORTFOLIO & PORTFOLIO DELEGATION TOOLS
// =========================================================
bot.action('menu_my_launches', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { launchedTokens: { orderBy: { launchedAt: 'desc' } } } });
    if (!user || user.launchedTokens.length === 0) {
        return safeEditMessageText(ctx, `📂 <b>MY LAUNCH PORTFOLIO</b>\n\nYou haven't launched any tokens yet. Deploy a token using Sentry to manage it here.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_token_launcher')]]));
    }

    let text = `📂 <b>MY LAUNCH PORTFOLIO</b>\n\n<i>Select a token below to review on-chain distribution metrics or manage standard concurrent position entries:</i>\n\n`;
    const buttons = user.launchedTokens.map(t => [Markup.button.callback(`🚀 ${t.name} ($${t.symbol})`, `manage_launch_${t.tokenAddress}`)]);
    buttons.push([Markup.button.callback('⬅️ Back', 'menu_token_launcher')]);

    await safeEditMessageText(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action(/^manage_launch_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tokenAddress = ctx.match[1];

    const token = await prisma.launchedToken.findUnique({ where: { tokenAddress } });
    if (!token) return;

    let mcap = "Live";
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (res.data?.pairs && res.data.pairs.length > 0) { mcap = `$${res.data.pairs[0].fdv?.toLocaleString() || "Live"}`; }
    } catch (e) {}

    const text = `⚙️ <b>MANAGE: ${token.name} ($${token.symbol})</b>\n\n` +
                 `📝 <b>CA:</b> <code>${tokenAddress}</code>\n` +
                 `📊 <b>Live Market Cap:</b> ${mcap}\n\n` +
                 `<i>Select an operational command:</i>`;

    const buttons = [
        [Markup.button.callback('🔍 Check Holder Distribution', `launch_holders_${tokenAddress}`)],
        [Markup.button.callback('💥 Multi-Wallet Position Exit', `launch_nuke_${tokenAddress}`)],
        [Markup.button.url('🔗 View on Pump.fun', `https://pump.fun/${tokenAddress}`)],
        [Markup.button.callback('⬅️ Back to Portfolio', 'menu_my_launches')]
    ];

    await safeEditMessageText(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action(/^launch_holders_(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    try { await ctx.answerCbQuery("🔍 Scanning blockchain for holder distribution..."); } catch(e){}

    const loader = await ctx.reply("<i>⏳ Fetching largest token accounts via RPC...</i>", { parse_mode: 'HTML' });

    try {
        const largest = await connection.getTokenLargestAccounts(new PublicKey(tokenAddress));
        
        let holderMsg = `📊 <b>HOLDER DISTRIBUTION AUDIT</b>\nToken: <code>${tokenAddress.substring(0,8)}...</code>\n\n`;
        
        largest.value.slice(0, 15).forEach((h, i) => {
            const addressStr = h.address.toBase58();
            const pct = (h.uiAmount! / 1000000000) * 100;
            const alert = pct >= 15 ? '🚨' : pct >= 5 ? '⚠️' : '✅';
            holderMsg += `${i+1}. <code>${addressStr.substring(0,8)}...</code>: <b>${pct.toFixed(2)}%</b> ${alert}\n`; 
        });

        holderMsg += `\n<i>Verify initial wallet allocations and analyze the top token holders for transparent metrics.</i>`;

        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, holderMsg, { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: `manage_launch_${tokenAddress}` }]] }
        });
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Error fetching holders:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

bot.action(/^launch_nuke_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const ca = ctx.match[1];
    const tgId = ctx.from?.id.toString()!;
    
    await redis.set(`state:dev_nuke:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `💥 <b>MULTI-WALLET POSITION EXIT</b>\n\n` +
        `This will initiate a consolidated sell order of 100% of your holdings for <code>${ca}</code> across all active wallets.\n\n` +
        `Please confirm your intention by replying with the Token Contract Address (CA) below:\n` +
        `<code>${ca}</code>\n\n` +
        `<i>Type /cancel to abort.</i>`
    );
});

// =========================================================
// ⚡ TEXT INTERCEPTOR: (Catches Redis States & Snipes)
// =========================================================

// =========================================================
// ⚡ TEXT INTERCEPTOR: (Catches Redis States & Snipes)
// =========================================================

async function deleteKeysPattern(pattern: string) {
    
    let cursor = '0';
    do {
        const [nextCursor, elements] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (elements.length > 0) await redis.del(...elements);
    } while (cursor !== '0');
}

bot.on("text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return next();

    

    // 🟢 GLOBAL CANCEL
    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
        const keysToClear = [
            `state:guard:${telegramId}`, `state:dca:${telegramId}`, `state:limit:${telegramId}`, 
            `state:copytrade:${telegramId}`, `state:import_key:${telegramId}`, `state:autosnipe_amt:${telegramId}`, 
            `state:autosnipe_sl:${telegramId}`, `state:autosnipe_delay:${telegramId}`, `state:autosnipe_tp:${telegramId}`, 
            `state:autosnipe_mc:${telegramId}`, `state:autosnipe_budget:${telegramId}`, `state:autosnipe_dev:${telegramId}`, 
            `state:enter_ref:${telegramId}`, `state:edit_slippage:${telegramId}`, `state:edit_custom_speed:${telegramId}`, 
            `state:dev_volume:${telegramId}`, `state:dev_nuke:${telegramId}`,
            `active_bumper:${telegramId}`, `state:edit_caller_age:${telegramId}`, `state:edit_caller_pct:${telegramId}`,
            `state:caller_guard_input:${telegramId}`, `state:caller_dca_input:${telegramId}`,
            `state:edit_caller_score:${telegramId}`, `state:edit_caller_liq:${telegramId}`, `state:edit_caller_vol:${telegramId}`,
            `sim:autosnipe:${telegramId}`, `sim:caller_seq:${telegramId}`, `state:guard_ca:${telegramId}`,
            `state:guild_tiered_drop:${telegramId}`, `state:guild_indiv_drop:${telegramId}`,
            `state:edit_guild_name:${telegramId}`, `state:edit_guild_reward:${telegramId}`,
            `state:guild_airdrop:${telegramId}`, `vip:awaiting_tx:${telegramId}`,
            `state:set_pin:${telegramId}`, `state:withdraw_pin:${telegramId}`
        ];
        
        await redis.del(...keysToClear); 
        await deleteKeysPattern(`token_launch:${telegramId}:*`);

        await ctx.replyWithHTML(`✅ <b>Action Cancelled. Automations & Bumpers Paused.</b> You are back to the main menu.`);
        await sendOrEditDashboard(ctx, telegramId, false);
        return;
    }
    
    // 🟢 VIP PAYMENT HANDLER
    const pendingVipTier = await redis.get(`vip:awaiting_tx:${telegramId}`);
    if (pendingVipTier) {
        await redis.del(`vip:awaiting_tx:${telegramId}`);
        const txSig = text.trim();
        const loader = await ctx.replyWithHTML(`<i>⏳ Verifying VIP payment on-chain...</i>`);
        try {
            const user = await prisma.user.findUnique({ where: { telegramId } });
            const { VIP_TIERS, verifyVipPayment, grantVip } = await import('./services/vip.service.js');
            const tierDef = VIP_TIERS[pendingVipTier as keyof typeof VIP_TIERS];
            const treasury = process.env.TREASURY_WALLET_ADDRESS!;
            
            const verifyRes = await verifyVipPayment(txSig, tierDef.priceSol, treasury, user!.vaultAddress!);
            if (verifyRes.valid) {
                await grantVip(telegramId, pendingVipTier as any, 'purchased', txSig);
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>VIP ACTIVATED!</b>\n\nYour account has been successfully upgraded to <b>${tierDef.label}</b>.`, { parse_mode: 'HTML' });
                await sendOrEditDashboard(ctx, telegramId, false);
            } else {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Verification Failed:</b> ${verifyRes.reason}\n\nIf you sent the SOL, please contact support with your signature.`, { parse_mode: 'HTML' });
            }
        } catch (e: any) {
            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Error:</b> ${e.message}`, { parse_mode: 'HTML' });
        }
        return;
    }

    // 🟢 SECURITY: Hashed PIN Setup
    if (await redis.get(`state:set_pin:${telegramId}`)) {
        await redis.del(`state:set_pin:${telegramId}`);
        try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){} 
        
        const pin = text.trim();
        if (!/^\d{4,6}$/.test(pin)) {
            return ctx.replyWithHTML(`🔴 <b>Invalid PIN.</b> Must be exactly 4 to 6 numeric digits. Process aborted.`);
        }

        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (user) {
            const userSalt = telegramId + process.env.BOT_TOKEN!;
            const hashedPin = crypto.scryptSync(pin, userSalt, 32).toString('hex');
            await prisma.user.update({ where: { id: user.id }, data: { withdrawalPin: hashedPin } }); 
            await ctx.replyWithHTML(`✅ <b>Security PIN Set Successfully!</b>\n\nYour account is now protected. All future withdrawals will require this PIN in a secure secondary prompt.`);
            await sendOrEditVaultMenu(ctx, telegramId);
        }
        return;
    }

    // 🟢 SECURITY: Withdrawal Execution
    const pendingWithdrawalStr = await redis.get(`state:withdraw_pin:${telegramId}`);
    if (pendingWithdrawalStr) {
        await redis.del(`state:withdraw_pin:${telegramId}`);
        try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){} 

        const user = await prisma.user.findUnique({ where: { telegramId } });
        const submittedHash = crypto.scryptSync(text.trim(), process.env.BOT_TOKEN!, 32).toString('hex');

        if (user && user.withdrawalPin !== submittedHash) {
            const attemptsKey = `pin_fails:${telegramId}`;
            const fails = await redis.incr(attemptsKey);
            if (fails === 1) await redis.expire(attemptsKey, 3600);

            if (fails >= 3) {
                await redis.set(`withdraw_lockout:${telegramId}`, 'LOCKED', 'EX', 3600); 
                await redis.del(`lock:withdraw:${telegramId}`);
                return ctx.replyWithHTML(`🚨 <b>SECURITY LOCKOUT</b>\n\nToo many failed PIN attempts. Withdrawals are locked for 60 minutes to protect your funds.`);
            }
            await redis.del(`lock:withdraw:${telegramId}`);
            return ctx.replyWithHTML(`🔴 <b>Incorrect PIN.</b> Attempt ${fails} of 3. Please request a new withdrawal.`);
        }

        await redis.del(`pin_fails:${telegramId}`);
        const withdrawData = JSON.parse(pendingWithdrawalStr);
        await executeWithdrawalProcess(user, withdrawData.targetAddress, withdrawData.requestedAmount, withdrawData.isMax, telegramId, ctx, `lock:withdraw:${telegramId}`);
        return;
    }

    // 🟢 TOKEN LAUNCH WIZARD
    const launchStep = await redis.get(`token_launch:${telegramId}:step`);
    if (launchStep) {
        if (launchStep === 'AWAITING_NAME') {
            await redis.set(`token_launch:${telegramId}:name`, text, 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_SYMBOL', 'EX', 900);
            return ctx.replyWithHTML(`✅ Name saved.\n\n<b>Step 2/8:</b> What is your token <b>Ticker/Symbol</b>?\n<i>(e.g., DOGE) Max 10 chars.</i>`);
        }
        if (launchStep === 'AWAITING_SYMBOL') {
            const symbol = text.toUpperCase().trim().replace(/[^A-Z0-9]/g, '').substring(0, 10);
            await redis.set(`token_launch:${telegramId}:symbol`, symbol, 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_DESC', 'EX', 900);
            return ctx.replyWithHTML(`✅ Symbol saved as <b>$${symbol}</b>\n\n<b>Step 3/8:</b> Enter a short <b>Description</b> for your token:`);
        }
        if (launchStep === 'AWAITING_DESC') {
            await redis.set(`token_launch:${telegramId}:description`, text, 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_VANITY', 'EX', 900);
            return ctx.replyWithHTML(`✅ Description saved.\n\n<b>Step 4/8:</b> Do you want a <b>Vanity Contract Address</b>?\n\nIf you want your CA to start with specific letters (e.g., <code>CAT</code>), enter 2 to 4 letters here.\n\n<i>Type <b>NO</b> for a standard random address.</i>`);
        }
        if (launchStep === 'AWAITING_VANITY') {
            const prefix = text.toUpperCase().trim();
            await redis.set(`token_launch:${telegramId}:vanity`, prefix, 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_DEVBUY', 'EX', 900);
            return ctx.replyWithHTML(`✅ Vanity preference saved.\n\n<b>Step 5/8:</b> How much SOL do you want to <b>allocate</b> to your initial buy?\n<i>(Enter a number, e.g., 0.5. Enter 0 for no initial purchase)</i>`);
        }
        if (launchStep === 'AWAITING_DEVBUY') {
            const buyAmt = parseFloat(text);
            if (isNaN(buyAmt) || buyAmt < 0) return ctx.replyWithHTML("⚠️ Invalid amount. Please enter a number.");
            await redis.set(`token_launch:${telegramId}:devbuy`, buyAmt.toString(), 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_SPLIT', 'EX', 900);
            return ctx.replyWithHTML(`✅ Initial allocation set to <b>${buyAmt} SOL</b>.\n\n<b>Step 6/8: Portfolio Risk Division</b> 🐋\nAcross how many distinct wallets do you want Sentry to distribute your initial allocation buy?\n\n<i>Enter a number from <b>1 to 4</b>.</i>`);
        }
        if (launchStep === 'AWAITING_SPLIT') {
            const wallets = parseInt(text);
            if (isNaN(wallets) || wallets < 1 || wallets > 4) return ctx.replyWithHTML("⚠️ Invalid. Please enter 1, 2, 3, or 4.");
            await redis.set(`token_launch:${telegramId}:wallets`, wallets.toString(), 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_GUARD', 'EX', 900);
            return ctx.replyWithHTML(`✅ Risk division set to <b>${wallets} Wallets</b>.\n\n<b>Step 7/8: Capital Protection</b> 🛡️\nDo you want to deploy an automatic trailing Stop-Loss guard on this initial buy to protect your capital?\n<i>Enter the drop percentage (e.g., 40), or enter <b>0</b> to skip.</i>`);
        }
        if (launchStep === 'AWAITING_GUARD') {
            const guard = parseFloat(text);
            if (isNaN(guard) || guard < 0 || guard > 99) return ctx.replyWithHTML("⚠️ Invalid. Enter 0 to 99.");
            await redis.set(`token_launch:${telegramId}:guard`, guard.toString(), 'EX', 900);
            await redis.set(`token_launch:${telegramId}:step`, 'AWAITING_IMAGE', 'EX', 900);
            return ctx.replyWithHTML(`✅ Stop-Loss configured at <b>${guard > 0 ? '-' + guard + '%' : 'OFF'}</b>.\n\n<b>Step 8/8:</b> Please send an <b>Image</b> (JPG/PNG) to configure your project's logo and finalize metadata deployment.`);
        }
        return;
    }

    if (text.startsWith("/")) return next();

    // 🟢 GENERAL SETTINGS & INPUTS
    try {
        if (await redis.get(`state:edit_slippage:${telegramId}`)) {
            await redis.del(`state:edit_slippage:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 1 || val > 100) return ctx.replyWithHTML(`🔴 <b>Invalid Slippage.</b> Must be between 1 and 100.`);
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (user) { 
                await prisma.user.update({ where: { id: user.id }, data: { slippagePercent: val } }); 
                await ctx.replyWithHTML(`✅ <b>Slippage successfully updated to ${val}%.</b>`);
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
            }
            return;
        }

        const callerGuardCA = await redis.get(`state:caller_guard_input:${telegramId}`);
        if (callerGuardCA) {
            await redis.del(`state:caller_guard_input:${telegramId}`);
            const parts = text.trim().split(/\s+/);
            if (parts.length !== 2 && parts.length !== 3) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please reply with: <code>[DROP %] [AMOUNT SOL OR $USD] [OPTIONAL TP %]</code>");
            
            const trailPct = parseFloat(parts[0]); 
            const solAmt = parseSolAmount(parts[1]); 
            const tpPct = parts.length === 3 ? parseFloat(parts[2]) : undefined;
            if (isNaN(trailPct) || solAmt === null || (tpPct !== undefined && isNaN(tpPct))) return ctx.reply("🔴 Invalid numbers provided. Example: 15 $50 50");

            const loader = await ctx.replyWithHTML(`<i>⏳ Executing Jito Trade & Syncing Guard...</i>`);
            try {
                const buyResult = await executeSnipe(telegramId, callerGuardCA, solAmt);
                if (!buyResult.success) return await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `${buyResult.message}`, { parse_mode: 'HTML' });

                let initialPriceNative = 0;
                try {
                    const priceRes = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${callerGuardCA}`).catch(() => null);
                    initialPriceNative = priceRes?.data?.data?.[callerGuardCA]?.price || 0;
                } catch (_) {}

                await addTrailingStopToMemory(telegramId, callerGuardCA, trailPct, solAmt, initialPriceNative, tpPct);
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `🟢 <b>BUY & GUARD SUCCESSFUL!</b>\n\nToken: <code>${callerGuardCA.substring(0,8)}...</code>\nInvested: <b>${solAmt} SOL</b>\nTrailing Drop: <b>-${trailPct}%</b>\nTake Profit: ${tpPct ? `<b>+${tpPct}%</b>` : `<i>Not Set</i>`}\n\n🔗 <a href="https://solscan.io/tx/${buyResult.signature}">View on Solscan</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            } catch (e: any) { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Error:</b> ${e.message}`, { parse_mode: 'HTML' }); }
            return;
        }

        const callerDcaCA = await redis.get(`state:caller_dca_input:${telegramId}`);
        if (callerDcaCA) {
            await redis.del(`state:caller_dca_input:${telegramId}`);
            try {
                const parts = text.trim().split(/\s+/);
                if (parts.length < 3 || parts.length > 5) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please reply with: <code>[INTERVAL] [AMOUNT SOL OR $USD] [DROP %] [OPTIONAL TP] [OPTIONAL BUDGET]</code>");

                const intervalMins = parseInt(parts[0]); 
                const solAmt = parseSolAmount(parts[1]); 
                const dropPct = parseFloat(parts[2]);
                const tpPct = (parts.length >= 4 && parseFloat(parts[3]) !== 0) ? parseFloat(parts[3]) : undefined;
                const maxBudget = parts.length === 5 ? parseSolAmount(parts[4], true) : undefined;

                if (isNaN(intervalMins) || solAmt === null || isNaN(dropPct)) return ctx.reply("🔴 Invalid numbers provided. Example amount: 0.5 or $50");
                const user = await prisma.user.findUnique({ where: { telegramId } });
                if (!user) return ctx.reply("🔴 User not found.");

                await prisma.activeOrder.create({
                    data: { userId: user.id, tokenAddress: callerDcaCA, orderType: 'DCA', amountSol: solAmt, dcaIntervalMins: intervalMins, trailingPercent: dropPct, takeProfitPercent: tpPct || null, maxBudgetSol: maxBudget || null, isActive: true }
                });

                return ctx.replyWithHTML(`🟢 <b>TWAP/DCA SCHEDULE DEPLOYED</b>\n\nToken: <code>${callerDcaCA.substring(0,8)}...</code>\nInterval: <b>Every ${intervalMins} Minutes</b>\nAmount: <b>${solAmt} SOL per interval</b>\nMax Budget: <b>${maxBudget ? `${maxBudget} SOL` : 'Infinite'}</b>\nGuard: <b>-${dropPct}%</b>\nTake Profit: <b>${tpPct ? `+${tpPct}%` : 'Not Set'}</b>`);
            } catch (e: any) { return ctx.reply(`🔴 Error deploying DCA: ${e.message}`); }
        }

        if (await redis.get(`state:edit_caller_age:${telegramId}`)) {
            await redis.del(`state:edit_caller_age:${telegramId}`);
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 0) return ctx.replyWithHTML("🔴 <b>Invalid Age.</b> Must be a positive number.");
            const { setUserCallerFilters } = await import('./services/caller.service.js');
            await setUserCallerFilters(telegramId, { maxAgeMins: val });
            await ctx.replyWithHTML(`✅ <b>Max Age updated to ${val} minutes!</b>`);
            await sendCallerMenu(ctx, telegramId, false);
            return;
        }

        if (await redis.get(`state:edit_caller_pct:${telegramId}`)) {
            await redis.del(`state:edit_caller_pct:${telegramId}`);
            const parts = text.trim().split(/\s+/);
            if (parts.length !== 2) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Use: <code>[MIN_%] [MAX_%]</code> (Example: <code>10 500</code>)");
            const min = parseFloat(parts[0]); const max = parseFloat(parts[1]);
            if (isNaN(min) || isNaN(max) || min > max) return ctx.replyWithHTML("🔴 <b>Invalid Range.</b>");
            const { setUserCallerFilters } = await import('./services/caller.service.js');
            await setUserCallerFilters(telegramId, { minPctChange: min, maxPctChange: max });
            await ctx.replyWithHTML(`✅ <b>Percentage Range updated to ${min}% - ${max}%!</b>`);
            return;
        }

        if (await redis.get(`state:edit_caller_score:${telegramId}`)) {
            await redis.del(`state:edit_caller_score:${telegramId}`);
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 0 || val > 100) return ctx.replyWithHTML("🔴 <b>Invalid Score.</b> Must be between 0 and 100.");
            const { setUserCallerFilters } = await import('./services/caller.service.js');
            await setUserCallerFilters(telegramId, { minScore: val });
            await ctx.replyWithHTML(`✅ <b>Minimum Score updated to ${val}!</b>`);
            return;
        }

        if (await redis.get(`state:edit_caller_liq:${telegramId}`)) {
            await redis.del(`state:edit_caller_liq:${telegramId}`);
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 0) return ctx.replyWithHTML("🔴 <b>Invalid Amount.</b> Must be a positive number.");
            const { setUserCallerFilters } = await import('./services/caller.service.js'); 
            await setUserCallerFilters(telegramId, { minLiquidity: val });
            await ctx.replyWithHTML(`✅ <b>Min Liquidity updated to $${val.toLocaleString()}!</b>`);
            return;
        }

        if (await redis.get(`state:edit_caller_vol:${telegramId}`)) {
            await redis.del(`state:edit_caller_vol:${telegramId}`);
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 0) return ctx.replyWithHTML("🔴 <b>Invalid Amount.</b> Must be a positive number.");
            const { setUserCallerFilters } = await import('./services/caller.service.js');
            await setUserCallerFilters(telegramId, { minVolume24h: val });
            await ctx.replyWithHTML(`✅ <b>Min 24h Volume updated to $${val.toLocaleString()}!</b>`);
            return;
        }
        
        const tieredGuildId = await redis.get(`state:guild_tiered_drop:${telegramId}`);
        if (tieredGuildId) {
            await redis.del(`state:guild_tiered_drop:${telegramId}`);
            const parts = text.trim().split(/\s+/);
            if (parts.length !== 3) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please use: <code>[SOL_TOP_3] [SOL_NEXT_7] [SOL_RANKS_11_TO_50]</code>");
            const amtTop3 = parseFloat(parts[0]); const amtTop10 = parseFloat(parts[1]); const amtTop50 = parseFloat(parts[2]);
            if (isNaN(amtTop3) || isNaN(amtTop10) || isNaN(amtTop50) || amtTop3 < 0 || amtTop10 < 0 || amtTop50 < 0) return ctx.replyWithHTML("🔴 <b>Invalid Payout parameters.</b>");

            const loader = await ctx.replyWithHTML("<i>⏳ Packing tiered transfers and submitting Jito bundle...</i>");
            const { executeTieredAirdrop } = await import('./services/guild.service.js');
            const res = await executeTieredAirdrop(telegramId, tieredGuildId, amtTop3, amtTop10, amtTop50);
            
            if (res.success) {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>TIERED AIRDROP COMPLETE!</b>\n\n${res.message}\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Transaction</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            } else { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Airdrop Failed:</b> ${res.message}`, { parse_mode: 'HTML' }); }
            return;
        }

        const indivGuildId = await redis.get(`state:guild_indiv_drop:${telegramId}`);
        if (indivGuildId) {
            await redis.del(`state:guild_indiv_drop:${telegramId}`);
            const parts = text.trim().split(/\s+/);
            if (parts.length !== 2) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Please use: <code>[TARGET_RANK] [AMOUNT_SOL]</code>");
            const targetRank = parseInt(parts[0]); const amountSol = parseFloat(parts[1]);
            if (isNaN(targetRank) || isNaN(amountSol) || targetRank <= 0 || amountSol <= 0) return ctx.replyWithHTML("🔴 <b>Invalid Payout parameters.</b>");

            const loader = await ctx.replyWithHTML("<i>⏳ Processing individual transfer via Jito...</i>");
            const { executeIndividualAirdrop } = await import('./services/guild.service.js');
            const res = await executeIndividualAirdrop(telegramId, indivGuildId, targetRank, amountSol);
            
            if (res.success) {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>PAYOUT SUCCESSFUL!</b>\n\n${res.message}\n\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Transaction</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            } else { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Payout Failed:</b> ${res.message}`, { parse_mode: 'HTML' }); }
            return;
        }     

        const editGuildNameId = await redis.get(`state:edit_guild_name:${telegramId}`);
        if (editGuildNameId) {
            await redis.del(`state:edit_guild_name:${telegramId}`);
            if (text.length < 3 || text.length > 30) return ctx.replyWithHTML("🔴 <b>Error:</b> Name must be between 3 and 30 characters.");
            await prisma.guild.update({ where: { id: editGuildNameId }, data: { name: text.trim() } });
            await ctx.replyWithHTML(`✅ <b>Guild Name successfully updated to:</b> <code>${text.trim()}</code>`);
            return;
        }

        const editGuildRewardId = await redis.get(`state:edit_guild_reward:${telegramId}`);
        if (editGuildRewardId) {
            await redis.del(`state:edit_guild_reward:${telegramId}`);
            await prisma.guild.update({ where: { id: editGuildRewardId }, data: { rewardDescription: text.trim() } });
            await ctx.replyWithHTML(`✅ <b>Guild Reward successfully updated.</b> Your members will now see the new offer when they check their /guild status.`);
            return;
        }

        const airdropGuildId = await redis.get(`state:guild_airdrop:${telegramId}`);
        if (airdropGuildId) {
            await redis.del(`state:guild_airdrop:${telegramId}`);
            const totalSol = parseFloat(text.trim());
            if (isNaN(totalSol) || totalSol <= 0) return ctx.reply("🔴 Invalid amount.");

            const loader = await ctx.reply("<i>⏳ Compiling multi-transfer transaction block...</i>", { parse_mode: 'HTML' });
            const { executeGuildAirdrop } = await import('./services/guild.service.js');
            const res = await executeGuildAirdrop(telegramId, airdropGuildId as string, totalSol);
            
            if (res.success) {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>AIRDROP SUCCESSFUL!</b>\n\n${res.message}\n🔗 <a href="https://solscan.io/tx/${res.signature}">View Receipt</a>`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            } else { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Airdrop Failed:</b> ${res.message}`, { parse_mode: 'HTML' }); }
            return;
        }

        // 🟢 FIX: USE PARSE-SOL-AMOUNT FOR ALL THESE
        if (await redis.get(`state:autosnipe_amt:${telegramId}`)) {
            await redis.del(`state:autosnipe_amt:${telegramId}`);
            const val = parseSolAmount(text);
            if (val === null) return ctx.reply("🔴 Invalid amount. Use a number (e.g. 0.2) or USD (e.g. $50).");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { amountSol: val } });
            await ctx.replyWithHTML(`✅ <b>Sniper Amount set to ${val} SOL.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_budget:${telegramId}`)) {
            await redis.del(`state:autosnipe_budget:${telegramId}`);
            const val = parseSolAmount(text, true); // allowZero
            if (val === null) return ctx.reply("🔴 Invalid amount. Use a number (e.g. 2.5) or USD (e.g. $500).");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { maxBudgetSol: val === 0 ? null : val } });
            await ctx.replyWithHTML(`✅ <b>Max Budget set to ${val === 0 ? 'Infinite' : val + ' SOL'}.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_dev:${telegramId}`)) {
            await redis.del(`state:autosnipe_dev:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0 || val > 100) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { maxDevBuyPercent: val } });
            await ctx.replyWithHTML(`✅ <b>Max Dev Bag set to ${val}%.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_score:${telegramId}`)) {
            await redis.del(`state:autosnipe_score:${telegramId}`);
            const val = parseInt(text);
            if (isNaN(val) || val < 0 || val > 100) return ctx.reply("🔴 Invalid score. Must be between 0 and 100.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { minScore: val } });
            await ctx.replyWithHTML(`✅ <b>AI Min Score set to ${val === 0 ? 'OFF' : val + '/100'}.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_sl:${telegramId}`)) {
            await redis.del(`state:autosnipe_sl:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 1 || val > 100) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { autoTrailingDropPercent: val } });
            await ctx.replyWithHTML(`✅ <b>Auto-Guard SL set to -${val}%.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_tp:${telegramId}`)) {
            await redis.del(`state:autosnipe_tp:${telegramId}`);
            const val = parseFloat(text);
            if (isNaN(val) || val < 0) return ctx.reply("🔴 Invalid percentage.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { autoTakeProfitPercent: val === 0 ? null : val } });
            await ctx.replyWithHTML(`✅ <b>Auto-TP set to ${val === 0 ? 'OFF' : '+' + val + '%'}.</b>`);
            return;
        }

        if (await redis.get(`state:autosnipe_delay:${telegramId}`)) {
            await redis.del(`state:autosnipe_delay:${telegramId}`);
            const val = parseInt(text);
            if (isNaN(val) || val < 0) return ctx.reply("🔴 Invalid delay.");
            await prisma.autoSnipeConfig.update({ where: { userId: (await prisma.user.findUnique({where:{telegramId}}))!.id }, data: { snipeDelaySeconds: val } });
            await ctx.replyWithHTML(`✅ <b>Block Delay set to ${val} seconds.</b>`);
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
            return;
        }

        if (await redis.get(`state:admin_broadcast`)) {
            await redis.del(`state:admin_broadcast`);
            if (!isAdmin(telegramId)) return;

            const messageToBlast = text;
            const allUsers = await prisma.user.findMany({ select: { telegramId: true } });
            const loader = await ctx.replyWithHTML(`<i>⏳ Broadcasting message to ${allUsers.length} users... Please wait.</i>`);
            
            let sentCount = 0;
            for (const u of allUsers) {
                try {
                    await bot.telegram.sendMessage(u.telegramId, `📢 <b>Platform Announcement</b>\n\n${messageToBlast}`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                    sentCount++;
                    await new Promise(r => setTimeout(r, 50)); 
                } catch(e) {} 
            }
            return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>BROADCAST COMPLETE</b>\n\nSuccessfully delivered to <b>${sentCount} / ${allUsers.length}</b> users!`, { parse_mode: 'HTML' });
        }

        if (await redis.get(`state:dev_volume:${telegramId}`)) {
            await redis.del(`state:dev_volume:${telegramId}`);
            
            const user = await prisma.user.findUnique({ where: { telegramId }});
            if (!user || !user.isDevSuiteUnlocked) {
                return ctx.reply("🔴 Access Restricted. Unlock Dev Suite.");
            }

            const parts = text.trim().split(/\s+/);
            
            if (parts.length !== 4) return ctx.replyWithHTML("🔴 <b>Format Error.</b> Use: <code>[CA] [TRADE_SIZE] [MAX_FEE_BUDGET] [DELAY_SECONDS]</code>");

            const ca = parts[0]; 
            const tradeSize = parseSolAmount(parts[1]); 
            const maxBudget = parseSolAmount(parts[2]); 
            const delaySecs = parseInt(parts[3]);

            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return ctx.reply("🔴 Invalid Contract Address.");
            if (tradeSize === null || maxBudget === null || isNaN(delaySecs) || delaySecs < 1) return ctx.reply("🔴 Invalid numbers. Example sizes: 0.02 or $10");

            await redis.set(`active_bumper:${telegramId}`, ca);
            const statusMsg = await ctx.replyWithHTML(`📈 <b>AUTOMATED TRADING UTILITY INITIALIZING...</b>\n\n<i>Connecting to Jito block engine...</i>`);

            (async () => {
                let isBuy = true; let totalVolume = 0; let tradeCount = 0; let spentFees = 0;
                while (await redis.get(`active_bumper:${telegramId}`) === ca) {
                    if (spentFees >= maxBudget) {
                        await redis.del(`active_bumper:${telegramId}`);
                        try { await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, `✅ <b>TRADING UTILITY COMPLETE (BUDGET REACHED)</b>\n\nMax budget of <b>${maxBudget} SOL</b> spent in platform & gas fees.\nTotal Volume Generated: <b>~${totalVolume.toFixed(2)} SOL</b>\nTrades Executed: <b>${tradeCount}</b>`, { parse_mode: 'HTML' }); } catch(e) {}
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
                                await ctx.telegram.editMessageText(ctx.chat!.id, statusMsg.message_id, undefined, 
                                    `📈 <b>AUTOMATED TRADING UTILITY RUNNING 🟢</b>\n\n<b>Target:</b> <code>${ca.substring(0,8)}...</code>\n<b>Trade Size:</b> ${tradeSize} SOL\n<b>Speed:</b> 1 trade every ${delaySecs}s\n\n📊 <b>LIVE STATS:</b>\n• Volume Generated: <b>~${totalVolume.toFixed(3)} SOL</b>\n• Trades Executed: <b>${tradeCount}</b>\n• Budget Used: <b>${spentFees.toFixed(4)} / ${maxBudget} SOL</b>\n\n<i>Send /cancel to pause.</i>`, 
                                    { parse_mode: 'HTML' }
                                );
                            } catch (e) {} 
                        }
                        await new Promise(r => setTimeout(r, delaySecs * 1000));
                    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
                }
            })();
            return;
        }
        
        if (await redis.get(`state:dev_nuke:${telegramId}`)) {
            await redis.del(`state:dev_nuke:${telegramId}`);

            const user = await prisma.user.findUnique({ where: { telegramId }});
            if (!user || !user.isDevSuiteUnlocked) return ctx.reply("🔴 Access Restricted. Unlock Dev Suite.");

            const ca = text.trim();
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return ctx.reply("🔴 Invalid Solana Contract Address.");
            
            const loader = await ctx.replyWithHTML(`<i>⏳ COMPLIANT POSITION CONSOLIDATION: Initiating consolidated position exit for <code>${ca.substring(0,6)}...</code> across all active wallets concurrently...</i>`);
            const result = await executeExit(telegramId, ca, 100);
            if (result.success) {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `💥 <b>CONSOLIDATED PORTFOLIO EXIT COMPLETE!</b>\n\nPositions successfully closed at 100% across all sub-wallets.\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction Receipt on Solscan</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            } else { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Exit Aborted:</b> ${result.message}`, { parse_mode: 'HTML' }); }
            return;
        }

        // 🟢 FIX: LIMIT ORDER - Uses parseSolAmount
        if (await redis.get(`state:limit:${telegramId}`)) {
           await redis.del(`state:limit:${telegramId}`);
           const parts = text.split(/\s+/);
           if (parts.length !== 3) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[CA] [TARGET PRICE USD] [AMOUNT SOL OR $USD]</code>`);

           const targetCA = parts[0]!; const targetPrice = parseFloat(parts[1]!); 
           const solAmt = parseSolAmount(parts[2]!);
           
           if (isNaN(targetPrice) || solAmt === null) return ctx.reply("🔴 Invalid numbers provided. Example amount: 0.5 or $50");

           const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
           if (!user) return;

           await prisma.activeOrder.create({
               data: { userId: user.id, tokenAddress: targetCA, orderType: 'LIMIT', amountSol: solAmt, targetPriceUsd: targetPrice, isActive: true }
           });

           return ctx.replyWithHTML(`🟢 <b>LIMIT ORDER DEPLOYED</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nTarget Price: <b>$${targetPrice}</b>\nAmount: <b>${solAmt} SOL</b>\n<i>The engine will monitor the price and execute automatically via Jito.</i>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]]) });
        }

        // 🟢 FIX: COPY TRADE - Uses parseSolAmount
        if (await redis.get(`state:copytrade:${telegramId}`)) {
            await redis.del(`state:copytrade:${telegramId}`);
            const parts = text.split(/\s+/);
            if (parts.length < 3 || parts.length > 4) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[WALLET] [AMOUNT SOL OR $USD] [DROP %] [OPTIONAL TP %]</code>`);
            const targetWallet = parts[0]!; 
            const solAmt = parseSolAmount(parts[1]!); 
            const dropPct = parseFloat(parts[2]!); 
            const tpPct = parts.length === 4 ? parseFloat(parts[3]!) : undefined;

            if (targetWallet.length < 32 || targetWallet.length > 44) return ctx.reply("🔴 Invalid Solana Wallet Address.");
            if (solAmt === null || isNaN(dropPct)) return ctx.reply("🔴 Invalid numbers provided. Example amount: 0.5 or $50");
            
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (!user) return;

            const loader = await ctx.replyWithHTML(`<i>⏳ Auditing Target Wallet behavior via Helius...</i>`);
            
            const { scoreWallet } = await import('./services/copytrade.service.js');
            const audit = await scoreWallet(targetWallet);

            await prisma.copyTradeConfig.create({ data: { userId: user.id, targetWallet, tradeAmountSol: solAmt, autoTrailingDropPercent: dropPct, autoTakeProfitPercent: tpPct || null, isActive: true } });
            
            return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                `🟢 <b>COPY TRADE ACTIVE</b>\n\nTarget: <code>${targetWallet.substring(0,8)}...</code>\nAmount: <b>${solAmt} SOL</b>\nGuard: <b>-${dropPct}%</b>\n\n📊 <b>WALLET AUDIT SCORE: ${audit.score}/100</b>\n<i>${audit.message}</i>`, 
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Copy Trade Menu', 'menu_copytrade')]]) }
            );
        }

        // 🟢 FIX: GUARD - Uses parseSolAmount
        if (await redis.get(`state:guard:${telegramId}`)) {
            await redis.del(`state:guard:${telegramId}`);
            
            const stashedCa = await redis.get(`state:guard_ca:${telegramId}`);
            let textToParse = text.trim();
            if (stashedCa) { textToParse = `${stashedCa} ${textToParse}`; await redis.del(`state:guard_ca:${telegramId}`); }

            const parts = textToParse.split(/\s+/);
            if (parts.length !== 3 && parts.length !== 4) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> <code>[CA] [DROP %] [AMOUNT SOL OR $USD] [OPTIONAL TP %]</code>`);

            const targetCA = parts[0]!; 
            const trailPct = parseFloat(parts[1]!); 
            const solAmt = parseSolAmount(parts[2]!); 
            const tpPct = parts.length === 4 ? parseFloat(parts[3]!) : undefined; 
            
            if (isNaN(trailPct) || solAmt === null || (tpPct !== undefined && isNaN(tpPct))) return ctx.reply("🔴 Invalid numbers provided. Example amount: 0.5 or $50");

            const loader = await ctx.replyWithHTML(`<i>⏳ Executing Jito Trade & Syncing Guard...</i>`, { parse_mode: 'HTML' });

            try {
                const buyResult = await executeSnipe(telegramId, targetCA, solAmt);
                if (!buyResult.success) return await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `${buyResult.message}`, { parse_mode: 'HTML' });

                let initialPriceNative = 0;
                try {
                    const priceRes = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${targetCA}`).catch(() => null);
                    initialPriceNative = priceRes?.data?.data?.[targetCA]?.price || 0;
                    if (initialPriceNative === 0 && targetCA.toLowerCase().endsWith("pump")) {
                        const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./services/price.service.js');
                        const curvePda = getBondingCurveAddress(targetCA);
                        const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                        if(accInfo && accInfo.data) initialPriceNative = decodePumpCurvePrice(accInfo.data.toString('base64'));
                    }
                } catch (e) {}

                await addTrailingStopToMemory(telegramId, targetCA, trailPct, solAmt, initialPriceNative, tpPct);
                
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `🟢 <b>BUY & GUARD SUCCESSFUL!</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nInvested: <b>${solAmt} SOL</b>\nTrailing Drop: <b>-${trailPct}%</b>\nTake Profit: ${tpPct ? `<b>+${tpPct}%</b>` : `<i>Not Set (Trailing Only)</i>`}\n\n🔗 <a href="https://solscan.io/tx/${buyResult.signature}">View Receipt (Fee Extracted)</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Guards Menu', 'menu_trailing')]]) }
                );
            } catch (e) { await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, "🔴 Failed to process transaction or memory block."); }
            return;
        }

       // 🟢 FIX: DCA - Uses parseSolAmount
       if (await redis.get(`state:dca:${telegramId}`)) {
           await redis.del(`state:dca:${telegramId}`);
           try {
               const parts = text.split(/\s+/);
               if (parts.length < 4 || parts.length > 6) return ctx.replyWithHTML(`🔴 <b>Format Error.</b> Use: <code>[CA] [INTERVAL] [AMOUNT SOL OR $USD] [DROP %] [OPTIONAL TP] [OPTIONAL BUDGET]</code>`);

               const targetCA = parts[0]!; const intervalMins = parseInt(parts[1]!); 
               const solAmt = parseSolAmount(parts[2]!); 
               const dropPct = parseFloat(parts[3]!);
               const tpPct = (parts.length >= 5 && parseFloat(parts[4]!) !== 0) ? parseFloat(parts[4]!) : undefined;
               const maxBudget = parts.length === 6 ? parseSolAmount(parts[5]!, true) : undefined; 
               
               if (isNaN(intervalMins) || solAmt === null || isNaN(dropPct)) return ctx.reply("🔴 Invalid numbers provided. Example amount: 0.5 or $50");

               const user = await prisma.user.findUnique({ where: { telegramId } });
               if (!user) return ctx.reply("🔴 User not found.");

               await prisma.activeOrder.create({
                   data: { userId: user.id, tokenAddress: targetCA, orderType: 'DCA', amountSol: solAmt, dcaIntervalMins: intervalMins, trailingPercent: dropPct, takeProfitPercent: tpPct || null, maxBudgetSol: maxBudget || null, isActive: true }
               });

               return ctx.replyWithHTML(`🟢 <b>TWAP/DCA SCHEDULE DEPLOYED</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nInterval: <b>Every ${intervalMins} Minutes</b>\nAmount: <b>${solAmt} SOL per interval</b>\nMax Budget: <b>${maxBudget ? `${maxBudget} SOL` : 'Infinite'}</b>\nGuard: <b>-${dropPct}%</b>\nTake Profit: <b>${tpPct ? `+${tpPct}%` : 'OFF'}</b>\n\n<i>This schedule runs fully headless via Jito protection.</i>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_dca')]]) });
           } catch (e: any) { return ctx.reply(`🔴 Error deploying DCA: ${e.message}`); }
       }

        if (await redis.get(`state:enter_ref:${telegramId}`)) {
            await redis.del(`state:enter_ref:${telegramId}`);
            const code = text.trim().toUpperCase();
            const currentUser = await prisma.user.findUnique({ where: { telegramId } });
            if (currentUser?.referralCode === code) return ctx.replyWithHTML(`🔴 <b>Error:</b> You cannot use your own referral code.`);

            const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
            if (!referrer) return ctx.replyWithHTML(`🔴 <b>Error:</b> Partner code <code>${code}</code> not found.`);

            await prisma.user.update({ where: { telegramId }, data: { referredById: referrer.id } });
            await ctx.replyWithHTML(`✅ <b>Success!</b>\n\nYou are now linked to Partner <b>${code}</b>. They will receive a revenue share of your trading volume.`);
            return;
        }

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
                
                await redis.hmset(`guild_setup:${telegramId}`, { step: '3', reward: rewardDescription });
                
                await ctx.replyWithHTML(
                    `🏰 <b>CONFIRM GUILD CREATION</b>\n\n` +
                    `Please review your loyalty infrastructure setup:\n\n` +
                    `• <b>Community Name:</b> <code>${communityName}</code>\n` +
                    `• <b>Member Reward:</b> <i>"${rewardDescription}"</i>\n\n` +
                    `<i>This unlocks permanent Guild ownership: unlimited members, live leaderboard, CSV export, and a 50% revenue share on every trade your members make — forever.</i>`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Confirm & Create Guild', 'action_confirm_guild_pay')],
                        [Markup.button.callback('❌ Abort Setup', 'action_abort_guild_setup')]
                    ])
                );
                return;
            }
        }

        if (await redis.get(`state:import_key:${telegramId}`)) {
            await redis.del(`state:import_key:${telegramId}`);
            try { await ctx.deleteMessage(ctx.message.message_id); } catch(e){}
            const loader = await ctx.replyWithHTML("<i>⏳ Verifying and encrypting imported key...</i>");

            const success = await importPrivateKey(telegramId, text.trim());
            if (success) {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `✅ <b>Wallet Imported Successfully!</b>\nYour Sentry terminal is now linked to your new encrypted address.`, { parse_mode: 'HTML' });
            } else {
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Import Failed.</b> Not a valid Solana Base58 Private Key.`, { parse_mode: 'HTML' });
            }
            return;
        }

    } catch (redisErr) {}
 
    // 🟢 FIX: Manual Snipe - Uses parseSolAmount
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
            const parsedAmt = parseSolAmount(parts[1]!);
            if (parsedAmt !== null && parsedAmt > 0) tradeAmountSol = parsedAmt;
            else return ctx.reply("🔴 Invalid amount specified. Use a number (e.g. 0.5) or USD (e.g. $50).");
        } else {
            const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
            if (user?.autoSnipeConfig?.amountSol) tradeAmountSol = user.autoSnipeConfig.amountSol;
        }

        const spamLockKey = `lock:manual_snipe:${telegramId}`;
        if (!(await redis.set(spamLockKey, 'LOCKED', 'EX', 3, 'NX'))) return ctx.reply("⚠️ <b>Please wait a moment before sending another snipe command.</b>", { parse_mode: 'HTML' });

        const loader = await ctx.replyWithHTML(`⚡ <b>SNIPE ENGAGED</b>\n\nTarget: <code>${possibleCA.substring(0,8)}...</code>\nAmount: <b>${tradeAmountSol} SOL</b>\n<i>⏳ Running security scan & fetching Token Info...</i>`);
        
        try {
            const { checkTokenRugRisk } = await import('./services/price.service.js');
            const isRug = await checkTokenRugRisk(possibleCA);
            if (isRug) {
                await redis.del(spamLockKey);
                return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `🚨 <b>SECURITY WARNING: HIGH RISK TOKEN</b> 🚨\n\nRugCheck detected critical risks (e.g. Freeze Authority enabled or Honeypot). Sentry has blocked this transaction to protect your funds.\n\nIf you know what you are doing, click below to override the shield.`, 
                    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⚠️ IGNORE WARNING & BUY ANYWAY', `forcebuy_${possibleCA}_${tradeAmountSol}`)]]) }
                );
            }
        } catch (e) {} 

        const dexRes = (await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${possibleCA}`
        ).then(r => r.json()).catch(() => null)) as any;

        const pair = dexRes?.pairs?.[0];
        const mcap = pair?.fdv ? `$${Number(pair.fdv).toLocaleString()}` : 'Unknown';
        const vol24h = pair?.volume?.h24 ? `$${Number(pair.volume.h24).toLocaleString()}` : 'Unknown';
        const tgLink = pair?.info?.socials?.find((s: any) => s.type === 'telegram')?.url || null;
        const twitterLink = pair?.info?.socials?.find((s: any) => s.type === 'twitter')?.url || null;

        const { checkTokenRugRisk } = await import('./services/price.service.js');
        const rugDetected = await checkTokenRugRisk(possibleCA);
        const mevWarning = rugDetected ? `\n\n🚨 <b>WARNING: Critical Rug/Honeypot risk detected on RugCheck!</b>` : '';
        const socialsLine = [tgLink, twitterLink].filter(Boolean).join(' | ') || 'None found';

        await redis.del(spamLockKey);
        await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});

        await ctx.reply(
            `🔍 <b>TOKEN INFO</b>\n\n` +
            `<code>${possibleCA}</code>\n\n` +
            `📊 Market Cap: <b>${mcap}</b>\n` +
            `💹 24H Volume: <b>${vol24h}</b>\n` +
            `🔗 Socials: ${socialsLine}` +
            mevWarning +
            `\n\n<i>Tap below to buy instantly or set up a price alert guard:</i>`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Confirm Buy', callback_data: `confirm_buy_${possibleCA}` },
                            { text: '👀 Watch Price', callback_data: `confirm_watch_${possibleCA}` } 
                        ],
                        [
                            { text: '❌ Cancel', callback_data: 'cancel_buy' }
                        ]
                    ]
                }
            }
        );

        await redis.set(`pending_buy:${telegramId}:${possibleCA}`, tradeAmountSol.toString(), 'EX', 120);
        return;
    }

    return next();
});


// 🟢 GAP 3 FIX: Seamlessly route the user from the "Watch Price" button directly into the Guard Flow
bot.action(/^confirm_watch_(.+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tokenAddress = ctx.match[1];
    const telegramId = ctx.from?.id.toString()!;

    await redis.set(`state:guard:${telegramId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `🛡️ <b>DEPLOY WATCH GUARD & TAKE PROFIT</b>\n\n` +
        `Token: <code>${tokenAddress}</code>\n\n` +
        `Reply to this message with your guard parameters (excluding the CA):\n` +
        `<code>[DROP %] [AMOUNT SOL] [OPTIONAL TP %]</code>\n\n` +
        `<i>Example: 15 0.1 50 (Sentry will buy 0.1 SOL, deploy a 15% trailing stop-loss, and set a 50% take profit)</i>`
    );
    
    // Store the target CA for the incoming text interceptor
    await redis.set(`state:guard_ca:${telegramId}`, tokenAddress, 'EX', 120);
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


// 🟢 B.2 FIX: Caller Debugging Command
bot.command('callerdebug', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;
    
    const { getRecentNewMints } = await import('./services/grpc.service.js');
    const buffer = getRecentNewMints();
    const rawHot = await redis.get('caller:hot_scored_tokens');
    const scored = rawHot ? JSON.parse(rawHot) : [];
    
    await ctx.replyWithHTML(
        `🔧 <b>CALLER DEBUG</b>\n\n` +
        `Ring buffer size: <b>${buffer.length}</b>\n` +
        `Newest mint: <code>${buffer[buffer.length-1]?.mint?.substring(0,10) || 'NONE'}</code>\n` +
        `Newest mint age: <b>${buffer.length ? Math.floor((Date.now()-buffer[buffer.length-1].firstSeenAt)/1000)+'s' : 'N/A'}</b>\n` +
        `Last scored batch size: <b>${scored.length}</b>\n\n` +
        `<i>(If buffer size is 0 after 2 minutes, your server is blocking outbound WebSocket connections. Relying on REST fallback.)</i>`
    );
});

// Add this command handler to index.ts for the transparent stats check
bot.command('callerstats', async (ctx) => {
    const loader = await ctx.replyWithHTML("<i>⏳ Auditing recent AI Call history...</i>");
    try {
        const historyMap = await redis.hgetall('caller_history');
        const calls = Object.values(historyMap).map(val => JSON.parse(val));
        
        if (calls.length === 0) {
            return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, "📊 <b>No recent calls in memory.</b>");
        }

        let hits = 0; let misses = 0; let pending = 0;
        let bestGain = 0;
        
        for (const call of calls) {
            // 🟢 C1 FIX: Authentic math based on verified 24h outcomes
            if (!call.finalized && !call.outcome24h && !call.outcome6h) { 
                pending++; 
                continue; 
            }
            
            // Check the highest recorded outcome from the evaluator job
            const peakGain = Math.max(call.outcome1h || -100, call.outcome6h || -100, call.outcome24h || -100);
            
            if (peakGain >= 20) { 
                hits++; 
                if (peakGain > bestGain) bestGain = peakGain; 
            } else { 
                misses++; 
            }
        }

        const winRate = hits + misses > 0 ? ((hits / (hits + misses)) * 100).toFixed(1) : "0.0";
        
        const msg = `🤖 <b>AI COIN CALLER AUDIT</b>\n\n` +
            `<i>Transparent breakdown of all calls issued in the last 24-72 hours.</i>\n\n` +
            `📊 <b>Verified Win Rate:</b> ${winRate}%\n` +
            `✅ <b>Hits (20%+ gain):</b> ${hits}\n` +
            `❌ <b>Misses/Duds:</b> ${misses}\n` +
            `⏳ <b>Pending (Too early):</b> ${pending}\n\n` +
            `🏆 <b>Best Call Peak:</b> +${bestGain.toFixed(1)}%\n\n` +
            `<i>Sentry Terminal tracks its own hit rate to ensure full transparency. A 40%+ win rate is mathematically profitable with trailing guards.</i>`;
            
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, msg, { parse_mode: 'HTML' });
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Error pulling history.</b>`);
    }
});

// 🟢 NEW: PIN Setup action
bot.action('action_set_pin', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:set_pin:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(`🔒 <b>SET WITHDRAWAL PIN</b>\n\nProtect your funds from Telegram session hijacking.\n\nReply with a <b>4 to 6 digit number</b> to set your PIN.\n<i>(If you ever forget this, you will need to contact support to manually verify ownership).</i>\n\n<i>Type /cancel to abort.</i>`);
});

bot.action('action_confirm_guild_pay', async (ctx) => {
    const tgId = ctx.from?.id.toString()!;
    try { await ctx.answerCbQuery("⏳ Initializing Guild Database..."); } catch(e){}

    const setupState = await redis.hgetall(`guild_setup:${tgId}`);
    if (!setupState || !setupState.name || !setupState.reward) {
        return ctx.replyWithHTML("🔴 <b>Session Expired:</b> Please run <code>/createguild</code> again.");
    }

    const loader = await ctx.replyWithHTML(`<i>⏳ Deploying secure database schema and registering "<b>${setupState.name}</b>"...</i>`);
    
    // We execute createGuild here, which is completely free in the code
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
        const telegramId = JSON.
        
        
        
        parse(new URLSearchParams(req.body.initData).get('user')!).id.toString();
        
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

// =========================================================
// 🌐 SECURE BOOT & EXPRESS WEBAPP
// =========================================================

async function bootEcosystem() {
    await warmDnsCache();
    await syncGuardsFromDb(); 
    // Start WebApp Express Server
    app.listen(3001, () => console.log('🟢 WebApp API Server listening on port 3001'));



    // Background sweep to cleanly demote expired VIPs every 10 minutes
    setInterval(async () => {
        await sweepExpiredVips();
    }, 10 * 60 * 1000);

    // Inside your async function bootEcosystem(), find the 60s interval block and replace it:
    // 🟢 OPTIMIZATION: Stagger rank cache updates 1.5 seconds apart to avoid blocking database transactions
    setInterval(async () => {
        try {
            const guilds = await prisma.guild.findMany({ where: { isActive: true }, select: { id: true } });
            for (let i = 0; i < guilds.length; i++) {
                setTimeout(async () => {
                    await updateRankCache(guilds[i].id);
                }, i * 1500); // 1.5 second stagger
            }
        } catch (e) {}
    }, 60000);

// 🟢 NEW: Headless Scheduled Volume Bumper Loop
setInterval(async () => {
    try {
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'scheduled_bump:*', 'COUNT', 100);
            cursor = nextCursor;
            for (const key of keys) {
                const dataRaw = await redis.get(key);
                if (!dataRaw) continue;
                const data = JSON.parse(dataRaw);
                
                if (Date.now() > data.expiresAt || data.spent >= data.budget) {
                    await redis.del(key);
                    continue;
                }
                
                const parts = key.split(':');
                const tgId = parts[1];
                const tokenCA = parts[2];
                
                const cdKey = `bump_cd:${tokenCA}`;
                if (await redis.get(cdKey)) continue;
                await redis.set(cdKey, '1', 'EX', 12); 
                
                try {
                   const tradeSize = 0.01 + Math.random() * 0.02; 
                   const { executeSnipe, executeExit } = await import('./services/engine.service.js');
                   
                   if (data.isBuyNext) {
                       const res = await executeSnipe(tgId, tokenCA, tradeSize, 'buy', undefined, true);
                       if (res.success) data.isBuyNext = false;
                   } else {
                       const res = await executeExit(tgId, tokenCA, 100, true);
                       if (res.success) data.isBuyNext = true;
                   }
                   
                   data.spent += (tradeSize * 0.01) + 0.0005; 
                   await redis.set(key, JSON.stringify(data));
                   
                   await prisma.launchedToken.update({
                       where: { tokenAddress: tokenCA },
                       data: { totalVolumeBumped: { increment: tradeSize } }
                   }).catch(() => {});
                } catch(e) {}
            }
        } while (cursor !== '0');
    } catch (e) {}
}, 5000);


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
        
        startCoinCaller(bot); // ADDED CALLER ENGINE STARTUP
        
// =========================================================
    // 📬 WEEKLY REPORT SCHEDULER — Every Monday 8:00 AM UTC
    // =========================================================
    cron.schedule('0 8 * * 1', async () => {
        console.log('🕗 [CRON] Monday 8AM — firing weekly reports');
        await sendWeeklyReportsToAll(bot);
    }, {
        timezone: 'UTC'
    });
    console.log('📬 Weekly report scheduler armed — fires every Monday 8AM UTC');

    // =========================================================
    // 👑 VIP EXPIRY SCHEDULER — Every Day 9:00 AM UTC
    // =========================================================
    cron.schedule('0 9 * * *', async () => {
        const expiringUsers = await prisma.user.findMany({
            where: {
                isVip: true,
                vipTier: { not: 'lifetime' },
                vipExpiresAt: { gte: new Date(), lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }
            }
        });

        for (const u of expiringUsers) {
            const daysLeft = Math.ceil((u.vipExpiresAt!.getTime() - Date.now()) / 86400000);
            try {
                await bot.telegram.sendMessage(u.telegramId,
                    `⚠️ <b>VIP EXPIRING SOON</b>\n\nYour ${u.vipTier} VIP expires in <b>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</b>.\nRenew now to keep your 0% fees.`,
                    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('👑 Renew VIP', 'menu_vip')]]) }
                );
                await new Promise(r => setTimeout(r, 100));
            } catch(e) {}
        }
    }, { timezone: 'UTC' });

    // 🟢 CRASH-PROOF DELETION SWEEPER: Deletes private keys even if bot rebooted
    setInterval(async () => {
        try {
            const now = Date.now();
            const pending = await redis.zrangebyscore('pending_key_deletions', 0, now);
            for (const item of pending) {
                const [chatId, msgId] = item.split(':');
                try { await bot.telegram.deleteMessage(chatId, parseInt(msgId)); } catch(e){}
                await redis.zrem('pending_key_deletions', item);
            }
        } catch(e){}
    }, 5000);

        // 🟢 FEATURE 3: Initialize the Launch Calendar background updater
        const { updateLaunchCalendar } = await import('./services/calendar.service.js');
        await updateLaunchCalendar();
        setInterval(updateLaunchCalendar, 30 * 60 * 1000); // Refreshes every 30 mins

    } catch (err: any) {
        console.error("🔴 TELEGRAM BOOT FAILED:", err.message);
        process.exit(1);
    }

    const { startCallerEvaluator } = await import('./services/caller.service.js');
        startCallerEvaluator(); // 🟢 Starts the background hit-rate processing job
} // 🟢 This closing bracket was missing!

bootEcosystem();

process.once('SIGINT', () => { try { if (bot.botInfo) bot.stop('SIGINT'); } catch(e){} prisma.$disconnect(); redis.quit(); });
process.once('SIGTERM', () => { try { if (bot.botInfo) bot.stop('SIGTERM'); } catch(e){} prisma.$disconnect(); redis.quit(); });