// src/services/reaction.service.ts
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

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
        const res = await axios.get(
            `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(keyword)}&limit=25&rating=pg-13`,
            { timeout: 3000 }
        );
        const gifs = res.data?.data;
        if (!gifs || gifs.length === 0) {
            console.warn(`⚠️ [REACTION GIF] Giphy returned 0 results for "${keyword}"`);
            return null;
        }
        const pick = gifs[Math.floor(Math.random() * gifs.length)];
        return pick.images?.original?.mp4 || pick.images?.fixed_height?.mp4 || pick.images?.downsized?.url || pick.images?.original?.url || null;
    } catch (e: any) {
        // 🟢 log the ACTUAL status code and Giphy's error body, not just the message —
        // this is what tells you "bad key" vs "wrong API type" vs "rate limited"
        console.error(`🔴 [REACTION GIF] Fetch failed. Status: ${e.response?.status}, Body: ${JSON.stringify(e.response?.data)}, Message: ${e.message}`);
        return null;
    }
}

export async function getReactionGifUrl(isWin: boolean): Promise<string | null> {
    return fetchRandomGif(isWin ? WIN_KEYWORDS : LOSS_KEYWORDS);
}