// src/services/engine.service.ts
import { PublicKey, SystemProgram, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import axios from 'axios';
import { connection } from '../lib/connection.js';
import { decryptKey } from './vault.service.js';
import { awardGuildPoints } from './guild.service.js';
import { getEffectiveFeePercent, getVipStatus } from './vip_promo.service.js'; 
import { checkRecentMevActivity } from './price.service.js'; // TASK 7 FIX
import { redis } from '../lib/redis.js'; 
import dns from 'dns';
import https from 'https';

dotenv.config();

export function getDynamicFeeRate(volumeSol: number, hasReferral: boolean): number {
    if (volumeSol >= 20) return 0.006; 
    if (volumeSol >= 5) return 0.008;  
    if (hasReferral) return 0.009;     
    return 0.01;                       
}

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
}, 1000);

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

async function getDynamicPriorityFee(priorityLevel: string, customPriorityFee: number): Promise<number> {
    if (priorityLevel === 'ECO') return 500_000;
    if (priorityLevel === 'CUSTOM') return Math.floor(customPriorityFee * 1_000_000_000);
    if (priorityLevel === 'TURBO') return 5_000_000;
    
    try {
        const rpcUrl = process.env.HELIUS_RPC_URL || connection.rpcEndpoint;
        const res = await axios.post(rpcUrl, {
            jsonrpc: "2.0", id: 1, method: "getPriorityFeeEstimate",
            params: [{ "targetOptions": { "defaultLevel": "high" } }]
        }, { timeout: 2000 });
        return Math.max(1_000_000, res.data?.result?.priorityFeeEstimate || 1_000_000);
    } catch (_) {
        return 1_000_000;
    }
}

export async function sendToJitoBundle(swapTx: VersionedTransaction, tipTx: VersionedTransaction): Promise<boolean> {
    try {
        const base64Swap = Buffer.from(swapTx.serialize()).toString('base64');
        const base64Tip = Buffer.from(tipTx.serialize()).toString('base64');

        const jitoRes = await axios.post(`https://mainnet.block-engine.jito.wtf/api/v1/bundles`, {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [[base64Swap, base64Tip]]
        }, { headers: { 'Content-Type': 'application/json', ...API_HEADERS }, httpsAgent: activeAgent, timeout: 10000 });

        if (jitoRes.data?.error) {
            console.error("🔴 [JITO BUNDLE REJECTED]:", JSON.stringify(jitoRes.data.error));
            return false;
        }
        return !!jitoRes.data?.result;
    } catch (e: any) {
        const detail = e.response?.status ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
        console.error("🔴 [JITO CONNECTION EXCEPTION]:", detail);
        return false;
    }
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
): Promise<{ buffer: Buffer | null, errorLog: string }> {
    let globalErrorLog = "";
    try {
        const isPumpToken = mint.toLowerCase().endsWith("pump");
        let apiBuffer: Buffer | null = null;

        if (isPumpToken) {
            const pumpAmount: string | number = action === 'buy'
                ? amountSolForBuy
                : (sellPercentage === 100 ? "100%" : rawTokenAmountForSell);
            try {
                const pumpRes = await axios.post(
                    `https://pumpportal.fun/api/trade-local`,
                    {
                        publicKey: vault,
                        action,
                        mint,
                        denominatedInSol: action === 'buy',
                        amount: pumpAmount,
                        slippage,
                        priorityFee: 0.0001,
                        pool: "auto"
                    },
                    { httpsAgent: activeAgent, headers: API_HEADERS, responseType: 'arraybuffer', timeout: 8000 }
                );
                apiBuffer = Buffer.from(pumpRes.data);
                return { buffer: apiBuffer, errorLog: "" };
            } catch (e: any) {
                const detail = e.response?.data
                    ? Buffer.from(e.response.data).toString('utf-8').substring(0, 150)
                    : e.message;
                globalErrorLog += `[PumpPortal: ${e.response?.status || ''} ${detail}] `;
            }
        }

        if (!apiBuffer && !isPumpToken) {
            if (raydiumPoolId && pkEncrypted) {
                try {
                    const { buildDirectRaydiumSwap } = await import('./raydium.service.js');
                    const keypair = getCachedKeypair(vault, pkEncrypted); 
                    if (keypair) {
                        const inputMint = action === 'buy' ? 'So11111111111111111111111111111111111111112' : mint;
                        const rawAmount = action === 'buy' ? Math.floor(amountSolForBuy * 1_000_000_000) : parseInt(rawTokenAmountForSell);

                        const raydiumBuffer = await buildDirectRaydiumSwap(
                            keypair, raydiumPoolId, inputMint, rawAmount, Math.floor(slippage * 100)
                        );
                        if (raydiumBuffer) {
                            return { buffer: raydiumBuffer, errorLog: '' };
                        }
                    }
                } catch (e: any) {
                    globalErrorLog += `[Raydium Direct: ${e.message}] `;
                }
            }
        }

        if (!apiBuffer) {
            const inputMint = action === 'buy' ? "So11111111111111111111111111111111111111112" : mint;
            const outputMint = action === 'buy' ? mint : "So11111111111111111111111111111111111111112";
            const rawAmount = action === 'buy' ? Math.floor(amountSolForBuy * 1_000_000_000).toString() : rawTokenAmountForSell;
            const slippageBps = Math.floor(slippage * 100);

            const jupiterPriorityLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);

            try {
                const quoteRes = await axios.get(
                    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawAmount}&autoSlippage=true&maxAutoSlippageBps=${slippageBps}`,
                    { httpsAgent: activeAgent, headers: API_HEADERS, timeout: 8000 }
                );
                const swapRes = await axios.post(
                    'https://lite-api.jup.ag/swap/v1/swap',
                    {
                        quoteResponse: quoteRes.data,
                        userPublicKey: vault,
                        wrapAndUnwrapSol: true,
                        dynamicComputeUnitLimit: true,
                        prioritizationFeeLamports: jupiterPriorityLamports
                    },
                    { httpsAgent: activeAgent, headers: API_HEADERS, timeout: 8000 }
                );

                if (swapRes.data?.swapTransaction) {
                    apiBuffer = Buffer.from(swapRes.data.swapTransaction, 'base64');
                    return { buffer: apiBuffer, errorLog: "" };
                }
                globalErrorLog += `[Jupiter: No swapTransaction in response] `;
            } catch (e: any) {
                const detail = e.response?.data ? JSON.stringify(e.response.data).substring(0, 150) : e.message;
                globalErrorLog += `[Jupiter: ${e.response?.status || ''} ${detail}] `;
            }
        }

        return { buffer: null, errorLog: globalErrorLog };
    } catch (e: any) {
        return { buffer: null, errorLog: `Fatal: ${e.message}` };
    }
}

async function buildTipAndFeeTransaction(
    payer: Keypair,
    telegramId: string, 
    expectedSolVolume: number,
    priorityLevel: string = "FAST",
    customPriorityFee: number = 0.001,
    isBumper: boolean = false,
    blockhash: string,
    hasDiscount: boolean = false
): Promise<VersionedTransaction | null> {
    try {
        const baseFeeRate = getDynamicFeeRate(expectedSolVolume, hasDiscount);
        const feeRate = await getEffectiveFeePercent(telegramId, baseFeeRate);
        const feeLamports = BigInt(Math.floor((expectedSolVolume * 1_000_000_000) * feeRate));

        const partnerWallet = process.env.TREASURY_WALLET_ADDRESS;

        let tipLamports = 100_000;
        if (!isBumper) {
            tipLamports = await getDynamicPriorityFee(priorityLevel, customPriorityFee);
        }

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
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(jitoTipAccount),
            lamports: tipLamports
        }));

        const messageV0 = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

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
    raydiumPoolId?: string
): Promise<{ success: boolean; signature?: string; message: string; volumeSpent?: number }> {

    const { isSimulationActive, simExecuteSnipe } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteSnipe(telegramId, targetCA, amountSol);
    }
    
    // TASK 7 FIX: Wire checkRecentMevActivity into the pre-buy safety checks
    if (side === 'buy' && !isBumper) {
        try {
            const hasMev = await checkRecentMevActivity(targetCA);
            if (hasMev) {
                return { success: false, message: "🚨 High MEV Bot / Sandwich activity detected on this token recently. Snipe aborted by safety shields to protect your funds." };
            }
        } catch (e) {
            // Ignore API faults to not block fast trading
        }
    }

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
                            if (parsed.value.length > 0) {
                                totalTokens += parsed.value[0].account.data.parsed.info.tokenAmount.uiAmount;
                            }
                        } catch (err) {}
                    }));

                    if (totalTokens > 0) {
                        percentage = Math.min(100, Math.round((tokenAmount / totalTokens) * 100));
                    }
                }
            } catch (e) {
                percentage = 100;
            }
        }
        return executeExit(telegramId, targetCA, percentage, isBumper);
    }

    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
            return { success: false, message: "🔴 No active Vault found." };
        }

        const slippage = user.slippagePercent || 20.0;
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        let successCount = 0;
        let totalVolume = 0;
        let firstSignature = "";
        let lastError = "";
        const walletReport: string[] = [];

        const latestBlockhash = await getLatestBlockhashWithCache();

        const executionPromises = wallets.map(async (w, index) => {
            const balanceSol = (await connection.getBalance(new PublicKey(w.pub))) / 1_000_000_000;

            let jitoTipSol = 0.001; 
            if (priorityLevel === 'ECO')    jitoTipSol = 0.0005;
            if (priorityLevel === 'TURBO')  jitoTipSol = 0.005;
            if (priorityLevel === 'CUSTOM') jitoTipSol = customPriorityFee;

            const platformFeeSol = amountSol * 0.01;
            const gasSol = 0.0005;
            const requiredBuffer = jitoTipSol + platformFeeSol + gasSol;

            if (balanceSol < amountSol + requiredBuffer) {
                lastError = `Insufficient Funds (need ~${(amountSol + requiredBuffer).toFixed(4)} SOL, have ${balanceSol.toFixed(4)} SOL)`;
                walletReport[index] = `W${index + 1}: 🔴 Gas`;
                return;
            }

            const apiRes = await fetchApiTransaction('buy', targetCA, w.pub, amountSol, 0, "0", 0, slippage, priorityLevel, customPriorityFee, w.pk, raydiumPoolId);
            if (!apiRes.buffer) {
                lastError = `API Route Failed: ${apiRes.errorLog}`;
                walletReport[index] = `W${index + 1}: 🔴 API Reject`;
                return;
            }

            const keypair = getCachedKeypair(w.pub, w.pk);
            if (!keypair) { lastError = "Decryption Fault."; walletReport[index] = `W${index + 1}: 🔴 Auth`; return; }

            const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            swapTx.sign([keypair]);

            const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, amountSol, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash, user.hasReferralDiscount);
            if (!tipTx) { walletReport[index] = `W${index + 1}: 🔴 Sign`; return; }

            let confirmed = false;
            let txSig = bs58.encode(swapTx.signatures[0]);

            const bundleOk = await sendToJitoBundle(swapTx, tipTx);
            if (bundleOk) {
                confirmed = await pollSignatureConfirmation(txSig);
            }

            if (!confirmed) {
                if (slippage > 25.0) {
                    lastError = "Jito Bundle dropped. Aborted public fallback to prevent MEV Sandwich Attack on high slippage.";
                    walletReport[index] = `W${index + 1}: 🔴 Jito Drop`;
                } else {
                    console.warn("⚠️ [JITO FALLBACK TRIGGERED] Sending trade + fee directly to the blockchain...");
                    try {
                        const directSig = await connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true });
                        txSig = directSig;
                        await connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true }).catch(() => null);
                        confirmed = await pollSignatureConfirmation(directSig);
                    } catch (e: any) {
                        lastError = `Direct Send Failed: ${e.message}`;
                    }
                }
            }

            if (confirmed) {
                if (!firstSignature) firstSignature = txSig;
                successCount++;
                totalVolume += amountSol;
                walletReport[index] = `W${index + 1}: 🟢`;
            } else {
                walletReport[index] = `W${index + 1}: 🔴 Fail`;
            }
        });

        await Promise.allSettled(executionPromises);

        if (successCount === 0) {
            return { success: false, message: `🔴 <b>Snipe Aborted:</b>\n<code>${lastError || "Transaction failed on-chain or expired."}</code>` };
        }

        const baseFeeRate = getDynamicFeeRate(user.totalVolumeSol, user.hasReferralDiscount);
        const effectiveFeeRate = await getEffectiveFeePercent(user.telegramId, baseFeeRate);

        const feeCharged = totalVolume * effectiveFeeRate;
        let affiliateCut = 0;
        if (user.referredById) {
            const dynamicRate = await getDynamicAffiliateRate(user.referredById);
            affiliateCut = feeCharged * dynamicRate;
        }

        // TASK 6 FIX: Compute Guild Owner 50% Revenue Share permanently
        let guildOwnerCut = 0;
        let guildOwnerId: string | null = null;
        try {
            const activeGuildMembership = await prisma.guildMembership.findFirst({
                where: { userId: user.id, isActive: true },
                include: { guild: true }
            });

            if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                guildOwnerId = activeGuildMembership.guild.ownerId;
                guildOwnerCut = feeCharged * 0.50; // 50% of the platform fee goes to the guild owner
            }
        } catch (_) {}

        await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: totalVolume } } });
        
        // TASK 5 FIX: Award Guild Points guaranteed to run on every successful trade
        awardGuildPoints(user.telegramId, totalVolume).catch(() => {});
        
        if (user.referredById && affiliateCut > 0) {
            await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: affiliateCut } } });
        }

        // TASK 6 FIX: Deposit the 50% revenue share into the Guild Owner's withdrawable wallet
        if (guildOwnerId && guildOwnerCut > 0 && guildOwnerId !== user.referredById) {
            await prisma.user.update({ where: { id: guildOwnerId }, data: { pendingRewardsSol: { increment: guildOwnerCut } } });
        }

        await prisma.trade.create({
            data: {
                userId: user.id,
                tokenAddress: targetCA,
                isBuy: true,
                amountInSol: totalVolume,
                feeChargedSol: feeCharged,
                affiliateCutSol: affiliateCut,
                loyaltyRebateSol: 0,
                txSignature: firstSignature,
                status: 'CONFIRMED'
            }
        }).catch(() => {});

        const vipStatus = await getVipStatus(telegramId);
        const badgeStr = vipStatus.badge ? `${vipStatus.badge} ` : '';

        await redis.set(`trade_time:${telegramId}:${targetCA}`, Date.now().toString(), 'EX', 86400 * 7);
        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10); 

        return {
            success: true,
            signature: firstSignature,
            message: `${badgeStr}🟢 Confirmed on ${successCount}/${wallets.length} Wallets.\n📊 <b>Breakdown:</b> ${walletReport.join(" | ")}\n⚡ <i>Trade Executed Successfully</i>`,
            volumeSpent: totalVolume
        };
    } catch (error: any) {
        return { success: false, message: `🔴 Execution Fault: ${error.message}` };
    }
}

export async function executeExit(
    telegramId: string,
    targetCA: string,
    sellPercentage: number = 100,
    isBumper: boolean = false
): Promise<{ success: boolean; signature?: string; message: string }> {

    const { isSimulationActive, simExecuteExit } = await import('./simulation.service.js');
    if (await isSimulationActive(telegramId)) {
        return await simExecuteExit(telegramId, targetCA, sellPercentage);
    }
    
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
            return { success: false, message: "🔴 No Vault." };
        }

        const slippage = sellPercentage === 100 ? 100.0 : (user.slippagePercent || 20.0);
        const priorityLevel = user.priorityLevel || 'FAST';
        const customPriorityFee = user.customPriorityFee || 0.001;

        const wallets = [{ pub: user.vaultAddress, pk: user.turnkeySubOrgId }];
        if (user.activeWallets >= 2 && user.vault2 && user.pk2) wallets.push({ pub: user.vault2, pk: user.pk2 });
        if (user.activeWallets >= 3 && user.vault3 && user.pk3) wallets.push({ pub: user.vault3, pk: user.pk3 });
        if (user.activeWallets >= 4 && user.vault4 && user.pk4) wallets.push({ pub: user.vault4, pk: user.pk4 });
        if (user.activeWallets >= 5 && user.vault5 && user.pk5) wallets.push({ pub: user.vault5, pk: user.pk5 });

        const tokenMint = new PublicKey(targetCA);
        let successCount = 0;
        let totalFeeBase = 0;
        let firstSignature = "";
        let lastError = "";
        const walletReport: string[] = [];

        const latestBlockhash = await getLatestBlockhashWithCache();

        const balances = await Promise.all(wallets.map(w => connection.getBalance(new PublicKey(w.pub)).catch(() => 0)));

        const executionPromises = wallets.map(async (w, index) => {
            const vaultPubkey = new PublicKey(w.pub);

            const keypair = getCachedKeypair(w.pub, w.pk);
            if (!keypair) { lastError = "Decryption Fault."; walletReport[index] = `W${index + 1}: 🔴 Auth`; return; }

            if (balances[index] < 1_500_000) {
                lastError = `Insufficient Gas.`;
                walletReport[index] = `W${index + 1}: 🔴 Gas`;
                return;
            }

            const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(vaultPubkey, { mint: tokenMint }, 'confirmed');
            if (
                parsedTokenAccounts.value.length === 0 ||
                BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) === 0n
            ) {
                walletReport[index] = `W${index + 1}: ⚪ Empty`;
                return;
            }

            const rawTokenBalance = BigInt(parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const decimals = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals;
            const tokensToSellRaw = (rawTokenBalance * BigInt(Math.floor(sellPercentage))) / 100n;
            const uiTokensToSell = Number((Number(tokensToSellRaw) / (10 ** decimals)).toFixed(decimals));

            const apiRes = await fetchApiTransaction('sell', targetCA, w.pub, 0, uiTokensToSell, tokensToSellRaw.toString(), sellPercentage, slippage, priorityLevel, customPriorityFee, w.pk);
            if (!apiRes.buffer) { lastError = apiRes.errorLog; walletReport[index] = `W${index + 1}: 🔴 Route`; return; }

            let estimatedSolOutput = 0;
            try {
                const quoteRes = await axios.get(
                    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${targetCA}&outputMint=So11111111111111111111111111111111111111112&amount=${tokensToSellRaw.toString()}`,
                    { httpsAgent: activeAgent, headers: API_HEADERS, timeout: 8000 }
                );
                if (quoteRes.data) estimatedSolOutput = Number(quoteRes.data.outAmount) / 1_000_000_000;
            } catch (_) {}

            const dynamicFeeBase = estimatedSolOutput > 0 ? estimatedSolOutput : 0.01;
            const swapTx = VersionedTransaction.deserialize(new Uint8Array(apiRes.buffer));
            swapTx.sign([keypair]);

            const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, dynamicFeeBase, priorityLevel, customPriorityFee, isBumper, latestBlockhash.blockhash, user.hasReferralDiscount);
            if (!tipTx) { lastError = `Sign Error.`; walletReport[index] = `W${index + 1}: 🔴 Sign`; return; }

            let confirmed = false;
            let txSig = bs58.encode(swapTx.signatures[0]);

            const bundleOk = await sendToJitoBundle(swapTx, tipTx);
            if (bundleOk) {
                confirmed = await pollSignatureConfirmation(txSig);
            }

            if (!confirmed) {
                if (slippage > 25.0) {
                    lastError = "Jito Bundle dropped. Aborted public fallback to prevent MEV Sandwich Attack on high slippage.";
                    walletReport[index] = `W${index + 1}: 🔴 Jito Drop`;
                } else {
                    console.warn("⚠️ [JITO FALLBACK TRIGGERED] Sending standard transaction directly to the blockchain...");
                    try {
                        const directSig = await connection.sendRawTransaction(Buffer.from(swapTx.serialize()), { skipPreflight: true });
                        txSig = directSig;
                        await connection.sendRawTransaction(Buffer.from(tipTx.serialize()), { skipPreflight: true }).catch(() => null);
                        confirmed = await pollSignatureConfirmation(directSig);
                    } catch (e: any) {
                        lastError = `Direct Send Failed: ${e.message}`;
                    }
                }
            }

            if (confirmed) {
                if (!firstSignature) firstSignature = txSig;
                successCount++;
                
                try {
                    const parsedTx = await connection.getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (parsedTx?.meta && parsedTx.meta.preBalances[0] !== undefined && parsedTx.meta.postBalances[0] !== undefined) {
                        const preBalance = parsedTx.meta.preBalances[0] as number; 
                        const postBalance = parsedTx.meta.postBalances[0] as number;
                        const actualSolReceived = (postBalance - preBalance) / 1_000_000_000;
                        
                        if (actualSolReceived > 0) {
                            totalFeeBase += actualSolReceived;
                        } else {
                            totalFeeBase += dynamicFeeBase;
                        }
                    } else {
                        totalFeeBase += dynamicFeeBase;
                    }
                } catch (e) {
                    totalFeeBase += dynamicFeeBase;
                }
                
                walletReport[index] = `W${index + 1}: 🟢`;
            } else {
                walletReport[index] = `W${index + 1}: 🔴 Fail`;
            }
        });

        await Promise.allSettled(executionPromises);

        if (successCount === 0) {
            return { success: false, message: `🔴 <b>Exit Aborted:</b>\n<code>${lastError || "Transaction failed on-chain or expired."}</code>` };
        }

        const baseFeeRate = getDynamicFeeRate(user.totalVolumeSol, user.hasReferralDiscount);
        const effectiveFeeRate = await getEffectiveFeePercent(telegramId, baseFeeRate);

        const feeCharged = totalFeeBase * effectiveFeeRate;
        let affiliateCut = 0;
        if (user.referredById) {
            const dynamicRate = await getDynamicAffiliateRate(user.referredById);
            affiliateCut = feeCharged * dynamicRate;
        }

        // TASK 6 FIX: Compute Guild Owner 50% Revenue Share permanently on Sells
        let guildOwnerCut = 0;
        let guildOwnerId: string | null = null;
        try {
            const activeGuildMembership = await prisma.guildMembership.findFirst({
                where: { userId: user.id, isActive: true },
                include: { guild: true }
            });

            if (activeGuildMembership && activeGuildMembership.guild.ownerId) {
                guildOwnerId = activeGuildMembership.guild.ownerId;
                guildOwnerCut = feeCharged * 0.50; // 50% of the platform fee goes to the guild owner
            }
        } catch (_) {}

        let volumeToRecord = totalFeeBase; 
        try {
            const lastBuy = await prisma.trade.findFirst({
                where: { userId: user.id, tokenAddress: targetCA, isBuy: true },
                orderBy: { createdAt: 'desc' }
            });
            if (lastBuy) {
                volumeToRecord = lastBuy.amountInSol * (sellPercentage / 100);
            }
        } catch (_) {}

        const realizedPnlSol = totalFeeBase - volumeToRecord;
        const profitPercent = volumeToRecord > 0 ? (realizedPnlSol / volumeToRecord) * 100 : 0;

        await prisma.user.update({ where: { id: user.id }, data: { totalVolumeSol: { increment: volumeToRecord } } });
        
        // TASK 5 FIX: Award Guild Points guaranteed to run on every successful trade
        awardGuildPoints(user.telegramId, volumeToRecord).catch(() => {});
        
        if (user.referredById && affiliateCut > 0) {
            await prisma.user.update({ where: { id: user.referredById }, data: { pendingRewardsSol: { increment: affiliateCut } } });
        }

        // TASK 6 FIX: Deposit the 50% revenue share into the Guild Owner's withdrawable wallet
        if (guildOwnerId && guildOwnerCut > 0 && guildOwnerId !== user.referredById) {
            await prisma.user.update({ where: { id: guildOwnerId }, data: { pendingRewardsSol: { increment: guildOwnerCut } } });
        }

        await prisma.trade.create({
            data: {
                userId: user.id,
                tokenAddress: targetCA,
                isBuy: false,
                amountInSol: volumeToRecord,
                feeChargedSol: feeCharged,
                affiliateCutSol: affiliateCut,
                loyaltyRebateSol: 0,
                txSignature: firstSignature,
                status: 'CONFIRMED',
                profitPercent: parseFloat(profitPercent.toFixed(2)),
                realizedPnlSol: parseFloat(realizedPnlSol.toFixed(6))
            }
        }).catch(() => {});

        const breakdown = walletReport.filter(r => !r.includes("Empty")).join(" | ");
        const vipStatus = await getVipStatus(telegramId);
        const badgeStr = vipStatus.badge ? `${vipStatus.badge} ` : '';

        await redis.set(`recent_trade:${telegramId}`, '1', 'EX', 10);

        return {
            success: true,
            signature: firstSignature,
            message: `${badgeStr}🟢 Exit Successful (${sellPercentage}%).\nPnL: ${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%\n📊 <b>Breakdown:</b> ${breakdown}\n⚡ <i>Trade Executed Successfully</i>`
        };
    } catch (error: any) {
        return { success: false, message: `🔴 Error: ${error.message}` };
    }
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
    } catch {
        return 0.40;
    }
}

export async function generatePreSignedExitTx(telegramId: string, targetCA: string): Promise<string | null> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return null;

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
        
        const tipTx = await buildTipAndFeeTransaction(keypair, telegramId, 0.01, 'TURBO', 0.005, false, latestBlockhash.blockhash, user.hasReferralDiscount);
        if (!tipTx) return null;

        const payload = {
            swapBase64: Buffer.from(swapTx.serialize()).toString('base64'),
            tipBase64: Buffer.from(tipTx.serialize()).toString('base64')
        };
        
        return JSON.stringify(payload);
    } catch (e) {
        return null;
    }
}