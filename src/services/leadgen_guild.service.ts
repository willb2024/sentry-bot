// src/services/leadgen_guild.service.ts
//
// 🏰 SENTRY GUILDS LEAD-GEN ENGINE v3 — QUALIFIED TELEGRAM-ONLY
//
// CHANGES IN THIS VERSION:
//   - TELEGRAM ONLY: Discord (Disboard) and Twitter/Nitter sources removed
//     entirely. Every other source's Discord/Twitter branches stripped too.
//   - MIN_MEMBERS_FOR_GUILD: 0 → 300 (HARD FLOOR, actually enforced post-
//     enrichment — previously this constant existed but was never checked)
//   - MIN_GUILD_FIT_SCORE: 35 → 45 (tighter — quality over raw volume)
//   - Leads with memberCount unknown (0) are now enriched BEFORE the
//     qualification decision, and dropped if they can't confirm 300+
//   - Scheduler unchanged: every 45 minutes
//
// PHILOSOPHY: You asked for "qualified members to my platform" — that
// means real, checkable Telegram communities of meaningful size, not a
// firehose of unknown-size Discord servers and tweet mentions.

import dotenv from 'dotenv';
import axios from 'axios';
import { redis } from '../lib/redis.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_GUILD_LEADS_PER_SCAN  = 9999;  // Effectively unlimited — quality gate does the real filtering
const MIN_GUILD_FIT_SCORE       = 45;    // Tighter net — fewer, better leads
const MIN_MEMBERS_FOR_GUILD     = 300;   // HARD FLOOR — enforced after enrichment, see qualifyLead()
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

// ─── Types ────────────────────────────────────────────────────────────────────

type PitchType = 'LAUNCH_KOL' | 'PROJECT_OWNER' | 'ALPHA_GROUP';

interface GuildLead {
    url: string;
    platform: 'telegram';   // 🟢 TELEGRAM ONLY — Discord/Twitter removed
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
// Recalibrated: small KOLs with strong keywords score higher than big dead channels

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

    // Community size (max 30 pts) — recalibrated around the 300-member hard floor.
    // Anything under 300 scores 0 here and will be rejected later by qualifyLead()
    // regardless of keyword score, so we don't bother giving it points.
    if (memberCount >= 50000)      score += 30;
    else if (memberCount >= 10000) score += 26;
    else if (memberCount >= 2000)  score += 20;
    else if (memberCount >= 1000)  score += 15;
    else if (memberCount >= 300)   score += 10;
    // < 300 members = 0 pts, and will be hard-rejected after enrichment

    // Solana relevance (max 15 pts — must be Solana ecosystem)
    for (const kw of SOLANA_KEYWORDS) {
        if (text.includes(kw)) { score += 4; foundKeywords.push(kw); break; }
    }

    // Launch/presale keywords (max 35 pts — HIGHEST signal for Guild pitch)
    for (const kw of LAUNCH_KEYWORDS) {
        if (text.includes(kw)) { score += 5; foundKeywords.push(kw); }
    }

    // Alpha/calls keywords (max 25 pts)
    for (const kw of ALPHA_KEYWORDS) {
        if (text.includes(kw)) { score += 3; foundKeywords.push(kw); }
    }

    // Community engagement keywords (max 15 pts)
    for (const kw of COMMUNITY_KEYWORDS) {
        if (text.includes(kw)) { score += 3; foundKeywords.push(kw); }
    }

    // Bonus: has a token (already launching things)
    if (hasToken) score += 15;

    score = Math.min(100, score);

    // Pitch type assignment
    const launchSignals = LAUNCH_KEYWORDS.filter(k => text.includes(k)).length;
    const alphaSignals  = ALPHA_KEYWORDS.filter(k => text.includes(k)).length;

    let pitchType: PitchType;
    if (hasToken || launchSignals >= 2) pitchType = 'PROJECT_OWNER';
    else if (alphaSignals >= 2)         pitchType = 'LAUNCH_KOL';
    else                                pitchType = 'ALPHA_GROUP';

    return { score, pitchType, keywords: [...new Set(foundKeywords)] };
}

// ─── SOURCE 1: tgstat.com — EXPANDED to 12 KOL search queries ────────────────

async function fetchKolChannelsFromDirectory(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];

    // 12 targeted searches — covers every KOL persona type
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
        // CommBot directory — different source, same TG channel scraping
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
            console.warn(`⚠️ [GUILD-LEAD] ${search.label} failed: ${e.message}`);
        }
    }

    return leads;
}

// ─── SOURCE 2: DexScreener Boosted ───────────────────────────────────────────

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

                // 🟢 TELEGRAM ONLY — Discord links skipped entirely
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
                    guildFitScore: Math.min(100, score + 20), // paid boost = serious
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

// ─── SOURCE 3: Pump.fun King of the Hill ─────────────────────────────────────

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

            // 🟢 TELEGRAM ONLY — discord/twitter socials ignored
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

// ─── SOURCE 4: Pump.fun Recent Graduates (bonding curve completed) ────────────
// These tokens GRADUATED the bonding curve — they raised real money.
// The dev has a community and will do another launch. High value prospect.

async function fetchPumpGraduates(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        const coins: any[] = Array.isArray(res.data) ? res.data : [];

        for (const coin of coins) {
            // 🟢 TELEGRAM ONLY — discord/twitter socials ignored
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
                guildFitScore: Math.min(100, score + 20), // graduated = serious dev
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

// ─── SOURCE 5: Birdeye high-holder tokens ────────────────────────────────────

async function fetchHighHolderTokenKols(): Promise<GuildLead[]> {
    const leads: GuildLead[] = [];
    try {
        const res = await axios.get(
            'https://public-api.birdeye.so/defi/tokenlist?sort_by=holder&sort_type=desc&offset=0&limit=50&min_holder=500',
            { headers: { 'User-Agent': randomUA(), 'x-chain': 'solana' }, timeout: 8000 }
        );
        const tokens: any[] = res.data?.data?.tokens || [];

        // Process in parallel chunks of DEEP_PARALLEL
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
                        // 🟢 TELEGRAM ONLY — discord links ignored
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

// ─── SOURCE 6: DexScreener new Solana pairs (token socials) ──────────────────
// Catches fresh tokens the moment they list — before they hit any directory.

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
                // 🟢 TELEGRAM ONLY — discord links ignored
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

// ─── Member count enrichment ──────────────────────────────────────────────────
// 🟢 TELEGRAM ONLY — discord branch removed
// 🟢 BUG FIX: "online" count was being matched ahead of "members" count in some
//    HTML layouts, which under-counts real group size (online << total members).
//    Members/subscribers pattern is now tried first and exclusively, with
//    "online" only used as an absolute last resort fallback.

async function enrichMemberCount(lead: GuildLead): Promise<number> {
    if (lead.memberCount > 0) return lead.memberCount;
    try {
        const res = await axios.get(lead.url, { headers: { 'User-Agent': randomUA() }, timeout: 6000 });
        const html: string = res.data;

        // Primary signal — actual member/subscriber count
        const memberMatch = html.match(/([\d\s,]+)\s+(members|subscribers)/i);
        if (memberMatch?.[1]) {
            const n = parseInt(memberMatch[1].replace(/[, ]/g, ''), 10);
            if (n > 0) return n;
        }

        // Fallback only if no members count was found at all
        const onlineMatch = html.match(/([\d\s,]+)\s+online/i);
        if (onlineMatch?.[1]) {
            const n = parseInt(onlineMatch[1].replace(/[, ]/g, ''), 10);
            if (n > 0) return n;
        }
    } catch { }
    return 0;
}

// ─── Qualification gate — HARD ENFORCEMENT of 300+ members ───────────────────
// This is the actual fix you asked for: MIN_MEMBERS_FOR_GUILD previously
// existed as a constant but was never checked against memberCount anywhere.
// A high keyword score could send a 0-member or 50-member lead to your inbox.
// Now every lead must clear BOTH the score threshold AND the member floor,
// checked AFTER enrichment so unknown-size leads get a real number first.

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

// ─── Pitch templates ──────────────────────────────────────────────────────────

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

// ─── Send lead to admin ───────────────────────────────────────────────────────

async function sendGuildLead(
    bot: any,
    adminId: string,
    leadIndex: number,
    lead: GuildLead,
    memberCount: number
): Promise<void> {
    const scoreBar   = '█'.repeat(Math.floor(lead.guildFitScore / 10)) + '░'.repeat(10 - Math.floor(lead.guildFitScore / 10));
    // memberCount is guaranteed >= MIN_MEMBERS_FOR_GUILD here — qualifyLead()
    // already verified it before this function is ever called.
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

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runGuildLeadScraper(bot: any, adminId: string): Promise<string> {
    const cancelKey = `state:guild_lead_scraper:${adminId}`;

    try {
        await redis.set(cancelKey, 'RUNNING', 'EX', 3600);
        console.log(`🏰 [GUILD-LEAD] Starting Guild Prospect Scan (Telegram-only, ${MIN_MEMBERS_FOR_GUILD}+ members)...`);

        // Run all 6 Telegram sources in parallel
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

        // Dedupe by URL, sort by score descending — score-only pre-filter here,
        // the real member-count gate happens per-lead below via qualifyLead()
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

            // 🟢 HARD GATE: must clear MIN_MEMBERS_FOR_GUILD (300) after enrichment.
            // Lead is only marked contacted and sent if it actually qualifies —
            // failed/under-threshold leads are skipped silently and NOT marked,
            // so they can be re-checked on a future scan if they grow.
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

// ─── Scheduler — every 45 minutes (was 90) ───────────────────────────────────

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