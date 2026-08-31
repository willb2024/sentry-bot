// src/services/accuracy-benchmark.service.ts
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

export interface AccuracyReport {
    sampleSize: number;
    projectionHitRate: number;
    avgAbsoluteError: number;
    directionalAccuracy: number;
    falsePositiveRate: number;
    scoreCorrelationBucket: { bucket: string; avgOutcome24h: number; count: number }[];
    modelUsable: boolean;
    modelR2: number | null;
    warning: string | null;
}

export async function runAccuracyBenchmark(): Promise<AccuracyReport> {
    const predictions = await prisma.callerPrediction.findMany({
        where: { finalized: true, peakPct: { not: null } },
        orderBy: { alertedAt: 'desc' },
        take: 500
    }).catch(() => []);

    if (predictions.length < 5) {
        return {
            sampleSize: predictions.length,
            projectionHitRate: 0, 
            avgAbsoluteError: 0, 
            directionalAccuracy: 0, 
            falsePositiveRate: 0,
            scoreCorrelationBucket: [], 
            modelUsable: false, 
            modelR2: null,
            warning: `Only ${predictions.length} finalized predictions available (need at least 5). Predictions finalize automatically 24h after an alert is issued.`
        };
    }

    let withinRangeCount = 0;
    let totalAbsError = 0;
    let directionalMatches = 0;
    let falsePositives = 0;
    let falsePositiveEligible = 0;

    const buckets: Record<string, { sum: number; count: number }> = {
        '0-40 (low)': { sum: 0, count: 0 },
        '40-70 (mid)': { sum: 0, count: 0 },
        '70-100 (high)': { sum: 0, count: 0 }
    };

    for (const p of predictions) {
        const peak = p.peakPct ?? 0;
        const outcome24h = p.outcome24h ?? peak;

        if (p.predictedLow !== null && p.predictedHigh !== null) {
            if (peak >= p.predictedLow && peak <= p.predictedHigh) {
                withinRangeCount++;
            }
            const predictedMid = (p.predictedLow + p.predictedHigh) / 2;
            totalAbsError += Math.abs(predictedMid - peak);
        }

        const predictedUp = p.score > 50;
        const actualUp = outcome24h > 0;
        if (predictedUp === actualUp) directionalMatches++;

        if (p.score >= 70) {
            falsePositiveEligible++;
            if (outcome24h < 0) falsePositives++;
        }

        const bucket = p.score < 40 ? '0-40 (low)' : p.score < 70 ? '40-70 (mid)' : '70-100 (high)';
        buckets[bucket].sum += outcome24h;
        buckets[bucket].count++;
    }

    const modelWeightsRaw = await redis.get('caller_model_weights').catch(() => null);
    let modelR2: number | null = null;
    let modelUsable = false;
    if (modelWeightsRaw) {
        try {
            const weights = JSON.parse(modelWeightsRaw);
            modelR2 = weights.metrics?.valR2 ?? null;
            modelUsable = weights.metrics?.isUsable ?? false;
        } catch (_) {}
    }

    const scoreCorrelationBucket = Object.entries(buckets).map(([bucket, v]) => ({
        bucket,
        avgOutcome24h: v.count > 0 ? parseFloat((v.sum / v.count).toFixed(2)) : 0,
        count: v.count
    }));

    let warning: string | null = null;
    if (scoreCorrelationBucket.length >= 3 && predictions.length >= 20) {
        const lowAvg = scoreCorrelationBucket[0].avgOutcome24h;
        const midAvg = scoreCorrelationBucket[1].avgOutcome24h;
        const highAvg = scoreCorrelationBucket[2].avgOutcome24h;
        if (!(highAvg >= midAvg && midAvg >= lowAvg)) {
            warning = 'Higher scores are not yet monotonically correlating with better returns on your recent sample.';
        }
    }

    return {
        sampleSize: predictions.length,
        projectionHitRate: parseFloat(((withinRangeCount / predictions.length) * 100).toFixed(1)),
        avgAbsoluteError: parseFloat((totalAbsError / predictions.length).toFixed(1)),
        directionalAccuracy: parseFloat(((directionalMatches / predictions.length) * 100).toFixed(1)),
        falsePositiveRate: falsePositiveEligible > 0 ? parseFloat(((falsePositives / falsePositiveEligible) * 100).toFixed(1)) : 0,
        scoreCorrelationBucket,
        modelUsable,
        modelR2,
        warning
    };
}

export function buildAccuracyReportMessage(report: AccuracyReport): string {
    if (report.sampleSize < 5) {
        return `📊 <b>SENTRY ACCURACY AUDIT</b>\n\n⚠️ ${report.warning}`;
    }

    const bucketRows = report.scoreCorrelationBucket
        .map(b => `├ Score ${b.bucket}: avg outcome <code>${b.avgOutcome24h >= 0 ? '+' : ''}${b.avgOutcome24h}%</code> (n=${b.count})`)
        .join('\n');

    const warningBlock = report.warning ? `\n\n🚨 <b>Notice:</b> ${report.warning}` : '';
    const modelBlock = report.modelR2 !== null
        ? `\n\n🧠 <b>ML Ridge Regression Model:</b> Validation R² = <code>${report.modelR2.toFixed(3)}</code> (${report.modelUsable ? '✅ Active' : '🔴 Below Threshold'})`
        : `\n\n🧠 <b>ML Model:</b> Training data building (heuristic rules active)`;

    return (
        `📊 <b>SENTRY ACCURACY AUDIT</b>\n\n` +
        `• <b>Sample Size:</b> <code>${report.sampleSize}</code> finalized predictions\n` +
        `• <b>Projection Hit Rate:</b> <code>${report.projectionHitRate}%</code>\n` +
        `• <b>Avg Range Error:</b> <code>±${report.avgAbsoluteError}%</code>\n` +
        `• <b>Directional Accuracy:</b> <code>${report.directionalAccuracy}%</code>\n` +
        `• <b>High-Score Loss Rate:</b> <code>${report.falsePositiveRate}%</code>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 <b>Score → Outcome Correlation:</b>\n` +
        `${bucketRows}` +
        modelBlock +
        warningBlock + `\n\n` +
        `<i>(Calculated strictly against your live production database).</i>`
    );
}