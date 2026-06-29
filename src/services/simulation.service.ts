// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { generatePnlCard } from './image.service.js';
import { PrismaClient } from '@prisma/client';

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
    // Real Solana signatures are 87-88 base58 chars
    return randomBase58(87);
}

export function randomTradeDelay(): number {
    return Math.floor(Math.random() * 4000) + 1000;
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

// Simulates a buy — returns fake success result after random delay
export async function simExecuteSnipe(
    telegramId: string,
    tokenAddress: string,
    amountSol: number
): Promise<{ success: boolean, signature: string, message: string, volumeSpent: number }> {
    await new Promise(r => setTimeout(r, randomTradeDelay()));

    // Update sim balance
    const currentBal = parseFloat(await getSimBalance(telegramId));
    const newBal = Math.max(0, currentBal - amountSol - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const posKey = `sim:positions:${telegramId}`;
    const existing = JSON.parse(await redis.get(posKey) || '[]');

    // Realistic entry price range for Pump.fun tokens
    const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(12));
    const solUsdPrice = 150;
    const entryPriceUsd = entryPriceSol * solUsdPrice;
    const tokenAmount = Math.floor(amountSol / entryPriceSol);

    const tokenNames = ['DEGEN', 'CHAD', 'PEPE', 'BONK', 'WIF', 'POPCAT', 'GIGA', 'MYRO', 'BOME', 'SLERF', 'MEW', 'ZEUS', 'HARAMBE', 'COPE', 'FOMO'];
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

    const sig = generateSimSignature();
    return {
        success: true,
        signature: sig,
        message: `🟢 Trade Confirmed via Jito Bundle. W1: ✅`,
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
                : -parseFloat((Math.random() * 25 + 5).toFixed(2));   // -5% to -30% (Fixed TS type assignment)

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
    percent: number
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

// Single wallet alert — only one CA per scan as requested
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