// src/services/engine.service.ts
import { PublicKey, SystemProgram, VersionedTransaction, TransactionMessage, Keypair, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js'; 
import bs58 from 'bs58';
import dotenv from 'dotenv';
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

dotenv.config();

// 🟢 FIX: Safe PublicKey parser to prevent fatal runtime crashes on malformed strings
function safePublicKey(address: string | undefined | null): PublicKey | null {
    if (!address) return null;
    try {
        return new PublicKey(address);
    } catch {
        return null;
    }
}

// Performance Optimization: Cache priority fees
let cachedPriorityFee = 1_000_000;
let lastPriorityFeeFetch = 0;

dns.setDefaultResultOrder('ipv4first');

const dohCache: Record<string, string> = {
    'dns.google': '8.8.8.8'
};

const CRITICAL_DOMAINS = [
    'pumpportal.fun',
    'lite-api.jup.ag',
    'mainnet.block-engine.jito.wtf'
];

function resolveViaDoh(hostname: string): Promise<string | null> {
    return new Promise(async (resolve) => {
        if (dohCache[hostname]) return resolve(dohCache[hostname]);
        
        const cachedIp = await redis.get(`doh_cache:${hostname}`);
        if (cachedIp) return resolve(cachedIp);

        const req = https.request({
            hostname: '8.8.8.8',
            path: `/resolve?name=${encodeURIComponent(hostname)}&type=A`,
            method: 'GET',
            port: 443,
            servername: 'dns.google',
            rejectUnauthorized: true,
            headers: { 'Accept': 'application/dns-json' },
            timeout: 5000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', async () => {
                try {
                    const parsed = JSON.parse(data);
                    const ip = parsed?.Answer?.find((a: any) => a.type === 1)?.data;
                    if (ip) {
                        dohCache[hostname] = ip;
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
    if (dohCache[hostname]) return callback(null, dohCache[hostname], 4);
    resolveViaDoh(hostname).then((ip) => {
        if (ip) return callback(null, ip, 4);
        dns.lookup(hostname, options, callback);
    });
};

export async function warmDnsCache(): Promise<void> {
    console.log('🌐 [DNS] Pre-warming DoH cache for critical endpoints...');
    await Promise.all(CRITICAL_DOMAINS.map(async (domain) => {
        const ip = await resolveViaDoh(domain);
        if (ip) console.log(`  ✅ ${domain} → ${ip}`);
    }));
}

const activeAgent = new https.Agent({
    lookup: secureDoHLookup,
    family: 4,
    keepAlive: true,
});

const axiosClient = axios.create({ httpsAgent: activeAgent });

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
    'User-Agent': 'Mozilla/5.0',
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

let cachedBlockhash: { blockhash: string; lastValidBlockHeight: number } | null = null;
connection.getLatestBlockhash('confirmed').then(b => { cachedBlockhash = b; }).catch(() => {});

setInterval(async () => {
    try { cachedBlockhash = await connection.getLatestBlockhash('confirmed'); } catch (_) {}
}, 15000);

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

async function getLatestBlockhashWithCache(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    if (cachedBlockhash) return cachedBlockhash;
    return await connection.getLatestBlockhash('confirmed');
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

// ============================================================================
// 🟢 WALL STREET FEATURE 3: DYNAMIC VOLATILITY-ADAPTIVE SLIPPAGE
// ============================================================================
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

// ============================================================================
// 🟢 WALL STREET FEATURE 1: TRANSACTION COST ANALYSIS (TCA)
// ============================================================================
export interface TcaExecutionReport {
    confirmed: boolean;
    expectedPriceSol: number;
    executedPriceSol: number;
    slippagePercent: number;
    slippageBps: number;
    executionQuality: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR' | 'MEV_SANDWICHED';
}

export async function verifyExecutionQuality(
    signature: string,
    expectedOutAmount: number,
    tokenDecimals: number,
    isBuy: boolean,
    maxRetries = 8
): Promise<TcaExecutionReport> {
    const fallbackReport: TcaExecutionReport = {
        confirmed: false, expectedPriceSol: 0, executedPriceSol: 0, slippagePercent: 0, slippageBps: 0, executionQuality: 'ACCEPTABLE'
    };

    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        
        if (status?.value) {
            if (status.value.err) return { ...fallbackReport, confirmed: false };
            
            if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (!tx?.meta) return { ...fallbackReport, confirmed: true };

                    const preBalances = tx.meta.preTokenBalances || [];
                    const postBalances = tx.meta.postTokenBalances || [];
                    const WSOL_MINT = "So11111111111111111111111111111111111111112";

                    let actualOutAmount = 0;
                    if (isBuy) {
                        const postToken = postBalances.find(b => b.mint !== WSOL_MINT);
                        const preToken = preBalances.find(b => b.accountIndex === postToken?.accountIndex);
                        const postAmt = postToken ? Number(postToken.uiTokenAmount.amount) : 0;
                        const preAmt = preToken ? Number(preToken.uiTokenAmount.amount) : 0;
                        actualOutAmount = (postAmt - preAmt) / Math.pow(10, tokenDecimals || 6);
                    } else {
                        const preSol = Number(tx.meta.preBalances[0] || 0);
                        const postSol = Number(tx.meta.postBalances[0] || 0);
                        actualOutAmount = Math.max(0, (postSol - preSol) / LAMPORTS_PER_SOL);
                    }

                    if (expectedOutAmount <= 0 || actualOutAmount <= 0) return { ...fallbackReport, confirmed: true };

                    const slippagePercent = ((expectedOutAmount - actualOutAmount) / expectedOutAmount) * 100;
                    const slippageBps = Math.round(slippagePercent * 100);

                    let quality: 'EXCELLENT' | 'ACCEPTABLE' | 'POOR' | 'MEV_SANDWICHED' = 'ACCEPTABLE';
                    if (slippagePercent <= 0.5) quality = 'EXCELLENT';
                    else if (slippagePercent <= 3.0) quality = 'ACCEPTABLE';
                    else if (slippagePercent <= 10.0) quality = 'POOR';
                    else quality = 'MEV_SANDWICHED';

                    return {
                        confirmed: true, expectedPriceSol: expectedOutAmount, executedPriceSol: actualOutAmount,
                        slippagePercent: parseFloat(slippagePercent.toFixed(2)), slippageBps, executionQuality: quality
                    };
                } catch (e) { return { ...fallbackReport, confirmed: true }; }
            }
        }
    }
    return fallbackReport;
}

export async function sendToJitoBundle(
    swapTx: VersionedTransaction, 
    tipTx: VersionedTransaction,
    allowRawFallback: boolean = true
): Promise<boolean> {
    try {
        const base64Swap = Buffer.from(swapTx.serialize()).toString('base64');
        const base64Tip = Buffer.from(tipTx.serialize()).toString('base64');
        const bundledTxs = [base64Swap, base64Tip];

        const JITO_REGIONS = [
            'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
            'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
            'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
            'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
            'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles'
        ];

        const requests = JITO_REGIONS.map(url => 
            axiosClient.post(url, {
                jsonrpc: "2.0", id: 1, method: "sendBundle", params: [bundledTxs] 
            }, { 
                headers: { 'Content-Type': 'application/json', ...API_HEADERS }, timeout: 3000
            })
        );

        const results = await Promise.allSettled(requests);
        let jitoSuccess = false;

        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.data && !res.value.data.error) {
                jitoSuccess = true;
                break;
            }
        }

        if (allowRawFallback && !jitoSuccess) {
            const rawSig = await connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(() => null);
            if (rawSig) {
                await connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true }).catch(() => {});
                return true;
            }
            return false;
        }

        return jitoSuccess;
    } catch (e: any) {
        console.error("🔴 [JITO BUNDLE] Fatal error:", e.message);
        return false;
    }
}

// ============================================================================
// 🟢 WALL STREET FEATURE 2: SMART ORDER ROUTING (SOR)
// ============================================================================
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
    raydiumPoolId?: string
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

        // Direct Raydium Bypass
        if (raydiumPoolId && pkEncrypted) {
            const { buildDirectRaydiumSwap } = await import('./raydium.service.js');
            const keypair = getCachedKeypair(vault, pkEncrypted);
            if (keypair) {
                const raydiumBuffer = await buildDirectRaydiumSwap(keypair, raydiumPoolId, inputMint, parseInt(jupAmount), slippageBps).catch(() => null);
                if (raydiumBuffer) return { buffer: raydiumBuffer, errorLog: "", winningRoute: 'Raydium_Direct' };
            }
        }

        // 🟢 SMART ORDER ROUTING (SOR)
        const dexPools = ['Raydium', 'Meteora DLMM', 'Meteora', 'Pump.fun'];
        const quotePromises = dexPools.map(dex => getIsolatedDexQuote(dex, inputMint, outputMint, jupAmount, slippageBps));

        const globalJupPromise = axiosClient.get(
            `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${jupAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`,
            { headers: API_HEADERS, timeout: 2500 }
        ).then(res => res.data ? ({ dex: 'Jupiter_Aggregated', outAmount: Number(res.data.outAmount), quoteResponse: res.data }) : null).catch(() => null);

        const results = await Promise.allSettled([...quotePromises, globalJupPromise]);

        const validQuotes: DexRouteQuote[] = [];
        for (const res of results) {
            if (res.status === 'fulfilled' && res.value && res.value.outAmount > 0) validQuotes.push(res.value);
        }

        if (validQuotes.length === 0) return { buffer: null, errorLog: globalErrorLog || "SOR: No DEX liquidity routes available." };

        validQuotes.sort((a, b) => b.outAmount - a.outAmount);
        const bestRoute = validQuotes[0];

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
        return { buffer: null, errorLog: `SOR Route (${bestRoute.dex}) Swap Generation Failed.` };
    } catch (e: any) { return { buffer: null, errorLog: `Routing Fault: ${e.message}` }; }
}

async function buildTipAndFeeTransaction(
    payer: Keypair, telegramId: string, expectedSolVolume: number,
    priorityLevel: string = "FAST", customPriorityFee: number = 0.001,
    isBumper: boolean = false, blockhash: string
): Promise<VersionedTransaction | null> {
    try {
        const feeRate = await getPlatformFeeRate(telegramId); 
        const feeLamports = BigInt(Math.round((expectedSolVolume * 1_000_000_000) * feeRate));
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
    telegramId: string, targetCA: string, amountSol: number,
    side: 'buy' | 'sell' = 'buy', tokenAmount?: number,
    isBumper: boolean = false, raydiumPoolId?: string,
    overrideSlippage?: number,
    antiMevDelayMs: number = 0,
    customRpcUrl?: string,
    strategy: string = 'MANUAL'
): Promise<{ success: boolean; signature?: string; message: string; volumeSpent?: number }> {

    // 🟢 SIMULATION INTERCEPT: Pass strategy parameter to simExecuteSnipe correctly
    const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteSnipe(telegramId, targetCA, amountSol, strategy);
    }
    
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

        // 🟢 VOLATILITY ADAPTIVE SLIPPAGE APPLIED
        const baseSlip = user.slippagePercent ?? 20.0;
        const slippage = overrideSlippage ?? (await getVolatilityAdjustedSlippage(targetCA, baseSlip));
        
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
        const latestBlockhash = await getLatestBlockhashWithCache();

        const executionPromises = wallets.map(async (w, index) => {
            let wBal = getLiveWalletBalance(w.publicKey.toBase58());
            if (wBal === null) wBal = (await connection.getBalance(w.publicKey).catch(()=>0)) / LAMPORTS_PER_SOL;
            
            const requiredBuffer = 0.001 + (amountSol * 0.01) + 0.0005;
            if (wBal < amountSol + requiredBuffer) {
                walletErrors[index] = `Insufficient Funds`; walletReport[index] = `W${index + 1}: 🔴 Gas`; 
                return { success: false, index };
            }

            const apiRes = await fetchApiTransaction('buy', targetCA, w.publicKey.toBase58(), amountSol, 0, "0", 0, slippage, priorityLevel, customPriorityFee, undefined, raydiumPoolId);
            if (!apiRes.buffer) { 
                walletErrors[index] = apiRes.errorLog; walletReport[index] = `W${index + 1}: 🔴 Route`; 
                return { success: false, index }; 
            }

            let swapTx: VersionedTransaction;
            try {
                swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            } catch (e: any) {
                walletErrors[index] = `Malformed TX buffer: ${e.message}`; walletReport[index] = `W${index + 1}: 🔴 Format`;
                return { success: false, index };
            }
            swapTx.sign([w]);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, amountSol, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash);
            if (!tipTx) { walletReport[index] = `W${index + 1}: 🔴 Sign`; return { success: false, index }; }

            let txSig = bs58.encode(swapTx.signatures[0]);

            if (customRpcUrl) {
                try {
                    const customConnection = new Connection(customRpcUrl, 'confirmed');
                    customConnection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(()=>{});
                } catch(e) {}
            }

            const bundleOk = await sendToJitoBundle(swapTx, tipTx, slippage <= 25.0);
            if (!bundleOk) { walletErrors[index] = "Dropped by Jito."; walletReport[index] = `W${index + 1}: 🔴 Drop`; return { success: false, index }; }

            // 🟢 TCA LOGGING
            const expectedOutput = apiRes.estimatedOutput || 0;
            const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, 6, true);
            
            if (tcaReport.confirmed) {
                walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;
                
                (async () => {
                    const feeRate = await getPlatformFeeRate(user.telegramId);
                    const feeCharged = amountSol * feeRate;
                    const feeChargedLamports = BigInt(Math.round((amountSol * 1_000_000_000) * feeRate));
                    let affiliateCutLamports = 0n;
                    let guildOwnerCutLamports = 0n;

                    if (user.referredById) {
                        const dynamicRate = await getDynamicAffiliateRate(user.referredById);
                        affiliateCutLamports = (feeChargedLamports * BigInt(Math.floor(dynamicRate * 100))) / 100n;
                        await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: Number(affiliateCutLamports) / 1_000_000_000 } } }).catch(()=>{});
                    }

                    try {
                        const activeGuildMembership = await prisma.guildMembership.findFirst({ where: { userId: user.id, isActive: true }, include: { guild: true } });
                        if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                            guildOwnerCutLamports = (feeChargedLamports * 40n) / 100n; 
                            await prisma.user.update({ where: { id: activeGuildMembership.guild.ownerId }, data: { pendingRewardsSol: { increment: Number(guildOwnerCutLamports) / 1_000_000_000 } } }).catch(()=>{});
                        }
                    } catch (_) {}

                    await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: amountSol } } }).catch(()=>{});
                    awardGuildPoints(user.telegramId, amountSol).catch(() => {});
                    
                    await prisma.trade.create({
                        data: {
                            userId: user.id, tokenAddress: targetCA, isBuy: true, amountInSol: amountSol,
                            feeChargedSol: feeCharged, affiliateCutSol: Number(affiliateCutLamports) / 1_000_000_000, loyaltyRebateSol: 0,
                            txSignature: txSig, status: 'CONFIRMED', strategy: strategy,
                            // 🟢 TCA Details
                            expectedPriceUsd: tcaReport.expectedPriceSol,
                            executedPriceUsd: tcaReport.executedPriceSol,
                            slippagePercent: tcaReport.slippagePercent
                        } as any
                    }).catch(() => {});

                    fireWebhook(user.telegramId, 'trade_buy', { tokenAddress: targetCA, amountSol, signature: txSig, strategy }).catch(()=>{});
                    const { recordStatsEvent } = await import('./simulation.service.js');
                    await recordStatsEvent(user.telegramId, 'live', 0).catch(()=>{});
                })();

                return { success: true, index, signature: txSig, volumeSpent: amountSol };
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
            success: true, signature: firstSignature, volumeSpent: totalVolume,
            message: `🟢 Trade Submitted & Confirmed (${successful.length}/${wallets.length}).\n📊 <b>Breakdown:</b> ${walletReport.join(" | ")}`
        };
    } catch (error: any) { return { success: false, message: `🔴 Execution Fault: ${error.message}` }; }
}

export async function executeExit(
    telegramId: string, targetCA: string, sellPercentage: number = 100, isBumper: boolean = false,
    strategy: string = 'MANUAL'
): Promise<{ success: boolean; signature?: string; message: string }> {

    // 🟢 SIMULATION INTERCEPT: Pass strategy parameter to simExecuteExit correctly
    const { isSimulationActive, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteExit(telegramId, targetCA, sellPercentage, undefined, strategy);
    }
    
    const tokenMint = safePublicKey(targetCA);
    if (!tokenMint) return { success: false, message: "🔴 Invalid Token Address." };

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No Vault." };

        // 🟢 VOLATILITY ADAPTIVE SLIPPAGE APPLIED
        const baseSlip = user.slippagePercent || 20.0;
        const slippage = sellPercentage === 100 ? 100.0 : (await getVolatilityAdjustedSlippage(targetCA, baseSlip));
        
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
        const latestBlockhash = await getLatestBlockhashWithCache();
        const balances = await Promise.all(wallets.map(w => connection.getBalance(w.publicKey).catch(() => 0)));

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

            const apiRes = await fetchApiTransaction('sell', targetCA, w.publicKey.toBase58(), 0, uiTokensToSell, tokensToSellRaw.toString(), sellPercentage, slippage, priorityLevel, customPriorityFee, pkEncrypted);
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

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, dynamicFeeBase, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash);
            if (!tipTx) { walletErrors[index] = `Sign Error.`; walletReport[index] = `W${index + 1}: 🔴 Sign`; return { success: false, index }; }

            let txSig = bs58.encode(swapTx.signatures[0]);
            
            const bundleOk = await sendToJitoBundle(swapTx, tipTx, slippage <= 25.0);
            if (!bundleOk) { walletErrors[index] = "Dropped by Jito."; walletReport[index] = `W${index + 1}: 🔴 Drop`; return { success: false, index }; }

            // 🟢 TCA APPLIED: Execute exit relies on verified on-chain execution output
            const expectedOutput = apiRes.estimatedOutput || 0;
            const tcaReport = await verifyExecutionQuality(txSig, expectedOutput, decimals, false);
            
            if (tcaReport.confirmed) {
                walletReport[index] = `W${index + 1}: 🚀 Sent [${apiRes.winningRoute || 'Native'}]`;
                
                (async () => {
                    let actualSolReceived = tcaReport.executedPriceSol > 0 ? tcaReport.executedPriceSol : dynamicFeeBase;
                    
                    const feeRate = await getPlatformFeeRate(user.telegramId);
                    const feeCharged = actualSolReceived * feeRate;
                    const feeChargedLamports = BigInt(Math.round((actualSolReceived * 1_000_000_000) * feeRate));
                    let affiliateCutLamports = 0n;
                    let guildOwnerCutLamports = 0n;

                    if (user.referredById) {
                        const dynamicRate = await getDynamicAffiliateRate(user.referredById);
                        affiliateCutLamports = (feeChargedLamports * BigInt(Math.floor(dynamicRate * 100))) / 100n;
                        await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: Number(affiliateCutLamports) / 1_000_000_000 } } }).catch(()=>{});
                    }

                    try {
                        const activeGuildMembership = await prisma.guildMembership.findFirst({ where: { userId: user.id, isActive: true }, include: { guild: true } });
                        if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                            guildOwnerCutLamports = (feeChargedLamports * 40n) / 100n; 
                            await prisma.user.update({ where: { id: activeGuildMembership.guild.ownerId }, data: { pendingRewardsSol: { increment: Number(guildOwnerCutLamports) / 1_000_000_000 } } }).catch(()=>{});
                        }
                    } catch (_) {}

                    let volumeToRecord = actualSolReceived; 
                    try {
                        const allBuys = await prisma.trade.findMany({ where: { userId: user.id, tokenAddress: targetCA, isBuy: true, status: 'CONFIRMED' } });
                        if (allBuys.length > 0) {
                            const totalInvested = allBuys.reduce((sum, t) => sum + t.amountInSol, 0);
                            volumeToRecord = totalInvested * (sellPercentage / 100);
                        }
                    } catch (_) {}

                    const realizedPnlSol = actualSolReceived - volumeToRecord;
                    const profitPercent = volumeToRecord > 0 ? (realizedPnlSol / volumeToRecord) * 100 : 0;

                    await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: volumeToRecord } } }).catch(()=>{});
                    awardGuildPoints(user.telegramId, volumeToRecord).catch(() => {});
                    
                    const { recordStatsEvent } = await import('./simulation.service.js');
                    await recordStatsEvent(user.telegramId, 'live', realizedPnlSol).catch(()=>{});

                    await prisma.trade.create({
                        data: {
                            userId: user.id, tokenAddress: targetCA, isBuy: false, amountInSol: volumeToRecord,
                            feeChargedSol: feeCharged, affiliateCutSol: Number(affiliateCutLamports) / 1_000_000_000, loyaltyRebateSol: 0,
                            txSignature: txSig, status: 'CONFIRMED', profitPercent: parseFloat(profitPercent.toFixed(2)),
                            realizedPnlSol: realizedPnlSol, strategy: strategy,
                            // 🟢 TCA LOGGING
                            expectedPriceUsd: tcaReport.expectedPriceSol,
                            executedPriceUsd: tcaReport.executedPriceSol,
                            slippagePercent: tcaReport.slippagePercent
                        } as any
                    }).catch(() => {});

                    fireWebhook(user.telegramId, 'trade_sell', { tokenAddress: targetCA, percentage: sellPercentage, realizedPnlSol, profitPercent, signature: txSig, strategy }).catch(()=>{});

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
        
        return { success: true, signature: (successful[0] as any).value.signature, message: `🟢 Exit Submitted & Confirmed (${sellPercentage}%).\n📊 <b>Breakdown:</b> ${breakdown}` };
    } catch (error: any) { return { success: false, message: `🔴 Error: ${error.message}` }; }
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
        const latestBlockhash = await getLatestBlockhashWithCache();

        const results = await Promise.all(wallets.map(async (w): Promise<PreSignedExitPayload | null> => {
            try {
                const vaultPubkey = new PublicKey(w.pub);
                const parsedAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
                if (parsedAccounts.value.length === 0) return null;

                const rawBalance = BigInt(parsedAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                if (rawBalance === 0n) return null;

                // 🟢 VOLATILITY ADAPTIVE SLIPPAGE ON PRESIGNED INSTANT EXITS
                const baseSlip = user.slippagePercent || 20.0;
                const dynamicSlip = await getVolatilityAdjustedSlippage(targetCA, baseSlip);

                const apiRes = await fetchApiTransaction('sell', targetCA, w.pub, 0, 0, rawBalance.toString(), 100, dynamicSlip, 'TURBO', 0.005, w.pk);
                if (!apiRes.buffer) return null;

                const keypair = getCachedKeypair(w.pub, w.pk);
                if (!keypair) return null; 

                const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
                swapTx.sign([keypair]);

                const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, 0.01, 'TURBO', 0.005, false, latestBlockhash.blockhash);
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