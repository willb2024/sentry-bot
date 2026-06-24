// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export function getBondingCurveAddress(tokenMint: string): string {
    const mintPubKey = new PublicKey(tokenMint);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubKey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return pda.toBase58();
}

export function decodePumpCurvePrice(base64Data: string): number {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length < 40) return 0;

        const virtualTokenReserves = buffer.readBigUInt64LE(8);
        const virtualSolReserves = buffer.readBigUInt64LE(16);
        
        const solAmount = Number(virtualSolReserves) / 1_000_000_000; 
        const tokenAmount = Number(virtualTokenReserves) / 1_000_000; 
        
        if (tokenAmount === 0) return 0;
        
        return solAmount / tokenAmount; 
    } catch (e: any) {
        console.error("⚠️ [PRICE SERVICE] Failed to decode pump curve price:", e.message);
        return 0;
    }
}

export async function checkRecentMevActivity(tokenMint: string): Promise<boolean> {
    try {
        const pubkey = new PublicKey(tokenMint);
        const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 10 });
        const txs = await connection.getParsedTransactions(
            sigs.map((s: any) => s.signature),
            { maxSupportedTransactionVersion: 0 }
        );

        const buyerMap: Record<string, number[]> = {};

        txs.forEach((tx: any, blockIdx: number) => {
            if (!tx || tx.meta?.err) return;
            const buyer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58();
            if (!buyer) return;
            if (!buyerMap[buyer]) buyerMap[buyer] = [];
            buyerMap[buyer].push(blockIdx);
        });

        for (const slots of Object.values(buyerMap)) {
            if (slots.length >= 2 && slots[slots.length - 1] - slots[0] <= 2) {
                return true;
            }
        }
        return false;
    } catch (e: any) {
        console.error("⚠️ [PRICE SERVICE] MEV activity check exception:", e.message);
        return false; 
    }
}