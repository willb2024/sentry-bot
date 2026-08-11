// src/services/image.service.ts
import { createCanvas, loadImage } from '@napi-rs/canvas';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Draws a rounded rectangle path on the canvas context.
 */
function drawRoundRect(ctx: any, x: number, y: number, width: number, height: number, radius: number) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

/**
 * Attempts to load the Sentry logo from local assets.
 */
async function loadLogoImage() {
    try {
        const logoPath = path.join(__dirname, 'assets', 'logo.jpg');
        if (fs.existsSync(logoPath)) {
            return await loadImage(logoPath);
        }
    } catch (_) {}
    return null;
}

/**
 * Generates a high-quality green/red PnL Card for trade confirmations.
 */
export async function generatePnlCard(
    tokenAddress: string,
    pnlPercent: number,
    referralCode?: string
): Promise<Buffer> {
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    // Background Gradient
    const gradient = ctx.createLinearGradient(0, 0, 800, 400);
    gradient.addColorStop(0, '#0a0d14');
    gradient.addColorStop(1, '#121826');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 400);

    // Border
    const isProfit = pnlPercent >= 0;
    ctx.strokeStyle = isProfit ? '#10b981' : '#ef4444';
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 760, 360);

    // Header Logo
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('⚡ SENTRY TERMINAL', 40, 70);

    // Optional Logo Drawing if present
    const logo = await loadLogoImage();
    if (logo) {
        ctx.drawImage(logo, 700, 40, 40, 40);
    }

    // Token CA
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(`$${tokenAddress.substring(0, 8)}...`, 40, 180);

    // PnL Value
    ctx.fillStyle = isProfit ? '#10b981' : '#ef4444';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText(`${isProfit ? '+' : ''}${pnlPercent.toFixed(1)}%`, 40, 270);

    // MEV Badge
    ctx.fillStyle = '#334155';
    ctx.font = '16px sans-serif';
    ctx.fillText('🛡️ MEV Protected • Jito Bundle Executed', 40, 330);

    // Referral Footer
    if (referralCode) {
        ctx.fillStyle = '#4b5563';
        ctx.font = '14px sans-serif';
        const botName = process.env.BOT_USERNAME || 'SentryTerminalBot';
        ctx.fillText(`Copy my trades: t.me/${botName}?start=${referralCode}`, 40, 370);
    }

    return Buffer.from(canvas.toBuffer('image/png'));
}

/**
 * Generates a token deployment receipt card with Jito Block-0 details.
 */
export async function generateLaunchCard(
    name: string, symbol: string, tokenAddress: string, devBuySol: number, wallets: number
): Promise<Buffer> {
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 800, 400);
    gradient.addColorStop(0, '#0a0d14');
    gradient.addColorStop(1, '#121826');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 400);

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 760, 360);

    ctx.fillStyle = '#3b82f6';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('🚀 DEPLOYED WITH SENTRY', 40, 70);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(`${name} ($${symbol})`, 40, 180);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '22px sans-serif';
    ctx.fillText(`CA: ${tokenAddress.substring(0, 12)}...`, 40, 240);

    ctx.fillStyle = '#4b5563';
    ctx.font = '18px sans-serif';
    ctx.fillText(`💳 Dev Buy: ${devBuySol} SOL | 🤖 Wallets: ${wallets}`, 40, 310);

    ctx.fillStyle = '#334155';
    ctx.font = '16px sans-serif';
    ctx.fillText('🔗 Jito Block-0 Bundle Routing Active', 40, 360);

    return Buffer.from(canvas.toBuffer('image/png'));
}

/**
 * Generates a dynamic line chart to render 1H historical candle trends using QuickChart.
 */
export async function generatePriceAlertChart(
    symbol: string,
    candles: Array<{ time: number; open: number; high: number; low: number; close: number }>,
    targetPrice: number,
    currentPrice: number
): Promise<Buffer> {
    const labels = candles.map(c => new Date(c.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const closes = candles.map(c => c.close);
    const isGreen = currentPrice >= (candles[0]?.close || currentPrice);

    const config = {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: `${symbol} Price`,
                    data: closes,
                    borderColor: isGreen ? '#10b981' : '#ef4444',
                    backgroundColor: isGreen ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2.5,
                    pointRadius: 0
                },
                {
                    label: `Target $${targetPrice.toFixed(6)}`,
                    data: Array(labels.length).fill(targetPrice),
                    borderColor: '#f59e0b',
                    borderDash: [6, 3],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            plugins: {
                legend: { display: true, labels: { color: '#94a3b8' } },
                title: { display: true, text: `${symbol} — 1H Price Action`, color: '#f8fafc' }
            },
            scales: {
                x: { ticks: { color: '#64748b', maxTicksLimit: 8 } },
                y: { ticks: { color: '#64748b' } }
            }
        }
    };

    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    const url = `https://quickchart.io/chart?width=800&height=400&backgroundColor=%230a0d14&c=${encodedConfig}`;

    const res = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
}