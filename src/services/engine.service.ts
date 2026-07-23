// src/services/engine.service.ts
import { PublicKey, SystemProgram, VersionedTransaction, TransactionMessage, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
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
import https from 'https';

dotenv.config();

// 🟢 PERFORMANCE: Cache priority fees so 'FAST' default doesn't block on RPC
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

// 🟢 SPEED FIX: Apply the DoH-resolved agent to ALL outbound calls, including Jupiter and PumpPortal
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

const prisma = new PrismaClient();

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

// Background poller. No longer blocks UI responses.
async function pollSignatureConfirmation(signature: string, maxRetries = 8): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status?.value) {
            if (status.value.err) return false;
            if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                return true;
            }
        }
    }
    return false;
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

export async function checkRecentMevActivityCached(tokenMint: string): Promise<boolean> {
    try {
        const cached = await redis.get(`mev_check:${tokenMint}`);
        if (cached) return cached === 'true';
        const hasMev = await checkRecentMevActivity(tokenMint);
        await redis.set(`mev_check:${tokenMint}`, hasMev ? 'true' : 'false', 'EX', 10);
        return hasMev;
    } catch (_) {
        return false;
    }
}

// 🟢 SPEED FIX: Fire raw send AT THE SAME TIME as Jito, don't wait for Jito to fail first
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
                headers: { 'Content-Type': 'application/json', ...API_HEADERS },
                timeout: 3000
            })
        );

        // 🟢 FIRE RAW SEND IN PARALLEL
        const rawSendPromise = allowRawFallback
            ? connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true }).catch(() => null)
            : Promise.resolve(null);

        const jitoRes = await Promise.any(requests).catch((e) => e.errors?.[0] || e);
        const rawSig = await rawSendPromise;

        // If raw hit, attempt to tip anyway just in case
        if (rawSig) {
            connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true }).catch(() => {});
        }

        if (jitoRes?.data?.error && !rawSig) {
            console.error("🔴 [JITO BUNDLE REJECTED]:", JSON.stringify(jitoRes.data.error));
            return false;
        }

        const signature = bs58.encode(swapTx.signatures[0]);
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) return true;
        }
        
        return false;
    } catch (e: any) {
        return false;
    }
}

// 🟢 PERFORMANCE: Timeouts slashed to 3.5s to fail fast
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
): Promise<{ buffer: Buffer | null, errorLog: string, estimatedOutput?: number }> {
    let globalErrorLog = "";
    try {
        const isPumpToken = mint.toLowerCase().endsWith("pump");
        let apiBuffer: Buffer | null = null;

        if (isPumpToken) {
            const pumpAmount: string | number = action === 'buy'
                ? amountSolForBuy
                : (sellPercentage === 100 ? "100%" : rawTokenAmountForSell);
            try {
                const pumpRes = await axiosClient.post(
                    `https://pumpportal.fun/api/trade-local`,
                    {
                        publicKey: vault, action, mint, denominatedInSol: action === 'buy',
                        amount: pumpAmount, slippage, priorityFee: 0.0001, pool: "auto"
                    },
                    { headers: API_HEADERS, responseType: 'arraybuffer', timeout: 3500 }
                );
                apiBuffer = Buffer.from(pumpRes.data);
                return { buffer: apiBuffer, errorLog: "" };
            } catch (e: any) {
                globalErrorLog += `[PumpPortal: API Reject] `;
            }
        }

        if (!apiBuffer && !isPumpToken && raydiumPoolId && pkEncrypted) {
            try {
                const { buildDirectRaydiumSwap } = await import('./raydium.service.js');
                const keypair = getCachedKeypair(vault, pkEncrypted); 
                if (keypair) {
                    const inputMint = action === 'buy' ? 'So11111111111111111111111111111111111111112' : mint;
                    const rawAmount = action === 'buy' ? Math.floor(amountSolForBuy * 1_000_000_000) : parseInt(rawTokenAmountForSell);

                    const raydiumBuffer = await buildDirectRaydiumSwap(
                        keypair, raydiumPoolId, inputMint, rawAmount, Math.floor(slippage * 100)
                    );
                    if (raydiumBuffer) return { buffer: raydiumBuffer, errorLog: '' };
                }
            } catch (e: any) {
                globalErrorLog += `[Raydium Direct: ${e.message}] `;
            }
        }

        if (!apiBuffer) {
            const inputMint = action === 'buy' ? "So11111111111111111111111111111111111111112" : mint;
            const outputMint = action === 'buy' ? mint : "So11111111111111111111111111111111111111112";
            const rawAmount = action === 'buy' ? Math.floor(amountSolForBuy * 1_000_000_000).toString() : rawTokenAmountForSell;
            const slippageBps = Math.floor(slippage * 100);
            const jupiterPriorityLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);

            try {
                const quoteRes = await axiosClient.get(
                    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`,
                    { headers: API_HEADERS, timeout: 3500 }
                );
                
                let estimatedOutput = 0;
                if (action === 'sell' && quoteRes.data?.outAmount) estimatedOutput = Number(quoteRes.data.outAmount) / 1_000_000_000;

                const swapRes = await axiosClient.post(
                    'https://lite-api.jup.ag/swap/v1/swap',
                    {
                        quoteResponse: quoteRes.data, userPublicKey: vault, wrapAndUnwrapSol: true,
                        dynamicComputeUnitLimit: true, prioritizationFeeLamports: jupiterPriorityLamports
                    },
                    { headers: API_HEADERS, timeout: 3500 }
                );

                if (swapRes.data?.swapTransaction) {
                    apiBuffer = Buffer.from(swapRes.data.swapTransaction, 'base64');
                    return { buffer: apiBuffer, errorLog: "", estimatedOutput };
                }
                globalErrorLog += `[Jupiter: Swap Reject] `;
            } catch (e: any) {
                globalErrorLog += `[Jupiter: Route Timeout] `;
            }
        }

        return { buffer: null, errorLog: globalErrorLog };
    } catch (e: any) {
        return { buffer: null, errorLog: `Fatal: ${e.message}` };
    }
}

async function buildTipAndFeeTransaction(
    payer: Keypair, telegramId: string, expectedSolVolume: number,
    priorityLevel: string = "FAST", customPriorityFee: number = 0.001,
    isBumper: boolean = false, blockhash: string
): Promise<VersionedTransaction | null> {
    try {
        // 🟢 CRITICAL FIX: Dynamically fetch fee rate (0% for VIPs, 1% for standard)
        const feeRate = await getPlatformFeeRate(telegramId); 
        const feeLamports = BigInt(Math.floor((expectedSolVolume * 1_000_000_000) * feeRate));

        const partnerWallet = process.env.TREASURY_WALLET_ADDRESS;

        let tipLamports = 100_000;
        if (!isBumper) tipLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);

        const jitoTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const instructions = [];

        if (partnerWallet && feeLamports > 0n) {
            instructions.push(SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: new PublicKey(partnerWallet),
                lamports: Number(feeLamports)
            }));
        }

        instructions.push(SystemProgram.transfer({
            fromPubkey: payer.publicKey, toPubkey: new PublicKey(jitoTipAccount), lamports: tipLamports
        }));

        const messageV0 = new TransactionMessage({
            payerKey: payer.publicKey, recentBlockhash: blockhash, instructions
        }).compileToV0Message();

        const tx = new VersionedTransaction(messageV0);
        tx.sign([payer]);
        return tx;
    } catch (_) { return null; }
}
export async function executeSnipe(
    telegramId: string, targetCA: string, amountSol: number,
    side: 'buy' | 'sell' = 'buy', tokenAmount?: number,
    isBumper: boolean = false, raydiumPoolId?: string
): Promise<{ success: boolean; signature?: string; message: string; volumeSpent?: number }> {

    const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteSnipe(telegramId, targetCA, amountSol);
    }
    
    // 🟢 PERFORMANCE: MEV check parallelization
    const mevPromise = (side === 'buy' && !isBumper)
        ? checkRecentMevActivityCached(targetCA).catch(() => false)
        : Promise.resolve(false);

    if (side === 'sell') {
        let percentage = 100;
        if (tokenAmount) {
            try {
                const user = await prisma.user.findUnique({ where: { telegramId } });
                if (user && user.vaultAddress) {
                    const activePubkeys: PublicKey[] = [new PublicKey(user.vaultAddress)];
                    if (user.activeWallets >= 2 && user.vault2) activePubkeys.push(new PublicKey(user.vault2));
                    if (user.activeWallets >= 3 && user.vault3) activePubkeys.push(new PublicKey(user.vault3));
                    if (user.activeWallets >= 4 && user.vault4) activePubkeys.push(new PublicKey(user.vault4));
                    if (user.activeWallets >= 5 && user.vault5) activePubkeys.push(new PublicKey(user.vault5));

                    let totalTokens = 0;
                    await Promise.all(activePubkeys.map(async (pubKey) => {
                        try {
                            const parsed = await connection.getParsedTokenAccountsByOwner(pubKey, { mint: new PublicKey(targetCA) }, 'confirmed');
                            if (parsed.value.length > 0) totalTokens += parsed.value[0].account.data.parsed.info.tokenAmount.uiAmount;
                        } catch (err) {}
                    }));
                    if (totalTokens > 0) percentage = Math.min(100, Math.round((tokenAmount / totalTokens) * 100));
                }
            } catch (e) { percentage = 100; }
        }
        return executeExit(telegramId, targetCA, percentage, isBumper);
    }

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No active Vault found." };

        // 🟢 C6 FIX: Pre-check cached memory balance before wasting a full RPC call
        let liveBalanceSol = getLiveWalletBalance(user.vaultAddress);
        if (liveBalanceSol === null) {
            const balanceLamports = await connection.getBalance(new PublicKey(user.vaultAddress));
            liveBalanceSol = balanceLamports / LAMPORTS_PER_SOL;
        }

        if (liveBalanceSol < amountSol + 0.005) {
            return { success: false, message: "Insufficient Funds." };
        }

        // 🟢 C7 FIX: Race condition for MEV to unblock the execution path
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 300));
        const mevResult = await Promise.race([mevPromise, timeoutPromise]);
        
        if (mevResult === true) {
            return { success: false, message: "🚨 MEV Sandwich Bot / High Risk Activity Detected. Trade Blocked." };
        } else if (mevResult === "TIMEOUT") {
            // Unblocks the buy immediately, but evaluates the MEV warning asynchronously in the background
            mevPromise.then(async (isMev) => {
                if (isMev) {
                    try {
                        const { default: axios } = await import('axios');
                        await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                            chat_id: telegramId,
                            text: `⚠️ <b>Advisory Warning:</b> <code>${targetCA}</code> was successfully sniped, but post-trade analysis detected high MEV activity. Consider tightening your trailing stop.`,
                            parse_mode: 'HTML'
                        });
                    } catch(e) {}
                }
            }).catch(()=>{});
        }

        const slippage = user.slippagePercent || 20.0;
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed." };
        
        const wallets: Keypair[] = [Keypair.fromSecretKey(bs58.decode(rawW1))];
        if (user.activeWallets >= 2 && user.pk2) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk2)!)));
        if (user.activeWallets >= 3 && user.pk3) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk3)!)));
        if (user.activeWallets >= 4 && user.pk4) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk4)!)));
        if (user.activeWallets >= 5 && user.pk5) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk5)!)));

        let successCount = 0;
        let totalVolume = 0;
        let firstSignature = "";
        
        const walletReport: string[] = [];
        const walletErrors: string[] = [];

        const latestBlockhash = await getLatestBlockhashWithCache();

        const executionPromises = wallets.map(async (w, index) => {
            let wBal = getLiveWalletBalance(w.publicKey.toBase58());
            if (wBal === null) {
                wBal = (await connection.getBalance(w.publicKey).catch(()=>0)) / LAMPORTS_PER_SOL;
            }
            const requiredBuffer = 0.001 + (amountSol * 0.01) + 0.0005;
            if (wBal < amountSol + requiredBuffer) {
                walletErrors[index] = `Insufficient Funds`; walletReport[index] = `W${index + 1}: 🔴 Gas`; return;
            }

            const apiRes = await fetchApiTransaction('buy', targetCA, w.publicKey.toBase58(), amountSol, 0, "0", 0, slippage, priorityLevel, customPriorityFee, undefined, raydiumPoolId);
            if (!apiRes.buffer) {
                walletErrors[index] = apiRes.errorLog; walletReport[index] = `W${index + 1}: 🔴 Route`; return;
            }

            const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            swapTx.sign([w]);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, amountSol, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash);
            if (!tipTx) { walletReport[index] = `W${index + 1}: 🔴 Sign`; return; }

            let txSig = bs58.encode(swapTx.signatures[0]);

            // 🟢 SPEED FIX: Parallel execution via updated sendToJitoBundle. Maintains slippage safety.
            const bundleOk = await sendToJitoBundle(swapTx, tipTx, slippage <= 25.0);
            if (!bundleOk) {
                walletErrors[index] = "Transaction dropped. High slippage fallback aborted or network congested."; 
                walletReport[index] = `W${index + 1}: 🔴 Drop`; 
                return;
            }

            // 🟢 PERFORMANCE: DO NOT AWAIT CONFIRMATION! Assume submission success to speed up Telegram response.
            if (!firstSignature) firstSignature = txSig;
            successCount++;
            totalVolume += amountSol;
            walletReport[index] = `W${index + 1}: 🚀 Sent`;

            // 🟢 BACKGROUND: Polling and DB writes
            pollSignatureConfirmation(txSig).then(async (confirmed) => {
                if (confirmed) {
                    const feeRate = await getPlatformFeeRate(user.telegramId);
                    const feeCharged = amountSol * feeRate;
                    
                    const maxDistributable = feeCharged * 0.70;

                    let affiliateCut = 0;
                    if (user.referredById) {
                        const dynamicRate = await getDynamicAffiliateRate(user.referredById); 
                        affiliateCut = feeCharged * dynamicRate;
                        await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: affiliateCut } } }).catch(()=>{});
                    }

                    let guildOwnerCut = 0;
                    let guildOwnerId: string | null = null;
                    try {
                        const activeGuildMembership = await prisma.guildMembership.findFirst({ where: { userId: user.id, isActive: true }, include: { guild: true } });
                        if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                            guildOwnerId = activeGuildMembership.guild.ownerId;
                            
                            const availableForGuild = maxDistributable - affiliateCut;
                            if (availableForGuild > 0) {
                                const standardGuildCut = feeCharged * 0.50; 
                                guildOwnerCut = Math.min(standardGuildCut, availableForGuild);
                                
                                if (guildOwnerId !== user.referredById) {
                                    await prisma.user.update({ where: { id: guildOwnerId }, data: { pendingRewardsSol: { increment: guildOwnerCut } } }).catch(()=>{});
                                }
                            }
                        }
                    } catch (_) {}

                    await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: amountSol } } }).catch(()=>{});
                    awardGuildPoints(user.telegramId, amountSol).catch(() => {});
                    
                    await prisma.trade.create({
                        data: {
                            userId: user.id, tokenAddress: targetCA, isBuy: true, amountInSol: amountSol,
                            feeChargedSol: feeCharged, affiliateCutSol: affiliateCut, loyaltyRebateSol: 0,
                            txSignature: txSig, status: 'CONFIRMED'
                        }
                    }).catch(() => {});
                }
            });
        });

        await Promise.allSettled(executionPromises);

        if (successCount === 0) {
            const finalError = walletErrors.filter(Boolean).join(" | ") || "Transaction failed to build.";
            return { success: false, message: `🔴 <b>Snipe Aborted:</b>\n<code>${finalError}</code>` };
        }

        await redis.set(`trade_time:${telegramId}:${targetCA}`, Date.now().toString(), 'EX', 86400 * 7);
        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10); 

        return {
            success: true,
            signature: firstSignature,
            message: `🟢 Trade Submitted to Validators (${successCount}/${wallets.length} Wallets).\n📊 <b>Breakdown:</b> ${walletReport.join(" | ")}\n⚡ <i>Confirming in background...</i>`,
            volumeSpent: totalVolume
        };
    } catch (error: any) {
        return { success: false, message: `🔴 Execution Fault: ${error.message}` };
    }
}

export async function executeExit(
    telegramId: string, targetCA: string, sellPercentage: number = 100, isBumper: boolean = false
): Promise<{ success: boolean; signature?: string; message: string }> {

    const { isSimulationActive, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) return await simExecuteExit(telegramId, targetCA, sellPercentage);
    
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "🔴 No Vault." };

        const slippage = sellPercentage === 100 ? 100.0 : (user.slippagePercent || 20.0);
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const rawW1 = decryptKey(user.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Decryption Failed." };

        const wallets: Keypair[] = [Keypair.fromSecretKey(bs58.decode(rawW1))];
        if (user.activeWallets >= 2 && user.pk2) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk2)!)));
        if (user.activeWallets >= 3 && user.pk3) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk3)!)));
        if (user.activeWallets >= 4 && user.pk4) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk4)!)));
        if (user.activeWallets >= 5 && user.pk5) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(user.pk5)!)));

        const tokenMint = new PublicKey(targetCA);
        let successCount = 0;
        let totalFeeBase = 0;
        let firstSignature = "";
        
        const walletReport: string[] = [];
        const walletErrors: string[] = [];

        const latestBlockhash = await getLatestBlockhashWithCache();
        const balances = await Promise.all(wallets.map(w => connection.getBalance(w.publicKey).catch(() => 0)));

        const executionPromises = wallets.map(async (w, index) => {
            const vaultPubkey = w.publicKey;

            if (balances[index] < 1_500_000) { walletErrors[index] = `Gas.`; walletReport[index] = `W${index + 1}: 🔴 Gas`; return; }

            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
            if (parsedTokenAccounts.value.length === 0 || BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) === 0n) {
                walletReport[index] = `W${index + 1}: ⚪ Empty`; return;
            }

            const rawTokenBalance = BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const decimals = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;
            const tokensToSellRaw = (rawTokenBalance * BigInt(Math.floor(sellPercentage))) / 100n;
            const uiTokensToSell = Number((Number(tokensToSellRaw) / (10 ** decimals)).toFixed(decimals));

            // 🟢 TS ERROR FIX: Safely assert string | undefined to prevent strict-null compiler failure
            const rawPkEncrypted = index === 0 ? user.turnkeySubOrgId : user[`pk${index+1}` as keyof typeof user];
            const pkEncrypted = typeof rawPkEncrypted === 'string' ? rawPkEncrypted : undefined;

            const apiRes = await fetchApiTransaction('sell', targetCA, w.publicKey.toBase58(), 0, uiTokensToSell, tokensToSellRaw.toString(), sellPercentage, slippage, priorityLevel, customPriorityFee, pkEncrypted);
            if (!apiRes.buffer) { walletErrors[index] = apiRes.errorLog; walletReport[index] = `W${index + 1}: 🔴 Route`; return; }

            const dynamicFeeBase = apiRes.estimatedOutput && apiRes.estimatedOutput > 0 ? apiRes.estimatedOutput : 0.01;
            const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            swapTx.sign([w]);

            const tipTx = await buildTipAndFeeTransaction(w, telegramId, dynamicFeeBase, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash);
            if (!tipTx) { walletErrors[index] = `Sign Error.`; walletReport[index] = `W${index + 1}: 🔴 Sign`; return; }

            let txSig = bs58.encode(swapTx.signatures[0]);
            
            const bundleOk = await sendToJitoBundle(swapTx, tipTx, slippage <= 25.0);
            if (!bundleOk) {
                walletErrors[index] = "Transaction dropped. High slippage fallback aborted or network congested."; 
                walletReport[index] = `W${index + 1}: 🔴 Drop`; 
                return;
            }

            if (!firstSignature) firstSignature = txSig;
            successCount++;
            totalFeeBase += dynamicFeeBase;
            walletReport[index] = `W${index + 1}: 🚀 Sent`;

            pollSignatureConfirmation(txSig).then(async (confirmed) => {
                if (confirmed) {
                    let actualSolReceived = dynamicFeeBase;
                    try {
                        const parsedTx = await connection.getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                        if (parsedTx?.meta && parsedTx.meta.preBalances[0] !== undefined && parsedTx.meta.postBalances[0] !== undefined) {
                            actualSolReceived = (Number(parsedTx.meta.postBalances[0]) - Number(parsedTx.meta.preBalances[0])) / LAMPORTS_PER_SOL;
                        }
                    } catch (e) {}

                    const feeRate = await getPlatformFeeRate(user.telegramId);
                    const feeCharged = actualSolReceived * feeRate;
                    
                    let affiliateCut = 0;
                    if (user.referredById) {
                        const dynamicRate = await getDynamicAffiliateRate(user.referredById);
                        affiliateCut = feeCharged * dynamicRate;
                        await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: affiliateCut } } }).catch(()=>{});
                    }

                    // 🟢 FIX F1: Calculate Guild Owner split with precise overlap & feeCharged caps
                    let guildOwnerCut = 0;
                    let guildOwnerId: string | null = null;
                    try {
                        const activeGuildMembership = await prisma.guildMembership.findFirst({ where: { userId: user.id, isActive: true }, include: { guild: true } });
                        if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                            guildOwnerId = activeGuildMembership.guild.ownerId;
                            
                            const maxDistributable = feeCharged * 0.70;
                            const availableForGuild = maxDistributable - affiliateCut;
                            
                            if (availableForGuild > 0) {
                                const standardGuildCut = feeCharged * 0.50; 
                                guildOwnerCut = Math.min(standardGuildCut, availableForGuild);
                                
                                if (guildOwnerId === user.referredById) {
                                    const combined = affiliateCut + guildOwnerCut;
                                    if (combined > feeCharged) guildOwnerCut = feeCharged - affiliateCut;
                                }
                                
                                await prisma.user.update({ where: { id: guildOwnerId }, data: { pendingRewardsSol: { increment: guildOwnerCut } } }).catch(()=>{});
                            }
                        }
                    } catch (_) {}

                    let volumeToRecord = actualSolReceived; 
                    try {
                        // 🟢 FIX B5: Accurate weighted cost-basis summing across all unclosed buys
                        const allBuys = await prisma.trade.findMany({ 
                            where: { userId: user.id, tokenAddress: targetCA, isBuy: true, status: 'CONFIRMED' } 
                        });
                        if (allBuys.length > 0) {
                            const totalInvested = allBuys.reduce((sum, t) => sum + t.amountInSol, 0);
                            volumeToRecord = totalInvested * (sellPercentage / 100);
                        }
                    } catch (_) {}

                    const realizedPnlSol = actualSolReceived - volumeToRecord;
                    const profitPercent = volumeToRecord > 0 ? (realizedPnlSol / volumeToRecord) * 100 : 0;

                    await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: volumeToRecord } } }).catch(()=>{});
                    
                    const { awardGuildPoints } = await import('./guild.service.js');
                    awardGuildPoints(user.telegramId, volumeToRecord).catch(() => {});
                    
                    // 🟢 FIX 4: Record Stats Event natively to the rolling stats window
                    const { recordStatsEvent } = await import('./simulation.service.js');
                    await recordStatsEvent(user.telegramId, 'live', realizedPnlSol).catch(()=>{});

                    await prisma.trade.create({
                        data: {
                            userId: user.id, tokenAddress: targetCA, isBuy: false, amountInSol: volumeToRecord,
                            feeChargedSol: feeCharged, affiliateCutSol: affiliateCut, loyaltyRebateSol: 0,
                            txSignature: txSig, status: 'CONFIRMED', profitPercent: parseFloat(profitPercent.toFixed(2)),
                            realizedPnlSol: realizedPnlSol
                        }
                    }).catch(() => {});

                    if (!isBumper) {
                        const captionHtml = `${profitPercent >= 0 ? '🟢' : '🔴'} <b>SELL CONFIRMED</b>\n\n` +
                                `Token: <code>${targetCA.substring(0,8)}...</code>\n` +
                                `PnL: <b>${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%</b>\n` +
                                `🔗 <a href="https://solscan.io/tx/${txSig}">View on Solscan</a>`;
                        try {
                            const { generatePnlCard } = await import('./image.service.js');
                            const imageBuffer = await generatePnlCard(targetCA, profitPercent, user.referralCode ?? undefined);
                            
                            const FormData = (await import('form-data')).default || await import('form-data');
                            const form: any = new FormData();
                            form.append('chat_id', telegramId);
                            form.append('photo', imageBuffer, { filename: 'pnl.png', contentType: 'image/png' });
                            form.append('caption', captionHtml);
                            form.append('parse_mode', 'HTML');
                            
                            const axiosClient = (await import('axios')).default;
                            await axiosClient.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, form, {
                                headers: form.getHeaders(),
                                timeout: 5000
                            });
                        } catch (e) {
                            try {
                                const axiosClient = (await import('axios')).default;
                                await axiosClient.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                                    chat_id: telegramId, text: captionHtml, parse_mode: 'HTML', link_preview_options: { is_disabled: true }
                                });
                            } catch (_) {}
                        }
                    }
                }
            });
        });

        await Promise.allSettled(executionPromises);

        if (successCount === 0) {
            const finalError = walletErrors.filter(Boolean).join(" | ") || "Transaction failed to build.";
            return { success: false, message: `🔴 <b>Exit Aborted:</b>\n<code>${finalError}</code>` };
        }

        const breakdown = walletReport.filter(r => !r.includes("Empty")).join(" | ");
        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10);

        return { success: true, signature: firstSignature, message: `🟢 Exit Submitted (${sellPercentage}%).\n📊 <b>Breakdown:</b> ${breakdown}\n⚡ <i>Confirming in background...</i>` };
    } catch (error: any) { return { success: false, message: `🔴 Error: ${error.message}` }; }
}

async function getDynamicAffiliateRate(referrerId: string): Promise<number> {
    try {
        const referrer = await prisma.user.findUnique({
            where: { id: referrerId },
            include: { _count: { select: { recruits: true } } }
        });
        if (!referrer) return 0.40; 

        const basePoints = Math.floor((referrer.totalVolumeSol || 0) * 10000);
        const welcomeBonus = referrer.referredById ? 10000 : 0;
        const recruitBonus = (referrer._count.recruits || 0) * 2000;
        const totalPoints = basePoints + welcomeBonus + recruitBonus;

        if (totalPoints >= 1000000) return 0.70; 
        if (totalPoints >= 250000) return 0.60;  
        if (totalPoints >= 50000) return 0.50;   
        return 0.40;                             
    } catch { return 0.40; }
}

export async function generatePreSignedExitTx(telegramId: string, targetCA: string): Promise<{ swapBase64: string, tipBase64: string } | null> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return null;
        
        if (user.activeWallets > 1) return null;

        const slippage = 100.0; 
        const vaultPubkey = new PublicKey(user.vaultAddress);
        const tokenMint = new PublicKey(targetCA);
        
        const parsedAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
        if (parsedAccounts.value.length === 0) return null;

        const rawBalance = BigInt(parsedAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        if (rawBalance === 0n) return null;

        const apiRes = await fetchApiTransaction('sell', targetCA, user.vaultAddress, 0, 0, rawBalance.toString(), 100, slippage, 'TURBO', 0.005, user.turnkeySubOrgId);
        if (!apiRes.buffer) return null;

        const keypair = getCachedKeypair(user.vaultAddress, user.turnkeySubOrgId);
        if (!keypair) return null;

        const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
        swapTx.sign([keypair]);

        const latestBlockhash = await getLatestBlockhashWithCache();
        const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, 0.01, 'TURBO', 0.005, false, latestBlockhash.blockhash);
        if (!tipTx) return null;

        return {
            swapBase64: Buffer.from(swapTx.serialize()).toString('base64'),
            tipBase64: Buffer.from(tipTx.serialize()).toString('base64')
        };
    } catch (e) { return null; }
}