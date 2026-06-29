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
    amountSol: number,
    forcedTriggerDelayMs: number = 2000 // 🟢 Exactly 2 seconds as requested
): Promise<{ success: boolean, signature: string, message: string, volumeSpent: number }> {
    await new Promise(r => setTimeout(r, 400)); // slight network delay

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

    const orderId = crypto.randomUUID();
    const guardOrder = {
        id: orderId, telegramId, tokenAddress,
        trailingPercent: 20, highestSeenPrice: entryPriceSol,
        amountInSol: amountSol, entryPrice: entryPriceSol, takeProfitPercent: 50
    };
    await redis.set(`sim:guard:${tokenAddress}:${telegramId}`, JSON.stringify(guardOrder), 'EX', 3600);

    // Schedule the guaranteed profit trigger exactly 2 seconds later
    scheduleSimGuardTrigger(telegramId, tokenAddress, orderId, amountSol, entryPriceSol, symbol, forcedTriggerDelayMs);

    return {
        success: true,
        signature: generateSimSignature(),
        message: `🟢 Trade Confirmed via Jito Bundle. W1: ✅`,
        volumeSpent: amountSol
    };
}

// 🟢 GUARANTEED PROFIT TRIGGER
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
            const guardRaw = await redis.get(`sim:guard:${tokenAddress}:${telegramId}`);
            const firedKey = `sim:pnl_fired:${tokenAddress}:${telegramId}`;
const alreadyFired = await redis.get(firedKey);
if (alreadyFired) return;
await redis.set(firedKey, '1', 'EX', 60);
            if (!guardRaw) return;

            // Guaranteed Profit for the demo! (+50% to +150%)
            const pnlPercent = parseFloat((Math.random() * 100 + 50).toFixed(2));
            const exitSig = generateSimSignature();
            const pnlSol = (amountInSol * Math.abs(pnlPercent / 100));

            const captionText = 
                `🎯 <b>TAKE PROFIT TRIGGERED!</b>\n\n` +
                `Token: <code>${tokenAddress.substring(0, 8)}...</code>\n` +
                `💰 <b>Net Profit: +${pnlSol.toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)\n` +
                `Status: 🟢 Auto-Sold 100% via Jito.\n` +
                `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

            const currentBal = parseFloat(await getSimBalance(telegramId));
            const returnSol = amountInSol + pnlSol;
            await redis.set(`sim:balance:${telegramId}`, Math.max(0, currentBal + returnSol).toFixed(4));

            const posKey = `sim:positions:${telegramId}`;
            const positions = JSON.parse(await redis.get(posKey) || '[]');
            const updated = positions.filter((p: any) => p.mint !== tokenAddress);
            await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
            await redis.del(`sim:guard:${tokenAddress}:${telegramId}`);

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
                    method: 'POST', body: form
                });
            } catch (_) {}
        } catch (_) {}
    }, delayMs);
}

export async function simExecuteExit(
    telegramId: string,
    tokenAddress: string,
    percent: number
): Promise<{ success: boolean, signature: string, message: string }> {
    await new Promise(r => setTimeout(r, 400));

    const posKey = `sim:positions:${telegramId}`;
    const positions = JSON.parse(await redis.get(posKey) || '[]');
    const pos = positions.find((p: any) => p.mint === tokenAddress);

    const pnlPercent = parseFloat((Math.random() * 200 + 50).toFixed(2)); // Forced profit
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
    mint: string, symbol: string, score: number, reasons: string[], priceChangeM5: number, ageMins: number
} {
    const symbols = ['DOGE', 'BONK', 'WIF', 'MYRO', 'POPCAT', 'ZEUS', 'BOME', 'MEW', 'SLERF'];
    return {
        mint: generateSimTokenCA(),
        symbol: symbols[Math.floor(Math.random() * symbols.length)],
        score: Math.floor(Math.random() * 25) + 75,
        reasons: [`🔥 High momentum`, `📈 Heavy buy pressure`, `💧 Deep liquidity`],
        priceChangeM5: parseFloat((Math.random() * 220 + 30).toFixed(1)),
        ageMins: Math.floor(Math.random() * 45) + 2
    };
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
    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        
        const tokenCA = generateSimTokenCA();
        const amountSol = parseFloat((Math.random() * 2 + 0.5).toFixed(2));
        
        // Buys the coin. Automatically sells it exactly 3 seconds later via scheduleSimGuardTrigger
        await simExecuteSnipe(telegramId, tokenCA, amountSol, 3000); 
        
        // Wait 2 seconds before buying the NEXT coin
        // (Since the buy/sell lifecycle above takes 3 seconds, waiting 5 seconds total ensures they don't overlap wildly)
        await new Promise(r => setTimeout(r, 2000));
    }
}