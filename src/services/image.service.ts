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

    // 1. Dashboard Background (#0a0d14)
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, width, height);

    // 2. Dashboard Grid Overlay
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 24) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += 24) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    const isProfit = pnlPercent >= 0;
    const themeColor = isProfit ? '#10b981' : '#ef4444'; // Dashboard Green / Red
    const sign = isProfit ? '+' : '';
    const label = isProfit ? 'PROFIT SECURED' : 'STOP LOSS TRIGGERED';

    // 3. Dashboard Flat Card (#121826)
    ctx.fillStyle = '#121826';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    drawRoundRect(ctx, 40, 40, width - 80, height - 80, 16);
    ctx.fill();
    ctx.stroke();

    // 4. Logo (Green Square)
    ctx.fillStyle = '#10b981';
    drawRoundRect(ctx, 75, 75, 46, 46, 12);
    ctx.fill();

    // 5. Lightning Bolt Inside Logo
    ctx.fillStyle = '#0a0d14'; // slateDark
    ctx.beginPath();
    ctx.moveTo(103, 85);
    ctx.lineTo(91, 101);
    ctx.lineTo(100, 101);
    ctx.lineTo(95, 113);
    ctx.lineTo(110, 95);
    ctx.lineTo(100, 95);
    ctx.closePath();
    ctx.fill();

    // 6. Bot Name
    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(botName, 135, 108);

    // 7. Token Info
    ctx.font = '500 20px monospace';
    ctx.fillStyle = '#64748b'; // Slate 500
    ctx.fillText(`Token: ${tokenMint.substring(0, 12)}...pump`, 75, 175);
    
    // 8. Status Label
    ctx.fillStyle = themeColor;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(label, 75, 210);

    // 9. Massive PnL Percentage
    ctx.font = '900 115px sans-serif';
    ctx.fillStyle = themeColor; 
    ctx.fillText(`${sign}${pnlPercent.toFixed(2)}%`, 65, 320);

    // 10. Footer Link
    ctx.fillStyle = '#475569'; // Slate 600
    ctx.font = '500 16px sans-serif';
    const supportUser = process.env.SUPPORT_USERNAME || 'sentrylead';
    const linkText = refCode 
        ? `Mirror my trades via TG with code: ${refCode}` 
        : `Powered by ${botName} on Solana | @${supportUser}`;
    ctx.fillText(linkText, 75, 395);

    // 11. "Share to X" Fake UI Button
    ctx.fillStyle = '#0a0d14'; // slateDark
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    drawRoundRect(ctx, 610, 365, 150, 40, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('𝕏 Share to X', 638, 391);

    return canvas.toBuffer('image/png');
}