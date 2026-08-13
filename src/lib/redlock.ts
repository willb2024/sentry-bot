// src/lib/redlock.ts
import Redlock from 'redlock';
import { redis } from './redis.js';

export const redlock = new Redlock(
  [redis as any], // 🟢 FIX: Cast to 'any' to bypass TS error
  {
    driftFactor: 0.01,
    retryCount: 10,
    retryDelay: 200,
    retryJitter: 100,
  }
);