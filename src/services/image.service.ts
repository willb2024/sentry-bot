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
    const width = 900;
    const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Cool Color Gradient Background (Deep Purple -> Dark Slate -> Pitch Black)
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#1e003b'); // Deep Purple
    bgGrad.addColorStop(0.5, '#0f172a'); // Dark Slate
    bgGrad.addColorStop(1, '#020617'); // Pitch Black
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    const isProfit = pnlPercent >= 0;
    const themeColor = isProfit ? '#10b981' : '#f43f5e'; // Emerald Green vs Rose Red
    const sign = isProfit ? '+' : '';
    const label = isProfit ? 'PROFIT SECURED' : 'STOP LOSS TRIGGERED';

    // 2. Glowing Background Orbs
    ctx.shadowBlur = 150;
    ctx.shadowColor = themeColor;
    ctx.fillStyle = themeColor;
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    ctx.arc(200, 150, 100, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(700, 350, 120, 0, Math.PI * 2);
    ctx.fill();
    
    // Reset shadow & alpha for the main glass card
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;

    // 3. Glassmorphic Panel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 2;
    drawRoundRect(ctx, 40, 40, 820, 420, 24);
    ctx.fill();
    ctx.stroke();

    // 4. Emoji Shield & Bot Name (Universal sans-serif font)
    ctx.font = '40px sans-serif';
    ctx.fillText('🛡️', 70, 110);

    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(botName.toUpperCase(), 130, 105);

    // 5. Token Info & Status
    ctx.font = '500 24px sans-serif';
    ctx.fillStyle = '#94a3b8'; // Slate 400
    ctx.fillText(`Token: ${tokenMint.substring(0, 8)}...${tokenMint.substring(tokenMint.length - 4)}`, 75, 180);
    
    ctx.fillStyle = themeColor;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(label, 75, 225);

    // 6. Massive PnL Percentage (Shadow for Pop)
    ctx.font = 'bold 130px sans-serif';
    ctx.fillStyle = '#ffffff'; 
    ctx.shadowBlur = 25;
    ctx.shadowColor = themeColor;
    ctx.fillText(`${sign}${pnlPercent.toFixed(2)}%`, 65, 340);
    ctx.shadowBlur = 0; 

    // 7. Footer Link
    ctx.fillStyle = '#64748b'; // Slate 500
    ctx.font = 'bold 18px sans-serif';
    const supportUser = process.env.SUPPORT_USERNAME || 'sentrylead';
    const linkText = refCode 
        ? `Mirror my trades via TG with code: ${refCode}` 
        : `Powered by ${botName} on Solana | @${supportUser}`;
    ctx.fillText(linkText, 75, 425);

    // 8. "Share to X" Button Design
    ctx.fillStyle = '#000000'; // Black X button
    drawRoundRect(ctx, 670, 390, 150, 40, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.stroke();
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('𝕏 Share to X', 695, 416);

    return canvas.toBuffer('image/png');
}