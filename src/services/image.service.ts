// src/services/image.service.ts
import { createCanvas } from '@napi-rs/canvas';
import dotenv from 'dotenv';

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

    // 1. Base Background (Deep Space / Dark Slate)
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#020617'); // Slate 950
    bgGrad.addColorStop(1, '#0f172a'); // Slate 900
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    const isProfit = pnlPercent >= 0;
    const themeColor = isProfit ? '#10b981' : '#f43f5e'; // Emerald Green vs Rose Red
    const sign = isProfit ? '+' : '';
    const label = isProfit ? 'PROFIT SECURED' : 'STOP LOSS TRIGGERED';

    // 2. Glowing Orbs (Behind the glass)
    ctx.shadowBlur = 120;
    ctx.shadowColor = themeColor;
    ctx.fillStyle = themeColor;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.arc(150, 100, 80, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(750, 350, 120, 0, Math.PI * 2);
    ctx.fill();
    
    // Reset shadow & alpha for the main card
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;

    // 3. The Glassmorphic Panel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, 40, 40, 770, 370, 24);
    ctx.fill();
    ctx.stroke();

    // 4. Draw Logo (Shield with Lightning)
    ctx.save();
    ctx.translate(80, 75);
    ctx.fillStyle = themeColor;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(40, 10);
    ctx.lineTo(40, 30);
    ctx.lineTo(20, 45);
    ctx.lineTo(0, 30);
    ctx.lineTo(0, 10);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#020617'; // Cutout lightning
    ctx.beginPath();
    ctx.moveTo(22, 10);
    ctx.lineTo(12, 25);
    ctx.lineTo(22, 25);
    ctx.lineTo(18, 38);
    ctx.lineTo(30, 20);
    ctx.lineTo(20, 20);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 5. App Name & Title
    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(botName.toUpperCase(), 140, 108);

    // 6. Token Info & Status
    ctx.font = 'bold 24px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#94a3b8'; // Slate 400
    ctx.fillText(`Token: ${tokenMint.substring(0, 8)}...${tokenMint.substring(tokenMint.length - 4)}`, 80, 180);
    
    ctx.fillStyle = themeColor;
    ctx.font = 'bold 22px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(label, 80, 220);

    // 7. Massive PnL Percentage
    ctx.font = '900 120px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#ffffff'; // White text for huge contrast
    ctx.shadowBlur = 30;
    ctx.shadowColor = themeColor; // Glow matches profit/loss
    ctx.fillText(`${sign}${pnlPercent.toFixed(2)}%`, 75, 330);
    ctx.shadowBlur = 0; // reset

    // 8. Bottom Footer (Affiliate & X Badge)
    ctx.fillStyle = '#64748b'; // Slate 500
    ctx.font = '18px "Helvetica Neue", Arial, sans-serif';
    const supportUser = process.env.SUPPORT_USERNAME || 'sentrylead';
    const linkText = refCode 
        ? `Mirror my trades via TG with code: ${refCode}` 
        : `Powered by ${botName} on Solana | @${supportUser}`;
    ctx.fillText(linkText, 80, 385);

    // "Share to X" Fake UI Button element
    ctx.fillStyle = '#1da1f2'; // Twitter Blue
    drawRoundRect(ctx, 630, 355, 140, 36, 18);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('Share to X', 660, 379);

    return canvas.toBuffer('image/png');
}