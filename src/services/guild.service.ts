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

export async function createGuild(
    telegramId: string, 
    name: string, 
    description: string | null, 
    rewardDescription: string | null
): Promise<{ success: boolean; message: string; guildCode?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId }, include: { ownedGuild: true } });
        if (!user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "No active vault found." };
        if (user.ownedGuild) return { success: false, message: "You already own a Guild." };

        // 🟢 FIX: Guild creation is free. Removed Dev Suite requirement and 2.0 SOL transfer.
        const randomWord = GUILD_WORDS[Math.floor(Math.random() * GUILD_WORDS.length)];
        const randomTwoDigit = Math.floor(10 + Math.random() * 90);
        const guildCode = `GUILD-${randomWord}-${randomTwoDigit}`;

        await prisma.guild.create({
            data: {
                ownerId: user.id,
                guildCode,
                name,
                description,
                rewardDescription,
                feePaidSol: 0
            }
        });

        return { success: true, message: "Guild successfully established.", guildCode };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function joinGuild(telegramId: string, guildCode: string): Promise<{ success: boolean; message: string; guildName?: string; rewardDescription?: string | null }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const guild = await prisma.guild.findUnique({ where: { guildCode: guildCode.toUpperCase() } });
        if (!guild || !guild.isActive) return { success: false, message: "Guild not found or inactive." };

        await prisma.guildMembership.create({
            data: { guildId: guild.id, userId: user.id }
        });

        await redis.set(`guild_member:${guild.id}:${user.id}`, "1");

        return { success: true, message: "Joined successfully.", guildName: guild.name, rewardDescription: guild.rewardDescription };
    } catch (e: any) {
        if (e.code === 'P2002') return { success: false, message: "You are already a member of this Guild." };
        return { success: false, message: "Error joining guild." };
    }
}

export async function awardGuildPoints(telegramId: string, volumeSol: number): Promise<void> {
    if (volumeSol <= 0) return;
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return;

        const memberships = await prisma.guildMembership.findMany({ where: { userId: user.id } });
        if (memberships.length === 0) return;

        const points = volumeSol / 0.1; // 10 GLP per SOL

        await Promise.all(memberships.map(async (membership) => {
            await prisma.guildMembership.update({
                where: { id: membership.id },
                data: {
                    loyaltyPoints: { increment: points },
                    totalVolumeSol: { increment: volumeSol },
                    lastActiveAt: new Date()
                }
            });

            await redis.zincrby(`guild_lb:${membership.guildId}`, points, user.id);
        }));
    } catch (e) {}
}

export async function getLeaderboard(guildId: string, limit: number = 50) {
    try {
        const rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, limit - 1, 'WITHSCORES');
        const results = [];
        
        for (let i = 0; i < rawLb.length; i += 2) {
            const userId = rawLb[i];
            const score = parseFloat(rawLb[i + 1]);
            
            const memberInfo = await prisma.guildMembership.findUnique({
                where: { guildId_userId: { guildId, userId } },
                include: { user: true }
            });

            if (memberInfo) {
                results.push({
                    rank: (i / 2) + 1,
                    username: memberInfo.user.username || memberInfo.user.telegramId,
                    walletAddress: memberInfo.user.vaultAddress || "Unknown",
                    glp: score,
                    volumeSol: memberInfo.totalVolumeSol
                });
            }
        }
        return results;
    } catch (e) {
        return [];
    }
}

export async function exportLeaderboard(telegramId: string, guildId: string): Promise<string | null> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return null;

        const lb = await getLeaderboard(guildId, 500);
        let csv = `rank,telegram_username,wallet_address,glp,volume_sol\n`;
        
        lb.forEach(row => {
            csv += `${row.rank},@${row.username},${row.walletAddress},${row.glp.toFixed(2)},${row.volumeSol.toFixed(4)}\n`;
        });

        return csv;
    } catch (e) {
        return null;
    }
}

export async function updateRankCache(guildId: string) {
    try {
        const rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, -1);
        
        for (let i = 0; i < rawLb.length; i++) {
            const userId = rawLb[i];
            const rank = i + 1;
            
            await prisma.guildMembership.update({
                where: { guildId_userId: { guildId, userId } },
                data: { rank }
            }).catch(() => {});
        }
    } catch (e) {}
}

// 🟢 FIX 2: Missing functions added below

export async function switchActiveGuild(telegramId: string, membershipId: string): Promise<{ success: boolean; message?: string; guildName?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const membership = await prisma.guildMembership.findUnique({
            where: { id: membershipId },
            include: { guild: true }
        });
        if (!membership || membership.userId !== user.id) {
            return { success: false, message: "Membership not found." };
        }

        await prisma.$transaction([
            prisma.guildMembership.updateMany({ where: { userId: user.id }, data: { isActive: false } }),
            prisma.guildMembership.update({ where: { id: membershipId }, data: { isActive: true } })
        ]);

        return { success: true, guildName: membership.guild.name };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function payFromOwnerWallet(telegramId: string, totalLamports: number, recipients: { pubkey: string; lamports: number }[]) {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.vaultAddress || !user.turnkeySubOrgId) throw new Error("No active vault found.");

    const balance = await connection.getBalance(new PublicKey(user.vaultAddress));
    if (balance < totalLamports + 500000) throw new Error("Insufficient W1 balance to cover this airdrop.");

    const rawPk = decryptKey(user.turnkeySubOrgId);
    if (!rawPk) throw new Error("Decryption failure.");
    const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

    const instructions = recipients
        .filter(r => r.lamports > 0)
        .map(r => SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: new PublicKey(r.pubkey),
            lamports: r.lamports
        }));

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const vTx = new VersionedTransaction(new TransactionMessage({
        payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions
    }).compileToV0Message());
    vTx.sign([keypair]);

    const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

    let confirmed = false;
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (status?.value && !status.value.err) { confirmed = true; break; }
    }
    if (!confirmed) throw new Error("Transaction dropped by the network.");
    return sig;
}

export async function executeTieredAirdrop(
    telegramId: string, guildId: string, top3Sol: number, next7Sol: number, ranks11to50Sol: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this guild." };

        const lb = await getLeaderboard(guildId, 50);
        const recipients = lb.map((row, i) => {
            const rank = i + 1;
            let sol = 0;
            if (rank <= 3) sol = top3Sol;
            else if (rank <= 10) sol = next7Sol;
            else sol = ranks11to50Sol;
            return { pubkey: row.walletAddress, lamports: Math.floor(sol * LAMPORTS_PER_SOL) };
        });

        const totalLamports = recipients.reduce((s, r) => s + r.lamports, 0);
        const sig = await payFromOwnerWallet(telegramId, totalLamports, recipients);

        return { success: true, message: `Paid out ${(totalLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL across ${recipients.filter(r=>r.lamports>0).length} members.`, signature: sig };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function executeIndividualAirdrop(
    telegramId: string, guildId: string, targetRank: number, amountSol: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this guild." };

        const lb = await getLeaderboard(guildId, 500);
        const target = lb[targetRank - 1];
        if (!target) return { success: false, message: `No member found at rank #${targetRank}.` };

        const sig = await payFromOwnerWallet(telegramId, Math.floor(amountSol * LAMPORTS_PER_SOL), [
            { pubkey: target.walletAddress, lamports: Math.floor(amountSol * LAMPORTS_PER_SOL) }
        ]);

        return { success: true, message: `Sent ${amountSol} SOL to rank #${targetRank} (@${target.username}).`, signature: sig };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function executeGuildAirdrop(
    telegramId: string, guildId: string, totalSol: number
): Promise<{ success: boolean; message: string; signature?: string }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return { success: false, message: "You do not own this guild." };

        const lb = await getLeaderboard(guildId, 50);
        if (lb.length === 0) return { success: false, message: "No members to airdrop to." };

        const perMemberSol = totalSol / lb.length;
        const perMemberLamports = Math.floor(perMemberSol * LAMPORTS_PER_SOL);
        const recipients = lb.map(row => ({ pubkey: row.walletAddress, lamports: perMemberLamports }));

        const sig = await payFromOwnerWallet(telegramId, perMemberLamports * lb.length, recipients);

        return { success: true, message: `Airdropped ${perMemberSol.toFixed(4)} SOL to each of ${lb.length} members.`, signature: sig };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}