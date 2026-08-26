// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';

export function getCachedBlockhash(): string {
    return cachedBlockhash;
}

// 🟢 FIX: Tightened steady-state refresh from 3000ms to 1500ms so blockhashes are always hot
setInterval(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
}, 1500);

// Staggered initial boot fetch
setTimeout(async () => {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        cachedBlockhash = blockhash;
    } catch (_) {}
}, 2000);