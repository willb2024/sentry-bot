// src/services/webhook.service.ts
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export async function fireWebhook(telegramId: string, eventName: string, payload: any) {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { webhookConfigs: true } });
        if (!user || !user.webhookConfigs || user.webhookConfigs.length === 0) return;

        const activeHooks = user.webhookConfigs.filter(w => w.isActive && w.events.includes(eventName));
        const timestamp = Date.now();
        const data = JSON.stringify({ event: eventName, timestamp, data: payload });

        await Promise.allSettled(activeHooks.map(async (hook) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (hook.secretKey) {
                headers['X-Sentry-Signature'] = crypto.createHmac('sha256', hook.secretKey).update(data).digest('hex');
            }
            try {
                await axios.post(hook.url, data, { headers, timeout: 3000 });
            } catch (err) {
                // 🟢 Persist to retry queue
                await redis.rpush('webhook_retry_queue', JSON.stringify({ url: hook.url, data, headers, attempts: 0 }));
            }
        }));
    } catch (e) {
        console.error(`🔴 [WEBHOOK] Failed to fire ${eventName}:`, e);
    }
}

export async function drainWebhookRetryQueue() {
    try {
        const item = await redis.lpop('webhook_retry_queue');
        if (!item) return;
        const job = JSON.parse(item);
        if (job.attempts >= 5) return; // Drop after 5 attempts
        try {
            await axios.post(job.url, job.data, { headers: job.headers, timeout: 3000 });
        } catch {
            job.attempts++;
            await redis.rpush('webhook_retry_queue', JSON.stringify(job));
        }
    } catch (_) {}
}