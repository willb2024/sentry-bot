// src/services/guild.service.ts
import { PrismaClient } from '@prisma/client';
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { decryptKey } from './vault.service.js';
import { redis } from '../lib/redis.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();
const GUILD_WORDS = ['ALPHA', 'SIGMA', 'APEX', 'NOVA', 'NEXUS', 'OMEGA', 'TITAN', 'VANGUARD', 'ECLIPSE', 'ZENITH'];



export async function joinGuild(telegramId: string, guildCode: string): Promise<{ success: boolean; message: string; guildName?: string; rewardDescription?: string | null }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };
        const guild = await prisma.guild.findUnique({ where: { guildCode: guildCode.toUpperCase() } });
        if (!guild || !guild.isActive) return { success: false, message: "Guild not found or inactive." };

        await prisma.guildMembership.create({ data: { guildId: guild.id, userId: user.id } });
        await redis.set(`guild_member:${guild.id}:${user.id}`, "1");
        return { success: true, message: "Joined successfully.", guildName: guild.name, rewardDescription: guild.rewardDescription };
    } catch (e: any) {
        if (e.code === 'P2002') return { success: false, message: "You are already a member of this Guild." };
        return { success: false, message: "Error joining guild." };
    }
}
export async function createGuild(
    telegramId: string, name: string, description: string | null, rewardDescription: string | null
): Promise<{ success: boolean; message: string; guildCode?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { ownedGuild: true } });
        if (!user || !user.vaultAddress) return { success: false, message: "No active vault found." };
        if (user.ownedGuild) return { success: false, message: "You already own a Guild." };

        // 🟢 FIX A2: Guild creation is now genuinely free. No Dev Suite required, no SOL transferred.
        const randomWord = GUILD_WORDS[Math.floor(Math.random() * GUILD_WORDS.length)];
        const randomTwoDigit = Math.floor(10 + Math.random() * 90);
        const guildCode = `GUILD-${randomWord}-${randomTwoDigit}`;

        await prisma.guild.create({
            data: { ownerId: user.id, guildCode, name, description, rewardDescription, feePaidSol: 0 }
        });

        return { success: true, message: "Guild successfully established.", guildCode };
    } catch (e: any) { return { success: false, message: e.message }; }
}

export async function getLeaderboard(guildId: string, limit: number = 50) {
    try {
        let rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, limit - 1, 'WITHSCORES');
        
        // 🟢 FIX C6: DB Fallback if Redis is flushed
        if (rawLb.length === 0) {
            const members = await prisma.guildMembership.findMany({ where: { guildId, isActive: true } });
            if (members.length === 0) return [];
            const multi = redis.multi();
            for (const m of members) multi.zadd(`guild_lb:${guildId}`, m.loyaltyPoints, m.userId);
            await multi.exec();
            rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, limit - 1, 'WITHSCORES');
        }

        // 🟢 FIX G3: Eliminate N+1 Query. Fetch all users in one batch.
        const userIds = [];
        const scoreMap: Record<string, number> = {};
        for (let i = 0; i < rawLb.length; i += 2) {
            userIds.push(rawLb[i]);
            scoreMap[rawLb[i]] = parseFloat(rawLb[i + 1]);
        }

        const memberships = await prisma.guildMembership.findMany({
            where: { guildId, userId: { in: userIds } },
            include: { user: true }
        });

        const memberMap = new Map(memberships.map(m => [m.userId, m]));
        return userIds.map((userId, index) => {
            const memberInfo = memberMap.get(userId);
            if (!memberInfo) return null;
            return {
                rank: index + 1, membershipId: memberInfo.id, telegramId: memberInfo.user.telegramId,
                username: memberInfo.user.username || memberInfo.user.telegramId,
                walletAddress: memberInfo.user.vaultAddress || "Unknown", glp: scoreMap[userId],
                volumeSol: memberInfo.totalVolumeSol, airdropsReceived: memberInfo.airdropsReceivedSol || 0 
            };
        }).filter(Boolean);
    } catch (e) { return []; }
}

export async function awardGuildPoints(telegramId: string, volumeSol: number): Promise<void> {
    if (volumeSol <= 0) return;
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return;
        
        const memberships = await prisma.guildMembership.findMany({ where: { userId: user.id, isActive: true } });
        if (memberships.length === 0) return;
        
        const points = volumeSol / 0.1;
        // 🟢 FIX G2: Parallelize DB and Redis updates instead of sequential await
        await Promise.all(memberships.map(async (membership) => {
            await prisma.guildMembership.update({
                where: { id: membership.id },
                data: { loyaltyPoints: { increment: points }, totalVolumeSol: { increment: volumeSol }, lastActiveAt: new Date() }
            });
            await redis.zincrby(`guild_lb:${membership.guildId}`, points, user.id);
        }));
    } catch (e) {}
}


export async function exportLeaderboard(telegramId: string, guildId: string): Promise<string | null> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return null;
        const lb = await getLeaderboard(guildId, 500);
        let csv = `rank,telegram_username,wallet_address,glp,volume_sol\n`;
        lb.forEach(row => { if (row) csv += `${row.rank},@${row.username},${row.walletAddress},${row.glp.toFixed(2)},${row.volumeSol.toFixed(4)}\n`; });
        return csv;
    } catch (e) { return null; }
}

export async function updateRankCache(guildId: string) {
    try {
        const rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, -1);
        for (let i = 0; i < rawLb.length; i++) {
            await prisma.guildMembership.update({
                where: { guildId_userId: { guildId, userId: rawLb[i] } }, data: { rank: i + 1 }
            }).catch(() => {});
        }
    } catch (e) {}
}

// =========================================================
// 🟢 P0 FIX #2: MISSING GUILD FUNCTIONS FULLY IMPLEMENTED
// =========================================================

// SWITCH ACTIVE GUILD
export async function switchActiveGuild(
    telegramId: string,
    membershipId: string
): Promise<{ success: boolean; message: string; guildName?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const targetMembership = await prisma.guildMembership.findUnique({
            where: { id: membershipId },
            include: { guild: true }
        });
        if (!targetMembership || targetMembership.userId !== user.id) {
            return { success: false, message: "Membership not found or does not belong to you." };
        }

        await prisma.$transaction([
            prisma.guildMembership.updateMany({
                where: { userId: user.id },
                data: { isActive: false }
            }),
            prisma.guildMembership.update({
                where: { id: membershipId },
                data: { isActive: true, lastActiveAt: new Date() }
            })
        ]);

        return { success: true, message: "Active guild switched.", guildName: targetMembership.guild.name };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

// SHARED HELPER: Build + send multi-recipient SOL payout from the guild owner's W1
async function sendGuildPayout(
    telegramId: string,
    recipients: Array<{ pubkey: string; lamports: number }>
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) {
            return { success: false, message: "No active vault found." };
        }

        const validRecipients = recipients.filter(r => r.lamports > 0);
        if (validRecipients.length === 0) {
            return { success: false, message: "No valid recipients with a positive payout amount." };
        }

        const totalLamports = validRecipients.reduce((sum, r) => sum + r.lamports, 0);
        const vaultPubkey = new PublicKey(user.vaultAddress);
        const balance = await connection.getBalance(vaultPubkey);

        if (balance < totalLamports + 50000) {
            return { success: false, message: `Insufficient Funds: You need ${((totalLamports + 50000) / LAMPORTS_PER_SOL).toFixed(4)} SOL in your Main Wallet (W1) to cover this payout + gas.` };
        }

        const rawPk = decryptKey(user.turnkeySubOrgId);
        if (!rawPk) return { success: false, message: "Decryption Fault." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

        const CHUNK_SIZE = 20;
        let lastSig = "";

        for (let i = 0; i < validRecipients.length; i += CHUNK_SIZE) {
            const chunk = validRecipients.slice(i, i + CHUNK_SIZE);
            const instructions = chunk.map(r => SystemProgram.transfer({
                fromPubkey: vaultPubkey,
                toPubkey: new PublicKey(r.pubkey),
                lamports: r.lamports
            }));

            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const vTx = new VersionedTransaction(new TransactionMessage({
                payerKey: vaultPubkey, recentBlockhash: blockhash, instructions
            }).compileToV0Message());
            vTx.sign([keypair]);

            const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

            let isConfirmed = false;
            for (let attempt = 0; attempt < 15; attempt++) {
                await new Promise(r => setTimeout(r, 2000));
                const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                if (status?.value && !status.value.err) { isConfirmed = true; break; }
            }

            if (!isConfirmed) {
                return { success: false, message: `Batch ${Math.floor(i / CHUNK_SIZE) + 1} dropped by the network. Check Solscan before retrying.` };
            }
            lastSig = sig;
        }

        return {
            success: true,
            signature: lastSig,
            message: `Paid ${validRecipients.length} wallet(s) a total of ${(totalLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL.`
        };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

// TIERED AIRDROP
export async function executeTieredAirdrop(
    telegramId: string, guildId: string, amtTop3: number, amtNext7: number, amtRanks11to50: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this Guild." };
        if (amtTop3 < 0 || amtNext7 < 0 || amtRanks11to50 < 0) return { success: false, message: "Amounts must be positive." };

        const lb = await getLeaderboard(guildId, 50);
        if (lb.length === 0) return { success: false, message: "No ranked members found to pay out." };

        const recipients = lb.map((row: any, idx: number) => {
            const rank = idx + 1;
            let solAmt = 0;
            if (rank <= 3) solAmt = amtTop3;
            else if (rank <= 10) solAmt = amtNext7;
            else solAmt = amtRanks11to50;
            return { pubkey: row.walletAddress, lamports: Math.floor(solAmt * LAMPORTS_PER_SOL), rank };
        }).filter(r => r.lamports > 0 && r.pubkey && r.pubkey !== "Unknown");

        if (recipients.length === 0) return { success: false, message: "No eligible recipients (check your amounts aren't all zero)." };

        const result = await sendGuildPayout(telegramId, recipients);
        if (!result.success) return result;

        await Promise.all(recipients.map(async (r) => {
            const membership = lb.find((row: any) => row.walletAddress === r.pubkey);
            if (membership) {
                await prisma.guildMembership.updateMany({
                    where: { guildId, user: { vaultAddress: r.pubkey } },
                    data: { airdropsReceivedSol: { increment: r.lamports / LAMPORTS_PER_SOL } }
                }).catch(() => {});
            }
        }));

        return { success: true, signature: result.signature, message: `${result.message}\n\nTop 3: ${amtTop3} SOL each | Ranks 4-10: ${amtNext7} SOL each | Ranks 11-50: ${amtRanks11to50} SOL each.` };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

// INDIVIDUAL PAYOUT
export async function executeIndividualAirdrop(
    telegramId: string, guildId: string, targetRank: number, amountSol: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this Guild." };
        if (targetRank <= 0 || amountSol <= 0) return { success: false, message: "Rank and Amount must be > 0." };

        const lb = await getLeaderboard(guildId, Math.max(targetRank, 50));
        const target = lb.find((row: any) => row.rank === targetRank);
        if (!target) return { success: false, message: `No member found at rank #${targetRank}.` };
        if (!target.walletAddress || target.walletAddress === "Unknown") return { success: false, message: `Rank #${targetRank}'s wallet address could not be resolved.` };

        const result = await sendGuildPayout(telegramId, [{ pubkey: target.walletAddress, lamports: Math.floor(amountSol * LAMPORTS_PER_SOL) }]);
        if (!result.success) return result;

        await prisma.guildMembership.updateMany({
            where: { guildId, user: { vaultAddress: target.walletAddress } },
            data: { airdropsReceivedSol: { increment: amountSol } }
        }).catch(() => {});

        return { success: true, signature: result.signature, message: `Sent ${amountSol} SOL to @${target.username} (Rank #${targetRank}).` };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

// BULK AIRDROP
export async function executeGuildAirdrop(
    telegramId: string, guildId: string, totalSol: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this Guild." };
        if (totalSol <= 0) return { success: false, message: "Amount must be > 0." };

        const lb = await getLeaderboard(guildId, 50);
        const eligible = lb.filter((row: any) => row.walletAddress && row.walletAddress !== "Unknown");
        if (eligible.length === 0) return { success: false, message: "No eligible members to airdrop to." };

        const perMemberSol = totalSol / eligible.length;
        const perMemberLamports = Math.floor(perMemberSol * LAMPORTS_PER_SOL);
        if (perMemberLamports <= 0) return { success: false, message: "Amount too small to split across all members." };

        const recipients = eligible.map((row: any) => ({ pubkey: row.walletAddress, lamports: perMemberLamports }));

        const result = await sendGuildPayout(telegramId, recipients);
        if (!result.success) return result;

        await Promise.all(eligible.map(async (row: any) => {
            await prisma.guildMembership.updateMany({
                where: { guildId, user: { vaultAddress: row.walletAddress } },
                data: { airdropsReceivedSol: { increment: perMemberSol } }
            }).catch(() => {});
        }));

        return { success: true, signature: result.signature, message: `Split ${totalSol} SOL evenly across ${eligible.length} members (~${perMemberSol.toFixed(4)} SOL each).` };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}