// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';

export function getCachedBlockhash(): string {
    return cachedBlockhash;
}

// 🟢 Steady-state refresh every 3000ms
setInterval(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
}, 3000);

// 🟢 FIX: Stagger initial boot fetch by 4 seconds instead of firing at 0ms
setTimeout(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
}, 4000);