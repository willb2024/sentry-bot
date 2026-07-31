// src/lib/connection.ts
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

const PRIMARY_URL = process.env.PRIMARY_RPC_URL 
    || process.env.HELIUS_RPC_URL 
    || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : 'https://api.mainnet-beta.solana.com');

const BACKUP_URL = process.env.BACKUP_RPC_URL 
    || 'https://api.mainnet-beta.solana.com';

const primaryConnection = new Connection(PRIMARY_URL, 'confirmed');
const backupConnection = new Connection(BACKUP_URL, 'confirmed');

const SYNC_SUBSCRIPTION_METHODS = new Set([
    'onAccountChange', 'onLogs', 'onProgramAccountChange', 
    'onSlotChange', 'onSignature', 'onRootChange'
]);
const SYNC_REMOVAL_METHODS = new Set([
    'removeAccountChangeListener', 'removeOnLogsListener', 
    'removeProgramAccountChangeListener', 'removeSlotChangeListener', 
    'removeSignatureListener', 'removeRootChangeListener'
]);

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

function recordPrimarySuccess() { 
    consecutivePrimaryFailures = 0; 
    circuitOpenedAt = null; 
}

function recordPrimaryFailure() {
    consecutivePrimaryFailures++;
    if (consecutivePrimaryFailures >= CIRCUIT_BREAKER_THRESHOLD && circuitOpenedAt === null) {
        circuitOpenedAt = Date.now();
        console.warn(`🔴 [RPC CIRCUIT BREAKER] Primary Helius RPC failed ${CIRCUIT_BREAKER_THRESHOLD} times. Routing to backup RPC for 30s.`);
    }
}

// 🟢 Concurrency slots tuned for strict RPC limits
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

export const coldConnection = backupConnection;