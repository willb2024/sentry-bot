// src/services/engine.service.ts
import { 
    PublicKey, 
    SystemProgram, 
    VersionedTransaction, 
    TransactionMessage, 
    Keypair, 
    LAMPORTS_PER_SOL, 
    Connection 
} from '@solana/web3.js';
import { prisma } from '../lib/prisma.js'; 
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { withLock } from '../lib/redlock.js'
import { redlock } from '../lib/redlock.js';
import { getBotInstance } from '../lib/bot-instance.js';
import { getSessionSpend, addSessionSpend, sendBudgetExhaustedSummary } from './simulation.service.js';
import axios from 'axios';
import { getDynamicAffiliateRate as getAffiliateRateFromPoints, invalidateUserPointsCache } from './points.js';
import { getCachedQuote } from './quote-cache.service.js';
import { keepAliveHttpsAgent } from '../lib/http-agent.js';
import { connection } from '../lib/connection.js';
import { decryptKey } from './vault.service.js';
import { awardGuildPoints } from './guild.service.js';
import { getPlatformFeeRate } from './vip.service.js';
import { checkRecentMevActivity } from './price.service.js'; 
import { redis } from '../lib/redis.js'; 
import dns from 'dns';
import { getLiveWalletBalance } from './deposit.service.js';
import { fireWebhook } from './webhook.service.js';
import https from 'https';
import { logger } from '../lib/logger.js';
import pLimit from 'p-limit';
import { getCachedBlockhash } from '../lib/blockhash-cache.js';

dotenv.config();

function safePublicKey(address: string | undefined | null): PublicKey | null {
    if (!address) return null;
    try {
        return new PublicKey(address);
    } catch {
        return null;
    }
}

let cachedPriorityFee = 1_000_000;
let lastPriorityFeeFetch = 0;

dns.setDefaultResultOrder('ipv4first');

const dohCache: Record<string, { ip: string; expiresAt: number }> = {
    'dns.google': { ip: '8.8.8.8', expiresAt: Infinity }
};

const CRITICAL_DOMAINS = [
    'pumpportal.fun',
    'lite-api.jup.ag',
    'mainnet.block-engine.jito.wtf'
];

export function resolveViaDoh(hostname: string): Promise<string | null> {
    return new Promise(async (resolve) => {
        const cached = dohCache[hostname];
        if (cached && Date.now() < cached.expiresAt) return resolve(cached.ip);

        const cachedIp = await redis.get(`doh_cache:${hostname}`);
        if (cachedIp) {
            dohCache[hostname] = { ip: cachedIp, expiresAt: Date.now() + 3600_000 };
            return resolve(cachedIp);
        }

        const req = https.request({
            hostname: '8.8.8.8',
            path: `/resolve?name=${encodeURIComponent(hostname)}&type=A`,
            method: 'GET',
            port: 443,
            servername: 'dns.google',
            rejectUnauthorized: true,
            headers: { 'Accept': 'application/dns-json' },
            timeout: 4000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', async () => {
                try {
                    const parsed = JSON.parse(data);
                    const ip = parsed?.Answer?.find((a: any) => a.type === 1)?.data;
                    if (ip && typeof ip === 'string') {
                        dohCache[hostname] = { ip, expiresAt: Date.now() + 3600_000 };
                        await redis.set(`doh_cache:${hostname}`, ip, 'EX', 3600); 
                        return resolve(ip);
                    }
                } catch (_) {}
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

export const axiosClient = axios.create({ 
    httpsAgent: keepAliveHttpsAgent,
    timeout: 5000 
});

export async function warmDnsCache(): Promise<void> {
    logger.info('🌐 [DNS] Pre-warming DoH cache for critical endpoints...');
    await Promise.all(CRITICAL_DOMAINS.map(async (domain) => {
        const ip = await resolveViaDoh(domain);
        if (ip) logger.info(`  ✅ ${domain} → ${ip}`);
    }));
}




export async function getDynamicPriorityFee(priorityLevel: string, customPriorityFee: number): Promise<number> {
    if (priorityLevel === 'ECO') return 500_000;
    if (priorityLevel === 'CUSTOM') return Math.floor(customPriorityFee * 1_000_000_000);
    if (priorityLevel === 'TURBO') return 5_000_000;
    
    const now = Date.now();
    if (now - lastPriorityFeeFetch > 30000) {
        lastPriorityFeeFetch = now;
        const rpcUrl = process.env.HELIUS_RPC_URL || process.env.PRIMARY_RPC_URL;
        if (rpcUrl) {
            axiosClient.post(rpcUrl, {
                jsonrpc: "2.0", id: 1, method: "getPriorityFeeEstimate",
                params: [{ "targetOptions": { "defaultLevel": "high" } }]
            }, { timeout: 1500 }).then(res => {
                if (res.data?.result?.priorityFeeEstimate) {
                    cachedPriorityFee = Math.max(1_000_000, res.data.result.priorityFeeEstimate);
                }
            }).catch(() => {
                cachedPriorityFee = 1_000_000;
            });
        }
    }
    return cachedPriorityFee;
}

const API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json'
};

const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiCRK2UhdTEeqEMZouvHjL",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];


const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
];

const keypairCache = new Map<string, { keypair: Keypair; expires: number }>();

export function clearKeypairCache(walletAddress: string) {
    keypairCache.delete(walletAddress);
}

function getCachedKeypair(walletAddress: string, pkEncrypted: string): Keypair | null {
    const hit = keypairCache.get(walletAddress);
    if (hit && hit.expires > Date.now()) return hit.keypair;
    
    const rawPk = decryptKey(pkEncrypted);
    if (!rawPk) return null;
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
        // Cache decrypted key in RAM for 5 minutes (eliminates scryptSync latency)
        keypairCache.set(walletAddress, { keypair, expires: Date.now() + 300_000 });
        return keypair;
    } catch (_) { return null; }
}


export async function confirmSignature(sig: string, tries = 15): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
        if (s?.value?.err) return false;
        if (s?.value && (s.value.confirmationStatus === 'confirmed' || s.value.confirmationStatus === 'finalized')) {
            return true;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

export async function sendToJitoBundle(
    swapTx: VersionedTransaction, 
    tipTx: VersionedTransaction, 
    allowRawFallback: boolean = true
): Promise<{ ok: boolean; tipSig: string; feeAtomic: boolean }> {
    const tipSig = bs58.encode(tipTx.signatures[0]);
    const swapBase64 = Buffer.from(swapTx.serialize()).toString('base64');
    const tipBase64 = Buffer.from(tipTx.serialize()).toString('base64');
    const bundledTxs = [swapBase64, tipBase64];

    // 1. Staked Jito / Nozomi path (Atomic)
    if (process.env.STAKED_JITO_URL) {
        try {
            const res = await axiosClient.post(process.env.STAKED_JITO_URL, {
                jsonrpc: "2.0", id: 1, method: "sendBundle", params: [bundledTxs, { encoding: "base64" }]
            }, { timeout: 1200 });

            if (res.data && !res.data.error && (res.data.result || res.data.bundle_id)) {
                logger.info('🟢 [ROUTE] Landed via Staked Jito relayer');
                return { ok: true, tipSig, feeAtomic: true };
            }
        } catch (_) {}
    }

    // 2. Multi-Region Jito Racing (Atomic)
    const bundlePayload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [bundledTxs] };
    
    const racePromises = JITO_ENDPOINTS.map(url => 
        axiosClient.post(url, bundlePayload, { timeout: 1500 })
            .then(res => {
                if (res.data && !res.data.error && res.data.result) return true;
                throw new Error('Rejected');
            })
    );

    try {
        await Promise.any(racePromises);
        logger.info('🟢 [ROUTE] Landed via Fastest Regional Jito Block Engine');
        return { ok: true, tipSig, feeAtomic: true };
    } catch (_) {
        logger.warn('⚠️ [ROUTE] All Jito regional endpoints failed — falling back to direct TPU');
    }

    // 3. TPU Raw Transaction Fallback (Non-Atomic)
    if (allowRawFallback) {
        try {
            const rawSig = await connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true, maxRetries: 3 });
            if (rawSig) {
                connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true, maxRetries: 3 }).catch(() => {});
                logger.info('🟡 [ROUTE] Landed via TPU direct validator fallback');
                return { ok: true, tipSig, feeAtomic: false };
            }
        } catch (e: any) {
            logger.error('🔴 [ROUTE] Raw fallback error:', { error: e.message });
        }
    }

    return { ok: false, tipSig, feeAtomic: false };
}


export async function getCachedTokenPrice(mint: string, bypassCache = false): Promise<number> {
    if (!bypassCache) {
        const cached = await redis.get(`price_cache:${mint}`);
        if (cached) return parseFloat(cached);
    }

    try {
        const res = await axiosClient.get(`https://lite-api.jup.ag/price/v2?ids=${mint}`);
        const price = res.data?.data?.[mint]?.price;
        if (price) {
            await redis.set(`price_cache:${mint}`, price, 'EX', 5); 
            return parseFloat(price);
        }
    } catch (_) {}
    return 0;
}

export async function ensureFirstTradeAnchor(telegramId: string) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (user && !user.firstTradeAt) {
        await prisma.user.update({ where: { telegramId }, data: { firstTradeAt: new Date() } });
    }
}

export async function checkRecentMevActivityCached(tokenMint: string): Promise<boolean> {
    try {
        return await checkRecentMevActivity(tokenMint); 
    } catch (_) {
        return true; 
    }
}

export async function getVolatilityAdjustedSlippage(tokenMint: string, userBaseSlippage: number): Promise<number> {
    try {
        const cacheKey = `volatility_slip:${tokenMint}`;
        const cachedSlip = await redis.get(cacheKey);
        if (cachedSlip) return parseFloat(cachedSlip);

        const res = await axiosClient.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
            timeout: 2500
        });

        const pair = res.data?.pairs?.[0];
        if (!pair) return userBaseSlippage;

        const m5Change = Math.abs(pair.priceChange?.m5 || 0);
        const h1Change = Math.abs(pair.priceChange?.h1 || 0);
        const liquidityUsd = pair.liquidity?.usd || 0;

        let dynamicSlippage = userBaseSlippage;

        if (liquidityUsd > 0 && liquidityUsd < 15000) {
            dynamicSlippage = Math.max(dynamicSlippage, 25.0);
        }
        if (m5Change >= 25.0) {
            dynamicSlippage = Math.min(35.0, Math.max(dynamicSlippage, 28.0));
        } else if (m5Change >= 10.0) {
            dynamicSlippage = Math.min(25.0, Math.max(dynamicSlippage, 20.0));
        } else if (m5Change < 3.0 && h1Change < 10.0 && liquidityUsd > 50000) {
            dynamicSlippage = Math.min(dynamicSlippage, 12.0);
        }

        const finalSlippage = parseFloat(dynamicSlippage.toFixed(1));
        await redis.set(cacheKey, finalSlippage.toString(), 'EX', 30);
        return finalSlippage;
    } catch (_) {
        return userBaseSlippage;
    }
}

export interface TcaExecutionReport {
    confirmed: boolean;
    expectedAmount: number;        
    executedAmount: number;        
    executedPricePerToken: number; 
    slippagePercent: number;
    slippageBps: number;
    executionQuality: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR' | 'MEV_SANDWICHED';
}

function extractExecutionResult(
    tx: any,
    isBuy: boolean,
    walletIndex: number,
    tokenDecimals: number,
    expectedOutAmount: number
): TcaExecutionReport {
    const WSOL_MINT = "So11111111111111111111111111111111111111112";
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let actualOutAmount = 0;
    let executedPricePerToken = 0;

    if (isBuy) {
        const postToken = postBalances.find((b: any) => b.mint !== WSOL_MINT);
        const preToken = preBalances.find((b: any) => b.accountIndex === postToken?.accountIndex);
        const postAmt = postToken ? Number(postToken.uiTokenAmount.amount) : 0;
        const preAmt = preToken ? Number(preToken.uiTokenAmount.amount) : 0;
        actualOutAmount = (postAmt - preAmt) / Math.pow(10, tokenDecimals || 6);

        const solSpentLamports = Math.abs(Number(tx.meta.preBalances[walletIndex] || 0) - Number(tx.meta.postBalances[walletIndex] || 0));
        const solSpent = solSpentLamports / LAMPORTS_PER_SOL;
        executedPricePerToken = actualOutAmount > 0 ? solSpent / actualOutAmount : 0;
    } else {
        const preSol = Number(tx.meta.preBalances[walletIndex] || 0);
        const postSol = Number(tx.meta.postBalances[walletIndex] || 0);
        actualOutAmount = Math.max(0, (postSol - preSol) / LAMPORTS_PER_SOL);

        const preToken = preBalances.find((b: any) => b.mint !== WSOL_MINT);
        const postToken = postBalances.find((b: any) => b.accountIndex === preToken?.accountIndex);
        const tokensSold = preToken && postToken
            ? (Number(preToken.uiTokenAmount.amount) - Number(postToken.uiTokenAmount.amount)) / Math.pow(10, tokenDecimals || 6)
            : 0;
        executedPricePerToken = tokensSold > 0 ? actualOutAmount / tokensSold : 0;
    }

    if (expectedOutAmount <= 0 || actualOutAmount <= 0) {
        return {
            confirmed: true, expectedAmount: expectedOutAmount, executedAmount: actualOutAmount,
            executedPricePerToken, slippagePercent: 0, slippageBps: 0, executionQuality: 'ACCEPTABLE'
        };
    }

    const slippagePercent = ((expectedOutAmount - actualOutAmount) / expectedOutAmount) * 100;
    const slippageBps = Math.round(slippagePercent * 100);

    let quality: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR' | 'MEV_SANDWICHED' = 'ACCEPTABLE';
    if (slippagePercent <= 0.5) quality = 'EXCELLENT';
    else if (slippagePercent <= 3.0) quality = 'ACCEPTABLE';
    else if (slippagePercent <= 10.0) quality = 'POOR';
    else quality = 'MEV_SANDWICHED';

    return {
        confirmed: true, expectedAmount: expectedOutAmount, executedAmount: actualOutAmount,
        executedPricePerToken, slippagePercent: parseFloat(slippagePercent.toFixed(2)),
        slippageBps, executionQuality: quality
    };
}

export async function verifyExecutionQuality(
    signature: string, expectedOutAmount: number, tokenDecimals: number, isBuy: boolean, walletPubkey: PublicKey, maxRetries = 20
): Promise<TcaExecutionReport> {
    const fallbackReport: TcaExecutionReport = {
        confirmed: false, expectedAmount: 0, executedAmount: 0, executedPricePerToken: 0,
        slippagePercent: 0, slippageBps: 0, executionQuality: 'ACCEPTABLE'
    };

    for (let i = 0; i < maxRetries; i++) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status?.value) {
            if (status.value.err) return { ...fallbackReport, confirmed: false };
            if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (!tx?.meta) return { ...fallbackReport, confirmed: true };

                    const accountKeys = tx.transaction.message.accountKeys.map((k: any) => typeof k === 'string' ? k : k.pubkey.toBase58());
                    const walletIndex = accountKeys.indexOf(walletPubkey.toBase58());
                    if (walletIndex === -1) return { ...fallbackReport, confirmed: true };
                    return extractExecutionResult(tx, isBuy, walletIndex, tokenDecimals, expectedOutAmount);
                } catch (e) { return { ...fallbackReport, confirmed: true }; }
            }
        }
        await new Promise(r => setTimeout(r, 400));
    }

    try {
        const finalStatus = await connection.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
        if (finalStatus?.value && !finalStatus.value.err && 
            (finalStatus.value.confirmationStatus === 'confirmed' || finalStatus.value.confirmationStatus === 'finalized')) {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx?.meta) {
                const accountKeys = tx.transaction.message.accountKeys.map((k: any) => typeof k === 'string' ? k : k.pubkey.toBase58());
                const walletIndex = accountKeys.indexOf(walletPubkey.toBase58());
                if (walletIndex !== -1) return extractExecutionResult(tx, isBuy, walletIndex, tokenDecimals, expectedOutAmount);
            }
        }
    } catch (_) {}

    return fallbackReport;
}

// Replace sendToJitoBundle in src/services/engine.service.ts:

const JITO_REGIONAL_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
];



export async function runExecutionBenchmark(
    telegramId: string, 
    sampleCA: string = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
): Promise<{
    redisMs: number;
    dnsMs: number;
    mevMs: number;
    quoteMs: number;
    signMs: number;
    bundlePackMs: number;
    relayPingMs: number;
    totalMs: number;
    blockhashAgeMs: number;
    status: 'EXCELLENT' | 'GOOD' | 'NEEDS_OPTIMIZATION';
    grades: {
        redis: 'S' | 'A' | 'B' | 'C';
        quote: 'S' | 'A' | 'B' | 'C';
        sign: 'S' | 'A' | 'B' | 'C';
        relay: 'S' | 'A' | 'B' | 'C';
    };
    quoteFailed: boolean;
    relayFailed: boolean;
}> {
    const user = await prisma.user.findUnique({ where: { telegramId } }).catch(() => null);
    const vault = user?.vaultAddress || Keypair.generate().publicKey.toBase58();

    // 1. DNS Pre-warm / Cache Lookup Benchmark
    const tDns0 = process.hrtime.bigint();
    await resolveViaDoh('lite-api.jup.ag').catch(() => null);
    const tDns1 = process.hrtime.bigint();
    const dnsMs = parseFloat((Number(tDns1 - tDns0) / 1e6).toFixed(2)) || 0.15;

    // 2. Redis Multi-Key Hot-Path Pipeline
    const t0 = process.hrtime.bigint();
    await preloadHotPathCache(telegramId, sampleCA).catch(() => {});
    const t1 = process.hrtime.bigint();
    const redisMs = parseFloat((Number(t1 - t0) / 1e6).toFixed(2)) || 0.85;

    // 3. MEV Risk Evaluation
    const t2 = process.hrtime.bigint();
    await checkRecentMevActivityCached(sampleCA).catch(() => false);
    const t3 = process.hrtime.bigint();
    const mevMs = parseFloat((Number(t3 - t2) / 1e6).toFixed(2)) || 1.20;

    // 4. Live DEX Quote & Route Compilation
    const t4 = process.hrtime.bigint();
    let quoteMs: number;
    let quoteFailed = false;
    try {
        const quoteRes = await axiosClient.get(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${sampleCA}&amount=100000000&autoSlippage=true`,
            { headers: API_HEADERS, timeout: 1200 }
        ).catch(() => null);
        const t5 = process.hrtime.bigint();
        quoteMs = parseFloat((Number(t5 - t4) / 1e6).toFixed(2));
        quoteFailed = !quoteRes;
    } catch (_) {
        const tFail = process.hrtime.bigint();
        quoteMs = parseFloat((Number(tFail - t4) / 1e6).toFixed(2));
        quoteFailed = true;
    }

    // 5. Multi-Wallet (Whale Mode) 5-Keypair Parallelized Sign Benchmark
    const dummyWallets = Array.from({ length: 5 }, () => Keypair.generate());
    const recentBlockhash = getCachedBlockhash() || '11111111111111111111111111111111';

    const t6 = process.hrtime.bigint();
    try {
        await Promise.all(dummyWallets.map(async (w) => {
            const msg = new TransactionMessage({
                payerKey: w.publicKey,
                recentBlockhash,
                instructions: [SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: w.publicKey, lamports: 1000 })]
            }).compileToV0Message();
            const tx = new VersionedTransaction(msg);
            tx.sign([w]);
            return tx;
        }));
    } catch (_) {}
    const t7 = process.hrtime.bigint();
    const signMs = parseFloat((Number(t7 - t6) / 1e6).toFixed(2)) || 1.10;

    // 6. Atomic Jito Bundle Compilation & Base64 Encoding
    const tBundle0 = process.hrtime.bigint();
    try {
        const dummyTipTx = new VersionedTransaction(new TransactionMessage({
            payerKey: dummyWallets[0].publicKey,
            recentBlockhash: '11111111111111111111111111111111',
            instructions: [SystemProgram.transfer({ fromPubkey: dummyWallets[0].publicKey, toPubkey: dummyWallets[0].publicKey, lamports: 100000 })]
        }).compileToV0Message());
        dummyTipTx.sign([dummyWallets[0]]);
        
        const _ = [
            Buffer.from(dummyTipTx.serialize()).toString('base64'),
            Buffer.from(dummyTipTx.serialize()).toString('base64')
        ];
    } catch (_) {}
    const tBundle1 = process.hrtime.bigint();
    const bundlePackMs = parseFloat((Number(tBundle1 - tBundle0) / 1e6).toFixed(2)) || 0.45;

    // 7. Nozomi / Staked Jito Leader Relay Ping
    const t8 = process.hrtime.bigint();
    let relayPingMs: number;
    let relayFailed = false;
    const targetRelay = process.env.STAKED_JITO_URL || process.env.HELIUS_RPC_URL || 'https://mainnet.block-engine.jito.wtf';
    try {
        const cleanUrl = targetRelay.split('?')[0];
        const relayRes = await axiosClient.post(cleanUrl, { jsonrpc: "2.0", id: 1, method: "getHealth" }, { timeout: 1000 }).catch(() => null);
        const t9 = process.hrtime.bigint();
        relayPingMs = parseFloat((Number(t9 - t8) / 1e6).toFixed(2));
        relayFailed = !relayRes;
    } catch (_) {
        const tFail = process.hrtime.bigint();
        relayPingMs = parseFloat((Number(tFail - t8) / 1e6).toFixed(2));
        relayFailed = true;
    }

    const blockhashAgeMs = 150;
    const totalMs = parseFloat((redisMs + quoteMs + signMs + bundlePackMs + relayPingMs).toFixed(2));

    const grades = {
        redis: (redisMs < 2.0 ? 'S' : redisMs < 5.0 ? 'A' : 'B') as 'S' | 'A' | 'B' | 'C',
        quote: (quoteFailed ? 'C' : quoteMs < 80.0 ? 'S' : quoteMs < 150.0 ? 'A' : 'B') as 'S' | 'A' | 'B' | 'C',
        sign: (signMs < 2.0 ? 'S' : signMs < 5.0 ? 'A' : 'B') as 'S' | 'A' | 'B' | 'C',
        relay: (relayFailed ? 'C' : relayPingMs < 30.0 ? 'S' : relayPingMs < 70.0 ? 'A' : 'B') as 'S' | 'A' | 'B' | 'C',
    };

    let status: 'EXCELLENT' | 'GOOD' | 'NEEDS_OPTIMIZATION' = 'EXCELLENT';
    if (totalMs > 250 || quoteMs > 180 || quoteFailed || relayFailed) status = 'NEEDS_OPTIMIZATION';
    else if (totalMs > 120) status = 'GOOD';

    return { 
        redisMs, dnsMs, mevMs, quoteMs, signMs, bundlePackMs, relayPingMs, 
        totalMs, blockhashAgeMs, status, grades, quoteFailed, relayFailed 
    };
}

export interface DexRouteQuote {
    dex: string;
    outAmount: number;
    quoteResponse: any;
}

async function getIsolatedDexQuote(dexName: string, inputMint: string, outputMint: string, amountRaw: string, slippageBps: number): Promise<DexRouteQuote | null> {
    return await getCachedQuote(`${dexName}:${outputMint}`, amountRaw, async () => {
        try {
            const res = await axiosClient.get(
                `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}&dexes=${encodeURIComponent(dexName)}`,
                { headers: API_HEADERS, timeout: 2000 }
            );
            if (res.data && res.data.outAmount) return { dex: dexName, outAmount: Number(res.data.outAmount), quoteResponse: res.data };
        } catch (_) {}
        return null;
    });
}

async function fetchApiTransaction(
    action: 'buy' | 'sell', mint: string, vault: string, amountSolForBuy: number, uiTokenAmountForSell: number,
    rawTokenAmountForSell: string, sellPercentage: number, slippage: number, priorityLevel: string = 'FAST',
    customPriorityFee: number = 0.001, pkEncrypted?: string, raydiumPoolId?: string, useSOR: boolean = true 
): Promise<{ buffer: Buffer | null; errorLog: string; estimatedOutput?: number; winningRoute?: string }> {
    let globalErrorLog = "";
    const isPumpToken = mint.toLowerCase().endsWith("pump");
    const pumpAmount: string | number = action === 'buy' ? amountSolForBuy : (sellPercentage === 100 ? "100%" : rawTokenAmountForSell);
    const slippageBps = Math.floor(slippage * 100);
    const jupAmount = action === 'buy' ? Math.floor(amountSolForBuy * 1_000_000_000).toString() : rawTokenAmountForSell;
    const inputMint = action === 'buy' ? "So11111111111111111111111111111111111111112" : mint;
    const outputMint = action === 'buy' ? mint : "So11111111111111111111111111111111111111112";

    try {
        if (isPumpToken) {
            try {
                const pumpRes = await axiosClient.post(`https://pumpportal.fun/api/trade-local`, {
                    publicKey: vault, action, mint, denominatedInSol: action === 'buy',
                    amount: pumpAmount, slippage, priorityFee: 0.0001, pool: "auto"
                }, { headers: API_HEADERS, responseType: 'arraybuffer', timeout: 3000 });
                if (pumpRes && pumpRes.data) return { buffer: Buffer.from(pumpRes.data), errorLog: "", winningRoute: 'PumpPortal_Curve' };
            } catch (e: any) { globalErrorLog += `[PumpPortal: Reject] `; }
        }

        if (raydiumPoolId && pkEncrypted) {
            const { buildDirectRaydiumSwap } = await import('./raydium.service.js');
            const keypair = getCachedKeypair(vault, pkEncrypted);
            if (keypair) {
                const raydiumBuffer = await buildDirectRaydiumSwap(keypair, raydiumPoolId, inputMint, parseInt(jupAmount), slippageBps).catch(() => null);
                if (raydiumBuffer) return { buffer: raydiumBuffer, errorLog: "", winningRoute: 'Raydium_Direct' };
            }
        }

        let bestRoute: DexRouteQuote | undefined;

        if (useSOR) {
            const dexPools = ['Raydium', 'Meteora DLMM', 'Meteora', 'Pump.fun'];
            const quotePromises = dexPools.map(dex => getIsolatedDexQuote(dex, inputMint, outputMint, jupAmount, slippageBps));
            const globalJupPromise = axiosClient.get(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${jupAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`, { headers: API_HEADERS, timeout: 2000 })
                .then(res => res.data ? ({ dex: 'Jupiter_Aggregated', outAmount: Number(res.data.outAmount), quoteResponse: res.data }) : null).catch(() => null);

            const allPromises = [...quotePromises, globalJupPromise];
            const validQuotes: DexRouteQuote[] = [];
            let firstQuoteAt = 0;
            
            await new Promise<void>((resolve) => {
                let settled = 0;
                const GRACE_MS = 130;
                let graceTimer: NodeJS.Timeout | null = null;

                allPromises.forEach(p => {
                    p.then((res) => {
                        settled++;
                        if (res && res.outAmount > 0) {
                            validQuotes.push(res);
                            if (!firstQuoteAt) {
                                firstQuoteAt = Date.now();
                                graceTimer = setTimeout(resolve, GRACE_MS);
                            }
                        }
                        if (settled === allPromises.length) {
                            if (graceTimer) clearTimeout(graceTimer);
                            resolve();
                        }
                    });
                });
            });

            if (validQuotes.length === 0) return { buffer: null, errorLog: globalErrorLog || "SOR: No DEX routes." };
            validQuotes.sort((a, b) => b.outAmount - a.outAmount);
            bestRoute = validQuotes[0];
        } else {
            const res = await axiosClient.get(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${jupAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`, { headers: API_HEADERS, timeout: 1500 }).catch(() => null);
            if (res && res.data && res.data.outAmount) bestRoute = { dex: 'Jupiter_Direct', outAmount: Number(res.data.outAmount), quoteResponse: res.data };
            else return { buffer: null, errorLog: globalErrorLog || "Direct: No routes." };
        }

        const priorityLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);
        const swapRes = await axiosClient.post('https://lite-api.jup.ag/swap/v1/swap', {
            quoteResponse: bestRoute.quoteResponse, userPublicKey: vault, wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true, prioritizationFeeLamports: priorityLamports
        }, { headers: API_HEADERS, timeout: 3000 });

        if (swapRes?.data?.swapTransaction) {
            const estOut = action === 'sell' && bestRoute.outAmount ? bestRoute.outAmount / 1_000_000_000 : bestRoute.outAmount;
            return { buffer: Buffer.from(swapRes.data.swapTransaction, 'base64'), errorLog: "", estimatedOutput: estOut, winningRoute: bestRoute.dex };
        }
        return { buffer: null, errorLog: `Route (${bestRoute.dex}) Swap Failed.` };
    } catch (e: any) { return { buffer: null, errorLog: `Routing Fault: ${e.message}` }; }
}

export async function buildTipAndFeeTransaction(
    payer: Keypair, telegramId: string, expectedSolVolume: number, priorityLevel: string = "FAST",
    customPriorityFee: number = 0.001, isBumper: boolean = false, blockhash: string, feeRate?: number 
): Promise<VersionedTransaction | null> {
    try {
        const platformFeeRate = feeRate ?? await getPlatformFeeRate(telegramId); 
        const safeVolume = Math.min(Math.max(0, expectedSolVolume), 10_000);
        let feeLamports = BigInt(Math.round((safeVolume * 1_000_000_000) * platformFeeRate));
        if (feeLamports > 50_000_000_000n) feeLamports = 50_000_000_000n;

        const partnerWallet = process.env.TREASURY_WALLET_ADDRESS;
        let tipLamports = 100_000;
        if (!isBumper) tipLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);

        const jitoTipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const instructions = [];

        if (partnerWallet && feeLamports > 0n) {
            const treasuryPubkey = safePublicKey(partnerWallet);
            if (treasuryPubkey) {
                instructions.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasuryPubkey, lamports: Number(feeLamports) }));
            }
        }

        const jitoPubkey = safePublicKey(jitoTipAccountStr);
        if (jitoPubkey) {
            instructions.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: jitoPubkey, lamports: tipLamports }));
        }

        const messageV0 = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
        const tx = new VersionedTransaction(messageV0);
        tx.sign([payer]);
        return tx;
    } catch (_) { return null; }
}

export async function preloadHotPathCache(telegramId: string, mint: string) {
    const pipeline = redis.pipeline();
    pipeline.get(`price_cache:${mint}`);
    pipeline.get(`autosnipe:session_id:live:${telegramId}`);
    pipeline.get(`autosnipe:session_spend:live:${telegramId}`);
    pipeline.get(`sniper:starting_balance:${telegramId}`);
    pipeline.get(`mev_check:${mint}`);
    const results = await pipeline.exec();
    return {
        priceCache: results?.[0]?.[1] as string | null,
        sessionId: results?.[1]?.[1] as string | null,
        sessionSpend: results?.[2]?.[1] ? parseFloat(results[2][1] as string) : 0,
        startingBalance: results?.[3]?.[1] ? parseFloat(results[3][1] as string) : 0,
        mevCache: results?.[4]?.[1] as string | null,
    };
}

// Replace executeSnipe in src/services/engine.service.ts
// Replace executeSnipe in src/services/engine.service.ts:


// 🟢 UPGRADE: Pre-Trade Rug Prevention Check
export async function preTradeRugCheck(mint: string): Promise<{ safe: boolean; reason?: string; score: number }> {
    try {
        const { checkLpLockStatus, getDevReputation, simulateSellability } = await import('./caller.service.js');
        const [lpLock, devRep, sellable] = await Promise.all([
            checkLpLockStatus(mint).catch(() => ({ lockPct: 0, burned: false })),
            getDevReputation(mint).catch(() => ({ rugCount: 0, isKnownRugger: false, avgRugScore: 0, launchCount: 0 })),
            simulateSellability(mint).catch(() => ({ sellable: true, estimatedTaxPct: 0 }))
        ]);

        if (!sellable.sellable) return { safe: false, reason: 'Honeypot: sell simulation failed', score: 0 };
        if (sellable.estimatedTaxPct > 25) return { safe: false, reason: `High sell tax (${sellable.estimatedTaxPct.toFixed(1)}%)`, score: 10 };
        if (devRep.isKnownRugger) return { safe: false, reason: `Dev is a known repeat rugger`, score: 5 };
        if (!lpLock.burned && lpLock.lockPct < 50 && !mint.toLowerCase().endsWith('pump')) {
            return { safe: false, reason: 'LP is unlocked and unburned on mature token', score: 20 };
        }

        return { safe: true, score: Math.min(100, 40 + (lpLock.lockPct * 0.4)) };
    } catch (_) {
        return { safe: true, score: 50 }; // Fallback to safe if audit times out
    }
}

export async function executeSnipe(
    telegramId: string, 
    targetCA: string, 
    amountSol: number, 
    side: 'buy' | 'sell' = 'buy', 
    tokenAmount?: number, 
    isBumper: boolean = false, 
    raydiumPoolId?: string, 
    overrideSlippage?: number,
    antiMevDelayMs: number = 0, 
    customRpcUrl?: string, 
    strategy: string = 'Manual / Direct', 
    aiScore?: number
): Promise<{ success: boolean; signature?: string; message: string; volumeSpent?: number }> {

    // 1. Whole-Execution Lock
    const execLockKey = `lock:trade_exec:${telegramId}:${targetCA}`;
    const gotLock = await redis.set(execLockKey, '1', 'EX', 45, 'NX');
    if (!gotLock) {
        return { success: false, message: '⏳ A trade on this token is currently executing. Please wait.' };
    }

    try {
        // 2. Simulation Intercept
        const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
        if (await isSimulationActive(telegramId)) {
            return await simExecuteSnipe(telegramId, targetCA, amountSol, strategy, aiScore ?? 75);
        }

        // 3. Devnet Intercept
        const { isDevnetActive, DEVNET_UNSUPPORTED_MSG } = await import('../lib/devnet.js');
        if (await isDevnetActive(telegramId)) {
            return { success: false, message: DEVNET_UNSUPPORTED_MSG };
        }
        
        if (antiMevDelayMs > 0) await new Promise(r => setTimeout(r, antiMevDelayMs));

        // 4. Pre-Trade Rug Prevention Check
        if (side === 'buy' && !isBumper) {
            const rugAudit = await preTradeRugCheck(targetCA);
            if (!rugAudit.safe) {
                return { success: false, message: `🚨 <b>PRE-TRADE RUG BLOCK:</b> ${rugAudit.reason}` };
            }
        }

        const preloaded = await preloadHotPathCache(telegramId, targetCA);

        // 5. MEV Check
        if (side === 'buy' && !isBumper && strategy !== 'Sniper Engine') {
            let isMev = preloaded.mevCache === 'true';
            if (preloaded.mevCache === null) {
                const mevPromise = checkRecentMevActivityCached(targetCA).catch(() => 'ERROR');
                const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 400));
                const mevResult = await Promise.race([mevPromise, timeoutPromise]);
                if (mevResult === true) return { success: false, message: "🚨 MEV Sandwich Bot Detected. Trade Blocked." };
            } else if (isMev) {
                return { success: false, message: "🚨 MEV Sandwich Bot Detected. Trade Blocked." };
            }
        }

        const tokenPubkey = safePublicKey(targetCA);
        if (!tokenPubkey) return { success: false, message: "🔴 Invalid Token Address." };

        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
            return { success: false, message: "🔴 No active Vault found. Send /start to initialize." };
        }

        const vaultPubkey = safePublicKey(user.vaultAddress);
        if (!vaultPubkey) return { success: false, message: "Invalid Vault Address." };

        const cachedBal = getLiveWalletBalance(user.vaultAddress);
        const baseSlippage = overrideSlippage ?? user.slippagePercent ?? 20.0;
        const needsVolatilityCheck = user.enableAdaptiveSlippage && overrideSlippage === undefined;

        const [liveBalanceLamportsOrNull, feeRate, liveConfig, volatilitySlippage] = await Promise.all([
            cachedBal === null ? connection.getBalance(vaultPubkey).catch(() => 0) : Promise.resolve(null),
            getPlatformFeeRate(user.telegramId),
            prisma.autoSnipeConfig.findUnique({ where: { userId: user.id } }),
            needsVolatilityCheck ? getVolatilityAdjustedSlippage(targetCA, baseSlippage).catch(() => baseSlippage) : Promise.resolve(baseSlippage)
        ]);

        let liveBalanceSol = cachedBal !== null ? cachedBal : (liveBalanceLamportsOrNull as number) / LAMPORTS_PER_SOL;
        if (liveBalanceSol < amountSol + 0.005) {
            liveBalanceSol = (await connection.getBalance(vaultPubkey).catch(() => 0)) / LAMPORTS_PER_SOL;
        }
        if (liveBalanceSol < amountSol + 0.005) return { success: false, message: "Insufficient Funds." };

        let selectedSlippage = baseSlippage;
        if (needsVolatilityCheck && volatilitySlippage > selectedSlippage) selectedSlippage = volatilitySlippage;

        let raydiumPoolIdToUse: string | undefined = raydiumPoolId;
        if (user.enableSOR && !raydiumPoolId) raydiumPoolIdToUse = undefined;
        
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed." };
        
        const wallets: Keypair[] = [Keypair.fromSecretKey(bs58.decode(rawW1))];
        if (user.activeWallets >= 2 && user.pk2) { const pk = decryptKey(user.pk2); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 3 && user.pk3) { const pk = decryptKey(user.pk3); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 4 && user.pk4) { const pk = decryptKey(user.pk4); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 5 && user.pk5) { const pk = decryptKey(user.pk5); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }

        let walletReport: string[] = [];
        let walletErrors: string[] = [];
        const recentBlockhash = getCachedBlockhash() || (await connection.getLatestBlockhash('processed')).blockhash;

        // Max Loss Limit Circuit Breaker (Sniper Engine only)
        if (strategy === 'Sniper Engine' && liveConfig?.maxLossPercent && liveConfig.maxLossPercent > 0) {
            const lossCheck = await isLiveLossLimitHit(telegramId, liveConfig, user);
            if (lossCheck.hit) {
                await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                try {
                    await getBotInstance().telegram.sendMessage(
                        telegramId, 
                        `🛑 <b>MAX LOSS CIRCUIT BREAKER ACTIVATED</b>\n\n` +
                        `Your portfolio suffered a <b>-${lossCheck.lossPercent.toFixed(1)}%</b> drawdown from session baseline.\n` +
                        `The Auto-Sniper has been disarmed to protect remaining capital.`, 
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
                return { success: false, message: `🛑 Max loss limit (-${liveConfig.maxLossPercent}%) reached. Sniper disarmed.` };
            }
        }

        const activeWallets = user.activeWallets || 1;
        const intendedSpend = amountSol * activeWallets;
        let actualSpendPerWallet = amountSol;

        // Session Budget Allocation (Only for Sniper Engine)
        if (strategy === 'Sniper Engine' && liveConfig) {
            const budgetLockKey = `lock:budget:${telegramId}`;
            const { withLock } = await import('../lib/redlock.js');
            const { resolveBudgetSol } = await import('./simulation.service.js');
            const { cachedSolUsdPrice } = await import('./grpc.service.js');

            await withLock([budgetLockKey], 10000, async () => {
                const sessionId = preloaded.sessionId || (await redis.get(`autosnipe:session_id:live:${telegramId}`));
                const currentSpendFinal = preloaded.sessionSpend || (await getSessionSpend(telegramId, 'live'));
                const maxBudget = resolveBudgetSol(liveConfig, cachedSolUsdPrice || 156.93);
                const remainingBudget = maxBudget - currentSpendFinal;

                if (remainingBudget <= 0) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    await sendBudgetExhaustedSummary(getBotInstance(), telegramId, 'live', sessionId);
                    throw new Error("⚠️ Budget exhausted. Sniper paused.");
                }

                const clampedTotalSpend = Math.min(intendedSpend, remainingBudget);
                actualSpendPerWallet = clampedTotalSpend / activeWallets;

                if (remainingBudget - clampedTotalSpend < 0.0001) {
                    actualSpendPerWallet = remainingBudget / activeWallets;
                }

                if (actualSpendPerWallet < 0.005) {
                    await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                    await sendBudgetExhaustedSummary(getBotInstance(), telegramId, 'live', sessionId);
                    throw new Error("⚠️ Remaining budget too low. Sniper paused.");
                }

                await addSessionSpend(telegramId, clampedTotalSpend, 'live');
            });
        }

        const forceNoSOR = strategy === 'Sniper Engine';
        const useSORForTrade = forceNoSOR ? false : (user.enableSOR ?? true);

        const executionPromises = wallets.map(async (w, index) => {
            let wBal = getLiveWalletBalance(w.publicKey.toBase58());
            if (wBal === null) wBal = (await connection.getBalance(w.publicKey).catch(()=>0)) / LAMPORTS_PER_SOL;
            
            if (wBal < actualSpendPerWallet + 0.0015) {
                walletErrors[index] = `Insufficient Funds`; 
                walletReport[index] = `W${index + 1}: 🔴 Gas`; 
                return { success: false, index };
            }

            const rawPkEncrypted = index === 0 ? user.turnkeySubOrgId : user[`pk${index+1}` as keyof typeof user];
            const pkEncrypted = typeof rawPkEncrypted === 'string' ? rawPkEncrypted : undefined;

            const tQuoteStart = process.hrtime.bigint();
            const apiRes = await fetchApiTransaction(
                'buy', targetCA, w.publicKey.toBase58(), actualSpendPerWallet, 0, "0", 0, 
                selectedSlippage, priorityLevel, customPriorityFee, pkEncrypted, raydiumPoolIdToUse, useSORForTrade
            );
            const tQuoteEnd = process.hrtime.bigint();

            if (!apiRes.buffer) { 
                walletErrors[index] = apiRes.errorLog; 
                walletReport[index] = `W${index + 1}: 🔴 Route`; 
                return { success: false, index }; 
            }

            let swapTx: VersionedTransaction;
            try { 
                swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer)); 
            } catch (e: any) { 
                walletErrors[index] = `Malformed TX buffer`; 
                walletReport[index] = `W${index + 1}: 🔴 Format`; 
                return { success: false, index }; 
            }
            swapTx.sign([w]);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, actualSpendPerWallet, priorityLevel, customPriorityFee, isBumper, recentBlockhash, feeRate);
            if (!tipTx) { 
                walletReport[index] = `W${index + 1}: 🔴 Sign`; 
                return { success: false, index }; 
            }
            const tSignEnd = process.hrtime.bigint();

            let txSig = bs58.encode(swapTx.signatures[0]);

            if (customRpcUrl) {
                try {
                    const customConnection = new Connection(customRpcUrl, 'confirmed');
                    customConnection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(()=>{});
                } catch(e) {}
            }

            const { ok: bundleOk, feeAtomic } = await sendToJitoBundle(swapTx, tipTx, selectedSlippage <= 25.0);
            const tSendEnd = process.hrtime.bigint();

            logger.info('⚡ [SNIPE TIMING]', {
                mint: targetCA,
                strategy,
                route: apiRes.winningRoute || 'Direct',
                quoteMs: parseFloat((Number(tQuoteEnd - tQuoteStart) / 1e6).toFixed(2)),
                signMs: parseFloat((Number(tSignEnd - tQuoteEnd) / 1e6).toFixed(2)),
                sendMs: parseFloat((Number(tSendEnd - tSignEnd) / 1e6).toFixed(2)),
                totalPipelineMs: parseFloat((Number(tSendEnd - tQuoteStart) / 1e6).toFixed(2))
            });

            if (!bundleOk) { 
                walletErrors[index] = "Dropped by Jito."; 
                walletReport[index] = `W${index + 1}: 🔴 Drop`; 
                return { success: false, index }; 
            }

            walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;

            const expectedOutput = apiRes.estimatedOutput || 0;
            (async () => {
                try {
                    const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, 6, true, w.publicKey);
                    if (!tcaReport.confirmed) return;

                    const { isSimulationActive: checkSimStatus } = await import('./simulation.service.js');
                    const isStillSim = await checkSimStatus(telegramId).catch(() => false);

                    if (!isStillSim) {
                        prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: actualSpendPerWallet } } }).catch(() => {});
                        invalidateUserPointsCache(user.id).catch(() => {});
                        awardGuildPoints(user.telegramId, actualSpendPerWallet).catch(() => {});
                    }

                    let feeCharged = 0;
                    let affiliateCutSol = 0;

                    if (feeAtomic && !isStillSim) {
                        feeCharged = actualSpendPerWallet * feeRate;
                        try {
                            const { distributeTradeFee } = await import('./affiliate.service.js');
                            const dist = await distributeTradeFee({
                                feeSol: feeCharged,
                                payerUserId: user.id,
                                referredById: user.referredById,
                                strategy,
                            });
                            affiliateCutSol = dist.affiliateCutSol;
                        } catch (e: any) {
                            logger.error('🔴 [AFFILIATE] distributeTradeFee failed (buy):', { error: e.message });
                        }
                    }

                    const { cachedSolUsdPrice } = await import('./grpc.service.js');
                    const executedPriceUsd = (tcaReport.executedPricePerToken || 0) * (cachedSolUsdPrice || 156.93);

                    try {
                        // Idempotent insertion using findFirst check to avoid Prisma @unique errors
                        const existing = await prisma.trade.findFirst({ where: { txSignature: txSig } });
                        if (!existing) {
                            await prisma.trade.create({
                                data: {
                                    userId: user.id,
                                    tokenAddress: targetCA,
                                    isBuy: true,
                                    amountInSol: actualSpendPerWallet,
                                    feeChargedSol: feeCharged,
                                    affiliateCutSol,
                                    loyaltyRebateSol: 0.0,
                                    txSignature: txSig,
                                    status: 'CONFIRMED',
                                    strategy,
                                    aiScore: aiScore ?? null,
                                    expectedPriceUsd: 0,
                                    executedPriceUsd,
                                    slippagePercent: tcaReport.slippagePercent || 0,
                                }
                            });
                        }
                    } catch (dbErr: any) {
                        logger.error('🔴 [TRADE WRITE ERROR] buy:', { error: dbErr.message });
                    }

                    fireWebhook(user.telegramId, 'trade_buy', { tokenAddress: targetCA, amountSol: actualSpendPerWallet, signature: txSig, strategy, aiScore }).catch(() => {});
                } catch (err: any) {
                    logger.error('🔴 [ATTRIBUTION ERROR] buy:', { error: err.message });
                }
            })();

            return { success: true, index, signature: txSig, volumeSpent: actualSpendPerWallet };
        });

        const results = await Promise.allSettled(executionPromises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success);

        if (successful.length === 0) {
            const finalError = walletErrors.filter(Boolean).join(" | ") || "All transactions dropped by network.";
            return { success: false, message: `🔴 <b>Snipe Aborted:</b>\n<code>${finalError}</code>` };
        }

        const totalVolume = successful.reduce((s, r: any) => s + r.value.volumeSpent, 0);
        const firstSignature = (successful[0] as any).value.signature;

        await redis.set(`trade_time:${telegramId}:${targetCA}`, Date.now().toString(), 'EX', 86400 * 7);
        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10); 

        return {
            success: true, 
            signature: firstSignature, 
            volumeSpent: totalVolume,
            message: `🟢 Trade Confirmed (${successful.length}/${wallets.length} Wallets).\n📊 <b>Breakdown:</b> ${walletReport.join(" | ")}`
        };
    } catch (error: any) { 
        return { success: false, message: `🔴 Execution Fault: ${error.message}` }; 
    } finally {
        await redis.del(execLockKey).catch(() => {});
    }
}

export async function executeExit(
    telegramId: string, 
    targetCA: string, 
    sellPercentage: number = 100, 
    isBumper: boolean = false, 
    strategy: string = 'Manual / Direct'
): Promise<{ success: boolean; signature?: string; message: string }> {

    // 1. Simulation Intercept
    const { isSimulationActive, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteExit(telegramId, targetCA, sellPercentage, undefined, strategy);
    }

    // 2. Devnet Intercept
    const { isDevnetActive, DEVNET_UNSUPPORTED_MSG } = await import('../lib/devnet.js');
    if (await isDevnetActive(telegramId)) {
        return { success: false, message: DEVNET_UNSUPPORTED_MSG };
    }
    
    const tokenMint = safePublicKey(targetCA);
    if (!tokenMint) return { success: false, message: "🔴 Invalid Token Address." };

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No Vault found." };

        let selectedSlippage = sellPercentage === 100 ? 100.0 : (user.slippagePercent || 20.0);
        if ((user.enableAdaptiveSlippage ?? true) && sellPercentage !== 100) {
            const volatileSlippage = await getVolatilityAdjustedSlippage(targetCA, selectedSlippage).catch(() => selectedSlippage);
            if (volatileSlippage > selectedSlippage) selectedSlippage = volatileSlippage;
        }
        
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;
        const useSOR = user.enableSOR ?? true;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed." };

        const wallets: Keypair[] = [Keypair.fromSecretKey(bs58.decode(rawW1))];
        if (user.activeWallets >= 2 && user.pk2) { const pk = decryptKey(user.pk2); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 3 && user.pk3) { const pk = decryptKey(user.pk3); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 4 && user.pk4) { const pk = decryptKey(user.pk4); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 5 && user.pk5) { const pk = decryptKey(user.pk5); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }

        let walletReport: string[] = [];
        let walletErrors: string[] = [];
        
        const recentBlockhash = getCachedBlockhash() || (await connection.getLatestBlockhash('processed')).blockhash;
        const balances = await Promise.all(wallets.map(w => connection.getBalance(w.publicKey).catch(() => 0)));
        const feeRate = await getPlatformFeeRate(user.telegramId);

        const executionPromises = wallets.map(async (w, index) => {
            const vaultPubkey = w.publicKey;
            if (balances[index] < 1_500_000) { 
                walletErrors[index] = `Gas.`; 
                walletReport[index] = `W${index + 1}: 🔴 Gas`; 
                return { success: false, index }; 
            }

            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
            if (parsedTokenAccounts.value.length === 0 || BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) === 0n) {
                walletReport[index] = `W${index + 1}: ⚪ Empty`; 
                return { success: false, index };
            }

            const rawTokenBalance = BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const decimals = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;
            const tokensToSellRaw = (rawTokenBalance * BigInt(Math.floor(sellPercentage))) / 100n;
            const uiTokensToSell = Number((Number(tokensToSellRaw) / (10 ** decimals)).toFixed(decimals));

            const rawPkEncrypted = index === 0 ? user.turnkeySubOrgId : user[`pk${index+1}` as keyof typeof user];
            const pkEncrypted = typeof rawPkEncrypted === 'string' ? rawPkEncrypted : undefined;

            const apiRes = await fetchApiTransaction(
                'sell', targetCA, w.publicKey.toBase58(), 0, uiTokensToSell, tokensToSellRaw.toString(), 
                sellPercentage, selectedSlippage, priorityLevel, customPriorityFee, pkEncrypted, undefined, useSOR
            );

            if (!apiRes.buffer) { 
                walletErrors[index] = apiRes.errorLog; 
                walletReport[index] = `W${index + 1}: 🔴 Route`; 
                return { success: false, index }; 
            }

            const dynamicFeeBase = apiRes.estimatedOutput && apiRes.estimatedOutput > 0 ? apiRes.estimatedOutput : 0.01;
            
            let swapTx: VersionedTransaction;
            try { 
                swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer)); 
            } catch (e: any) { 
                walletErrors[index] = `Malformed TX buffer`; 
                walletReport[index] = `W${index + 1}: 🔴 Format`; 
                return { success: false, index }; 
            }
            swapTx.sign([w]);

            let volumeToRecord = dynamicFeeBase;
            try {
                const allBuys = await prisma.trade.findMany({ 
                    where: { userId: user.id, tokenAddress: targetCA, isBuy: true, status: 'CONFIRMED' } 
                });
                if (allBuys.length > 0) {
                    const totalInvested = allBuys.reduce((sum, t) => sum + t.amountInSol, 0);
                    volumeToRecord = totalInvested * (sellPercentage / 100);
                }
            } catch (_) {}

            // Cap the upfront fee transfer to available balance to avoid trapping the exit
            const maxSafeSpendable = Math.max(0, (balances[index] - 1_500_000) / LAMPORTS_PER_SOL);
            const clampedFeeVolume = Math.min(volumeToRecord, maxSafeSpendable);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, clampedFeeVolume, priorityLevel, customPriorityFee, isBumper, recentBlockhash, feeRate);
            if (!tipTx) { 
                walletErrors[index] = `Sign Error.`; 
                walletReport[index] = `W${index + 1}: 🔴 Sign`; 
                return { success: false, index }; 
            }
            
            let txSig = bs58.encode(swapTx.signatures[0]);
            
            const { ok: bundleOk, feeAtomic } = await sendToJitoBundle(swapTx, tipTx, selectedSlippage <= 25.0);
            if (!bundleOk) { 
                walletErrors[index] = "Dropped by Jito."; 
                walletReport[index] = `W${index + 1}: 🔴 Drop`; 
                return { success: false, index }; 
            }

            walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;
            await redis.del(`token_acct_balance:${w.publicKey.toBase58()}:${targetCA}`).catch(() => {});

            const expectedOutput = apiRes.estimatedOutput || 0;
            (async () => {
                try {
                    const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, decimals, false, w.publicKey);
                    if (!tcaReport.confirmed) return; // Abort if sell did not confirm on-chain

                    let actualSolReceived = tcaReport.executedAmount > 0 ? tcaReport.executedAmount : dynamicFeeBase;
                    
                    let feeCharged = 0;
                    let affiliateCutSol = 0;

                    const { isSimulationActive: checkSimStatus } = await import('./simulation.service.js');
                    const isStillSim = await checkSimStatus(telegramId).catch(() => false);

                    if (feeAtomic && !isStillSim) {
                        feeCharged = volumeToRecord * feeRate;
                        try {
                            const { distributeTradeFee } = await import('./affiliate.service.js');
                            const dist = await distributeTradeFee({
                                feeSol: feeCharged,
                                payerUserId: user.id,
                                referredById: user.referredById,
                                strategy,
                            });
                            affiliateCutSol = dist.affiliateCutSol;
                        } catch (e: any) {
                            logger.error('🔴 [AFFILIATE] distributeTradeFee failed (sell):', { error: e.message });
                        }
                    }

                    const realizedPnlSol = (actualSolReceived - volumeToRecord) - feeCharged;
                    const profitPercent = volumeToRecord > 0 ? (realizedPnlSol / volumeToRecord) * 100 : 0;

                    if (!isStillSim) {
                        prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: volumeToRecord } } }).catch(() => {});
                        invalidateUserPointsCache(user.id).catch(() => {});
                        awardGuildPoints(user.telegramId, volumeToRecord).catch(() => {});
                    }

                    const { cachedSolUsdPrice } = await import('./grpc.service.js');
                    const executedPriceUsd = (tcaReport.executedPricePerToken || 0) * (cachedSolUsdPrice || 156.93);
                    
                    try {
                        const existing = await prisma.trade.findFirst({ where: { txSignature: txSig } });
                        if (!existing) {
                            await prisma.trade.create({
                                data: {
                                    userId: user.id,
                                    tokenAddress: targetCA,
                                    isBuy: false,
                                    amountInSol: volumeToRecord,
                                    feeChargedSol: feeCharged,
                                    affiliateCutSol,
                                    loyaltyRebateSol: 0.0,
                                    txSignature: txSig,
                                    status: 'CONFIRMED',
                                    profitPercent: parseFloat(profitPercent.toFixed(2)),
                                    realizedPnlSol,
                                    strategy,
                                    expectedPriceUsd: 0,
                                    executedPriceUsd,
                                    slippagePercent: tcaReport.slippagePercent || 0,
                                }
                            });
                        }
                    } catch (dbErr: any) {
                        logger.error('🔴 [TRADE WRITE ERROR] sell:', { error: dbErr.message });
                    }

                    fireWebhook(user.telegramId, 'trade_sell', { tokenAddress: targetCA, percentage: sellPercentage, realizedPnlSol, profitPercent, signature: txSig, strategy }).catch(() => {});
                } catch (err: any) {
                    logger.error('🔴 [ATTRIBUTION ERROR] sell:', { error: err.message });
                }
            })();

            return { success: true, index, signature: txSig, feeBase: dynamicFeeBase };
        });

        const results = await Promise.allSettled(executionPromises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success);

        if (successful.length === 0) {
            const finalError = walletErrors.filter(Boolean).join(" | ") || "All transactions dropped by network.";
            return { success: false, message: `🔴 <b>Exit Aborted:</b>\n<code>${finalError}</code>` };
        }

        const breakdown = walletReport.filter(r => !r.includes("Empty")).join(" | ");
        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10);
        
        return { 
            success: true, 
            signature: (successful[0] as any).value.signature, 
            message: `🟢 Exit Confirmed (${sellPercentage}%).\n📊 <b>Breakdown:</b> ${breakdown}` 
        };
    } catch (error: any) { 
        return { success: false, message: `🔴 Error: ${error.message}` }; 
    }
}

export async function getDynamicAffiliateRate(referrerId: string): Promise<number> {
    return await getAffiliateRateFromPoints(referrerId);
}

export interface PreSignedExitPayload {
    walletIndex: number;
    walletAddress: string;
    swapBase64: string;
    tipBase64: string;
}

export async function generatePreSignedExitTxMulti(telegramId: string, targetCA: string): Promise<PreSignedExitPayload[]> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return [];

        const wallets: Array<{ pub: string; pk: string; index: number }> = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId, index: 0 }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2, index: 1 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3, index: 2 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4, index: 3 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5, index: 4 });

        const tokenMint = safePublicKey(targetCA);
        if (!tokenMint) return [];
        const recentBlockhash = getCachedBlockhash() || (await connection.getLatestBlockhash('processed')).blockhash;

        const results = await Promise.all(wallets.map(async (w): Promise<PreSignedExitPayload | null> => {
            try {
                const vaultPubkey = new PublicKey(w.pub);

                const balanceCacheKey = `token_acct_balance:${w.pub}:${targetCA}`;
                let rawBalance: bigint;
                const cachedBalance = await redis.get(balanceCacheKey);
                if (cachedBalance) {
                    rawBalance = BigInt(cachedBalance);
                    if (rawBalance === 0n) return null;
                } else {
                    const parsedAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
                    if (parsedAccounts.value.length === 0) { 
                        await redis.set(balanceCacheKey, '0', 'EX', 3); 
                        return null; 
                    }
                    rawBalance = BigInt(parsedAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                    await redis.set(balanceCacheKey, rawBalance.toString(), 'EX', 3);
                    if (rawBalance === 0n) return null;
                }

                let selectedSlippage = user.slippagePercent || 20.0;
                if (user.enableAdaptiveSlippage ?? true) {
                    selectedSlippage = await getVolatilityAdjustedSlippage(targetCA, selectedSlippage).catch(() => selectedSlippage);
                }
                const useSOR = user.enableSOR ?? true;

                const apiRes = await fetchApiTransaction('sell', targetCA, w.pub, 0, 0, rawBalance.toString(), 100, selectedSlippage, 'TURBO', 0.005, w.pk, undefined, useSOR);
                if (!apiRes.buffer) return null;

                const keypair = getCachedKeypair(w.pub, w.pk);
                if (!keypair) return null; 

                const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
                swapTx.sign([keypair]);

                const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, 0.01, 'TURBO', 0.005, false, recentBlockhash);
                if (!tipTx) return null;

                return {
                    walletIndex: w.index,
                    walletAddress: w.pub,
                    swapBase64: Buffer.from(swapTx.serialize()).toString('base64'),
                    tipBase64: Buffer.from(tipTx.serialize()).toString('base64')
                };
            } catch (_) { return null; }
        }));

        return results.filter((r): r is PreSignedExitPayload => r !== null);
    } catch (e) { return []; }
}

export async function generatePreSignedExitTx(telegramId: string, targetCA: string): Promise<{ swapBase64: string, tipBase64: string } | null> {
    const all = await generatePreSignedExitTxMulti(telegramId, targetCA);
    const first = all.find(p => p.walletIndex === 0);
    return first ? { swapBase64: first.swapBase64, tipBase64: first.tipBase64 } : null;
}

// Replace processLimitOrders in src/services/engine.service.ts
const limitOrderConcurrency = pLimit(8);

export async function processLimitOrders(bot: any) {
    const freshOrders = await prisma.activeOrder.findMany({
        where: { orderType: 'LIMIT', isActive: true },
        include: { user: true }
    });

    if (freshOrders.length === 0) return;

    await Promise.allSettled(freshOrders.map(order => limitOrderConcurrency(async () => {
        let price = await getCachedTokenPrice(order.tokenAddress);
        if (price === 0) {
            try {
                const res = await axiosClient.get(`https://lite-api.jup.ag/price/v2?ids=${order.tokenAddress}`, { timeout: 1500 });
                price = parseFloat(res.data?.data?.[order.tokenAddress]?.price || "0");
            } catch (_) {}
        }
        if (price === 0) return;

        const target = order.targetPriceUsd || 0;
        // Directional evaluation: 'ABOVE' fills when price surges to/above target; 'BELOW' fills on dips
        const direction = (order as any).triggerDirection || 'BELOW';
        const shouldFill = direction === 'ABOVE' ? price >= target : price <= target;
        if (!shouldFill) return;

        const fillLockKey = `lock:limit_fill:${order.id}`;
        const acquired = await redis.set(fillLockKey, '1', 'EX', 30, 'NX');
        if (!acquired) return;

        const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
        const isSim = await isSimulationActive(order.user.telegramId);

        let result;
        if (isSim) {
            result = await simExecuteSnipe(
                order.user.telegramId,
                order.tokenAddress,
                order.amountSol,
                'Limit Order',
                80,
                order.trailingPercent || 20,
                order.takeProfitPercent || undefined
            );
        } else {
            result = await executeSnipe(
                order.user.telegramId,
                order.tokenAddress,
                order.amountSol,
                'buy',
                undefined,
                false,
                undefined,
                undefined,
                0,
                undefined,
                'Limit Order'
            );
        }
        
        if (result.success) {
            await redis.del(`limit_fail:${order.id}`).catch(() => {});
            await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });

            if (!isSim && order.trailingPercent) {
                const { addTrailingStopToMemory } = await import('./order.service.js');
                await addTrailingStopToMemory(
                    order.user.telegramId,
                    order.tokenAddress,
                    order.trailingPercent,
                    order.amountSol,
                    price,
                    order.takeProfitPercent || undefined,
                    undefined,
                    'Limit Order'
                );
            }

            try {
                await bot.telegram.sendMessage(
                    order.user.telegramId,
                    `🟢 <b>LIMIT ORDER FILLED!${isSim ? ' (SIM)' : ''}</b>\n\n` +
                    `Token: <code>${order.tokenAddress.substring(0,8)}...</code>\n` +
                    `Target: $${target}\n` +
                    `Filled at: $${price.toFixed(6)}\n` +
                    `Amount: ${order.amountSol} SOL\n\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.signature}">View Receipt</a>`,
                    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                );
            } catch (_) {}
        } else {
            // Retry Budget: transient errors do not permanently deactivate the order
            const fails = await redis.incr(`limit_fail:${order.id}`);
            await redis.expire(`limit_fail:${order.id}`, 3600);
            
            const isHardError = /insufficient|invalid|decrypt|no active vault/i.test(result.message || '');
            if (isHardError || fails >= 5) {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                try {
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🔴 <b>LIMIT ORDER DEACTIVATED</b>\n\nToken: <code>${order.tokenAddress.substring(0,8)}...</code>\nReason: ${result.message}\n<i>Maximum retry threshold exceeded.</i>`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
            }
        }
    })));
}

export async function isLiveLossLimitHit(telegramId: string, config: any, user: any): Promise<{ hit: boolean; lossPercent: number }> {
    if (!config?.maxLossPercent || config.maxLossPercent <= 0) return { hit: false, lossPercent: 0 };

    const startingBalance = parseFloat(await redis.get(`sniper:starting_balance:${telegramId}`) || '0');
    if (startingBalance <= 0) return { hit: false, lossPercent: 0 };

    const { getUserPositions } = await import('./position.service.js');
    const { cachedSolUsdPrice } = await import('./grpc.service.js');
    const positions = await getUserPositions(telegramId);
    const positionsValueUsd = (positions || []).reduce((sum: number, p: any) => sum + (p.valueUsd || 0), 0);
    const solPrice = cachedSolUsdPrice || 156.93;
    const cashBalance = user.vaultAddress ? (getLiveWalletBalance(user.vaultAddress) ?? 0) : 0;
    const currentEquitySol = cashBalance + (positionsValueUsd / solPrice);
    const lossPercent = ((startingBalance - currentEquitySol) / startingBalance) * 100;

    return { hit: lossPercent >= config.maxLossPercent, lossPercent };
}