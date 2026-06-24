// src/lib/connection.ts
import { Connection } from '@solana/web3.js';

import dotenv from 'dotenv';

dotenv.config();

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const BACKUP_URL = process.env.BACKUP_RPC_URL || "https://api.mainnet-beta.solana.com";

const primaryConnection = new Connection(HELIUS_URL, 'confirmed');
const backupConnection = new Connection(BACKUP_URL, 'confirmed');

// ─── Methods that return a synchronous subscription ID (not a Promise) ─────────
// Wrapping these as async breaks callers that store the return value as a number.
// The Proxy must call them synchronously and return the ID directly.
const SYNC_SUBSCRIPTION_METHODS = new Set([
    'onAccountChange',
    'onLogs',
    'onProgramAccountChange',
    'onSlotChange',
    'onSignature',
    'onRootChange',
]);

// ─── Removal methods — also synchronous, no failover needed ────────────────────
const SYNC_REMOVAL_METHODS = new Set([
    'removeAccountChangeListener',
    'removeOnLogsListener',
    'removeProgramAccountChangeListener',
    'removeSlotChangeListener',
    'removeSignatureListener',
    'removeRootChangeListener',
]);

// ─── Circuit breaker state ──────────────────────────────────────────
// Without this, every single async RPC call pays the full latency cost of
// trying-and-failing on `primaryConnection` first during a sustained Helius
// outage, before falling back to `backupConnection`. Under load (hundreds of
// calls/sec across guards, DCA, positions, etc.) this doubles latency and
// request volume on EVERY call for the entire outage window.
//
// After CIRCUIT_BREAKER_THRESHOLD consecutive primary failures, we "open" the
// circuit and route directly to backup for CIRCUIT_BREAKER_COOLDOWN_MS,
// periodically allowing a single "probe" call through to primary to detect
// recovery.
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30s

let consecutivePrimaryFailures = 0;
let circuitOpenedAt: number | null = null;

function isCircuitOpen(): boolean {
    if (circuitOpenedAt === null) return false;
    if (Date.now() - circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
        // Cooldown elapsed — allow one probe call through to primary.
        circuitOpenedAt = null;
        consecutivePrimaryFailures = 0;
        return false;
    }
    return true;
}

function recordPrimarySuccess() {
    consecutivePrimaryFailures = 0;
    circuitOpenedAt = null;
}

function recordPrimaryFailure() {
    consecutivePrimaryFailures++;
    if (consecutivePrimaryFailures >= CIRCUIT_BREAKER_THRESHOLD && circuitOpenedAt === null) {
        circuitOpenedAt = Date.now();
        console.warn(
            `🔴 [RPC CIRCUIT BREAKER] Primary RPC failed ${consecutivePrimaryFailures}x consecutively. ` +
            `Routing directly to backup for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s.`
        );
    }
}

// ─── Global concurrency limiter ─────────────────────────────────────
// PROBLEM THIS FIXES: every service (caller, dca, positions, guards, copytrade,
// engine, deposit watcher, etc.) calls `connection.<method>()` completely
// independently. None of them know how many *other* RPC calls are in flight
// at the same moment. Under normal load this is fine; under bursty load
// (e.g. scoreTokens() fanning out across 30 tokens every 60s, or 5 wallets
// executing a snipe in parallel) dozens of calls can hit Helius in the same
// 100ms window, blow through the plan's requests-per-second ceiling, and
// trigger 429s — which then trips the circuit breaker, which redirects the
// SAME burst onto the public backup RPC, which has an even lower ceiling and
// 429s near-instantly. The failover was solving the wrong problem: it had no
// way to throttle volume, only reroute it.
//
// This is a simple token-bucket-style limiter: only MAX_CONCURRENT requests
// are allowed in flight across the entire process at once; everything else
// queues. It is intentionally dependency-free (no p-limit) to avoid adding a
// package for ~20 lines of logic.
const MAX_CONCURRENT_RPC = Number(process.env.RPC_MAX_CONCURRENT || 8);

let activeCount = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
    if (activeCount < MAX_CONCURRENT_RPC) {
        activeCount++;
        return;
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve));
    activeCount++;
}

function releaseSlot(): void {
    activeCount--;
    const next = waitQueue.shift();
    if (next) next();
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquireSlot();
    try {
        return await fn();
    } finally {
        releaseSlot();
    }
}

/**
 * 🛡️ PROXY FAILOVER CONNECTION MANAGER
 *
 * FIX: Modified the synchronous traps so that WebSocket connections (onLogs, onAccountChange)
 * also benefit from fallback. If primary throws synchronously when subscribing, it now
 * seamlessly routes to the backup connection.
 *
 * FIX: All async RPC methods now pass through a global concurrency limiter
 * (withSlot) before reaching either primary or backup. This caps total
 * in-flight requests process-wide, which is what actually prevents 429s —
 * the circuit breaker alone only decided *where* to send failures, not
 * *how many* requests were allowed to pile up in the first place.
 */
export const connection = new Proxy(primaryConnection, {
    get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        if (typeof value !== 'function') return value;

        const methodName = String(prop);

        // Synchronous subscription methods — added try/catch fallback.
        // Not rate-limited: these open long-lived WS subscriptions, not
        // one-off requests, so they don't contribute to request-burst 429s
        // the same way. (If you're hitting WS-handshake 429s, that's a
        // concurrent-subscription-count ceiling on your RPC plan, not a
        // request-rate issue — see note in the chat response.)
        if (SYNC_SUBSCRIPTION_METHODS.has(methodName)) {
            return function (...args: any[]) {
                try {
                    return value.apply(target, args);
                } catch (error: any) {
                    console.warn(`⚠️ [WS FAILOVER] Primary failed on '${methodName}': ${error.message}. Switching to Backup RPC...`);
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') {
                        return backupValue.apply(backupConnection, args);
                    }
                    throw error;
                }
            };
        }

        // Synchronous removal methods — also synchronous, no failover needed
        // If a listener was created on the backup, removing it on primary will fail/do nothing.
        // This ensures the removal is attempted on the backup if it fails on primary.
        if (SYNC_REMOVAL_METHODS.has(methodName)) {
            return function (...args: any[]) {
                try {
                    return value.apply(target, args);
                } catch (error: any) {
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') {
                        return backupValue.apply(backupConnection, args);
                    }
                    throw error;
                }
            };
        }

        // All other async RPC methods — wrapped with the global concurrency
        // limiter FIRST, then failover + circuit breaker.
        return function (...args: any[]) {
            return withSlot(async () => {
                if (isCircuitOpen()) {
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') {
                        return await backupValue.apply(backupConnection, args);
                    }
                }

                try {
                    const result = await value.apply(target, args);
                    recordPrimarySuccess();
                    return result;
                } catch (error: any) {
                    console.warn(
                        `⚠️ [RPC FAILOVER] Primary RPC failed on '${methodName}': ${error.message}. Failing over to backup...`
                    );
                    recordPrimaryFailure();

                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') {
                        return await backupValue.apply(backupConnection, args);
                    }
                    throw error;
                }
            });
        };
    }
}) as unknown as Connection;