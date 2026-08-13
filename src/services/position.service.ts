// src/services/position.service.ts
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { prisma } from '../lib/prisma.js';
import dotenv from 'dotenv';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';
import { rpcLimiter } from '../lib/rpc-limiter.js';
import { getTokenMetadata } from './price.service.js';

dotenv.config();

export async function getUserPositions(telegramId: string) {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress) return null;

        const cacheKey = `positions_cache:${telegramId}`;
        const cachedPositions = await redis.get(cacheKey);
        if (cachedPositions) {
            return JSON.parse(cachedPositions);
        }

        const activePubkeys: PublicKey[] = [];
        if (user.vaultAddress) activePubkeys.push(new PublicKey(user.vaultAddress));
        if (user.activeWallets >= 2 && user.vault2) activePubkeys.push(new PublicKey(user.vault2));
        if (user.activeWallets >= 3 && user.vault3) activePubkeys.push(new PublicKey(user.vault3));
        if (user.activeWallets >= 4 && user.vault4) activePubkeys.push(new PublicKey(user.vault4));
        if (user.activeWallets >= 5 && user.vault5) activePubkeys.push(new PublicKey(user.vault5));

        const aggregatedPositions: Record<string, { mint: string, amount: number, decimals: number }> = {};

        await Promise.all(activePubkeys.map(async (pubKey) => {
            try {
                const [splAccounts, token2022Accounts] = await Promise.all([
                    rpcLimiter.run(() => 
                        connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed')
                    ),
                    rpcLimiter.run(() => 
                        connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed')
                    )
                ]);

                const allAccounts = [...splAccounts.value, ...token2022Accounts.value];

                allAccounts.forEach(account => {
                    const info = account.account.data.parsed.info;
                    const amt = info.tokenAmount.uiAmount;
                    if (amt > 0) {
                        if (aggregatedPositions[info.mint]) {
                            aggregatedPositions[info.mint].amount += amt; 
                        } else {
                            aggregatedPositions[info.mint] = { mint: info.mint, amount: amt, decimals: info.tokenAmount.decimals };
                        }
                    }
                });
            } catch (e: any) {
                console.warn(`⚠️ [POSITIONS] Failed to fetch accounts for ${pubKey.toBase58()}: ${e.message}`);
            }
        }));

        let rawPositions = Object.values(aggregatedPositions);
        if (rawPositions.length === 0) return [];

        const uniqueMints = rawPositions.map(p => p.mint);
        
        // Use metadata cache
        const metadataResults = await Promise.all(uniqueMints.map(mint => getTokenMetadata(mint)));
        
        const tokenMetadata: Record<string, any> = {};
        uniqueMints.forEach((mint, index) => {
            tokenMetadata[mint] = metadataResults[index];
        });

        const mappedPositions = rawPositions.map(p => {
            const meta = tokenMetadata[p.mint] || { priceUsd: 0, symbol: "UNKNOWN", name: "Unknown Token" };
            return {
                ...p,
                symbol: meta.symbol,
                name: meta.name,
                priceUsd: meta.priceUsd,
                valueUsd: p.amount * meta.priceUsd
            };
        })
        .filter(p => p.valueUsd >= 0.01 || p.priceUsd === 0) 
        .sort((a, b) => b.valueUsd - a.valueUsd);
          
        await redis.set(cacheKey, JSON.stringify(mappedPositions), 'EX', 30);
        return mappedPositions;

    } catch (e: any) {
        console.error("🔴 [POSITIONS] Aggregation error:", e.message);
        return null;
    }
}