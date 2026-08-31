// src/services/pipeline-benchmark.service.ts
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { connection } from '../lib/connection.js';
import { PublicKey } from '@solana/web3.js';
import axios from 'axios';

// ─────────────────────────────────────────────
// 1. GUARD / TRAILING-STOP BENCHMARK
// ─────────────────────────────────────────────
export interface GuardBenchmarkResult {
    activeGuardCount: number;
    uniqueTokenCount: number;
    bulkPriceFetchMs: number;
    fullScanMs: number;
    avgPerGuardMs: number;
    grade: 'S' | 'A' | 'B' | 'C';
}

export async function runGuardBenchmark(): Promise<GuardBenchmarkResult> {
    const { getAllActiveGuards } = await import('./order.service.js').catch(() => ({
        getAllActiveGuards: async () => []
    }));
    const { getLivePriceSol } = await import('./guard-price-feed.service.js').catch(() => ({
        getLivePriceSol: (_: string) => null
    }));
    const { fetchBulkTokenPrices } = await import('./grpc.service.js').catch(() => ({
        fetchBulkTokenPrices: async (_: string[]) => ({})
    }));

    const tStart = process.hrtime.bigint();
    const activeGuards = await getAllActiveGuards().catch(() => []);

    const guardsByToken = new Map<string, any[]>();
    for (const g of activeGuards) {
        if (!guardsByToken.has(g.tokenAddress)) guardsByToken.set(g.tokenAddress, []);
        guardsByToken.get(g.tokenAddress)!.push(g);
    }

    const tPriceStart = process.hrtime.bigint();
    const tokenMints = Array.from(guardsByToken.keys()).filter(m => getLivePriceSol(m) === null);
    const prices = tokenMints.length > 0 ? await fetchBulkTokenPrices(tokenMints).catch(() => ({})) : {};
    const bulkPriceFetchMs = parseFloat((Number(process.hrtime.bigint() - tPriceStart) / 1e6).toFixed(2));

    const tEnd = process.hrtime.bigint();
    const fullScanMs = parseFloat((Number(tEnd - tStart) / 1e6).toFixed(2));
    const avgPerGuardMs = activeGuards.length > 0 ? parseFloat((fullScanMs / activeGuards.length).toFixed(3)) : 0;

    let grade: 'S' | 'A' | 'B' | 'C' = 'S';
    if (fullScanMs > 4000) grade = 'C';
    else if (fullScanMs > 2000) grade = 'B';
    else if (fullScanMs > 500) grade = 'A';

    return {
        activeGuardCount: activeGuards.length,
        uniqueTokenCount: guardsByToken.size,
        bulkPriceFetchMs,
        fullScanMs,
        avgPerGuardMs,
        grade
    };
}

// ─────────────────────────────────────────────
// 2. COPY-TRADE LISTENER BENCHMARK
// ─────────────────────────────────────────────
export interface CopyTradeBenchmarkResult {
    activeConfigCount: number;
    uniqueTargetWallets: number;
    activeListenerCount: number;
    syncMs: number;
    grade: 'S' | 'A' | 'B' | 'C';
}

export async function runCopyTradeBenchmark(): Promise<CopyTradeBenchmarkResult> {
    const tStart = process.hrtime.bigint();
    const activeConfigs = await prisma.copyTradeConfig.findMany({ where: { isActive: true } }).catch(() => []);
    const targetWallets = [...new Set(activeConfigs.map(c => c.targetWallet))];
    const tEnd = process.hrtime.bigint();
    const syncMs = parseFloat((Number(tEnd - tStart) / 1e6).toFixed(2));

    let grade: 'S' | 'A' | 'B' | 'C' = 'S';
    if (syncMs > 500) grade = 'C';
    else if (syncMs > 200) grade = 'B';
    else if (syncMs > 50) grade = 'A';

    return {
        activeConfigCount: activeConfigs.length,
        uniqueTargetWallets: targetWallets.length,
        activeListenerCount: targetWallets.length,
        syncMs,
        grade
    };
}

// ─────────────────────────────────────────────
// 3. DEPOSIT WATCHER BENCHMARK
// ─────────────────────────────────────────────
export interface DepositBenchmarkResult {
    monitoredWalletCount: number;
    userQueryMs: number;
    balanceFetchMs: number;
    totalMs: number;
    cycleIntervalMs: number;
    withinCycleWindow: boolean;
    grade: 'S' | 'A' | 'B' | 'C';
}

export async function runDepositBenchmark(): Promise<DepositBenchmarkResult> {
    const CYCLE_MS = 60000;

    const tUserStart = process.hrtime.bigint();
    const activeUsers = await prisma.user.findMany({
        where: { vaultAddress: { not: null } },
        select: { telegramId: true, vaultAddress: true, vault2: true, vault3: true, vault4: true, vault5: true, activeWallets: true }
    }).catch(() => []);
    const userQueryMs = parseFloat((Number(process.hrtime.bigint() - tUserStart) / 1e6).toFixed(2));

    const addressToUserMap = new Map<string, any>();
    for (const u of activeUsers) {
        if (u.vaultAddress) addressToUserMap.set(u.vaultAddress, u);
        if (u.activeWallets >= 2 && u.vault2) addressToUserMap.set(u.vault2, u);
        if (u.activeWallets >= 3 && u.vault3) addressToUserMap.set(u.vault3, u);
        if (u.activeWallets >= 4 && u.vault4) addressToUserMap.set(u.vault4, u);
        if (u.activeWallets >= 5 && u.vault5) addressToUserMap.set(u.vault5, u);
    }
    const allAddresses = Array.from(addressToUserMap.keys());

    const tBalStart = process.hrtime.bigint();
    let balanceFetchMs = 0;
    if (allAddresses.length > 0) {
        const testChunk = allAddresses.slice(0, 50);
        const pubkeys = testChunk.map(a => { try { return new PublicKey(a); } catch { return null; } }).filter(Boolean) as PublicKey[];
        if (pubkeys.length > 0) {
            await connection.getMultipleAccountsInfo(pubkeys).catch(() => null);
        }
        balanceFetchMs = parseFloat((Number(process.hrtime.bigint() - tBalStart) / 1e6).toFixed(2));
    }

    const chunkCount = Math.ceil(allAddresses.length / 50) || 1;
    const estimatedTotalMs = parseFloat((userQueryMs + (balanceFetchMs * chunkCount)).toFixed(2));
    const withinCycleWindow = estimatedTotalMs < CYCLE_MS * 0.5;

    let grade: 'S' | 'A' | 'B' | 'C' = 'S';
    if (!withinCycleWindow) grade = 'C';
    else if (estimatedTotalMs > CYCLE_MS * 0.3) grade = 'B';
    else if (estimatedTotalMs > CYCLE_MS * 0.1) grade = 'A';

    return {
        monitoredWalletCount: allAddresses.length,
        userQueryMs,
        balanceFetchMs,
        totalMs: estimatedTotalMs,
        cycleIntervalMs: CYCLE_MS,
        withinCycleWindow,
        grade
    };
}

// ─────────────────────────────────────────────
// 4. WEBAPP API BENCHMARK
// ─────────────────────────────────────────────
export interface ApiEndpointResult { endpoint: string; ms: number; status: number | 'FAILED'; }
export interface WebAppBenchmarkResult { results: ApiEndpointResult[]; totalMs: number; slowestEndpoint: string; grade: 'S' | 'A' | 'B' | 'C'; }

export async function runWebAppApiBenchmark(telegramId: string): Promise<WebAppBenchmarkResult> {
    const PORT = process.env.PORT || 3001;
    const baseUrl = `http://localhost:${PORT}`;
    const endpoints: { path: string; method: 'GET' | 'POST'; body?: any }[] = [
        { path: '/api/affiliate-stats', method: 'POST', body: { telegramId } },
        { path: '/api/institutional-stats', method: 'POST', body: { telegramId } },
    ];

    const results: ApiEndpointResult[] = [];
    for (const ep of endpoints) {
        const t0 = process.hrtime.bigint();
        try {
            const res = await axios({ method: ep.method, url: `${baseUrl}${ep.path}`, data: ep.body, timeout: 4000, validateStatus: () => true });
            results.push({ endpoint: ep.path, ms: parseFloat((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), status: res.status });
        } catch (_) {
            results.push({ endpoint: ep.path, ms: parseFloat((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)), status: 'FAILED' });
        }
    }

    const totalMs = parseFloat(results.reduce((s, r) => s + r.ms, 0).toFixed(2));
    const slowest = results.length > 0 ? results.reduce((a, b) => (a.ms > b.ms ? a : b)) : { endpoint: 'None', ms: 0, status: 200 };
    const anyFailed = results.some(r => r.status === 'FAILED' || (typeof r.status === 'number' && r.status >= 500));

    let grade: 'S' | 'A' | 'B' | 'C' = 'S';
    if (anyFailed || slowest.ms > 500) grade = 'C';
    else if (slowest.ms > 250) grade = 'B';
    else if (slowest.ms > 100) grade = 'A';

    return { results, totalMs, slowestEndpoint: slowest.endpoint, grade };
}

// ─────────────────────────────────────────────
// 5. AI COIN CALLER DELIVERY BENCHMARK
// ─────────────────────────────────────────────
export interface CallerDeliveryBenchmarkResult {
    totalActiveUsers: number;
    perUserProcessingMs: number;
    estimatedFullCycleMs: number;
    liveIntervalMs: number;
    withinIntervalWindow: boolean;
    grade: 'S' | 'A' | 'B' | 'C';
}

export async function runCallerDeliveryBenchmark(): Promise<CallerDeliveryBenchmarkResult> {
    const LIVE_INTERVAL_MS = 12000;

    const { isSimulationActive } = await import('./simulation.service.js');
    const { getUserCallerFilters } = await import('./caller.service.js');

    const allUsers = await prisma.user.findMany({ select: { id: true, telegramId: true } }).catch(() => []);
    if (allUsers.length === 0) {
        return { totalActiveUsers: 0, perUserProcessingMs: 0, estimatedFullCycleMs: 0, liveIntervalMs: LIVE_INTERVAL_MS, withinIntervalWindow: true, grade: 'S' };
    }

    const sample = allUsers.slice(0, Math.min(10, allUsers.length));
    const tStart = process.hrtime.bigint();
    for (const user of sample) {
        await isSimulationActive(user.telegramId).catch(() => false);
        await getUserCallerFilters(user.telegramId).catch(() => ({ isActive: false }));
    }
    const sampleMs = Number(process.hrtime.bigint() - tStart) / 1e6;
    const perUserProcessingMs = parseFloat((sampleMs / sample.length).toFixed(3));

    const estimatedFullCycleMsParallel = parseFloat(((perUserProcessingMs * allUsers.length) / 20).toFixed(2));
    const withinIntervalWindow = estimatedFullCycleMsParallel < LIVE_INTERVAL_MS * 0.7;

    let grade: 'S' | 'A' | 'B' | 'C' = 'S';
    if (!withinIntervalWindow) grade = 'C';
    else if (estimatedFullCycleMsParallel > LIVE_INTERVAL_MS * 0.5) grade = 'B';
    else if (estimatedFullCycleMsParallel > LIVE_INTERVAL_MS * 0.2) grade = 'A';

    return {
        totalActiveUsers: allUsers.length,
        perUserProcessingMs,
        estimatedFullCycleMs: estimatedFullCycleMsParallel,
        liveIntervalMs: LIVE_INTERVAL_MS,
        withinIntervalWindow,
        grade
    };
}

// ─────────────────────────────────────────────
// Combined Message Builder
// ─────────────────────────────────────────────
export function buildPipelineBenchmarkMessage(
    guard: GuardBenchmarkResult,
    copyTrade: CopyTradeBenchmarkResult,
    deposit: DepositBenchmarkResult,
    webapp: WebAppBenchmarkResult,
    caller: CallerDeliveryBenchmarkResult
): string {
    const g = (grade: string) => grade === 'S' || grade === 'A' ? '🟢' : grade === 'B' ? '🟡' : '🔴';

    const callerWarning = !caller.withinIntervalWindow
        ? `\n🚨 <b>WARNING:</b> Per-user processing (${caller.estimatedFullCycleMs}ms est.) approaches the ${caller.liveIntervalMs}ms loop limit at ${caller.totalActiveUsers} users.`
        : '';

    const depositWarning = !deposit.withinCycleWindow
        ? `\n🚨 <b>WARNING:</b> Deposit sweep (${deposit.totalMs}ms est.) exceeds half of the ${deposit.cycleIntervalMs}ms cycle window.`
        : '';

    return (
        `🛰️ <b>SENTRY BACKGROUND SYSTEMS AUDIT</b>\n\n` +
        `🛡️ <b>1. Guard / Trailing-Stop:</b> ${g(guard.grade)} Grade <b>${guard.grade}</b>\n` +
        `├ Active Guards: <code>${guard.activeGuardCount}</code> (${guard.uniqueTokenCount} tokens)\n` +
        `├ Bulk Price Fetch: <code>${guard.bulkPriceFetchMs}ms</code>\n` +
        `└ Full Scan Duration: <code>${guard.fullScanMs}ms</code>\n\n` +
        `👥 <b>2. Copy-Trade Listeners:</b> ${g(copyTrade.grade)} Grade <b>${copyTrade.grade}</b>\n` +
        `├ Active Configs: <code>${copyTrade.activeConfigCount}</code>\n` +
        `├ Monitored Targets: <code>${copyTrade.uniqueTargetWallets}</code>\n` +
        `└ Sync Check: <code>${copyTrade.syncMs}ms</code>\n\n` +
        `👛 <b>3. Deposit Watcher:</b> ${g(deposit.grade)} Grade <b>${deposit.grade}</b>\n` +
        `├ Monitored Wallets: <code>${deposit.monitoredWalletCount}</code>\n` +
        `├ User Query: <code>${deposit.userQueryMs}ms</code>\n` +
        `└ Est. Full Cycle: <code>${deposit.totalMs}ms</code> / ${deposit.cycleIntervalMs}ms window` +
        depositWarning + `\n\n` +
        `🌐 <b>4. WebApp API Latency:</b> ${g(webapp.grade)} Grade <b>${webapp.grade}</b>\n` +
        `└ Aggregate Response: <code>${webapp.totalMs}ms</code> (Slowest: <code>${webapp.slowestEndpoint}</code>)\n\n` +
        `🎯 <b>5. AI Caller Engine:</b> ${g(caller.grade)} Grade <b>${caller.grade}</b>\n` +
        `├ Active Users: <code>${caller.totalActiveUsers}</code>\n` +
        `├ Per-User Query: <code>${caller.perUserProcessingMs}ms</code>\n` +
        `└ Parallelized Cycle: <code>${caller.estimatedFullCycleMs}ms</code> / ${caller.liveIntervalMs}ms window` +
        callerWarning
    );
}