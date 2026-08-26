// src/lib/cache.ts
import { redis } from './redis.js';
import { prisma } from './prisma.js';

export async function getCachedUser(telegramId: string, ttl = 30) {
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

export async function getCachedAutoSnipeConfig(telegramId: string, ttl = 20) {
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

export async function getCachedAutoSnipeConfigFull(telegramId: string, ttl = 30) {
    const key = `cache:autosnipe_full:${telegramId}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);

    const user = await prisma.user.findUnique({
        where: { telegramId },
        include: { autoSnipeConfig: true }
    });
    if (user) await redis.set(key, JSON.stringify(user), 'EX', ttl);
    return user;
}

export async function getCachedCopyTradeMenu(telegramId: string, ttl = 20) {
    const key = `cache:copytrade_menu:${telegramId}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);

    const user = await prisma.user.findUnique({
        where: { telegramId },
        include: {
            copyTrades: { where: { isActive: true } },
            followedBy: { where: { isActive: true } },
            following: { where: { isActive: true }, include: { leader: true } }
        }
    });
    if (user) await redis.set(key, JSON.stringify(user), 'EX', ttl);
    return user;
}

// 🟢 Activity tracker: tracks recent users so background workers pre-warm balances in RAM
export async function markUserActive(telegramId: string) {
    try {
        await redis.zadd('active_users_recent', Date.now(), telegramId);
        await redis.zremrangebyrank('active_users_recent', 0, -201); // Keeps top 200 active users
    } catch (_) {}
}

export async function invalidateUserCache(telegramId: string) {
    try {
        await redis.del(
            `cache:user:${telegramId}`,
            `cache:autosnipe:${telegramId}`,
            `cache:autosnipe_full:${telegramId}`,
            `cache:copytrade_menu:${telegramId}`
        );
    } catch (_) {}
}