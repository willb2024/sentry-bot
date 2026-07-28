// src/services/reaction.service.ts
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

// Safe, non-offensive, highly entertaining search terms
const WIN_KEYWORDS = [
    'money flex', 'making it rain cash', 'stack of cash celebration', 
    'success dance win', 'cash counting excited', 'crypto profit celebration'
];

const LOSS_KEYWORDS = [
    'keep going motivation', 'stay strong get up', 'not giving up', 
    'try again dust off', 'resilience comeback', 'we will bounce back'
];

async function fetchRandomGif(keywords: string[]): Promise<string | null> {
    if (!GIPHY_API_KEY) {
        console.warn("⚠️ [REACTION GIF] GIPHY_API_KEY missing in .env!");
        return null;
    }
    
    try {
        const keyword = keywords[Math.floor(Math.random() * keywords.length)];
        // rating=pg-13 guarantees safe, clean content
        const res = await axios.get(
            `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(keyword)}&limit=25&rating=pg-13`,
            { timeout: 3000 }
        );
        const gifs = res.data?.data;
        if (!gifs || gifs.length === 0) return null;
        
        const pick = gifs[Math.floor(Math.random() * gifs.length)];
        
        // 🟢 FIX: Prefer MP4 format because Telegram's sendAnimation renders MP4 instantly!
        return pick.images?.original?.mp4 || pick.images?.fixed_height?.mp4 || pick.images?.downsized?.url || pick.images?.original?.url || null;
    } catch (e: any) {
        console.warn(`⚠️ [REACTION GIF] Fetch failed: ${e.message}`);
        return null;
    }
}

export async function getReactionGifUrl(isWin: boolean): Promise<string | null> {
    return fetchRandomGif(isWin ? WIN_KEYWORDS : LOSS_KEYWORDS);
}