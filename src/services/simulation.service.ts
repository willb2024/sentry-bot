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

export async function recordSimTrade(telegramId: string, isBuy: boolean, amountInSol: number) {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    existing.unshift({
        createdAt: new Date().toISOString(),
        isBuy,
        amountInSol,
        profitPercent: 0
    });
    
    await redis.set(key, JSON.stringify(existing.slice(0, 100)), 'EX', 3600);
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

    // Also store as a guard in Redis exactly like the real system does
    const orderId = crypto.randomUUID();
    const guardOrder = {
        id: orderId,
        telegramId,
        tokenAddress,
        trailingPercent: 20,
        highestSeenPrice: entryPriceSol,
        amountInSol: amountSol,
        entryPrice: entryPriceSol,
        takeProfitPercent: 50
    };
    await redis.set(`sim:guard:${tokenAddress}:${telegramId}`, JSON.stringify(guardOrder), 'EX', 3600);

    // Schedule a realistic guard trigger between 10-45 seconds after buy
    const triggerDelay = Math.floor(Math.random() * 35000) + 10000;
    scheduleSimGuardTrigger(telegramId, tokenAddress, orderId, amountSol, entryPriceSol, symbol, triggerDelay);

    return {
        success: true,
        signature: generateSimSignature(),
        message: '🟢 Simulation: Jito bundle confirmed.',
        volumeSpent: amountSol
    };
}

// Fires a realistic guard/TP notification after a delay — identical to the real grpc.service output
async function scheduleSimGuardTrigger(
    telegramId: string,
    tokenAddress: string,
    orderId: string,
    amountInSol: number,
    entryPrice: number,
    symbol: string,
    delayMs: number
) {
    setTimeout(async () => {
        try {
            // Check the guard still exists (user may have sold manually)
            const guardRaw = await redis.get(`sim:guard:${tokenAddress}:${telegramId}`);
            if (!guardRaw) return;

            // 70% chance profit, 30% chance loss — weighted toward profit for demo
            const isProfit = Math.random() > 0.3;
            const pnlPercent = isProfit
                ? parseFloat((Math.random() * 280 + 20).toFixed(2))   // +20% to +300%
                : -parseFloat((Math.random() * 25 + 5).toFixed(2));   // 🟢 Fixed type compiler error

            const exitSig = generateSimSignature();
            const currentPrice = entryPrice * (1 + pnlPercent / 100);
            const pnlSol = (amountInSol * Math.abs(pnlPercent / 100));

            const pnlMessage = pnlPercent >= 0
                ? `💰 <b>Secured Profit: +${pnlSol.toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
                : `🩸 <b>Incurred Loss: -${pnlSol.toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;

            const isTP = isProfit && Math.random() > 0.5;

            const captionText = isTP
                ? `🎯 <b>TAKE PROFIT TRIGGERED!</b>\n\n` +
                  `Token: <code>${tokenAddress.substring(0, 8)}...</code>\n` +
                  `💰 <b>Net Profit: +${pnlSol.toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)\n` +
                  `Status: 🟢 Auto-Sold 100% via Jito.\n` +
                  `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`
                : `🚨 <b>TRAILING GUARD TRIGGERED!</b>\n\n` +
                  `Token: <code>${tokenAddress.substring(0, 8)}...</code>\n` +
                  `📉 <b>Peak Drop: -${Math.abs(pnlPercent).toFixed(1)}%</b>\n` +
                  `${pnlMessage}\n` +
                  `Status: 🟢 Auto-Sold 100% to protect capital.\n` +
                  `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

            // Update sim balance
            const currentBal = parseFloat(await getSimBalance(telegramId));
            const returnSol = amountInSol + (amountInSol * (pnlPercent / 100));
            await redis.set(`sim:balance:${telegramId}`, Math.max(0, currentBal + returnSol).toFixed(4));

            // Remove position
            const posKey = `sim:positions:${telegramId}`;
            const positions = JSON.parse(await redis.get(posKey) || '[]');
            const updated = positions.filter((p: any) => p.mint !== tokenAddress);
            await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
            await redis.del(`sim:guard:${tokenAddress}:${telegramId}`);

            // Send PnL card exactly like the real system
            const user = await prisma.user.findUnique({ where: { telegramId } });

            try {
                const telegramBotToken = process.env.BOT_TOKEN!;
                const imageBuffer = await generatePnlCard(
                    tokenAddress,
                    pnlPercent,
                    user?.referralCode ?? undefined
                );
                
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
                    method: 'POST',
                    body: form
                });
            } catch (_) {
                // Text fallback
                // @ts-ignore
                const fetch = (await import('node-fetch')).default;
                await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramId,
                        text: captionText,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    })
                });
            }
        } catch (_) {}
    }, delayMs);
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

    const pnlPercent = parseFloat((Math.random() * 280 + 15).toFixed(2));
    const sig = generateSimSignature();

    if (pos) {
        const soldSol = pos.amountInSol * (percent / 100);
        const returnSol = soldSol * (1 + pnlPercent / 100);
        const currentBal = parseFloat(await getSimBalance(telegramId));
        await redis.set(`sim:balance:${telegramId}`, (currentBal + returnSol).toFixed(4));

        if (percent === 100) {
            const updated = positions.filter((p: any) => p.mint !== tokenAddress);
            await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
            await redis.del(`sim:guard:${tokenAddress}:${telegramId}`);
        }
    }

    return {
        success: true,
        signature: sig,
        message: `🟢 Trade Confirmed via Jito Bundle. W1: ✅`
    };
}

export function generateSimCallerAlert(): {
    mint: string,
    symbol: string,
    score: number,
    reasons: string[],
    priceChangeM5: number,
    ageMins: number
} {
    const symbols = ['DOGE', 'BONK', 'WIF', 'MYRO', 'POPCAT', 'ZEUS', 'BOME', 'MEW', 'SLERF', 'GIGA', 'HARAMBE', 'COPE', 'CHAD', 'FOMO', 'MOCHI'];
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];
    const score = Math.floor(Math.random() * 25) + 75; // 75-100 — only high scores in sim
    const priceChangeM5 = parseFloat((Math.random() * 220 + 30).toFixed(1));
    const ageMins = Math.floor(Math.random() * 45) + 2;
    const liqK = Math.floor(Math.random() * 120 + 25);
    const buyPct = Math.floor(Math.random() * 20 + 65);

    const possibleReasons = [
        `🔥 High momentum (+${Math.floor(priceChangeM5 * 1.3)}% vol spike vs last hour)`,
        `📈 Heavy buy pressure (${buyPct}% buys in last 60 txs)`,
        `💧 Deep liquidity ($${liqK}k USD locked)`,
        `👶 Very fresh (${ageMins} mins old)`,
        `🛡️ RugCheck passed: Low Risk (Safe contract)`,
        `🚀 Curve ${Math.floor(Math.random() * 30 + 55)}% to graduation`,
        `📊 24H Volume: $${Math.floor(Math.random() * 800 + 50).toLocaleString()}k`
    ];

    const shuffled = possibleReasons.sort(() => Math.random() - 0.5);
    const reasons = shuffled.slice(0, Math.floor(Math.random() * 2) + 3);

    return {
        mint: generateSimTokenCA(), // Single random CA — not a sequence
        symbol,
        score,
        reasons,
        priceChangeM5,
        ageMins
    };
}

// 🟢 Utility: Shuffle arrays safely
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
    // 3 loss, 1 win, 2 win, 2 losses, 1 win, 1 loss, 2 losses, 2 win (14 items)
    const baseSequence = [
        false, false, false, 
        true,                
        true, true,          
        false, false,        
        true,                
        false,               
        false, false,        
        true, true           
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