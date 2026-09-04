// src/services/raydium.service.ts
import { PublicKey, VersionedTransaction, Keypair } from '@solana/web3.js';
import { Raydium, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { connection } from '../lib/connection.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
// @ts-ignore
import BN from 'bn.js';

dotenv.config();

const sdkCache = new Map<string, Raydium>();
const poolCache = new Map<string, { data: any; exp: number }>();

async function getRaydiumSdk(ownerKeypair: Keypair): Promise<Raydium> {
    const key = ownerKeypair.publicKey.toBase58();
    if (sdkCache.has(key)) return sdkCache.get(key)!;

    const sdk = await Raydium.load({
        owner: ownerKeypair,
        connection: connection,
        disableFeatureCheck: true,
        blockhashCommitment: 'confirmed',
    });
    
    sdkCache.set(key, sdk);
    setTimeout(() => sdkCache.delete(key), 120_000);
    return sdk;
}

async function getCachedPoolInfo(raydium: Raydium, poolId: string) {
    const hit = poolCache.get(poolId);
    if (hit && hit.exp > Date.now()) return hit.data;

    const data = await raydium.liquidity.getPoolInfoFromRpc({ poolId }).catch(() => null);
    if (data) {
        poolCache.set(poolId, { data, exp: Date.now() + 30_000 }); // 30s cache
    }
    return data;
}

export async function buildDirectRaydiumSwap(
    ownerKeypair: Keypair,
    poolId: string,
    inputMint: string,
    amountIn: number,
    slippageBps: number = 2000  
): Promise<Buffer | null> {
    try {
        const raydium = await getRaydiumSdk(ownerKeypair);
        const poolInfo = await getCachedPoolInfo(raydium, poolId);

        if (!poolInfo) {
            console.warn(`[RAYDIUM DIRECT] Pool ${poolId} not found on-chain.`);
            return null;
        }

        const amountInBn = new BN(Math.floor(amountIn));
        let minAmountOut = new BN(1);

        // Derive minimum out using pool reserves and user slippage tolerance
        try {
            const computeRes = await (raydium.liquidity as any).computeAmountOut({
                poolInfo: poolInfo.poolInfo,
                amountIn: amountInBn,
                inputMint,
                slippage: slippageBps / 10000
            });
            if (computeRes?.minAmountOut && !computeRes.minAmountOut.isZero()) {
                minAmountOut = computeRes.minAmountOut;
            }
        } catch (_) {
            // Fail closed if pool output calculation fails
            console.warn('[RAYDIUM DIRECT] Could not compute minAmountOut — failing closed to prevent sandwich attack.');
            return null;
        }

        const { transaction } = await raydium.liquidity.swap({
            poolInfo: poolInfo.poolInfo,
            poolKeys: poolInfo.poolKeys,
            amountIn: amountInBn,
            amountOut: minAmountOut, // Real price floor
            fixedSide: 'in',
            inputMint: inputMint,
            txVersion: TxVersion.V0,
            computeBudgetConfig: {
                microLamports: 1_000_000, 
                units: 300_000
            }
        });

        return Buffer.from(transaction.serialize());
    } catch (e: any) {
        console.error('🔴 [RAYDIUM DIRECT] Swap building failed:', e.message);
        return null;
    }
}

export async function extractPoolIdFromTx(signature: string): Promise<string | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx?.transaction?.message?.accountKeys) return null;

        const keys = tx.transaction.message.accountKeys;
        if (keys.length > 4) {
            return keys[4].pubkey.toBase58();
        }
        return null;
    } catch (e: any) {
        console.error('⚠️ [RAYDIUM DIRECT] Failed to extract pool ID from signature:', e.message);
        return null;
    }
}