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
    console.warn(`[REDIS] Reconnecting in ${delay}ms... (Attempt ${times})`);
    return delay;
  },
  reconnectOnError(err) {
    console.error("🔴 [REDIS RECONNECT ERROR]:", err.message);
    return true; // always attempt to reconnect
  },
  // --- CRITICAL FIXES for connection stability ---
  keepAlive: 10000,           // send TCP keepalive every 10s
  connectTimeout: 10000,      // 10s connection timeout
  lazyConnect: false,         // connect immediately
  enableReadyCheck: true,
  // ------------------------------------------------
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

// Optional: export a helper to check health
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}