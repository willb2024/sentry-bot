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
    const delay = Math.min(times * 200, 3000);
    return delay;
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

redis.on('connect', () => console.log('🟢 [2/5] Redis In-Memory Matrix Connected!'));
redis.on('ready', () => console.log('✅ [REDIS] Ready for operations'));
redis.on('error', (err: any) => {
  console.error('🔴 [REDIS FAULT]:', err.message);
});
redis.on('close', () => {
  console.warn('⚠️ [REDIS] Connection closed – will auto-reconnect');
});
redis.on('reconnecting', () => {
  console.warn('🔄 [REDIS] Attempting to reconnect...');
});

// 🟢 EXPORT checkRedisHealth (Resolves ts(2305) & ts(2339) in index.ts)
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

// 🟢 Keep connection alive with 30s heartbeat ping
setInterval(async () => {
  try { await redis.ping(); } catch (_) {}
}, 30000);