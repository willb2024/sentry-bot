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
        console.warn(`[REDIS] Connection dropped. Retrying in ${delay}ms... (Attempt ${times})`);
        return delay;
    },
    reconnectOnError(err) {
        console.error("🔴 [REDIS RECONNECT ERROR]:", err.message);
        return true;
    }
};

export const redis = new Redis(redisUrl as string, redisOptions);

redis.on('connect', () => console.log('🟢 [2/5] Redis In-Memory Matrix Connected!'));
redis.on('error', (err: any) => console.error('🔴 [REDIS FAULT]:', err.message));