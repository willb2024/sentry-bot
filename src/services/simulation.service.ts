// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generatePnlCard } from './image.service.js';
import { computeTokenScore, TokenStats } from './caller.service.js';

const prisma = new PrismaClient();

function randomBase58(length: number): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

function shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

export function applySimSlippage(targetPnl: number): number {
    const maxPercentDeviation = Math.abs(targetPnl) * 0.05; 
    const absoluteDeviation = (Math.random() * 2 - 1) * Math.max(1.2, maxPercentDeviation);
    return parseFloat((targetPnl + absoluteDeviation).toFixed(2));
}

export function generateSimWallets(): Array<{ address: string, balance: number }> {
    const count = Math.floor(Math.random() * 5) + 1;
    return Array.from({ length: count }, () => ({
        address: randomBase58(44),
        balance: parseFloat((Math.random() * 8 + 0.5).toFixed(4))
    }));
}

export function generateSimTokenCA(): string {
    const isPump = Math.random() > 0.4;
    const base = randomBase58(isPump ? 36 : 44);
    return isPump ? base + 'pump' : base;
}

export function generateSimSignature(): string {
    return randomBase58(87);
}

export async function isSimulationActive(telegramId: string): Promise<boolean> {
    const val = await redis.get(`sim:active:${telegramId}`);
    return val === 'true';
}

export async function getSimBalance(telegramId: string): Promise<string> {
    const bal = await redis.get(`sim:balance:${telegramId}`);
    return bal || '12.4521';
}

export async function getSimVolume(telegramId: string): Promise<number> {
    const vol = await redis.get(`sim:volume:${telegramId}`);
    return vol ? parseFloat(vol) : 0;
}

export async function getSimWallets(telegramId: string): Promise<Array<{ address: string, balance: number }>> {
    const raw = await redis.get(`sim:wallets:${telegramId}`);
    if (raw) return JSON.parse(raw);
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
    return wallets;
}

// 🟢 TRACK SIMULATED TRADES PROPERLY FOR THE DASHBOARD
export async function recordSimTrade(telegramId: string, isBuy: boolean, amountInSol: number, profitPercent: number = 0) {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    
    // Calculates realized PnL correctly so Flow Analytics reflects true values
    const realizedPnlSol = isBuy ? 0 : amountInSol * (profitPercent / 100);

    existing.unshift({
        createdAt: new Date().toISOString(),
        isBuy,
        amountInSol,
        profitPercent,
        realizedPnlSol
    });
    
    await redis.set(key, JSON.stringify(existing.slice(0, 100)), 'EX', 86400); 
    await redis.incrbyfloat(`sim:volume:${telegramId}`, amountInSol);
}

export async function simExecuteSnipe(
    telegramId: string,
    tokenAddress: string,
    amountSol: number
): Promise<{ success: boolean, signature: string, message: string, volumeSpent: number }> {
    
    // 🟢 FIX: Check simulated balance before allowing the trade
    const currentBal = parseFloat(await getSimBalance(telegramId));
    if (currentBal < amountSol + 0.001) {
        return { success: false, signature: '', message: '🔴 Insufficient Funds.', volumeSpent: 0 };
    }

    // 🟢 Match realistic network/RPC/Jito latency
    const delay = Math.random() > 0.95 ? (4000 + Math.random() * 6000) : (1500 + Math.random() * 3000);
    await new Promise(r => setTimeout(r, delay));

    const newBal = Math.max(0, currentBal - amountSol - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const posKey = `sim:positions:${telegramId}`;
    const existing = JSON.parse(await redis.get(posKey) || '[]');

    const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(12));
    const solUsdPrice = 150;
    const entryPriceUsd = entryPriceSol * solUsdPrice;
    const tokenAmount = Math.floor(amountSol / entryPriceSol);

    const tokenNames = ['DEGEN', 'CHAD', 'PEPE', 'BONK', 'WIF', 'POPCAT', 'GIGA', 'MYRO', 'BOME', 'SLERF'];
    const symbol = tokenNames[Math.floor(Math.random() * tokenNames.length)];

    existing.push({
        mint: tokenAddress,
        symbol,
        amount: tokenAmount,
        entryPrice: entryPriceSol,
        entryPriceUsd,
        priceUsd: entryPriceUsd,
        valueUsd: amountSol * solUsdPrice,
        amountInSol: amountSol,
        highestSeenPrice: entryPriceSol
    });
    await redis.set(posKey, JSON.stringify(existing), 'EX', 3600);
    
    await recordSimTrade(telegramId, true, amountSol, 0);

    return {
        success: true,
        signature: generateSimSignature(),
        message: '🟢 Simulation: Jito bundle confirmed.',
        volumeSpent: amountSol
    };
}

export async function simExecuteExit(
    telegramId: string,
    tokenAddress: string,
    percent: number,
    forcedPnlPercent?: number 
): Promise<{ success: boolean, signature: string, message: string }> {
    
    // 🟢 D4 FIX: Match realistic network/RPC/Jito latency for selling
    const delay = Math.random() > 0.95 ? (4000 + Math.random() * 6000) : (1500 + Math.random() * 3000);
    await new Promise(r => setTimeout(r, delay));

    const posKey = `sim:positions:${telegramId}`;
    const positions = JSON.parse(await redis.get(posKey) || '[]');
    const pos = positions.find((p: any) => p.mint === tokenAddress);

    let pnlPercent = forcedPnlPercent !== undefined 
        ? forcedPnlPercent 
        : parseFloat((Math.random() * 325 + 15).toFixed(2));

    if (pos) {
        const soldSol = pos.amountInSol * (percent / 100);
        const rawReturn = soldSol * (1 + pnlPercent / 100);
        const platformFee = rawReturn * 0.01;
        const jitoTip = 0.0015;
        const netReturnSol = rawReturn - platformFee - jitoTip;

        const currentBal = parseFloat(await getSimBalance(telegramId));
        await redis.set(`sim:balance:${telegramId}`, (currentBal + netReturnSol).toFixed(4));

        if (percent === 100) {
            const updated = positions.filter((p: any) => p.mint !== tokenAddress);
            await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
        }
        
        await recordSimTrade(telegramId, false, soldSol, pnlPercent);
    }

    return {
        success: true,
        signature: generateSimSignature(),
        message: `🟢 Simulation: Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`
    };
}

export function generateSimCallerAlert(filters: {
    minScore: number;
    maxAgeMins: number;
    minPctChange: number;
    maxPctChange: number;
    minLiquidity: number;
    minVolume24h: number;
    blockMev: boolean;
}): (ReturnType<typeof computeTokenScore> & { mint: string; symbol: string; ageMins: number; priceChangeM5: number; liquidity: number; volume: number }) | null {
    const symbols = ['DOGE', 'BONK', 'WIF', 'MYRO', 'POPCAT', 'ZEUS', 'BOME', 'MEW', 'SLERF'];

    // Simulate scanning a small pool of candidate tokens
    const poolSize = 8;
    const candidates = Array.from({ length: poolSize }, () => {
        const ageMins = Math.floor(Math.random() * 90) + 1;
        const stats: TokenStats = {
            ageMins,
            volume24h: Math.random() * 500000 + 5000,
            liquidity: Math.random() * 80000 + 2000,
            priceChangeM5: parseFloat((Math.random() * 220 + 1).toFixed(1)),
            hasSocials: Math.random() > 0.3,
            isRug: Math.random() < 0.08
        };
        const { score, reasons } = computeTokenScore(stats);
        return {
            mint: generateSimTokenCA(),
            symbol: symbols[Math.floor(Math.random() * symbols.length)],
            score, reasons, ageMins, priceChangeM5: stats.priceChangeM5,
            mevRisk: stats.isRug ? -100 : 0,
            liquidity: stats.liquidity, 
            volume: stats.volume24h     
        };
    });

    // Apply the SAME filter logic the real scoreTokens()/startCoinCaller() flow uses
    const match = candidates.find(t =>
        t.score >= filters.minScore &&
        t.ageMins <= filters.maxAgeMins &&
        t.priceChangeM5 >= filters.minPctChange &&
        t.priceChangeM5 <= filters.maxPctChange &&
        t.liquidity >= filters.minLiquidity &&
        t.volume >= filters.minVolume24h &&
        (!filters.blockMev || t.mevRisk >= 0)
    );

    return match || null;
}

// 🟢 D3 FIX: Biased by score with light momentum streaks
export async function getNextSimOutcome(telegramId: string, type: 'caller' | 'guard', score?: number): Promise<boolean> {
    const baseProb = score !== undefined ? 0.30 + (score / 100) * 0.45 : 0.5;

    const lastKey = `sim:last_outcome:${type}:${telegramId}`;
    const last = await redis.get(lastKey);
    const streakNudge = last === 'true' ? 0.05 : last === 'false' ? -0.05 : 0;

    const finalProb = Math.min(0.9, Math.max(0.1, baseProb + streakNudge));
    const outcome = Math.random() < finalProb;

    await redis.set(lastKey, outcome ? 'true' : 'false', 'EX', 3600);
    return outcome;
}

export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    
    if (newState === 'true') {
        runSimAutoSnipeLoop(telegramId, bot);
    }
    return newState === 'true';
}

async function runSimAutoSnipeLoop(telegramId: string, bot: any) {
    let totalSimSpent = 0;

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        const user = await prisma.user.findUnique({ where: { telegramId: telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        const amountSol = config?.amountSol || 0.1;
        const slPercent = config?.autoTrailingDropPercent || 20;
        const tpPercent = config?.autoTakeProfitPercent || 50; 
        const maxBudget = config?.maxBudgetSol || 10.0;

        // 🟢 ACCURATELY CHECK BUDGET LIMITS
        if (totalSimSpent + amountSol > maxBudget) {
            await bot.telegram.sendMessage(
                telegramId, 
                `✅ <b>AUTO-SNIPER COMPLETE: Max Budget Reached</b> 🎮\n\nYour sniper has spent a total of <b>${totalSimSpent.toFixed(4)} SOL</b> and has automatically powered down.`, 
                { parse_mode: 'HTML' }
            );
            break;
        }

        const isProfit = await getNextSimOutcome(telegramId, 'guard');
        const tokenCA = generateSimTokenCA();
        const targetPnl = isProfit ? tpPercent : -Math.abs(slPercent);
        const finalPnl = applySimSlippage(targetPnl);

        const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(10));
        const tokensBought = Math.floor(amountSol / entryPriceSol);

        const buyRes = await simExecuteSnipe(telegramId, tokenCA, amountSol);
        
        // 🟢 FIX: Halt auto-sniper loop if simulated balance runs out
        if (!buyRes.success) {
            await bot.telegram.sendMessage(telegramId, `🛑 <b>AUTO-SNIPER PAUSED:</b> Simulated balance insufficient.`, { parse_mode: 'HTML' });
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            break;
        }
        totalSimSpent += amountSol;

        const buyMsg = 
            `🟢 <b>BUY & GUARD SUCCESSFUL!</b>\n\n` +
            `Token: <code>${tokenCA.substring(0,8)}...</code>\n` +
            `Invested: <b>${amountSol} SOL</b>\n` +
            `Received: <b>${tokensBought.toLocaleString()} Tokens</b>\n` +
            `Entry Price: <b>${entryPriceSol.toFixed(9)} SOL</b>\n` +
            `Trailing Drop: <b>-${slPercent}%</b>\n` +
            `Take Profit: <b>${config?.autoTakeProfitPercent ? `+${tpPercent}%` : 'OFF'}</b>\n\n` +
            `🔗 <a href="https://solscan.io/tx/${buyRes.signature}">View on Solscan</a>`;
        
        await bot.telegram.sendMessage(telegramId, buyMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;

        await simExecuteExit(telegramId, tokenCA, 100, finalPnl);
        await sendSimPnlCard(telegramId, bot, tokenCA, amountSol, finalPnl, slPercent, entryPriceSol, tokensBought);

        await new Promise(r => setTimeout(r, 1500)); 
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;
    }

    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

async function sendSimPnlCard(telegramId: string, bot: any, tokenAddress: string, amountInSol: number, pnlPercent: number, slPercent: number, entryPriceSol: number, tokensBought: number) {
    const isProfit = pnlPercent >= 0;
    const exitSig = generateSimSignature();
    const exitPriceSol = entryPriceSol * (1 + pnlPercent / 100);
    const grossReturn = tokensBought * exitPriceSol;
    const platformFee = grossReturn * 0.01;
    const jitoTip = 0.0015;
    const pnlSol = grossReturn - amountInSol - platformFee - jitoTip;

    const pnlMessage = isProfit
        ? `💰 <b>Net Profit: +${Math.abs(pnlSol).toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
        : `🩸 <b>Incurred Loss: -${Math.abs(pnlSol).toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;

    const captionText = `${isProfit ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'} 🎮\n\n` +
        `Token: <code>${tokenAddress.substring(0,8)}...</code>\n` +
        `Exit Price: <b>${exitPriceSol.toFixed(9)} SOL</b>\n` +
        `${!isProfit ? `📉 <b>Peak Drop: -${slPercent.toFixed(1)}%</b>\n` : ''}` +
        `${pnlMessage}\n` +
        `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
        `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        const imageBuffer = await generatePnlCard(tokenAddress, pnlPercent, user?.referralCode ?? undefined);
        
        // 🟢 FIX: Safely use Telegraf native sendPhoto, bypassing fetch/form-data errors completely!
        await bot.telegram.sendPhoto(
            telegramId,
            { source: imageBuffer },
            { caption: captionText, parse_mode: 'HTML' }
        );
    } catch (e: any) {
        console.error("Simulation image generation failed:", e.message);
        // Fallback to purely text if image buffer rendering fails
        try {
            await bot.telegram.sendMessage(telegramId, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (_) {}
    }
}