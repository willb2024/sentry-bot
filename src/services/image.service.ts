// src/services/image.service.ts
import { createCanvas } from '@napi-rs/canvas';
import dotenv from 'dotenv';

dotenv.config();

export async function generatePnlCard(tokenMint: string, pnlPercent: number, refCode: string | undefined): Promise<Buffer> {
    const width = 800;
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Dark Background
    ctx.fillStyle = '#0f172a'; // Deep slate
    ctx.fillRect(0, 0, width, height);

    // Determine Profit or Loss Styling
    const isProfit = pnlPercent >= 0;
    const color = isProfit ? '#22c55e' : '#ef4444'; // Neon Green or Red
    const sign = isProfit ? '+' : '';
    const label = isProfit ? 'PROFIT SECURED' : 'STOP LOSS TRIGGERED';

    // Top Header
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 45px Arial';
    
    // Dynamic Bot Name & Emoji
    const botName = process.env.BOT_NAME || 'Sentry Terminal';
    const botEmoji = process.env.BOT_EMOJI || '⚡';
    ctx.fillText(`${botEmoji} ${botName.toUpperCase()}`, 40, 70);

    // Token & Status
    ctx.font = '28px Arial';
    ctx.fillStyle = '#9ca3af';
    ctx.fillText(`Token: ${tokenMint.substring(0, 8)}...${tokenMint.substring(tokenMint.length - 4)}`, 40, 140);
    
    ctx.fillStyle = color;
    ctx.font = 'bold 24px Arial';
    ctx.fillText(label, 40, 180);

    // Massive PnL Percentage
    ctx.font = 'bold 110px Arial';
    ctx.fillStyle = color;
    ctx.fillText(`${sign}${pnlPercent.toFixed(2)}%`, 35, 290);

    // Affiliate Link at the bottom
    ctx.fillStyle = '#3b82f6'; // Blue
    ctx.font = '22px Arial';
    
    // Dynamic Support Username
    const supportUser = process.env.SUPPORT_USERNAME || 'sentrylead';
    const linkText = refCode 
        ? `Mirror my trades & get 10% off fees with code: ${refCode}` 
        : `Powered by ${botName} on Solana | @${supportUser}`;
        
    ctx.fillText(linkText, 40, 360);

    // Top Right Decorative Accent
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(700, 70, 20, 0, Math.PI * 2);
    ctx.fill();

    return canvas.toBuffer('image/png');
}