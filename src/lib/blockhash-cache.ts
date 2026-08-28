// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';
let isFetching = false;

export function getCachedBlockhash(): string {
    return cachedBlockhash;
}

async function refreshBlockhash() {
    if (isFetching) return;
    isFetching = true;
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        if (blockhash) {
            cachedBlockhash = blockhash;
        }
    } catch (_) {
        // Silently back off on transient rate limits
    } finally {
        isFetching = false;
    }
}

// 🟢 Steady-state refresh every 1500ms
setInterval(refreshBlockhash, 1500);

// 🟢 FIX: Fire immediately on module load instead of waiting 2000ms
refreshBlockhash();
