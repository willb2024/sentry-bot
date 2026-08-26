// src/lib/connection.ts — Socket-Aborting RPC Engine with Zero Internal Retry Loops
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const PRIMARY_URL = process.env.PRIMARY_RPC_URL 
    || process.env.HELIUS_RPC_URL 
    || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com');

const BACKUP_URL = process.env.BACKUP_RPC_URL 
    || (PRIMARY_URL.includes('helius') ? 'https://solana-mainnet.rpc.extrnode.com' : 'https://api.mainnet-beta.solana.com');

// 🟢 FIX 1: Custom fetch with hard 3.5s AbortController — kills orphaned hanging sockets at the TCP level!
const customTimeoutFetch = (url: any, options: any = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    return fetch(url, {
        ...options,
        signal: controller.signal
    }).finally(() => {
        clearTimeout(timeoutId);
    });
};

// 🟢 FIX 2: disableRetryOnRateLimit: true stops web3.js from spawning internal exponential retry cascades
const primaryConnection = new Connection(PRIMARY_URL, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: customTimeoutFetch
});

const backupConnection = new Connection(BACKUP_URL, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: customTimeoutFetch
});

const SYNC_SUBSCRIPTION_METHODS = new Set([
    'onAccountChange', 'onLogs', 'onProgramAccountChange', 
    'onSlotChange', 'onSignature', 'onRootChange'
]);
const SYNC_REMOVAL_METHODS = new Set([
    'removeAccountChangeListener', 'removeOnLogsListener', 
    'removeProgramAccountChangeListener', 'removeSlotChangeListener', 
    'removeSignatureListener', 'removeRootChangeListener'
]);

const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
let circuitOpenedAt: number | null = null;
let lastBreakerWarnAt = 0;
let consecutiveSuccesses = 0;

function isCircuitOpen(): boolean {
    if (circuitOpenedAt === null) return false;
    if (Date.now() - circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
        circuitOpenedAt = null;
        consecutiveSuccesses = 0;
        return false;
    }
    return true;
}

const FAILURE_WINDOW_MS = 15_000;
const MAX_FAILURES_IN_WINDOW = 15;
const failureTimestamps: number[] = [];

function recordPrimarySuccess() { 
    consecutiveSuccesses++;
    const now = Date.now();
    while (failureTimestamps.length > 0 && now - failureTimestamps[0] > FAILURE_WINDOW_MS) {
        failureTimestamps.shift();
    }
    if (consecutiveSuccesses >= 5 && circuitOpenedAt !== null) {
        circuitOpenedAt = null;
        failureTimestamps.length = 0;
        console.log("🟢 [RPC BREAKER] Primary RPC restored and circuit breaker closed.");
    }
}

function recordPrimaryFailure(error?: any) {
    consecutiveSuccesses = 0;
    const now = Date.now();
    failureTimestamps.push(now);
    while (failureTimestamps.length > 0 && now - failureTimestamps[0] > FAILURE_WINDOW_MS) {
        failureTimestamps.shift();
    }
    if (failureTimestamps.length >= MAX_FAILURES_IN_WINDOW) {
        circuitOpenedAt = now;
        if (now - lastBreakerWarnAt > 60000) {
            lastBreakerWarnAt = now;
            const errMsg = error?.message || 'Rate-Limited';
            console.warn(`🔴 [RPC BREAKER] RPC rate limit reached (${errMsg}). Routing traffic to backup RPC for 60s.`);
        }
    }
}

const MAX_CONCURRENT_RPC = Number(process.env.RPC_MAX_CONCURRENT || 8);
let activeCount = 0;

const BYPASS_QUEUE_METHODS = new Set([
    'sendRawTransaction', 'sendTransaction', 'getLatestBlockhash',
    'getSignatureStatus', 'getBalance'
]);

const waitQueueHigh: Array<() => void> = [];
const waitQueueLow: Array<() => void> = [];

async function acquireSlot(highPriority: boolean = false): Promise<void> {
    if (activeCount < MAX_CONCURRENT_RPC) {
        activeCount++;
        return;
    }
    await new Promise<void>((resolve) => {
        if (highPriority) waitQueueHigh.push(resolve);
        else waitQueueLow.push(resolve);
    });
    activeCount++;
}

function releaseSlot(): void {
    activeCount--;
    const next = waitQueueHigh.shift() || waitQueueLow.shift();
    if (next) next();
}

async function withSlot<T>(highPriority: boolean, fn: () => Promise<T>): Promise<T> {
    await acquireSlot(highPriority);
    try { return await fn(); } finally { releaseSlot(); }
}

async function executeWithFallback<T>(target: any, prop: any, args: any[]): Promise<T> {
    try {
        const currentConn = isCircuitOpen() ? backupConnection : target;
        const fn = Reflect.get(currentConn, prop);
        const result = await fn.apply(currentConn, args);
        recordPrimarySuccess();
        return result;
    } catch (err: any) {
        recordPrimaryFailure(err);
        // Fail fast: Try backup once without queuing retry storms
        if (!isCircuitOpen()) {
            try {
                const backupFn = Reflect.get(backupConnection, prop);
                return await backupFn.apply(backupConnection, args);
            } catch (_) {}
        }
        throw err;
    }
}

export const connection = new Proxy(primaryConnection, {
    get(target, prop, receiver) {
        if (prop === 'rpcEndpoint') return isCircuitOpen() ? backupConnection.rpcEndpoint : target.rpcEndpoint;
        
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;

        const methodName = String(prop);

        if (SYNC_SUBSCRIPTION_METHODS.has(methodName) || SYNC_REMOVAL_METHODS.has(methodName)) {
            return function (...args: any[]) {
                try { return value.apply(target, args); } 
                catch (error: any) {
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') return backupValue.apply(backupConnection, args);
                    throw error;
                }
            };
        }

        return function (...args: any[]) {
            const isHighPriority = methodName.includes('sendRawTransaction') || methodName.includes('getLatestBlockhash');

            if (BYPASS_QUEUE_METHODS.has(methodName)) {
                return executeWithFallback(target, prop, args);
            }

            return withSlot(isHighPriority, async () => {
                return executeWithFallback(target, prop, args);
            });
        };
    }
}) as unknown as Connection;

export const coldConnection = backupConnection;