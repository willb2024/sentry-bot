// src/services/webhook.service.ts
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import crypto from 'crypto';

const prisma = new PrismaClient();

export async function fireWebhook(telegramId: string, eventName: string, payload: any) {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { webhookConfigs: true } });
        if (!user || !user.webhookConfigs || user.webhookConfigs.length === 0) return;

        const activeHooks = user.webhookConfigs.filter(w => w.isActive && w.events.includes(eventName));
        
        const timestamp = Date.now();
        const data = JSON.stringify({
            event: eventName,
            timestamp,
            data: payload
        });

        await Promise.allSettled(activeHooks.map(async (hook) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            
            if (hook.secretKey) {
                const signature = crypto.createHmac('sha256', hook.secretKey).update(data).digest('hex');
                headers['X-Sentry-Signature'] = signature;
            }

            await axios.post(hook.url, data, { headers, timeout: 3000 });
        }));
    } catch (e) {
        console.error(`🔴 [WEBHOOK] Failed to fire ${eventName}:`, e);
    }
}