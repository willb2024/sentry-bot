// src/lib/redis.ts
import { Redis, RedisOptions } from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.warn("⚠️ REDIS_URL missing in .env! Engine cannot store fast memory.");
}

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 200, 3000);
  },
  reconnectOnError() {
    return true; 
  },
  keepAlive: 10000,           
  connectTimeout: 10000,      
  lazyConnect: false,         
  enableReadyCheck: true,
  enableAutoPipelining: true,
};

export const redis = new Redis(redisUrl as string, redisOptions);

// 🟢 DEDICATED NON-PIPELINED CLIENT FOR SAFE WATCH/MULTI & REDLOCK
export const redisTx = new Redis(redisUrl as string, {
  ...redisOptions,
  enableAutoPipelining: false
});

redis.on('connect', () => console.log('🟢 [2/5] Redis In-Memory Matrix Connected!'));
redis.on('error', (err: any) => console.error('🔴 [REDIS FAULT]:', err.message));

redisTx.on('connect', () => console.log('🟢 Redis TX (non-pipelined) Connected!'));
redisTx.on('error', (err: any) => console.error('🔴 [REDIS-TX FAULT]:', err.message));

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

// 🟢 Track heartbeat interval in global registry for clean process shutdown
if (!(global as any)._sentryIntervals) (global as any)._sentryIntervals = [];
(global as any)._sentryIntervals.push(setInterval(async () => {
  try { 
    await redis.ping();
    await redisTx.ping();
  } catch (_) {}
}, 30000));