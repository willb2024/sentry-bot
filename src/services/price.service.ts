// src/services/price.service.ts
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import axios from 'axios';

const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export function getBondingCurveAddress(tokenMint: string): string {
    const mintPubKey = new PublicKey(tokenMint);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubKey.toBuffer()],
        PUMP_FUN_PROGRAM_ID
    );
    return pda.toBase58();
}

export function decodePumpCurvePrice(base64Data: string, tokenDecimals: number = 6): number {
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length < 40) return 0;

        const virtualTokenReserves = buffer.readBigUInt64LE(8);
        const virtualSolReserves = buffer.readBigUInt64LE(16);
        
        const solAmount = Number(virtualSolReserves) / 1_000_000_000; 
        const divisor = Math.pow(10, tokenDecimals);
        const tokenAmount = Number(virtualTokenReserves) / divisor; 
        
        if (tokenAmount === 0) return 0;
        
        return solAmount / tokenAmount; 
    } catch (e: any) {
        console.error("⚠️ [PRICE SERVICE] Failed to decode pump curve price:", e.message);
        return 0;
    }
}

// 🟢 NEW ZERO-RPC REPLACEMENT: Queries RugCheck's free API instead of heavy on-chain logs.
// This completely stops Helius getParsedTransactions rate-limit blocks (429/413) permanently.
export async function checkTokenRugRisk(tokenMint: string): Promise<boolean> {
    try {
        const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`, { timeout: 2000 });
        const data = res.data;
        // Scores above 1000 or active freeze authorities are flagged as high risk
        if (data && (data.score > 1000 || (data.risks && data.risks.some((r: any) => r.name === 'Freeze Authority still enabled')))) {
            return true; // Rug / High Risk detected
        }
        return false;
    } catch (e: any) {
        // Fail open if RugCheck API is down so it doesn't freeze the scraper
        return false; 
    }
}