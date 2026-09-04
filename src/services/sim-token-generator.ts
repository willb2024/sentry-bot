// src/services/sim-token-generator.ts
import { redis } from '../lib/redis.js';

export const SIM_TICK_MS = 3000;

const PREFIX = ['Turbo','Giga','Hyper','Quantum','Neon','Solar','Cyber','Astro','Vault','Sentry','Blaze','Nova','Prime','Echo','Volt','Zenith','Onyx','Lunar','Titan','Vertex'];
const CORE   = ['Doge','Pepe','Shiba','Cat','Wif','Bonk','Floki','Moon','Chad','Wojak','Frog','Ape','Bull','Fox','Wolf','Panda','Dragon','Phoenix','Yeti','Kong'];
const SUFFIX = ['Inu','Coin','Fi','Dao','X','AI','Labs','Protocol','Network','Chain','',''];

function pick<T>(arr: T[]): T { 
    return arr[Math.floor(Math.random() * arr.length)]; 
}

function generateSimMint(): string {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let out = 'SIM';
    for (let i = 0; i < 41; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

export function generateBandedScore(minScore: number): number {
    const floor = Math.min(Math.max(minScore + 10, 55), 90);
    const ceil  = Math.max(Math.min(floor + 35, 98), floor + 5);
    return Math.round(floor + Math.random() * (ceil - floor));
}

export interface SimToken {
    mint: string;
    name: string;
    symbol: string;
    score: number;
    priceSol: number;
    marketCapUsd: number;
    liquidityUsd: number;
    volume24hUsd: number;
    holders: number;
    devHoldPercent: number;
    lpLocked: boolean;
    ageSeconds: number;
    source: 'PUMP' | 'RAYDIUM';
    createdAt: number;
    isSimulated: true;
}

export function generateSimToken(opts: {
    minScore: number;
    mode?: 'PUMP' | 'RAYDIUM' | 'BOTH';
    minMarketCap?: number;
    maxMarketCap?: number;
    maxDevBuyPercent?: number;
}): SimToken {
    const score = generateBandedScore(opts.minScore ?? 45);
    const mode: 'PUMP' | 'RAYDIUM' = opts.mode === 'BOTH' || !opts.mode
        ? (Math.random() < 0.7 ? 'PUMP' : 'RAYDIUM')
        : opts.mode;

    const q = score / 100;
    const minMc = Math.max(opts.minMarketCap || 8_000, 1_000);
    const maxMc = Math.max(opts.maxMarketCap || 400_000, minMc * 2);
    const marketCapUsd = Math.exp(
        Math.log(minMc) + Math.random() * (Math.log(maxMc) - Math.log(minMc))
    );

    const liquidityUsd = marketCapUsd * (0.04 + q * 0.16);
    const volume24hUsd = marketCapUsd * (0.2 + Math.random() * 2.5 * q);
    const holders = Math.round(20 + q * 900 + Math.random() * 200);

    const devCap = opts.maxDevBuyPercent ?? 20;
    const devHoldPercent = parseFloat((Math.random() * Math.min(devCap * 0.8, (1 - q) * 25)).toFixed(2));
    const priceSol = marketCapUsd / 1_000_000_000 / 150;

    const p = pick(PREFIX), c = pick(CORE), s = pick(SUFFIX);
    const name = `${p} ${c}${s ? ' ' + s : ''}`.trim();
    const symbol = (c.slice(0, 4) + (s ? s.slice(0, 2) : p.slice(0, 2))).toUpperCase();

    return {
        mint: generateSimMint(),
        name,
        symbol,
        score,
        priceSol,
        marketCapUsd: Math.round(marketCapUsd),
        liquidityUsd: Math.round(liquidityUsd),
        volume24hUsd: Math.round(volume24hUsd),
        holders,
        devHoldPercent,
        lpLocked: Math.random() < (0.5 + q * 0.45),
        ageSeconds: Math.round(5 + Math.random() * 600),
        source: mode,
        createdAt: Date.now(),
        isSimulated: true,
    };
}

export function generateSimOutcome(score: number): {
    winProbability: number;
    pnlPercent: number;
    peakPercent: number;
    durationMs: number;
} {
    const q = Math.min(Math.max(score, 0), 100) / 100;
    const winProbability = 0.30 + q * 0.38;
    const isWin = Math.random() < winProbability;

    let pnlPercent: number;
    if (isWin) {
        const roll = Math.random();
        if (roll < 0.06) pnlPercent = 180 + Math.random() * 900 * q;
        else if (roll < 0.28) pnlPercent = 45 + Math.random() * 140;
        else pnlPercent = 6 + Math.random() * 40;
    } else {
        const roll = Math.random();
        if (roll < 0.12) pnlPercent = -(70 + Math.random() * 28);
        else pnlPercent = -(4 + Math.random() * 45);
    }

    const peakPercent = isWin
        ? pnlPercent * (1.1 + Math.random() * 0.5)
        : Math.max(0, Math.random() * 22);

    return {
        winProbability,
        pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        peakPercent: parseFloat(peakPercent.toFixed(2)),
        durationMs: Math.round(20_000 + Math.random() * 400_000),
    };
}

export function passesSimFilters(
    t: SimToken,
    cfg: { minScore: number; minMarketCap?: number; maxMarketCap?: number; maxDevBuyPercent?: number; targetMode?: string },
): { pass: boolean; reason?: string } {
    if (t.score < cfg.minScore) return { pass: false, reason: `Score ${t.score} < ${cfg.minScore}` };
    if (cfg.minMarketCap && t.marketCapUsd < cfg.minMarketCap) return { pass: false, reason: `MC $${t.marketCapUsd} below min` };
    if (cfg.maxMarketCap && t.marketCapUsd > cfg.maxMarketCap) return { pass: false, reason: `MC $${t.marketCapUsd} above max` };
    if (cfg.maxDevBuyPercent && t.devHoldPercent > cfg.maxDevBuyPercent) return { pass: false, reason: `Dev holds ${t.devHoldPercent}%` };
    if (cfg.targetMode && cfg.targetMode !== 'BOTH' && t.source !== cfg.targetMode) return { pass: false, reason: `Source ${t.source} filtered` };
    return { pass: true };
}

export function generateSimCallerToken(minScore = 45): SimToken & {
    projectedMultiple: number;
    confidence: number;
    reasons: string[];
} {
    const t = generateSimToken({ minScore });
    const q = t.score / 100;
    const reasonPool = [
        'Liquidity depth expanding',
        'Holder velocity accelerating',
        'LP locked, dev wallet clean',
        'Volume/MC ratio above cohort median',
        'No sandwich activity detected',
        'Bonding curve progressing steadily',
        'Early holder concentration falling',
    ];
    const reasons: string[] = [];
    while (reasons.length < 3) {
        const r = pick(reasonPool);
        if (!reasons.includes(r)) reasons.push(r);
    }
    return {
        ...t,
        projectedMultiple: parseFloat((1.2 + q * 4 + Math.random() * 2).toFixed(2)),
        confidence: Math.round(50 + q * 45),
        reasons,
    };
}