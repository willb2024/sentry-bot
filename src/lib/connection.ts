// src/lib/connection.ts
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const BACKUP_URL = process.env.BACKUP_RPC_URL || "https://api.mainnet-beta.solana.com";

const primaryConnection = new Connection(HELIUS_URL, 'confirmed');
const backupConnection = new Connection(BACKUP_URL, 'confirmed');

const SYNC_SUBSCRIPTION_METHODS = new Set(['onAccountChange', 'onLogs', 'onProgramAccountChange', 'onSlotChange', 'onSignature', 'onRootChange']);
const SYNC_REMOVAL_METHODS = new Set(['removeAccountChangeListener', 'removeOnLogsListener', 'removeProgramAccountChangeListener', 'removeSlotChangeListener', 'removeSignatureListener', 'removeRootChangeListener']);

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; 

let consecutivePrimaryFailures = 0;
let circuitOpenedAt: number | null = null;

function isCircuitOpen(): boolean {
    if (circuitOpenedAt === null) return false;
    if (Date.now() - circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
        circuitOpenedAt = null;
        consecutivePrimaryFailures = 0;
        return false;
    }
    return true;
}

function recordPrimarySuccess() { consecutivePrimaryFailures = 0; circuitOpenedAt = null; }

function recordPrimaryFailure() {
    consecutivePrimaryFailures++;
    if (consecutivePrimaryFailures >= CIRCUIT_BREAKER_THRESHOLD && circuitOpenedAt === null) {
        circuitOpenedAt = Date.now();
        console.warn(`🔴 [RPC CIRCUIT BREAKER] Primary RPC failed. Routing to backup for 30s.`);
    }
}

// 🟢 SPEED FIX: Raised MAX concurrent RPCs drastically from 8 to 40
const MAX_CONCURRENT_RPC = Number(process.env.RPC_MAX_CONCURRENT || 40);
let activeCount = 0;

// 🟢 SPEED FIX: These NEVER wait in the queue — trade submission and blockhash must be instant
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

export const connection = new Proxy(primaryConnection, {
    get(target, prop, receiver) {
        if (prop === 'rpcEndpoint') return target.rpcEndpoint;
        
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

            // 🟢 FAST PATH: Skip the semaphore completely for hot-path methods
            if (BYPASS_QUEUE_METHODS.has(methodName)) {
                return (async () => {
                    if (isCircuitOpen()) {
                        const backupValue = Reflect.get(backupConnection, prop);
                        if (typeof backupValue === 'function') return await backupValue.apply(backupConnection, args);
                    }
                    try {
                        const result = await value.apply(target, args);
                        recordPrimarySuccess();
                        return result;
                    } catch (error: any) {
                        recordPrimaryFailure();
                        const backupValue = Reflect.get(backupConnection, prop);
                        if (typeof backupValue === 'function') return await backupValue.apply(backupConnection, args);
                        throw error;
                    }
                })();
            }

            // STANDARD PATH: Queue background tasks
            return withSlot(isHighPriority, async () => {
                if (isCircuitOpen()) {
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') return await backupValue.apply(backupConnection, args);
                }
                try {
                    const result = await value.apply(target, args);
                    recordPrimarySuccess();
                    return result;
                } catch (error: any) {
                    recordPrimaryFailure();
                    const backupValue = Reflect.get(backupConnection, prop);
                    if (typeof backupValue === 'function') return await backupValue.apply(backupConnection, args);
                    throw error;
                }
            });
        };
    }
}) as unknown as Connection;

// 🟢 COLD CONNECTION: Non-latency critical read paths
export const coldConnection = backupConnection;