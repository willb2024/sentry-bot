// src/services/token_launch.service.ts
import { Keypair, VersionedTransaction, SystemProgram, TransactionMessage, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import FormData from 'form-data';
import { prisma } from '../lib/prisma.js';
import { connection } from '../lib/connection.js';
import { decryptKey, ensureWalletsExist } from './vault.service.js';
import { isSimulationActive, generateSimTokenCA, generateSimSignature } from './simulation.service.js';
import { isDevnetActive, DEVNET_UNSUPPORTED_MSG } from '../lib/devnet.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

export const TOKEN_LAUNCH_PLATFORM_FEE_SOL = 0.04;

function safePublicKey(address: string | undefined | null): PublicKey | null {
    if (!address) return null;
    try {
        return new PublicKey(address);
    } catch {
        return null;
    }
}

// 🟢 EXPORT 1: Upload Token Logo to Pinata IPFS
export async function uploadImageToIpfs(imageBuffer: Buffer, filename: string): Promise<string | null> {
    try {
        const form = new FormData();
        form.append('file', imageBuffer, { filename, contentType: 'image/png' });
        
        const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${process.env.PINATA_JWT}`, 
                ...form.getHeaders() 
            },
            body: form as any
        });

        if (!response.ok) throw new Error(`Pinata image upload failed with status ${response.status}`);
        const data = await response.json() as any;
        return `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`;
    } catch (e: any) {
        console.error("🔴 [IPFS] Image Upload Error:", e.message);
        return null;
    }
}

// 🟢 EXPORT 2: Upload Token JSON Metadata to Pinata IPFS
export async function uploadMetadataToIpfs(
    name: string, 
    symbol: string, 
    description: string, 
    imageUrl: string
): Promise<string | null> {
    try {
        const metadata = { 
            name, 
            symbol, 
            description, 
            image: imageUrl, 
            showName: true,
            createdOn: 'https://t.me/SentryTerminalBot' 
        };
        
        const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${process.env.PINATA_JWT}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ pinataContent: metadata })
        });

        if (!response.ok) throw new Error(`Pinata metadata failed with status ${response.status}`);
        const data = await response.json() as any;
        return `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`;
    } catch (e: any) {
        console.error("🔴 [IPFS] Metadata Upload Error:", e.message);
        return null;
    }
}

// 🟢 EXPORT 3: Vanity Address Miner
export async function mineVanityKeypair(prefix: string, maxIterations = 50000): Promise<{ keypair: Keypair, matched: boolean }> {
    if (!prefix || prefix.toUpperCase() === 'NO') return { keypair: Keypair.generate(), matched: true };
    const search = prefix.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 4);
    if (search.length === 0) return { keypair: Keypair.generate(), matched: true };

    let keypair = Keypair.generate();
    let iterations = 0;

    return new Promise((resolve) => {
        function mineChunk() {
            for (let i = 0; i < 500; i++) {
                if (keypair.publicKey.toBase58().toLowerCase().startsWith(search)) {
                    return resolve({ keypair, matched: true });
                }
                keypair = Keypair.generate();
            }
            iterations += 500;
            if (iterations >= maxIterations) {
                return resolve({ keypair, matched: false }); 
            }
            setImmediate(mineChunk);
        }
        mineChunk();
    });
}

// 🟢 EXPORT 4: Launch Token on Pump.fun with Jito Block-0 Multi-Wallet Bundles
// src/services/token_launch.service.ts
export async function launchTokenOnPumpFun(
    telegramId: string, 
    name: string, 
    symbol: string, 
    description: string, 
    metadataUri: string, 
    devBuySol: number, 
    vanityPrefix: string, 
    walletCount: number,
    dex: 'pump' | 'raydium' = 'pump'
): Promise<{ success: boolean; tokenAddress?: string; signature?: string; message: string }> {
    try {
        // 1. Simulation Intercept
        if (await isSimulationActive(telegramId)) {
            const fakeMint = generateSimTokenCA();
            const fakeSig = generateSimSignature();
            
            if (devBuySol > 0) {
                const { simExecuteSnipe } = await import('./simulation.service.js');
                await simExecuteSnipe(telegramId, fakeMint, devBuySol, 'Token Launchpad', 85, 15, 50);
            }

            const simUser = await prisma.user.findUnique({ where: { telegramId } });
            if (simUser) {
                await prisma.launchedToken.create({
                    data: {
                        userId: simUser.id,
                        tokenAddress: fakeMint,
                        name,
                        symbol,
                        devBuySol,
                        walletCount,
                        isSimulated: true
                    }
                }).catch(() => {});
            }

            return { 
                success: true, 
                tokenAddress: fakeMint, 
                signature: fakeSig, 
                message: "🚀 Token launched successfully! (Simulation Sandbox — No real SOL spent)." 
            };
        }

        // 2. Devnet Intercept
        if (await isDevnetActive(telegramId)) {
            return { success: false, message: DEVNET_UNSUPPORTED_MSG };
        }

        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
            return { success: false, message: "No active vault found. Send /start to initialize." };
        }

        if (dex === 'raydium') {
            return {
                success: false,
                message: "🚧 Raydium token launches are currently in development. Please use Pump.fun launches."
            };
        }

        const treasuryWalletStr = process.env.TREASURY_WALLET_ADDRESS;
        if (!treasuryWalletStr) return { success: false, message: "TREASURY_WALLET_ADDRESS is missing in .env!" };

        const treasuryPubkey = safePublicKey(treasuryWalletStr.trim());
        if (!treasuryPubkey) {
            return { success: false, message: `Invalid treasury address configured: "${treasuryWalletStr}"` };
        }

        if (walletCount > 1) await ensureWalletsExist(telegramId, walletCount);
        
        const refreshedUser = await prisma.user.findUnique({ where: { telegramId } });
        if (!refreshedUser || !refreshedUser.turnkeySubOrgId) {
            return { success: false, message: "Failed to retrieve active wallet keys from vault." };
        }

        const wallets: Keypair[] = [];
        const rawW1 = decryptKey(refreshedUser.turnkeySubOrgId);
        if (!rawW1) return { success: false, message: "Failed to decrypt W1 key." };
        wallets.push(Keypair.fromSecretKey(bs58.decode(rawW1)));

        if (walletCount >= 2 && refreshedUser.pk2) { const pk = decryptKey(refreshedUser.pk2); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (walletCount >= 3 && refreshedUser.pk3) { const pk = decryptKey(refreshedUser.pk3); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (walletCount >= 4 && refreshedUser.pk4) { const pk = decryptKey(refreshedUser.pk4); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }
        if (walletCount >= 5 && refreshedUser.pk5) { const pk = decryptKey(refreshedUser.pk5); if (pk) wallets.push(Keypair.fromSecretKey(bs58.decode(pk))); }

        const vanityResult = await mineVanityKeypair(vanityPrefix);
        const mintKeypair = vanityResult.keypair;
        const tokenAddress = mintKeypair.publicKey.toBase58();
        
        const splitBuySol = devBuySol > 0 ? Number((devBuySol / wallets.length).toFixed(4)) : 0;
        const bundledTxs: string[] = [];

        let createRes;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                createRes = await fetch('https://pumpportal.fun/api/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'create',
                        tokenMetadata: { name, symbol, uri: metadataUri },
                        mint: bs58.encode(mintKeypair.secretKey),
                        denominatedInSol: true,
                        amount: splitBuySol,
                        slippage: 25,
                        priorityFee: 0.001,
                        pool: 'pump'
                    })
                });
                if (createRes.ok) break;
            } catch (e) {
                if (attempt === 3) return { success: false, message: "PumpPortal rejected token creation after 3 attempts." };
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!createRes || !createRes.ok) return { success: false, message: "PumpPortal rejected token creation." };
        const txData = await createRes.arrayBuffer();
        const launchTx = VersionedTransaction.deserialize(new Uint8Array(txData));
        launchTx.sign([mintKeypair, wallets[0]]);
        bundledTxs.push(Buffer.from(launchTx.serialize()).toString('base64'));

        if (splitBuySol > 0 && wallets.length > 1) {
            const extraBuys = await Promise.all(wallets.slice(1).map(async (wallet) => {
                const buyRes = await axios.post('https://pumpportal.fun/api/trade-local', {
                    publicKey: wallet.publicKey.toBase58(), 
                    action: 'buy', 
                    mint: tokenAddress,
                    denominatedInSol: true, 
                    amount: splitBuySol, 
                    slippage: 25, 
                    priorityFee: 0.0005, 
                    pool: 'pump'
                }, { responseType: 'arraybuffer' });
                const buyTx = VersionedTransaction.deserialize(new Uint8Array(buyRes.data));
                buyTx.sign([wallet]);
                return Buffer.from(buyTx.serialize()).toString('base64');
            }));
            bundledTxs.push(...extraBuys);
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const JITO_TIP_ACCOUNTS = [
            "96gYZGLnJYVFmbjzopPSU6QiCRK2UhdTEeqEMZouvHjL", 
            "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", 
            "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY"
        ];
        const jitoTipAccountStr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const jitoTipPubkey = safePublicKey(jitoTipAccountStr);
        if (!jitoTipPubkey) return { success: false, message: "Invalid Jito Tip Account reference." };

        const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',');
        const isAdmin = ADMIN_IDS.includes(telegramId);
        const feeLamports = isAdmin ? 0 : Math.floor(TOKEN_LAUNCH_PLATFORM_FEE_SOL * 1_000_000_000);
        const jitoTipLamports = 3_000_000;

        const instructions = [];
        if (!isAdmin && feeLamports > 0) {
            instructions.push(SystemProgram.transfer({ fromPubkey: wallets[0].publicKey, toPubkey: treasuryPubkey, lamports: feeLamports }));
        }
        instructions.push(SystemProgram.transfer({ fromPubkey: wallets[0].publicKey, toPubkey: jitoTipPubkey, lamports: jitoTipLamports }));

        const feeTx = new VersionedTransaction(new TransactionMessage({
            payerKey: wallets[0].publicKey, recentBlockhash: blockhash, instructions
        }).compileToV0Message());
        feeTx.sign([wallets[0]]);
        bundledTxs.push(Buffer.from(feeTx.serialize()).toString('base64'));

        const jitoRes = await axios.post(`https://mainnet.block-engine.jito.wtf/api/v1/bundles`, {
            jsonrpc: "2.0", id: 1, method: "sendBundle", params: [bundledTxs]
        });

        if (jitoRes.data?.error) return { success: false, message: `Jito Bundle Rejected: ${JSON.stringify(jitoRes.data.error)}` };

        const signature = bs58.encode(launchTx.signatures[0]);
        let isConfirmed = false;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) { isConfirmed = true; break; }
        }

        if (!isConfirmed) return { success: false, message: "Network congestion. Jito validator did not land the bundle." };

        // Record launched token row in PostgreSQL
        await prisma.launchedToken.create({
            data: {
                userId: user.id,
                tokenAddress,
                name,
                symbol,
                devBuySol,
                walletCount,
                isSimulated: false
            }
        }).catch(() => {});

        let returnMsg = "Token launched successfully!";
        if (!vanityResult.matched) returnMsg = "Token launched! (Vanity prefix timed out, random address used).";

        return { success: true, tokenAddress, signature, message: returnMsg };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}