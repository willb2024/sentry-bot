// src/services/image.service.ts
import { createCanvas } from '@napi-rs/canvas';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

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

export async function generatePnlCard(tokenMint: string, pnlPercent: number, refCode: string | undefined): Promise<Buffer> {
    const width = 850;
    const height = 450;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 24) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += 24) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    const isProfit = pnlPercent >= 0;
    const themeColor = isProfit ? '#10b981' : '#ef4444'; 
    const sign = isProfit ? '+' : '';
    const label = isProfit ? 'PROFIT SECURED' : 'STOP LOSS TRIGGERED';

    ctx.fillStyle = '#121826';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    drawRoundRect(ctx, 40, 40, width - 80, height - 80, 16);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    drawRoundRect(ctx, 75, 75, 46, 46, 12);
    ctx.fill();

    ctx.fillStyle = '#0a0d14'; 
    ctx.beginPath();
    ctx.moveTo(103, 85);
    ctx.lineTo(91, 101);
    ctx.lineTo(100, 101);
    ctx.lineTo(95, 113);
    ctx.lineTo(110, 95);
    ctx.lineTo(100, 95);
    ctx.closePath();
    ctx.fill();

    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(botName, 135, 108);

    ctx.font = '500 20px monospace';
    ctx.fillStyle = '#64748b'; 
    ctx.fillText(`Token: ${tokenMint.substring(0, 12)}...pump`, 75, 175);
    
    ctx.fillStyle = themeColor;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(label, 75, 210);

    ctx.font = '900 115px sans-serif';
    ctx.fillStyle = themeColor; 
    ctx.fillText(`${sign}${pnlPercent.toFixed(2)}%`, 65, 320);

    ctx.fillStyle = '#475569'; 
    ctx.font = '500 16px sans-serif';
    const supportUser = process.env.SUPPORT_USERNAME || 'sentrylead';
    const linkText = refCode 
        ? `Mirror my trades via TG with code: ${refCode}` 
        : `Powered by ${botName} on Solana | @${supportUser}`;
    ctx.fillText(linkText, 75, 395);

    ctx.fillStyle = '#0a0d14'; 
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    drawRoundRect(ctx, 610, 365, 150, 40, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('𝕏 Share to X', 638, 391);

    return canvas.toBuffer('image/png');
}

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