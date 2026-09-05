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
let raydiumComputeVerified = false;

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

async function verifyComputeAmountOutShape(raydium: Raydium, poolId: string): Promise<void> {
    if (raydiumComputeVerified) return;
    try {
        const poolInfo = await getCachedPoolInfo(raydium, poolId);
        if (!poolInfo) return;
        
        const probe = await (raydium.liquidity as any).computeAmountOut({
            poolInfo: poolInfo.poolInfo,
            amountIn: new BN(1_000_000),
            inputMint: poolInfo.poolInfo?.mintA?.address,
            slippage: 0.2,
        }).catch(() => null);

        if (probe?.minAmountOut && typeof probe.minAmountOut.isZero === 'function') {
            raydiumComputeVerified = true;
            console.log('🟢 [RAYDIUM] computeAmountOut verified for installed SDK.');
        } else {
            console.error('🔴 [RAYDIUM] computeAmountOut returned an unexpected shape — swaps will FAIL CLOSED.');
        }
    } catch (e: any) {
        console.error('🔴 [RAYDIUM] computeAmountOut probe error:', e.message);
    }
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
        await verifyComputeAmountOutShape(raydium, poolId);
        const poolInfo = await getCachedPoolInfo(raydium, poolId);

        if (!poolInfo) {
            console.warn(`[RAYDIUM DIRECT] Pool ${poolId} not found on-chain.`);
            return null;
        }

        const amountInBn = new BN(Math.floor(amountIn));
        let minAmountOut = new BN(1);

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
            console.warn('[RAYDIUM DIRECT] Could not compute minAmountOut — failing closed to prevent sandwich attack.');
            return null;
        }

        const { transaction } = await raydium.liquidity.swap({
            poolInfo: poolInfo.poolInfo,
            poolKeys: poolInfo.poolKeys,
            amountIn: amountInBn,
            amountOut: minAmountOut, // Minimum output floor
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

// src/services/raydium.service.ts

export async function extractPoolIdFromTx(signature: string): Promise<string | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx?.transaction?.message) return null;

        const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
        const msg: any = tx.transaction.message;
        const instrs = [
            ...(msg.instructions || []),
            ...((tx.meta?.innerInstructions || []).flatMap((i: any) => i.instructions)),
        ];

        // Locate initialize2 on the AMM program
        for (const ix of instrs) {
            const prog = ix.programId?.toBase58?.() ?? ix.programId;
            if (prog !== RAYDIUM_AMM) continue;

            const accts: string[] = (ix.accounts || []).map((a: any) => a.toBase58?.() ?? a);
            // Account index 4 within the instruction's own accounts is the AMM Pool ID
            if (accts.length > 4) {
                return accts[4];
            }
        }
        return null;
    } catch (e: any) {
        console.error('⚠️ [RAYDIUM] extractPoolIdFromTx failed:', e.message);
        return null;
    }
}