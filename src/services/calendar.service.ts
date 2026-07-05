// src/services/calendar.service.ts
import axios from 'axios';
import { redis } from '../lib/redis.js';

export async function updateLaunchCalendar() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=pump', { timeout: 8000 });
        if (!res.data || !res.data.pairs) return;

        const now = Date.now();
        const validTokens = res.data.pairs.filter((p: any) => {
            if (p.chainId !== 'solana') return false;
            if (!p.pairCreatedAt || (now - p.pairCreatedAt) > 2 * 3600 * 1000) return false; // > 2 hours old
            if (!p.volume || p.volume.h24 < 5000) return false; // < $5k volume
            if (!p.info || !p.info.socials || p.info.socials.length === 0) return false; // No socials
            return true;
        }).slice(0, 10);

        await redis.set('calendar:launches', JSON.stringify(validTokens), 'EX', 2100); // 35 min expiry
    } catch (e) {
        console.error("🔴 [CALENDAR] Failed to update launch calendar.");
    }
}