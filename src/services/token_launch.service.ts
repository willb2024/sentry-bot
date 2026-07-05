// src/services/token_launch.service.ts
import { Keypair, VersionedTransaction, SystemProgram, TransactionMessage, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
// @ts-ignore
import fetch from 'node-fetch';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { connection } from '../lib/connection.js';
import { decryptKey, ensureWalletsExist } from './vault.service.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const prisma = new PrismaClient();

export const TOKEN_LAUNCH_PLATFORM_FEE_SOL = 0.05;

// 1. IPFS Uploads (Pinata)
export async function uploadImageToIpfs(imageBuffer: Buffer, filename: string): Promise<string | null> {
    try {
        const form = new FormData();
        form.append('file', imageBuffer, { filename, contentType: 'image/png' });
        const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.PINATA_JWT}`, ...form.getHeaders() },
            body: form
        });
        if (!res.ok) throw new Error(`Pinata upload failed: ${res.statusText}`);
        const data = await res.json() as any;
        return `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`;
    } catch (e: any) {
        console.error("🔴 [IPFS] Image Upload Error:", e.message);
        return null;
    }
}

export async function uploadMetadataToIpfs(name: string, symbol: string, description: string, imageUrl: string): Promise<string | null> {
    try {
        const metadata = { name, symbol, description, image: imageUrl, createdOn: 'https://t.me/SentryTerminalBot' };
        const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.PINATA_JWT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinataContent: metadata })
        });
        if (!res.ok) throw new Error(`Pinata metadata failed: ${res.statusText}`);
        const data = await res.json() as any;
        return `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`;
    } catch (e: any) {
        console.error("🔴 [IPFS] Metadata Upload Error:", e.message);
        return null;
    }
}

// 2. Vanity CA Miner
export function mineVanityKeypair(prefix: string): Keypair {
    if (!prefix || prefix.toUpperCase() === 'NO') return Keypair.generate();
    
    const search = prefix.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 4);
    if (search.length === 0) return Keypair.generate();

    let keypair = Keypair.generate();
    // Cap at 1,000,000 iterations to prevent blocking the bot
    for (let i = 0; i < 1000000; i++) {
        if (keypair.publicKey.toBase58().toLowerCase().startsWith(search)) {
            return keypair;
        }
        keypair = Keypair.generate();
    }
    return keypair;
}

// 3. Multi-Wallet Jito Bundle Launcher
export async function launchTokenOnPumpFun(
    telegramId: string, name: string, symbol: string, description: string, metadataUri: string, 
    devBuySol: number, vanityPrefix: string, walletCount: number
): Promise<{ success: boolean; tokenAddress?: string; signature?: string; message: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "No active vault found." };

        const treasuryWalletStr = process.env.TREASURY_WALLET_ADDRESS;
        if (!treasuryWalletStr) return { success: false, message: "Platform treasury not configured." };

        if (walletCount > 1) await ensureWalletsExist(telegramId, walletCount);
        const refreshedUser = await prisma.user.findUnique({ where: { telegramId } });

        const wallets: Keypair[] = [];
        const rawW1 = decryptKey(refreshedUser!.turnkeySubOrgId!);
        wallets.push(Keypair.fromSecretKey(bs58.decode(rawW1!)));

        if (walletCount >= 2 && refreshedUser?.pk2) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(refreshedUser.pk2)!)));
        if (walletCount >= 3 && refreshedUser?.pk3) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(refreshedUser.pk3)!)));
        if (walletCount >= 4 && refreshedUser?.pk4) wallets.push(Keypair.fromSecretKey(bs58.decode(decryptKey(refreshedUser.pk4)!)));

        const mintKeypair = mineVanityKeypair(vanityPrefix);
        const mintAddress = mintKeypair.publicKey.toBase58();

        const splitDevBuy = devBuySol > 0 ? Number((devBuySol / wallets.length).toFixed(4)) : 0;
        const bundledTxs: string[] = [];

        // Transaction 1: Create Token + Buy from W1
        const pumpRes = await axios.post('https://pumpportal.fun/api/create', {
            action: 'create',
            tokenMetadata: { name, symbol, uri: metadataUri },
            mint: bs58.encode(mintKeypair.secretKey),
            denominatedInSol: 'true',
            amount: splitDevBuy,
            slippage: 25,
            priorityFee: 0.001,
            pool: 'pump'
        }, { responseType: 'arraybuffer' });

        const launchTx = VersionedTransaction.deserialize(new Uint8Array(pumpRes.data));
        launchTx.sign([mintKeypair, wallets[0]]);
        bundledTxs.push(Buffer.from(launchTx.serialize()).toString('base64'));

        // Transactions 2-4: Stealth buys from W2, W3, W4
        if (splitDevBuy > 0 && wallets.length > 1) {
            const extraBuys = await Promise.all(wallets.slice(1).map(async (wallet) => {
                const buyRes = await axios.post('https://pumpportal.fun/api/trade-local', {
                    publicKey: wallet.publicKey.toBase58(),
                    action: 'buy',
                    mint: mintAddress,
                    denominatedInSol: 'true',
                    amount: splitDevBuy,
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

        // Final Transaction: Sentry Platform Fee + Jito MEV Tip
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const JITO_TIP_ACCOUNTS = ["96gYZGLnJYVFmbjzopPSU6QiCRK2UhdTEeqEMZouvHjL", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY"];
        const jitoTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

        // 🟢 ADMIN BACKDOOR CHECK
        const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM_ID || '').split(',');
        const isAdmin = ADMIN_IDS.includes(telegramId);

        const feeLamports = isAdmin ? 0 : Math.floor(TOKEN_LAUNCH_PLATFORM_FEE_SOL * 1_000_000_000);
        const jitoTipLamports = 3_000_000; 

        const instructions = [];
        if (!isAdmin) {
            instructions.push(SystemProgram.transfer({ fromPubkey: wallets[0].publicKey, toPubkey: new PublicKey(treasuryWalletStr), lamports: feeLamports }));
        }
        instructions.push(SystemProgram.transfer({ fromPubkey: wallets[0].publicKey, toPubkey: new PublicKey(jitoTipAccount), lamports: jitoTipLamports }));

        const feeTx = new VersionedTransaction(new TransactionMessage({
            payerKey: wallets[0].publicKey, recentBlockhash: blockhash, instructions
        }).compileToV0Message());
        feeTx.sign([wallets[0]]);
        bundledTxs.push(Buffer.from(feeTx.serialize()).toString('base64'));

        // Send to Jito
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

        return { success: true, tokenAddress: mintAddress, signature, message: "Token launched successfully!" };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}