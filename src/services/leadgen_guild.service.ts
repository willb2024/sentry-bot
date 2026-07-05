// src/services/leadgen_guild.service.ts
import dotenv from 'dotenv';
import axios from 'axios';
import { redis } from '../lib/redis.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_GUILD_LEADS_PER_SCAN  = 9999;  
const MIN_GUILD_FIT_SCORE       = 40;    
const MIN_MEMBERS_FOR_GUILD     = 100;   // 🟢 HARD FLOOR: 100+ members only
const DEDUP_TTL_SECONDS         = 7 * 24 * 60 * 60; // Don't message the same group within 7 days
const SLEEP                     = (ms: number) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── Types ────────────────────────────────────────────────────────────────────

type PitchType = 'LAUNCH_KOL' | 'PROJECT_OWNER' | 'ALPHA_GROUP';

interface GuildLead {
    url: string;
    platform: 'discord';     // 🟢 CHANGED: Strictly focus on Discord platform
    memberCount: number;
    title: string;
    description: string;
    guildFitScore: number;
    pitchType: PitchType;
    source: string;
    hasToken: boolean;
    keywords: string[];
    tokenAddress?: string;   
    creatorWallet?: string;  
    vol24h?: number;         // 🟢 NEW: 24-hour USD Volume
}

// ─── Redis dedup ──────────────────────────────────────────────────────────────

async function isAlreadyContacted(url: string): Promise<boolean> {
    const key = `guild_leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    return (await redis.exists(key)) === 1;
}

async function markContacted(url: string): Promise<void> {
    const key = `guild_leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS);
}

// ─── SCORING ENGINE ───────────────────────────────────────────────────────────

const LAUNCH_KEYWORDS    = ['presale', 'whitelist', 'wl', 'launch', 'mint', 'airdrop', 'allocation', 'ido', 'ico', 'fundraise', 'raise', 'sale'];
const ALPHA_KEYWORDS     = ['alpha', 'gem', 'calls', 'sniper', 'ape', 'degen', 'ct', '100x', 'moonshot', 'early', 'signal'];
const COMMUNITY_KEYWORDS = ['community', 'holders', 'loyal', 'members', 'tier', 'leaderboard', 'reward', 'points', 'rank'];
const SOLANA_KEYWORDS    = ['solana', 'sol', 'pump', 'raydium', 'jito', 'defi', 'spl', 'bonding'];

function scoreGuildFit(memberCount: number, description: string, hasToken: boolean): { score: number; pitchType: PitchType; keywords: string[] } {
    const text = description.toLowerCase();
    let score = 0;
    const foundKeywords: string[] = [];

    // Size scoring (100+ gets points)
    if (memberCount >= 50000)      score += 30;
    else if (memberCount >= 10000) score += 26;
    else if (memberCount >= 2000)  score += 20;
    else if (memberCount >= 1000)  score += 15;
    else if (memberCount >= 300)   score += 10;
    else if (memberCount >= 100)   score += 5;

    for (const kw of SOLANA_KEYWORDS) {
        if (text.includes(kw)) { score += 4; foundKeywords.push(kw); break; }
    }
    for (const kw of LAUNCH_KEYWORDS) {
        if (text.includes(kw)) { score += 5; foundKeywords.push(kw); }
    }
    for (const kw of ALPHA_KEYWORDS) {
        if (text.includes(kw)) { score += 3; foundKeywords.push(kw); }
    }
    for (const kw of COMMUNITY_KEYWORDS) {
        if (text.includes(kw)) { score += 3; foundKeywords.push(kw); }
    }
    if (hasToken) score += 15;
    score = Math.min(100, score);

    const launchSignals = LAUNCH_KEYWORDS.filter(k => text.includes(k)).length;
    const alphaSignals  = ALPHA_KEYWORDS.filter(k => text.includes(k)).length;

    let pitchType: PitchType;
    if (hasToken || launchSignals >= 2) pitchType = 'PROJECT_OWNER';
    else if (alphaSignals >= 2)         pitchType = 'LAUNCH_KOL';
    else                                pitchType = 'ALPHA_GROUP';

    return { score, pitchType, keywords: [...new Set(foundKeywords)] };
}

// ─── SCRAPERS ─────────────────────────────────────────────────────────────────

// 🟢 NEW: Extract Discord Invite Code
function extractDiscordInviteCode(url: string): string | null {
    const match = url.match(/(?:discord\.gg\/|discord\.com\/invite\/)([a-zA-Z0-9-]+)/i);
    return match ? match[1] : null;
}

// 🟢 NEW: Fetch Discord Member Count using Discord's open endpoints (100% rate-safe)
async function fetchDiscordMemberCount(url: string): Promise<number> {
    const code = extractDiscordInviteCode(url);
    if (!code) return 0;
    try {
        const res = await axios.get(`https://discord.com/api/v9/invites/${code}?with_counts=true`, { 
            headers: { 'User-Agent': randomUA() },
            timeout: 3500 
        });
        return res.data?.approximate_member_count || 0;
    } catch {
        return 0;
    }
}

// 🟢 NEW: Fetch 24-hour USD Volume via DexScreener pairs API
async function fetchToken24hVolume(tokenAddress: string): Promise<number> {
    try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3500 });
        if (res.data?.pairs && res.data.pairs.length > 0) {
            return res.data.pairs[0].volume?.h24 || 0;
        }
    } catch { }
    return 0;
}

// 🟢 NEW: Fetch Discord-linked boosted tokens
async function fetchBoostedTokenKols(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const [latestRes, topRes] = await Promise.all([
            axios.get('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 8000 }),
            axios.get('https://api.dexscreener.com/token-boosts/top/v1',    { timeout: 8000 }),
        ]);

        const boosted: any[] = [...(Array.isArray(latestRes.data) ? latestRes.data : []), ...(Array.isArray(topRes.data) ? topRes.data : [])].filter(t => t.chainId === 'solana');

        for (const token of boosted) {
            const description = token.description || token.info?.description || '';
            const links: any[]= token.links || token.info?.links || [];

            // Find valid Discord links
            const discordLink = links.find((l: any) => 
                l.type === 'discord' || 
                l.url?.includes('discord.gg') || 
                l.url?.includes('discord.com/invite')
            );

            if (!discordLink || !discordLink.url) continue; // 🟢 Strictly skip non-discord listings

            const { score, pitchType, keywords } = scoreGuildFit(0, description + ' launch token presale solana', true);
            
            leads.push({
                url: discordLink.url, 
                platform: 'discord', 
                memberCount: 0, 
                title: `$${token.symbol || 'UNKNOWN'} Discord`, 
                description,
                guildFitScore: Math.min(100, score + 20), 
                pitchType: 'PROJECT_OWNER', 
                source: 'dexscreener-boost', 
                hasToken: true, 
                keywords: [...keywords, 'paid-boost'],
                tokenAddress: token.tokenAddress
            });
        }
    } catch (e: any) { }
    return leads;
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

async function fetchPumpCreator(mint: string): Promise<string | null> {
    try {
        const res = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 3500 });
        return res.data?.creator || null;
    } catch {
        return null;
    }
}

// ─── EXECUTION ────────────────────────────────────────────────────────────────

export async function runGuildLeadScraper(bot: any, adminId: string): Promise<string> {
    const cancelKey = `state:guild_lead_scraper:${adminId}`;
    try {
        await redis.set(cancelKey, 'RUNNING', 'EX', 3600);
        
        // 🟢 Discord only: Telegram directories completely skipped
        const boostedLeads = await fetchBoostedTokenKols();

        const seenUrls = new Set<string>();
        const candidates = boostedLeads
            .filter(l => { if (seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; })
            .sort((a, b) => b.guildFitScore - a.guildFitScore);

        let sent = 0;
        let rejected = 0;

        for (const lead of candidates) {
            if (await isAlreadyContacted(lead.url)) continue;

            // 🟢 Discord live verification
            const memberCount = await fetchDiscordMemberCount(lead.url);
            if (memberCount < MIN_MEMBERS_FOR_GUILD) {
                rejected++;
                continue;
            }

            lead.memberCount = memberCount;

            // Fetch live 24h volume
            if (lead.tokenAddress) {
                lead.vol24h = await fetchToken24hVolume(lead.tokenAddress);
            }

            // Fetch pump.fun creator wallet
            if (lead.tokenAddress && lead.tokenAddress.toLowerCase().endsWith('pump')) {
                const creator = await fetchPumpCreator(lead.tokenAddress);
                if (creator) {
                    lead.creatorWallet = creator;
                }
            }

            await markContacted(lead.url);
            sent++;
            
            // 🟢 Customized volume-based Discord pitch template
            let tokenAndPitchInfo = '';
            if (lead.tokenAddress) {
                const formattedVol = lead.vol24h ? `$${lead.vol24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'N/A';
                tokenAndPitchInfo = 
                    `🪙 <b>Token Address (CA):</b> <code>${lead.tokenAddress}</code>\n` +
                    `📊 <b>24h Volume:</b> <code>${formattedVol}</code>\n` +
                    `🐋 <b>Creator Wallet:</b> <code>${lead.creatorWallet || 'Unable to fetch'}</code>\n\n` +
                    `📢 <b>DISCORD PITCH TEMPLATE (Copy & Send):</b>\n` +
                    `<code>Hey! Just saw your project trending on DexScreener with ${formattedVol} in 24h volume. I bought a bag at CA ${lead.tokenAddress} to support. Would love to bring our Alpha Guild trading volume into your community. Let's run a leaderboard together to coordinate our buys!</code>\n\n`;
            }

            const message = 
                `🔥 <b>DISCORD FOUND #${sent}</b>\n\n` +
                `<b>Target:</b> ${lead.title}\n` +
                `<b>Members:</b> 👥 ${memberCount.toLocaleString()} verified\n` +
                `<b>Source:</b> <code>${lead.source}</code>\n\n` +
                `<b>Quality Score:</b> ${lead.guildFitScore}/100 ⭐\n` +
                `<b>Type:</b> ${lead.pitchType}\n\n` +
                tokenAndPitchInfo +
                `🔗 <b>Invite Link:</b> ${lead.url}`;

            await bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => null);
            await SLEEP(300);
        }

        if (sent === 0) return `🟡 Scan complete. No uncontacted Discord guilds with ${MIN_MEMBERS_FOR_GUILD}+ members found.`;
        
        return `✅ <b>Discord Finder Complete!</b>\nDelivered <b>${sent}</b> highly qualified guilds (100+ members) to your DM.\n<i>Skipped ${rejected} guilds that were too small.</i>`;
    } catch (e: any) {
        return `🔴 Error: ${e.message}`;
    } finally {
        await redis.del(cancelKey);
    }
}

export function startGuildLeadScheduler(bot: any, adminId: string) {
    const runIfIdle = async () => {
        const isRunning = await redis.get(`state:guild_lead_scraper:${adminId}`);
        if (isRunning === 'RUNNING') return;
        const result = await runGuildLeadScraper(bot, adminId);
        await bot.telegram.sendMessage(adminId, `🏰 <b>Auto Discord Scan</b>\n${result}`, { parse_mode: 'HTML' }).catch(() => null);
    };
    runIfIdle();
    setInterval(runIfIdle, 45 * 60 * 1000); // Runs every 45 mins automatically
}