// src/lib/cache.ts
import { redis } from './redis.js';
import { prisma } from './prisma.js';

export async function getCachedUser(telegramId: string, ttl = 10) {
    const key = `cache:user:${telegramId}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
    
    const user = await prisma.user.findUnique({ 
        where: { telegramId },
        include: { _count: { select: { recruits: true } } }
    });
    if (user) await redis.set(key, JSON.stringify(user), 'EX', ttl);
    return user;
}

export async function getCachedAutoSnipeConfig(telegramId: string, ttl = 5) {
    const key = `cache:autosnipe:${telegramId}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);

    const user = await prisma.user.findUnique({
        where: { telegramId },
        include: { autoSnipeConfig: true }
    });
    const config = user?.autoSnipeConfig || null;
    if (config) await redis.set(key, JSON.stringify(config), 'EX', ttl);
    return config;
}

export async function invalidateUserCache(telegramId: string) {
    await redis.del(`cache:user:${telegramId}`, `cache:autosnipe:${telegramId}`);
}