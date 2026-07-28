// src/services/reaction.service.ts
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

// Curated safe keywords for both scenarios
const WIN_KEYWORDS = ['money flex', 'making it rain cash', 'stack of cash celebration', 'success dance win', 'cash counting excited'];
const LOSS_KEYWORDS = ['keep going motivation', 'stay strong get up', 'not giving up', 'try again dust off', 'resilience comeback'];

async function fetchRandomGif(keywords: string[]): Promise<string | null> {
    if (!GIPHY_API_KEY) return null; // Silently skip if no key is configured
    try {
        const keyword = keywords[Math.floor(Math.random() * keywords.length)];
        // 🟢 rating=pg-13 guarantees no highly offensive or NSFW content is returned
        const res = await axios.get(
            `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(keyword)}&limit=25&rating=pg-13`,
            { timeout: 2500 }
        );
        const gifs = res.data?.data;
        if (!gifs || gifs.length === 0) return null;
        
        const pick = gifs[Math.floor(Math.random() * gifs.length)];
        return pick.images?.original?.url || null;
    } catch (e: any) {
        console.warn(`⚠️ [REACTION GIF] Fetch failed, skipping: ${e.message}`);
        return null;
    }
}

export async function getReactionGifUrl(isWin: boolean): Promise<string | null> {
    return fetchRandomGif(isWin ? WIN_KEYWORDS : LOSS_KEYWORDS);
}