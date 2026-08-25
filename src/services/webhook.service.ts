// src/services/webhook.service.ts
import { prisma } from '../lib/prisma.js';

export async function fireWebhook(telegramId: string, event: 'trade_buy' | 'trade_sell', data: any): Promise<void> {
    try {
        const user = await prisma.user.findUnique({ 
            where: { telegramId },
            include: { webhookConfigs: { where: { isActive: true } } }
        });
        
        if (!user || user.webhookConfigs.length === 0) return;

        const payload = {
            event,
            timestamp: new Date().toISOString(),
            telegramId,
            data
        };

        await Promise.allSettled(user.webhookConfigs.map(async (cfg) => {
            if (cfg.events.length > 0 && !cfg.events.includes(event) && !cfg.events.includes('*')) {
                return;
            }

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': 'Sentry-Webhook-Dispatcher/1.0'
            };

            if (cfg.secretKey) {
                headers['X-Webhook-Secret'] = cfg.secretKey;
            }

            await fetch(cfg.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });
        }));
    } catch (_) {}
}