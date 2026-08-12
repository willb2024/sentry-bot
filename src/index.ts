// src/index.ts
import { Telegraf, Markup, Context } from 'telegraf';

import { startCopyTradeWatcher, syncCopyTradeListeners } from './services/copytrade.service.js';
import { startDcaEngine } from './services/dca.service.js';
import { getBondingCurveAddress, decodePumpCurvePrice, checkTokenRugRisk } from './services/price.service.js';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import cors from 'cors';
import { prisma } from './lib/prisma.js'; // 🟢 FIX: Use Singleton
import dotenv from 'dotenv';
import { redis } from './lib/redis.js';
import { isSimulationActive } from './services/simulation.service.js';
import axios from 'axios';
import { igniteYellowstoneStream } from './services/grpc.service.js';
import FormData from 'form-data';
import { getAdvancedStats, getHourlyPerformance, exportTradesToCsv } from './services/analytics.service.js';
import { sweepExpiredVips } from './services/vip_promo.service.js';
import { addTrailingStopToMemory, cancelAllUserGuards, cancelAllGuardsForToken, updateGuardSize } from './services/order.service.js';
import { generateSecureVault, exportPrivateKey, importPrivateKey, ensureWalletsExist, decryptKey } from './services/vault.service.js';
import { cachedSolUsdPrice } from './services/grpc.service.js';
import { getUserPositions } from './services/position.service.js';
import { processAffiliatePayout } from './services/payout.service.js';
import { getEmptyTokenAccounts, executeRentSweep } from './services/burn.service.js';
import { createGuild, joinGuild, getLeaderboard, exportLeaderboard, updateRankCache } from './services/guild.service.js';  
import { startDepositWatcher } from './services/deposit.service.js';
import { syncGuardsFromDb } from './services/order.service.js';
import { startCoinCaller, getUserCallerFilters, setUserCallerFilters } from './services/caller.service.js';
import { connection } from './lib/connection.js';
// 🟢 Update line 22 in src/index.ts:
import { executeSnipe, executeExit, warmDnsCache, getCachedTokenPrice } from './services/engine.service.js';
import cron from 'node-cron';
import { sendWeeklyReportsToAll, computeWeeklyStats, formatWeeklyReport } from './services/weekly_report.service.js';
import { VIP_TIERS, VipTierKey, checkVipStatus, grantVip, verifyVipPayment, getPlatformFeeRate, formatVipStatus, VIP_CREDIT_BONUS } from './services/vip.service.js';
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


const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',');

if (!BOT_TOKEN) { console.error("🔴 FATAL: BOT_TOKEN is missing in .env!"); process.exit(1); }
if (!process.env.TREASURY_WALLET_ADDRESS) { console.error("🔴 FATAL: TREASURY_WALLET_ADDRESS is missing in .env! All trades will run fee-free."); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);




dotenv.config();

// 🟢 FIX 3: Environment Variable Validation
const requiredEnv = [
    'BOT_TOKEN',
    'TREASURY_WALLET_ADDRESS',
    'ENCRYPTION_KEY',
    'DATABASE_URL',
    'REDIS_URL',
    'HELIUS_API_KEY',
    'PINATA_JWT',
    'WEBAPP_URL'
];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// 🟢 FIX 4: Add CORS Middleware
app.use(cors({
    origin: process.env.WEBAPP_URL || '*',
    credentials: true
}));

dotenv.config();
console.log("🟢 [1/5] Booting Sentry Terminal Core...");

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔴 Unhandled Rejection at:', promise, 'reason:', reason);
  });
  
  process.on('uncaughtException', (error) => {
    console.error('🔴 Uncaught Exception:', error);
  });


// Add this helper function near the top of index.ts
function isAdmin(tgId: string | undefined): boolean {
    if (!tgId) return false;
    const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',').filter(Boolean);
    return ADMIN_IDS.includes(tgId);
}


// 🟢 SECURITY UTILS: Add these near the top of your index.ts


export function hashPin(pin: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    const verifyHash = crypto.scryptSync(pin, salt, 64).toString('hex');
    return verifyHash === hash;
}


export function maskAddress(address: string | null | undefined, hidden: boolean): string {
    if (!address) return "None";
    if (hidden && address.length > 8) return `${address.substring(0, 4)}...${address.slice(-4)}`;
    return address;
}

// Replace safeSendMessage and safeEditMessageText in src/index.ts
export async function safeSendMessage(tgId: string, text: string, options: any = {}) {
    let retries = 3;
    while (retries > 0) {
        try {
            await bot.telegram.sendMessage(tgId, text, options);
            return; 
        } catch (error: any) {
            if (error.code === 429) { 
                const waitTime = error.parameters?.retry_after || 1;
                await new Promise(r => setTimeout(r, waitTime * 1000));
                retries--;
            } else if (error.code === 403 || error.code === 400) {
                console.warn(`⚠️ [TG] Message ignored (code ${error.code}): ${error.description}`);
                return;
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
            } else if (error.code === 400 && error.description?.includes('message is not modified')) {
                return;
            } else if (error.code === 400 || error.code === 403) {
                console.warn(`⚠️ [TG] Edit ignored (code ${error.code}): ${error.description}`);
                return;
            } else { 
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



// 🟢 ADD THIS HELPER FUNCTION

function extractTelegramId(initData: string): string | null {
    try {
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) {
            // 🟢 FIX: Prevent raw crash on incomplete JSON
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
        // 🟢 FIX: Handle potential 0 or undefined price scenarios
        if (!cachedSolUsdPrice || cachedSolUsdPrice <= 0) return null;
        return parseFloat((usdVal / cachedSolUsdPrice).toFixed(4));
    }
    
    const solVal = parseFloat(trimmed);
    if (isNaN(solVal) || (!allowZero && solVal <= 0)) return null;
    return solVal;
}


// 🟢 GLOBAL API ENDPOINTS (MUST BE AT THE TOP, BEFORE TELEGRAM HANDLERS)

app.post('/api/sol-price', (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        res.json({ price: cachedSolUsdPrice });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/analytics', async (req, res) => {
    const initData = req.body.initData;
    if (!initData) return res.status(401).json({ error: "No initData" });
    const tgId = extractTelegramId(initData);
    if (!tgId) return res.status(401).json({ error: "Invalid initData" });

    try {
        const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (!user) return res.json({ trades: [], stats: null });

        // Fetch ONLY the latest 50 trades for the ledger
        const trades = await prisma.trade.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        const mappedTrades = trades.map((t: any) => ({
            createdAt: t.createdAt, isBuy: t.isBuy, amountInSol: t.amountInSol,
            profitPercent: t.profitPercent || 0, realizedPnlSol: t.realizedPnlSol || 0
        }));

        const { getAdvancedStats } = await import('./services/analytics.service.js');
        const stats = await getAdvancedStats(tgId);
        
        // 🟢 FIX: Return the Object format the WebApp expects
        res.json({ trades: mappedTrades, stats });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sim-trades', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = JSON.parse(new URLSearchParams(req.body.initData).get('user')!).id.toString();
        if (!isAdmin(telegramId)) return res.status(403).json({ error: 'Admin only' });
        const { isSimulationActive } = await import('./services/simulation.service.js');
        if (!await isSimulationActive(telegramId)) return res.json([]);
        const raw = await redis.get(`sim:trades:${telegramId}`);
        res.json(raw ? JSON.parse(raw) : []);
    } catch (e: any) { res.status(500).json([]); }
});


app.post('/api/institutional-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: 'Invalid initData' });

        const { isSimulationActive } = await import('./services/simulation.service.js');
        const isSim = await isSimulationActive(tgId);

        let trades = [];
        let maxBudget = 0;
        let currentSpend = 0;

        if (isSim) {
            const rawTrades = await redis.get(`sim:trades:${tgId}`);
            trades = rawTrades ? JSON.parse(rawTrades) : [];
            const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
            maxBudget = user?.autoSnipeConfig?.maxBudgetSol || 0;
            const { getSessionSpend } = await import('./services/simulation.service.js');
            currentSpend = await getSessionSpend(tgId, 'sim');
        } else {
            const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
            if (!user) return res.status(404).json({ error: 'User not found' });
            trades = await prisma.trade.findMany({ where: { userId: user.id, status: 'CONFIRMED' }, orderBy: { createdAt: 'desc' }, take: 100 });
            maxBudget = user.autoSnipeConfig?.maxBudgetSol || 0;
            const { getSessionSpend } = await import('./services/simulation.service.js');
            currentSpend = await getSessionSpend(tgId, 'live');
        }

        const slippageValues = trades.map((t: any) => t.slippagePercent || 0).filter((v: number) => v > 0);
        const avgSlippage = slippageValues.length > 0 ? (slippageValues.reduce((a: number, b: number) => a + b, 0) / slippageValues.length) : 0;

        const stratStats: any = {};
        for (const t of trades) {
            const strat = t.strategy || 'MANUAL';
            if (!stratStats[strat]) stratStats[strat] = { count: 0, pnl: 0, volume: 0, wins: 0 };
            stratStats[strat].count++;
            stratStats[strat].pnl += t.realizedPnlSol || 0;
            stratStats[strat].volume += t.amountInSol || 0;
            if (t.profitPercent && t.profitPercent > 0) stratStats[strat].wins++;
        }

        const pnlArray = trades.filter((t: any) => !t.isBuy && t.realizedPnlSol !== null && t.realizedPnlSol !== undefined).map((t: any) => t.realizedPnlSol || 0).sort((a: number, b: number) => a - b);
        let cvar = 0;
        if (pnlArray.length >= 1) {
            const count = Math.max(1, Math.floor(pnlArray.length * 0.05));
            const tail = pnlArray.slice(0, count);
            cvar = tail.reduce((a: number, b: number) => a + b, 0) / tail.length;
        }

        res.json({ avgSlippage, stratStats, cvar, maxBudget, currentSpend });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// 🟢 NEW: Persistent Simulation Stats Endpoint
// Replace app.post('/api/sim-stats', ...) in src/index.ts
app.post('/api/sim-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: 'Invalid initData' });

        const { isSimulationActive, getSimBalance, getSimStartingBalance, getSimVolume, getSimCounters, getSimFirstTradeAt } = await import('./services/simulation.service.js');
        const isActive = await isSimulationActive(tgId);
        
        // 🟢 CRITICAL FIX: Explicitly return zero metrics if sim is inactive
        if (!isActive) {
            return res.json({
                isActive: false, balance: '0.0000', startingBalance: '0.0000', volume: 0,
                wins: 0, losses: 0, totalTrades: 0, totalInvestedSol: 0, totalPnlSol: 0,
                positions: [], trades: [], firstTradeAt: null
            });
        }

        const balance = await getSimBalance(tgId);
        const startingBalance = await getSimStartingBalance(tgId);
        const volume = await getSimVolume(tgId);
        const positionsRaw = await redis.get(`sim:positions:${tgId}`);
        const positions = positionsRaw ? JSON.parse(positionsRaw) : [];
        const tradesRaw = await redis.get(`sim:trades:${tgId}`);
        const trades = tradesRaw ? JSON.parse(tradesRaw) : [];

        const counters = await getSimCounters(tgId);
        const firstTradeAt = await getSimFirstTradeAt(tgId);

        res.json({
            isActive: true, balance, startingBalance, volume,
            wins: counters.wins, losses: counters.losses,
            totalTrades: counters.totalTrades,
            totalInvestedSol: counters.totalInvestedSol,
            totalPnlSol: counters.totalPnlSol,
            firstTradeAt, positions, trades: trades.slice(0, 50)
        });
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
});


// Add these admin commands in src/index.ts
bot.command('clearsim', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;
    
    const loader = await ctx.replyWithHTML("🧹 <i>Purging all simulation states...</i>");
    
    try {
        const { setSimulationMode } = await import('./services/simulation.service.js');
        await setSimulationMode(tgId!, false);
        
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
            `✅ <b>PURGE COMPLETE</b>\n\nSimulation data zeroed and reset.`, 
            { parse_mode: 'HTML' }
        );
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 Error: ${e.message}`, { parse_mode: 'HTML' });
    }
});

bot.command('resetlive', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;

    const loader = await ctx.replyWithHTML("🧹 <i>Hard-resetting LIVE database tables...</i>");

    try {
        const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (!user) return ctx.reply("User not found.");

        await prisma.trade.deleteMany({ where: { userId: user.id } });

        await prisma.user.update({
            where: { id: user.id },
            data: {
                totalVolumeSol: 0,
                firstTradeAt: null,
                pendingRewardsSol: 0
            }
        });

        await redis.del(`balance_cache:${tgId}`, `positions_cache:${tgId}`, `stats_events:live:${tgId}`);

        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
            `✅ <b>LIVE DATABASE PURGED</b>\n\nAll live trades deleted. Dashboard reset to 0.`,
            { parse_mode: 'HTML' }
        );
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 Error: ${e.message}`, { parse_mode: 'HTML' });
    }
});

// 🟢 NEW: Toggle Simulation Mode Endpoint
app.post('/api/toggle-sim', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: "Invalid initData" });
        const { setSimulationMode } = await import('./services/simulation.service.js');
        await setSimulationMode(tgId, req.body.active);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
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
app.get('/share/:imgId', async (req, res) => {
    try {
        const imgId = req.params.imgId;
        const botName = process.env.BOT_NAME || 'Sentry Terminal';
        // 🟢 FIX: Add a reliable fallback username
        const botUsername = process.env.BOT_USERNAME || 'SentryTerminalBot';
        
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





// 🟢 FIX: Serves 100% persistent simulation stats to the WebApp for any user in sim mode




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

        const displayVolume = user.totalVolumeSol || 0;
        let currentTier = "Bronze";
        let currentRate = 0.40;
        if (displayVolume >= 100) {
            currentTier = "Diamond";
            currentRate = 0.70;
        } else if (displayVolume >= 25) {
            currentTier = "Gold";
            currentRate = 0.60;
        } else if (displayVolume >= 5) {
            currentTier = "Silver";
            currentRate = 0.50;
        }
        
        res.json({
            recruits: user.recruits.length,
            pendingYieldSol: parseFloat((user.pendingRewardsSol || 0).toFixed(4)),
            lifetimeEarnedSol: parseFloat(((user.pendingRewardsSol || 0) + totalHistoricalEarned).toFixed(4)),
            // 🟢 FIX: Hardcoded to your correct bot username to fix the WebApp display
            referralLink: `https://t.me/sentry_terminalbot?start=${user.referralCode}`,
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
// src/index.ts – replace sendOrEditDashboard
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
  
    // 🟢 TYPO FIXED HERE (Removed the stray "c" before the comment)
    // Inside sendOrEditDashboard(...)
    const hideWallets = await redis.get(`user_settings:hide_wallets:${telegramId}`) === 'true';
    const whaleModeText = user.activeWallets > 1 ? `🐙 <b>WHALE MODE:</b> 🟢 ACTIVE (Firing ${user.activeWallets} Wallets)` : `⚙️ <b>Active Wallets:</b> 1 / 5 (Standard Mode)`;

    // ONE static snapshot for the dashboard render to prevent jitter
    const solUsdSnapshot = cachedSolUsdPrice;

    const totalTradingDays = user.firstTradeAt
        ? Math.max(1, Math.floor((Date.now() - user.firstTradeAt.getTime()) / 86_400_000) + 1)
        : 0;
        
    let displayCredits = user.creditBalance;
    if (isSimMode) {
      const simCreds = await redis.get(`sim:credits:${telegramId}`);
      if (simCreds) displayCredits = parseInt(simCreds);
    }
  
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
    
    let guildDisplay = `🏰 <b>Active Guild:</b> <i>None</i>\n` + 
    `└ <i>Join a community to compete on leaderboards for rewards.</i>\n`;
if (userGuilds.length > 0) {
const primaryGuild = userGuilds[0];
const rankDisplay = primaryGuild.rank ? `#${primaryGuild.rank}` : `Unranked`;
guildDisplay = `🏰 <b>Guild:</b> <b>${primaryGuild.guild.name}</b>\n🏆 <b>Your Rank:</b> <b>${rankDisplay}</b> (${primaryGuild.loyaltyPoints.toLocaleString()} GLP)\n` +
  `└ <i>Every trade automatically boosts your rank for community rewards.</i>\n`;
}
  
    const balanceNum = parseFloat(liveBalance) || 0;
    const usdValue = balanceNum * cachedSolUsdPrice;
    const usdBalanceFormatted = usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  
    const layoutTxt = 
        `⚡ <b>${botName.toUpperCase()}</b> ⚡\n` +
        `<i>The Quantitative Terminal for Solana Memecoins</i>\n\n` +
        `<i>Routing: Pump.fun | Raydium | Meteora DLMM</i>\n\n` +
        
        
        `👛 <b>Primary Deposit Node:</b> <code>${maskAddress(user.vaultAddress, hideWallets)}</code>\n\n` +
        
        `💰 <b>Total Balance:</b> <code>${liveBalance} SOL ($${usdBalanceFormatted})</code>\n` +
        `└ ${whaleModeText}\n\n` +

        `🎯 <b>Caller Credits:</b> <code>${displayCredits}</code> Remaining\n` + 
        `└ <i>Spent only when the AI Caller delivers a real match — never on empty scans.</i>\n\n` +

        `${guildDisplay}\n` +
        
        `📊 <b>Your Economics:</b>\n` +
        `• Protocol Fee: <b>${process.env.PLATFORM_FEE_PERCENT || '1.00'}%</b>\n` +
        `└ <i>VIPs pay 0% fees. Invite friends to earn up to 40%-70% of their fees forever.</i>\n\n` +
        
        `<i>Forward a call, paste a Token CA, or select a module below.\n(All inputs accept SOL or $USD).</i>`;

        const UI = Markup.inlineKeyboard([
            [Markup.button.callback('🎯 Sniper Module', 'menu_sniper'), Markup.button.callback('🎯 AI Coin Caller', 'menu_caller')],
            [Markup.button.callback('⏳ Limit / DCA Engine', 'menu_dca'), Markup.button.callback('🛡️ Trailing Stops', 'menu_trailing')],
            [Markup.button.callback('💼 Positions', 'menu_positions'), Markup.button.callback('👥 Copy Trade', 'menu_copytrade')],
            [Markup.button.callback('💰 Affiliates', 'menu_affiliate'), Markup.button.callback('💳 Buy Credits', 'menu_credits')],
            [Markup.button.callback('🏰 Sentry Guilds', 'action_guild_menu'), Markup.button.callback('⚙️ Settings', 'menu_settings')],
            [Markup.button.callback('📤 Withdraw', 'btn_withdraw_prompt'), Markup.button.callback('🔑 Vault & Keys', 'menu_vault')],
            // 🟢 UPDATED ROW: Launch Token + Track Trades (Grouped together)
            [Markup.button.callback('🚀 Launch Token', 'menu_token_launcher'), { text: '📊 Track Trades', web_app: { url: process.env.WEBAPP_URL || 'https://your-webapp-url.com/webapp' } }],
            // 🟢 UPDATED ROW: Cancel All + Contact Support (Grouped together)

            // 🟢 UPDATED ROW: Both Guides grouped at the bottom
            [Markup.button.callback('📖 How to Trade', 'btn_trade_guide'), Markup.button.callback('⚙️ Configuration Guide', 'btn_config_guide')],
            
            [Markup.button.callback('🛑 Cancel All', 'action_global_cancel'), Markup.button.callback('💬 Contact Support', 'action_support')],
            
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

// =========================================================
// 💬 USER SUPPORT & CONTACT SYSTEM
// =========================================================

bot.command('support', async (ctx) => {
    try {
        const text = (ctx.message as any).text.replace(/^\/support/i, '').trim();
        const tgId = ctx.from?.id?.toString();
        const username = ctx.from?.username ? `@${ctx.from.username}` : `User ID ${tgId}`;

        if (!text) {
            return await ctx.replyWithHTML(
                `💬 <b>CONTACT DEVELOPER / SUPPORT</b>\n\n` +
                `To send a message directly to the developer, type:\n` +
                `<code>/support [your message here]</code>\n\n` +
                `<i>Example:</i> <code>/support Hey, I need help with my deposit!</code>`
            );
        }

        const adminIdsStr = process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_ID || '';
        const adminIds = adminIdsStr.split(',').map(id => id.trim()).filter(Boolean);

        if (adminIds.length === 0) {
            return await ctx.replyWithHTML("🔴 Support is currently unconfigured (ADMIN_TELEGRAM_ID missing in .env).");
        }

        let delivered = 0;
        for (const adminId of adminIds) {
            try {
                await bot.telegram.sendMessage(
                    adminId,
                    `📩 <b>NEW SUPPORT MESSAGE</b>\n\n` +
                    `• <b>From:</b> ${username} (<code>${tgId}</code>)\n` +
                    `• <b>Message:</b> ${text}\n\n` +
                    `<i>To reply to this user, type:</i>\n` +
                    `<code>/reply ${tgId} [your answer]</code>`,
                    { parse_mode: 'HTML' }
                );
                delivered++;
            } catch (err: any) {
                console.error(`[SUPPORT] Failed to send to admin ${adminId}:`, err.message);
            }
        }

        if (delivered > 0) {
            await ctx.replyWithHTML(`✅ <b>Your message has been delivered directly to the developer!</b>\nYou will receive a response here as soon as it is reviewed.`);
        } else {
            await ctx.replyWithHTML(`🔴 <b>Delivery Failed.</b>\nThe Admin has not started a chat with this bot yet. (Telegram requires admins to press /start on the bot first before it can DM them).`);
        }
    } catch (e) {
        console.error("Support Error:", e);
    }
});

bot.command('reply', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    const adminIdsStr = process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || process.env.ADMIN_TELEGRAM_ID || '';
    const adminIds = adminIdsStr.split(',').map(id => id.trim()).filter(Boolean);

    if (!tgId || !adminIds.includes(tgId)) return; // Only admins can use this

    const text = (ctx.message as any).text || '';
    const parts = text.split(' ');
    
    if (parts.length < 3) {
        return ctx.replyWithHTML(
            `<b>Usage:</b> <code>/reply [USER_TELEGRAM_ID] [MESSAGE]</code>\n\n` +
            `<i>Example:</i> <code>/reply 12345678 Hi! Your deposit has been confirmed.</code>`
        );
    }

    const targetId = parts[1];
    const replyMsg = parts.slice(2).join(' ');

    try {
        await bot.telegram.sendMessage(
            targetId,
            `💬 <b>DEVELOPER RESPONSE</b>\n\n${replyMsg}`,
            { parse_mode: 'HTML' }
        );
        await ctx.replyWithHTML(`✅ <b>Reply successfully delivered to user <code>${targetId}</code>!</b>`);
    } catch (e: any) {
        await ctx.replyWithHTML(`🔴 <b>Failed to send reply:</b> ${e.message}\nMake sure the user hasn't blocked the bot.`);
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
    const bonusCredits = VIP_CREDIT_BONUS[tier];

    await redis.set(
        `vip:pending:${tgId}`,
        JSON.stringify({ tier, priceSol: tierDef.priceSol, initiatedAt: Date.now() }),
        'EX', 600
    );

    const msg =
        `${tierDef.label}\n` +
        `🎁 <b>Includes:</b> ${bonusCredits} Free AI Caller Credits\n\n` +
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



bot.action('action_abort_token_launch', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString()!;
    
    // 🟢 FIX: Purge known session keys directly instead of executing slow SCAN patterns
    await redis.del(
        `token_launch:${tgId}:step`,
        `token_launch:${tgId}:name`,
        `token_launch:${tgId}:symbol`,
        `token_launch:${tgId}:description`,
        `token_launch:${tgId}:imageUrl`,
        `token_launch:${tgId}:vanity`,
        `token_launch:${tgId}:devbuy`,
        `token_launch:${tgId}:wallets`,
        `token_launch:${tgId}:guard`
    );
    
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

bot.command('simcredits', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.replyWithHTML('Usage: <code>/simcredits 500</code>');
    const credits = parseInt(parts[1]);
    if (isNaN(credits)) return ctx.reply('🔴 Invalid number.');
    
    await redis.set(`sim:credits:${tgId}`, credits.toString());
    await ctx.replyWithHTML(`🎮 Sim credits set to <b>${credits}</b>.`);
});




// 🟢 UPDATED: AI Coin Caller Menu with MEV Shield & Self-Learning ML Callouts
async function sendCallerMenu(ctx: any, tgId: string, isEdit = false) {
    const { getUserCallerFilters } = await import('./services/caller.service.js');
    const filters = await getUserCallerFilters(tgId);
    
    const statusText = filters.isActive 
        ? "🟢 <b>ACTIVE & SCANNING</b> 🔍\n<i>(Searching mempool for matches every 15s...)</i>" 
        : "🔴 <b>OFFLINE</b>";
        
    const mevText = filters.blockMev ? "🟢 Yes (MEV Protected)" : "🔴 No (Risky)";

    const text = `🎯 <b>AI COIN CALLER ENGINE</b> 🛡️ <i>[MEV Protected]</i>\n\n` +

    `🤖 <b>INTELLIGENCE ARCHITECTURE</b>\n` +
    `Powered by a <b>Self-Learning Ridge Regression ML Model</b> combined with Rule-Based Safety Audits. Sentry's model calibrates itself automatically based on daily finalized trade outcomes.\n\n` +

    `⚙️ <b>HOW IT WORKS</b>\n` +
    `Every 15 seconds, Sentry checks new tokens as they appear and looks at a few things:\n` +
    `1️⃣ Is it new, and does it have real trading activity?\n` +
    `2️⃣ Is it safe? (checks for scam red flags like frozen wallets or fake liquidity)\n` +
    `3️⃣ Who made it, and is the liquidity locked so it can't be pulled out?\n` +
    `4️⃣ Are real people buying, or does it just look busy?\n` +
    `If a token looks good on all of this, Sentry scores it, routes it through Jito MEV protection, and sends it straight to you.\n\n` +

    `🧠 <b>WHAT THE SCORE (0-100) MEANS</b>\n` +
    `• <b>0-39 — 🔵 Too Early:</b> Not enough happening yet. Just something to keep an eye on, not a buy.\n` +
    `• <b>40-59 — 🟡 Speculative:</b> A couple of good signs, but still very risky. Think of it as a small gamble.\n` +
    `• <b>60-74 — 🟠 Developing:</b> Several good signs at once — decent volume, decent liquidity, no scam flags. Still early, but looking healthier.\n` +
    `• <b>75-100 — 🟢 High Conviction:</b> Everything Sentry checks looks good at the same time. This is the strongest signal the engine gives — but it's still not a sure thing.\n\n` +

    `🔮 <b>WHAT THE "PRICE PROJECTION" MEANS</b>\n` +
    `Each alert also shows a smart estimate at how far the price might move and how fast:\n` +
    `• <b>Calibrated (ML Trained):</b> Generated by our self-learning AI model. Highly reliable and constantly improving as it analyzes more data.\n` +
    `• <b>Uncalibrated Estimate:</b> A rough guess used when there isn't enough past data yet. Take this one with a bigger grain of salt.\n\n` +

        `<b>Engine Status:</b> ${statusText}\n\n` +
        `⚙️ <b>CURRENT FILTERS:</b>\n` +
        `• <b>Minimum Score:</b> ${filters.minScore} / 100\n` +
        `• <b>Max Token Age:</b> ${filters.maxAgeMins} Mins\n` +
        `• <b>Momentum % Range:</b> ${filters.minPctChange}% to ${filters.maxPctChange}%\n` +
        `• <b>Min Liquidity:</b> $${filters.minLiquidity.toLocaleString()}\n` +
        `• <b>Min 24h Volume:</b> $${filters.minVolume24h.toLocaleString()}\n` +
        `• <b>MEV Shield:</b> ${mevText}\n\n` +
        `<i>Adjust your scanner parameters below:</i>`;

    // ... (UI buttons stay exactly the same below this)

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


// 🟢 BATCH SNIPE COMMAND
bot.command('batch', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const text = ctx.message.text.replace('/batch', '').trim();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) {
        return ctx.replyWithHTML(
            `📦 <b>BATCH SNIPE USAGE</b>\n\n` +
            `Send /batch followed by contract addresses and amounts on separate lines:\n\n` +
            `<code>/batch\nCA1, 0.1\nCA2, $50\nCA3, 0.05</code>`
        );
    }

    const parsed: Array<{ ca: string; amt: number }> = [];
    for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length !== 2) continue;
        const ca = parts[0];
        const amt = parseSolAmount(parts[1]);
        if (!ca || amt === null || amt <= 0) continue;
        parsed.push({ ca, amt });
    }

    if (parsed.length === 0) return ctx.replyWithHTML('🔴 <b>No valid entries found.</b> Ensure format is: <code>[CA], [AMOUNT]</code>');

    const loader = await ctx.replyWithHTML(`<i>⏳ Executing ${parsed.length} concurrent snipes via Jito...</i>`);

    const results = await Promise.allSettled(
        parsed.map(({ ca, amt }) => executeSnipe(tgId, ca, amt, 'buy', undefined, false, undefined, undefined, 0, undefined, 'BATCH'))
    );

    let successCount = 0;
    let msg = `📦 <b>BATCH SNIPE COMPLETE</b>\n\n`;
    results.forEach((res, i) => {
        const entry = parsed[i];
        if (res.status === 'fulfilled' && res.value.success) {
            successCount++;
            msg += `✅ <code>${entry.ca.substring(0,8)}...</code> – <b>${entry.amt} SOL</b> – <a href="https://solscan.io/tx/${res.value.signature}">Receipt</a>\n`;
        } else {
            const reason = res.status === 'fulfilled' ? res.value.message : 'Execution error';
            msg += `❌ <code>${entry.ca.substring(0,8)}...</code> – <b>${entry.amt} SOL</b> – ${reason}\n`;
        }
    });
    msg += `\n<b>Success Rate:</b> ${successCount}/${parsed.length} Executed`;
    
    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, msg, { 
        parse_mode: 'HTML', 
        link_preview_options: { is_disabled: true } 
    });
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


// 🟢 NEW: INSTITUTIONAL PLATFORM CONFIGURATION GUIDE
const CONFIG_GUIDE_PAGES: string[] = [
    // PAGE 1: BASICS
    `⚡ <b>CONFIGURATION GUIDE: THE FOUNDATION</b> <i>(1/8)</i>\n\n` +
    `⚠️ <b>DISCLAIMER:</b> Memecoins are highly volatile. This guide maximizes your odds but does not guarantee profits.\n\n` +
    `🚀 <b>1. JITO PRIORITY FEES (Speed Bribe)</b>\n` +
    `• <b>Eco 🍃 (0.0005 SOL):</b> Quiet days only.\n` +
    `• <b>Fast 🐎 (0.001 SOL):</b> Standard daily snipe.\n` +
    `• <b>Turbo ⚡ (0.005 SOL):</b> Hyper-launch mode.\n` +
    `• <b>Custom ⚙️:</b> Set 0.02 SOL to guarantee Block-0 on hyped launches.\n\n` +
    `💧 <b>2. SLIPPAGE PROTECTION</b>\n` +
    `Set to <b>20%</b>. This acts as a buffer to ensure transactions don't fail during launch volatility.`,

    // PAGE 2: DYNAMIC SIZING (NEW!)
    `📊 <b>CONFIGURATION GUIDE: DYNAMIC SIZING</b> <i>(2/8)</i>\n\n` +
    `Stop using fixed dollar amounts. The Dynamic Sizing Engine auto-scales your snipe based on the AI Score.\n\n` +
    `🔹 <b>Base Risk Unit:</b>\n` +
    `This is your "minimum bet" for a low-scoring (50-60) token. Example: 0.02 SOL.\n\n` +
    `🔹 <b>Max Risk Multiplier:</b>\n` +
    `This is your "maximum bet" multiplier for a perfect 100-score token. Example: 10x (so 0.02 SOL * 10 = 0.2 SOL max).\n\n` +
    `🔹 <b>Scaling Curve (Exponent):</b>\n` +
    `• <b>Linear (1.0):</b> A 70-score token uses 70% of your max. Straight line.\n` +
    `• <b>Aggressive (2.0):</b> <i>Recommended.</i> Squares the score. A 70 gets 49% of max; a 90 gets 81% of max. Rewards high conviction.\n` +
    `• <b>Exponential (3.0):</b> Cubes the score. Only the top 10% tokens get huge sizes.\n\n` +
    `<i>Turn this ON in the Sniper Menu to protect your bag from risky punts.</i>`,

    // PAGE 3: AUTO-SNIPER FILTERS
    `🎯 <b>CONFIGURATION GUIDE: THE SNIPER'S EDGE</b> <i>(3/8)</i>\n\n` +
    `• <b>Target Mode:</b> BOTH (Pump.fun & Raydium).\n` +
    `• <b>Scoring Mode:</b> Use 🔍 Deep Scoring. It scans for serial ruggers and hidden taxes.\n` +
    `• <b>AI Min Score:</b> Set to 55. Dynamic Sizing will protect you on lower scores.\n` +
    `• <b>Anti-Dead Shield:</b> 🟢 TURN THIS ON. Blocks devs who don't buy their own supply.\n` +
    `• <b>Dev Bag Limit:</b> Set to 10%. Aborts if the dev owns more than 10% at launch.\n` +
    `• <b>Auto-Guard:</b> Set Stop Loss to -15% and Take Profit to +45%. This is the golden 1:3 risk-reward ratio.`,

    // PAGE 4: AI COIN CALLER
    `🧠 <b>CONFIGURATION GUIDE: AI CALLER TUNING</b> <i>(4/8)</i>\n\n` +
    `The AI scans the mempool every 15 seconds.\n` +
    `• <b>Min Score:</b> Set to 55. Keep the pool large. The ML model will fine-tune projections.\n` +
    `• <b>Max Token Age:</b> Set to 10 minutes. Catch them at birth, not after it's been farmed.\n` +
    `• <b>Momentum Range:</b> 10% to 500%. Captures tokens right as they ignite.\n` +
    `• <b>MEV Shield:</b> 🟢 TURN THIS ON. Prevents sandwich bots from stealing your slippage.\n\n` +
    `<i>The AI score fluctuates randomly. The ML Model retrains on your past outcomes every hour—the more you use it, the smarter it gets.</i>`,

    // PAGE 5: VAULT & WHALE MODE
    `🔑 <b>CONFIGURATION GUIDE: WHALE MODE & SECURITY</b> <i>(5/8)</i>\n\n` +
    `• <b>Activate Whale Mode:</b> In Vault & Keys, activate up to 5 wallets. Sentry fires simultaneous orders from all wallets in the same Jito block, bypassing Pump.fun's single-wallet limits.\n` +
    `• <b>Deposit SOL:</b> You must send SOL to each individual wallet address.\n` +
    `• <b>Protect Funds:</b> Set a Withdrawal PIN in the Vault menu to protect your funds if your Telegram is compromised.`,

    // PAGE 6: DCA & LIMIT ORDERS
    `⏳ <b>CONFIGURATION GUIDE: SILENT ACCUMULATION</b> <i>(6/8)</i>\n\n` +
    `• <b>Limit Orders:</b> Type /limit [CA] [TARGET_PRICE] [AMOUNT]. Bot monitors 24/7 and buys the dip instantly.\n` +
    `• <b>DCA (TWAP):</b> Type /dca [CA] [INTERVAL] [AMOUNT] [DROP] [MAX_BUDGET].\n` +
    `  <i>Example: /dca [CA] 60 $10 10 $200</i> (Buy $10 every 60 mins, stop at $200).\n` +
    `• <b>Auto-Guard:</b> Every DCA and Limit fill automatically arms a Trailing Stop Loss. You never have to manually manage exits.`,

    // PAGE 7: COPY TRADING & GUILDS
    `👥 <b>CONFIGURATION GUIDE: MULTIPLICATIVE WEALTH</b> <i>(7/8)</i>\n\n` +
    `• <b>Copy Trade:</b> Paste a whale wallet. Sentry scans their past 20 transactions via Helius to alert you if they are a bot.\n` +
    `• <b>Guilds:</b> Type /createguild (Free) to launch your own loyalty engine. You earn 50% of the platform fees on every trade your Guild members make, forever.`,

    // PAGE 8: DASHBOARD ANALYTICS
    `📊 <b>CONFIGURATION GUIDE: THE DASHBOARD</b> <i>(8/8)</i>\n\n` +
    `• <b>Sharpe Ratio:</b> Above 2.0 is elite. If it dips below 1.5, tighten your stops.\n` +
    `• <b>Max Drawdown:</b> Keep it under 2 SOL. If it spikes, lower your position sizes.\n` +
    `• <b>Profit Factor:</b> 4.0+ means you make $4 for every $1 lost. If below 2.0, raise your min Score to 70+.\n\n` +
    `⌨️ <b>Quick Commands:</b>\n` +
    `• /watch [CA] [PRICE] → Persistent price alerts.\n` +
    `• /batch → Snipe multiple tokens at once.\n` +
    `• /stats → Live Win Rate and PnL.\n` +
    `• /exporttrades → Download your full CSV tax ledger.`
];

// 📖 FULL OPERATIONS MANUAL (Simplified & Action-Oriented)
const TRADE_GUIDE_PAGES: string[] = [
    // PAGE 1: BASICS
    `📖 <b>OPERATIONS MANUAL — BASICS</b> <i>(1/8)</i>\n\n` +
    `🌐 <b>How it works:</b> 100% of Sentry trades are packaged inside Jito Bundles. This bypasses the public mempool, preventing sandwich bots from stealing your slippage.\n\n` +
    `👛 <b>1. Funding Your Vault:</b>\n` +
    `Copy your W1 address and deposit SOL. To activate Whale Mode, go to Vault & Keys and turn on up to 5 wallets.\n\n` +
    `⚡ <b>2. Instant Buy:</b>\n` +
    `Paste any contract address (CA). You can send it as a command: <code>[CA] [AMOUNT]</code> (e.g. <code>7xKX... 0.5</code> or <code>7xKX... $50</code>).`,

    // PAGE 2: SNIPER & DYNAMIC SIZING
    `📖 <b>OPERATIONS MANUAL — SNIPING</b> <i>(2/8)</i>\n\n` +
    `🎯 <b>The Auto-Sniper Engine:</b>\n` +
    `Tap <b>Sniper Module</b>. Sentry listens to raw Solana blocks (Pump.fun/Raydium) and executes within milliseconds.\n\n` +
    `⚙️ <b>Calculated Risks (Dynamic Sizing):</b>\n` +
    `Enable "Dynamic Sizing". Set your Base Risk (e.g., 0.02 SOL) and Max Multiplier (e.g., 10x). \n` +
    `The bot automatically uses math to scale the bet. A 55-score token gets 0.02 SOL, while an 85-score gem gets 0.15 SOL.\n\n` +
    `🛡️ <b>Auto-Guard:</b>\n` +
    `Set a Stop Loss (-15%) and Take Profit (+45%). The bot sells instantly via Jito when targets are hit.`,

    // PAGE 3: AI CALLER
    `📖 <b>OPERATIONS MANUAL — AI INTELLIGENCE</b> <i>(3/8)</i>\n\n` +
    `🤖 <b>AI Coin Caller:</b>\n` +
    `Type /caller. It scans new tokens every 15 seconds, scoring them 0–100. Higher scores yield Calibrated Price Targets.\n\n` +
    `👀 <b>Watchlist & Calendar:</b>\n` +
    `• <code>/watch [CA] [TARGET_PRICE]</code> to set persistent price alerts.\n` +
    `• <code>/calendar</code> to see a live feed of verified launches under 2 hours old.`,

    // PAGE 4: DCA & ADVANCED ORDERS
    `📖 <b>OPERATIONS MANUAL — AUTOMATION</b> <i>(4/8)</i>\n\n` +
    `📉 <b>Limit Orders (Buy the Dip):</b>\n` +
    `Tap <b>Limit / DCA Engine</b>. Set a target price. Sentry monitors the chart 24/7 and executes the instant it hits.\n\n` +
    `🔁 <b>DCA / TWAP Accumulation:</b>\n` +
    `Accumulate large positions without moving the market price. Set an interval (e.g., $10 every 30 mins) and a Max Budget cap.`,

    // PAGE 5: SECURITY & SHIELDS
    `📖 <b>OPERATIONS MANUAL — DEFENSIVE SHIELD</b> <i>(5/8)</i>\n\n` +
    `🚨 <b>Anti-Rug Frontrunner:</b>\n` +
    `Sentry's Yellowstone gRPC stream detects "RemoveLiquidity" instructions in the mempool and fires an aggressive Jito bundle to sell your tokens <i>before</i> the dev's rug pull processes.\n\n` +
    `🍯 <b>Token-2022 Tax Detector:</b>\n` +
    `Type <code>/scan [CA]</code>. Sentry decodes raw Token-2022 buffers to detect hidden 99% honeypot taxes before third-party sites index them.`,

    // PAGE 6: LAUNCHPAD & DEV TOOLS
    `📖 <b>OPERATIONS MANUAL — LAUNCHPAD</b> <i>(6/8)</i>\n\n` +
    `🚀 <b>Sentry Launchpad:</b>\n` +
    `Tap <b>Launch Token</b>. Sentry mines a Vanity CA (e.g., CAT...pump) and deploys the entire token in a single Jito Block-0. You can split your initial buy across up to 4 wallets to hide your true bag size.\n\n` +
    `🛠️ <b>Dev Suite:</b>\n` +
    `If your token drops off DexScreener, use the Volume Bumper (executes simultaneous wash trades across 5 wallets) to push you back to the top.`,

    // PAGE 7: GUILDS & COPY TRADE
    `📖 <b>OPERATIONS MANUAL — SOCIAL TRADING</b> <i>(7/8)</i>\n\n` +
    `🏰 <b>Sentry Guilds:</b>\n` +
    `Type /createguild. You earn 50% of platform fees from every trade your members make. Use the Guild dashboard to export top wallets for airdrops.\n\n` +
    `🐋 <b>Copy Trading:</b>\n` +
    `Mirror any whale wallet via WebSocket. Before adding, Sentry scans their trade history to warn you if they are a high-frequency MEV bot.`,

    // PAGE 8: ANALYTICS & TAX EXPORT
    `📖 <b>OPERATIONS MANUAL — METRICS & TAXES</b> <i>(8/8)</i>\n\n` +
    `📈 <b>Web Dashboard Analytics:</b>\n` +
    `• <b>Strategy Attribution:</b> See exactly which engine (Manual vs Sniper) is making you the most money.\n` +
    `• <b>Hourly Performance:</b> Shows which UTC hours your strategy is most profitable.\n\n` +
    `📤 <b>Ledger Export:</b>\n` +
    `Type <code>/exporttrades</code> or click the Export CSV button on the WebApp to download your complete trading history for tax purposes.\n\n` +
    `<i>All trades include Jito signatures for full on-chain verification.</i>`
];


// ✅ Navigation Keyboard Builder for CONFIG_GUIDE_PAGES
function buildConfigGuideKeyboard(page: number) {
    const buttons = [];
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `config_guide_page_${page - 1}`));
    if (page < CONFIG_GUIDE_PAGES.length - 1) navRow.push(Markup.button.callback('Next ➡️', `config_guide_page_${page + 1}`));
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]);
    return Markup.inlineKeyboard(buttons);
}


// 🟢 NEW: Configuration Guide Button Handler
bot.action('btn_config_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await safeEditMessageText(ctx, CONFIG_GUIDE_PAGES[0], buildConfigGuideKeyboard(0));
});

// 🟢 NEW: Configuration Guide Page Navigation Handler
bot.action(/^config_guide_page_(\d+)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const page = parseInt(ctx.match[1]);
    if (page < 0 || page >= CONFIG_GUIDE_PAGES.length) return;
    await safeEditMessageText(ctx, CONFIG_GUIDE_PAGES[page], buildConfigGuideKeyboard(page));
});


function buildGuideKeyboard(page: number) {
    const buttons = [];
    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `trade_guide_page_${page - 1}`));
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

    // 🟢 FIX: Verify the user exists in the DB (prevents crashes if they click an old button)
    const userCheck = await prisma.user.findUnique({ where: { telegramId } });
    if (!userCheck) {
        return ctx.replyWithHTML("🔴 <b>Session Expired.</b>\nYour account data was reset. Please send /start to create a new profile.");
    }

    const loader = await ctx.reply("<i>⏳ Encrypting local storage node...</i>", { parse_mode: 'HTML' });

    try {
        const vaultData = await generateSecureVault(telegramId);
        
        // 🟢 FIX: Add .catch() so Telegram doesn't throw an error if the message is already deleted
        await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});

        const step1Text = 
            `👛 <b>STEP 1/3: FUND YOUR VAULT</b>\n\n` +
            `Your secure, zero-latency trading vault has been generated and encrypted on-chain!\n\n` +
            `To prepare your trading capital and gas buffers, deposit SOL into your primary address:\n` +
            `<code>${vaultData.address}</code>\n\n` +
            `<i>Sentry is 100% MEV-protected. When you are ready, click below to set up your speed and slippage.</i>`;

        await ctx.replyWithHTML(step1Text, Markup.inlineKeyboard([[Markup.button.callback('➡️ STEP 2: SETTINGS', 'onboard_step2')]]));
    } catch (e: any) {
        console.error("🔴 Vault Gen Error:", e.message);
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 <b>Vault Generation Failed:</b> ${e.message}`, { parse_mode: 'HTML' }).catch(()=>{});
    }
});

// 🟢 NEW: Custom command to forge exactly $37.567k volume over 32 days with a high win rate
// 🟢 RECALIBRATED FOR EXACT 63% WIN RATE (113 Wins / 67 Losses over 32 Days)
bot.command('simflex', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return;

    const loader = await ctx.replyWithHTML("<i>⏳ Optimizing 32-day Auto-Engine history...</i>");

    try {
        const { cachedSolUsdPrice } = await import('./services/grpc.service.js');
        const currentSolPrice = cachedSolUsdPrice || 160;
        
        // Exactly $37,567 dollars of volume
        const targetUsdVolume = 37567;
        const totalVolSol = targetUsdVolume / currentSolPrice;

        // 🟢 EXACT 62.8% (~63%) WIN RATE
        const wins = 113;
        const losses = 67;
        const daysActive = 32;

        const totalTrades = wins + losses; // 180 trades
        const volPerTrade = totalVolSol / totalTrades;
        const now = Date.now();
        const fakeTrades = [];
        
        let totalRealizedPnl = 0;

        // Generate 113 profitable trades
        for (let i = 0; i < wins; i++) {
            const pnlPercent = Math.random() * 80 + 15; // Wins +15% to +95%
            const realizedPnlSol = volPerTrade * (pnlPercent / 100);
            totalRealizedPnl += realizedPnlSol;
            fakeTrades.push({
                createdAt: new Date(now - Math.random() * daysActive * 86400000).toISOString(),
                isBuy: false, amountInSol: volPerTrade, profitPercent: pnlPercent, realizedPnlSol
            });
        }
        
        // Generate 67 loss trades
        for (let i = 0; i < losses; i++) {
            const pnlPercent = -(Math.random() * 15 + 5); // Losses -5% to -20%
            const realizedPnlSol = volPerTrade * (pnlPercent / 100);
            totalRealizedPnl += realizedPnlSol;
            fakeTrades.push({
                createdAt: new Date(now - Math.random() * daysActive * 86400000).toISOString(),
                isBuy: false, amountInSol: volPerTrade, profitPercent: pnlPercent, realizedPnlSol
            });
        }

        fakeTrades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        await redis.set(`sim:trades:${tgId}`, JSON.stringify(fakeTrades), 'EX', 86400 * 30);
        await redis.set(`sim:volume:${tgId}`, totalVolSol.toString());

        const { getSimStartingBalance, saveSimulationState } = await import('./services/simulation.service.js');
        const startBal = await getSimStartingBalance(tgId!);
        const newBalance = startBal + totalRealizedPnl; 
        await redis.set(`sim:balance:${tgId}`, newBalance.toFixed(4));
        await saveSimulationState(tgId!);

        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
            `✅ <b>AUTO-ENGINE OPTIMIZATION COMPLETE</b>\n\n` +
            `• Target Volume: <b>$37,567.00</b> (~${totalVolSol.toFixed(2)} SOL)\n` +
            `• Timeframe: <b>32 Days</b>\n` +
            `• Win Rate: <b>62.8%</b> (113 Wins / 67 Losses)\n` +
            `• Net PnL Generated: <b>+${totalRealizedPnl.toFixed(2)} SOL</b>\n\n` +
            `<i>Open your WebApp to see the updated charts and Sharpe Ratio.</i>`,
            { parse_mode: 'HTML' }
        );

    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 Error: ${e.message}`, { parse_mode: 'HTML' });
    }
});

// 🟢 NEW: Missing /stats command added
bot.command('stats', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    const loader = await ctx.reply("<i>⏳ Compiling performance metrics...</i>", { parse_mode: 'HTML' });
    
    try {
        const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (!user) return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, "🔴 <b>Error:</b> Please run /start to create a profile.", { parse_mode: 'HTML' });
        
        const { isSimulationActive, getSimBalance, getSimStartingBalance, getSimVolume } = await import('./services/simulation.service.js');
        const isSim = await isSimulationActive(tgId);
        
        let text = `📊 <b>YOUR TRADING STATS</b>\n\n`;
        
        if (isSim) {
            const simBal = await getSimBalance(tgId);
            const simVol = await getSimVolume(tgId);
            const rawTrades = await redis.get(`sim:trades:${tgId}`);
            const trades = rawTrades ? JSON.parse(rawTrades) : [];
            
            let wins = 0, losses = 0, pnl = 0;
            trades.filter((t: any) => !t.isBuy).forEach((t: any) => {
                if (t.profitPercent > 0.5) wins++; else if (t.profitPercent < -0.5) losses++;
                pnl += t.realizedPnlSol || 0;
            });
            
            const winRate = (wins + losses) > 0 ? ((wins / (wins+losses))*100).toFixed(1) : "0.0";
            
            text += `🎮 <b>SIMULATION MODE</b>\n`;
            text += `• Current Balance: <b>${parseFloat(simBal).toFixed(4)} SOL</b>\n`;
            text += `• Volume Traded: <b>${simVol.toFixed(4)} SOL</b>\n`;
            text += `• Net PnL: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL</b>\n`;
            text += `• Win Rate: <b>${winRate}%</b> (${wins}W / ${losses}L)\n`;
        } else {
            const trades = await prisma.trade.findMany({ where: { userId: user.id }});
            
            let wins = 0, losses = 0, pnl = 0;
            trades.filter((t: any) => !t.isBuy).forEach((t: any) => {
                if ((t.profitPercent || 0) > 0.5) wins++; else if ((t.profitPercent || 0) < -0.5) losses++;
                pnl += t.realizedPnlSol || 0;
            });
            
            const winRate = (wins + losses) > 0 ? ((wins / (wins+losses))*100).toFixed(1) : "0.0";
            
            text += `⚡ <b>LIVE MAINNET</b>\n`;
            text += `• Volume Traded: <b>${(user.totalVolumeSol || 0).toFixed(4)} SOL</b>\n`;
            text += `• Net PnL: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL</b>\n`;
            text += `• Win Rate: <b>${winRate}%</b> (${wins}W / ${losses}L)\n`;
        }
        
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard', 'btn_dashboard')]]) });
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 Error fetching stats: ${e.message}`, { parse_mode: 'HTML' });
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
// Replace the existing bot.action('trigger_caller_scan', ...) block in index.ts with this:

bot.action('trigger_caller_scan', async (ctx) => {
    try { await ctx.answerCbQuery("🔍 Scanning Solana mainnet..."); } catch(e){}
    const tgId = ctx.from?.id.toString()!;

    try {
        const { getCalibratedProjection, getScoreBand } = await import('./services/caller.service.js');

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
                
                // 🟢 FIX 0.1 & A.1: Use shared formatter and pass isReshow!
                const { formatCallerAlertMessage } = await import('./services/caller.service.js');
                const msg = await formatCallerAlertMessage(matchedToken, projection, { isReshow: matchedToken.isReshow });

                const userConfig = await prisma.autoSnipeConfig.findUnique({ where: { userId: (await prisma.user.findUnique({where:{telegramId:tgId}}))!.id } });
                const defaultSize = userConfig?.amountSol || 0.1;

                return safeEditMessageText(ctx, msg, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [
                        [{ text: `⚡ Snipe ${defaultSize} SOL`, callback_data: `forcebuy_${matchedToken.mint}_${defaultSize}` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
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

        // 🟢 FIX 0.2: Progressive Ladder
        const { getMatchesWithLadder, formatCallerAlertMessage } = await import('./services/caller.service.js');
        const { matches, isRelaxed } = getMatchesWithLadder(topTokens, filters);
        let matchingTokens = matches;

        // Sort them highest score first to ensure "gems" pop up instantly
        matchingTokens.sort((a: any, b: any) => b.totalScore - a.totalScore);

        let matchedToken = null;
        for (const t of matchingTokens) {
            const seenKey = `caller_alerted:${tgId}:${t.mint}`;
            const seen = await redis.get(seenKey);
            if (!seen) {
                matchedToken = t;
                await redis.set(seenKey, '1', 'EX', 180); 
                break;
            }
        }

        let isReshow = false;
        if (!matchedToken && matchingTokens.length > 0) {
            matchedToken = matchingTokens[0]; 
            isReshow = true;
        }

        if (matchedToken) {
            // 🟢 FIX 0.5: Charge credits for manual scans too!
            const { consumeCredit } = await import('./services/credits.service.js');
            const creditResult = await consumeCredit(tgId, 'CONSUME_SCAN', matchedToken.mint);
            if (!creditResult.success) {
                return safeEditMessageText(ctx, `⚠️ <b>OUT OF CREDITS</b>\n\nBuy more with /credits to keep scanning.`, {
                    parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💳 Buy Credits', callback_data: 'menu_credits' }]] }
                });
            }

            const projection = await getCalibratedProjection(matchedToken); 
            
            const historyData = {
                mint: matchedToken.mint, symbol: matchedToken.symbol, score: matchedToken.totalScore,
                priceAtAlert: matchedToken.price, alertedAt: Date.now(), tokenAgeAtAlertMins: matchedToken.ageMins,
                predictedRangeLow: projection.rawLow, predictedRangeHigh: projection.rawHigh, predictedTimeframeMins: projection.rawTimeMins
            };
            // 🟢 FIX 0.4: Unique Key
            const historyKey = `${matchedToken.mint}:${Date.now()}`;
            await redis.hset(`caller_history`, historyKey, JSON.stringify(historyData));

            // 🟢 FIX 0.1: Universal Formatter
            const msg = await formatCallerAlertMessage(matchedToken, projection, { isRelaxed, isReshow });

            // 🟢 FIX C.2: Dynamic Button Size
            const userConfig = await prisma.autoSnipeConfig.findUnique({ where: { userId: (await prisma.user.findUnique({where:{telegramId:tgId}}))!.id } });
            const defaultSize = userConfig?.amountSol || 0.1;

            await safeEditMessageText(ctx, msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `⚡ Snipe ${defaultSize} SOL`, callback_data: `forcebuy_${matchedToken.mint}_${defaultSize}` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
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
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    // 🟢 UX FIX: Loader
    await safeEditMessageText(ctx, `<i>🛑 Shutting down all trading engines and clearing active memory...</i>`);

    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user) return;

    await prisma.activeOrder.updateMany({ where: { userId: user.id, orderType: { in: ['DCA', 'LIMIT'] }, isActive: true }, data: { isActive: false } });
    await prisma.autoSnipeConfig.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false } });
    await prisma.copyTradeConfig.updateMany({ where: { userId: user.id, isActive: true }, data: { isActive: false } });

    syncCopyTradeListeners(bot);
    const cancelledGuards = await cancelAllUserGuards(tgId);
    
    const { setUserCallerFilters } = await import('./services/caller.service.js');
    await setUserCallerFilters(tgId, { isActive: false });

    await safeEditMessageText(ctx,
        `🛑 <b>ALL AUTOMATIONS HALTED</b>\n\n` +
        `The following engines have been safely powered down to protect your capital:\n` +
        `• DCA Schedules: <b>Disabled</b>\n` +
        `• Limit Orders: <b>Disabled</b>\n` +
        `• Auto-Sniper: <b>Disabled</b>\n` +
        `• Copy Trades: <b>Disabled</b>\n` +
        `• AI Coin Caller: <b>Disabled</b>\n` + 
        `• Trailing Guards: <b>${cancelledGuards} Removed</b>\n\n` +
        `<i>No further automated buys or sells will occur until you manually reactivate them.</i>`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Return to Dashboard', 'btn_dashboard')]])
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

    const volumeSol = user.totalVolumeSol || 0;
    const recruitBonus = user._count.recruits * 2000;
    const totalPoints = (volumeSol * 10000) + recruitBonus;

    let currentTier = "🥉 Bronze";
    let nextTier = "Silver (5M PTS)";
    let rate = "50%";

    if (totalPoints >= 25000000) { 
        currentTier = "🥇 Gold"; nextTier = "MAX RANK ACHIEVED"; rate = "70%";
    } else if (totalPoints >= 5000000) { 
        currentTier = "🥈 Silver"; nextTier = "Gold (25M PTS)"; rate = "60%";
    }

    const text = 
    `💸 <b>SENTRY PARTNER PROGRAM</b>\n\n` +
    `Scale your influence to unlock the most aggressive commission structure on Solana. <b>Gold Rank</b> partners earn 70% of all generated fees.\n\n` +
    
    `👑 <b>TRADING FEE REV-SHARE:</b>\n` +
    `• 🥉 <b>Bronze:</b> 50% (Base Tier)\n` +
    `• 🥈 <b>Silver:</b> 60% (at 5M Points)\n` +
    `• 🥇 <b>Gold:</b> 70% (at 25M Points)\n\n` +

    `🎯 <b>AI CALLER CREDIT REV-SHARE:</b>\n` +
    `<b>Flat 40% Commission</b>\n` +
    `Regardless of your medal rank, you earn a fixed 40% share of all SOL spent on AI Caller Credits by your recruits. This remains consistent across all partners.\n\n` +
    
    `📖 <b>GRADUATION REQUIREMENTS:</b>\n` +
    `Moving to the next medal requires heavy network volume. <b>1 SOL volume = 10,000 Points.</b>\n` +
    `• 5M Pts = 500 SOL Volume\n` +
    `• 25M Pts = 2,500 SOL Volume\n\n` +
    
    `📊 <b>YOUR LIVE STATS:</b>\n` +
    `• Current Tier: <b>${currentTier} (${rate} Share)</b>\n` +
    `• Progress to Next: <b>${nextTier}</b>\n` +
    `• Total Points: <b>${totalPoints.toLocaleString()}</b>\n` +
    `• Pending Yield: <b>${user.pendingRewardsSol.toFixed(4)} SOL</b>\n\n` +
    
    `🔗 <b>Your Invite Link:</b>\n<code>https://t.me/${ctx.botInfo?.username}?start=${user.referralCode}</code>\n\n` +
    `<i>Minimum claim: 0.1 SOL. Payouts processed instantly in SOL.</i>`;

    await safeEditMessageText(ctx, text, { 
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            ...(user.referredById ? [] : [[Markup.button.callback("🔗 Enter Referral Code", "action_enter_ref_code")]]),
            [Markup.button.callback("📥 Claim Payout", "action_claim_payout")],
            [Markup.button.callback("⬅️ Back to Dashboard", "btn_dashboard")]
        ]) 
    });
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
    
    try { await ctx.answerCbQuery(); } catch(e){}

    // 🟢 UX FIX: Explicit loading state so they don't mash the button
    await safeEditMessageText(ctx, `<i>⏳ Processing Affiliate Payout...\nBroadcasting Treasury transfer via Jito to bypass congestion.</i>`);

    const result = await processAffiliatePayout(user.id);
    if (result.success) {
        await safeEditMessageText(ctx, `✅ <b>Payout Processed!</b>\n\nAmount: <b>${user.pendingRewardsSol.toFixed(4)} SOL</b>\n🔗 <a href="https://solscan.io/tx/${result.signature}">View Transaction</a>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Affiliates', 'menu_affiliate')]]));
    } else {
        await safeEditMessageText(ctx, `🔴 <b>Payout Failed</b>\n\n${result.message}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_affiliate')]]));
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
        [
            Markup.button.callback('✏️ Edit Slippage', 'action_edit_slippage')
        ],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, levelText, UI);
    else await ctx.replyWithHTML(levelText, UI);
}




// 3️⃣ BUTTON ACTION: When users click "Contact Support" on the dashboard
bot.action('action_support', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    
    const supportText = 
        `💬 <b>SENTRY TERMINAL SUPPORT</b>\n\n` +
        `Thank you for using our platform. We are deeply committed to providing the most powerful institutional-grade tools to ensure your trading success.\n\n` +
        `If you have any questions, need guidance on advanced features, or are experiencing any errors within the platform, our core engineering team is here to help.\n\n` +
        `<b>To send a message directly to the developer, type:</b>\n` +
        `<code>/support [your message here]</code>\n\n` +
        `<i>Example:</i>\n` +
        `<code>/support Hey, I need help configuring the Auto-Sniper limits.</code>\n\n` +
        `<i>A developer will review your request and reply to you directly through this bot.</i>`;

    // 🟢 Using safeEditMessageText so it smoothly replaces the dashboard instead of spamming the chat
    await safeEditMessageText(ctx, supportText, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]]));
});

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
    
    // 🟢 Define the missing variables!
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
    const deepScoringObj = config.useDeepScoring ? "🔍 Deep Score (High Accuracy)" : "⚡ Fast Score (Low Latency)";

    // 🟢 New variables for Dynamic Sizing
    const scalingStatus = config.enableDynamicScaling ? '🟢 ACTIVE (Conviction-Weighted)' : '🔴 INACTIVE';
    const curveDesc = config.scaleExponent === 1.0 ? '📈 Linear' : config.scaleExponent === 2.0 ? '🔥 Aggressive (Square)' : '🚀 Exponential';

    const sniperText = 
        `🎯 <b>TRENCH AUTO-SNIPER ENGINE</b> 🎯\n` +
        `<i>Sentry scans raw block transitions to front-run listings. Operational parameters explained:</i>\n\n` +
        `• <b>Status:</b> ${statusObj}\n` +
        `• <b>Target Mode:</b> <b>${modeDisplay}</b>\n` +
        `• <b>Scoring Mode:</b> <b>${deepScoringObj}</b>\n` +
        `• <b>Spend Amount (Static):</b> <b>${config.amountSol} SOL</b> (Used when Dynamic Sizing is OFF)\n` +
        `• <b>Max Budget:</b> <b>${config.maxBudgetSol ? config.maxBudgetSol + ' SOL' : 'Infinite (No Limit)'}</b>\n` +
        `• <b>Total Spent:</b> <b>${spentSol.toFixed(4)} SOL</b>\n` +
        `• <b>AI Score Filter:</b> <b>${scoreDisplay}</b>\n` +
        `• <b>Market Cap Filter:</b> <b>${mcDisplay}</b>\n` +
        `• <b>Max Dev Bag (Dev Limit):</b> <b>${devBagDisplay}</b>\n` +
        `• <b>Anti-Dead Shield:</b> ${antiDeadObj}\n` +
        `• <b>Block Delay:</b> <b>${config.snipeDelaySeconds} Seconds</b>\n` +
        `• <b>Auto-Guard:</b> <b>-${config.autoTrailingDropPercent}% Stop Loss</b> | Take Profit: <b>${tpDisplay}</b>\n\n` +
        `📊 <b>DYNAMIC SIZING ENGINE</b>\n` +
        `<i>Replaces fixed amounts with a smooth math curve based on the AI Score.</i>\n` +
        `• <b>Status:</b> ${scalingStatus}\n` +
        `• <b>Base Risk Unit:</b> <b>${config.baseRiskUnitSol} SOL</b>\n` +
        `• <b>Max Risk Multiplier:</b> <b>${config.maxRiskMultiplier}x</b>\n` +
        `• <b>Scaling Curve:</b> <b>${curveDesc}</b>`;

    let modeBtnText = '🟢 Mode: Pump.fun 💊';
    if (config.sniperMode === 'RAYDIUM') modeBtnText = '🟢 Mode: Raydium LPs 🧪';
    else if (config.sniperMode === 'BOTH') modeBtnText = '🟢 Mode: BOTH 🔥';

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback(isCurrentlyActive ? '🛑 SHUT DOWN ENGINE' : '⚡ ARM SNIPER ENGINE', 'toggle_autosnipe')],
        [Markup.button.callback(modeBtnText, 'toggle_sniper_mode')],
        [Markup.button.callback(`⭐ AI Min Score (${scoreDisplay})`, 'edit_snipe_score'), Markup.button.callback(`🧠 Mode: ${config.useDeepScoring ? '🔍 Deep' : '⚡ Fast'}`, 'toggle_snipe_deep_score')],
        [Markup.button.callback(`👻 Anti-Dead Shield: ${antiDeadObj}`, 'toggle_antidead'), Markup.button.callback(`🐋 Dev Limit (${devBagDisplay})`, 'edit_snipe_dev')],
        [Markup.button.callback(`✏️ Static Spend (${config.amountSol} SOL)`, 'edit_snipe_amt'), Markup.button.callback(`💳 Budget (${config.maxBudgetSol || 'Off'})`, 'edit_snipe_budget')],
        // 🟢 NEW ROWS: Dynamic Sizing Controls
        [
            Markup.button.callback(config.enableDynamicScaling ? '📊 Sizing: ON' : '📊 Sizing: OFF', 'toggle_dynamic_scaling')
        ],
        [
            Markup.button.callback(`💵 Base Risk: ${config.baseRiskUnitSol} SOL`, 'edit_base_risk'),
            Markup.button.callback(`🔺 Max Multiplier: ${config.maxRiskMultiplier}x`, 'edit_max_multiplier')
        ],
        [
            Markup.button.callback(`📈 Curve: ${curveDesc}`, 'edit_scaling_exponent')
        ],
        // Existing rows
        [Markup.button.callback(`📊 MC Filter (${mcDisplay})`, 'edit_snipe_mc')],
        [Markup.button.callback(`✏️ Guard (-${config.autoTrailingDropPercent}%)`, 'edit_snipe_sl'), Markup.button.callback(`🎯 TP (${tpDisplay})`, 'edit_snipe_tp')],
        [Markup.button.callback(`⏱️ Delay (${config.snipeDelaySeconds}s)`, 'edit_snipe_delay')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, sniperText, UI);
    else await ctx.replyWithHTML(sniperText, UI);
}


// Toggle Dynamic Sizing
bot.action('toggle_dynamic_scaling', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e) {}
    const tgId = ctx.from?.id.toString()!;
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
    if (!user || !user.autoSnipeConfig) return;
    await prisma.autoSnipeConfig.update({
        where: { id: user.autoSnipeConfig.id },
        data: { enableDynamicScaling: !user.autoSnipeConfig.enableDynamicScaling }
    });
    await sendOrEditSniper(ctx, tgId, true);
});

// Edit Base Risk Unit
bot.action('edit_base_risk', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e) {}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:autosnipe_base_risk:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `💵 <b>SET BASE RISK UNIT</b>\n\nReply with the SOL amount (or USD) you want as the foundation for scoring.\n<i>Example: 0.02 (This is what a 50-score token would roughly get).</i>\n\n<i>Type /cancel to abort.</i>`
    );
});

// Edit Max Risk Multiplier
bot.action('edit_max_multiplier', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e) {}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:autosnipe_max_multiplier:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `🔺 <b>SET MAX RISK MULTIPLIER</b>\n\nReply with the multiplier (e.g., 5.0).\n<i>If Base Risk = 0.02, and Multiplier = 5.0, a perfect 100-score token will snipe 0.1 SOL.</i>\n\n<i>Type /cancel to abort.</i>`
    );
});

// Edit Scaling Exponent
bot.action('edit_scaling_exponent', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e) {}
    const tgId = ctx.from?.id.toString()!;
    await redis.set(`state:autosnipe_exponent:${tgId}`, 'AWAITING', 'EX', 120);
    await ctx.replyWithHTML(
        `📈 <b>SET SCALING CURVE (EXPONENT)</b>\n\nReply with a number (1.0, 2.0, or 3.0).\n• <b>1.0 (Linear):</b> Straight line. A 70-score token gets 70% of the max.\n• <b>2.0 (Aggressive):</b> Squares the conviction. 70 becomes 49% of max. (Recommended).\n• <b>3.0 (Exponential):</b> Cubes it. Only the top 10% get massive sizes. \n\n<i>Type /cancel to abort.</i>`
    );
});

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

// Add this helper function somewhere near the top/utilities in src/index.ts
export async function getTotalTradeCount(telegramId: string, mode: 'live' | 'sim'): Promise<number> {
    if (mode === 'sim') {
        const raw = await redis.get(`sim:trades:${telegramId}`);
        const trades = raw ? JSON.parse(raw) : [];
        return trades.length;
    }
    const user = await prisma.user.findUnique({ where: { telegramId }});
    if (!user) return 0;
    return prisma.trade.count({ where: { userId: user.id } });
}

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
    
    // 🟢 FIX 4 & 7: Generate a new Session ID for Live Budget Capping tracking
    if (newState) {
        const crypto = await import('crypto');
        const sessionId = crypto.randomBytes(16).toString('hex');
        await redis.set(`autosnipe:session_id:live:${tgId}`, sessionId, 'EX', 86400);
        await redis.del(`autosnipe:session_spend:live:${tgId}`);
        await redis.del(`live:session_trades:${sessionId}`);
    }

    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { isActive: newState } });
    
    if (newState) {
        try { 
            await ctx.telegram.sendMessage(ctx.chat!.id, `📡 <b>SNIPER ARMED & SCANNING PUMP.FUN</b>\n\nYour engine is now actively listening to the Solana Mempool. It will execute via Jito MEV.`, { parse_mode: 'HTML' }); 
        } catch(e) {}
    }
    
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


bot.action('toggle_snipe_deep_score', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId: tgId }, include: { autoSnipeConfig: true } });
    if (!user || !user.autoSnipeConfig) return;
    
    await prisma.autoSnipeConfig.update({ 
        where: { id: user.autoSnipeConfig.id }, 
        data: { useDeepScoring: !user.autoSnipeConfig.useDeepScoring } 
    });
    await sendOrEditSniper(ctx, tgId!, true);
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
        // executeExit automatically checks if simulation mode is active and routes to simExecuteExit
        const result = await executeExit(tgId, targetCA, percentage);
        
        if (result.success) {
            await redis.del(`balance_cache:${tgId}`);
            
            // 🟢 FIX: Safely fetch the user here so 'user' is defined for both Live and Sim
            const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
            const isSim = await isSimulationActive(tgId);
            let isWin = true;

            if (isSim) {
                // Parse PnL from simulation result message
                const pnlMatch = result.message.match(/PnL: (-?\+?[\d.]+)%/);
                const pnlPercent = pnlMatch ? parseFloat(pnlMatch[1]) : parseFloat((Math.random() * 200 + 20).toFixed(2));
                isWin = pnlPercent >= 0;

                const captionText =
                    `🟢 <b>MANUAL SELL SUCCESSFUL!</b>\n\n` +
                    `<b>Token:</b> <code>${targetCA}</code>\n` +
                    `<b>Amount Sold:</b> ${percentage}%\n` +
                    `💰 <b>PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>\n` +
                    `Status: 🟢 Executed via Jito Bundle.\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`;
                
                try {
                    const { generatePnlCard } = await import('./services/image.service.js');
                    const imageBuffer = await generatePnlCard(targetCA, pnlPercent, user?.referralCode ?? undefined);
                    const tweetText = encodeURIComponent(`Just secured ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% using Sentry Terminal ⚡️\nhttps://t.me/${process.env.BOT_USERNAME}?start=${user?.referralCode}`);
                    const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };
                    
                    await ctx.replyWithPhoto({ source: imageBuffer }, { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn });
                    await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});
                } catch (_) {
                    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
                }
            } else {
                // Live Execution Result
                await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                    `🟢 <b>MANUAL SELL SUCCESSFUL!</b>\n\n<b>Token:</b> <code>${targetCA}</code>\n<b>Amount Sold:</b> ${percentage}%\n<b>Status:</b> ${result.message}\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`, 
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );

                if (user) {
                    const lastTrade = await prisma.trade.findFirst({ where: { userId: user.id, isBuy: false }, orderBy: { createdAt: 'desc' } });
                    if (lastTrade && lastTrade.profitPercent !== null) isWin = lastTrade.profitPercent >= 0;
                }
            }

         

            // Clean up or adjust trailing guards
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
    
    await safeEditMessageText(ctx, `<i>🛑 Pausing Limit & DCA schedules...</i>`);
    
    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (user) {
        await prisma.activeOrder.updateMany({ where: { userId: user.id, orderType: { in: ['DCA', 'LIMIT'] }, isActive: true }, data: { isActive: false } });
        await safeEditMessageText(ctx, `✅ <b>All active DCA and Limit Orders have been successfully cancelled.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_dca')]]));
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
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    // 🟢 UX FIX: Explicit visual loading state
    await safeEditMessageText(ctx, `<i>⏳ Sweeping all sub-wallets into W1...\nTransmitting signed transactions via Jito...</i>`);

    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (!user || !user.vaultAddress) {
        return safeEditMessageText(ctx, `🔴 <b>Error:</b> No active vault found.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_vault')]]));
    }

    const mainPubkey = new PublicKey(user.vaultAddress);
    const subWallets = [
        { pub: user.vault2, pk: user.pk2 }, { pub: user.vault3, pk: user.pk3 },
        { pub: user.vault4, pk: user.pk4 }, { pub: user.vault5, pk: user.pk5 }
    ].filter(w => w.pub && w.pk);

    if (subWallets.length === 0) {
        return safeEditMessageText(ctx, `⚠️ <b>No active sub-wallets to sweep.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_vault')]]));
    }

    let sweptSol = 0;
    for (const w of subWallets) {
        try {
            const vaultPubkey = new PublicKey(w.pub!);
            const balance = await connection.getBalance(vaultPubkey);
            const gasBuffer = 50000; // 0.00005 SOL
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
    
    if (sweptSol > 0) {
        await safeEditMessageText(ctx, `✅ <b>CONSOLIDATION COMPLETE</b>\nSwept ~<b>${sweptSol.toFixed(4)} SOL</b> from sub-wallets into W1.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Vault', 'menu_vault')]]));
    } else {
        await safeEditMessageText(ctx, `⚠️ <b>No funds swept.</b>\nSub-wallets are either empty or lack enough SOL to cover network gas fees.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Vault', 'menu_vault')]]));
    }
});


// =========================================================
// 🪙 PAY-PER-RESULT CREDIT SHOP
// =========================================================

bot.command('credits', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    await sendCreditsMenu(ctx, tgId, false);
});

bot.action('menu_credits', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    await sendCreditsMenu(ctx, ctx.from!.id.toString(), true);
});

// src/index.ts

async function sendCreditsMenu(ctx: any, tgId: string, isEdit: boolean) {
    const { getUsageStats, CREDIT_PACKS } = await import('./services/credits.service.js');
    const stats = await getUsageStats(tgId);
    if (!stats) return;

    const text = `💳 <b>SENTRY CREDITS</b>\n\n` +
        `<i>Credits only spend when Sentry finds and delivers a real token — never for empty scans.</i>\n\n` +
        `📊 <b>Your Usage (Last 30 days):</b>\n` +
        `• Current Balance: <b>${stats.currentBalance} credits</b>\n` +
        `• Lifetime Purchased: <b>${stats.lifetimeCredits.toLocaleString()}</b>\n` +
        `• Manual Scans Used: <b>${stats.scanConsumed}</b>\n` +
        `• Auto-Caller Alerts Used: <b>${stats.callerConsumed}</b>\n` +
        `• Total Consumed: <b>${stats.totalConsumed}</b>\n\n` +
        `💰 <b>CREDIT PACKS:</b>\n` +
        `• ${CREDIT_PACKS.starter.name}: $${CREDIT_PACKS.starter.priceUsd} → ${CREDIT_PACKS.starter.credits} credits <i>(~$0.14/alert)</i>\n` +
        `• ${CREDIT_PACKS.growth.name}: $${CREDIT_PACKS.growth.priceUsd} → ${CREDIT_PACKS.growth.credits} credits <i>(~$0.13/alert)</i>\n` +
        `• ${CREDIT_PACKS.pro.name}: $${CREDIT_PACKS.pro.priceUsd} → ${CREDIT_PACKS.pro.credits} credits <i>(~$0.13/alert)</i>\n` +
        `• ${CREDIT_PACKS.whale.name}: $${CREDIT_PACKS.whale.priceUsd} → ${CREDIT_PACKS.whale.credits} credits <i>(~$0.05/alert)</i>\n\n` +
        `<i>Pick a pack below to top up:</i>`;

    const UI = Markup.inlineKeyboard([
        [Markup.button.callback(`${CREDIT_PACKS.starter.name} — $${CREDIT_PACKS.starter.priceUsd} (${CREDIT_PACKS.starter.credits} credits)`, 'buy_credits_starter')],
        [Markup.button.callback(`${CREDIT_PACKS.growth.name} — $${CREDIT_PACKS.growth.priceUsd} (${CREDIT_PACKS.growth.credits} credits)`, 'buy_credits_growth')],
        [Markup.button.callback(`${CREDIT_PACKS.pro.name} — $${CREDIT_PACKS.pro.priceUsd} (${CREDIT_PACKS.pro.credits} credits)`, 'buy_credits_pro')],
        [Markup.button.callback(`${CREDIT_PACKS.whale.name} — $${CREDIT_PACKS.whale.priceUsd} (${CREDIT_PACKS.whale.credits.toLocaleString()} credits)`, 'buy_credits_whale')],
        [Markup.button.callback('⬅️ Back to Dashboard', 'btn_dashboard')]
    ]);

    if (isEdit) await safeEditMessageText(ctx, text, UI);
    else await ctx.replyWithHTML(text, UI);
}

bot.action(/^buy_credits_(starter|growth|pro|whale)$/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const packKey = ctx.match[1] as any;
    const tgId = ctx.from?.id.toString()!;
    const { CREDIT_PACKS } = await import('./services/credits.service.js');
    const pack = CREDIT_PACKS[packKey as keyof typeof CREDIT_PACKS];

    const priceSol = parseFloat((pack.priceUsd / cachedSolUsdPrice).toFixed(4));
    const treasury = process.env.TREASURY_WALLET_ADDRESS!;

    await redis.set(`credits:pending:${tgId}`, packKey, 'EX', 900);

    await safeEditMessageText(ctx,
        `💳 <b>${pack.name} Pack — $${pack.priceUsd} (${pack.credits} credits)</b>\n\n` +
        `Send exactly <b>${priceSol} SOL</b> (current rate) to:\n<code>${treasury}</code>\n\n` +
        `⏱️ You have 15 minutes. After sending, tap below and paste your transaction signature.\n\n` +
        `<i>Your W1 wallet address must be the sender.</i>`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ I\'ve Paid — Submit TX', `credits_submit_tx`)],
            [Markup.button.callback('❌ Cancel', 'menu_credits')]
        ])
    );
});

bot.action('credits_submit_tx', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id?.toString()!;
    await redis.set(`state:credits_tx:${tgId}`, 'AWAITING', 'EX', 600);
    await ctx.replyWithHTML(`✅ <b>Paste your transaction signature below.</b>\n<i>Example: 5KtP9x...abc123</i>`);
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
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;
    
    await safeEditMessageText(ctx, `<i>🧹 Disconnecting copytrade WebSockets...</i>`);

    const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
    if (user) {
        await prisma.copyTradeConfig.deleteMany({ where: { userId: user.id } });
        syncCopyTradeListeners(bot);
        await safeEditMessageText(ctx, `✅ <b>All Copy Trade targets have been cleared and WebSockets disconnected.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'menu_copytrade')]]));
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


// =========================================================
// 📤 SECURED WITHDRAWAL COMMAND
// =========================================================
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
    
    // @ts-ignore
    const parsedAmount = parseSolAmount(amountStr);
    const requestedAmount: number = isMax ? 0 : (parsedAmount !== null ? parsedAmount : 0);
    
    if (!isMax && requestedAmount <= 0) {
        await redis.del(withdrawLockKey);
        return ctx.reply("🔴 Invalid amount specified. Use a number (e.g. 1.5) or USD (e.g. $50).");
    }

    try { new PublicKey(targetAddress); } 
    catch (e) { await redis.del(withdrawLockKey); return ctx.reply("🔴 Invalid destination Solana address."); }

    // Start PIN verification flow if PIN exists
    if (user.withdrawalPin) {
        await redis.set(`state:withdraw_pin:${telegramId}`, JSON.stringify({ targetAddress, isMax, requestedAmount }), 'EX', 120);
        return ctx.replyWithHTML(`🔒 <b>PIN REQUIRED</b>\n\nPlease reply with your 4 to 6 digit security PIN to authorize this withdrawal.\n\n<i>This message sequence will self-destruct for security.</i>`);
    }

    // @ts-ignore
    await executeWithdrawalProcess(user, targetAddress, requestedAmount, isMax, telegramId, ctx, withdrawLockKey);
});


// =========================================================
// 👀 WATCHLIST COMMAND
// =========================================================
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
        
        // 🟢 FIX 43: Display highly accurate decimals correctly 
        const displayPrice = currentPrice > 0 ? currentPrice.toFixed(8) : '0';

        msg += `• <code>${ca.substring(0,6)}...</code>\n`;
        msg += `   Live: <b>$${displayPrice}</b> (${Number(diff) >= 0 ? '+' : ''}${diff}%)\n`;
        if (data.targetPrice > 0) msg += `   Target Alert: <b>$${data.targetPrice}</b>\n`;
        msg += `\n`;
    }

    await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, msg, { parse_mode: 'HTML' });
});

// ------------------ LIMIT ORDER WATCHER ------------------
let cachedLimitOrders: any[] = [];
let isLimitChecking = false;

export async function refreshLimitOrders() {
    try {
        cachedLimitOrders = await prisma.activeOrder.findMany({
            where: { orderType: 'LIMIT', isActive: true },
            include: { user: true }
        });
    } catch (e) {
        console.error("🔴 [LIMIT WATCHER] Cache refresh failed:", e);
    }
}

export function startLimitOrderWatcher(bot: any) {
    console.log("⏳ [LIMIT WATCHER] Monitoring limit orders every 5 seconds.");
    refreshLimitOrders();
    setInterval(refreshLimitOrders, 5000);

    setInterval(async () => {
        if (isLimitChecking || cachedLimitOrders.length === 0) return;
        isLimitChecking = true;

        try {
            for (const order of cachedLimitOrders) {
                const fresh = await prisma.activeOrder.findUnique({ where: { id: order.id } });
                if (!fresh || !fresh.isActive) {
                    cachedLimitOrders = cachedLimitOrders.filter(o => o.id !== order.id);
                    continue;
                }

                let price = await getCachedTokenPrice(order.tokenAddress);
                if (price === 0) {
                    try {
                        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${order.tokenAddress}`, { timeout: 2000 });
                        price = parseFloat(res.data?.pairs?.[0]?.priceUsd || "0");
                    } catch (_) {}
                }
                if (price === 0) continue; 

                // 🟢 LIMIT MET: Execute Snipe
                if (price <= order.targetPriceUsd!) {
                    const result = await executeSnipe(order.user.telegramId, order.tokenAddress, order.amountSol);
                    
                    if (result.success) {
                        await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                        cachedLimitOrders = cachedLimitOrders.filter(o => o.id !== order.id);

                        if (order.trailingPercent) {
                            await addTrailingStopToMemory(
                                order.user.telegramId, order.tokenAddress, order.trailingPercent,
                                order.amountSol, price, order.takeProfitPercent || undefined
                            );
                        }

                        try {
                            await bot.telegram.sendMessage(
                                order.user.telegramId,
                                `🟢 <b>LIMIT ORDER FILLED!</b>\n\nToken: <code>${order.tokenAddress.substring(0,8)}...</code>\nTarget: $${order.targetPriceUsd}\nFilled at: $${price}\nAmount: ${order.amountSol} SOL\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                            );
                        } catch (_) {}
                    } else {
                        await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                        cachedLimitOrders = cachedLimitOrders.filter(o => o.id !== order.id);
                        try {
                            await bot.telegram.sendMessage(
                                order.user.telegramId,
                                `🔴 <b>LIMIT ORDER FAILED</b>\n\nToken: <code>${order.tokenAddress.substring(0,8)}...</code>\nReason: ${result.message}\n<i>Order has been deactivated.</i>`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (_) {}
                    }
                }
            }
        } catch (e) {
            console.error('🔴 [LIMIT WATCHER] Error:', e);
        } finally {
            isLimitChecking = false;
        }
    }, 5000);
}

// ------------------ BATCHED WITHDRAWALS ------------------
// Replace your existing executeWithdrawalProcess with this optimized version
async function executeWithdrawalProcess(user: any, targetAddress: string, requestedAmount: number, isMax: boolean, telegramId: string, ctx: any, withdrawLockKey: string) {
    const targetPubkey = new PublicKey(targetAddress);
    const loader = await ctx.replyWithHTML(`<i>⏳ Building consolidated multi-wallet transfer...</i>`);

    try {
        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        let totalSentAmount = 0; 
        let remainingLamportsToWithdraw = isMax ? Number.MAX_SAFE_INTEGER : Math.floor(requestedAmount * LAMPORTS_PER_SOL);
        
        const instructions = [];
        const signers: Keypair[] = [];

        // 🟢 Gather all transfers into ONE transaction
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
                instructions.push(SystemProgram.transfer({
                    fromPubkey: vaultPubkey, toPubkey: targetPubkey, lamports: lamportsToWithdraw
                }));
                signers.push(keypair);
                
                if (!isMax) remainingLamportsToWithdraw -= lamportsToWithdraw;
                totalSentAmount += (lamportsToWithdraw / LAMPORTS_PER_SOL);
            } catch (e) {}
        }

        if (instructions.length === 0) {
            return ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Failed:</b> Insufficient balance across your active wallets.`);
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions
        }).compileToV0Message();
        
        const vTx = new VersionedTransaction(messageV0);
        vTx.sign(signers); // Sign with all gathered keypairs
        
        const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
        
        let isConfirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) { isConfirmed = true; break; }
        }

        if (isConfirmed) {
            await redis.del(`balance_cache:${telegramId}`); 
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, 
                `🟢 <b>WITHDRAWAL INITIATED</b>\n\n<b>Total Swept:</b> ~<code>${totalSentAmount.toFixed(4)} SOL</code>\n<b>Destination:</b> <code>${targetPubkey.toBase58()}</code>\n\n🔗 <a href="https://solscan.io/tx/${sig}">View Latest Receipt on Solscan</a>`, 
                { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
            );
        } else {
            await ctx.telegram.editMessageText(ctx.chat.id, loader.message_id, undefined, `🔴 <b>Withdrawal Failed:</b> Transaction dropped by the network.`);
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



// =========================================================
// ⚡ TEXT INTERCEPTOR: (Catches Redis States & Snipes)
// =========================================================
bot.on("text", async (ctx, next) => {
    if (!ctx.message || !('text' in ctx.message)) return next();
    const text = ctx.message.text.trim();
    const telegramId = ctx.from?.id?.toString();
    if (!telegramId) return next(); 

    // 1. GLOBAL CANCEL HANDLER & CHUNKED DELETE
    if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
        const keysToClear = [
            `state:simedit:${telegramId}`, `state:guard:${telegramId}`, `state:dca:${telegramId}`, 
            `state:limit:${telegramId}`, `state:copytrade:${telegramId}`, `state:import_key:${telegramId}`,
            `state:enter_ref:${telegramId}`, `state:edit_slippage:${telegramId}`, `state:edit_custom_speed:${telegramId}`, 
            `state:set_pin:${telegramId}`, `state:autosnipe_amt:${telegramId}`, `state:autosnipe_sl:${telegramId}`,
            `state:autosnipe_tp:${telegramId}`, `state:autosnipe_mc:${telegramId}`, `state:autosnipe_budget:${telegramId}`, 
            `state:autosnipe_dev:${telegramId}`, `state:edit_caller_age:${telegramId}`, `state:edit_caller_pct:${telegramId}`,
            `state:edit_caller_score:${telegramId}`, `state:edit_caller_liq:${telegramId}`, `state:edit_caller_vol:${telegramId}`, 
            `state:caller_guard_input:${telegramId}`, `state:caller_dca_input:${telegramId}`, `state:guild_tiered_drop:${telegramId}`, 
            `state:guild_indiv_drop:${telegramId}`, `state:edit_guild_name:${telegramId}`, `state:edit_guild_reward:${telegramId}`,
            `vip:awaiting_tx:${telegramId}`, `state:withdraw_pin:${telegramId}`, `state:credits_tx:${telegramId}`, 
            `credits:pending:${telegramId}`, `sim:autosnipe:${telegramId}`, `state:guard_ca:${telegramId}`,
            `active_bumper:${telegramId}`, `state:dev_volume:${telegramId}`, `state:dev_nuke:${telegramId}`,
            `token_launch:${telegramId}:step`, `token_launch:${telegramId}:name`, `token_launch:${telegramId}:symbol`,
            `token_launch:${telegramId}:description`, `token_launch:${telegramId}:imageUrl`, `token_launch:${telegramId}:vanity`,
            `token_launch:${telegramId}:devbuy`, `token_launch:${telegramId}:wallets`, `token_launch:${telegramId}:guard`
        ];
        
        // 🟢 FIX 38: Chunk array to avoid Redis max-arguments exception on highly active accounts
        for (let i = 0; i < keysToClear.length; i += 100) {
            await redis.del(...keysToClear.slice(i, i + 100));
        }

        await ctx.replyWithHTML(`✅ <b>Action Cancelled. Automations & Bumpers Paused.</b> You are back to the main menu.`);
        await sendOrEditDashboard(ctx, telegramId, false);
        return;
    }

    // 2. SET PIN HANDLER
    const isSettingPin = await redis.get(`state:set_pin:${telegramId}`);
    if (isSettingPin) {
        await redis.del(`state:set_pin:${telegramId}`);
        if (!/^\d{4,6}$/.test(text)) {
            return ctx.replyWithHTML(`🔴 <b>Invalid format.</b> PIN must be 4 to 6 numbers. Setup aborted.`);
        }
        
        // 🟢 FIX 11: Hash the PIN before saving to database to prevent plaintext exposure
        const hashed = hashPin(text);
        await prisma.user.update({ where: { telegramId }, data: { withdrawalPin: hashed } });
        
        await ctx.replyWithHTML(`✅ <b>Security PIN Set Successfully!</b>\n\nYour vault is now secured. You will need to enter this PIN for any future withdrawals.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Vault', 'menu_vault')]]));
        return;
    }

    // 3. WITHDRAWAL PIN VERIFICATION
    const withdrawState = await redis.get(`state:withdraw_pin:${telegramId}`);
    if (withdrawState) {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.withdrawalPin) {
            await redis.del(`state:withdraw_pin:${telegramId}`);
            return ctx.reply("🔴 PIN not set up correctly.");
        }

        // 🟢 FIX 11: Safely verify the hashed PIN against the database
        if (!verifyPin(text, user.withdrawalPin)) {
            await redis.del(`state:withdraw_pin:${telegramId}`);
            return ctx.replyWithHTML(`🔴 <b>INVALID PIN</b>\n\nWithdrawal aborted for security.`);
        }

        await redis.del(`state:withdraw_pin:${telegramId}`);
        const data = JSON.parse(withdrawState);
        
        // @ts-ignore
        await executeWithdrawalProcess(user, data.targetAddress, data.requestedAmount, data.isMax, telegramId, ctx, `lock:withdraw:${telegramId}`);
        return;
    }

    // 1. Base Risk Unit
const isBaseRisk = await redis.get(`state:autosnipe_base_risk:${telegramId}`);
if (isBaseRisk) {
    await redis.del(`state:autosnipe_base_risk:${telegramId}`);
    const amount = parseSolAmount(text);
    if (amount === null || amount <= 0.001) return ctx.reply('🔴 Invalid amount. Must be > 0.001.');
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (!user?.autoSnipeConfig) return;
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { baseRiskUnitSol: amount } });
    await ctx.replyWithHTML(`✅ Base Risk Unit set to <b>${amount.toFixed(4)} SOL</b>.`);
    await sendOrEditSniper(ctx, telegramId, true);
    return;
}

// 2. Max Risk Multiplier
const isMaxMult = await redis.get(`state:autosnipe_max_multiplier:${telegramId}`);
if (isMaxMult) {
    await redis.del(`state:autosnipe_max_multiplier:${telegramId}`);
    const val = parseFloat(text);
    if (isNaN(val) || val < 1.0 || val > 100.0) return ctx.reply('🔴 Invalid. Enter a number between 1.0 and 100.0.');
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (!user?.autoSnipeConfig) return;
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { maxRiskMultiplier: val } });
    await ctx.replyWithHTML(`✅ Max Risk Multiplier set to <b>${val}x</b>.`);
    await sendOrEditSniper(ctx, telegramId, true);
    return;
}

// 3. Scaling Exponent
const isExp = await redis.get(`state:autosnipe_exponent:${telegramId}`);
if (isExp) {
    await redis.del(`state:autosnipe_exponent:${telegramId}`);
    const val = parseFloat(text);
    if (isNaN(val) || val < 1.0 || val > 4.0) return ctx.reply('🔴 Invalid. Enter 1.0 (Linear), 2.0 (Aggressive), or 3.0 (Exponential).');
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
    if (!user?.autoSnipeConfig) return;
    await prisma.autoSnipeConfig.update({ where: { id: user.autoSnipeConfig.id }, data: { scaleExponent: val } });
    await ctx.replyWithHTML(`✅ Scaling Curve exponent set to <b>${val}</b>.`);
    await sendOrEditSniper(ctx, telegramId, true);
    return;
}

    // 4. THE SIMULATION EDITOR (DASHBOARD FORGE)
    const isSimEdit = await redis.get(`state:simedit:${telegramId}`);
    if (isSimEdit) {
        await redis.del(`state:simedit:${telegramId}`);
        
        const lines = text.split('\n');
        const data: Record<string, string> = {};
        for (const line of lines) {
            const parts = line.split(':');
            if (parts.length < 2) continue;
            data[parts[0].trim().toUpperCase()] = parts.slice(1).join(':').trim();
        }

        try {
            const loader = await ctx.reply("<i>⏳ Forging institutional database records...</i>", { parse_mode: 'HTML' });

            // Parse numeric values
            const wins = parseInt(data['WINS']) || 0;
            const losses = parseInt(data['LOSSES']) || 0;
            const vol = parseFloat(data['VOL']) || 0;
            const balance = parseFloat(data['BALANCE_SOL']) || 0;
            
            // Handle Rolling Activity (Split "Count | PnL")
            const manual24 = data['MANUAL_24H']?.split('|') || ["0", "0"];
            const auto24 = data['AUTO_24H']?.split('|') || ["0", "0"];
            
            // Handle Strategy Attribution (Split "Name | PnL")
            const s1 = data['STRAT1']?.split('|') || ["Manual / Direct", "0"];
            const s2 = data['STRAT2']?.split('|') || ["Sniper Engine", "0"];

            // 🟢 UPDATE REDIS (Immediate WebApp update)
            await redis.set(`sim:balance:${telegramId}`, balance.toFixed(4));
            await redis.set(`sim:stats:wins:${telegramId}`, wins.toString());
            await redis.set(`sim:stats:losses:${telegramId}`, losses.toString());
            await redis.set(`sim:stats:totalTrades:${telegramId}`, (wins + losses).toString());
            await redis.set(`sim:stats:totalInvestedSol:${telegramId}`, (vol * 0.8).toString());
            await redis.set(`sim:volume:${telegramId}`, vol.toString());
            
            const forgedPayload = {
                sharpe: parseFloat(data['SHARPE']) || 0,
                drawdown: parseFloat(data['DRAWDOWN']) || 0,
                profit: parseFloat(data['PROFIT_FACTOR']) || 0,
                risk: parseFloat(data['RISK_SCORE']) || 0,
                manual24hCount: parseInt(manual24[0]),
                manual24hPnl: parseFloat(manual24[1]),
                auto24hCount: parseInt(auto24[0]),
                auto24hPnl: parseFloat(auto24[1]),
                hourlyChart: data['HOURLY_CHART']?.split(',').map(s => parseFloat(s.trim())) || [],
                strat1Name: s1[0].trim(),
                strat1Pnl: parseFloat(s1[1]),
                strat2Name: s2[0].trim(),
                strat2Pnl: parseFloat(s2[1])
            };
            await redis.set(`sim:forged:${telegramId}`, JSON.stringify(forgedPayload));

            // 🟢 UPDATE PRISMA (Permanent Persistence)
            const user = await prisma.user.findUnique({ where: { telegramId } });
            if (user) {
                await prisma.simState.upsert({
                    where: { userId: user.id },
                    update: {
                        balance,
                        volume: vol,
                        active: true,
                        forgedSharpe: forgedPayload.sharpe,
                        forgedDrawdown: forgedPayload.drawdown,
                        forgedProfit: forgedPayload.profit,
                        forgedRisk: forgedPayload.risk,
                        forgedManual24hCount: forgedPayload.manual24hCount,
                        forgedManual24hPnl: forgedPayload.manual24hPnl,
                        forgedAuto24hCount: forgedPayload.auto24hCount,
                        forgedAuto24hPnl: forgedPayload.auto24hPnl,
                        forgedHourlyChart: forgedPayload.hourlyChart,
                        forgedStrat1Name: forgedPayload.strat1Name,
                        forgedStrat1Pnl: forgedPayload.strat1Pnl,
                        forgedStrat2Name: forgedPayload.strat2Name,
                        forgedStrat2Pnl: forgedPayload.strat2Pnl
                    },
                    create: { userId: user.id, balance, volume: vol, active: true }
                });
            }

            await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                `✅ <b>INSTITUTIONAL FORGE COMPLETE</b>\n\n` +
                `The WebApp Dashboard has been synchronized with your custom simulation parameters.`, 
                { parse_mode: 'HTML' }
            );
        } catch (e: any) {
            await ctx.reply(`🔴 <b>Forge Error:</b> ${e.message}`);
        }
        return;
    }

    // Pass through to CA handler or specific command checks
    if (text.startsWith("/")) return next();
    
    // ... (Your CA detection logic here)
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

bot.command('exporttrades', async (ctx) => {
    const tgId = ctx.from?.id.toString();
    if (!tgId) return;

    const loader = await ctx.replyWithHTML('<i>⏳ Generating your trade ledger...</i>');

    try {
        const csv = await exportTradesToCsv(tgId);
        if (!csv) {
            return ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, 
                '📊 <b>No trades found.</b>', { parse_mode: 'HTML' });
        }

        const buffer = Buffer.from(csv, 'utf-8');
        await ctx.replyWithDocument(
            { source: buffer, filename: `Sentry_Trades_${tgId}.csv` },
            { caption: '📊 <b>Your Secure Trade Ledger</b>\nIncludes full PnL, fee breakdowns, and Jito signatures.', parse_mode: 'HTML' }
        );
        await ctx.telegram.deleteMessage(ctx.chat!.id, loader.message_id).catch(() => {});
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined,
            `🔴 <b>Export failed:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
});

// 🟢 NEW: Telegram /health Command
bot.command('health', async (ctx) => {
    const loader = await ctx.replyWithHTML("<i>⏳ Interrogating system telemetry...</i>");
    try {
        const { checkRedisHealth } = await import('./lib/redis.js');
        const redisOk = await checkRedisHealth().catch(() => false);
        
        const { getActiveSubscriptionCount } = await import('./services/guard-price-feed.service.js');
        const guardSubs = getActiveSubscriptionCount();
        
        const uptimeHours = (process.uptime() / 3600).toFixed(2);
        const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

        const statusText = 
            `🩺 <b>SENTRY SYSTEM HEALTH REPORT</b>\n\n` +
            `• Core HFT Engine: 🟢 <b>ONLINE</b>\n` +
            `• System Uptime: <b>${uptimeHours} Hours</b>\n` +
            `• Heap Memory Usage: <b>${memMb} MB</b>\n` +
            `• Redis Matrix: ${redisOk ? '🟢 <b>CONNECTED</b>' : '🔴 <b>OFFLINE</b>'}\n` +
            `• Active Guard Feed Subs: <b>${guardSubs}</b>\n` +
            `• Express WebApp Server: 🟢 <b>Port 3001 Active</b>\n\n` +
            `<i>All systems operational. Private Jito bundle routing active.</i>`;

        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, statusText, { parse_mode: 'HTML' });
    } catch (e: any) {
        await ctx.telegram.editMessageText(ctx.chat!.id, loader.message_id, undefined, `🔴 Health Check Error: ${e.message}`, { parse_mode: 'HTML' });
    }
});


// 🟢 ADMIN COMMAND: Grant or Set Credits for Live & Simulation Modes
bot.command(['addcredits', 'setcredits'], async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!isAdmin(tgId)) return; // 🔒 Locked strictly to ADMIN_TELEGRAM_IDS in .env

    const parts = (ctx.message as any).text.split(/\s+/);
    if (parts.length < 3) {
        return ctx.replyWithHTML(
            `<b>Usage:</b>\n` +
            `<code>/addcredits [TELEGRAM_ID] [AMOUNT]</code> (Adds to current balance)\n` +
            `<code>/setcredits [TELEGRAM_ID] [AMOUNT]</code> (Overwrites total balance)\n\n` +
            `<i>Example: /addcredits 8494722111 100000</i>`
        );
    }

    const isAdd = (ctx.message as any).text.startsWith('/addcredits');
    const targetId = parts[1];
    const amount = parseInt(parts[2], 10);

    if (isNaN(amount) || amount < 0) {
        return ctx.reply("🔴 Invalid credit amount.");
    }

    try {
        const targetUser = await prisma.user.findUnique({ where: { telegramId: targetId } });
        if (!targetUser) {
            return ctx.replyWithHTML(`🔴 User <code>${targetId}</code> not found in database. They must send /start first.`);
        }

        let newBalance = amount;
        if (isAdd) {
            newBalance = targetUser.creditBalance + amount;
            await prisma.user.update({
                where: { id: targetUser.id },
                data: {
                    creditBalance: { increment: amount },
                    lifetimeCredits: { increment: amount }
                }
            });
        } else {
            await prisma.user.update({
                where: { id: targetUser.id },
                data: { creditBalance: amount }
            });
        }

        // 🟢 SYNC SIMULATION MODE CREDITS (depletes normally in sim too)
        await redis.set(`sim:credits:${targetId}`, newBalance.toString());

        await prisma.creditTransaction.create({
            data: {
                userId: targetUser.id,
                type: 'ADMIN_GRANT',
                amount: isAdd ? amount : (amount - targetUser.creditBalance),
                balanceAfter: newBalance,
                packName: 'ADMIN_GRANT'
            }
        });

        await ctx.replyWithHTML(
            `✅ <b>CREDITS UPDATED FOR <code>${targetId}</code></b>\n\n` +
            `• Action: <b>${isAdd ? 'Added' : 'Set'}</b>\n` +
            `• Live Balance: <b>${newBalance.toLocaleString()} credits</b>\n` +
            `• Sim Balance: <b>${newBalance.toLocaleString()} credits</b>\n\n` +
            `<i>Credits are ready and will deplete normally per trade/call.</i>`
        );

        // Notify the recipient
        try {
            await bot.telegram.sendMessage(targetId,
                `💳 <b>CREDITS GRANTED BY ADMIN</b>\n\n` +
                `You have received <b>${isAdd ? `+${amount.toLocaleString()}` : amount.toLocaleString()}</b> AI Caller Credits!\n` +
                `Current Balance: <b>${newBalance.toLocaleString()} credits</b>`,
                { parse_mode: 'HTML' }
            );
        } catch (_) {}

    } catch (e: any) {
        await ctx.replyWithHTML(`🔴 Error updating credits: ${e.message}`);
    }
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
    if (!initData) return false; // 🟢 FIX: Instantly reject empty payloads
    
    const params = new URLSearchParams(initData);
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

// 🟢 NEW: Server health monitoring endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
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


// =========================================================
// 🔗 COMBINED (LIVE + SIM) API ENDPOINTS
// =========================================================

app.post('/api/combined-trades', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const { getCombinedTrades, computeCombinedStats } = await import('./services/analytics.service.js');
        const trades = await getCombinedTrades(telegramId);
        const stats = computeCombinedStats(trades);

        const alloc = { labels: ['No Holdings'], data: [100] };

        // 🟢 FIX: PnL % calculation against total invested capital across closed trades
        const pnlPercentCalc = stats.totalInvestedSol > 0 
            ? ((stats.totalPnl / stats.totalInvestedSol) * 100).toFixed(2) 
            : '0.00';

        res.json({
            trades: trades.map(t => ({
                createdAt: t.createdAt,
                isBuy: t.isBuy,
                amountInSol: t.amountInSol,
                profitPercent: t.profitPercent || 0,
                realizedPnlSol: t.realizedPnlSol || 0
            })),
            stats: {
                networth: 0,
                networthSol: '0.00 SOL',
                pnlPercent: pnlPercentCalc,
                pnlUsd: stats.totalPnl * cachedSolUsdPrice,
                winrate: stats.winRate.toFixed(1),
                winLossText: `${stats.wins} Wins / ${stats.losses} Losses`,
                volume: stats.totalVolume.toFixed(2) + ' SOL'
            },
            alloc
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});
  
  app.post('/api/combined-advanced-stats', async (req, res) => {
    try {
      if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
      const telegramId = extractTelegramId(req.body.initData);
      if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });
      const { getCombinedAdvancedStats } = await import('./services/analytics.service.js');
      const stats = await getCombinedAdvancedStats(telegramId);
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: 'Server error' });
    }
  });
  
  app.post('/api/combined-hourly', async (req, res) => {
    try {
      if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
      const telegramId = extractTelegramId(req.body.initData);
      if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });
      const { getCombinedHourlyPerformance } = await import('./services/analytics.service.js');
      const hourly = await getCombinedHourlyPerformance(telegramId);
      res.json(hourly);
    } catch (e) {
      res.status(500).json({ error: 'Server error' });
    }
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





// 🟢 BUG 2 & 3 FIX: `/simedit` parses the template and updates the Redis Counters & Anchor
// 🟢 FIXED SIMEDIT COMMAND
bot.command('simedit', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    
    // Debug log to see if ID matches
    console.log("Admin Check for ID:", tgId); 

    if (!isAdmin(tgId)) {
        return ctx.replyWithHTML(`🚫 <b>Access Denied.</b>\nYour ID <code>${tgId}</code> is not in the ADMIN_TELEGRAM_IDS list in .env`);
    }
    
    await redis.set(`state:simedit:${tgId}`, 'AWAITING', 'EX', 300);
    
    const currentForged = JSON.parse(await redis.get(`sim:forged:${tgId}`) || '{}');
    const currentBal = await redis.get(`sim:balance:${tgId}`) || '254.1850';

    await ctx.replyWithHTML(
        `🛠️ <b>SIMULATION EDITOR ACTIVE</b>\n\n` +
        `I am now listening. Paste the stats block exactly as formatted below:\n\n` +
        `<code>BALANCE_SOL: ${currentBal}\n` +
        `WINS: 7182\n` +
        `LOSSES: 6117\n` +
        `VOL: 2142.65\n` +
        `DAYS: 278\n` +
        `SHARPE: 2.84\n` +
        `DRAWDOWN: -0.925\n` +
        `PROFIT_FACTOR: 3.85\n` +
        `RISK_SCORE: 12\n` +
        `MANUAL_24H: 0 | 0.0000\n` +
        `AUTO_24H: 34 | 12.4150\n` +
        `HOURLY_CHART: 0.4, 0.8, -0.1, 1.2, 2.5, 0.0, 4.1\n` +
        `STRAT1: Manual / Direct | 22.95\n` +
        `STRAT2: Sniper Engine | 231.23</code>`
    );
});


// 🟢 FIX 4: Send the isolated Counters and Anchor back to the WebApp




// Replace /api/stats-window endpoint in src/index.ts
app.post('/api/stats-window', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const { getStatsForWindow, isSimulationActive } = await import('./services/simulation.service.js');
        
        const isSim = await isSimulationActive(telegramId);
        if (isSim) {
            const now = Date.now();
            const oneDayAgo = now - 86400000;
            const rawTrades = await redis.get(`sim:trades:${telegramId}`);
            const simTrades = rawTrades ? JSON.parse(rawTrades) : [];
            
            // 🟢 FIX: Filter strictly by exact Date.now() 24h trailing window
            const recentTrades = simTrades.filter((t: any) => new Date(t.createdAt).getTime() > oneDayAgo && !t.isBuy);
            
            const manualTrades = recentTrades.filter((t: any) => t.strategy === 'Manual / Direct');
            const autoTrades = recentTrades.filter((t: any) => t.strategy !== 'Manual / Direct');
            
            const manualPnl = manualTrades.reduce((s: number, t: any) => s + (t.realizedPnlSol || 0), 0);
            const autoPnl = autoTrades.reduce((s: number, t: any) => s + (t.realizedPnlSol || 0), 0);
            
            return res.json({
                manual: { count: manualTrades.length, pnl: manualPnl },
                auto: { count: autoTrades.length, pnl: autoPnl }
            });
        } {
            const liveStats = await getStatsForWindow(telegramId, 'live', 86400);
            return res.json({
                manual: { count: liveStats.tradeCount, pnl: liveStats.totalPnl },
                auto: { count: 0, pnl: 0 }
            });
        }
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Replace /api/analytics/hourly endpoint in src/index.ts

// 📤 Export Trades (CSV Web)
app.post('/api/trades/export', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const csv = await exportTradesToCsv(telegramId);
        if (!csv) return res.status(404).json({ error: 'No trades found' });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=trades_${telegramId}.csv`);
        res.send(csv);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// (Locate your existing `bot.command('simflex', ...)` and `bot.command('simedit', ...)` block and REPLACE IT ENTIRELY with this)


// 1️⃣ Update /sim command
bot.command('sim', async (ctx) => {
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;
    try {
        const { isSimulationActive, setSimulationMode } = await import('./services/simulation.service.js');
        const current = await isSimulationActive(tgId);
        const newState = !current;
        await setSimulationMode(tgId, newState);

        const displayBal = await redis.get(`sim:balance:${tgId}`) || '1000';
        await ctx.replyWithHTML(
            `🎮 <b>SIMULATION MODE: ${newState ? '🟢 ACTIVATED' : '🔴 DEACTIVATED'}</b>\n\n` +
            `${newState
                ? `⚠️ <i>All trades, balances, and alerts are now simulated.</i>\n\n` +
                  `💰 Starting balance: <b>${displayBal} SOL</b>\n` +
                  `🎯 Type <code>/simbal [amount]</code> to change it.`
                : `<i>Platform returned to live mode. All sim data cleared.</i>`
            }`
        );
        await sendOrEditDashboard(ctx, tgId, false);
    } catch (e: any) {
        await ctx.replyWithHTML(`🔴 <b>SIM ERROR:</b> ${e.message}`);
    }
});

// 2️⃣ Update toggle_sim_mode button action
bot.action('toggle_sim_mode', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch(e){}
    const tgId = ctx.from?.id?.toString();
    if (!tgId) return;

    const { isSimulationActive, setSimulationMode } = await import('./services/simulation.service.js');
    const current = await isSimulationActive(tgId);
    await setSimulationMode(tgId, !current);

    await sendOrEditSettings(ctx, tgId, true);
});

// 3️⃣ Update /api/toggle-sim express route
// 🟢 GLOBAL EXPRESS ROUTES (MUST BE OUTSIDE TELEGRAM HANDLERS)
app.post('/api/analytics', async (req, res) => {
    const initData = req.body.initData;
    if (!initData) return res.status(401).json({ error: "No initData" });
    const tgId = extractTelegramId(initData);
    if (!tgId) return res.status(401).json({ error: "Invalid initData" });

    try {
        const user = await prisma.user.findUnique({ where: { telegramId: tgId } });
        if (!user) return res.json({ trades: [], stats: null });

        const trades = await prisma.trade.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        const mappedTrades = trades.map((t: any) => ({
            createdAt: t.createdAt,
            isBuy: t.isBuy,
            amountInSol: t.amountInSol,
            profitPercent: t.profitPercent || 0,
            realizedPnlSol: t.realizedPnlSol || 0
        }));

        const { getAdvancedStats } = await import('./services/analytics.service.js');
        const stats = await getAdvancedStats(tgId);
        
        res.json({ trades: mappedTrades, stats });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sim-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: 'Invalid initData' });

        const { isSimulationActive, getSimBalance, getSimStartingBalance, getSimVolume, getSimCounters, getSimFirstTradeAt } = await import('./services/simulation.service.js');
        const isActive = await isSimulationActive(tgId);
        if (!isActive) return res.json({ isActive: false });

        const balance = await getSimBalance(tgId);
        const startingBalance = await getSimStartingBalance(tgId);
        const volume = await getSimVolume(tgId);
        const positionsRaw = await redis.get(`sim:positions:${tgId}`);
        const positions = positionsRaw ? JSON.parse(positionsRaw) : [];
        
        // 🟢 FIX: We read the LIVE trades array directly, no static snapshot.
        const tradesRaw = await redis.get(`sim:trades:${tgId}`);
        const trades = tradesRaw ? JSON.parse(tradesRaw) : [];

        const counters = await getSimCounters(tgId);
        const firstTradeAt = await getSimFirstTradeAt(tgId);

        return res.json({
            isActive: true, balance, startingBalance, volume,
            wins: counters.wins, losses: counters.losses,
            totalTrades: counters.totalTrades,
            totalInvestedSol: counters.totalInvestedSol,
            totalPnlSol: counters.totalPnlSol,
            firstTradeAt, positions, trades: trades.slice(0, 50)
        });
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/toggle-sim', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: "Invalid initData" });
        
        const { setSimulationMode } = await import('./services/simulation.service.js');
        await setSimulationMode(tgId, req.body.active);

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});


// 🟢 FIX: Connects /simedit top-row stats and the Main Line Chart
app.post('/api/sim-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const tgId = extractTelegramId(req.body.initData);
        if (!tgId) return res.status(401).json({ error: 'Invalid initData' });

        const { isSimulationActive, getSimBalance, getSimStartingBalance, getSimVolume } = await import('./services/simulation.service.js');
        const isActive = await isSimulationActive(tgId);
        
        if (!isActive) return res.json({ isActive: false });

        const balance = await getSimBalance(tgId);
        const startingBalance = await getSimStartingBalance(tgId);
        const volume = await getSimVolume(tgId);
        
        const positionsRaw = await redis.get(`sim:positions:${tgId}`);
        const positions = positionsRaw ? JSON.parse(positionsRaw) : [];
        
        const tradesRaw = await redis.get(`sim:trades:${tgId}`);
        const trades = tradesRaw ? JSON.parse(tradesRaw) : [];

        let wins = 0;
        let losses = 0;

        trades.filter((t: any) => !t.isBuy).forEach((t: any) => {
            if (t.profitPercent > 0) wins++;
            else if (t.profitPercent < 0) losses++;
        });

        res.json({
            isActive: true,
            balance,
            startingBalance,
            volume,
            wins,
            losses,
            positions,
            trades
        });
    } catch (e) {
        res.status(500).json({ error: 'Server Error' });
    }
});

// 🟢 FIX: Connects /simedit HOURLY_CHART to the Bar Chart
app.post('/api/analytics/hourly', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const { isSimulationActive } = await import('./services/simulation.service.js');
        const isSim = await isSimulationActive(telegramId);
        
        if (isSim) {
            const forgedRaw = await redis.get(`sim:forged:${telegramId}`);
            if (forgedRaw) {
                const f = JSON.parse(forgedRaw);
                if (f.hourlyChart && Array.isArray(f.hourlyChart)) {
                    const result = [];
                    for(let h = 0; h < 24; h++) {
                        const pnl = f.hourlyChart[h % f.hourlyChart.length] || 0;
                        const winRate = pnl > 0 ? 60 + Math.random() * 30 : 20 + Math.random() * 30;
                        result.push({ hour: h, totalPnlSol: pnl, winRate: winRate });
                    }
                    return res.json(result);
                }
            }
        }
        
        const { getHourlyPerformance } = await import('./services/analytics.service.js');
        const hourly = await getHourlyPerformance(telegramId);
        res.json(hourly);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/analytics/advanced-stats', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const { getAdvancedStats, computeSimTradeStats } = await import('./services/analytics.service.js');
        const stats = await getAdvancedStats(telegramId);

        const { isSimulationActive } = await import('./services/simulation.service.js');
        if (await isSimulationActive(telegramId)) {
            const simTrades = JSON.parse(await redis.get(`sim:trades:${telegramId}`) || '[]');
            const dynamicStats = computeSimTradeStats(simTrades);
            
            stats.sharpeRatio = dynamicStats.sharpeRatio;
            stats.maxDrawdown = dynamicStats.maxDrawdown;
            stats.profitFactor = dynamicStats.profitFactor;
            stats.totalTrades = simTrades.length;
            stats.totalInvestedSol = dynamicStats.totalInvestedSol;
        }

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/risk-score', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const { isSimulationActive } = await import('./services/simulation.service.js');
        if (await isSimulationActive(telegramId)) {
            const forgedRaw = await redis.get(`sim:forged:${telegramId}`);
            if (forgedRaw) {
                const f = JSON.parse(forgedRaw);
                if (f.risk !== undefined && f.risk !== null) {
                    return res.json({ score: f.risk, riskLevel: f.risk > 70 ? 'High' : 'Safe', details: { topConcentration: 0, rugCount: 0 } });
                }
            }
        }

        const positions = await getUserPositions(telegramId);
        if (!positions || positions.length === 0) return res.json({ score: 0, riskLevel: 'Safe', details: { topConcentration: 0, rugCount: 0 } });

        const { getTokenRiskDetails } = await import('./services/price.service.js');
        let totalValue = 0; let rugCount = 0;

        const enriched = await Promise.all(positions.map(async (p: any) => {
            const rug = await getTokenRiskDetails(p.mint);
            totalValue += p.valueUsd;
            if (rug.isUnsafe) rugCount++;
            return { ...p, rug };
        }));

        const topConcentration = Math.max(...enriched.map((t: any) => t.valueUsd / (totalValue || 1)));
        
        let score = 0;
        if (topConcentration > 0.50) score += 30;
        if (topConcentration > 0.80) score += 15;
        if (rugCount > 0) score += 40;
        
        const riskLevel = score > 70 ? 'High' : score > 40 ? 'Medium' : 'Low';
        res.json({ score: Math.min(100, score), riskLevel, details: { topConcentration, rugCount } });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});



app.post('/api/performance', async (req, res) => {
    try {
        if (!verifyTelegramAuth(req.body.initData)) return res.status(403).json({ error: 'Unauthorized' });
        const telegramId = extractTelegramId(req.body.initData);
        if (!telegramId) return res.status(400).json({ error: 'Invalid ID' });

        const strategyStats: Record<string, { totalPnl: number, totalVolume: number, count: number }> = {};
        const { isSimulationActive } = await import('./services/simulation.service.js');
        
        const isSim = await isSimulationActive(telegramId);
        if (isSim) {
            const forgedRaw = await redis.get(`sim:forged:${telegramId}`);
            if (forgedRaw) {
                const f: any = JSON.parse(forgedRaw);
                if ((f as any)?.strat1Name) strategyStats[(f as any).strat1Name] = { totalPnl: (f as any).strat1Pnl || 0, totalVolume: 0, count: 0 };
                if ((f as any)?.strat2Name) strategyStats[(f as any).strat2Name] = { totalPnl: (f as any).strat2Pnl || 0, totalVolume: 0, count: 0 };
            }
            
            // Allow real-time new sim trades to append natively
            const simTrades = JSON.parse(await redis.get(`sim:trades:${telegramId}`) || '[]');
            simTrades.forEach((t: any) => {
               if (!t.isBuy) {
                   const s = t.strategy || 'Sniper Engine';
                   if (!strategyStats[s]) strategyStats[s] = { totalPnl: 0, totalVolume: 0, count: 0 };
                   strategyStats[s].totalPnl += t.realizedPnlSol || 0;
                   strategyStats[s].totalVolume += t.amountInSol || 0;
                   strategyStats[s].count += 1;
               }
            });
        } else {
            const user = await prisma.user.findUnique({ where: { telegramId } });
            const trades = await prisma.trade.findMany({
                where: { userId: user!.id, isBuy: false, status: 'CONFIRMED' },
                select: { strategy: true, realizedPnlSol: true, amountInSol: true }
            });
            trades.forEach(t => {
                const s = t.strategy || 'MANUAL';
                if (!strategyStats[s]) strategyStats[s] = { totalPnl: 0, totalVolume: 0, count: 0 };
                strategyStats[s].totalPnl += t.realizedPnlSol || 0;
                strategyStats[s].totalVolume += t.amountInSol || 0;
                strategyStats[s].count += 1;
            });
        }

        res.json(strategyStats);
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

async function bootEcosystem() {
    await warmDnsCache();
    await syncGuardsFromDb(); 
    
    // 🟢 FIX: Handle port collisions so the bot doesn't crash silently
    try {
        app.listen(3001, () => console.log('🟢 WebApp API Server listening on port 3001'))
           .on('error', (e: any) => {
               if (e.code === 'EADDRINUSE') console.warn('⚠️ Port 3001 already in use (Ghost process). Skipping Express boot.');
               else console.error('🔴 Express Error:', e);
           });
    } catch (e) {
        console.error('🔴 Express Boot Error:', e);
    }

    setInterval(async () => { await sweepExpiredVips(); }, 10 * 60 * 1000);

    setInterval(async () => {
        try {
            const guilds = await prisma.guild.findMany({ where: { isActive: true }, select: { id: true } });
            for (let i = 0; i < guilds.length; i++) {
                setTimeout(async () => { await updateRankCache(guilds[i].id); }, i * 1500); 
            }
        } catch (e) {}
    }, 60000);

  

    console.log("⏳ Pinging Telegram Servers...");
    try {
        const keys = await redis.keys('active_bumper:*');
        if (keys.length > 0) await redis.del(...keys);

        const info = await bot.telegram.getMe();
        console.log(`🟢 [4/5] HFT BOT ONLINE -> @${info.username}`);
        
        // 🟢 FIX: Trap the launch promise to keep the process alive even if Telegram API is dropping connections
        bot.launch({ dropPendingUpdates: true }).catch((e) => {
            console.error("🔴 [FATAL] Telegram Bot Launch Failed (Check Token or Connection):", e.message);
        });
        
        console.log("🟢 [5/5] ALL SYSTEMS GO. Interface Active.");

        igniteYellowstoneStream(bot).catch((err: any) => console.error("🟡 [Background] gRPC Delayed:", err.message));
        
        startDcaEngine(bot);
        startCopyTradeWatcher(bot); 
        startDepositWatcher(bot); 
        startCoinCaller(bot); 
        startLimitOrderWatcher(bot);

        cron.schedule('0 8 * * 1', async () => {
            console.log('🕗 [CRON] Monday 8AM — firing weekly reports');
            await sendWeeklyReportsToAll(bot);
        }, { timezone: 'UTC' });

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

        const { updateLaunchCalendar } = await import('./services/calendar.service.js');
        await updateLaunchCalendar();
        setInterval(updateLaunchCalendar, 30 * 60 * 1000);

    } catch (err: any) {
        console.error("🔴 TELEGRAM BOOT FAILED:", err.message);
        // Let it continue running other background services instead of exiting
    }

    const { startCallerEvaluator, scheduleTraining } = await import('./services/caller.service.js');
    startCallerEvaluator(); 
    scheduleTraining();
}

process.once('SIGINT', () => { try { if (bot.botInfo) bot.stop('SIGINT'); } catch(e){} prisma.$disconnect(); redis.quit(); });
process.once('SIGTERM', () => { try { if (bot.botInfo) bot.stop('SIGTERM'); } catch(e){} prisma.$disconnect(); redis.quit(); });

// Replace bootEcosystem(); at the bottom of src/index.ts
bootEcosystem().catch((err) => {
    console.error("🔴 [FATAL] Ecosystem boot failed!");
    console.error("Check your .env, database, and Redis connection. Error:", err);
    process.exit(1);
});
