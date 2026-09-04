// src/lib/redlock.ts
import Redlock from 'redlock';
import { redisTx } from './redis.js';
import { logger } from './logger.js';

export const redlock = new Redlock([redisTx as any], {
  driftFactor: 0.01,
  retryCount: 20,
  retryDelay: 150,
  retryJitter: 150,
});

// @types/redlock expects 'clientError'
redlock.on('clientError', (err: any) => {
  if (err?.name === 'ResourceLockedError' || err?.name === 'LockError') return;
  logger.error('🔴 [REDLOCK ERROR]', { error: err?.message || String(err) });
});

/**
 * Acquire a distributed lock over ALL resources, auto-extend at half-TTL,
 * and guarantee clean release via unlock().
 */
export async function withLock<T>(
  resources: string[],
  ttlMs: number,
  routine: () => Promise<T>,
): Promise<T> {
  const resourceArray = Array.isArray(resources) ? resources : [resources];
  let lock = await redlock.lock(resourceArray, ttlMs);
  let released = false;

  const extender = setInterval(async () => {
    if (released) return;
    try {
      lock = await lock.extend(ttlMs);
    } catch (e: any) {
      logger.warn('⚠️ [REDLOCK] auto-extend failed', { resources: resourceArray, error: e?.message });
    }
  }, Math.max(500, Math.floor(ttlMs / 2)));

  try {
    return await routine();
  } finally {
    released = true;
    clearInterval(extender);
    try {
      await lock.unlock();
    } catch (_) {
      /* lock may have already expired; safe to ignore */
    }
  }
}