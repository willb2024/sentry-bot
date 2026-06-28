// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';

// Generates realistic-looking random Solana wallet addresses
// Uses base58 character set, 44 characters long
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
    // Generate between 1 and 5 wallets with random balances
    const count = Math.floor(Math.random() * 5) + 1;
    return Array.from({ length: count }, () => ({
        address: randomBase58(44),
        balance: parseFloat((Math.random() * 8 + 0.5).toFixed(4))
    }));
}

export function generateSimTokenCA(): string {
    // Ends in 'pump' 60% of the time to look like real Pump.fun tokens
    const isPump = Math.random() > 0.4;
    const base = randomBase58(isPump ? 36 : 44);
    return isPump ? base + 'pump' : base;
}

export function generateSimSignature(): string {
    return randomBase58(88);
}

// Random delay between 1000ms and 5000ms for realistic timing
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

    // Store sim position
    const posKey = `sim:positions:${telegramId}`;
    const existing = JSON.parse(await redis.get(posKey) || '[]');
    const entryPrice = parseFloat((Math.random() * 0.00001 + 0.000001).toFixed(9));
    
    existing.push({
        mint: tokenAddress,
        symbol: 'SIM' + tokenAddress.substring(0, 4).toUpperCase(),
        amount: Math.floor(amountSol / entryPrice),
        entryPrice,
        priceUsd: entryPrice * 150,
        valueUsd: amountSol * 150,
        amountInSol: amountSol
    });
    await redis.set(posKey, JSON.stringify(existing), 'EX', 3600);

    return {
        success: true,
        signature: generateSimSignature(),
        message: '🟢 Simulation: Jito bundle confirmed.',
        volumeSpent: amountSol
    };
}

// Simulates a profitable sell — PnL between +15% and +340%
export async function simExecuteExit(
    telegramId: string,
    tokenAddress: string,
    percent: number
): Promise<{ success: boolean, signature: string, message: string }> {
    await new Promise(r => setTimeout(r, randomTradeDelay()));

    const posKey = `sim:positions:${telegramId}`;
    const positions = JSON.parse(await redis.get(posKey) || '[]');
    const pos = positions.find((p: any) => p.mint === tokenAddress);

    let pnlPercent = parseFloat((Math.random() * 325 + 15).toFixed(2));

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
        message: `🟢 Simulation: Sold ${percent}% | PnL: +${pnlPercent}%`
    };
}

// Generates a fake coin caller alert with a random wallet CA
export function generateSimCallerAlert(): {
    mint: string,
    symbol: string,
    score: number,
    reasons: string[],
    priceChangeM5: number
} {
    const symbols = ['DOGE', 'BONK', 'WIF', 'MYRO', 'POPCAT', 'ZEUS', 'BOME', 'MEW', 'SLERF', 'GIGA'];
    const symbol = symbols[Math.floor(Math.random() * symbols.length)];
    const score = Math.floor(Math.random() * 35) + 65; // 65-100
    const priceChangeM5 = parseFloat((Math.random() * 180 + 20).toFixed(1));

    const possibleReasons = [
        `🔥 High momentum (+${Math.floor(priceChangeM5 * 1.2)}% vol spike)`,
        `📈 Heavy buy pressure (${Math.floor(Math.random() * 20 + 65)}% buys)`,
        `💧 Deep liquidity ($${Math.floor(Math.random() * 80 + 20)}k)`,
        `👶 Very fresh (${Math.floor(Math.random() * 25 + 2)} mins old)`,
        `🛡️ RugCheck passed: Low Risk (Safe contract)`,
        `🚀 Curve ${Math.floor(Math.random() * 30 + 60)}% to graduation`
    ];

    // Pick 3-4 random reasons
    const shuffled = possibleReasons.sort(() => Math.random() - 0.5);
    const reasons = shuffled.slice(0, Math.floor(Math.random() * 2) + 3);

    return {
        mint: generateSimTokenCA(),
        symbol,
        score,
        reasons,
        priceChangeM5
    };
}