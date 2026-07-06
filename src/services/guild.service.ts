// src/services/guild.service.ts
import { PrismaClient } from '@prisma/client';
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { decryptKey } from './vault.service.js';
import { redis } from '../lib/redis.js';
import { resolveBadge } from './vip_promo.service.js'; 
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
        if (!user.isDevSuiteUnlocked) return { success: false, message: "Dev Suite not unlocked." };
        if (user.ownedGuild) return { success: false, message: "You already own a Guild." };

        // TASK 3 FIX: Removed the 2.0 SOL silent charge. Guild creation is now genuinely free as advertised.
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
                feePaidSol: 0 // Fully Free
            }
        });

        return { success: true, message: "Guild successfully established.", guildCode };
    } catch (e: any) {
        console.error("🔴 [GUILD] Create Guild error:", e.message);
        return { success: false, message: e.message };
    }
}

export async function joinGuild(telegramId: string, guildCode: string): Promise<{ success: boolean; message: string; guildName?: string; rewardDescription?: string | null }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const guild = await prisma.guild.findUnique({ where: { guildCode: guildCode.toUpperCase() } });
        if (!guild || !guild.isActive) return { success: false, message: "Guild not found or inactive." };
        if (guild.ownerId === user.id) return { success: false, message: "You cannot join your own Guild." };

        await prisma.guildMembership.updateMany({
            where: { userId: user.id },
            data: { isActive: false }
        });

        await prisma.guildMembership.upsert({
            where: { guildId_userId: { guildId: guild.id, userId: user.id } },
            update: { isActive: true },
            create: { guildId: guild.id, userId: user.id, isActive: true }
        });

        await redis.set(`guild_member:${guild.id}:${user.id}`, "1", 'EX', 60 * 60 * 24 * 365);

        return { success: true, message: "Joined successfully.", guildName: guild.name, rewardDescription: guild.rewardDescription };
    } catch (e: any) {
        if (e.code === 'P2002') return { success: false, message: "You are already a member of this Guild." };
        console.error("🔴 [GUILD] Join Guild error:", e.message);
        return { success: false, message: "Error joining guild." };
    }
}

export async function awardGuildPoints(telegramId: string, volumeSol: number): Promise<void> {
    if (volumeSol <= 0) return;
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return;

        const memberships = await prisma.guildMembership.findMany({ 
            where: { userId: user.id, isActive: true } 
        });
        if (memberships.length === 0) return;

        const points = volumeSol / 0.1; 

        for (const membership of memberships) {
            await prisma.guildMembership.update({
                where: { id: membership.id },
                data: {
                    loyaltyPoints: { increment: points },
                    totalVolumeSol: { increment: volumeSol },
                    lastActiveAt: new Date()
                }
            });

            await redis.zincrby(`guild_lb:${membership.guildId}`, points, user.id);
        }
    } catch (e: any) {
        console.error("🔴 [GUILD] Point allocation exception:", e.message);
    }
}

// TASK 4 FIX: Implemented missing switchActiveGuild
export async function switchActiveGuild(telegramId: string, membershipId: string): Promise<{ success: boolean; message: string; guildName?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const targetMembership = await prisma.guildMembership.findFirst({
            where: { id: membershipId, userId: user.id },
            include: { guild: true }
        });

        if (!targetMembership) return { success: false, message: "Membership record not found." };

        await prisma.guildMembership.updateMany({
            where: { userId: user.id },
            data: { isActive: false }
        });

        await prisma.guildMembership.update({
            where: { id: membershipId },
            data: { isActive: true }
        });

        return { success: true, message: `Switched active community!`, guildName: targetMembership.guild.name };
    } catch (e: any) {
        console.error("🔴 [GUILD] Switch exception:", e.message);
        return { success: false, message: e.message };
    }
}

// TASK 8 FIX: N+1 queries eliminated. Now performs a single batched database query.
export async function getLeaderboard(guildId: string, limit: number = 50) {
    try {
        const rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, limit - 1, 'WITHSCORES');
        if (rawLb.length === 0) return [];
        
        const userIds: string[] = [];
        const scoreMap: Record<string, number> = {};

        for (let i = 0; i < rawLb.length; i += 2) {
            const userId = rawLb[i];
            userIds.push(userId);
            scoreMap[userId] = parseFloat(rawLb[i + 1]);
        }

        const memberships = await prisma.guildMembership.findMany({
            where: { guildId, userId: { in: userIds } },
            include: { user: true }
        });
        const memberMap = new Map(memberships.map(m => [m.userId, m]));

        const results = userIds.map((userId, index) => {
            const memberInfo = memberMap.get(userId);
            if (!memberInfo) return null;

            let daysRemaining = null;
            if (memberInfo.user.isVip && memberInfo.user.vipExpiresAt) {
                daysRemaining = Math.ceil((memberInfo.user.vipExpiresAt.getTime() - Date.now()) / 86400000);
            }
            const badgeObj = resolveBadge(
                memberInfo.user.isVip, 
                !!(memberInfo.user.vipExpiresAt && memberInfo.user.vipExpiresAt < new Date()), 
                memberInfo.user.vipSource as any, 
                daysRemaining
            );
            const badgeStr = badgeObj.badge ? ` ${badgeObj.badge}` : '';

            return {
                rank: index + 1,
                membershipId: memberInfo.id,
                telegramId: memberInfo.user.telegramId,
                username: `${memberInfo.user.username || memberInfo.user.telegramId}${badgeStr}`, 
                walletAddress: memberInfo.user.vaultAddress || "Unknown",
                glp: scoreMap[userId],
                volumeSol: memberInfo.totalVolumeSol,
                airdropsReceived: memberInfo.airdropsReceivedSol || 0 
            };
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        return results;
    } catch (e: any) {
        console.error("🔴 [GUILD] Leaderboard fetch failed:", e.message);
        return [];
    }
}

export async function exportLeaderboard(telegramId: string, guildId: string): Promise<string | null> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        if (!guild) return null;

        const lb = await getLeaderboard(guildId, 500);
        let csv = `rank,telegram_username,wallet_address,glp,volume_sol,airdrops_received_sol\n`;
        
        lb.forEach(row => {
            const cleanUsername = row.username.split(' ')[0];
            csv += `${row.rank},@${cleanUsername},${row.walletAddress},${row.glp.toFixed(2)},${row.volumeSol.toFixed(4)},${row.airdropsReceived.toFixed(4)}\n`;
        });

        return csv;
    } catch (e: any) {
        console.error("🔴 [GUILD] CSV Compilation failed:", e.message);
        return null;
    }
}

// TASK 4 FIX: Implemented missing executeTieredAirdrop
export async function executeTieredAirdrop(
    telegramId: string, 
    guildId: string, 
    amountTop3: number, 
    amountTop10: number,
    amountTop50: number 
): Promise<{ success: boolean; message: string; signature?: string; notifiedUsers?: { tgId: string; amount: number; guildName: string }[] }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!guild || !user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "Auth failed." };

        const lb = await getLeaderboard(guild.id, 50); 
        const validLb = lb.filter((m) => m !== null);
        if (validLb.length === 0) return { success: false, message: "Guild is empty." };

        const vaultPubkey = new PublicKey(user.vaultAddress);
        const instructions = [];
        let totalLamportsNeeded = 0n;
        const notifiedUsers: { tgId: string; amount: number; guildName: string }[] = [];
        const dbUpdates: { id: string; amount: number }[] = [];

        for (const member of validLb) {
            let amountSol = 0;
            if (member.rank <= 3) {
                amountSol = amountTop3;
            } else if (member.rank <= 10) {
                amountSol = amountTop10;
            } else if (member.rank <= 50) {
                amountSol = amountTop50; 
            }

            if (amountSol > 0) {
                const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
                totalLamportsNeeded += BigInt(lamports);
                
                instructions.push(SystemProgram.transfer({
                    fromPubkey: vaultPubkey,
                    toPubkey: new PublicKey(member.walletAddress),
                    lamports: lamports
                }));

                dbUpdates.push({ id: member.membershipId, amount: amountSol });
                notifiedUsers.push({ tgId: member.telegramId, amount: amountSol, guildName: guild.name });
            }
        }

        if (instructions.length === 0) {
            return { success: false, message: "No rewards to distribute (amounts must be greater than 0)." };
        }

        const balance = await connection.getBalance(vaultPubkey);
        if (BigInt(balance) < totalLamportsNeeded + 2000000n) {
            return { success: false, message: `Insufficient SOL. Need ${((Number(totalLamportsNeeded) + 2000000) / LAMPORTS_PER_SOL).toFixed(4)} SOL in W1.` };
        }

        const rawPk = decryptKey(user.turnkeySubOrgId);
        if(!rawPk) return { success: false, message: "Decryption failed." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

        const BATCH_SIZE = 18;
        let lastSig = '';
        for (let i = 0; i < instructions.length; i += BATCH_SIZE) {
            const batch = instructions.slice(i, i + BATCH_SIZE);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const vTx = new VersionedTransaction(new TransactionMessage({
                payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: batch
            }).compileToV0Message());
            vTx.sign([keypair]);
            lastSig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
            await new Promise(r => setTimeout(r, 400));
        }
        const sig = lastSig;

        for (const u of dbUpdates) {
            await prisma.guildMembership.update({
                where: { id: u.id },
                data: { airdropsReceivedSol: { increment: u.amount } }
            });
        }

        return { 
            success: true, 
            message: `Airdropped ${amountTop3} SOL to Top 3, ${amountTop10} SOL to Next 7, and ${amountTop50} SOL to Next 40.`, 
            signature: sig,
            notifiedUsers
        };
    } catch(e: any) {
        console.error("🔴 [GUILD] Tiered drop transaction exception:", e.message);
        return { success: false, message: e.message };
    }
}

// TASK 4 FIX: Implemented missing executeIndividualAirdrop
export async function executeIndividualAirdrop(
    telegramId: string,
    guildId: string,
    targetRank: number,
    amountSol: number
): Promise<{ success: boolean; message: string; signature?: string; notifiedUser?: { tgId: string; amount: number; guildName: string; username: string } }> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!guild || !user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "Auth failed." };

        const lb = await getLeaderboard(guild.id, targetRank);
        const targetMember = lb.find(m => m.rank === targetRank);
        if (!targetMember) return { success: false, message: `No member found at rank #${targetRank}.` };

        const vaultPubkey = new PublicKey(user.vaultAddress);
        const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
        
        const balance = await connection.getBalance(vaultPubkey);
        if (balance < lamports + 2000000) return { success: false, message: "Insufficient SOL." };

        const rawPk = decryptKey(user.turnkeySubOrgId);
        if(!rawPk) return { success: false, message: "Decryption failed." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

        const ix = SystemProgram.transfer({
            fromPubkey: vaultPubkey,
            toPubkey: new PublicKey(targetMember.walletAddress),
            lamports
        });

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const vTx = new VersionedTransaction(new TransactionMessage({
            payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: [ix]
        }).compileToV0Message());
        vTx.sign([keypair]);

        const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

        await prisma.guildMembership.update({
            where: { id: targetMember.membershipId },
            data: { airdropsReceivedSol: { increment: amountSol } }
        });

        return {
            success: true,
            message: `Successfully paid ${amountSol} SOL to @${targetMember.username} (Rank #${targetRank})!`,
            signature: sig,
            notifiedUser: {
                tgId: targetMember.telegramId,
                amount: amountSol,
                guildName: guild.name,
                username: targetMember.username
            }
        };
    } catch(e: any) {
        console.error("🔴 [GUILD] Individual drop exception:", e.message);
        return { success: false, message: e.message };
    }
}

// TASK 4 FIX: Implemented missing executeGuildAirdrop
export async function executeGuildAirdrop(telegramId: string, guildId: string, totalSol: number): Promise<{success: boolean, message: string, signature?: string}> {
    try {
        const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!guild || !user || !user.vaultAddress || !user.turnkeySubOrgId) return { success: false, message: "Auth failed." };

        const lb = await getLeaderboard(guild.id, 50);
        const validLb = lb.filter((m) => m !== null);
        if (validLb.length === 0) return { success: false, message: "Guild is empty." };

        const solPerUser = totalSol / validLb.length;
        const lamportsPerUser = Math.floor(solPerUser * LAMPORTS_PER_SOL);
        const totalLamportsNeeded = lamportsPerUser * validLb.length;

        const vaultPubkey = new PublicKey(user.vaultAddress);
        const balance = await connection.getBalance(vaultPubkey);
        if (balance < totalLamportsNeeded + 2000000) return { success: false, message: "Insufficient SOL in Main Wallet (W1)." };

        const rawPk = decryptKey(user.turnkeySubOrgId);
        if(!rawPk) return { success: false, message: "Decryption failed." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

        const instructions = validLb.map(member => SystemProgram.transfer({
            fromPubkey: vaultPubkey,
            toPubkey: new PublicKey(member.walletAddress),
            lamports: lamportsPerUser
        }));

        const BATCH_SIZE = 18;
        let lastSig = '';
        for (let i = 0; i < instructions.length; i += BATCH_SIZE) {
            const batch = instructions.slice(i, i + BATCH_SIZE);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const vTx = new VersionedTransaction(new TransactionMessage({
                payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: batch
            }).compileToV0Message());
            vTx.sign([keypair]);
            lastSig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
            await new Promise(r => setTimeout(r, 400));
        }
        const sig = lastSig;

        return { success: true, message: `Airdropped ${solPerUser.toFixed(4)} SOL to ${validLb.length} members.`, signature: sig };
    } catch(e: any) {
        console.error("🔴 [GUILD] Legacy full-guild drop exception:", e.message);
        return { success: false, message: e.message };
    }
}

export async function updateRankCache(guildId: string) {
    try {
        const rawLb = await redis.zrevrange(`guild_lb:${guildId}`, 0, -1);
        
        if (rawLb.length > 0) {
            await prisma.$transaction(
                rawLb.map((userId, i) => 
                    prisma.guildMembership.update({
                        where: { guildId_userId: { guildId, userId } },
                        data: { rank: i + 1 }
                    })
                )
            );
        }
    } catch (e: any) {
        console.error("🔴 [GUILD] Rank cache update exception:", e.message);
    }
}