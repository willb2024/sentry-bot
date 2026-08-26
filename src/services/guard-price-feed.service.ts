// src/services/guard-price-feed.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';
import axios from 'axios';

const activeSubscriptions = new Map<string, { subId: number; lastPriceSol: number; subscribers: Set<string> }>();
const fastPollTargets = new Map<string, { lastPriceSol: number; subscribers: Set<string> }>();
let fastPollLoopStarted = false;

function startFastPollLoop() {
    if (fastPollLoopStarted) return;
    fastPollLoopStarted = true;

    // 🟢 FIX: Optimized polling interval to 800ms (balanced for speed + bounded RPC load)
    setInterval(async () => {
        const mints = [...fastPollTargets.keys()];
        if (mints.length === 0) return;
        const chunks: string[][] = [];
        for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

        await Promise.all(chunks.map(async (chunk) => {
            try {
                const res = await axios.get(`https://lite-api.jup.ag/price/v2?ids=${chunk.join(',')}`, { timeout: 1200 });
                for (const mint of chunk) {
                    const price = res.data?.data?.[mint]?.price;
                    if (price && parseFloat(price) > 0) {
                        const entry = fastPollTargets.get(mint);
                        if (entry) entry.lastPriceSol = parseFloat(price);
                    }
                }
            } catch (_) {}
        }));
    }, 800);

    console.log("🟢 [GUARD FEED] Fast-poll loop active (800ms interval, parallel chunks).");
}
export async function subscribeToMintPrice(mint: string, guardId: string): Promise<void> {
    if (mint.toLowerCase().endsWith('pump')) {
        const existing = activeSubscriptions.get(mint);
        if (existing) {
            existing.subscribers.add(guardId);
            return;
        }

        try {
            const curvePda = new PublicKey(getBondingCurveAddress(mint));
            // 🟢 'processed' commitment for lowest latency slot-level detection
            const subId = connection.onAccountChange(curvePda, (accInfo) => {
                try {
                    const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);

                    if (buf.length > 2 && buf[2] === 1) {
                        const entry = activeSubscriptions.get(mint);
                        if (entry) {
                            entry.lastPriceSol = 0;
                            const subs = entry.subscribers;
                            connection.removeAccountChangeListener(entry.subId).catch(() => {});
                            activeSubscriptions.delete(mint);
                            fastPollTargets.set(mint, { lastPriceSol: 0, subscribers: subs });
                            startFastPollLoop();
                            console.log(`🔄 [GUARD FEED] ${mint.substring(0,8)}... graduated — migrated to fast-poll.`);
                        }
                        return;
                    }

                    const priceSol = decodePumpCurvePrice(buf.toString('base64'));
                    const entry = activeSubscriptions.get(mint);
                    if (entry) entry.lastPriceSol = priceSol;
                    redis.set(`live_price:${mint}`, priceSol.toString(), 'EX', 30).catch(() => {});
                } catch (_) {}
            }, 'processed');

            activeSubscriptions.set(mint, { subId, lastPriceSol: 0, subscribers: new Set([guardId]) });
            console.log(`🟢 [GUARD FEED] Subscribed to ${mint.substring(0, 8)}... (processed stream)`);
        } catch (e: any) {
            const existing2 = fastPollTargets.get(mint);
            if (existing2) existing2.subscribers.add(guardId);
            else fastPollTargets.set(mint, { lastPriceSol: 0, subscribers: new Set([guardId]) });
            startFastPollLoop();
        }
        return;
    }

    const existing = fastPollTargets.get(mint);
    if (existing) {
        existing.subscribers.add(guardId);
        return;
    }
    fastPollTargets.set(mint, { lastPriceSol: 0, subscribers: new Set([guardId]) });
    
    if (!fastPollLoopStarted) {
        startFastPollLoop();
    }
    console.log(`🟢 [GUARD FEED] Fast-poll registered for ${mint.substring(0, 8)}... (250ms interval)`);
}

export async function unsubscribeFromMintPrice(mint: string, guardId: string): Promise<void> {
    const entry = activeSubscriptions.get(mint);
    if (entry) {
        entry.subscribers.delete(guardId);
        if (entry.subscribers.size === 0) {
            try { await connection.removeAccountChangeListener(entry.subId); } catch (_) {}
            activeSubscriptions.delete(mint);
            console.log(`🔵 [GUARD FEED] Unsubscribed from ${mint.substring(0, 8)}...`);
        }
        return;
    }

    const fastEntry = fastPollTargets.get(mint);
    if (fastEntry) {
        fastEntry.subscribers.delete(guardId);
        if (fastEntry.subscribers.size === 0) {
            fastPollTargets.delete(mint);
            console.log(`🔵 [GUARD FEED] Fast-poll deregistered for ${mint.substring(0, 8)}...`);
        }
    }
}

export function getLivePriceSol(mint: string): number | null {
    const entry = activeSubscriptions.get(mint);
    if (entry && entry.lastPriceSol > 0) return entry.lastPriceSol;

    const fastEntry = fastPollTargets.get(mint);
    if (fastEntry && fastEntry.lastPriceSol > 0) return fastEntry.lastPriceSol;

    return null;
}

export function getActiveSubscriptionCount(): number {
    return activeSubscriptions.size + fastPollTargets.size;
}