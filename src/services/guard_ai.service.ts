// src/services/guard_ai.service.ts
import axios from 'axios';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import {
  getCachedRugStatus,
  checkLpLockStatus,
  trackHolderVelocity,
  getSentimentScore,
  computeTokenScore,
  getCalibratedProjection,
  TokenStats,
  getModelScore
} from './caller.service.js';

export interface GuardFilters {
  minScore: number;
  minLiquidity: number;
  maxVolatility: number; // max absolute 5m change %
  requireSocials: boolean;
  requireLpLock: boolean;
}

export const DEFAULT_GUARD_FILTERS: GuardFilters = {
  minScore: 55,
  minLiquidity: 5000,
  maxVolatility: 60,
  requireSocials: false,
  requireLpLock: false
};

export interface GuardScoreBreakdown {
  factor: string;
  points: number;
  maxPoints: number;
  detail: string;
}

export interface GuardRecommendation {
  tokenAddress: string;
  tokenSymbol: string;
  score: number;
  scoreBreakdown: GuardScoreBreakdown[];
  trailingDropPercent: number;
  takeProfitPercent: number;
  projectedRange: string;
  timeframe: string;
  confidence: 'Low' | 'Moderate' | 'Good' | 'High';
  filters: GuardFilters;
  recommendationId?: string;
}

export async function getUserGuardFilters(telegramId: string): Promise<GuardFilters> {
  const raw = await redis.get(`guard_filters:${telegramId}`);
  if (raw) return { ...DEFAULT_GUARD_FILTERS, ...JSON.parse(raw) };
  return { ...DEFAULT_GUARD_FILTERS };
}

export async function setUserGuardFilters(telegramId: string, updates: Partial<GuardFilters>) {
  const current = await getUserGuardFilters(telegramId);
  const updated = { ...current, ...updates };
  await redis.set(`guard_filters:${telegramId}`, JSON.stringify(updated));
  return updated;
}

// Replace analyzeTokenForGuard in src/services/guard_ai.service.ts

export async function analyzeTokenForGuard(
    telegramId: string,
    tokenMint: string,
    filters?: GuardFilters
  ): Promise<GuardRecommendation> {
    const activeFilters = filters || await getUserGuardFilters(telegramId);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenMint)) {
      throw new Error('Invalid token address.');
    }
  
    // 1. Fetch DexScreener market data
    const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { timeout: 3000 }).catch(() => null);
    const pair = dsRes?.data?.pairs?.[0];
    if (!pair) throw new Error('Token not found on DexScreener.');
  
    const ageMins = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 0;
    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const priceChangeM5 = pair.priceChange?.m5 || 0;
    const symbol = pair.baseToken?.symbol || 'UNKNOWN';
    const hasSocials = (pair.info?.socials?.length || 0) > 0;
  
    // 2. Rug / security checks
    const { isRug, top10Pct, uncertain } = await getCachedRugStatus(tokenMint);
    if (isRug) {
      throw new Error('Token flagged as high risk (rug/honeypot).');
    }
  
    // 3. On-chain factors
    const lpLock = await checkLpLockStatus(tokenMint);
    const velocity = await trackHolderVelocity(tokenMint);
  
    // 4. Sentiment
    const sentiment = await getSentimentScore(symbol);
  
    // 5. Build TokenStats for computeTokenScore
    const stats: TokenStats & { sentiment?: number } = {
      ageMins,
      volume24h,
      liquidity,
      priceChangeM5,
      hasSocials,
      isRug,
      uncertain,
      lpLock,
      velocity,
      sentiment,
      devRep: { launchCount: 0, avgRugScore: 0, isKnownRugger: false },
      sellability: { sellable: true, estimatedTaxPct: 0 }
    };
  
    // 6. Heuristic score
    const scoreResult = computeTokenScore(stats);
    const score = scoreResult.score;
  
    // 7. ML refined score (if model exists)
    let mlScore: number | null = null;
    try {
      mlScore = await getModelScore(tokenMint, stats);
    } catch (_) {}
  
    const finalScore = mlScore !== null
      ? Math.round((mlScore * 0.6) + (score * 0.4))
      : score;
  
    // 8. Filter checks
    const filterChecks = {
      score: finalScore >= activeFilters.minScore,
      liquidity: liquidity >= activeFilters.minLiquidity,
      volatility: Math.abs(priceChangeM5) <= activeFilters.maxVolatility,
      socials: !activeFilters.requireSocials || hasSocials,
      lpLock: !activeFilters.requireLpLock || (lpLock.locked || lpLock.burned || lpLock.lockPct > 80)
    };
  
    if (Object.values(filterChecks).includes(false)) {
      const failed = Object.entries(filterChecks).filter(([_, v]) => !v).map(([k]) => k).join(', ');
      throw new Error(`Token fails filter criteria: ${failed}`);
    }
  
    // 9. Build score breakdown
    const breakdown: GuardScoreBreakdown[] = [
      { factor: 'Age', points: ageMins < 60 ? 30 : ageMins < 180 ? 15 : 5, maxPoints: 30, detail: `${Math.floor(ageMins)}m` },
      { factor: 'Volume', points: volume24h > 50000 ? 25 : volume24h > 20000 ? 15 : 5, maxPoints: 25, detail: `$${(volume24h/1000).toFixed(1)}k` },
      { factor: 'Liquidity', points: liquidity > 20000 ? 15 : liquidity > 5000 ? 10 : 2, maxPoints: 15, detail: `$${(liquidity/1000).toFixed(1)}k` },
      { factor: 'Momentum', points: priceChangeM5 > 15 && priceChangeM5 <= 60 ? 20 : priceChangeM5 > 60 && priceChangeM5 <= 150 ? 12 : 3, maxPoints: 20, detail: `${priceChangeM5.toFixed(1)}%` },
      { factor: 'Socials', points: hasSocials ? 10 : 0, maxPoints: 10, detail: hasSocials ? 'Present' : 'None' },
      { factor: 'LP Security', points: (lpLock.burned || lpLock.lockPct > 80) ? 15 : (lpLock.lockPct > 0 ? 8 : 0), maxPoints: 15, detail: `${lpLock.lockPct.toFixed(0)}% locked` },
      { factor: 'Holder Velocity', points: velocity.growthRate > 50 ? 15 : velocity.growthRate > 0 ? 8 : 0, maxPoints: 15, detail: `${velocity.growthRate.toFixed(0)}% growth` },
      { factor: 'Sentiment', points: sentiment > 0.6 ? Math.floor((sentiment - 0.5) * 20) : 0, maxPoints: 10, detail: sentiment.toFixed(2) }
    ];
    breakdown.forEach(b => b.points = Math.min(b.points, b.maxPoints));
  
    // 10. Projection
    const tokenForProj = {
      mint: tokenMint,
      symbol,
      score: finalScore,
      totalScore: finalScore,
      isRug: false,
      ageMins,
      liquidity,
      volume: volume24h,
      priceChangeM5,
      stats: { lpLock, velocity, hasSocials },
      socials: pair.info?.socials || []
    };
    const projection = await getCalibratedProjection(tokenForProj);
  
    // 11. Determine suggested trailing drop & TP
    let trailingDrop = 15;
    let takeProfit = 40;
    // 🟢 FIX: Explicitly typed to the literal union
    let confidence: 'Low' | 'Moderate' | 'Good' | 'High' = 'Moderate'; 
  
    if (finalScore < 40) { 
      trailingDrop = 10; 
      takeProfit = 20; 
      confidence = 'Low'; 
    } else if (finalScore < 60) { 
      trailingDrop = 15; 
      takeProfit = 40; 
      confidence = 'Moderate'; 
    } else if (finalScore < 80) { 
      trailingDrop = 20; 
      takeProfit = 60; 
      confidence = 'Good'; 
    } else { 
      trailingDrop = 25; 
      takeProfit = 100; 
      confidence = 'High'; 
    }
  
    if (Math.abs(priceChangeM5) > 50) trailingDrop += 5;
    if (liquidity > 50000) trailingDrop = Math.max(10, trailingDrop - 5);
    
    if (projection.rawLow > 0) {
      takeProfit = Math.min(300, Math.max(takeProfit, Math.floor(projection.rawLow * 0.8)));
    }
  
    const tokenFeatures = [
      finalScore, ageMins, Math.log(Math.max(liquidity, 1)), Math.log(Math.max(volume24h, 1)),
      priceChangeM5, hasSocials ? 1 : 0, lpLock.lockPct || 0, velocity.growthRate || 0, sentiment || 0.5
    ];
    const mlPredictedTp = await predictTakeProfitFromModel(tokenFeatures);
    if (mlPredictedTp !== null) {
      takeProfit = Math.round((takeProfit * 0.4) + (mlPredictedTp * 0.6));
    }
  
    trailingDrop = Math.min(40, Math.max(5, Math.round(trailingDrop)));
    takeProfit = Math.min(300, Math.max(20, Math.round(takeProfit)));
  
    // 12. Store recommendation in DB
    const rec = await prisma.guardRecommendation.create({
      data: {
        telegramId,
        tokenAddress: tokenMint,
        tokenSymbol: symbol,
        score: finalScore,
        trailingDrop,
        takeProfit,
        ageMins,
        liquidity,
        volume24h,
        priceChangeM5,
        hasSocials,
        isRug: false,
        lpLockPct: lpLock.lockPct || 0,
        velocityGrowth: velocity.growthRate || 0,
        sentiment: sentiment || 0.5,
        predictedRange: projection.target,
        timeframe: projection.timeframe,
        confidence,
        used: false,
      }
    }).catch(() => null);
  
    return {
      tokenAddress: tokenMint,
      tokenSymbol: symbol,
      score: finalScore,
      scoreBreakdown: breakdown,
      trailingDropPercent: trailingDrop,
      takeProfitPercent: takeProfit,
      projectedRange: projection.target,
      timeframe: projection.timeframe,
      confidence,
      filters: activeFilters,
      recommendationId: rec?.id
    };
  }
  
  // 🟢 MAKE SURE THIS FUNCTION IS EXPORTED IN guard_ai.service.ts
  export async function recordGuardOutcome(
    telegramId: string, 
    tokenAddress: string, 
    pnlPercent: number, 
    peakPercent: number
  ): Promise<void> {
    try {
      const rec = await prisma.guardRecommendation.findFirst({
        where: { telegramId, tokenAddress, used: true, finalized: false },
        orderBy: { createdAt: 'desc' }
      });
      if (rec) {
        await prisma.guardRecommendation.update({
          where: { id: rec.id },
          data: {
            outcomePnlPercent: pnlPercent,
            outcomePeakPercent: peakPercent,
            finalized: true
          }
        });
      }
    } catch (e: any) {
      console.error('🔴 [GUARD AI] Failed to record guard outcome:', e.message);
    }
  }

// ──────────────────────────────────────────────────────────────
//  ML TRAINING (like Caller)
// ──────────────────────────────────────────────────────────────

export async function trainGuardModel() {
  try {
    const records = await prisma.guardRecommendation.findMany({
      where: { finalized: true, outcomePnlPercent: { not: null } },
      orderBy: { createdAt: 'asc' }
    });

    if (records.length < 60) {
      console.log(`🧠 [GUARD ML] Skipping training — only ${records.length} samples (need 60+).`);
      return;
    }

    // Build features
    const X: number[][] = [];
    const y: number[] = []; // target: optimal takeProfit (or maybe risk-adjusted)
    for (const r of records) {
      X.push([
        r.score, r.ageMins, Math.log(Math.max(r.liquidity, 1)), Math.log(Math.max(r.volume24h, 1)),
        r.priceChangeM5, r.hasSocials ? 1 : 0, r.lpLockPct, r.velocityGrowth, r.sentiment
      ]);
      y.push(r.takeProfit); // We can predict the TP that led to best outcome?
    }

    // Split chronological 80/20
    const split = Math.floor(X.length * 0.8);
    const trainX = X.slice(0, split);
    const trainY = y.slice(0, split);
    const valX = X.slice(split);
    const valY = y.slice(split);

    // Normalize
    const means = trainX[0].map((_, j) => trainX.reduce((s, row) => s + row[j], 0) / trainX.length);
    const stds = trainX[0].map((_, j) => {
      const mean = means[j];
      return Math.sqrt(trainX.reduce((s, row) => s + (row[j] - mean) ** 2, 0) / trainX.length) || 1;
    });
    const normX = trainX.map(row => row.map((v, j) => (v - means[j]) / stds[j]));
    const normValX = valX.map(row => row.map((v, j) => (v - means[j]) / stds[j]));

    // Ridge Regression (simplified - you can reuse the solver from caller.service.ts)
    // For brevity, we'll implement a simple linear regression with regularization
    const lambda = 0.1;
    const Xt = normX[0].map((_, idx) => normX.map(row => row[idx]));
    const XtX = Xt.map(row => Xt[0].map((_, j) => row.reduce((sum, val, k) => sum + val * normX[k][j], 0)));
    const Xty = Xt.map(row => row.reduce((sum, val, i) => sum + val * trainY[i], 0));
    // Add lambda*I
    for (let i = 0; i < XtX.length; i++) XtX[i][i] += lambda * trainX.length;
    // Solve XtX * w = Xty (Gaussian elimination)
    const size = XtX.length;
    const aug = XtX.map((row, i) => [...row, Xty[i]]);
    for (let col = 0; col < size; col++) {
      let maxRow = col;
      for (let row = col + 1; row < size; row++) if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      for (let row = col + 1; row < size; row++) {
        const factor = aug[row][col] / aug[col][col];
        for (let j = col; j <= size; j++) aug[row][j] -= factor * aug[col][j];
      }
    }
    const w = new Array(size).fill(0);
    for (let i = size - 1; i >= 0; i--) {
      let sum = aug[i][size];
      for (let j = i + 1; j < size; j++) sum -= aug[i][j] * w[j];
      w[i] = sum / aug[i][i];
    }

    // Validate R²
    const valPred = normValX.map(row => row.reduce((sum, v, j) => sum + v * w[j], 0));
    const meanY = valY.reduce((a, b) => a + b, 0) / valY.length;
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < valY.length; i++) {
      ssRes += (valY[i] - valPred[i]) ** 2;
      ssTot += (valY[i] - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    const isUsable = r2 >= 0.15;

    // Save weights
    await redis.set('guard_model_weights', JSON.stringify({
      version: 1,
      trainedAt: Date.now(),
      coefficients: w,
      featureNames: ['score','age','log_liq','log_vol','mom','socials','lpLock','velocity','sentiment'],
      normalization: { means, stds },
      metrics: { r2, sampleCount: trainX.length, isUsable }
    }));

    console.log(`🧠 [GUARD ML] Trained on ${trainX.length} samples, validation R² = ${r2.toFixed(3)}`);
  } catch (e: any) {
    console.error('🔴 [GUARD ML] Training failed:', e.message);
  }
}

export async function predictTakeProfitFromModel(tokenFeatures: number[]): Promise<number | null> {
  const raw = await redis.get('guard_model_weights');
  if (!raw) return null;
  const model = JSON.parse(raw);
  if (!model.metrics?.isUsable) return null;
  const norm = tokenFeatures.map((v, i) => (v - model.normalization.means[i]) / model.normalization.stds[i]);
  const pred = norm.reduce((s, v, i) => s + v * model.coefficients[i], 0);
  return Math.max(20, Math.min(300, Math.round(pred)));
}

export async function runGuardModelTrainingScheduler() {
  let lastCount = 0;
  setInterval(async () => {
    const count = await prisma.guardRecommendation.count({ where: { finalized: true, outcomePnlPercent: { not: null } } });
    if (count - lastCount >= 20) {
      console.log('🧠 [GUARD ML] Retraining...');
      await trainGuardModel();
      lastCount = count;
    }
  }, 12 * 60 * 60 * 1000);
}