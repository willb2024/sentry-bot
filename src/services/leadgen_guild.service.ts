// src/services/leadgen_guild.service.ts
import dotenv from 'dotenv';
import axios from 'axios';
import { redis } from '../lib/redis.js';

dotenv.config();

const MAX_GUILD_LEADS_PER_SCAN  = 9999;  
const MIN_GUILD_FIT_SCORE       = 45;    
const MIN_MEMBERS_FOR_GUILD     = 300;   
const DEDUP_TTL_SECONDS         = 7 * 24 * 60 * 60;
const DEEP_PARALLEL             = 20;
const SLEEP                     = (ms: number) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

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

async function isAlreadyContacted(url: string): Promise<boolean> {
    const key = `guild_leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    return (await redis.exists(key)) === 1;
}

async function markContacted(url: string): Promise<void> {
    const key = `guild_leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS);
}

const LAUNCH_KEYWORDS    = ['presale', 'whitelist', 'wl', 'launch', 'mint', 'airdrop', 'allocation', 'ido', 'ico', 'fundraise', 'raise', 'sale'];
const ALPHA_KEYWORDS     = ['alpha', 'gem', 'calls', 'sniper', 'ape', 'degen', 'ct', '100x', 'moonshot', 'early', 'signal'];
const COMMUNITY_KEYWORDS = ['community', 'holders', 'loyal', 'members', 'tier', 'leaderboard', 'reward', 'points', 'rank'];
const SOLANA_KEYWORDS    = ['solana', 'sol', 'pump', 'raydium', 'jito', 'defi', 'spl', 'bonding'];

function scoreGuildFit(
    memberCount: number,
    description: string,
    hasToken: boolean
): { score: number; pitchType: PitchType; keywords: string[] } {
    const text = description.toLowerCase();
    let score = 0;
    const foundKeywords: string[] = [];

    if (memberCount >= 50000)      score += 30;
    else if (memberCount >= 10000) score += 26;
    else if (memberCount >= 2000)  score += 20;
    else if (memberCount >= 1000)  score += 15;
    else if (memberCount >= 300)   score += 10;

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

async function fetchKolChannelsFromDirectory(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];

    const searches = [
        { url: 'https://tgstat.com/en/search?q=solana+alpha+calls',        label: 'tgstat-alpha-calls'   },
        { url: 'https://tgstat.com/en/search?q=solana+gem+presale',        label: 'tgstat-gem-presale'   },
        { url: 'https://tgstat.com/en/search?q=crypto+whitelist+wl',       label: 'tgstat-whitelist'     },
        { url: 'https://tgstat.com/en/search?q=solana+kol+community',      label: 'tgstat-kol'           },
        { url: 'https://tgstat.com/en/search?q=solana+airdrop+launch',     label: 'tgstat-launch'        },
        { url: 'https://tgstat.com/en/search?q=solana+trading+signals',    label: 'tgstat-signals'       },
        { url: 'https://tgstat.com/en/search?q=crypto+degen+alpha',        label: 'tgstat-degen'         },
        { url: 'https://tgstat.com/en/search?q=solana+sniper+bot',         label: 'tgstat-sniper'        },
        { url: 'https://tgstat.com/en/search?q=pump+fun+calls+gems',       label: 'tgstat-pumpfun'       },
        { url: 'https://tgstat.com/en/search?q=sol+moonshot+100x',         label: 'tgstat-moonshot'      },
        { url: 'https://tgstat.com/en/search?q=solana+token+launch+ido',   label: 'tgstat-ido'           },
        { url: 'https://tgstat.com/en/search?q=crypto+nft+solana+mint',    label: 'tgstat-nft-mint'      },
        { url: 'https://commbot.ru/en/search?q=solana+alpha',              label: 'commbot-alpha'        },
        { url: 'https://commbot.ru/en/search?q=solana+trading',            label: 'commbot-trading'      },
    ];

    for (const search of searches) {
        try {
            const res = await axios.get(search.url, {
                headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
                timeout: 10000
            });
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
            while ((m = memberRegex.exec(html)) !== null) {
                memberCounts.push(parseInt(m[1].replace(/[\s,]/g, ''), 10));
            }

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
        } catch (e: any) {
            // 🟢 SILENCE LOGGING FIX: Do not spam console with expected Cloudflare 403 blocks or ENOTFOUND errors
            if (e.response?.status !== 403 && e.code !== 'ENOTFOUND') {
                console.warn(`⚠️ [GUILD-LEAD] ${search.label} failed: ${e.message}`);
            }
        }
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

        const boosted: any[] = [
            ...(Array.isArray(latestRes.data) ? latestRes.data : []),
            ...(Array.isArray(topRes.data)    ? topRes.data    : []),
        ].filter(t => t.chainId === 'solana');

        for (const token of boosted) {
            const description = token.description || token.info?.description || '';
            const links: any[]= token.links || token.info?.links || [];

            for (const link of links) {
                const url: string = link.url || '';
                if (!url) continue;

                if (!url.includes('t.me/')) continue;

                const { score, pitchType, keywords } = scoreGuildFit(
                    0,
                    description + ' launch token presale solana',
                    true
                );

                leads.push({
                    url, platform: 'telegram', memberCount: 0,
                    title: `$${token.symbol || 'UNKNOWN'} (Boosted)`,
                    description,
                    guildFitScore: Math.min(100, score + 20), 
                    pitchType: 'PROJECT_OWNER',
                    source: 'dexscreener-boost',
                    hasToken: true,
                    keywords: [...keywords, 'paid-boost']
                });
            }
        }
    } catch (e: any) {
        console.warn(`⚠️ [GUILD-LEAD] DexScreener boost: ${e.message}`);
    }
    return leads;
}

async function fetchPumpKothKols(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://frontend-api.pump.fun/coins/king-of-the-hill?offset=0&limit=50&includeNsfw=false',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        const coins: any[] = Array.isArray(res.data) ? res.data : [];

        for (const coin of coins) {
            const tg   = coin.telegram;
            const desc = coin.description || '';
            const name = coin.name || coin.symbol || 'Unknown';

            if (!tg) continue;
            const url = typeof tg === 'string' && tg.startsWith('http') ? tg : `https://t.me/${tg}`;
            if (!url.includes('t.me/')) continue;

            const { score, pitchType, keywords } = scoreGuildFit(
                coin.reply_count ? coin.reply_count * 5 : 0,
                desc + ' community token launch solana koth',
                true
            );

            leads.push({
                url,
                platform: 'telegram',
                memberCount: 0,
                title: `${name} (KotH Survivor)`,
                description: desc,
                guildFitScore: Math.min(100, score + 15),
                pitchType: 'PROJECT_OWNER',
                source: 'pump-koth',
                hasToken: true,
                keywords: [...keywords, 'koth-survivor']
            });
        }
    } catch (e: any) {
        console.warn(`⚠️ [GUILD-LEAD] Pump KotH: ${e.message}`);
    }
    return leads;
}

async function fetchPumpGraduates(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        const coins: any[] = Array.isArray(res.data) ? res.data : [];

        for (const coin of coins) {
            if (!coin.telegram) continue;
            const url = coin.telegram.startsWith('http') ? coin.telegram : `https://t.me/${coin.telegram}`;
            if (!url.includes('t.me/') || url.length < 10) continue;

            const { score, pitchType, keywords } = scoreGuildFit(
                0, (coin.description || '') + ' graduated launch token solana community', true
            );

            leads.push({
                url,
                platform: 'telegram',
                memberCount: 0,
                title: `${coin.name || 'Unknown'} (Pump Graduate 🎓)`,
                description: coin.description || '',
                guildFitScore: Math.min(100, score + 20), 
                pitchType: 'PROJECT_OWNER',
                source: 'pump-graduate',
                hasToken: true,
                keywords: [...keywords, 'pump-graduate']
            });
        }
    } catch (e: any) {
        console.warn(`⚠️ [GUILD-LEAD] Pump Graduates: ${e.message}`);
    }
    return leads;
}

async function fetchHighHolderTokenKols(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://public-api.birdeye.so/defi/tokenlist?sort_by=holder&sort_type=desc&offset=0&limit=50&min_holder=500',
            { headers: { 'User-Agent': randomUA(), 'x-chain': 'solana' }, timeout: 8000 }
        );
        const tokens: any[] = res.data?.data?.tokens || [];

        for (let i = 0; i < tokens.length; i += DEEP_PARALLEL) {
            const chunk = tokens.slice(i, i + DEEP_PARALLEL);
            await Promise.all(chunk.map(async (token: any) => {
                try {
                    const profile = await axios.get(
                        `https://api.dexscreener.com/token-profiles/v1/solana/${token.address}`,
                        { timeout: 5000 }
                    );
                    const links = profile.data?.links || [];
                    const desc  = profile.data?.description || '';

                    for (const link of links) {
                        const url: string = link.url || '';
                        if (!url.includes('t.me/')) return;

                        const { score, pitchType, keywords } = scoreGuildFit(
                            token.holder || 0, desc + ' community holders solana', true
                        );
                        if (score < MIN_GUILD_FIT_SCORE) return;

                        leads.push({
                            url,
                            platform: 'telegram',
                            memberCount: 0,
                            title: `${token.symbol || '?'} (${(token.holder || 0).toLocaleString()} holders)`,
                            description: desc,
                            guildFitScore: score,
                            pitchType, source: 'birdeye-high-holders',
                            hasToken: true, keywords
                        });
                    }
                } catch { }
            }));
            await SLEEP(200);
        }
    } catch (e: any) {
        console.warn(`⚠️ [GUILD-LEAD] Birdeye: ${e.message}`);
    }
    return leads;
}

async function fetchNewSolanaPairKols(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://api.dexscreener.com/token-profiles/latest/v1',
            { timeout: 8000 }
        );
        const profiles: any[] = Array.isArray(res.data) ? res.data : [];
        const solanaProfiles   = profiles.filter(p => p.chainId === 'solana');

        for (const profile of solanaProfiles) {
            const links: any[] = profile.links || [];
            const desc         = profile.description || '';
            const symbol       = profile.header || profile.tokenAddress?.substring(0, 6) || 'NEW';

            for (const link of links) {
                const url: string = link.url || '';
                if (!url.includes('t.me/')) continue;

                const { score, pitchType, keywords } = scoreGuildFit(
                    0, desc + ' token launch solana new', true
                );
                if (score < MIN_GUILD_FIT_SCORE) continue;

                leads.push({
                    url,
                    platform: 'telegram',
                    memberCount: 0,
                    title: `${symbol} (New Listing)`,
                    description: desc,
                    guildFitScore: score,
                    pitchType, source: 'dexscreener-new-profiles',
                    hasToken: true, keywords
                });
            }
        }
    } catch (e: any) {
        console.warn(`⚠️ [GUILD-LEAD] DexScreener new profiles: ${e.message}`);
    }
    return leads;
}

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
    if (lead.guildFitScore < MIN_GUILD_FIT_SCORE) {
        return { qualifies: false, memberCount: lead.memberCount };
    }

    const memberCount = await enrichMemberCount(lead);

    if (memberCount < MIN_MEMBERS_FOR_GUILD) {
        return { qualifies: false, memberCount };
    }

    return { qualifies: true, memberCount };
}

const PITCH_LABELS: Record<PitchType, string> = {
    LAUNCH_KOL:    '🎙️ LAUNCH KOL — Pitch: Their community earns loyalty points every time they follow a call',
    PROJECT_OWNER: '🚀 PROJECT OWNER — Pitch: Replace their manual WL form with an on-chain verifiable leaderboard',
    ALPHA_GROUP:   '⚡ ALPHA GROUP — Pitch: Internal trading leaderboard to drive member competition & retention',
};

const PITCH_OPENERS: Record<PitchType, string> = {
    LAUNCH_KOL:
        `Hey! I noticed your community is really active with calls. I built something specifically for KOLs like you.\n\n` +
        `Every time your followers trade on Sentry Terminal, they automatically earn Guild Loyalty Points based on volume. ` +
        `You get a live leaderboard and can export a ranked list of wallet addresses to reward your most loyal traders ` +
        `with airdrops, presale allocations, or WL spots — verified by on-chain volume, not Twitter engagement.\n\n` +
        `Takes 5 minutes to set up. Want me to show you how the leaderboard looks?`,

    PROJECT_OWNER:
        `Hey! I saw you launched [PROJECT/TOKEN]. I built something that solves the #1 pain point for token launches.\n\n` +
        `It's called Sentry Guilds. Your community trades on Sentry Terminal → earns Guild Loyalty Points → ` +
        `you export a ranked CSV of their Solana wallet addresses for WL allocation. ` +
        `No more airdrop farmers — only people who actually put volume in qualify.\n\n` +
        `Would this help for your next launch?`,

    ALPHA_GROUP:
        `Hey! Your group clearly has serious traders. I built a loyalty layer that tracks member trading volume ` +
        `and creates a live leaderboard — so your most active traders get recognised and rewarded.\n\n` +
        `Members compete to climb the ranks. You reward the top wallets with whatever you want. ` +
        `Drives engagement and keeps members trading actively instead of going quiet.\n\n` +
        `Want to see how it looks inside your group?`,
};

async function sendGuildLead(
    bot: any,
    adminId: string,
    leadIndex: number,
    lead: GuildLead,
    memberCount: number
): Promise<void> {
    const scoreBar   = '█'.repeat(Math.floor(lead.guildFitScore / 10)) + '░'.repeat(10 - Math.floor(lead.guildFitScore / 10));
    const sizeStr    = `✅ ${memberCount.toLocaleString()} verified members`;
    const tokenBadge = lead.hasToken ? '✅ Has Token (launcher/dev)' : '➖ No token (KOL/group)';

    const message =
        `🏰 <b>GUILD PROSPECT #${leadIndex}</b>\n\n` +
        `<b>Name:</b> ${lead.title}\n` +
        `<b>Platform:</b> ✈️ Telegram\n` +
        `<b>Community:</b> 👥 ${sizeStr}\n` +
        `<b>Token:</b> ${tokenBadge}\n` +
        `<b>Keywords:</b> ${lead.keywords.length > 0 ? lead.keywords.map(k => `#${k}`).join(' ') : 'none'}\n` +
        `<b>Source:</b> <code>${lead.source}</code>\n\n` +
        `<b>Guild Fit:</b> ${lead.guildFitScore}/100\n` +
        `<code>${scoreBar}</code>\n\n` +
        `<b>🎯 PITCH TYPE:</b>\n${PITCH_LABELS[lead.pitchType]}\n\n` +
        `<b>📋 SEND THIS DM:</b>\n<i>${PITCH_OPENERS[lead.pitchType]}</i>\n\n` +
        `🔗 ${lead.url}`;

    await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
    }).catch((e: any) => console.log(`[GUILD-LEAD] Send error: ${e.message}`));
}

export async function runGuildLeadScraper(bot: any, adminId: string): Promise<string> {
    const cancelKey = `state:guild_lead_scraper:${adminId}`;

    try {
        await redis.set(cancelKey, 'RUNNING', 'EX', 3600);
        console.log(`🏰 [GUILD-LEAD] Starting Guild Prospect Scan (Telegram-only, ${MIN_MEMBERS_FOR_GUILD}+ members)...`);

        const [
            dirLeads, boostedLeads, kothLeads, graduateLeads,
            holderLeads, newPairLeads
        ] = await Promise.all([
            fetchKolChannelsFromDirectory(),
            fetchBoostedTokenKols(),
            fetchPumpKothKols(),
            fetchPumpGraduates(),
            fetchHighHolderTokenKols(),
            fetchNewSolanaPairKols(),
        ]);

        const allLeads = [
            ...dirLeads, ...boostedLeads, ...kothLeads, ...graduateLeads,
            ...holderLeads, ...newPairLeads
        ];

        console.log(`🏰 [GUILD-LEAD] Raw leads: ${allLeads.length}`);

        const seenUrls = new Set<string>();
        const candidates = allLeads
            .filter(l => { if (seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; })
            .filter(l => l.guildFitScore >= MIN_GUILD_FIT_SCORE)
            .sort((a, b) => b.guildFitScore - a.guildFitScore);

        console.log(`🏰 [GUILD-LEAD] Score-qualified candidates: ${candidates.length} (member count checked next)`);

        let sent     = 0;
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
            await sendGuildLead(bot, adminId, sent, lead, memberCount);
            await SLEEP(300);
        }

        if (sent === 0) {
            return (
                `🟡 Guild scan complete — 0 qualified leads sent.\n` +
                `<i>${rejected} candidates were checked but didn't clear the ${MIN_MEMBERS_FOR_GUILD}+ member floor, ` +
                `or were already contacted previously.</i>`
            );
        }

        return (
            `🏰 <b>Guild Prospect Scan Complete!</b>\n\n` +
            `Sent <b>${sent}</b> qualified Telegram-only Guild prospects to your inbox.\n` +
            `<i>${rejected} additional candidates were rejected for not reaching ${MIN_MEMBERS_FOR_GUILD}+ verified members.</i>\n\n` +
            `<b>Breakdown by source:</b>\n` +
            `• tgstat/CommBot KOL: ${dirLeads.length}\n` +
            `• DexScreener Boosted: ${boostedLeads.length}\n` +
            `• Pump KotH: ${kothLeads.length}\n` +
            `• Pump Graduates 🎓: ${graduateLeads.length}\n` +
            `• Birdeye high-holders: ${holderLeads.length}\n` +
            `• DexScreener New: ${newPairLeads.length}\n\n` +
            `<i>Each lead includes verified member count, Guild Fit Score, pitch type, and a ready-to-send DM.</i>`
        );

    } catch (e: any) {
        return `🔴 Guild scan error: ${e.message}`;
    } finally {
        await redis.del(cancelKey);
    }
}

export function startGuildLeadScheduler(bot: any, adminId: string) {
    console.log('🏰 [GUILD-LEAD] Guild Prospect Scheduler started — scanning every 45 minutes.');

    const runIfIdle = async () => {
        const cancelKey = `state:guild_lead_scraper:${adminId}`;
        const isRunning = await redis.get(cancelKey).catch(() => null);
        if (isRunning === 'RUNNING') return;

        const result = await runGuildLeadScraper(bot, adminId);
        await bot.telegram.sendMessage(adminId,
            `🏰 <b>Auto Guild Scan</b>\n${result}`,
            { parse_mode: 'HTML' }
        ).catch(() => null);
    };

    runIfIdle();
    setInterval(runIfIdle, 45 * 60 * 1000);
}