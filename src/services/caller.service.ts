// src/services/caller.service.ts
import axios from 'axios';
import { getBondingCurveAddress } from './price.service.js';
import { redis } from '../lib/redis.js';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface TokenScore {
    mint: string;
    symbol: string;
    totalScore: number;
    breakdown: {
        volumeSpike: number;      
        buySellRatio: number;     
        liquidityDepth: number;   
        ageScore: number;         
        mevRisk: number;          
        curveProgress: number;    
    };
    reasons: string[];
    warnings: string[];
}

export interface CallerFilters {
    minVolUsd: number;
    maxAgeMins: number;
    blockMev: boolean;
    minScore: number;
    isActive: boolean;
}

const DEFAULT_FILTERS: CallerFilters = {
    minVolUsd: 10000,
    maxAgeMins: 120,
    blockMev: true,
    minScore: 70,
    isActive: false
};

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        return raw ? JSON.parse(raw) : DEFAULT_FILTERS;
    } catch (e: any) {
        console.error(`🔴 [CALLER] Failed to read filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

export async function setUserCallerFilters(telegramId: string, filters: Partial<CallerFilters>): Promise<CallerFilters> {
    try {
        const current = await getUserCallerFilters(telegramId);
        const updated = { ...current, ...filters };
        await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
        return updated;
    } catch (e: any) {
        console.error(`🔴 [CALLER] Failed to write filters for ${telegramId}: ${e.message}`);
        return DEFAULT_FILTERS;
    }
}

// 🟢 NEW TRENCH RADAR FEATURE: Registers a new coin for volume tracking the second it is born on-chain
export async function registerTrenchCandidate(mint: string): Promise<void> {
    try {
        const now = Date.now();
        await redis.zadd('trench_candidates', now, mint);
        
        // Grab initial reserves immediately to use as a starting point
        const curvePda = getBondingCurveAddress(mint);
        const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
        
        if (accInfo?.data) {
            const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
            const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
            await redis.set(`trench_init_reserves:${mint}`, virtualSolReserves.toString(), 'EX', 600);
        }
    } catch (e: any) {
        console.error(`⚠️ [TRENCH RADAR] Failed to register candidate ${mint.substring(0,6)}:`, e.message);
    }
}

const TOKEN_PROCESSING_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// 🟢 NEW TRENCH RADAR FEATURE: The real-time loop that tracks pool changes
export function startTrenchRadar(bot: any) {
    console.log("📡 [TRENCH RADAR] Stream-Based Breakout Engine Active. Polling every 10 seconds.");

    setInterval(async () => {
        try {
            const now = Date.now();
            const fiveMinsAgo = now - 300000; // 5 minute tracking window

            // 1. Clean up old candidates from temporal set
            await redis.zremrangebyscore('trench_candidates', '-inf', fiveMinsAgo);

            // 2. Fetch remaining active candidates
            const candidates = await redis.zrangebyscore('trench_candidates', fiveMinsAgo, now);
            if (candidates.length === 0) return;

            const subscribedUsers = await prisma.user.findMany({ select: { telegramId: true } });
            
            // 3. Process candidate reserves using the safe parallel queue
            await mapWithConcurrency(candidates, TOKEN_PROCESSING_CONCURRENCY, async (mint) => {
                try {
                    const curvePda = getBondingCurveAddress(mint);
                    const accInfo = await connection.getAccountInfo(new PublicKey(curvePda));
                    if (!accInfo?.data) return;

                    const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                    const currentSol = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                    
                    const initialSolRaw = await redis.get(`trench_init_reserves:${mint}`);
                    const initialSol = initialSolRaw ? parseFloat(initialSolRaw) : 30.0; 

                    const solDelta = currentSol - initialSol;

                    // 🟢 BREAKOUT! Token received more than 4.0 SOL of buy volume in under 5 minutes
                    if (solDelta >= 4.0) {
                        const isNotifiedGlobal = await redis.set(`trench_notified:${mint}`, '1', 'EX', 86400, 'NX');
                        if (!isNotifiedGlobal) return; // Prevent double alerts

                        // Retrieve metadata gracefully
                        let symbol = "UNKNOWN";
                        try {
                            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 1500 });
                            symbol = dexRes.data?.pairs?.[0]?.baseToken?.symbol || "UNKNOWN";
                        } catch (_) {}

                        const progress = Math.min(100, (currentSol / 85) * 100);

                        for (const user of subscribedUsers) {
                            const filters = await getUserCallerFilters(user.telegramId);
                            if (!filters.isActive) continue;

                            const msg = `📡 <b>SENTRY RADAR — Trench Breakout!</b>\n\n` +
                                        `🪙 <b>Token:</b> $${symbol} (<code>${mint}</code>)\n` +
                                        `📈 <b>Buy Volume:</b> +${solDelta.toFixed(2)} SOL in under 5 mins!\n` +
                                        `🚀 <b>Bonding Curve:</b> ${progress.toFixed(0)}% completed\n\n` +
                                        `✅ <i>Breaking out of the baseline trend on high volume.</i>\n\n` +
                                        `<i>Reply with the CA to quick-snipe, or click below.</i>`;

                            await bot.telegram.sendMessage(user.telegramId, msg, {
                                parse_mode: 'HTML',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '⚡ Snipe 0.1 SOL', callback_data: `forcebuy_${mint}_0.1` },
                                        { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${mint}` }
                                    ]]
                                }
                            }).catch(() => null);
                        }
                    }
                } catch (err: any) {
                    console.error(`⚠️ [TRENCH RADAR] Failed to evaluate ${mint.substring(0,6)}...: ${err.message}`);
                }
            });
        } catch (e: any) {
            console.error("🔴 [TRENCH RADAR] Loop Error:", e.message);
        }
    }, 10 * 1000); // 10-second tick rate for maximum resolution
}