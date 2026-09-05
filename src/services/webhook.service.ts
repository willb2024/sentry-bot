// src/services/webhook.service.ts
import { prisma } from '../lib/prisma.js';
import dns from 'dns/promises';
import net from 'net';
import crypto from 'crypto';
import https from 'https';

async function resolveSafeWebhook(raw: string): Promise<{
    ip: string; family: number; hostname: string; port: number; path: string;
} | null> {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (u.protocol !== 'https:') return null;
    const port = u.port ? parseInt(u.port, 10) : 443;
    if (port !== 443) return null;

    try {
        const results = await dns.lookup(u.hostname, { all: true });
        if (!results || results.length === 0) return null;

        // Validate every resolved record against private/reserved ranges
        for (const { address } of results) {
            if (net.isIP(address) === 0) return null;

            // Private, loopback, link-local, carrier-grade NAT IPv4
            if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address)) {
                return null;
            }
            // Loopback, unique-local, link-local IPv6
            if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80') || address === '::') {
                return null;
            }
        }

        const first = results[0];
        return {
            ip: first.address,
            family: first.family,
            hostname: u.hostname,
            port,
            path: (u.pathname || '/') + (u.search || ''),
        };
    } catch {
        return null;
    }
}

function dispatchPinnedHttpsPost(
    safe: { ip: string; family: number; hostname: string; port: number; path: string },
    payloadStr: string,
    headers: Record<string, string>
): Promise<void> {
    return new Promise((resolve) => {
        const req = https.request(
            {
                host: safe.ip,                 // Connect straight to validated IP (no DNS re-resolution)
                servername: safe.hostname,     // SNI cert check against real hostname
                port: safe.port,
                path: safe.path,
                method: 'POST',
                family: safe.family,
                rejectUnauthorized: true,
                timeout: 5000,
                headers: {
                    ...headers,
                    Host: safe.hostname,       // Virtual-host routing header
                    'Content-Length': Buffer.byteLength(payloadStr),
                },
            },
            (res) => {
                res.resume();
                res.on('end', () => resolve());
                res.on('error', () => resolve());
            }
        );

        req.on('error', () => resolve());
        req.on('timeout', () => { 
            req.destroy(); 
            resolve(); 
        });

        req.write(payloadStr);
        req.end();
    });
}

export async function fireWebhook(
    telegramId: string,
    event: 'trade_buy' | 'trade_sell',
    data: any
): Promise<void> {
    try {
        const user = await prisma.user.findUnique({
            where: { telegramId },
            include: { webhookConfigs: { where: { isActive: true } } },
        });

        if (!user || user.webhookConfigs.length === 0) return;

        const payload = { event, timestamp: new Date().toISOString(), telegramId, data };
        const payloadStr = JSON.stringify(payload);

        await Promise.allSettled(
            user.webhookConfigs.map(async (cfg) => {
                if (cfg.events.length > 0 && !cfg.events.includes(event) && !cfg.events.includes('*')) {
                    return;
                }

                const safe = await resolveSafeWebhook(cfg.url);
                if (!safe) return;

                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Sentry-Webhook-Dispatcher/1.0',
                };

                if (cfg.secretKey) {
                    const signature = crypto
                        .createHmac('sha256', cfg.secretKey)
                        .update(payloadStr)
                        .digest('hex');
                    headers['X-Webhook-Signature'] = `sha256=${signature}`;
                }

                await dispatchPinnedHttpsPost(safe, payloadStr, headers);
            })
        );
    } catch (_) {}
}