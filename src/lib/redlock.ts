// src/lib/redlock.ts
import Redlock from 'redlock';
import { redisTx } from './redis.js';

export const redlock = new Redlock(
  [redisTx as any],
  {
    driftFactor: 0.01,
    retryCount: 20,
    retryDelay: 150,
    retryJitter: 150
  }
);

redlock.on('clientError', (err: any) => {
  if (err?.name === 'ResourceLockedError') return;
  console.error('🔴 [REDLOCK CLIENT ERROR]:', err?.message || err);
});

/**
 * 🟢 Universal Auto-Extending Lock Wrapper:
 * Acquires a distributed lock and automatically extends it every ttl/2 ms 
 * until the routine completes, preventing mid-execution expiration.
 */
export async function withLock<T>(
  resources: string[],
  ttlMs: number,
  routine: () => Promise<T>
): Promise<T> {
  const lock = await redlock.lock(resources[0], ttlMs);
  let released = false;

  const extender = setInterval(async () => {
    if (released) return;
    try {
      await lock.extend(ttlMs);
    } catch (_) {
      console.warn('⚠️ [REDLOCK] Failed to auto-extend lock:', resources[0]);
    }
  }, Math.max(500, Math.floor(ttlMs / 2)));

  try {
    return await routine();
  } finally {
    released = true;
    clearInterval(extender);
    try { 
      await lock.unlock(); 
    } catch (_) {}
  }
}