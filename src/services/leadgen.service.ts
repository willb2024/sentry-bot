// src/services/leadgen.service.ts

import dotenv from 'dotenv';
import axios from 'axios';
import { redis } from '../lib/redis.js';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_LEADS_PER_SCAN   = 9999;
const CHUNK_SIZE            = 30;

const MIN_VOLUME_24H_USD    = 500;
const MIN_LIQUIDITY_USD     = 200;
const MIN_TXNS_24H          = 10;
const MIN_MEMBERS_DISPLAY   = 10;

const SLEEP_BETWEEN_CHUNKS  = 150;
const SLEEP_BETWEEN_SOCIALS = 150;  
const DEEP_PARALLEL         = 20;   

// 7-day dedup TTL — prevents hammering the same group across multiple runs
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── Redis helpers ────────────────────────────────────────────────────────────

async function isCancelled(key: string): Promise<boolean> {
    const state = await redis.get(key);
    return state !== 'RUNNING';
}

async function isAlreadyContacted(url: string): Promise<boolean> {
    const dedupKey = `leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    const exists = await redis.exists(dedupKey);
    return exists === 1;
}

async function markContacted(url: string): Promise<void> {
    const dedupKey = `leadgen:contacted:${Buffer.from(url).toString('base64').substring(0, 60)}`;
    await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS);
}

// ─── Community size fetchers ──────────────────────────────────────────────────

async function getTelegramMemberCount(url: string): Promise<number | null> {
    try {
        if (!url.includes('t.me/')) return null;
        const res = await axios.get(url, { headers: { 'User-Agent': randomUA() }, timeout: 6000 });
        const html: string = res.data;
        for (const pattern of [/([\d\s,]+)\s+(members|subscribers)/i, /([\d\s,]+)\s+online/i]) {
            const m = html.match(pattern);
            if (m?.[1]) {
                const n = parseInt(m[1].replace(/[, ]/g, ''), 10);
                if (n > 0) return n;
            }
        }
        const ogMatch = html.match(/content="([\d,]+)\s+(members|subscribers)/i);
        if (ogMatch?.[1]) {
            const n = parseInt(ogMatch[1].replace(/,/g, ''), 10);
            if (n > 0) return n;
        }
        return 0;
    } catch (e: any) {
        if (e.response?.status === 429) await sleep(5000);
        return null;
    }
}

async function getDiscordMemberCount(url: string): Promise<number | null> {
    try {
        const m = url.match(/(?:discord\.gg\/|discord\.com\/invite\/)([a-zA-Z0-9-]+)/i);
        if (!m?.[1]) return null;
        const res = await axios.get(
            `https://discord.com/api/v9/invites/${m[1]}?with_counts=true`,
            { headers: { 'User-Agent': randomUA() }, timeout: 5000 }
        );
        return typeof res.data.approximate_member_count === 'number'
            ? res.data.approximate_member_count : null;
    } catch { return null; }
}

async function getTwitterFollowerCount(url: string): Promise<number | null> {
    try {
        // Extract handle from URL (twitter.com/handle or x.com/handle)
        const match = url.match(/(?:twitter\.com|x\.com)\/([^/?]+)/i);
        if (!match?.[1]) return null;
        const handle = match[1];

        // Undocumented, free Syndication API used by Twitter Embeds
        const res = await axios.get(
            `https://cdn.syndication.twimg.com/widgets/followbutton/info.json?screen_names=${handle}`,
            { headers: { 'User-Agent': randomUA() }, timeout: 5000 }
        );

        if (res.data && res.data.length > 0 && typeof res.data[0].followers_count === 'number') {
            return res.data[0].followers_count;
        }
        return null;
    } catch { return null; }
}

// ─── Social link type ─────────────────────────────────────────────────────────

interface NormalizedSocial {
    platform: 'telegram' | 'discord' | 'twitter';
    url: string;
}

// ─── Social extraction ────────────────────────────────────────────────────────

function extractSocialsFromInfo(info: any): NormalizedSocial[] {
    const out: NormalizedSocial[] = [];
    if (!info) return out;

    for (const s of (info.socials || [])) {
        const plat = ((s.type || s.platform || '')).toLowerCase();
        let url = s.url;
        if (!url && s.handle) {
            const h = s.handle.replace(/^@/, '').replace(/^https?:\/\//, '');
            if (plat === 'telegram') url = `https://t.me/${h.replace(/^t\.me\//, '')}`;
            else if (plat === 'discord') url = `https://discord.gg/${h.replace(/^discord\.(gg|com\/invite)\//, '')}`;
            else if (plat === 'twitter' || plat === 'x') url = `https://x.com/${h.replace(/^(twitter|x)\.com\//, '')}`;
        }
        if (url) {
            if (plat === 'telegram') out.push({ platform: 'telegram', url });
            else if (plat === 'discord') out.push({ platform: 'discord', url });
            else if (plat === 'twitter' || plat === 'x') out.push({ platform: 'twitter', url });
        }
    }

    for (const l of (info.links || [])) {
        const label = ((l.label || l.type || '')).toLowerCase();
        const url: string = l.url || '';
        if (!url) continue;
        if (label === 'telegram' || url.includes('t.me/')) out.push({ platform: 'telegram', url });
        else if (label === 'discord' || url.includes('discord.gg') || url.includes('discord.com/invite')) out.push({ platform: 'discord', url });
        else if (label === 'twitter' || url.includes('twitter.com') || url.includes('x.com')) out.push({ platform: 'twitter', url });
    }

    const website: string = info.website || info.websiteUrl || '';
    if (website.includes('t.me/')) out.push({ platform: 'telegram', url: website });
    if (website.includes('discord.gg') || website.includes('discord.com/invite')) out.push({ platform: 'discord', url: website });
    if (website.includes('twitter.com') || website.includes('x.com')) out.push({ platform: 'twitter', url: website });

    return out;
}

// ─── Supplementary social fetchers ───────────────────────────────────────────

async function fetchDexScreenerProfileSocials(mint: string): Promise<NormalizedSocial[]> {
    try {
        const res = await axios.get(
            `https://api.dexscreener.com/token-profiles/v1/solana/${mint}`,
            { timeout: 6000 }
        );
        return extractSocialsFromInfo({ links: res.data?.links, socials: res.data?.socials, website: res.data?.url });
    } catch { return []; }
}

async function fetchPumpFunSocials(mint: string): Promise<NormalizedSocial[]> {
    try {
        const res = await axios.get(
            `https://frontend-api.pump.fun/coins/${mint}`,
            { headers: { 'User-Agent': randomUA() }, timeout: 5000 }
        );
        const d = res.data;
        const out: NormalizedSocial[] = [];
        const tg: string = d?.telegram || '';
        const tw: string = d?.twitter || '';
        const web: string = d?.website || '';

        if (tg && tg.includes('t.me')) out.push({ platform: 'telegram', url: tg.startsWith('http') ? tg : `https://${tg}` });
        if (tw && (tw.includes('twitter.com') || tw.includes('x.com'))) out.push({ platform: 'twitter', url: tw.startsWith('http') ? tw : `https://${tw}` });

        if (web.includes('t.me')) out.push({ platform: 'telegram', url: web });
        if (web.includes('discord.gg') || web.includes('discord.com/invite')) out.push({ platform: 'discord', url: web });
        if (web.includes('twitter.com') || web.includes('x.com')) out.push({ platform: 'twitter', url: web });

        return out;
    } catch { return []; }
}

async function fetchJupiterNewTokens(): Promise<string[]> {
    try {
        const res = await axios.get('https://token.jup.ag/strict', { timeout: 10000 });
        const tokens: any[] = Array.isArray(res.data) ? res.data : [];
        return tokens.slice(-200).map((t: any) => t.address).filter(Boolean);
    } catch (e: any) {
        return [];
    }
}

async function fetchCoinGeckoTrending(): Promise<string[]> {
    try {
        const res = await axios.get(
            'https://api.coingecko.com/api/v3/search/trending',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        const coins: any[] = res.data?.coins || [];
        const mints: string[] = [];
        for (const c of coins) {
            const platforms = c.item?.platforms || {};
            const solanaMint = platforms['solana'];
            if (solanaMint) mints.push(solanaMint);
        }
        return mints;
    } catch (e: any) {
        return [];
    }
}

async function fetchSolscanNewTokens(): Promise<string[]> {
    try {
        const res = await axios.get(
            'https://public-api.solscan.io/token/list?sortBy=market_cap&direction=desc&limit=50&offset=0',
            { headers: { 'User-Agent': randomUA(), 'token': '' }, timeout: 8000 }
        );
        const items: any[] = res.data?.data || [];
        return items.map((t: any) => t.tokenAddress || t.mint).filter(Boolean);
    } catch (e: any) {
        return [];
    }
}

const NITTER_MIRRORS = [
    'https://nitter.net',
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
];

async function fetchNitterCAs(): Promise<string[]> {
    const queries = ['solana pump token contract', 'SOL gem CA snipe', 'new token solana t.me'];
    const mints: string[] = [];
    const SOLANA_CA_REGEX = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

    for (const query of queries) {
        for (const mirror of NITTER_MIRRORS) {
            try {
                const res = await axios.get(
                    `${mirror}/search?q=${encodeURIComponent(query)}&f=tweets`,
                    { headers: { 'User-Agent': randomUA() }, timeout: 7000 }
                );
                const html: string = res.data;
                const matches = html.match(SOLANA_CA_REGEX) || [];
                for (const m of matches) {
                    if (m.length >= 32 && m.length <= 44 && !m.includes('http')) mints.push(m);
                }
                break;
            } catch { continue; }
        }
    }
    return [...new Set(mints)];
}

interface DirectoryLead {
    url: string;
    memberCount: number;
    title: string;
    source: 'tgstat-crypto' | 'tgstat-solana' | 'tgstat-trading';
}

async function fetchTelegramDirectoryGroups(): Promise<DirectoryLead[]> {
    const results: DirectoryLead[] = [];
    const categories = [
        { url: 'https://tgstat.com/en/category/crypto', label: 'tgstat-crypto' as const },
        { url: 'https://tgstat.com/en/search?q=solana+trading', label: 'tgstat-solana' as const },
        { url: 'https://tgstat.com/en/search?q=solana+gem', label: 'tgstat-trading' as const },
    ];

    for (const cat of categories) {
        try {
            const res = await axios.get(cat.url, {
                headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
                timeout: 10000
            });
            const html: string = res.data;
            const linkRegex = /href="(https:\/\/t\.me\/[a-zA-Z0-9_]+)"/g;
            const memberRegex = /(\d[\d\s,]+)\s*(members?|subscribers?)/gi;

            let linkMatch;
            const foundLinks: string[] = [];
            while ((linkMatch = linkRegex.exec(html)) !== null) {
                const url = linkMatch[1];
                if (!url.includes('/s/') && !url.includes('/+')) foundLinks.push(url);
            }

            const memberMatches: number[] = [];
            let memberMatch;
            while ((memberMatch = memberRegex.exec(html)) !== null) {
                const n = parseInt(memberMatch[1].replace(/[\s,]/g, ''), 10);
                if (n > 0) memberMatches.push(n);
            }

            for (let i = 0; i < foundLinks.length; i++) {
                const memberCount = memberMatches[i] || 0;
                if (memberCount >= 100 || memberCount === 0) { 
                    results.push({ url: foundLinks[i], memberCount, title: `Directory group`, source: cat.label });
                }
            }
            await sleep(1500); 
        } catch (e: any) {}
    }
    const seen = new Set<string>();
    return results.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
    });
}

async function fetchFromDexFeed(url: string, label: string): Promise<string[]> {
    try {
        const res = await axios.get(url, { timeout: 10000 });
        const items = Array.isArray(res.data) ? res.data : (res.data?.pairs || res.data?.tokens || []);
        return items
            .filter((p: any) => (p.chainId === 'solana' || p.chain === 'solana') && (p.tokenAddress || p.baseToken?.address))
            .map((p: any) => (p.tokenAddress || p.baseToken?.address) as string);
    } catch (e: any) { return []; }
}

async function fetchPumpFunKingOfHill(): Promise<string[]> {
    try {
        const res = await axios.get(
            'https://frontend-api.pump.fun/coins/king-of-the-hill?offset=0&limit=50&includeNsfw=false',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        return (Array.isArray(res.data) ? res.data : []).map((c: any) => c.mint as string).filter(Boolean);
    } catch (e: any) { return []; }
}

async function fetchPumpFunLatest(): Promise<string[]> {
    try {
        const res = await axios.get(
            'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=last_reply&includeNsfw=false',
            { headers: { 'User-Agent': randomUA() }, timeout: 8000 }
        );
        return (Array.isArray(res.data) ? res.data : []).map((c: any) => c.mint as string).filter(Boolean);
    } catch (e: any) { return []; }
}

async function fetchBirdeyeTrending(): Promise<string[]> {
    try {
        const res = await axios.get(
            'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=50',
            { headers: { 'User-Agent': randomUA(), 'x-chain': 'solana' }, timeout: 8000 }
        );
        const items = res.data?.data?.tokens || res.data?.tokens || [];
        return items.map((t: any) => t.address as string).filter(Boolean);
    } catch (e: any) { return []; }
}

async function fetchAllCandidateMints(): Promise<{ mints: string[], counts: Record<string, number> }> {
    const [
        latestProfiles, recentUpdates, latestBoosts, topBoosted,
        pumpKotH, pumpLatest, birdeye, jupiterNew, coinGecko, solscan, nitter
    ] = await Promise.all([
        fetchFromDexFeed('https://api.dexscreener.com/token-profiles/latest/v1',         'dex:latest-profiles'),
        fetchFromDexFeed('https://api.dexscreener.com/token-profiles/recent-updates/v1', 'dex:recent-updates'),
        fetchFromDexFeed('https://api.dexscreener.com/token-boosts/latest/v1',           'dex:boosts-latest'),
        fetchFromDexFeed('https://api.dexscreener.com/token-boosts/top/v1',              'dex:boosts-top'),
        fetchPumpFunKingOfHill(),
        fetchPumpFunLatest(),
        fetchBirdeyeTrending(),
        fetchJupiterNewTokens(),
        fetchCoinGeckoTrending(),
        fetchSolscanNewTokens(),
        fetchNitterCAs(),
    ]);

    const counts: Record<string, number> = {
        'dex-latest-profiles': latestProfiles.length,
        'dex-recent-updates':  recentUpdates.length,
        'dex-boosts-latest':   latestBoosts.length,
        'dex-boosts-top':      topBoosted.length,
        'pump-koth':           pumpKotH.length,
        'pump-latest':         pumpLatest.length,
        'birdeye-trending':    birdeye.length,
        'jupiter-new':         jupiterNew.length,
        'coingecko-trending':  coinGecko.length,
        'solscan-new':         solscan.length,
        'nitter-x-cas':        nitter.length,
    };

    const merged = [...new Set([
        ...latestProfiles, ...recentUpdates, ...latestBoosts, ...topBoosted,
        ...pumpKotH, ...pumpLatest, ...birdeye, ...jupiterNew,
        ...coinGecko, ...solscan, ...nitter,
    ])];

    return { mints: merged, counts };
}

async function fetchPairsForMints(mints: string[], cancelKey: string): Promise<{ pairs: any[], cancelled: boolean }> {
    const allPairs: any[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += CHUNK_SIZE) chunks.push(mints.slice(i, i + CHUNK_SIZE));

    const PARALLEL = 5;
    for (let i = 0; i < chunks.length; i += PARALLEL) {
        if (await isCancelled(cancelKey)) return { pairs: allPairs, cancelled: true };

        const batch = chunks.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
            batch.map(chunk =>
                axios.get(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`, { timeout: 10000 })
                    .then(r => Array.isArray(r.data) ? r.data : [])
                    .catch(() => [])
            )
        );
        for (const r of results) {
            if (r.status === 'fulfilled') allPairs.push(...r.value);
        }
        await sleep(SLEEP_BETWEEN_CHUNKS);
    }
    return { pairs: allPairs, cancelled: false };
}

async function sendLeadMessage(
    bot: any, adminId: string, leadIndex: number, platform: 'telegram' | 'discord' | 'twitter',
    url: string, memberCount: number | null, symbol: string, mint: string,
    vol: number, liq: number, mcap: number, source: string
): Promise<void> {
    
    let icon = '✈️';
    let platLabel = 'Telegram';
    if (platform === 'discord') { icon = '🎮'; platLabel = 'Discord'; }
    if (platform === 'twitter') { icon = '🐦'; platLabel = 'Twitter / X'; }

    let sizeLabel = 'Group Size:';
    if (platform === 'twitter') sizeLabel = 'Followers:';

    const sizeStr = memberCount === null
        ? 'Fetch failed'
        : memberCount === 0
        ? 'Size unknown'
        : platform === 'twitter'
        ? `${memberCount.toLocaleString()}`
        : `~${memberCount.toLocaleString()} members`;

    const leadMessage =
        `🎯 <b>KOL / COMMUNITY LEAD [${leadIndex}]</b>\n\n` +
        `<b>Token:</b> $${symbol} — <code>${mint}</code>\n` +
        `<b>24H Volume:</b> 💰 $${vol.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        `<b>Liquidity:</b> 💧 $${liq.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` +
        (mcap > 0 ? `<b>Market Cap:</b> $${mcap.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n` : '') +
        `<b>Platform:</b> ${icon} ${platLabel}\n` +
        `<b>${sizeLabel}</b> 👥 ${sizeStr}\n` +
        `<b>Source:</b> ${source}\n` +
        `<b>Link:</b> ${url}`;

    await bot.telegram.sendMessage(adminId, leadMessage, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
    }).catch((e: any) => console.log(`[LEAD-GEN] Send Error: ${e.message}`));
}

export async function runLeadScraper(bot: any, adminId: string): Promise<string> {
    const cancelKey = `state:lead_scraper:${adminId}`;

    try {
        await redis.set(cancelKey, 'RUNNING', 'EX', 3600);

        console.log(`📡 [LEAD-GEN] Stage 1: Fetching from 11 discovery sources...`);
        const { mints: candidateMints, counts } = await fetchAllCandidateMints();
        console.log(`📡 [LEAD-GEN] Stage 1 complete: ${candidateMints.length} unique Solana mints`);

        if (await isCancelled(cancelKey)) return `🛑 Cancelled at Stage 1.`;
        if (candidateMints.length === 0) return `🟡 All 11 discovery sources returned 0 results. Try again shortly.`;

        console.log(`📡 [LEAD-GEN] Stage 1b: Scraping Telegram community directories...`);
        const directoryLeadsPromise = fetchTelegramDirectoryGroups();

        console.log(`📡 [LEAD-GEN] Stage 2: Fetching pair data for ${candidateMints.length} mints...`);
        const { pairs: allPairs, cancelled: c2 } = await fetchPairsForMints(candidateMints, cancelKey);
        if (c2) return `🛑 Cancelled at Stage 2.`;

        const seenMints = new Set<string>();
        const uniquePool: any[] = [];

        for (const item of allPairs) {
            const mint = item.baseToken?.address;
            if (!mint || seenMints.has(mint)) continue;
            if (item.chainId !== 'solana') continue;

            const vol  = item.volume?.h24 || 0;
            const liq  = item.liquidity?.usd || 0;
            const txns = (item.txns?.h24?.buys || 0) + (item.txns?.h24?.sells || 0);

            if (vol >= MIN_VOLUME_24H_USD && liq >= MIN_LIQUIDITY_USD && txns >= MIN_TXNS_24H) {
                seenMints.add(mint);
                uniquePool.push(item);
            }
        }
        if (await isCancelled(cancelKey)) return `🛑 Cancelled at Stage 3.`;

        const withSocials: { item: any; socials: NormalizedSocial[]; source: string }[] = [];
        const needsDeepLookup: any[] = [];

        for (const item of uniquePool) {
            const socials = extractSocialsFromInfo(item.info);
            if (socials.length > 0) {
                withSocials.push({ item, socials, source: 'dex-pair-info' });
            } else {
                needsDeepLookup.push(item);
            }
        }

        for (let i = 0; i < needsDeepLookup.length; i += DEEP_PARALLEL) {
            if (await isCancelled(cancelKey)) return `🛑 Cancelled during deep social lookup.`;
            const batch = needsDeepLookup.slice(i, i + DEEP_PARALLEL);
            const results = await Promise.allSettled(
                batch.map(async (item) => {
                    const mint = item.baseToken?.address;
                    const isPump = typeof mint === 'string' && mint.toLowerCase().endsWith('pump');
                    let socials = await fetchDexScreenerProfileSocials(mint);
                    if (socials.length === 0 && isPump) socials = await fetchPumpFunSocials(mint);
                    return { item, socials, source: isPump ? 'pump-fun-api' : 'dex-profile-page' };
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled' && r.value.socials.length > 0) withSocials.push(r.value);
            }
            await sleep(200);
        }

        if (await isCancelled(cancelKey)) return `🛑 Cancelled at Stage 4.`;

        let foundLeads = 0;
        const processedUrls = new Set<string>();

        for (const { item: token, socials, source } of withSocials) {
            if (foundLeads >= MAX_LEADS_PER_SCAN) break;
            if (await isCancelled(cancelKey)) return `🛑 <b>Scan Cancelled.</b> ${foundLeads} leads sent before stop.`;

            // --- 🟢 NEW: TWITTER STRICT FOLLOWER FILTERING (500 to 20k) ---
            let twitterFollowers: number | null = null;
            const twitterSocial = socials.find(s => s.platform === 'twitter');

            if (twitterSocial) {
                twitterFollowers = await getTwitterFollowerCount(twitterSocial.url);
                
                // If we successfully fetched the count, apply the strict 500 - 20k filter
                if (twitterFollowers !== null && (twitterFollowers < 500 || twitterFollowers > 20000)) {
                    console.log(`⏭️ [LEAD-GEN] Skipping ${token.baseToken?.symbol}: Twitter followers (${twitterFollowers}) out of range.`);
                    continue; 
                }
            }
            // -------------------------------------------------------------

            const mint   = token.baseToken?.address;
            const symbol = token.baseToken?.symbol || '???';
            const vol    = token.volume?.h24 || 0;
            const liq    = token.liquidity?.usd || 0;
            const mcap   = token.fdv || token.marketCap || 0;

            const tgSocial      = socials.find(s => s.platform === 'telegram');
            const discordSocial = socials.find(s => s.platform === 'discord');
            const targets       = [tgSocial, discordSocial, twitterSocial].filter(Boolean) as NormalizedSocial[];

            for (const target of targets) {
                if (processedUrls.has(target.url)) continue;
                processedUrls.add(target.url);

                if (await isAlreadyContacted(target.url)) continue;
                await sleep(SLEEP_BETWEEN_SOCIALS);

                let memberCount: number | null = null;
                if (target.platform === 'telegram') {
                    memberCount = await getTelegramMemberCount(target.url);
                    if (memberCount !== null && memberCount < MIN_MEMBERS_DISPLAY) continue;
                } else if (target.platform === 'discord') {
                    memberCount = await getDiscordMemberCount(target.url);
                    if (memberCount !== null && memberCount < MIN_MEMBERS_DISPLAY) continue;
                } else if (target.platform === 'twitter') {
                    // Already fetched and filtered above! 
                    memberCount = twitterFollowers;
                    if (memberCount !== null && (memberCount < 500 || memberCount > 20000)) continue;
                }

                foundLeads++;
                await markContacted(target.url);
                await sendLeadMessage(bot, adminId, foundLeads, target.platform, target.url,
                    memberCount, symbol, mint, vol, liq, mcap, source);
                await sleep(300);
            }
        }

        const directoryLeads = await directoryLeadsPromise;
        for (const lead of directoryLeads) {
            if (foundLeads >= MAX_LEADS_PER_SCAN || await isCancelled(cancelKey)) break;
            if (processedUrls.has(lead.url) || await isAlreadyContacted(lead.url)) continue;
            processedUrls.add(lead.url);

            let memberCount: number | null = lead.memberCount > 0 ? lead.memberCount : null;
            if (memberCount === null) {
                await sleep(SLEEP_BETWEEN_SOCIALS);
                memberCount = await getTelegramMemberCount(lead.url);
            }

            if (memberCount !== null && memberCount < MIN_MEMBERS_DISPLAY) continue;

            foundLeads++;
            await markContacted(lead.url);

            const leadMessage =
                `🗂️ <b>COMMUNITY DIRECTORY LEAD [${foundLeads}]</b>\n\n` +
                `<b>Platform:</b> ✈️ Telegram\n` +
                `<b>Group Size:</b> 👥 ${memberCount !== null && memberCount > 0 ? `~${memberCount.toLocaleString()} members` : 'Size unknown'}\n` +
                `<b>Source:</b> ${lead.source}\n` +
                `<b>Link:</b> ${lead.url}`;

            await bot.telegram.sendMessage(adminId, leadMessage, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            }).catch((e: any) => console.log(`[LEAD-GEN] Dir send error: ${e.message}`));
            await sleep(300);
        }

        const sourceBreakdown = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' | ');

        if (foundLeads === 0) {
            return `🟡 <b>Scan Complete:</b> Pipeline ran but all groups were already contacted or outside follower limits.\n<i>${sourceBreakdown}</i>`;
        }

        return `🟢 <b>Scan Complete!</b> Found <b>${foundLeads}</b> KOL/community leads.\n` +
            `<i>Pipeline: ${candidateMints.length} candidates → ${uniquePool.length} passed thresholds → filtered for 500-20k Followers → ${foundLeads} leads sent.</i>\n` +
            `<i>Directory leads: ${directoryLeads.length} scraped.</i>\n` +
            `<i>Sources: ${sourceBreakdown}</i>`;

    } catch (error: any) {
        return `🔴 <b>Scraper Error:</b> ${error.message}`;
    } finally {
        await redis.del(cancelKey);
    }
}

export function startLeadGenScheduler(bot: any, adminId: string) {
    console.log('⏱️ [LEAD-GEN] Auto-scheduler started — scanning every 60 minutes.');

    const runIfIdle = async () => {
        const cancelKey = `state:lead_scraper:${adminId}`;
        const isRunning = await redis.get(cancelKey).catch(() => null);
        if (isRunning === 'RUNNING') return;
        
        console.log('⏱️ [LEAD-GEN] Scheduler firing automatic scan...');
        const result = await runLeadScraper(bot, adminId);
        await bot.telegram.sendMessage(adminId,
            `🔄 <b>Auto-Scan Complete</b>\n${result}`,
            { parse_mode: 'HTML' }
        ).catch(() => null);
    };

    runIfIdle();
    setInterval(runIfIdle, 60 * 60 * 1000);
}