// src/services/simulation.service.ts
import { redis } from '../lib/redis.js';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { generatePnlCard } from './image.service.js';
import { computeTokenScore, TokenStats } from './caller.service.js';

const prisma = new PrismaClient();

function randomBase58(length: number): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let result = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

export function applySimSlippage(targetPnl: number): number {
    const maxPercentDeviation = Math.abs(targetPnl) * 0.05; 
    const absoluteDeviation = (Math.random() * 2 - 1) * Math.max(1.2, maxPercentDeviation);
    return parseFloat((targetPnl + absoluteDeviation).toFixed(2));
}

export function generateSimWallets(): Array<{ address: string, balance: number }> {
    const count = Math.floor(Math.random() * 5) + 1;
    return Array.from({ length: count }, () => ({
        address: randomBase58(44),
        balance: parseFloat((Math.random() * 8 + 0.5).toFixed(4))
    }));
}

export function generateSimTokenCA(): string {
    const isPump = Math.random() > 0.4;
    const base = randomBase58(isPump ? 36 : 44);
    return isPump ? base + 'pump' : base;
}

export function generateSimSignature(): string {
    return randomBase58(87);
}

export async function isSimulationActive(telegramId: string): Promise<boolean> {
    const val = await redis.get(`sim:active:${telegramId}`);
    return val === 'true';
}

export async function getSimStartingBalance(telegramId: string): Promise<number> {
    const val = await redis.get(`sim:starting_balance:${telegramId}`);
    return val ? parseFloat(val) : 1000;
}

export async function setSimStartingBalance(telegramId: string, amount: number): Promise<void> {
    await redis.set(`sim:starting_balance:${telegramId}`, amount.toFixed(4));
}

export async function getSimBalance(telegramId: string): Promise<string> {
    const bal = await redis.get(`sim:balance:${telegramId}`);
    return bal || '12.4521';
}

export async function getSimVolume(telegramId: string): Promise<number> {
    const vol = await redis.get(`sim:volume:${telegramId}`);
    return vol ? parseFloat(vol) : 0;
}

export async function getSimWallets(telegramId: string): Promise<Array<{ address: string, balance: number }>> {
    const raw = await redis.get(`sim:wallets:${telegramId}`);
    if (raw) return JSON.parse(raw);
    const wallets = generateSimWallets();
    await redis.set(`sim:wallets:${telegramId}`, JSON.stringify(wallets));
    return wallets;
}

// 🟢 NEW: Record every closed trade into a rolling Redis window
export async function recordStatsEvent(telegramId: string, mode: 'live' | 'sim', realizedPnlSol: number) {
    const key = `stats_events:${mode}:${telegramId}`;
    await redis.zadd(key, Date.now(), JSON.stringify({ t: Date.now(), pnl: realizedPnlSol }));
    await redis.zremrangebyscore(key, 0, Date.now() - 3_600_000); // drop anything older than 1h
}

export async function getStatsForWindow(telegramId: string, mode: 'live' | 'sim', windowSeconds: number) {
    const key = `stats_events:${mode}:${telegramId}`;
    const since = Date.now() - windowSeconds * 1000;
    const raw = await redis.zrangebyscore(key, since, Date.now());
    const events = raw.map(r => JSON.parse(r));
    const totalPnl = events.reduce((sum: number, e: any) => sum + e.pnl, 0);
    const wins = events.filter((e: any) => e.pnl > 0).length;
    const losses = events.filter((e: any) => e.pnl <= 0).length;
    return { totalPnl, wins, losses, tradeCount: events.length };
}

export async function recordSimTrade(telegramId: string, isBuy: boolean, amountInSol: number, profitPercent: number = 0) {
    const key = `sim:trades:${telegramId}`;
    const existing = JSON.parse(await redis.get(key) || '[]');
    const realizedPnlSol = isBuy ? 0 : amountInSol * (profitPercent / 100);

    existing.unshift({
        createdAt: new Date().toISOString(),
        isBuy, amountInSol, profitPercent, realizedPnlSol
    });
    
    await redis.set(key, JSON.stringify(existing.slice(0, 100)), 'EX', 86400); 
    await redis.incrbyfloat(`sim:volume:${telegramId}`, amountInSol);
}

// 🟢 CLAUDE FIX 2: Fetch real tokens for Simulation Display
export async function getRealTokenForSimDisplay(): Promise<{ mint: string; symbol: string }> {
    const cacheKey = 'sim:real_token_pool';
    let pool: Array<{ mint: string; symbol: string }> = [];
    const cached = await redis.get(cacheKey);
    if (cached) pool = JSON.parse(cached);

    if (pool.length === 0) {
        try {
            const { scoreTokens } = await import('./caller.service.js'); 
            const real = await scoreTokens();
            pool = real.slice(0, 20).map(t => ({ mint: t.mint, symbol: t.symbol }));
            if (pool.length > 0) await redis.set(cacheKey, JSON.stringify(pool), 'EX', 60);
        } catch (_) { /* fall through to fake fallback */ }
    }

    if (pool.length === 0) {
        return { mint: generateSimTokenCA(), symbol: 'SIMDEMO' }; 
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

export async function simExecuteSnipe(
    telegramId: string,
    tokenAddress: string,
    amountSol: number
): Promise<{ success: boolean, signature: string, message: string, volumeSpent: number }> {
    
    const currentBal = parseFloat(await getSimBalance(telegramId));
    if (currentBal < amountSol + 0.001) {
        return { 
            success: false, 
            signature: '', 
            message: `🔴 <b>Insufficient Funds.</b>\nYour simulated balance is only <b>${currentBal.toFixed(4)} SOL</b>. Use <code>/simbal $150000</code> to add more funds.`, 
            volumeSpent: 0 
        };
    }

    const delay = Math.random() > 0.95 ? (4000 + Math.random() * 6000) : (1500 + Math.random() * 3000);
    await new Promise(r => setTimeout(r, delay));

    const newBal = Math.max(0, currentBal - amountSol - 0.001).toFixed(4);
    await redis.set(`sim:balance:${telegramId}`, newBal);

    const posKey = `sim:positions:${telegramId}`;
    const existing = JSON.parse(await redis.get(posKey) || '[]');

    let symbol = 'UNKNOWN';
    let entryPriceSol = 0;
    let entryPriceUsd = 0;
    const solUsdPrice = 160;

    try {
        const { default: axios } = await import('axios');
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (res.data?.pairs?.length > 0) {
            symbol = res.data.pairs[0].baseToken.symbol;
            entryPriceUsd = parseFloat(res.data.pairs[0].priceUsd || "0");
        }
        const { getCachedTokenPrice } = await import('./engine.service.js');
        entryPriceSol = await getCachedTokenPrice(tokenAddress);
    } catch (e) {}

    if (entryPriceSol === 0) {
        entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(12));
        if (symbol === 'UNKNOWN') {
            const tokenNames = ['DEGEN', 'CHAD', 'PEPE', 'BONK', 'WIF', 'POPCAT', 'GIGA'];
            symbol = tokenNames[Math.floor(Math.random() * tokenNames.length)];
        }
    }
    if (entryPriceUsd === 0) entryPriceUsd = entryPriceSol * solUsdPrice;

    const tokenAmount = Math.floor(amountSol / entryPriceSol);

    existing.push({
        mint: tokenAddress, symbol, amount: tokenAmount, entryPrice: entryPriceSol,
        entryPriceUsd, priceUsd: entryPriceUsd, valueUsd: amountSol * solUsdPrice,
        amountInSol: amountSol, highestSeenPrice: entryPriceSol,
        entryScore: 75 // Default entry score for manual snipes so they have a slight positive bias
    });
    
    await redis.set(posKey, JSON.stringify(existing), 'EX', 3600);
    await recordSimTrade(telegramId, true, amountSol, 0);

    return { success: true, signature: generateSimSignature(), message: '🟢 Simulation: Jito bundle confirmed.', volumeSpent: amountSol };
}

export async function simExecuteExit(
    telegramId: string,
    tokenAddress: string,
    percent: number,
    forcedPnlPercent?: number 
): Promise<{ success: boolean, signature: string, message: string }> {
    
    await new Promise(r => setTimeout(r, 2000));

    const posKey = `sim:positions:${telegramId}`;
    const positions = JSON.parse(await redis.get(posKey) || '[]');
    const pos = positions.find((p: any) => p.mint === tokenAddress);

    // 🟢 FIX: Deny success if the position was already closed by a concurrent trigger
    if (!pos) {
        return { success: false, signature: '', message: '⚠️ No open simulated position found for this token (already closed).' };
    }

    let pnlPercent: number;
    if (forcedPnlPercent !== undefined) {
        pnlPercent = forcedPnlPercent;
    } else {
        const isProfit = await getNextSimOutcome(telegramId, 'guard');
        if (isProfit) pnlPercent = parseFloat((Math.random() * 180 + 10).toFixed(2)); 
        else pnlPercent = parseFloat((-(Math.random() * 45 + 5)).toFixed(2)); 
    }

    const soldSol = pos.amountInSol * (percent / 100);
    const rawReturn = soldSol * (1 + pnlPercent / 100);
    const platformFee = rawReturn * 0.01;
    const jitoTip = 0.0015;
    const netReturnSol = rawReturn - platformFee - jitoTip;

    const currentBal = parseFloat(await getSimBalance(telegramId));
    await redis.set(`sim:balance:${telegramId}`, (currentBal + netReturnSol).toFixed(4));

    if (percent === 100) {
        const updated = positions.filter((p: any) => p.mint !== tokenAddress);
        await redis.set(posKey, JSON.stringify(updated), 'EX', 3600);
    }
    
    await recordSimTrade(telegramId, false, soldSol, pnlPercent);
    
    // 🟢 CLAUDE FIX 4: Record stats natively to the rolling window
    const realizedPnlSol = netReturnSol - soldSol;
    await recordStatsEvent(telegramId, 'sim', realizedPnlSol);

    return { success: true, signature: generateSimSignature(), message: `🟢 Simulation: Sold ${percent}% | PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` };
}

// 🟢 FIX: Generate Caller Alert correctly using telegramId for deduplication
export async function generateSimCallerAlert(telegramId: string, filters: {
    minScore: number; maxAgeMins: number; minPctChange: number; maxPctChange: number; minLiquidity: number; minVolume24h: number; blockMev: boolean;
}): Promise<(ReturnType<typeof computeTokenScore> & { mint: string; symbol: string; ageMins: number; priceChangeM5: number; liquidity: number; volume: number; mevRisk: number; }) | null> {
    
    try {
        const hotRaw = await redis.get('caller:hot_scored_tokens');
        if (hotRaw) {
            const hotTokens = JSON.parse(hotRaw);
            const matching = hotTokens.filter((t: any) =>
                t.totalScore >= filters.minScore && t.ageMins <= filters.maxAgeMins &&
                t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange &&
                ((t.sourceQuality !== 'onchain-only' && t.volume >= filters.minVolume24h) || 
                 (t.sourceQuality === 'onchain-only' && t.liquidity >= filters.minLiquidity)) &&
                t.liquidity >= filters.minLiquidity &&
                (!filters.blockMev || t.breakdown?.mevRisk >= 0)
            );
            
            if (matching.length > 0) {
                // 🟢 Deduplication logic to force variety
                let bestMatch = null;
                for (const t of matching) {
                    const seen = await redis.get(`sim_alerted:${telegramId}:${t.mint}`);
                    if (!seen) {
                        bestMatch = t;
                        await redis.set(`sim_alerted:${telegramId}:${t.mint}`, '1', 'EX', 300); // Hide for 5 mins
                        break;
                    }
                }
                
                // If they have seen every single matching token in the snapshot, return null to wait for fresh blocks
                if (!bestMatch) return null;

                return {
                    mint: bestMatch.mint, symbol: bestMatch.symbol, score: bestMatch.totalScore, reasons: bestMatch.reasons || [],
                    ageMins: bestMatch.ageMins, priceChangeM5: bestMatch.priceChangeM5 || 0, mevRisk: bestMatch.breakdown?.mevRisk || 0,
                    liquidity: bestMatch.liquidity, volume: bestMatch.volume
                };
            }
        }
    } catch(e) {}

    // Fallback: Generate candidates but use REAL token identities so DexScreener links work
    const generateFakeTicker = () => {
        const consonants = 'BCDFGHJKLMNPRSTVWXYZ';
        const vowels = 'AEIOU';
        let ticker = '';
        const length = Math.floor(Math.random() * 2) + 3; 
        for (let i = 0; i < length; i++) {
            ticker += (i % 2 === 0) 
                ? consonants.charAt(Math.floor(Math.random() * consonants.length))
                : vowels.charAt(Math.floor(Math.random() * vowels.length));
        }
        if (Math.random() > 0.85) ticker += Math.floor(Math.random() * 9) + 1;
        return ticker;
    };

    const poolSize = 15; 
    const candidates = [];
    
    for (let i = 0; i < poolSize; i++) {
        const ageMins = Math.floor(Math.random() * 120) + 1; 
        const liqRand = Math.random();
        let liquidity = 0;
        if (liqRand < 0.70) liquidity = Math.random() * 7000 + 3000;         
        else if (liqRand < 0.95) liquidity = Math.random() * 15000 + 10000;  
        else liquidity = Math.random() * 55000 + 25000;                      

        const volRand = Math.random();
        let volume24h = 0;
        if (volRand < 0.60) volume24h = liquidity * (Math.random() * 2 + 0.5);      
        else if (volRand < 0.90) volume24h = liquidity * (Math.random() * 5 + 2);   
        else volume24h = liquidity * (Math.random() * 15 + 5);                      

        const momRand = Math.random();
        let priceChangeM5 = 0;
        if (momRand < 0.60) priceChangeM5 = (Math.random() * 15) - 10;        
        else if (momRand < 0.90) priceChangeM5 = (Math.random() * 25) + 5;    
        else priceChangeM5 = (Math.random() * 120) + 30;                      

        const hasSocials = Math.random() > 0.40; 
        const isRug = Math.random() < 0.08; 

        const stats: TokenStats = { ageMins, volume24h, liquidity, priceChangeM5: parseFloat(priceChangeM5.toFixed(1)), hasSocials, isRug };
        let { score, reasons } = computeTokenScore(stats);
        if (score >= 100) score = Math.floor(Math.random() * 7) + 92; 

        // 🟢 Attach a real token identity
        const realToken = await getRealTokenForSimDisplay();

        candidates.push({
            mint: realToken.mint, symbol: realToken.symbol, score, reasons, ageMins, priceChangeM5: stats.priceChangeM5,
            mevRisk: stats.isRug ? -100 : 0, liquidity: stats.liquidity, volume: stats.volume24h     
        });
    }

    const matching = candidates.filter(t =>
        t.score >= filters.minScore && t.ageMins <= filters.maxAgeMins &&
        t.priceChangeM5 >= filters.minPctChange && t.priceChangeM5 <= filters.maxPctChange &&
        t.liquidity >= filters.minLiquidity && t.volume >= filters.minVolume24h &&
        (!filters.blockMev || t.mevRisk >= 0)
    );

    if (matching.length > 0) {
        // 🟢 Apply deduplication to the fallback candidates as well
        let bestMatch = null;
        for (const t of matching) {
            const seen = await redis.get(`sim_alerted:${telegramId}:${t.mint}`);
            if (!seen) {
                bestMatch = t;
                await redis.set(`sim_alerted:${telegramId}:${t.mint}`, '1', 'EX', 300);
                break;
            }
        }
        return bestMatch; // Can be null if all are seen, mimicking live behavior
    }
    
    return null;
}

export async function getNextSimOutcome(telegramId: string, type: 'caller' | 'guard', score?: number): Promise<boolean> {
    // 🟢 FIX 9: Tie simulator win rate directly to real engine historical accuracy
    try {
        const historyMap = await redis.hgetall('caller_history');
        const calls = Object.values(historyMap).map((v: any) => JSON.parse(v)).filter((c: any) => c.finalized);
        const nearScore = calls.filter((c: any) => Math.abs(c.score - (score ?? 50)) <= 10);
        
        if (nearScore.length >= 5) {
            const hits = nearScore.filter((c: any) => Math.max(c.outcome1h || -100, c.outcome6h || -100, c.outcome24h || -100) >= 20).length;
            const empiricalProb = hits / nearScore.length;
            
            const lastKey = `sim:last_outcome:${type}:${telegramId}`;
            const last = await redis.get(lastKey);
            const streakNudge = last === 'true' ? 0.05 : last === 'false' ? -0.05 : 0;
            
            const finalProb = Math.min(0.9, Math.max(0.1, empiricalProb + streakNudge));
            const outcome = Math.random() < finalProb;
            await redis.set(lastKey, outcome ? 'true' : 'false', 'EX', 3600);
            return outcome;
        }
    } catch(e) {}

    // Fallback formula if not enough history
    const baseProb = score !== undefined ? 0.30 + (score / 100) * 0.45 : 0.5;
    const lastKey = `sim:last_outcome:${type}:${telegramId}`;
    const last = await redis.get(lastKey);
    const streakNudge = last === 'true' ? 0.05 : last === 'false' ? -0.05 : 0;
    const finalProb = Math.min(0.9, Math.max(0.1, baseProb + streakNudge));
    const outcome = Math.random() < finalProb;
    await redis.set(lastKey, outcome ? 'true' : 'false', 'EX', 3600);
    return outcome;
}

export async function toggleSimAutoSnipe(telegramId: string, bot: any): Promise<boolean> {
    const key = `sim:autosnipe:${telegramId}`;
    const current = await redis.get(key);
    const newState = current === 'true' ? 'false' : 'true';
    await redis.set(key, newState);
    if (newState === 'true') runSimAutoSnipeLoop(telegramId, bot);
    return newState === 'true';
}

async function runSimAutoSnipeLoop(telegramId: string, bot: any) {
    let totalSimSpent = 0;

    while (await redis.get(`sim:autosnipe:${telegramId}`) === 'true' && await isSimulationActive(telegramId)) {
        const user = await prisma.user.findUnique({ where: { telegramId: telegramId }, include: { autoSnipeConfig: true } });
        const config = user?.autoSnipeConfig;
        
        const amountSol = config?.amountSol || 0.1;
        const slPercent = config?.autoTrailingDropPercent || 20;
        const tpPercent = config?.autoTakeProfitPercent || 50; 
        const maxBudget = config?.maxBudgetSol || 10.0;
        const minScore = config?.minScore || 0;

        if (totalSimSpent + amountSol > maxBudget) {
            await bot.telegram.sendMessage(telegramId, `✅ <b>AUTO-SNIPER COMPLETE: Max Budget Reached</b>\n\nYour sniper has spent a total of <b>${totalSimSpent.toFixed(4)} SOL</b> and has automatically powered down.`, { parse_mode: 'HTML' });
            break;
        }

        let tokenCA = '';
        let simScore = 0;
        
        try {
            const hotRaw = await redis.get('caller:hot_scored_tokens');
            if (hotRaw) {
                const hotTokens = JSON.parse(hotRaw).filter((t:any) => t.totalScore >= minScore);
                if (hotTokens.length > 0) {
                    const pick = hotTokens[Math.floor(Math.random() * hotTokens.length)];
                    tokenCA = pick.mint; simScore = pick.totalScore;
                }
            }
        } catch(e) {}

        if (!tokenCA) {
            const rand = Math.random();
            if (rand < 0.6) simScore = Math.floor(Math.random() * 21) + 30;
            else if (rand < 0.9) simScore = Math.floor(Math.random() * 21) + 50;
            else simScore = Math.floor(Math.random() * 21) + 70;

            if (simScore < minScore) { await new Promise(r => setTimeout(r, 1500)); continue; }
            
            const realTok = await getRealTokenForSimDisplay();
            tokenCA = realTok.mint;
        }

        const isProfit = await getNextSimOutcome(telegramId, 'guard');
        const targetPnl = isProfit ? tpPercent : -Math.abs(slPercent);
        const finalPnl = applySimSlippage(targetPnl);

        const entryPriceSol = parseFloat((Math.random() * 0.000008 + 0.0000005).toFixed(10));
        const tokensBought = Math.floor(amountSol / entryPriceSol);

        const buyRes = await simExecuteSnipe(telegramId, tokenCA, amountSol);
        if (!buyRes.success) {
            await bot.telegram.sendMessage(telegramId, `🛑 <b>AUTO-SNIPER PAUSED:</b> Simulated balance insufficient.`, { parse_mode: 'HTML' });
            await redis.set(`sim:autosnipe:${telegramId}`, 'false');
            break;
        }
        totalSimSpent += amountSol;

        const buyMsg = 
            `🟢 <b>BUY & GUARD SUCCESSFUL!</b> \n\n` +
            `Token: <code>${tokenCA.substring(0,8)}...</code>\n` +
            `AI Score: <b>${simScore}/100</b> ⭐\n` +
            `Invested: <b>${amountSol} SOL</b>\n` +
            `Received: <b>${tokensBought.toLocaleString()} Tokens</b>\n` +
            `Entry Price: <b>${entryPriceSol.toFixed(9)} SOL</b>\n` +
            `Trailing Drop: <b>-${slPercent}%</b>\n` +
            `Take Profit: <b>${config?.autoTakeProfitPercent ? `+${tpPercent}%` : 'OFF'}</b>\n\n` +
            `🔗 <a href="https://solscan.io/tx/${buyRes.signature}">View on Solscan</a>`;
        
        await bot.telegram.sendMessage(telegramId, buyMsg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;

        await simExecuteExit(telegramId, tokenCA, 100, finalPnl);
        await sendSimPnlCard(telegramId, bot, tokenCA, amountSol, finalPnl, slPercent, entryPriceSol, tokensBought);

        await new Promise(r => setTimeout(r, 1500)); 
        if (await redis.get(`sim:autosnipe:${telegramId}`) !== 'true') break;
    }

    await redis.set(`sim:autosnipe:${telegramId}`, 'false');
}

async function sendSimPnlCard(telegramId: string, bot: any, tokenAddress: string, amountInSol: number, pnlPercent: number, slPercent: number, entryPriceSol: number, tokensBought: number) {
    const isProfit = pnlPercent >= 0;
    const exitSig = generateSimSignature();
    const exitPriceSol = entryPriceSol * (1 + pnlPercent / 100);
    const grossReturn = tokensBought * exitPriceSol;
    const platformFee = grossReturn * 0.01;
    const jitoTip = 0.0015;
    const pnlSol = grossReturn - amountInSol - platformFee - jitoTip;

    const pnlMessage = isProfit
        ? `💰 <b>Net Profit: +${Math.abs(pnlSol).toFixed(4)} SOL</b> (+${pnlPercent.toFixed(1)}%)`
        : `🩸 <b>Incurred Loss: -${Math.abs(pnlSol).toFixed(4)} SOL</b> (${pnlPercent.toFixed(1)}%)`;

    const captionText = `${isProfit ? '🎯 <b>TAKE PROFIT TRIGGERED!</b>' : '🚨 <b>TRAILING GUARD TRIGGERED!</b>'} \n\n` +
        `Token: <code>${tokenAddress.substring(0,8)}...</code>\n` +
        `Exit Price: <b>${exitPriceSol.toFixed(9)} SOL</b>\n` +
        `${!isProfit ? `📉 <b>Peak Drop: -${slPercent.toFixed(1)}%</b>\n` : ''}` +
        `${pnlMessage}\n` +
        `Status: 🟢 Auto-Sold 100% via Instant Pre-Signed Jito Bundle.\n` +
        `🔗 <a href="https://solscan.io/tx/${exitSig}">View on Solscan</a>`;

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        const imageBuffer = await generatePnlCard(tokenAddress, pnlPercent, user?.referralCode ?? undefined);
        const hostUrl = process.env.WEBAPP_URL || 'http://localhost:3001';
        const imgId = crypto.randomBytes(8).toString('hex');
        await redis.set(`pnl_img:${imgId}`, imageBuffer.toString('base64'), 'EX', 259200); 
        const shareUrl = `${hostUrl}/share/${imgId}?ref=${user?.referralCode || ''}`;
        const tweetText = encodeURIComponent(`Just secured a verified ${pnlPercent >= 0 ? `gain of +${pnlPercent.toFixed(1)}%` : `loss protection`} on $${tokenAddress.substring(0,6).toUpperCase()} using Sentry Terminal ⚡\n\nCopy my trades and earn passive SOL here 👇\n${shareUrl}`);
        const twitterBtn = { inline_keyboard: [[{ text: '🐦 Share & Earn on X', url: `https://twitter.com/intent/tweet?text=${tweetText}` }]] };

        await bot.telegram.sendPhoto(
            telegramId, { source: imageBuffer },
            { caption: captionText, parse_mode: 'HTML', reply_markup: twitterBtn }
        );
    } catch (e: any) {
        try { await bot.telegram.sendMessage(telegramId, captionText, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); } catch (_) {}
    }
}

export async function walkSimPositionPrices(telegramId: string): Promise<void> {
    const posKey = `sim:positions:${telegramId}`;
    const raw = await redis.get(posKey);
    if (!raw) return;

    const positions = JSON.parse(raw);
    if (positions.length === 0) return;

    let changed = false;
    for (const p of positions) {
        // 🟢 FIX 10: Score-aware drift logic. High AI scores mathematically drift upwards more often.
        const scoreBias = ((p.entryScore ?? 50) - 50) / 50; // Returns -1.0 to +1.0
        const stepPct = (Math.random() - 0.5 + scoreBias * 0.4) * 6; 

        const newPriceUsd = Math.max(p.entryPriceUsd * 0.05, p.priceUsd * (1 + stepPct / 100));


        p.priceUsd = newPriceUsd;
        p.valueUsd = p.amount * newPriceUsd;
        if (newPriceUsd > (p.highestSeenPrice || 0)) p.highestSeenPrice = newPriceUsd;
        changed = true;
    }

    if (changed) await redis.set(posKey, JSON.stringify(positions), 'EX', 3600);
}