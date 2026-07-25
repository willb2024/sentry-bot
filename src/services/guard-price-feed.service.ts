// src/services/guard-price-feed.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { redis } from '../lib/redis.js';
import { getBondingCurveAddress, decodePumpCurvePrice } from './price.service.js';

// mint -> { subscriptionId, lastPriceSol, subscribers }
const activeSubscriptions = new Map<string, { subId: number; lastPriceSol: number; subscribers: Set<string> }>();

// Called once per guard when it's created (buy fires, DCA fires, copytrade opens, etc.)
export async function subscribeToMintPrice(mint: string, guardId: string): Promise<void> {
    if (!mint.toLowerCase().endsWith('pump')) {
        return; // No bonding curve to subscribe to — checkAndTriggerGuard's fallback will price this via Jupiter.
    }
    
    const existing = activeSubscriptions.get(mint);
    if (existing) {
        existing.subscribers.add(guardId);
        return; 
    }

    try {
        const curvePda = new PublicKey(getBondingCurveAddress(mint));
        const subId = connection.onAccountChange(curvePda, (accInfo) => {
            try {
                const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                
                // 🟢 FIX 1.1: Stop trusting the curve the moment it graduates — force callers back to the Jupiter fallback
                if (buf.length > 2 && buf[2] === 1) { 
                    const entry = activeSubscriptions.get(mint);
                    if (entry) entry.lastPriceSol = 0;
                    return;
                }
                
                const priceSol = decodePumpCurvePrice(buf.toString('base64'));
                const entry = activeSubscriptions.get(mint);
                if (entry) entry.lastPriceSol = priceSol;
                redis.set(`live_price:${mint}`, priceSol.toString(), 'EX', 30).catch(() => {});
            } catch (_) {}
        }, 'confirmed');

        activeSubscriptions.set(mint, { subId, lastPriceSol: 0, subscribers: new Set([guardId]) });
        console.log(`🟢 [GUARD FEED] Subscribed to ${mint.substring(0, 8)}... (push-based, no polling)`);
    } catch (e: any) {
        console.error(`🔴 [GUARD FEED] Subscribe failed for ${mint}: ${e.message}`);
    }
}

// Called when a guard closes (TP hit, SL hit, manual cancel)
export async function unsubscribeFromMintPrice(mint: string, guardId: string): Promise<void> {
    const entry = activeSubscriptions.get(mint);
    if (!entry) return;
    entry.subscribers.delete(guardId);
    if (entry.subscribers.size === 0) {
        try { await connection.removeAccountChangeListener(entry.subId); } catch (_) {}
        activeSubscriptions.delete(mint);
        console.log(`🔵 [GUARD FEED] Unsubscribed from ${mint.substring(0, 8)}... (no more guards watching it)`);
    }
}

// Read path — guards check this instead of making their own RPC call
export function getLivePriceSol(mint: string): number | null {
    const entry = activeSubscriptions.get(mint);
    return entry && entry.lastPriceSol > 0 ? entry.lastPriceSol : null;
}

export function getActiveSubscriptionCount(): number {
    return activeSubscriptions.size;
}