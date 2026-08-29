// src/services/quote-cache.service.ts
import { redis } from '../lib/redis.js';

const QUOTE_TTL_MS = 250; // 250ms Micro-cache for rapid burst quotes

export async function getCachedQuote<T>(
    mintKey: string,
    amountRaw: string,
    fetchFn: () => Promise<T>
): Promise<T> {
    const cacheKey = `quote_micro:${mintKey}:${amountRaw}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch (_) {}

    const fresh = await fetchFn();
    if (fresh) {
        redis.set(cacheKey, JSON.stringify(fresh), 'PX', QUOTE_TTL_MS).catch(() => {});
    }
    return fresh;
}