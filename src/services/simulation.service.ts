// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generatePnlCard } from './image.service.js';
import FormData from 'form-data'; 

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

export function randomTradeDelay(): number {
    return Math.floor(Math.random() * 2000) + 500;
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

export async function recordSimTrade(telegramId: string, isBuy: boolean, amountInSol: number, profitPercent: number = 0) {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    existing.unshift({
        createdAt: new Date().toISOString(),
        isBuy,
        amountInSol,
        profitPercent
    });
    await redis.set(key, JSON.stringify(existing.slice(0, 100)), 'EX', 86400); 
    await redis.incrbyfloat(`sim:volume:${telegramId}`, amountInSol);
}

export async function simExecuteSnipe(
    telegramId: string,
    tokenAddress: string,
    amountSol: number
): Promise<{ success: boolean, signature: string, message: string, volumeSpent: number }> {
    await new Promise(r => setTimeout(r, randomTradeDelay()));

    const currentBal = parseFloat(await getSimBalance(telegramId));
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
    await new Promise(r => setTimeout(r, randomTradeDelay()));

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

export function generateSimCallerAlert(): { mint: string, symbol: string, score: number, reasons: string[], priceChangeM5: number, ageMins: number } {
    const symbols = ['DOGE', 'BONK', 'WIF', 'MYRO', 'POPCAT', 'ZEUS', 'BOME', 'MEW', 'SLERF'];
    const priceChangeM5 = parseFloat((Math.random() * 220 + 30).toFixed(1));
    return {
        mint: generateSimTokenCA(),
        symbol: symbols[Math.floor(Math.random() * symbols.length)],
        score: Math.floor(Math.random() * 25) + 75,
        reasons: [`🔥 High momentum (+${Math.floor(priceChangeM5 * 1.3)}% vol spike)`, `📈 Heavy buy pressure`, `💧 Deep liquidity`],
        priceChangeM5,
        ageMins: Math.floor(Math.random() * 45) + 2
    };
}

function shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
    const baseSequence = [
        false, false, false, true, true, true, false, false, true, false, false, false, true, true           
    ];

    let sequence = shuffleArray(baseSequence);
    let totalSimSpent = 0;
    let sequenceIndex = 0;

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        if (sequenceIndex >= sequence.length) {
            sequence = shuffleArray(baseSequence);
            sequenceIndex = 0;
        }

        const user = await prisma.user.findUnique({ where: { telegramId: telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        const amountSol = config?.amountSol || 0.1;
        const slPercent = config?.autoTrailingDropPercent || 20;
        const tpPercent = config?.autoTakeProfitPercent || 50; 
        const maxBudget = config?.maxBudgetSol || 10.0;

        if (totalSimSpent + amountSol > maxBudget) {
            await bot.telegram.sendMessage(
                telegramId, 
                `✅ <b>AUTO-SNIPER COMPLETE: Max Budget Reached</b> 🎮\n\nYour sniper has spent a total of <b>${totalSimSpent.toFixed(4)} SOL</b> and has automatically powered down.`, 
                { parse_mode: 'HTML' }
            );
            break;
        }

        const isProfit = sequence[sequenceIndex];
        sequenceIndex++;

        const tokenCA = generateSimTokenCA();
        const targetPnl = isProfit ? tpPercent : -Math.abs(slPercent);
        const finalPnl = applySimSlippage(targetPnl);

        const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(10));
        const tokensBought = Math.floor(amountSol / entryPriceSol);

        const buyRes = await simExecuteSnipe(telegramId, tokenCA, amountSol);
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

        const randomWaitMs = [2000, 3000, 4000, 5000][Math.floor(Math.random() * 4)];
        await new Promise(r => setTimeout(r, randomWaitMs));

        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;

        await simExecuteExit(telegramId, tokenCA, 100, finalPnl);
        await sendSimPnlCard(telegramId, bot, tokenCA, amountSol, finalPnl, slPercent, entryPriceSol, tokensBought);

        await new Promise(r => setTimeout(r, 2000)); 
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;
    }

    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

async function sendSimPnlCard(telegramId: string, bot: any, tokenAddress: string, amountInSol: number, pnlPercent: number, slPercent: number, entryPriceSol: number, tokensBought: number) {
    try {
        const exitSig = generateSimSignature();
        const isProfit = pnlPercent >= 0;

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

        const user = await prisma.user.findUnique({ where: { telegramId } });
        const telegramBotToken = process.env.BOT_TOKEN!;
        const imageBuffer = await generatePnlCard(tokenAddress, pnlPercent, user?.referralCode ?? undefined);
        
        // 🟢 FIX: Static FormData with native fetch cleanly prevents dynamic dynamic node-fetch exceptions
        const form = new FormData();
        form.append('chat_id', telegramId);
        form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
        form.append('caption', captionText);
        form.append('parse_mode', 'HTML');
        
        await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
            method: 'POST', 
            body: form as any,
            headers: form.getHeaders()
        });
    } catch (e: any) {
        console.error("Simulation image send failed:", e.message);
    }
}

export async function getNextSimOutcome(telegramId: string, type: 'caller' | 'guard'): Promise<boolean> {
    const key = `sim:${type}_seq:${telegramId}`;
    let seqStr = await redis.get(key);
    let seq: boolean[] = [];
    
    if (seqStr) seq = JSON.parse(seqStr);
    
    if (!seq || seq.length === 0) {
        if (type === 'caller') {
            seq = shuffleArray([
                false, false, false, true, 
                false, false, true,       
                false, true               
            ]);
        } else if (type === 'guard') {
            seq = shuffleArray([false, false, true, true, true, true, false]);
        }
    }
    
    const outcome = seq.pop() ?? true;
    await redis.set(key, JSON.stringify(seq), 'EX', 86400); 
    return outcome;
}