// src/services/caller.service.ts
import { PrismaClient } from '@prisma/client';
import { redis } from '../lib/redis.js';
import axios from 'axios';
import { getRecentNewMints } from './grpc.service.js';
import { rpcLimiter } from '../lib/rpc-limiter.js';

const prisma = new PrismaClient();
const BASE58_MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface CallerFilters {
    isActive: boolean;
    minScore: number;
    maxAgeMins: number;
    minPctChange: number;
    maxPctChange: number;
    minLiquidity: number; 
    minVolume24h: number; 
    blockMev: boolean;
    minHolders: number;
    maxSupply: number;
    minLiquidityLockPercent: number;
}

export async function getUserCallerFilters(telegramId: string): Promise<CallerFilters> {
    const defaultFilters: CallerFilters = {
        isActive: false,
        minScore: 55,
        maxAgeMins: 90,
        minPctChange: 10,
        maxPctChange: 500,
        minLiquidity: 2000, 
        minVolume24h: 2000, 
        blockMev: true,
        minHolders: 50,
        maxSupply: 1_000_000_000,
        minLiquidityLockPercent: 0
    };

    try {
        const raw = await redis.get(`caller_filters:${telegramId}`);
        if (raw) return { ...defaultFilters, ...JSON.parse(raw) };
    } catch (e) {}

    return defaultFilters;
}

export async function setUserCallerFilters(telegramId: string, updates: Partial<CallerFilters>) {
    const current = await getUserCallerFilters(telegramId);
    const updated = { ...current, ...updates };
    await redis.set(`caller_filters:${telegramId}`, JSON.stringify(updated));
    return updated;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export function humanizeMs(ms: number): string {
    const mins = ms / 60000;
    if (mins < 60) return `~${Math.round(mins)} Minutes`;
    if (mins < 1440) return `~${(mins / 60).toFixed(1)} Hours`;
    return `~${(mins / 1440).toFixed(1)} Days`;
}

export function getScoreBand(score: number): { label: string; sizeSol: string; risk: string } {
    if (score < 40) return { label: '🔵 Too Early', sizeSol: '0.01-0.02 SOL (watchlist only)', risk: 'Unproven — no real signal yet' };
    if (score < 60) return { label: '🟡 Speculative', sizeSol: '0.02-0.05 SOL', risk: 'Weak confirmation — lottery-ticket sizing' };
    if (score < 75) return { label: '🟠 Developing', sizeSol: '0.05-0.1 SOL', risk: 'Multiple signals confirmed' };
    return { label: '🟢 High Conviction', sizeSol: '0.1-0.2 SOL', risk: 'Strong confirmation across categories' };
}

// ------------------ ML Training & Features ------------------

async function getCachedRugStatus(mint: string): Promise<{ isRug: boolean; top10Pct: number; uncertain: boolean }> {
    const cacheKey = `rug_status_ext:${mint}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (!parsed.uncertain) return parsed;
        }

        const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { timeout: 4000 });
        const data = res.data;
        const risks = data.risks || [];
        const isHoneypot = risks.some((r: any) => r.name === 'Freeze Authority still enabled');
        const isMintable = !!(data.token && data.token.mintAuthority);
        const topHolders = data.topHolders || [];
        const top10Pct = topHolders.reduce((acc: number, h: any) => acc + (h.pct || 0), 0);
        const isUnsafe = isHoneypot || isMintable || (data.score > 500) || top10Pct > 40.0;

        const result = { isRug: isUnsafe, top10Pct, uncertain: false };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    } catch (_) {
        const result = { isRug: true, top10Pct: 0, uncertain: true };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 45); 
        return result;
    }
}

export async function getSentimentScore(tokenSymbol: string): Promise<number> {
    if (!tokenSymbol || tokenSymbol === 'UNKNOWN') return 0.5;
    const cacheKey = `sentiment:${tokenSymbol.toUpperCase()}`;
    const cached = await redis.get(cacheKey);
    if (cached) return parseFloat(cached);

    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) return 0.5;

    try {
        const res = await axios.get(`https://api.twitter.com/2/tweets/search/recent?query=$${encodeURIComponent(tokenSymbol)}&max_results=10`, {
            headers: { Authorization: `Bearer ${bearerToken}` },
            timeout: 2000
        });
        const tweetCount = res.data?.meta?.result_count || 0;
        const sentiment = Math.min(1.0, 0.4 + (tweetCount / 20));
        await redis.set(cacheKey, sentiment.toString(), 'EX', 600);
        return sentiment;
    } catch (_) {
        return 0.5;
    }
}

function extractFeatures(token: any): number[] {
    const score = token.totalScore ?? token.score ?? 50;
    const age = token.ageMins ?? 10;
    const liq = Math.log(Math.max(token.liquidity || 0, 1));
    const vol = Math.log(Math.max(token.volume || token.volume24h || 0, 1));
    const mom = token.priceChangeM5 ?? 0;
    const hasSocials = token.socials?.length > 0 ? 1 : 0;
    const isRug = token.isRug ? 1 : 0;
    const lockPct = token.stats?.lpLock?.lockPct ?? 0;
    const velocity = token.stats?.velocity?.growthRate ?? 0;
    return [score, age, liq, vol, mom, hasSocials, isRug, lockPct, velocity];
}

function solveOLS(X: number[][], y: number[]): { coefficients: number[], intercept: number } {
    const n = X.length;
    const p = X[0].length;
    
    try {
        const X_ext = X.map(row => [1, ...row]);
        const XtX = Array.from({ length: p + 1 }, () => Array(p + 1).fill(0));
        const Xty = Array(p + 1).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j <= p; j++) {
                for (let k = 0; k <= p; k++) {
                    XtX[j][k] += X_ext[i][j] * X_ext[i][k];
                }
                Xty[j] += X_ext[i][j] * y[i];
            }
        }

        let weights = new Array(p + 1).fill(0.01);
        const lr = 0.0001;
        for(let iter=0; iter<1000; iter++){
            let gradients = new Array(p+1).fill(0);
            for(let i=0; i<n; i++){
                let pred = 0;
                for(let j=0; j<=p; j++) pred += weights[j] * X_ext[i][j];
                const err = pred - y[i];
                for(let j=0; j<=p; j++) gradients[j] += err * X_ext[i][j];
            }
            for(let j=0; j<=p; j++) weights[j] -= lr * (gradients[j] / n);
        }

        return { intercept: weights[0], coefficients: weights.slice(1) };
    } catch(e) {
        return { coefficients: new Array(p).fill(0), intercept: 0 };
    }
}

interface NormalizationParams { means: number[]; stds: number[]; }

function computeNormalization(X: number[][]): NormalizationParams {
    const p = X[0].length;
    const means = new Array(p).fill(0);
    const stds = new Array(p).fill(1);
    for (let j = 0; j < p; j++) {
        const col = X.map(row => row[j]);
        const mean = col.reduce((a, b) => a + b, 0) / col.length;
        const variance = col.reduce((sum, v) => sum + (v - mean) ** 2, 0) / col.length;
        const std = Math.sqrt(variance);
        means[j] = mean;
        stds[j] = std > 1e-8 ? std : 1; 
    }
    return { means, stds };
}

function normalizeRow(row: number[], norm: NormalizationParams): number[] {
    return row.map((v, j) => (v - norm.means[j]) / norm.stds[j]);
}

function solveRidgeRegression(X: number[][], y: number[], lambda: number = 0.1): { coefficients: number[], intercept: number } {
    const n = X.length;
    const p = X[0].length;
    let weights = new Array(p).fill(0);
    let intercept = 0;
    const lr = 0.05; 
    const epochs = 2000;

    for (let iter = 0; iter < epochs; iter++) {
        let interceptGrad = 0;
        const weightGrads = new Array(p).fill(0);
        for (let i = 0; i < n; i++) {
            let pred = intercept;
            for (let j = 0; j < p; j++) pred += weights[j] * X[i][j];
            const err = pred - y[i];
            interceptGrad += err;
            for (let j = 0; j < p; j++) weightGrads[j] += err * X[i][j] + lambda * weights[j];
        }
        intercept -= lr * (interceptGrad / n);
        for (let j = 0; j < p; j++) weights[j] -= lr * (weightGrads[j] / n);
    }
    return { coefficients: weights, intercept };
}

function predictNormalized(row: number[], weights: number[], intercept: number): number {
    let pred = intercept;
    for (let j = 0; j < row.length; j++) pred += weights[j] * row[j];
    return pred;
}

export async function trainCallerModel() {
    try {
        const predictions = await prisma.callerPrediction.findMany({
            where: { finalized: true, peakPct: { not: null } },
            orderBy: { alertedAt: 'asc' }
        });

        if (predictions.length < 60) {
            console.log(`🧠 [CALLER ML] Skipping training — only ${predictions.length} samples (need 60+).`);
            return;
        }

        const rawX: number[][] = [];
        const y: number[] = [];

        for (const p of predictions) {
            rawX.push([
                p.score, p.ageMins, Math.log(p.liquidity + 1), Math.log(p.volume24h + 1),
                p.priceChangeM5, p.hasSocials ? 1 : 0, p.isRug ? 1 : 0, p.lpLockPct ?? 0, p.velocityGrowth ?? 0
            ]);
            y.push(Math.log(Math.max(0, p.peakPct!) + 1));
        }

        const indices = Array.from({ length: rawX.length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        const splitAt = Math.floor(indices.length * 0.8);
        const trainIdx = indices.slice(0, splitAt);
        const valIdx = indices.slice(splitAt);

        const trainX = trainIdx.map(i => rawX[i]);
        const trainY = trainIdx.map(i => y[i]);
        const valX = valIdx.map(i => rawX[i]);
        const valY = valIdx.map(i => y[i]);

        const norm = computeNormalization(trainX);
        const trainXNorm = trainX.map(row => normalizeRow(row, norm));
        const valXNorm = valX.map(row => normalizeRow(row, norm));

        const { coefficients, intercept } = solveRidgeRegression(trainXNorm, trainY, 0.1);

        const valMean = valY.reduce((a, b) => a + b, 0) / valY.length;
        let ssTot = 0, ssRes = 0;
        for (let i = 0; i < valY.length; i++) {
            const pred = predictNormalized(valXNorm[i], coefficients, intercept);
            ssTot += (valY[i] - valMean) ** 2;
            ssRes += (valY[i] - pred) ** 2;
        }
        const valR2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

        const featureNames = ['score', 'age', 'log_liquidity', 'log_volume', 'momentum', 'socials', 'rug', 'lock_pct', 'velocity'];
        console.log(`🧠 [CALLER ML] Trained on ${trainX.length} samples, validated on ${valX.length}. Out-of-sample R² = ${valR2.toFixed(3)}`);

        const MIN_VAL_R2 = 0.15;
        const isUsable = valR2 >= MIN_VAL_R2;

        await redis.set('caller_model_weights', JSON.stringify({
            version: 1, trainedAt: Date.now(), coefficients, featureNames, intercept,
            normalization: norm, metrics: { valR2, trainSampleCount: trainX.length, valSampleCount: valX.length, isUsable }
        }));

        if (!isUsable) console.warn(`⚠️ [CALLER ML] Model validation R² (${valR2.toFixed(3)}) below threshold (${MIN_VAL_R2}). Marked unusable — will fall back to heuristic scoring.`);
    } catch (e) {
        console.error(`🔴 [CALLER ML] Training Failed:`, e);
    }
}

export async function getModelScore(mint: string, stats: any): Promise<number | null> {
    try {
        const weightsRaw = await redis.get('caller_model_weights');
        if (!weightsRaw) return null;
        const weights = JSON.parse(weightsRaw);

        if (weights.metrics?.isUsable === false) return null; 

        const features = extractFeatures({ ...stats, mint });
        const normFeatures = weights.normalization
            ? features.map((f: number, i: number) => (f - weights.normalization.means[i]) / weights.normalization.stds[i])
            : features;

        const logPred = weights.intercept + normFeatures.reduce((sum: number, f: number, i: number) => sum + f * weights.coefficients[i], 0);
        const predictedPeak = Math.max(0, Math.exp(logPred) - 1);

        if (predictedPeak > 0) return Math.min(100, Math.max(0, Math.log(predictedPeak + 1) * 20));
    } catch (e) { }
    return null;
}

export async function scheduleTraining() {
    let lastTrainedCount = 0;
    setInterval(async () => {
        try {
            const currentCount = await prisma.callerPrediction.count({ where: { finalized: true, peakPct: { not: null } } });
            const newSamples = currentCount - lastTrainedCount;
            if (newSamples >= 20) {
                console.log(`🧠 [CALLER ML] ${newSamples} new finalized predictions since last train — retraining.`);
                await trainCallerModel();
                lastTrainedCount = currentCount;
            } else {
                console.log(`🧠 [CALLER ML] Only ${newSamples} new samples — skipping retrain.`);
            }
        } catch (e) {
            console.error('🔴 [CALLER ML] Scheduled training check failed:', e);
        }
    }, 24 * 60 * 60 * 1000); 
}

export async function storePredictionData(token: any, projection: any, alertKey: string) {
    try {
        await prisma.callerPrediction.upsert({
            where: { alertKey },
            update: {},
            create: {
                alertKey,
                mint: token.mint,
                symbol: token.symbol,
                score: token.totalScore ?? token.score ?? 0,
                ageMins: token.ageMins ?? 0,
                liquidity: token.liquidity ?? 0,
                volume24h: token.volume ?? token.volume24h ?? 0,
                priceChangeM5: token.priceChangeM5 ?? 0,
                hasSocials: (token.socials?.length ?? 0) > 0,
                isRug: token.isRug ?? false,
                sourceQuality: token.sourceQuality ?? 'unknown',
                devLaunchCount: token.stats?.devRep?.launchCount ?? 0,
                lpLockPct: token.stats?.lpLock?.lockPct ?? 0,
                velocityGrowth: token.stats?.velocity?.growthRate ?? 0,
                predictedLow: projection.rawLow,
                predictedHigh: projection.rawHigh,
                predictedTimeMins: projection.rawTimeMins,
                alertedAt: new Date()
            }
        });
    } catch(e) {}
}

export async function getCalibratedProjection(token: any) {
    const features = extractFeatures(token);
    
    // ML Prediction Route
    try {
        const weightsRaw = await redis.get('caller_model_weights');
        if (weightsRaw) {
            const weights = JSON.parse(weightsRaw);
            if (weights.metrics?.isUsable !== false && weights.coefficients && weights.coefficients.length === features.length) {
                const normFeatures = weights.normalization
                    ? features.map((f: number, i: number) => (f - weights.normalization.means[i]) / weights.normalization.stds[i])
                    : features;
                const logPred = (weights.intercept || 0) + normFeatures.reduce((sum: number, f: number, i: number) => sum + f * (weights.coefficients[i] || 0), 0);
                const modelPeak = Math.max(0, Math.exp(logPred) - 1);
                
                if (modelPeak > 0) {
                    const residualStd = 0.5;
                    const low = Math.max(0, modelPeak - 1.96 * residualStd);
                    const high = modelPeak + 1.96 * residualStd;
                    const timeframe = humanizeMs((token.ageMins || 10) * 60000 * 2);
                    const sampleCount = (weights.metrics?.trainSampleCount || 0) + (weights.metrics?.valSampleCount || 0);

                    return {
                        target: `+${Math.floor(low)}% to +${Math.floor(high)}%`,
                        timeframe,
                        volatility: `ML Model (${sampleCount} samples)`,
                        sampleSize: sampleCount,
                        rawLow: low,
                        rawHigh: high, 
                        rawTimeMins: (token.ageMins || 10) * 2
                    };
                }
            }
        }
    } catch (_) {}

    // Standard Heuristic Route Fallback
    const historyMap = await redis.hgetall('caller_history');
    const calls = Object.values(historyMap).map((v: any) => JSON.parse(v)).filter((c: any) => c.finalized && c.peakPct !== undefined);

    const scoreBand = 15;   
    const similar = calls.filter((c: any) =>
        Math.abs((c.score ?? 50) - (token.score ?? token.totalScore ?? 50)) <= scoreBand
    );

    if (similar.length >= 8) {
        const sortedPct = similar.map((c: any) => c.peakPct).sort((a: number, b: number) => a - b);
        const sortedTime = similar.map((c: any) => c.peakAtMs).sort((a: number, b: number) => a - b);
        const p25 = sortedPct[Math.floor(sortedPct.length * 0.25)];
        const p75 = sortedPct[Math.floor(sortedPct.length * 0.75)];
        const medianTimeMs = sortedTime[Math.floor(sortedTime.length * 0.5)];

        return {
            target: `+${Math.max(0, p25).toFixed(0)}% to +${Math.max(p25 + 1, p75).toFixed(0)}%`,
            timeframe: humanizeMs(medianTimeMs),
            volatility: `Calibrated (${similar.length} past alerts)`,
            sampleSize: similar.length,
            rawLow: Math.max(0, p25),
            rawHigh: Math.max(p25 + 1, p75),
            rawTimeMins: medianTimeMs / 60000
        };
    }

    const score = token.score ?? token.totalScore ?? 50;
    const liq = token.liquidity || 5000;
    const mom = token.priceChangeM5 || 10;
    const age = token.ageMins || 10;

    let baseMultiplier = (score / 100) * 4.5; 
    let liqMultiplier = Math.max(0.5, 20000 / Math.max(liq, 1000)); 
    let momMultiplier = 1 + (Math.min(mom, 300) / 100); 

    let minPeak = baseMultiplier * liqMultiplier * momMultiplier * 100;
    let maxPeak = minPeak * 1.5; 

    if (minPeak > 5000) minPeak = 3500;
    if (maxPeak > 10000) maxPeak = 7000;
    if (minPeak < 20) { minPeak = 20; maxPeak = 50; }

    let timeframe = "1 - 4 Hours";
    let rawTimeMins = 120;
    if (age < 15 && mom > 50) { timeframe = "10 - 30 Minutes"; rawTimeMins = 20; }
    else if (age < 60) { timeframe = "30 - 90 Minutes"; rawTimeMins = 60; }
    else if (liq > 50000) { timeframe = "12 - 24 Hours"; rawTimeMins = 720; }

    return {
        target: `+${Math.floor(minPeak).toLocaleString()}% to +${Math.floor(maxPeak).toLocaleString()}%`,
        timeframe,
        volatility: 'Preliminary Estimate (Building History)',
        sampleSize: similar.length,
        rawLow: minPeak,
        rawHigh: maxPeak,
        rawTimeMins
    };
}

export async function formatCallerAlertMessage(
    matchedToken: any,
    projection: Awaited<ReturnType<typeof getCalibratedProjection>>,
    opts: { isRelaxed?: boolean; isReshow?: boolean } = {}
): Promise<string> {
    const band = getScoreBand(matchedToken.totalScore ?? matchedToken.score);
    const projLabel = projection.sampleSize >= 8
        ? '🔮 <b>AI PROJECTION (Calibrated)</b>'
        : '🔮 <b>AI PROJECTION (Uncalibrated Estimate)</b>';

    let historicalContext = "";
    try {
        const historyMap = await redis.hgetall('caller_history');
        const calls = Object.values(historyMap).map((v: any) => JSON.parse(v)).filter((c: any) => c.finalized && c.score >= 75);
        if (calls.length >= 5) {
            const hits = calls.filter((c: any) => Math.max(c.outcome1h ?? -100, c.outcome6h ?? -100, c.outcome24h ?? -100) >= 20).length;
            const winRate = ((hits / calls.length) * 100).toFixed(1);
            historicalContext = `<i>(Based on ${calls.length} verified alerts, coins scoring 75+ have a ${winRate}% win rate hitting +20%).</i>\n\n`;
        }
    } catch (_) {}

    const relaxNote = opts.isRelaxed ? `⚠️ <i>Filters temporarily relaxed to find this match.</i>\n\n` : '';
    const reshowNote = opts.isReshow ? `⚠️ <i>Showing previously seen top match (waiting for new tokens).</i>\n\n` : '';

    return `🎯 <b>SOLANA BREAKOUT DETECTED!</b>\n\n` +
        reshowNote + relaxNote +
        `<b>Token:</b> $${matchedToken.symbol} (<code>${matchedToken.mint}</code>)\n` +
        `<b>Score:</b> ${matchedToken.totalScore ?? matchedToken.score}/100 ⭐\n\n` +
        `${band.label} — Suggested size: <b>${band.sizeSol}</b>\n<i>${band.risk}</i>\n\n` +
        `${projLabel}\n` +
        `• Confidence: <b>${projection.volatility}</b>\n` +
        `• Target Peak: <b>${projection.target}</b>\n` +
        `• Est. Timeframe: <b>${projection.timeframe}</b>\n\n` +
        `<b>Audit Trail:</b>\n${(matchedToken.reasons || []).map((r: string) => `✅ ${r}`).join('\n')}\n\n` +
        historicalContext +
        `<i>Click below to buy instantly via Jito:</i>`;
}

// 🟢 NEW: Unified Audit Trail Formatter (Fix 8)
export function buildAuditTrailMessage(
    mint: string,
    score: number,
    stats: { ageMins: number; volume: number; liquidity: number; priceChangeM5: number },
    invested: number,
    trailingDrop: number,
    takeProfit: number | string,
    isSimulated: boolean
): string {
    return `🟢 <b>BUY & GUARD SUCCESSFUL!${isSimulated ? ' (SIM)' : ''}</b>\n\n` +
           `Token: <code>${mint.substring(0, 8)}...</code>\n` +
           `AI Score: ${score}/100 ⭐\n\n` +
           `Audit Trail:\n` +
           `${stats.ageMins < 60 ? '✅' : '⚠️'} 🕐 Age: ${Math.floor(stats.ageMins)}m\n` +
           `${stats.volume > 20000 ? '✅' : '⚠️'} 💰 Vol: $${(stats.volume / 1000).toFixed(1)}k\n` +
           `${stats.priceChangeM5 > 15 ? '✅' : '⚠️'} 📈 Mom: ${stats.priceChangeM5 >= 0 ? '+' : ''}${stats.priceChangeM5.toFixed(1)}%\n` +
           `${stats.liquidity > 20000 ? '✅' : '⚠️'} 💧 Liq: $${(stats.liquidity / 1000).toFixed(1)}k\n\n` +
           `Invested: <b>${invested} SOL</b>\n` +
           `Trailing Drop: <b>-${trailingDrop}%</b>\n` +
           `Take Profit: <b>${typeof takeProfit === 'number' ? '+' + takeProfit + '%' : takeProfit}</b>`;
}

export function getMatchesWithLadder(tokens: any[], filters: CallerFilters): { matches: any[]; isRelaxed: boolean } {
    const steps = [
        filters,
        { ...filters, minScore: Math.max(20, filters.minScore - 10), maxAgeMins: filters.maxAgeMins * 1.25, minLiquidity: filters.minLiquidity * 0.75, minVolume24h: filters.minVolume24h * 0.75 },
        { ...filters, minScore: Math.max(15, filters.minScore - 20), maxAgeMins: filters.maxAgeMins * 1.6,  minLiquidity: filters.minLiquidity * 0.4,  minVolume24h: filters.minVolume24h * 0.4  },
    ];
    for (let i = 0; i < steps.length; i++) {
        const f = steps[i];
        const matches = tokens.filter((t: any) =>
            t.totalScore >= f.minScore &&
            t.ageMins <= f.maxAgeMins &&
            (t.sourceQuality === 'onchain-only' || (t.priceChangeM5 >= f.minPctChange && t.priceChangeM5 <= f.maxPctChange)) &&
            ((t.sourceQuality !== 'onchain-only' && t.volume >= f.minVolume24h) || (t.sourceQuality === 'onchain-only' && t.liquidity >= f.minLiquidity)) &&
            t.liquidity >= f.minLiquidity &&
            (!f.blockMev || (t.breakdown && t.breakdown.mevRisk >= 0)) &&
            (f.minLiquidityLockPercent === 0 || (t.stats?.lpLock?.lockPct >= f.minLiquidityLockPercent))
        );
        if (matches.length > 0) return { matches, isRelaxed: i > 0 };
    }
    return { matches: [], isRelaxed: false };
}

let isScoring = false;

// 🟢 FAST DUAL-SPEED CALLER ENGINE
export async function startCoinCaller(bot: any) {
    console.log("🎯 [CALLER ENGINE] Initialized. Live loop (15s) & Sim loop (5s) active.");

    // 1️⃣ FAST 5-SECOND SIMULATION CALLER LOOP
    setInterval(async () => {
        try {
            const { isSimulationActive, generateSimCallerAlert } = await import('./simulation.service.js');
            const allUsers = await prisma.user.findMany({ select: { id: true, telegramId: true } });

            for (const user of allUsers) {
                const isSim = await isSimulationActive(user.telegramId);
                if (!isSim) continue; 

                const filters = await getUserCallerFilters(user.telegramId);
                if (!filters.isActive) continue; 

                const matchedToken = await generateSimCallerAlert(user.telegramId, filters);
                if (matchedToken) {
                    const projection = await getCalibratedProjection(matchedToken);
                    const msg = await formatCallerAlertMessage(matchedToken, projection, { isReshow: matchedToken.isReshow });

                    const userConfig = await prisma.autoSnipeConfig.findUnique({ where: { userId: user.id } });
                    const defaultSize = userConfig?.amountSol || 0.1;

                    try {
                        await bot.telegram.sendMessage(user.telegramId, msg, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `⚡ Snipe ${defaultSize} SOL`, callback_data: `forcebuy_${matchedToken.mint}_${defaultSize}` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
                                    [{ text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` }, { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }],
                                    [{ text: '⬅️ Manage Caller Settings', callback_data: 'menu_caller' }]
                                ]
                            }
                        });
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }, 5000); 

    // 2️⃣ STANDARD 15-SECOND LIVE MAINNET CALLER LOOP
    setInterval(async () => {
        if (isScoring) return;
        isScoring = true;

        try {
            const { isSimulationActive } = await import('./simulation.service.js');
            const tokens = await scoreTokens();
            if (tokens.length === 0) return;

            const allUsers = await prisma.user.findMany({ select: { id: true, telegramId: true } });
            
            for (const user of allUsers) {
                const isSim = await isSimulationActive(user.telegramId);
                if (isSim) continue; 

                const filters = await getUserCallerFilters(user.telegramId);
                if (!filters.isActive) continue;

                const { matches: matchingTokens, isRelaxed } = getMatchesWithLadder(tokens, filters);

                let matchedToken = null;
                for (const t of matchingTokens) {
                    const alertKey = `caller_alerted:${user.telegramId}:${t.mint}`;
                    const alreadyAlerted = await redis.get(alertKey);
                    if (!alreadyAlerted) {
                        matchedToken = t;
                        await redis.set(alertKey, '1', 'EX', 180); 
                        break; 
                    }
                }

                if (matchedToken) {
                    const { consumeCredit } = await import('./credits.service.js');
                    const creditResult = await consumeCredit(user.telegramId, 'CONSUME_CALLER', matchedToken.mint);
                    if (!creditResult.success) continue; 

                    const projection = await getCalibratedProjection(matchedToken);
                    const historyData = {
                        mint: matchedToken.mint, symbol: matchedToken.symbol, score: matchedToken.totalScore,
                        priceAtAlert: matchedToken.price, alertedAt: Date.now(), tokenAgeAtAlertMins: matchedToken.ageMins,
                        predictedRangeLow: projection.rawLow, predictedRangeHigh: projection.rawHigh, predictedTimeframeMins: projection.rawTimeMins
                    };
                    const historyKey = `${matchedToken.mint}:${Date.now()}`;
                    await redis.hset(`caller_history`, historyKey, JSON.stringify(historyData));
                    
                    await storePredictionData(matchedToken, projection, historyKey);

                    const msg = await formatCallerAlertMessage(matchedToken, projection, { isRelaxed });

                    const userConfig = await prisma.autoSnipeConfig.findUnique({ where: { userId: user.id } });
                    const defaultSize = userConfig?.amountSol || 0.1;
                    
                    try {
                        await bot.telegram.sendMessage(user.telegramId, msg, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `⚡ Snipe ${defaultSize} SOL`, callback_data: `forcebuy_${matchedToken.mint}_${defaultSize}` }, { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${matchedToken.mint}` }],
                                    [{ text: '🛡️ Deploy Guard', callback_data: `caller_guard_${matchedToken.mint}` }, { text: '⏳ Start DCA', callback_data: `caller_dca_${matchedToken.mint}` }],
                                    [{ text: '⬅️ Manage Caller Settings', callback_data: 'menu_caller' }]
                                ]
                            }
                        });
                    } catch (e: any) {}
                }
            }
        } catch (e) {
        } finally {
            isScoring = false;
        }
    }, 15000);
}



export interface TokenStats {
    ageMins: number;
    volume24h: number;
    liquidity: number;
    priceChangeM5: number;
    hasSocials: boolean;
    isRug: boolean;
    sourceQuality?: string;
    uncertain?: boolean;
    devRep?: { launchCount: number; avgRugScore: number; isKnownRugger: boolean };
    lpLock?: { locked: boolean; burned: boolean; lockPct: number };
    velocity?: { growthRate: number; uniqueBuyers5m: number };
    sellability?: { sellable: boolean; estimatedTaxPct: number };
    observedVol?: number;
}

export function computeTokenScore(stats: TokenStats & { sentiment?: number }): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    reasons.push(`🕒 Age: ${Math.floor(stats.ageMins)}m`);
    if (stats.ageMins < 60) score += 30;
    else if (stats.ageMins < 180) score += 15;

    const activeVol = stats.observedVol && stats.observedVol > stats.volume24h ? stats.observedVol : stats.volume24h;
    reasons.push(`💰 Vol: $${(activeVol/1000).toFixed(1)}k`);
    if (activeVol > 100000) score += 25;
    else if (activeVol > 20000) score += 10;

    if (stats.liquidity > 0) {
        const volToLiqRatio = activeVol / stats.liquidity;
        if (volToLiqRatio > 25) {
            score -= 25;
            reasons.push(`🚨 Vol/Liq ratio ${volToLiqRatio.toFixed(1)}x — likely wash-traded`);
        } else if (volToLiqRatio > 12) {
            score -= 10;
            reasons.push(`⚠️ High Vol/Liq ratio ${volToLiqRatio.toFixed(1)}x`);
        }
    }

    reasons.push(`📈 Mom: +${stats.priceChangeM5.toFixed(1)}%`);
    if (stats.priceChangeM5 > 15 && stats.priceChangeM5 <= 60) score += 20;
    else if (stats.priceChangeM5 > 60 && stats.priceChangeM5 <= 150) score += 12;
    else if (stats.priceChangeM5 > 150) { score += 3; reasons.push(`⚠️ Parabolic — elevated reversal risk`); }

    reasons.push(`💧 Liq: $${(stats.liquidity/1000).toFixed(1)}k`);
    if (stats.liquidity > 20000) score += 15;
    else if (stats.liquidity < 3000) { score -= 10; reasons.push(`⚠️ Thin liquidity — high slippage risk`); }

    if (stats.hasSocials) { score += 10; reasons.push(`🌐 Socials present`); }
    if (stats.sentiment !== undefined && stats.sentiment > 0.6) {
        const bonus = Math.floor((stats.sentiment - 0.5) * 20);
        score += bonus;
        reasons.push(`📈 Positive sentiment +${bonus}`);
    }

    if (stats.isRug) { score -= 100; reasons.push(`🚨 Rug risk flagged`); }
    if (stats.uncertain) { score -= 5; reasons.push(`⚠️ Rug check inconclusive (Timeout)`); }

    if (stats.sourceQuality === 'onchain-only') {
        reasons.push(`⛓️ Unindexed (early, unverified)`);
    }

    if (stats.sellability && !stats.sellability.sellable) {
        return { score: 0, reasons: [`🚨 UNSELLABLE (Honeypot/High Tax >15%)`] };
    }

    if (stats.devRep) {
        if (stats.devRep.isKnownRugger) {
            return { score: 0, reasons: [`🚨 Serial Rugger Wallet Detected`] };
        } else if (stats.devRep.launchCount > 5) {
            score += 10;
            reasons.push(`🏗️ Established Builder (${stats.devRep.launchCount} launches)`);
        }
    }

    if (stats.lpLock) {
        if (stats.lpLock.burned || stats.lpLock.lockPct > 80) {
            score += 15;
            reasons.push(`🔒 LP Secured (${stats.lpLock.lockPct.toFixed(0)}% Locked/Burned)`);
        } else if (stats.ageMins > 10 && stats.lpLock.lockPct === 0 && !stats.isRug) {
            score -= 20;
            reasons.push(`⚠️ Mature token with 0% LP Lock (Rug Setup)`);
        }
    }

    if (stats.velocity) {
        if (stats.velocity.growthRate > 50) {
            score += 15;
            reasons.push(`🔥 High Organic Velocity (+${stats.velocity.growthRate.toFixed(0)}% holders in 5m)`);
        } else if (stats.velocity.growthRate <= 0 && stats.priceChangeM5 > 5) {
            score -= 15;
            reasons.push(`🤖 Wash Buy Warning (Price rising but flat unique buyers)`);
        }
    }

    return { score: Math.max(55, score), reasons };
}

async function safeDexScreenerFetch(mints: string[]): Promise<any[]> {
    if (mints.length === 0) return [];
    const chunks = chunkArray(mints, 30);
    const allPairs: any[] = [];
    
    for (const chunk of chunks) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 3500 });
            if (res.data?.pairs) allPairs.push(...res.data.pairs);
        } catch (e: any) {}
        await new Promise(r => setTimeout(r, 350)); 
    }
    return allPairs;
}

async function fetchRecentNewMints() {
    const rawMints = getRecentNewMints().slice(0, 120) as any[];
    if (rawMints.length === 0) return [];

    const enrichedTokens: any[] = [];
    const mintsOnly = rawMints.map((m: any) => m.mint);
    
    const dsPairs = await safeDexScreenerFetch(mintsOnly);

    dsPairs.forEach((pair: any) => {
        enrichedTokens.push({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            priceChangeH1: pair.priceChange?.h1 || 0, pairCreatedAt: pair.pairCreatedAt || Date.now(),
            socials: pair.info?.socials || [], sourceQuality: 'dexscreener',
            creatorWallet: rawMints.find((m: any) => m.mint === pair.baseToken.address)?.creator || ''
        });
    });

    const missing = mintsOnly.filter(m => !enrichedTokens.some(e => e.mint === m));
    if (missing.length > 0) {
        try {
            const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
            const { connection } = await import('../lib/connection.js');
            const { PublicKey } = await import('@solana/web3.js');
            const { cachedSolUsdPrice } = await import('./grpc.service.js');

            const missingChunks = chunkArray(missing, 100);
            for (const mintChunk of missingChunks) {
                const pdaChunk = mintChunk.map(m => new PublicKey(getBondingCurveAddress(m)));
                const accInfos = await connection.getMultipleAccountsInfo(pdaChunk).catch(() => null);
                if (accInfos) {
                    accInfos.forEach((accInfo, idx) => {
                        if (!accInfo?.data) return;
                        const mint = mintChunk[idx];
                        const buf = Buffer.isBuffer(accInfo.data) ? accInfo.data : Buffer.from(accInfo.data);
                        const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                        const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                        
                        enrichedTokens.push({
                            mint, symbol: rawMints.find((m: any) => m.mint === mint)?.symbol || 'UNKNOWN',
                            price: decodePumpCurvePrice(buf.toString('base64')) * cachedSolUsdPrice,
                            volume: realSolReserves * cachedSolUsdPrice * 2, 
                            liquidity: virtualSolReserves * cachedSolUsdPrice,
                            priceChangeM5: 0, pairCreatedAt: rawMints.find((m: any) => m.mint === mint)?.firstSeenAt || Date.now(),
                            socials: [], sourceQuality: 'onchain-only',
                            creatorWallet: rawMints.find((m: any) => m.mint === mint)?.creator || ''
                        });
                    });
                }
                await new Promise(r => setTimeout(r, 200)); 
            }
        } catch (e: any) {}
    }
    return enrichedTokens;
}

async function fetchFreshPumpTokens() {
    try {
        const res = await axios.get('https://frontend-api-v3.pump.fun/coins?offset=0&limit=60&sort=created_timestamp&order=DESC&includeNsfw=false', { timeout: 3500, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!Array.isArray(res.data)) return [];

        const now = Date.now();
        const recentPump = res.data.filter((c: any) => c.created_timestamp && (now - c.created_timestamp) < 20 * 60 * 1000);
        if (recentPump.length === 0) return [];

        const mintsOnly = recentPump.map((c: any) => c.mint);
        const dsPairs = await safeDexScreenerFetch(mintsOnly);
        
        const enrichedTokens: any[] = [];
        for (const coin of recentPump) {
            const dsPair = dsPairs.find((p: any) => p.baseToken.address === coin.mint);
            if (dsPair) {
                enrichedTokens.push({
                    mint: dsPair.baseToken.address, symbol: dsPair.baseToken.symbol, price: parseFloat(dsPair.priceUsd || "0"),
                    volume: dsPair.volume?.h24 || 0, liquidity: dsPair.liquidity?.usd || 0, priceChangeM5: dsPair.priceChange?.m5 || 0,
                    priceChangeH1: dsPair.priceChange?.h1 || 0, pairCreatedAt: dsPair.pairCreatedAt || coin.created_timestamp,
                    socials: dsPair.info?.socials || [], sourceQuality: 'pump-fallback'
                });
            } else {
                const { cachedSolUsdPrice } = await import('./grpc.service.js');
                const virtualSolReserves = coin.virtual_sol_reserves ? (coin.virtual_sol_reserves / 1_000_000_000) : 30;
                const realSolReserves = coin.real_sol_reserves ? (coin.real_sol_reserves / 1_000_000_000) : 0;
                enrichedTokens.push({
                    mint: coin.mint, symbol: coin.symbol || 'UNKNOWN', price: coin.usd_market_cap ? (coin.usd_market_cap / 1_000_000_000) : 0, 
                    volume: realSolReserves * cachedSolUsdPrice * 2, liquidity: virtualSolReserves * cachedSolUsdPrice,
                    priceChangeM5: 0, priceChangeH1: 0, pairCreatedAt: coin.created_timestamp, socials: [], sourceQuality: 'onchain-only'
                });
            }
        }
        return enrichedTokens;
    } catch (e: any) {
        return [];
    }
}

async function fetchFreshViaRest() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 60);
        const dsPairs = await safeDexScreenerFetch(mints);

        const now = Date.now();
        return dsPairs.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || now, socials: pair.info?.socials || [], sourceQuality: 'rest-fallback'
        })).filter((t: any) => (now - t.pairCreatedAt) < 30 * 60 * 1000); 
    } catch (e: any) {
        return [];
    }
}

async function fetchBoostedPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 3000 });
        if (!res.data) return [];
        const mints = res.data.map((p: any) => p.tokenAddress).slice(0, 60);
        const dsPairs = await safeDexScreenerFetch(mints);
        return dsPairs.map((pair: any) => ({
            mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
            volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || Date.now(), socials: pair.info?.socials || []
        }));
    } catch (e: any) {
        return [];
    }
}

async function fetchFreshRaydiumPairs() {
    try {
        const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium', { timeout: 3000 });
        if (!res.data) return [];
        const now = Date.now();
        return (res.data?.pairs || [])
            .filter((p: any) => p.chainId === 'solana' && p.dexId === 'raydium' && (now - p.pairCreatedAt) < 30 * 60 * 1000)
            .slice(0, 60)
            .map((pair: any) => ({
                mint: pair.baseToken.address, symbol: pair.baseToken.symbol, price: parseFloat(pair.priceUsd || "0"),
                volume: pair.volume?.h24 || 0, liquidity: pair.liquidity?.usd || 0, priceChangeM5: pair.priceChange?.m5 || 0,
                pairCreatedAt: pair.pairCreatedAt || now, socials: pair.info?.socials || [], sourceQuality: 'dexscreener'
            }));
    } catch (e: any) {
        return [];
    }
}

export async function getDevReputation(creatorWallet: string): Promise<{ launchCount: number; avgRugScore: number; isKnownRugger: boolean }> {
    if (!creatorWallet) return { launchCount: 0, avgRugScore: 0, isKnownRugger: false };
    const cacheKey = `dev_rep:${creatorWallet}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        
        let pubkey: any;
        try { pubkey = new PublicKey(creatorWallet); } catch { 
            return { launchCount: 0, avgRugScore: 0, isKnownRugger: false }; 
        }

        const sigs = await rpcLimiter.run(() =>
            connection.getSignaturesForAddress(pubkey, { limit: 8 }).catch(() => [])
        );

        let rugCount = 0;
        for (const s of sigs) {
            const tx = await rpcLimiter.run(() =>
                connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
            );
            if (!tx?.meta) continue;
            const pre = tx.meta.preBalances?.[0] || 0;
            const post = tx.meta.postBalances?.[0] || 0;
            if (pre > 0 && (pre - post) / pre > 0.9) rugCount++;
        }

        const result = {
            launchCount: sigs.length,
            avgRugScore: sigs.length > 0 ? rugCount / sigs.length : 0,
            isKnownRugger: rugCount >= 2
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
        return result;
    } catch (_) {
        return { launchCount: 0, avgRugScore: 0, isKnownRugger: false };
    }
}

export async function checkLpLockStatus(mintAddress: string): Promise<{ locked: boolean; burned: boolean; lockPct: number }> {
    const cacheKey = `lp_lock:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const BURN_ADDRESS = "11111111111111111111111111111111";
    const STREAMFLOW_PROGRAM = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        
        const largest = await rpcLimiter.run(() => 
            connection.getTokenLargestAccounts(new PublicKey(mintAddress)).catch(()=>null)
        );
        
        if (!largest || !largest.value[0]) return { locked: false, burned: false, lockPct: 0 };

        const top = largest.value[0];
        
        const ownerInfo = await rpcLimiter.run(() => 
            connection.getParsedAccountInfo(top.address).catch(()=>null)
        );
        
        const owner = (ownerInfo?.value?.data as any)?.parsed?.info?.owner ?? '';
        
        const pct = (top.uiAmount || 0) / (largest.value.reduce((s: number, v: any) => s + (v.uiAmount || 0), 0) || 1) * 100;

        const result = {
            burned: owner === BURN_ADDRESS,
            locked: owner === STREAMFLOW_PROGRAM,
            lockPct: pct
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        return result;
    } catch (_) {
        return { locked: false, burned: false, lockPct: 0 };
    }
}

export async function trackHolderVelocity(mintAddress: string): Promise<{ growthRate: number; uniqueBuyers5m: number }> {
    const cacheKey = `velocity_cache:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        
        const largest = await rpcLimiter.run(() => 
            connection.getTokenLargestAccounts(new PublicKey(mintAddress)).catch(()=>null)
        );
        
        if(!largest) return { growthRate: 0, uniqueBuyers5m: 0 };
        const currentCount = largest.value.filter(v => (v.uiAmount || 0) > 0).length;

        const snapshotKey = `holder_snapshots:${mintAddress}`;
        const now = Date.now();
        await redis.zadd(snapshotKey, now, `${now}:${currentCount}`);
        await redis.expire(snapshotKey, 3600);

        const fiveMinAgo = now - 5 * 60 * 1000;
        const oldEntries = await redis.zrangebyscore(snapshotKey, fiveMinAgo, fiveMinAgo + 60000);
        const oldCount = oldEntries.length > 0 ? parseInt(oldEntries[0].split(':')[1]) : currentCount;

        const growthRate = oldCount > 0 ? ((currentCount - oldCount) / oldCount) * 100 : 0;
        
        const result = { growthRate, uniqueBuyers5m: Math.max(0, currentCount - oldCount) };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 45); 
        return result;
    } catch (_) {
        return { growthRate: 0, uniqueBuyers5m: 0 };
    }
}

export async function simulateSellability(mintAddress: string, probeSolSize: number = 0.1): Promise<{ sellable: boolean; estimatedTaxPct: number }> {
    const cacheKey = `sellable:${mintAddress}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
        const buyQuote = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mintAddress}&amount=${Math.floor(probeSolSize * 1e9)}&autoSlippage=true`).catch(() => null);
        
        if (!buyQuote?.data?.outAmount) {
            const result = { sellable: true, estimatedTaxPct: 0 }; 
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 120);
            return result;
        }

        const sellQuote = await axios.get(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${buyQuote.data.outAmount}&autoSlippage=true`).catch(() => null);

        if (!sellQuote?.data?.outAmount) {
            const result = { sellable: true, estimatedTaxPct: 0 }; 
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 120);
            return result;
        }

        const priceImpact = parseFloat(sellQuote.data.priceImpactPct || "0") * 100;
        const result = { sellable: priceImpact < 15, estimatedTaxPct: priceImpact };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
        return result;
    } catch (_) {
        return { sellable: true, estimatedTaxPct: 0 }; 
    }
}

export async function scoreTokens() {
    try {
        const [newMints, pumpFallback, restFallback, boosted, raydiumPairs] = await Promise.all([
            fetchRecentNewMints(),
            fetchFreshPumpTokens(),
            fetchFreshViaRest(),
            fetchBoostedPairs(),
            fetchFreshRaydiumPairs() 
        ]);

        const allPairs = [...newMints, ...pumpFallback, ...restFallback, ...boosted, ...raydiumPairs];
        
        const sourceRank: Record<string, number> = { 'dexscreener': 3, 'pump-fallback': 3, 'rest-fallback': 2, 'onchain-only': 1 };
        const mergedMap = new Map<string, any>();
        
        for (const item of allPairs) {
            const existing = mergedMap.get(item.mint);
            if (!existing || (sourceRank[item.sourceQuality || 'onchain-only'] || 1) > (sourceRank[existing.sourceQuality || 'onchain-only'] || 1)) {
                mergedMap.set(item.mint, item);
            }
        }
        
        const uniquePairs = Array.from(mergedMap.values()).filter((p: any) => BASE58_MINT_REGEX.test(p.mint));

        const { getBondingCurveAddress, decodePumpCurvePrice } = await import('./price.service.js');
        const { connection } = await import('../lib/connection.js');
        const { PublicKey } = await import('@solana/web3.js');
        const { cachedSolUsdPrice } = await import('./grpc.service.js');

        const needsFix = uniquePairs.filter(p => (p.liquidity === 0 || p.volume === 0) && p.mint.toLowerCase().endsWith('pump'));

        if (needsFix.length > 0) {
            const chunks = chunkArray(needsFix, 100);
            for (const chunk of chunks) {
                const pdas = chunk.map(p => new PublicKey(getBondingCurveAddress(p.mint)));
                const accInfos = await connection.getMultipleAccountsInfo(pdas).catch(() => null);
                if (accInfos) {
                    accInfos.forEach((acc, idx) => {
                        if (acc?.data) {
                            const buf = Buffer.isBuffer(acc.data) ? acc.data : Buffer.from(acc.data);
                            if (buf.length >= 40) {
                                const virtualSolReserves = Number(buf.readBigUInt64LE(16)) / 1_000_000_000;
                                const realSolReserves = Number(buf.readBigUInt64LE(32)) / 1_000_000_000;
                                
                                const liqUsd = virtualSolReserves * cachedSolUsdPrice;
                                const volUsd = realSolReserves * cachedSolUsdPrice * 2; 

                                if (chunk[idx].liquidity === 0) chunk[idx].liquidity = liqUsd;
                                if (chunk[idx].volume === 0) chunk[idx].volume = volUsd;
                                if (chunk[idx].price === 0) {
                                    chunk[idx].price = decodePumpCurvePrice(buf.toString('base64')) * cachedSolUsdPrice;
                                }
                            }
                        }
                    });
                }
                await new Promise(r => setTimeout(r, 250)); 
            }
        }

        const stage1Scored: any[] = [];
        const stage1Chunks = chunkArray(uniquePairs, 8);
        
        for (const chunk of stage1Chunks) {
            const results = await Promise.all(chunk.map(async (pair) => {
                const { isRug, top10Pct, uncertain } = await getCachedRugStatus(pair.mint);
                const observedVolStr = await redis.get(`observed_vol:${pair.mint}`);
                
                let hasMev = false;

                const stats: TokenStats = {
                    ageMins: (Date.now() - pair.pairCreatedAt) / 60000,
                    volume24h: pair.volume,
                    liquidity: pair.liquidity,
                    priceChangeM5: pair.priceChangeM5,
                    hasSocials: pair.socials.length > 0,
                    isRug,
                    uncertain,
                    sourceQuality: pair.sourceQuality,
                    observedVol: observedVolStr ? parseFloat(observedVolStr) : undefined
                };

                const sentiment = await getSentimentScore(pair.symbol);
                const { score, reasons } = computeTokenScore({ ...stats, sentiment });
                
                return { pair, stats, score, reasons, isRug, top10Pct, hasMev, sentiment };
            }));
            stage1Scored.push(...results);
        }

        const passedStage1 = stage1Scored.filter(t => t.score >= 15).sort((a,b) => b.score - a.score);

        const fullyScored: any[] = [];
        
        const stage2Chunks = chunkArray(passedStage1.slice(0, 15), 5);
        
        for (const chunk of stage2Chunks) {
            const results = await Promise.all(chunk.map(async (t) => {
                const stillOnCurve = t.pair.mint.toLowerCase().endsWith('pump') && t.pair.sourceQuality !== 'dexscreener' && t.pair.sourceQuality !== 'pump-fallback';
                
                let sellability = { sellable: true, estimatedTaxPct: 0 };
                if (!stillOnCurve) {
                    sellability = await simulateSellability(t.pair.mint);
                }

                const mevCacheKey = `mev_check:${t.pair.mint}`;
                const cachedMev = await redis.get(mevCacheKey);
                let hasMev = false;
                if (cachedMev !== null) {
                    hasMev = cachedMev === 'true';
                } else {
                    const { checkRecentMevActivity } = await import('./price.service.js');
                    hasMev = await checkRecentMevActivity(t.pair.mint);
                    await redis.set(mevCacheKey, hasMev ? 'true' : 'false', 'EX', 300);
                }

                const [devRep, lpLock, velocity] = await Promise.all([
                    getDevReputation(t.pair.creatorWallet || ''), 
                    checkLpLockStatus(t.pair.mint),
                    trackHolderVelocity(t.pair.mint)
                ]);

                t.stats.devRep = devRep;
                t.stats.lpLock = lpLock;
                t.stats.velocity = velocity;
                t.stats.sellability = sellability;

                const finalScoreRes = computeTokenScore({ ...t.stats, sentiment: t.sentiment });
                
                let concentrationAdjustedScore = finalScoreRes.score;
                if (!t.isRug && t.top10Pct > 25) {
                    concentrationAdjustedScore -= Math.floor((t.top10Pct - 25) * 1.5);
                    finalScoreRes.reasons.push(`⚠️ Top 10 holders own ${t.top10Pct.toFixed(1)}%`);
                }

                return { 
                    ...t.pair, 
                    totalScore: Math.max(0, concentrationAdjustedScore), 
                    ageMins: t.stats.ageMins, 
                    reasons: finalScoreRes.reasons, 
                    breakdown: { mevRisk: t.isRug || !sellability.sellable || hasMev ? -100 : 0 },
                    isRug: t.isRug,
                    stats: t.stats
                };
            }));
            fullyScored.push(...results);
        }

        const finalScored = [...fullyScored, ...stage1Scored.filter(t => t.score < 15).map(t => ({
            ...t.pair, totalScore: t.score, ageMins: t.stats.ageMins, reasons: t.reasons, 
            breakdown: { mevRisk: t.isRug ? -100 : 0 },
            isRug: t.isRug,
            stats: t.stats
        }))].sort((a, b) => b.totalScore - a.totalScore);

        await redis.set('caller:hot_scored_tokens', JSON.stringify(finalScored), 'EX', 30);
        return finalScored;
    } catch (e: any) {
        console.error("🔴 [CALLER] Engine Error:", e.message);
        return [];
    }
}

export function startCallerEvaluator() {
    setInterval(async () => {
        try {
            const historyMap = await redis.hgetall('caller_history');
            const now = Date.now();

            for (const [key, val] of Object.entries(historyMap)) {
                const data = JSON.parse(val);
                if (data.finalized) continue;

                const ageMs = now - data.alertedAt;
                const mint = data.mint;

                const priceCacheKey = `caller_price:${mint}`;
                const cachedPrice = await redis.get(priceCacheKey);
                let currentPrice = 0;
                if (cachedPrice !== null) {
                    currentPrice = parseFloat(cachedPrice);
                } else {
                    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 3000 }).catch(() => null);
                    currentPrice = parseFloat(res?.data?.pairs?.[0]?.priceUsd || "0");
                    if (currentPrice > 0) {
                        await redis.set(priceCacheKey, currentPrice.toString(), 'EX', 60);
                    }
                }

                if (currentPrice > 0 && data.priceAtAlert > 0) {
                    const pctChange = ((currentPrice - data.priceAtAlert) / data.priceAtAlert) * 100;
                    if (data.peakPct === undefined || pctChange > data.peakPct) {
                        data.peakPct = pctChange;
                        data.peakAtMs = ageMs; 
                    }
                    if (ageMs >= 3600000 && data.outcome1h === undefined) data.outcome1h = pctChange;
                    if (ageMs >= 6 * 3600000 && data.outcome6h === undefined) data.outcome6h = pctChange;
                    if (ageMs >= 24 * 3600000 && data.outcome24h === undefined) data.outcome24h = pctChange;
                }

                if (ageMs > 24 * 3600000) { 
                    data.finalized = true; 
                    if (data.outcome24h === undefined && currentPrice > 0 && data.priceAtAlert > 0) {
                        data.outcome24h = ((currentPrice - data.priceAtAlert) / data.priceAtAlert) * 100;
                    }
                    
                    try {
                        await prisma.callerPrediction.update({
                            where: { alertKey: key },
                            data: {
                                finalized: true,
                                peakPct: data.peakPct,
                                peakAtMs: data.peakAtMs,
                                outcome1h: data.outcome1h,
                                outcome6h: data.outcome6h,
                                outcome24h: data.outcome24h
                            }
                        });
                    } catch(e) {}
                    
                    if (data.peakPct !== undefined && data.predictedRangeLow !== undefined && data.predictedRangeHigh !== undefined) {
                        const withinRange = data.peakPct >= data.predictedRangeLow && data.peakPct <= data.predictedRangeHigh;
                        await redis.incr(withinRange ? 'projection:hits' : 'projection:misses');
                    }
                }
                
                await redis.hset('caller_history', key, JSON.stringify(data));
            }
        } catch (_) {}
    }, 5 * 60 * 1000);
}