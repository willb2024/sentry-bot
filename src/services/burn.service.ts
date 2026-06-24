// src/services/burn.service.ts
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { connection } from '../lib/connection.js'; 
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';
import bs58 from 'bs58';
import { decryptKey } from './vault.service.js';
import dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();

const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiCRK2UhdTEeqEMZouvHjL", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY"
];

export async function getEmptyTokenAccounts(walletAddress: string): Promise<Array<{ mint: string, pubkey: string, programId: string }>> {
    const WSOL_MINT = "So11111111111111111111111111111111111111112"; 

    try {
        const pubKey = new PublicKey(walletAddress);
        const [splAccounts, token2022Accounts] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
            connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed')
        ]);

        const allAccounts = [...splAccounts.value, ...token2022Accounts.value];
        const emptyAccounts: Array<{ mint: string, pubkey: string, programId: string }> = [];

        allAccounts.forEach(account => {
            const info = account.account.data.parsed.info;
            const amount = info.tokenAmount.uiAmount;

            if (amount === 0 && info.mint !== WSOL_MINT) {
                emptyAccounts.push({
                    mint: info.mint,
                    pubkey: account.pubkey.toBase58(),
                    programId: account.account.owner.toBase58()
                });
            }
        });

        return emptyAccounts;
    } catch (e) {
        return [];
    }
}

export async function executeRentSweep(telegramId: string): Promise<{ success: boolean, reclaimedSol: number, signature?: string, message: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, reclaimedSol: 0, message: "No active Vault found." };

        const emptyAccounts = await getEmptyTokenAccounts(user.vaultAddress);
        if (emptyAccounts.length === 0) return { success: false, reclaimedSol: 0, message: "No empty token accounts found to reclaim." };

        const targets = emptyAccounts.slice(0, 18);
        const vaultPubkey = new PublicKey(user.vaultAddress);
        const instructions = [];

        for (const target of targets) {
            instructions.push(
                createCloseAccountInstruction(
                    new PublicKey(target.pubkey),
                    vaultPubkey,
                    vaultPubkey,
                    [],
                    new PublicKey(target.programId)
                )
            );
        }

        const jitoTipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        const TIP_LAMPORTS = 500000; // 0.0005 SOL Jito Tip
        
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: vaultPubkey,
                toPubkey: new PublicKey(jitoTipAccount),
                lamports: TIP_LAMPORTS
            })
        );

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: vaultPubkey,
            recentBlockhash: blockhash,
            instructions
        }).compileToV0Message();

        const vTx = new VersionedTransaction(messageV0);
        const rawPk = decryptKey(user.turnkeySubOrgId);
        if (!rawPk) return { success: false, reclaimedSol: 0, message: "Decryption Fault." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));
        vTx.sign([keypair]);

        const txBuffer = Buffer.from(vTx.serialize());
        const signature = bs58.encode(vTx.signatures[0]);

        let jitoSuccess = false;
        try {
            const jitoRes = await fetch(`https://mainnet.block-engine.jito.wtf/api/v1/transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 1, method: "sendTransaction", 
                    params: [txBuffer.toString('base64'), { encoding: "base64" }]
                })
            });
            if (jitoRes.ok) jitoSuccess = true;
        } catch (e) {
            console.warn("⚠️ [RENT SWEEP] Jito API timeout.");
        }

        if (!jitoSuccess) {
            console.warn("⚠️ [RENT SWEEP] Jito routing rejected. Falling back to public RPC...");
            try {
                await connection.sendRawTransaction(txBuffer, { skipPreflight: true });
            } catch (e: any) {
                return { success: false, reclaimedSol: 0, message: `Public RPC Fallback failed: ${e.message}` };
            }
        }

        let isConfirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) {
                isConfirmed = true;
                break;
            }
        }

        if (!isConfirmed) return { success: false, reclaimedSol: 0, message: "Network dropped the sweep transaction." };

        // 🟢 MEDIUM BUG 15 FIX: Mathematically decouple the gross rent returns from the priority tip.
        const RENT_PER_ACCOUNT_LAMPORTS = 2039280;
        const grossReclaimedSol = (targets.length * RENT_PER_ACCOUNT_LAMPORTS) / 1_000_000_000;
        const jitoTipSol = TIP_LAMPORTS / 1_000_000_000;
        const netReclaimedSol = Math.max(0, grossReclaimedSol - jitoTipSol);

        return {
            success: true, 
            reclaimedSol: netReclaimedSol, 
            signature,
            message: `🧹 Swept ${targets.length} empty accounts.\n\n💰 <b>Gross Reclaimed:</b> +${grossReclaimedSol.toFixed(4)} SOL\n⛽ <b>Jito Validator Tip:</b> -${jitoTipSol.toFixed(4)} SOL\n💳 <b>Net Reclaimed:</b> +${netReclaimedSol.toFixed(4)} SOL!`
        };

    } catch (e: any) {
        return { success: false, reclaimedSol: 0, message: e.message };
    }
}