// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';

export function getCachedBlockhash(): string {
    return cachedBlockhash;
}

// 🟢 Slowed down to 3000ms (3 seconds) to save RPC credits
setInterval(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {} // Silent catch to prevent console spam when rate-limited
}, 3000);

// Populate immediately on boot
(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
})();