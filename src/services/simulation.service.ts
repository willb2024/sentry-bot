// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generatePnlCard } from './image.service.js';

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

export async function getSimWallets(telegramId: string): Promise<Array<{ address: string, balance: number }>> {
    const raw = await redis.get(`sim:wallets:${telegramId}`);
    if (raw) return JSON.parse(raw);
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
    return wallets;
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
        const returnSol = soldSol * (1 + pnlPercent / 100);
        const currentBal = parseFloat(await getSimBalance(telegramId));
        await redis.set(`sim:balance:${telegramId}`, (currentBal + returnSol).toFixed(4));

        if (percent === 100) {
            const updated = positions.filter((p: any) => p.mint !== tokenAddress);
            await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
        }
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

// ─── 🟢 SIMULATED AUTO SNIPE LOOP ──────────────────────────────

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
    // Programmed Sequence: 3 loss, 1 win, 2 win, 2 losses, 1 win, 1 loss, 2 losses, 2 win (14 items)
    const baseSequence = [
        false, false, false, // 3 loss
        true,                // 1 win
        true, true,          // 2 win
        false, false,        // 2 losses
        true,                // 1 win
        false,               // 1 loss
        false, false,        // 2 losses
        true, true           // 2 win
    ];

    let sequence = shuffleArray(baseSequence);
    let totalSimSpent = 0;
    let sequenceIndex = 0;

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        
        // Re-shuffle the cycle once we run through all 14 outcomes to keep the pattern organic
        if (sequenceIndex >= sequence.length) {
            sequence = shuffleArray(baseSequence);
            sequenceIndex = 0;
        }

        // Fetch your exact live configurations [1]
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        const amountSol = config?.amountSol || 0.1;
        const slPercent = config?.autoTrailingDropPercent || 20;
        const tpPercent = config?.autoTakeProfitPercent || 50; 
        const maxBudget = config?.maxBudgetSol || 10.0; // Fallback to 10 SOL if none configured

        // Check if next simulated buy exceeds your configured max budget
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
        const finalPnl = isProfit ? tpPercent : -Math.abs(slPercent);

        // 1. Realistic Entry Math
        const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(10));
        const tokensBought = Math.floor(amountSol / entryPriceSol);

        // Execute Fake Buy using your real Config Amount
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

        // 2. RANDOMIZED DELAY: 2s, 3s, 4s, or 5s [1]
        const randomWaitMs = [2000, 3000, 4000, 5000][Math.floor(Math.random() * 4)];
        await new Promise(r => setTimeout(r, randomWaitMs));

        // Ensure user didn't hit cancel during the sleep
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;

        // 3. Fake Sell using exact PnL from your configs
        await simExecuteExit(telegramId, tokenCA, 100, finalPnl);
        
        // 4. Send the beautiful PnL Card directly
        await sendSimPnlCard(telegramId, bot, tokenCA, amountSol, finalPnl, slPercent, entryPriceSol, tokensBought);

        // Wait 2 seconds before buying the NEXT coin in the sequence
        await new Promise(r => setTimeout(r, 2000)); 
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;
    }

    // Silently reset the state
    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

async function sendSimPnlCard(telegramId: string, bot: any, tokenAddress: string, amountInSol: number, pnlPercent: number, slPercent: number, entryPriceSol: number, tokensBought: number) {
    try {
        const exitSig = generateSimSignature();
        const isProfit = pnlPercent >= 0;

        // Accurate mathematical tracking
        const exitPriceSol = entryPriceSol * (1 + pnlPercent / 100);
        const grossReturn = tokensBought * exitPriceSol;
        const pnlSol = grossReturn - amountInSol;

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
        
        // @ts-ignore
        const fetch = (await import('node-fetch')).default;
        // @ts-ignore
        const FormData = (await import('form-data')).default;
        
        const form = new FormData();
        form.append('chat_id', telegramId);
        form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
        form.append('caption', captionText);
        form.append('parse_mode', 'HTML');
        
        await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
            method: 'POST', body: form
        });
    } catch (_) {}
}