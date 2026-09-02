// src/services/webhook.service.ts
import { prisma } from '../lib/prisma.js';
import dns from 'dns/promises';
import net from 'net';
import crypto from 'crypto';

async function isSafeWebhookUrl(raw: string): Promise<boolean> {
    let u: URL;
    try { 
        u = new URL(raw); 
    } catch { 
        return false; 
    }
    if (u.protocol !== 'https:') return false;
    if (u.port && !['443', ''].includes(u.port)) return false;

    try {
        const results = await dns.lookup(u.hostname, { all: true });
        if (!results || results.length === 0) return false;

        for (const { address } of results) {
            if (net.isIP(address) === 0) return false;

            // Block IPv4 loopback, private, link-local, CGNAT, broadcast
            if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address)) {
                return false;
            }
            // Block IPv6 loopback, unique local, link-local
            if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80') || address === '::') {
                return false;
            }
        }
        return true;
    } catch { 
        return false; 
    }
}

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
        const payloadStr = JSON.stringify(payload);

        await Promise.allSettled(user.webhookConfigs.map(async (cfg) => {
            if (cfg.events.length > 0 && !cfg.events.includes(event) && !cfg.events.includes('*')) {
                return;
            }

            const isSafe = await isSafeWebhookUrl(cfg.url);
            if (!isSafe) return;

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': 'Sentry-Webhook-Dispatcher/1.0'
            };

            // 🟢 NEW-2 FIX: HMAC-SHA256 signature in header instead of plaintext secret
            if (cfg.secretKey) {
                const signature = crypto
                    .createHmac('sha256', cfg.secretKey)
                    .update(payloadStr)
                    .digest('hex');
                headers['X-Webhook-Signature'] = `sha256=${signature}`;
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            try {
                await fetch(cfg.url, {
                    method: 'POST',
                    headers,
                    body: payloadStr,
                    signal: controller.signal,
                    redirect: 'error'
                });
            } finally {
                clearTimeout(timeout);
            }
        }));
    } catch (_) {}
}