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
const DEEP_PARALLEL             = 20;
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
    platform: 'telegram';
    memberCount: number;
    title: string;
    description: string;
    guildFitScore: number;
    pitchType: PitchType;
    source: string;
    hasToken: boolean;
    keywords: string[];
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
    else if (memberCount >= 100)   score += 5; // Minimum viable community

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

async function fetchKolChannelsFromDirectory(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    const searches = [
        { url: 'https://tgstat.com/en/search?q=solana+alpha+calls',        label: 'tgstat-alpha-calls'   },
        { url: 'https://tgstat.com/en/search?q=solana+gem+presale',        label: 'tgstat-gem-presale'   },
        { url: 'https://tgstat.com/en/search?q=crypto+whitelist+wl',       label: 'tgstat-whitelist'     },
        { url: 'https://tgstat.com/en/search?q=solana+kol+community',      label: 'tgstat-kol'           },
        { url: 'https://tgstat.com/en/search?q=solana+airdrop+launch',     label: 'tgstat-launch'        },
        { url: 'https://commbot.ru/en/search?q=solana+alpha',              label: 'commbot-alpha'        },
    ];

    for (const search of searches) {
        try {
            const res = await axios.get(search.url, { headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 10000 });
            const html: string = res.data;

            const linkRegex   = /href="(https:\/\/t\.me\/[a-zA-Z0-9_]+)"/g;
            const memberRegex = /(\d[\d\s,]+)\s*(members?|subscribers?)/gi;
            const titleRegex  = /title="([^"]{3,80})"/g;
            const descRegex   = /<p[^>]*class="[^"]*description[^"]*"[^>]*>([^<]{10,300})<\/p>/gi;

            const links: string[] = [];
            let m;
            while ((m = linkRegex.exec(html)) !== null) {
                if (!m[1].includes('/s/') && !m[1].includes('/+')) links.push(m[1]);
            }

            const memberCounts: number[] = [];
            while ((m = memberRegex.exec(html)) !== null) memberCounts.push(parseInt(m[1].replace(/[\s,]/g, ''), 10));

            const titles: string[] = [];
            while ((m = titleRegex.exec(html)) !== null) titles.push(m[1]);

            const descriptions: string[] = [];
            while ((m = descRegex.exec(html)) !== null) descriptions.push(m[1]);

            for (let i = 0; i < links.length; i++) {
                const url         = links[i];
                const memberCount = memberCounts[i] || 0;
                const title       = titles[i] || url;
                const description = descriptions[i] || title;

                const { score, pitchType, keywords } = scoreGuildFit(memberCount, description, false);
                if (score < MIN_GUILD_FIT_SCORE) continue;

                leads.push({
                    url, platform: 'telegram', memberCount, title, description,
                    guildFitScore: score, pitchType, source: search.label,
                    hasToken: false, keywords
                });
            }
            await SLEEP(1500);
        } catch (e: any) { }
    }
    return leads;
}

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

            for (const link of links) {
                const url: string = link.url || '';
                if (!url || !url.includes('t.me/')) continue;

                const { score, pitchType, keywords } = scoreGuildFit(0, description + ' launch token presale solana', true);
                leads.push({
                    url, platform: 'telegram', memberCount: 0, title: `$${token.symbol || 'UNKNOWN'} (Boosted)`, description,
                    guildFitScore: Math.min(100, score + 20), pitchType: 'PROJECT_OWNER', source: 'dexscreener-boost', hasToken: true, keywords: [...keywords, 'paid-boost']
                });
            }
        }
    } catch (e: any) { }
    return leads;
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

async function enrichMemberCount(lead: GuildLead): Promise<number> {
    if (lead.memberCount > 0) return lead.memberCount;
    try {
        const res = await axios.get(lead.url, { headers: { 'User-Agent': randomUA() }, timeout: 6000 });
        const html: string = res.data;

        const memberMatch = html.match(/([\d\s,]+)\s+(members|subscribers)/i);
        if (memberMatch?.[1]) {
            const n = parseInt(memberMatch[1].replace(/[, ]/g, ''), 10);
            if (n > 0) return n;
        }

        const onlineMatch = html.match(/([\d\s,]+)\s+online/i);
        if (onlineMatch?.[1]) {
            const n = parseInt(onlineMatch[1].replace(/[, ]/g, ''), 10);
            if (n > 0) return n;
        }
    } catch { }
    return 0;
}

async function qualifyLead(lead: GuildLead): Promise<{ qualifies: boolean; memberCount: number }> {
    if (lead.guildFitScore < MIN_GUILD_FIT_SCORE) return { qualifies: false, memberCount: lead.memberCount };
    const memberCount = await enrichMemberCount(lead);
    
    // 🟢 ENFORCES 100+ MEMBERS
    if (memberCount < MIN_MEMBERS_FOR_GUILD) return { qualifies: false, memberCount };
    return { qualifies: true, memberCount };
}

// ─── EXECUTION ────────────────────────────────────────────────────────────────

export async function runGuildLeadScraper(bot: any, adminId: string): Promise<string> {
    const cancelKey = `state:guild_lead_scraper:${adminId}`;
    try {
        await redis.set(cancelKey, 'RUNNING', 'EX', 3600);
        
        const [dirLeads, boostedLeads] = await Promise.all([
            fetchKolChannelsFromDirectory(),
            fetchBoostedTokenKols(),
        ]);

        const allLeads = [...dirLeads, ...boostedLeads];
        const seenUrls = new Set<string>();
        const candidates = allLeads
            .filter(l => { if (seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; })
            .filter(l => l.guildFitScore >= MIN_GUILD_FIT_SCORE)
            .sort((a, b) => b.guildFitScore - a.guildFitScore);

        let sent = 0;
        let rejected = 0;

        for (const lead of candidates) {
            if (await isAlreadyContacted(lead.url)) continue;

            const { qualifies, memberCount } = await qualifyLead(lead);

            if (!qualifies) {
                rejected++;
                continue;
            }

            await markContacted(lead.url);
            sent++;
            
            const message = 
                `🔥 <b>KOL FOUND #${sent}</b>\n\n` +
                `<b>Target:</b> ${lead.title}\n` +
                `<b>Members:</b> 👥 ${memberCount.toLocaleString()} verified\n` +
                `<b>Source:</b> <code>${lead.source}</code>\n\n` +
                `<b>Quality Score:</b> ${lead.guildFitScore}/100 ⭐\n` +
                `<b>Type:</b> ${lead.pitchType}\n\n` +
                `🔗 <b>Link:</b> ${lead.url}`;

            await bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => null);
            await SLEEP(300);
        }

        if (sent === 0) return `🟡 Scan complete. No uncontacted groups with ${MIN_MEMBERS_FOR_GUILD}+ members found.`;
        
        return `✅ <b>KOL Finder Complete!</b>\nDelivered <b>${sent}</b> highly qualified groups (100+ members) to your DM.\n<i>Skipped ${rejected} groups that were too small.</i>`;
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
        await bot.telegram.sendMessage(adminId, `🏰 <b>Auto KOL Scan</b>\n${result}`, { parse_mode: 'HTML' }).catch(() => null);
    };
    runIfIdle();
    setInterval(runIfIdle, 45 * 60 * 1000); // Runs every 45 mins automatically
}