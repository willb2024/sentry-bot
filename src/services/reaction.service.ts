import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

const WIN_KEYWORDS = ['money flex', 'making it rain cash', 'success dance'];
const LOSS_KEYWORDS = ['keep going motivation', 'stay strong get up', 'resilience'];

// Reliable fallbacks
const FALLBACK_WIN_URL = 'https://media.giphy.com/media/67ThRZlYBzybBc19T5/giphy.mp4';
const FALLBACK_LOSS_URL = 'https://media.giphy.com/media/11MjL4wE1s8zG8/giphy.mp4';

async function fetchRandomGif(keywords: string[]): Promise<string | null> {
    if (!GIPHY_API_KEY) {
        console.warn("⚠️ [REACTION GIF] GIPHY_API_KEY missing. Using fallback.");
        return null;
    }
    try {
        const keyword = keywords[Math.floor(Math.random() * keywords.length)];
        const res = await axios.get(
            `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(keyword)}&limit=25&rating=pg-13`,
            { timeout: 3000 }
        );
        const gifs = res.data?.data;
        if (!gifs || gifs.length === 0) return null;
        
        const pick = gifs[Math.floor(Math.random() * gifs.length)];
        return pick.images?.original?.mp4 || pick.images?.fixed_height?.mp4 || pick.images?.downsized?.url || null;
    } catch (e: any) {
        console.error(`🔴 [REACTION GIF] Fetch failed: ${e.message}`);
        return null;
    }
}

export async function getReactionGifUrl(isWin: boolean): Promise<string | null> {
    const url = await fetchRandomGif(isWin ? WIN_KEYWORDS : LOSS_KEYWORDS);
    return url || (isWin ? FALLBACK_WIN_URL : FALLBACK_LOSS_URL);
}