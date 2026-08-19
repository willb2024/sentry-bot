// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';

export function getCachedBlockhash(): string {
    return cachedBlockhash;
}

// 🟢 Sub-second 800ms blockhash cache
setInterval(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
}, 800);

// Populate immediately on boot
(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
})();