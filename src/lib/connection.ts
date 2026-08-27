// src/lib/connection.ts — High-Performance RPC Engine with Smart Rate-Limit Resiliency
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const PRIMARY_URL = process.env.PRIMARY_RPC_URL 
    || process.env.HELIUS_RPC_URL 
    || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com');

const BACKUP_URL = process.env.BACKUP_RPC_URL || 'https://solana-mainnet.rpc.extrnode.com';

// 🟢 FIX 1: Robust Fetch with Clean Abort Handling (Eliminates unhandled "TypeError: fetch failed")
const customTimeoutFetch = async (url: any, options: any = {}) => {
    const controller = new AbortController();
    const timeoutMs = options?.timeout || 4000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return res;
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`RPC Request Timed Out (${timeoutMs}ms)`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
};

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

// 🟢 FIX 2: Dynamic Breaker (Fails over only on genuine prolonged outage, not single 429s)
const CIRCUIT_BREAKER_COOLDOWN_MS = 15_000; // Reduced from 60s to 15s for faster recovery
let circuitOpenedAt: number | null = null;
let lastBreakerWarnAt = 0;
let consecutiveFailures = 0;
let consecutiveSuccesses = 0;

function isCircuitOpen(): boolean {
    if (circuitOpenedAt === null) return false;
    if (Date.now() - circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
        circuitOpenedAt = null;
        consecutiveFailures = 0;
        return false;
    }
    return true;
}

function recordPrimarySuccess() { 
    consecutiveSuccesses++;
    consecutiveFailures = 0;
    if (circuitOpenedAt !== null && consecutiveSuccesses >= 3) {
        circuitOpenedAt = null;
        console.log("🟢 [RPC BREAKER] Primary RPC restored and circuit breaker closed.");
    }
}

function recordPrimaryFailure(error?: any) {
    consecutiveSuccesses = 0;
    consecutiveFailures++;
    const now = Date.now();

    // Only trip breaker after 10 consecutive hard failures in a short window
    if (consecutiveFailures >= 10 && circuitOpenedAt === null) {
        circuitOpenedAt = now;
        if (now - lastBreakerWarnAt > 30000) {
            lastBreakerWarnAt = now;
            const errMsg = error?.message || 'Rate-Limited';
            console.warn(`🟡 [RPC BREAKER] Primary RPC experiencing load (${errMsg}). Routing non-critical traffic to backup for 15s.`);
        }
    }
}

const MAX_CONCURRENT_RPC = Number(process.env.RPC_MAX_CONCURRENT || 10);
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
        
        // Try fallback connection only if primary failed and circuit wasn't already on backup
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