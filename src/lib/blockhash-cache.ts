// src/lib/blockhash-cache.ts
import { connection } from './connection.js';

let cachedBlockhash: string = '';
let cachedAt: number = 0;
let isFetching = false;

export function getCachedBlockhash(): string {
    if (Date.now() - cachedAt > 20_000) {
        return ''; // Stale: forces callers to fetch a fresh blockhash
    }
    return cachedBlockhash;
}

async function refreshBlockhash() {
    if (isFetching) return;
    isFetching = true;
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        if (blockhash) {
            cachedBlockhash = blockhash;
            cachedAt = Date.now();
        }
    } catch (_) {
    } finally {
        isFetching = false;
    }
}

setInterval(refreshBlockhash, 1500);
refreshBlockhash();