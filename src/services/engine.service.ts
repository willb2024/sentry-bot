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
import { redlock } from '../lib/redlock.js';
import { getBotInstance } from '../lib/bot-instance.js';
import { getSessionSpend, addSessionSpend, sendBudgetExhaustedSummary } from './simulation.service.js';
import axios from 'axios';
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

// DoH cache with 1-hour in-memory TTL expiration
const dohCache: Record<string, { ip: string; expiresAt: number }> = {
    'dns.google': { ip: '8.8.8.8', expiresAt: Infinity }
};

const CRITICAL_DOMAINS = [
    'pumpportal.fun',
    'lite-api.jup.ag',
    'mainnet.block-engine.jito.wtf'
];

function resolveViaDoh(hostname: string): Promise<string | null> {
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

const secureDoHLookup = (hostname: string, options: any, callback: any) => {
    const cached = dohCache[hostname];
    if (cached && Date.now() < cached.expiresAt) return callback(null, cached.ip, 4);
    resolveViaDoh(hostname).then((ip) => {
        if (ip) return callback(null, ip, 4);
        dns.lookup(hostname, options, callback);
    });
};

export async function warmDnsCache(): Promise<void> {
    logger.info('🌐 [DNS] Pre-warming DoH cache for critical endpoints...');
    await Promise.all(CRITICAL_DOMAINS.map(async (domain) => {
        const ip = await resolveViaDoh(domain);
        if (ip) logger.info(`  ✅ ${domain} → ${ip}`);
    }));
}

const activeAgent = new https.Agent({
    lookup: secureDoHLookup,
    family: 4,
    keepAlive: true,
});

export const axiosClient = axios.create({ 
    httpsAgent: activeAgent,
    timeout: 5000 
});

export async function getDynamicPriorityFee(priorityLevel: string, customPriorityFee: number): Promise<number> {
    if (priorityLevel === 'ECO') return 500_000;
    if (priorityLevel === 'CUSTOM') return Math.floor(customPriorityFee * 1_000_000_000);
    if (priorityLevel === 'TURBO') return 5_000_000;
    
    const now = Date.now();
    if (now - lastPriorityFeeFetch > 10000) {
        lastPriorityFeeFetch = now;
        try {
            const rpcUrl = process.env.HELIUS_RPC_URL || connection.rpcEndpoint;
            axiosClient.post(rpcUrl, {
                jsonrpc: "2.0", id: 1, method: "getPriorityFeeEstimate",
                params: [{ "targetOptions": { "defaultLevel": "high" } }]
            }, { timeout: 2000 }).then(res => {
                if (res.data?.result?.priorityFeeEstimate) {
                    cachedPriorityFee = Math.max(1_000_000, res.data.result.priorityFeeEstimate);
                }
            }).catch(() => {});
        } catch (_) {}
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

const keypairCache = new Map<string, Keypair>();

export function clearKeypairCache(walletAddress: string) {
    keypairCache.delete(walletAddress);
}

function getCachedKeypair(walletAddress: string, pkEncrypted: string): Keypair | null {
    if (keypairCache.has(walletAddress)) return keypairCache.get(walletAddress)!;
    const rawPk = decryptKey(pkEncrypted);
    if (!rawPk) return null;
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
        keypairCache.set(walletAddress, keypair);
        setTimeout(() => keypairCache.delete(walletAddress), 60 * 1000); 
        return keypair;
    } catch (_) { return null; }
}

export async function getCachedTokenPrice(mint: string): Promise<number> {
    const cached = await redis.get(`price_cache:${mint}`);
    if (cached) return parseFloat(cached);

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
    expectedAmount: number;        // Total tokens (buy) or total SOL (sell) expected
    executedAmount: number;        // Total tokens (buy) or total SOL (sell) received
    executedPricePerToken: number; // Derived SOL price per single token
    slippagePercent: number;
    slippageBps: number;
    executionQuality: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR' | 'MEV_SANDWICHED';
}

/**
 * Shared balance-delta and price-per-token extractor for confirmed transactions
 */
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
        // Output is tokens received
        const postToken = postBalances.find((b: any) => b.mint !== WSOL_MINT);
        const preToken = preBalances.find((b: any) => b.accountIndex === postToken?.accountIndex);
        const postAmt = postToken ? Number(postToken.uiTokenAmount.amount) : 0;
        const preAmt = preToken ? Number(preToken.uiTokenAmount.amount) : 0;
        actualOutAmount = (postAmt - preAmt) / Math.pow(10, tokenDecimals || 6);

        // Compute SOL spent from wallet SOL balance delta
        const solSpentLamports = Math.abs(Number(tx.meta.preBalances[walletIndex] || 0) - Number(tx.meta.postBalances[walletIndex] || 0));
        const solSpent = solSpentLamports / LAMPORTS_PER_SOL;
        executedPricePerToken = actualOutAmount > 0 ? solSpent / actualOutAmount : 0;
    } else {
        // Output is SOL received net of transaction fees
        const preSol = Number(tx.meta.preBalances[walletIndex] || 0);
        const postSol = Number(tx.meta.postBalances[walletIndex] || 0);
        actualOutAmount = Math.max(0, (postSol - preSol) / LAMPORTS_PER_SOL);

        // Tokens sold from token balance delta
        const preToken = preBalances.find((b: any) => b.mint !== WSOL_MINT);
        const postToken = postBalances.find((b: any) => b.accountIndex === preToken?.accountIndex);
        const tokensSold = preToken && postToken
            ? (Number(preToken.uiTokenAmount.amount) - Number(postToken.uiTokenAmount.amount)) / Math.pow(10, tokenDecimals || 6)
            : 0;
        executedPricePerToken = tokensSold > 0 ? actualOutAmount / tokensSold : 0;
    }

    if (expectedOutAmount <= 0 || actualOutAmount <= 0) {
        return {
            confirmed: true,
            expectedAmount: expectedOutAmount,
            executedAmount: actualOutAmount,
            executedPricePerToken,
            slippagePercent: 0,
            slippageBps: 0,
            executionQuality: 'ACCEPTABLE'
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
        confirmed: true,
        expectedAmount: expectedOutAmount,
        executedAmount: actualOutAmount,
        executedPricePerToken,
        slippagePercent: parseFloat(slippagePercent.toFixed(2)),
        slippageBps,
        executionQuality: quality
    };
}

export async function verifyExecutionQuality(
    signature: string,
    expectedOutAmount: number,
    tokenDecimals: number,
    isBuy: boolean,
    walletPubkey: PublicKey,
    maxRetries = 20
): Promise<TcaExecutionReport> {
    const fallbackReport: TcaExecutionReport = {
        confirmed: false,
        expectedAmount: 0,
        executedAmount: 0,
        executedPricePerToken: 0,
        slippagePercent: 0,
        slippageBps: 0,
        executionQuality: 'ACCEPTABLE'
    };

    for (let i = 0; i < maxRetries; i++) {
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        
        if (status?.value) {
            if (status.value.err) return { ...fallbackReport, confirmed: false };
            
            if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (!tx?.meta) return { ...fallbackReport, confirmed: true };

                    const accountKeys = tx.transaction.message.accountKeys.map((k: any) => 
                        typeof k === 'string' ? k : k.pubkey.toBase58()
                    );
                    const walletIndex = accountKeys.indexOf(walletPubkey.toBase58());
                    if (walletIndex === -1) {
                        logger.error('Wallet not found in transaction account keys', { signature, wallet: walletPubkey.toBase58() });
                        return { ...fallbackReport, confirmed: true };
                    }

                    return extractExecutionResult(tx, isBuy, walletIndex, tokenDecimals, expectedOutAmount);
                } catch (e) { 
                    return { ...fallbackReport, confirmed: true }; 
                }
            }
        }

        // 400ms cadence matching Solana slot boundaries
        await new Promise(r => setTimeout(r, 400));
    }

    // Final-chance confirmation check on timeout
    try {
        const finalStatus = await connection.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
        if (finalStatus?.value && !finalStatus.value.err && 
            (finalStatus.value.confirmationStatus === 'confirmed' || finalStatus.value.confirmationStatus === 'finalized')) {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx?.meta) {
                const accountKeys = tx.transaction.message.accountKeys.map((k: any) => 
                    typeof k === 'string' ? k : k.pubkey.toBase58()
                );
                const walletIndex = accountKeys.indexOf(walletPubkey.toBase58());
                if (walletIndex !== -1) {
                    return extractExecutionResult(tx, isBuy, walletIndex, tokenDecimals, expectedOutAmount);
                }
            }
        }
    } catch (_) {}

    return fallbackReport;
}

// True Concurrent 5-Region Jito Broadcast
export async function sendToJitoBundle(
    swapTx: VersionedTransaction, 
    tipTx: VersionedTransaction,
    allowRawFallback: boolean = true
): Promise<boolean> {
    const JITO_REGIONS = [
        'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
    ];

    const bundledTxs = [
        Buffer.from(swapTx.serialize()).toString('base64'),
        Buffer.from(tipTx.serialize()).toString('base64')
    ];

    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [bundledTxs]
    };

    const promises = JITO_REGIONS.map(url =>
        axiosClient.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 2000
        }).then(res => res.data && !res.data.error).catch(() => false)
    );

    const results = await Promise.allSettled(promises);
    const landed = results.some(r => r.status === 'fulfilled' && r.value === true);

    if (landed) return true;

    if (allowRawFallback) {
        try {
            const rawSig = await connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(() => null);
            if (rawSig) {
                connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true }).catch(() => {});
                return true;
            }
        } catch (e: any) {
            logger.error('Jito fallback RPC also failed', { error: e.message });
        }
    }
    return false;
}

export interface DexRouteQuote {
    dex: string;
    outAmount: number;
    quoteResponse: any;
}

async function getIsolatedDexQuote(dexName: string, inputMint: string, outputMint: string, amountRaw: string, slippageBps: number): Promise<DexRouteQuote | null> {
    try {
        const res = await axiosClient.get(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}&dexes=${encodeURIComponent(dexName)}`,
            { headers: API_HEADERS, timeout: 2000 }
        );
        if (res.data && res.data.outAmount) {
            return { dex: dexName, outAmount: Number(res.data.outAmount), quoteResponse: res.data };
        }
    } catch (_) {}
    return null;
}

async function fetchApiTransaction(
    action: 'buy' | 'sell',
    mint: string,
    vault: string,
    amountSolForBuy: number,
    uiTokenAmountForSell: number,
    rawTokenAmountForSell: string,
    sellPercentage: number,
    slippage: number,
    priorityLevel: string = 'FAST',
    customPriorityFee: number = 0.001,
    pkEncrypted?: string,
    raydiumPoolId?: string,
    useSOR: boolean = true 
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
                const pumpRes = await axiosClient.post(
                    `https://pumpportal.fun/api/trade-local`,
                    {
                        publicKey: vault, action, mint, denominatedInSol: action === 'buy',
                        amount: pumpAmount, slippage, priorityFee: 0.0001, pool: "auto"
                    },
                    { headers: API_HEADERS, responseType: 'arraybuffer', timeout: 3000 }
                );
                if (pumpRes && pumpRes.data) {
                    return { buffer: Buffer.from(pumpRes.data), errorLog: "", winningRoute: 'PumpPortal_Curve' };
                }
            } catch (e: any) { globalErrorLog += `[PumpPortal: API Reject] `; }
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

            const globalJupPromise = axiosClient.get(
                `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${jupAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`,
                { headers: API_HEADERS, timeout: 2500 }
            ).then(res => res.data ? ({ dex: 'Jupiter_Aggregated', outAmount: Number(res.data.outAmount), quoteResponse: res.data }) : null).catch(() => null);

            const allPromises = [...quotePromises, globalJupPromise];

            const validQuotes: DexRouteQuote[] = [];
            let firstQuoteAt = 0;
            await new Promise<void>((resolve) => {
                let settled = 0;
                const GRACE_MS = 400;
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

            if (validQuotes.length === 0) return { buffer: null, errorLog: globalErrorLog || "SOR: No DEX liquidity routes available." };

            validQuotes.sort((a, b) => b.outAmount - a.outAmount);
            bestRoute = validQuotes[0];
        } else {
            const res = await axiosClient.get(
                `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${jupAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`,
                { headers: API_HEADERS, timeout: 2000 }
            ).catch(() => null);

            if (res && res.data && res.data.outAmount) {
                bestRoute = { dex: 'Jupiter_Direct', outAmount: Number(res.data.outAmount), quoteResponse: res.data };
            } else {
                return { buffer: null, errorLog: globalErrorLog || "Direct: No liquidity routes available." };
            }
        }

        const priorityLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);
        const swapRes = await axiosClient.post(
            'https://lite-api.jup.ag/swap/v1/swap',
            {
                quoteResponse: bestRoute.quoteResponse, userPublicKey: vault, wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true, prioritizationFeeLamports: priorityLamports
            },
            { headers: API_HEADERS, timeout: 3000 }
        );

        if (swapRes?.data?.swapTransaction) {
            const estOut = action === 'sell' && bestRoute.outAmount ? bestRoute.outAmount / 1_000_000_000 : bestRoute.outAmount;
            return {
                buffer: Buffer.from(swapRes.data.swapTransaction, 'base64'),
                errorLog: "", estimatedOutput: estOut, winningRoute: bestRoute.dex
            };
        }
        return { buffer: null, errorLog: `Route (${bestRoute.dex}) Swap Generation Failed.` };
    } catch (e: any) { return { buffer: null, errorLog: `Routing Fault: ${e.message}` }; }
}

export async function buildTipAndFeeTransaction(
    payer: Keypair, telegramId: string, expectedSolVolume: number,
    priorityLevel: string = "FAST", customPriorityFee: number = 0.001,
    isBumper: boolean = false, blockhash: string,
    feeRate?: number 
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
                instructions.push(SystemProgram.transfer({
                    fromPubkey: payer.publicKey, toPubkey: treasuryPubkey, lamports: Number(feeLamports)
                }));
            }
        }

        const jitoPubkey = safePublicKey(jitoTipAccountStr);
        if (jitoPubkey) {
            instructions.push(SystemProgram.transfer({
                fromPubkey: payer.publicKey, toPubkey: jitoPubkey, lamports: tipLamports
            }));
        }

        const messageV0 = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
        const tx = new VersionedTransaction(messageV0);
        tx.sign([payer]);
        return tx;
    } catch (_) { return null; }
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

    // 1. Simulation Intercept
    const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteSnipe(telegramId, targetCA, amountSol, strategy, aiScore ?? 75);
    }
    
    // 2. Anti-MEV Delays & Sandwich Defense
    if (antiMevDelayMs > 0) await new Promise(r => setTimeout(r, antiMevDelayMs));

    const mevPromise = (side === 'buy' && !isBumper)
        ? checkRecentMevActivityCached(targetCA).catch(() => 'ERROR')
        : Promise.resolve(false);

    if (side === 'buy' && !isBumper) {
        const HARD_CAP_MS = 800;
        const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), HARD_CAP_MS));
        const mevResult = await Promise.race([mevPromise, timeoutPromise]);

        if (mevResult === true) return { success: false, message: "🚨 MEV Sandwich Bot Detected. Trade Blocked." };
        if (mevResult === 'TIMEOUT' || mevResult === 'ERROR') return { success: false, message: "⚠️ MEV check timeout — trade blocked." };
    }

    const tokenPubkey = safePublicKey(targetCA);
    if (!tokenPubkey) return { success: false, message: "🔴 Invalid Token Address." };

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No active Vault found." };

        let liveBalanceSol = getLiveWalletBalance(user.vaultAddress);
        if (liveBalanceSol === null) {
            const vaultPubkey = safePublicKey(user.vaultAddress);
            if (!vaultPubkey) return { success: false, message: "Invalid Vault Address." };
            const balanceLamports = await connection.getBalance(vaultPubkey);
            liveBalanceSol = balanceLamports / LAMPORTS_PER_SOL;
        }

        if (liveBalanceSol < amountSol + 0.005) return { success: false, message: "Insufficient Funds." };

        let selectedSlippage = overrideSlippage ?? user.slippagePercent ?? 20.0;
        if (user.enableAdaptiveSlippage && overrideSlippage === undefined) {
            const volatileSlippage = await getVolatilityAdjustedSlippage(targetCA, selectedSlippage).catch(() => selectedSlippage);
            if (volatileSlippage > selectedSlippage) selectedSlippage = volatileSlippage;
        }

        let raydiumPoolIdToUse: string | undefined = raydiumPoolId;
        if (user.enableSOR && !raydiumPoolId) raydiumPoolIdToUse = undefined;
        
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed: Primary wallet key could not be decrypted." };
        
        const wallets: Keypair[] = [Keypair.fromSecretKey(bs58.decode(rawW1))];
        if (user.activeWallets >= 2 && user.pk2) { const pk = decryptKey(user.pk2); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 3 && user.pk3) { const pk = decryptKey(user.pk3); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 4 && user.pk4) { const pk = decryptKey(user.pk4); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (user.activeWallets >= 5 && user.pk5) { const pk = decryptKey(user.pk5); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }

        let walletReport: string[] = [];
        let walletErrors: string[] = [];
        
        const recentBlockhash = getCachedBlockhash() || (await connection.getLatestBlockhash('processed')).blockhash;
        const feeRate = await getPlatformFeeRate(user.telegramId);

        // 3. Live Max Loss Circuit Breaker Check
        const liveConfig = await prisma.autoSnipeConfig.findUnique({ where: { userId: user.id } });
        if (liveConfig?.maxLossPercent && liveConfig.maxLossPercent > 0) {
            const lossCheck = await isLiveLossLimitHit(telegramId, liveConfig, user);
            if (lossCheck.hit) {
                await prisma.autoSnipeConfig.update({ where: { id: liveConfig.id }, data: { isActive: false } });
                const bot = getBotInstance();
                try {
                    await bot.telegram.sendMessage(
                        telegramId,
                        `🛑 <b>MAX LOSS LIMIT REACHED</b>\n\n` +
                        `Your live portfolio dropped <b>${lossCheck.lossPercent.toFixed(1)}%</b> from session baseline (Limit: -${liveConfig.maxLossPercent}%).\n\n` +
                        `Auto-Sniper paused to protect your funds.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (e: any) {
                    console.error("🔴 [SNIPER] Failed to send loss limit alert:", e.message);
                }
                return { success: false, message: "🛑 Max loss limit reached. Sniper paused." };
            }
        }

        // 4. Atomic Budget Locking & Strict Clamping
        const activeWallets = user.activeWallets || 1;
        const intendedSpend = amountSol * activeWallets;
        
        const budgetLockKey = `lock:budget:${telegramId}`;
        let budgetLock;
        try {
            budgetLock = await redlock.acquire([budgetLockKey], 5000);
        } catch (err) {
            return { success: false, message: "Budget lock contention. Try again in a moment." };
        }

        let actualSpendPerWallet = amountSol;
        try {
            const sessionId = await redis.get(`autosnipe:session_id:live:${telegramId}`);
            const currentSpendFinal = await getSessionSpend(telegramId, 'live');
            const maxBudget = liveConfig?.maxBudgetSol || Infinity;
            const remainingBudget = maxBudget - currentSpendFinal;

            if (remainingBudget <= 0) {
                await prisma.autoSnipeConfig.update({ where: { id: liveConfig!.id }, data: { isActive: false } });
                const bot = getBotInstance(); 
                await sendBudgetExhaustedSummary(bot, telegramId, 'live', sessionId);
                return { success: false, message: "⚠️ Budget exhausted. Sniper paused." };
            }

            // Clamp total buy size to exact remaining budget
            const clampedTotalSpend = Math.min(intendedSpend, remainingBudget);
            actualSpendPerWallet = clampedTotalSpend / activeWallets;

            if (actualSpendPerWallet < 0.005) {
                await prisma.autoSnipeConfig.update({ where: { id: liveConfig!.id }, data: { isActive: false } });
                const bot = getBotInstance(); 
                await sendBudgetExhaustedSummary(bot, telegramId, 'live', sessionId);
                return { success: false, message: "⚠️ Remaining budget too low for trade. Sniper paused." };
            }

            // Pre-reserve clamped budget atomically
            await addSessionSpend(telegramId, clampedTotalSpend, 'live');
        } finally {
            if (budgetLock) await (budgetLock as any).release().catch(() => {});
        }

        // 5. Parallel Multi-Wallet Purchase Assembly & Execution
        const executionPromises = wallets.map(async (w, index) => {
            let wBal = getLiveWalletBalance(w.publicKey.toBase58());
            if (wBal === null) wBal = (await connection.getBalance(w.publicKey).catch(()=>0)) / LAMPORTS_PER_SOL;
            
            const requiredBuffer = 0.001 + (actualSpendPerWallet * 0.01) + 0.0005;
            if (wBal < actualSpendPerWallet + requiredBuffer) {
                walletErrors[index] = `Insufficient Funds`; 
                walletReport[index] = `W${index + 1}: 🔴 Gas`; 
                return { success: false, index };
            }

            const rawPkEncrypted = index === 0 ? user.turnkeySubOrgId : user[`pk${index+1}` as keyof typeof user];
            const pkEncrypted = typeof rawPkEncrypted === 'string' ? rawPkEncrypted : undefined;

            const apiRes = await fetchApiTransaction(
                'buy', targetCA, w.publicKey.toBase58(), actualSpendPerWallet, 0, "0", 0, 
                selectedSlippage, priorityLevel, customPriorityFee, pkEncrypted, raydiumPoolIdToUse, user.enableSOR ?? true
            );

            if (!apiRes.buffer) { 
                walletErrors[index] = apiRes.errorLog; 
                walletReport[index] = `W${index + 1}: 🔴 Route`; 
                return { success: false, index }; 
            }

            let swapTx: VersionedTransaction;
            try {
                swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            } catch (e: any) {
                walletErrors[index] = `Malformed TX buffer: ${e.message}`; 
                walletReport[index] = `W${index + 1}: 🔴 Format`;
                return { success: false, index };
            }
            swapTx.sign([w]);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, actualSpendPerWallet, priorityLevel, customPriorityFee, isBumper, recentBlockhash, feeRate);
            if (!tipTx) { 
                walletReport[index] = `W${index + 1}: 🔴 Sign`; 
                return { success: false, index }; 
            }

            let txSig = bs58.encode(swapTx.signatures[0]);

            if (customRpcUrl) {
                try {
                    const customConnection = new Connection(customRpcUrl, 'confirmed');
                    customConnection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(()=>{});
                } catch(e) {}
            }

            const bundleOk = await sendToJitoBundle(swapTx, tipTx, selectedSlippage <= 25.0);
            if (!bundleOk) { 
                walletErrors[index] = "Dropped by Jito."; 
                walletReport[index] = `W${index + 1}: 🔴 Drop`; 
                return { success: false, index }; 
            }

            const expectedOutput = apiRes.estimatedOutput || 0;
            const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, 6, true, w.publicKey);
            
            if (tcaReport.confirmed) {
                walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;
                
                (async () => {
                    try {
                        const feeCharged = actualSpendPerWallet * feeRate;
                        const feeChargedLamports = BigInt(Math.round((actualSpendPerWallet * 1_000_000_000) * feeRate));

                        const [affiliateCutLamports, guildOwnerCutLamports, leaderCutLamports] = await Promise.all([
                            (async () => {
                                if (!user.referredById) return 0n;
                                const dynamicRate = await getDynamicAffiliateRate(user.referredById);
                                const cut = (feeChargedLamports * BigInt(Math.floor(dynamicRate * 100))) / 100n;
                                prisma.user.update({ 
                                    where: { id: user.referredById }, 
                                    data: { pendingRewardsSol: { increment: Number(cut) / 1_000_000_000 } } 
                                }).catch(() => {});
                                return cut;
                            })(),
                            (async () => {
                                try {
                                    const activeGuildMembership = await prisma.guildMembership.findFirst({ 
                                        where: { userId: user.id, isActive: true }, 
                                        include: { guild: true } 
                                    });
                                    if (activeGuildMembership?.guild.ownerId) {
                                        const cut = (feeChargedLamports * 40n) / 100n;
                                        prisma.user.update({ 
                                            where: { id: activeGuildMembership.guild.ownerId }, 
                                            data: { pendingRewardsSol: { increment: Number(cut) / 1_000_000_000 } } 
                                        }).catch(() => {});
                                        return cut;
                                    }
                                } catch (_) {}
                                return 0n;
                            })(),
                            (async () => {
                                try {
                                    const followRelation = await prisma.copyTradeFollow.findFirst({
                                        where: { followerId: user.id, isActive: true },
                                        include: { leader: true }
                                    });
                                    if (followRelation?.leaderId && strategy === 'Copy Trade') {
                                        const leaderCut = (feeChargedLamports * 50n) / 100n;
                                        prisma.user.update({
                                            where: { id: followRelation.leaderId },
                                            data: { pendingRewardsSol: { increment: Number(leaderCut) / 1_000_000_000 } }
                                        }).catch(() => {});
                                        return leaderCut;
                                    }
                                } catch (_) {}
                                return 0n;
                            })()
                        ]);

                        prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: actualSpendPerWallet } } }).catch(() => {});
                        awardGuildPoints(user.telegramId, actualSpendPerWallet).catch(() => {});
                        
                        await prisma.trade.create({
                            data: {
                                userId: user.id, 
                                tokenAddress: targetCA, 
                                isBuy: true, 
                                amountInSol: actualSpendPerWallet,
                                feeChargedSol: feeCharged, 
                                affiliateCutSol: Number(affiliateCutLamports) / 1_000_000_000, 
                                loyaltyRebateSol: 0,
                                txSignature: txSig, 
                                status: 'CONFIRMED', 
                                strategy: strategy,
                                aiScore: aiScore ?? null,
                                expectedPriceUsd: tcaReport.expectedAmount,
                                executedPriceUsd: tcaReport.executedPricePerToken,
                                slippagePercent: tcaReport.slippagePercent
                            } as any
                        }).catch(() => {});

                        fireWebhook(user.telegramId, 'trade_buy', { tokenAddress: targetCA, amountSol: actualSpendPerWallet, signature: txSig, strategy, aiScore }).catch(() => {});
                        const { recordStatsEvent } = await import('./simulation.service.js');
                        recordStatsEvent(user.telegramId, 'live', 0).catch(() => {});
                    } catch (err: any) {
                        logger.error('Buy post-processing failed', { error: err.message, txSig });
                        await redis.rpush('failed_trade_recovery', JSON.stringify({ telegramId, targetCA, txSig, amountSol: actualSpendPerWallet, side: 'buy' }));
                    }
                })();

                return { success: true, index, signature: txSig, volumeSpent: actualSpendPerWallet };
            } else {
                walletReport[index] = `W${index + 1}: 🔴 Drop`;
                return { success: false, index };
            }
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
        console.error('🔴 [SNIPE] Unhandled execution error:', error.message);
        return { success: false, message: `🔴 Execution Fault: ${error.message}` }; 
    }
}

export async function executeExit(
    telegramId: string, targetCA: string, sellPercentage: number = 100, isBumper: boolean = false,
    strategy: string = 'Manual / Direct'
): Promise<{ success: boolean; signature?: string; message: string }> {

    const { isSimulationActive, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteExit(telegramId, targetCA, sellPercentage, undefined, strategy);
    }
    
    const tokenMint = safePublicKey(targetCA);
    if (!tokenMint) return { success: false, message: "🔴 Invalid Token Address." };

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No Vault." };

        let selectedSlippage = sellPercentage === 100 ? 100.0 : (user.slippagePercent || 20.0);
        if ((user.enableAdaptiveSlippage ?? true) && sellPercentage !== 100) {
            const volatileSlippage = await getVolatilityAdjustedSlippage(targetCA, selectedSlippage).catch(() => selectedSlippage);
            if (volatileSlippage > selectedSlippage) selectedSlippage = volatileSlippage;
        }
        
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;
        const useSOR = user.enableSOR ?? true;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed: Primary wallet key could not be decrypted." };

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
                walletErrors[index] = `Gas.`; walletReport[index] = `W${index + 1}: 🔴 Gas`; 
                return { success: false, index }; 
            }

            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
            if (parsedTokenAccounts.value.length === 0 || BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) === 0n) {
                walletReport[index] = `W${index + 1}: ⚪ Empty`; return { success: false, index };
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
                walletErrors[index] = apiRes.errorLog; walletReport[index] = `W${index + 1}: 🔴 Route`; 
                return { success: false, index }; 
            }

            const dynamicFeeBase = apiRes.estimatedOutput && apiRes.estimatedOutput > 0 ? apiRes.estimatedOutput : 0.01;
            
            let swapTx: VersionedTransaction;
            try {
                swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            } catch (e: any) {
                walletErrors[index] = `Malformed TX buffer: ${e.message}`; walletReport[index] = `W${index + 1}: 🔴 Format`; return { success: false, index };
            }
            swapTx.sign([w]);

            let volumeToRecord = dynamicFeeBase;
            try {
                const allBuys = await prisma.trade.findMany({ where: { userId: user.id, tokenAddress: targetCA, isBuy: true, status: 'CONFIRMED' } });
                if (allBuys.length > 0) {
                    const totalInvested = allBuys.reduce((sum, t) => sum + t.amountInSol, 0);
                    volumeToRecord = totalInvested * (sellPercentage / 100);
                }
            } catch (_) {}

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, volumeToRecord, priorityLevel, customPriorityFee, isBumper, recentBlockhash, feeRate);
            if (!tipTx) { walletErrors[index] = `Sign Error.`; walletReport[index] = `W${index + 1}: 🔴 Sign`; return { success: false, index }; }
            
            let txSig = bs58.encode(swapTx.signatures[0]);
            
            const bundleOk = await sendToJitoBundle(swapTx, tipTx, selectedSlippage <= 25.0);
            if (!bundleOk) { walletErrors[index] = "Dropped by Jito."; walletReport[index] = `W${index + 1}: 🔴 Drop`; return { success: false, index }; }

            const expectedOutput = apiRes.estimatedOutput || 0;
            const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, decimals, false, w.publicKey);
            
            if (tcaReport.confirmed) {
                walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;
                
                await redis.del(`token_acct_balance:${w.publicKey.toBase58()}:${targetCA}`).catch(() => {});

                (async () => {
                    try {
                        let actualSolReceived = tcaReport.executedAmount > 0 ? tcaReport.executedAmount : dynamicFeeBase;
                        
                        const feeCharged = volumeToRecord * feeRate;
                        const feeChargedLamports = BigInt(Math.round((volumeToRecord * 1_000_000_000) * feeRate));

                        const [affiliateCutLamports, guildOwnerCutLamports, leaderCutLamports] = await Promise.all([
                            (async () => {
                                if (!user.referredById) return 0n;
                                const dynamicRate = await getDynamicAffiliateRate(user.referredById);
                                const cut = (feeChargedLamports * BigInt(Math.floor(dynamicRate * 100))) / 100n;
                                prisma.user.update({ 
                                    where: { id: user.referredById }, 
                                    data: { pendingRewardsSol: { increment: Number(cut) / 1_000_000_000 } } 
                                }).catch(() => {});
                                return cut;
                            })(),
                            (async () => {
                                try {
                                    const activeGuildMembership = await prisma.guildMembership.findFirst({ 
                                        where: { userId: user.id, isActive: true }, 
                                        include: { guild: true } 
                                    });
                                    if (activeGuildMembership?.guild.ownerId) {
                                        const cut = (feeChargedLamports * 40n) / 100n;
                                        prisma.user.update({ 
                                            where: { id: activeGuildMembership.guild.ownerId }, 
                                            data: { pendingRewardsSol: { increment: Number(cut) / 1_000_000_000 } } 
                                        }).catch(() => {});
                                        return cut;
                                    }
                                } catch (_) {}
                                return 0n;
                            })(),
                            (async () => {
                                try {
                                    const followRelation = await prisma.copyTradeFollow.findFirst({
                                        where: { followerId: user.id, isActive: true },
                                        include: { leader: true }
                                    });
                                    if (followRelation?.leaderId && strategy === 'Copy Trade') {
                                        const leaderCut = (feeChargedLamports * 50n) / 100n;
                                        prisma.user.update({
                                            where: { id: followRelation.leaderId },
                                            data: { pendingRewardsSol: { increment: Number(leaderCut) / 1_000_000_000 } }
                                        }).catch(() => {});
                                        return leaderCut;
                                    }
                                } catch (_) {}
                                return 0n;
                            })()
                        ]);

                        const realizedPnlSol = (actualSolReceived - volumeToRecord) - feeCharged;
                        const profitPercent = volumeToRecord > 0 ? (realizedPnlSol / volumeToRecord) * 100 : 0;

                        prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: volumeToRecord } } }).catch(() => {});
                        awardGuildPoints(user.telegramId, volumeToRecord).catch(() => {});
                        
                        const { recordStatsEvent } = await import('./simulation.service.js');
                        recordStatsEvent(user.telegramId, 'live', realizedPnlSol).catch(() => {});

                        await prisma.trade.create({
                            data: {
                                userId: user.id, tokenAddress: targetCA, isBuy: false, amountInSol: volumeToRecord,
                                feeChargedSol: feeCharged, affiliateCutSol: Number(affiliateCutLamports) / 1_000_000_000, loyaltyRebateSol: 0,
                                txSignature: txSig, status: 'CONFIRMED',
                                profitPercent: parseFloat(profitPercent.toFixed(2)),
                                realizedPnlSol: realizedPnlSol,
                                strategy: strategy || 'Manual / Direct',
                                expectedPriceUsd: tcaReport.expectedAmount,
                                executedPriceUsd: tcaReport.executedPricePerToken,
                                slippagePercent: tcaReport.slippagePercent
                            } as any
                        }).catch(() => {});

                        fireWebhook(user.telegramId, 'trade_sell', { tokenAddress: targetCA, percentage: sellPercentage, realizedPnlSol, profitPercent, signature: txSig, strategy }).catch(() => {});

                        if (!isBumper) {
                            const captionHtml = `${profitPercent >= 0 ? '🟢' : '🔴'} <b>SELL CONFIRMED</b>\n\nToken: <code>${targetCA.substring(0,8)}...</code>\nPnL: <b>${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%</b>\n🔗 <a href="https://solscan.io/tx/${txSig}">View on Solscan</a>`;
                            try {
                                const { generatePnlCard } = await import('./image.service.js');
                                const imageBuffer = await generatePnlCard(targetCA, profitPercent, user.referralCode ?? undefined);
                                const FormData = (await import('form-data')).default || await import('form-data');
                                const form: any = new FormData();
                                form.append('chat_id', telegramId); form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' }); form.append('caption', captionHtml); form.append('parse_mode', 'HTML');
                                await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 5000 });
                            } catch (e) {
                                try { await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, { chat_id: telegramId, text: captionHtml, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); } catch (_) {}
                            }
                        }
                    } catch (err: any) {
                        logger.error('Sell post-processing failed', { error: err.message, txSig });
                        await redis.rpush('failed_trade_recovery', JSON.stringify({ telegramId, targetCA, txSig, percentage: sellPercentage, side: 'sell' }));
                    }
                })();

                return { success: true, index, signature: txSig, feeBase: dynamicFeeBase };
            } else {
                walletReport[index] = `W${index + 1}: 🔴 Drop`;
                return { success: false, index };
            }
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
        console.error('🔴 [EXIT] Execution error:', error.message);
        return { success: false, message: `🔴 Error: ${error.message}` }; 
    }
}

export async function getDynamicAffiliateRate(referrerId: string): Promise<number> {
    try {
        const referrer = await prisma.user.findUnique({
            where: { id: referrerId },
            include: { _count: { select: { recruits: true } } }
        });
        if (!referrer) return 0.50; 

        const volumeSol = referrer.totalVolumeSol || 0;
        const recruitBonus = (referrer._count?.recruits || 0) * 2000;
        const totalPoints = (volumeSol * 10000) + recruitBonus;

        if (totalPoints >= 25000000) return 0.70; 
        if (totalPoints >= 5000000)  return 0.60; 
        return 0.50;                              
    } catch { 
        return 0.50; 
    }
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

const limitOrderConcurrency = pLimit(8);

export async function processLimitOrders(bot: any) {
    const { prisma } = await import('../lib/prisma.js');
    const freshOrders = await prisma.activeOrder.findMany({
        where: { orderType: 'LIMIT', isActive: true },
        include: { user: true }
    });

    if (freshOrders.length === 0) return;

    await Promise.allSettled(freshOrders.map(order => limitOrderConcurrency(async () => {
        let price = await getCachedTokenPrice(order.tokenAddress);
        if (price === 0) {
            try {
                const res = await axiosClient.get(`https://api.dexscreener.com/latest/dex/tokens/${order.tokenAddress}`, { timeout: 2000 });
                price = parseFloat(res.data?.pairs?.[0]?.priceUsd || "0");
            } catch (_) {}
        }
        if (price === 0) return;

        if (price <= (order.targetPriceUsd || 0)) {
            const fillLockKey = `lock:limit_fill:${order.id}`;
            const acquired = await redis.set(fillLockKey, '1', 'EX', 30, 'NX');
            if (!acquired) return;

            const result = await executeSnipe(
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
            
            if (result.success) {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });

                if (order.trailingPercent) {
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
                        `🟢 <b>LIMIT ORDER FILLED!</b>\n\nToken: <code>${order.tokenAddress.substring(0,8)}...</code>\nTarget: $${order.targetPriceUsd}\nFilled at: $${price}\nAmount: ${order.amountSol} SOL\n\n🔗 <a href="https://solscan.io/tx/${result.signature}">View on Solscan</a>`,
                        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
                    );
                } catch (_) {}
            } else {
                await prisma.activeOrder.update({ where: { id: order.id }, data: { isActive: false } });
                try {
                    await bot.telegram.sendMessage(
                        order.user.telegramId,
                        `🔴 <b>LIMIT ORDER FAILED</b>\n\nToken: <code>${order.tokenAddress.substring(0,8)}...</code>\nReason: ${result.message}\n<i>Order has been deactivated.</i>`,
                        { parse_mode: 'HTML' }
                    );
                } catch (_) {}
            }
        }
    })));
}

export async function isLiveLossLimitHit(
    telegramId: string,
    config: any,
    user: any
): Promise<{ hit: boolean; lossPercent: number }> {
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

    return {
        hit: lossPercent >= config.maxLossPercent,
        lossPercent
    };
}