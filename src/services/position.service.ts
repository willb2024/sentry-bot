// src/services/position.service.ts
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { connection } from '../lib/connection.js'; 
import { redis } from '../lib/redis.js';

dotenv.config();
const prisma = new PrismaClient();

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
                    connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
                    connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed')
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
        let tokenMetadata: Record<string, { price: number, symbol: string, name: string }> = {};

        // 🟢 FIX: Parallel chunk fetching for massive speed boost
        const chunks: string[] = [];
        for (let i = 0; i < uniqueMints.length; i += 30) chunks.push(uniqueMints.slice(i, i + 30).join(','));

        await Promise.all(chunks.map(async (chunk) => {
            try {
                const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`, { signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                    const data = (await res.json()) as any;
                    (data.pairs || []).forEach((pair: any) => {
                        const baseAddress = pair.baseToken.address;
                        if (!tokenMetadata[baseAddress]) {
                            tokenMetadata[baseAddress] = {
                                price: parseFloat(pair.priceUsd || "0"),
                                symbol: pair.baseToken.symbol || "UNKNOWN",
                                name: pair.baseToken.name || "Unknown Token"
                            };
                        }
                    });
                }
            } catch (e) {
                console.warn("⚠️ [POSITIONS] DexScreener chunk fetch timeout.");
            }
        }));

        const mappedPositions = rawPositions.map(p => {
            const meta = tokenMetadata[p.mint] || { price: 0, symbol: "UNKNOWN", name: "Unknown Token" };
            return {
                ...p,
                symbol: meta.symbol,
                name: meta.name,
                priceUsd: meta.price,
                valueUsd: p.amount * meta.price
            };
        })// 🟢 PART 3.9 FIX: Keep tokens even if DexScreener times out (valueUsd = 0)
          .filter(p => p.valueUsd >= 0.01 || p.priceUsd === 0) 
          .sort((a, b) => b.valueUsd - a.valueUsd);
          

        await redis.set(cacheKey, JSON.stringify(mappedPositions), 'EX', 15);

        return mappedPositions;

    } catch (e: any) {
        console.error("🔴 [POSITIONS] Aggregation error:", e.message);
        return null;
    }
}