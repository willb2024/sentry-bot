// src/services/guild.service.ts
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../lib/connection.js';
import { decryptKey } from './vault.service.js';
import { redis } from '../lib/redis.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js';
import { redlock } from '../lib/redlock.js';
import { isSimulationActive } from './simulation.service.js';

dotenv.config();

const GUILD_WORDS = ['ALPHA', 'SIGMA', 'APEX', 'NOVA', 'NEXUS', 'OMEGA', 'TITAN', 'VANGUARD', 'ECLIPSE', 'ZENITH'];
const PRICE_SOL = 0.2; // 🟢 0.2 SOL activation fee

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

        const isSim = await isSimulationActive(telegramId);

        const randomWord = GUILD_WORDS[Math.floor(Math.random() * GUILD_WORDS.length)];
        const randomTwoDigit = Math.floor(10 + Math.random() * 90);
        const guildCode = `GUILD-${randomWord}-${randomTwoDigit}`;

        if (isSim) {
            await prisma.guild.create({
                data: {
                    ownerId: user.id,
                    guildCode,
                    name,
                    description,
                    rewardDescription,
                    feePaidSol: 0 // Free in simulation mode
                }
            });
            return { success: true, message: "Guild successfully established (Simulation).", guildCode };
        }

        const treasuryWalletStr = process.env.TREASURY_WALLET_ADDRESS;
        if (!treasuryWalletStr) return { success: false, message: "Platform treasury not configured." };

        const priceLamports = Math.floor(PRICE_SOL * LAMPORTS_PER_SOL);
        const vaultPubkey = new PublicKey(user.vaultAddress);
        const balance = await connection.getBalance(vaultPubkey);

        if (balance < priceLamports + 500000) {
            return { success: false, message: `Insufficient Funds: You need ${PRICE_SOL} SOL + gas in your Main Wallet (W1).` };
        }

        const rawPk = decryptKey(user.turnkeySubOrgId);
        if (!rawPk) return { success: false, message: "Decryption Fault." };
        const keypair = Keypair.fromSecretKey(bs58.decode(rawPk));

        const ix = SystemProgram.transfer({
            fromPubkey: vaultPubkey,
            toPubkey: new PublicKey(treasuryWalletStr),
            lamports: priceLamports
        });

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const vTx = new VersionedTransaction(new TransactionMessage({
            payerKey: vaultPubkey, recentBlockhash: blockhash, instructions: [ix]
        }).compileToV0Message());
        vTx.sign([keypair]);

        const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

        let isConfirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) { isConfirmed = true; break; }
        }

        if (!isConfirmed) return { success: false, message: "Transaction dropped by the network." };

        await prisma.guild.create({
            data: {
                ownerId: user.id,
                guildCode,
                name,
                description,
                rewardDescription,
                feePaidSol: PRICE_SOL
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

        const points = (volumeSol / 0.1) * 10;

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

export async function switchActiveGuild(telegramId: string, membershipId: string): Promise<{ success: boolean; message: string; guildName?: string }> {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId } });
        if (!user) return { success: false, message: "User not found." };

        const target = await prisma.guildMembership.findUnique({
            where: { id: membershipId },
            include: { guild: true }
        });
        if (!target || target.userId !== user.id) return { success: false, message: "Membership not found." };

        await prisma.$transaction([
            prisma.guildMembership.updateMany({ where: { userId: user.id }, data: { isActive: false } }),
            prisma.guildMembership.update({ where: { id: membershipId }, data: { isActive: true } })
        ]);

        return { success: true, message: "Switched.", guildName: target.guild.name };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function getGuildOwnerSigner(telegramId: string, guildId: string) {
    const guild = await prisma.guild.findFirst({ where: { id: guildId, owner: { telegramId } } });
    if (!guild) return null;
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user?.vaultAddress || !user.turnkeySubOrgId) return null;
    const rawPk = decryptKey(user.turnkeySubOrgId);
    if (!rawPk) return null;
    return { keypair: Keypair.fromSecretKey(bs58.decode(rawPk)), vaultPubkey: new PublicKey(user.vaultAddress) };
}

export async function executeGuildAirdrop(telegramId: string, guildId: string, totalSol: number): Promise<{ success: boolean; message: string; signature?: string }> {
    let lock;
    try {
        lock = await redlock.acquire([`lock:guild_airdrop:${guildId}`], 60000);
        const signer = await getGuildOwnerSigner(telegramId, guildId);
        if (!signer) return { success: false, message: "Not the guild owner or no active vault." };

        const top50 = await getLeaderboard(guildId, 50);
        if (top50.length === 0) return { success: false, message: "No members to airdrop to." };

        const perMember = totalSol / top50.length;
        const lamportsPer = Math.floor(perMember * LAMPORTS_PER_SOL);
        if (lamportsPer <= 0) return { success: false, message: "Amount too small to split." };

        const instructions = top50.filter(m => m && m.walletAddress && m.walletAddress !== "Unknown").map(m => SystemProgram.transfer({
            fromPubkey: signer.vaultPubkey, toPubkey: new PublicKey(m!.walletAddress), lamports: lamportsPer
        }));

        const CHUNK_SIZE = 20;
        let confirmedTxs = 0;
        let lastSig = "";

        for (let i = 0; i < instructions.length; i += CHUNK_SIZE) {
            const chunk = instructions.slice(i, i + CHUNK_SIZE);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const vTx = new VersionedTransaction(new TransactionMessage({
                payerKey: signer.vaultPubkey, recentBlockhash: blockhash, instructions: chunk
            }).compileToV0Message());
            vTx.sign([signer.keypair]);
            const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
            lastSig = sig;

            let isConfirmed = false;
            for (let j = 0; j < 15; j++) {
                await new Promise(r => setTimeout(r, 1000));
                const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                if (status?.value && !status.value.err) { isConfirmed = true; break; }
            }
            if (isConfirmed) confirmedTxs++;
        }

        if (confirmedTxs === 0) return { success: false, message: "All transaction batches dropped by the network." };

        await prisma.guildMembership.updateMany({
            where: { guildId, user: { vaultAddress: { in: top50.map(m => m?.walletAddress).filter((w): w is string => !!w && w !== 'Unknown') } } },
            data: { airdropsReceivedSol: { increment: perMember } }
        }).catch(() => {});

        return { success: true, message: `Airdropped ${perMember.toFixed(4)} SOL to ${top50.length} members.`, signature: lastSig };
    } catch (e: any) {
        return { success: false, message: e.message || "Airdrop failed." };
    } finally {
        if (lock) await (lock as any).release().catch(() => {});
    }
}

export async function executeTieredAirdrop(telegramId: string, guildId: string, top3Sol: number, next7Sol: number, ranks11to50Sol: number): Promise<{ success: boolean; message: string; signature?: string }> {
    let lock;
    try {
        lock = await redlock.acquire([`lock:guild_airdrop:${guildId}`], 60000);
        const signer = await getGuildOwnerSigner(telegramId, guildId);
        if (!signer) return { success: false, message: "Not the guild owner or no active vault." };

        const top50 = await getLeaderboard(guildId, 50);
        if (top50.length === 0) return { success: false, message: "No members to airdrop to." };

        const instructions = [];
        let totalPaid = 0;
        for (const m of top50) {
            if (!m || !m.walletAddress || m.walletAddress === "Unknown") continue;
            let amount = 0;
            if (m.rank <= 3) amount = top3Sol;
            else if (m.rank <= 10) amount = next7Sol;
            else amount = ranks11to50Sol;
            if (amount <= 0) continue;

            instructions.push(SystemProgram.transfer({
                fromPubkey: signer.vaultPubkey, toPubkey: new PublicKey(m.walletAddress), lamports: Math.floor(amount * LAMPORTS_PER_SOL)
            }));
            totalPaid += amount;
        }
        if (instructions.length === 0) return { success: false, message: "No eligible recipients." };

        const CHUNK_SIZE = 20;
        let confirmedTxs = 0;
        let lastSig = "";

        for (let i = 0; i < instructions.length; i += CHUNK_SIZE) {
            const chunk = instructions.slice(i, i + CHUNK_SIZE);
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const vTx = new VersionedTransaction(new TransactionMessage({
                payerKey: signer.vaultPubkey, recentBlockhash: blockhash, instructions: chunk
            }).compileToV0Message());
            vTx.sign([signer.keypair]);
            const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });
            lastSig = sig;

            let isConfirmed = false;
            for (let j = 0; j < 15; j++) {
                await new Promise(r => setTimeout(r, 1000));
                const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
                if (status?.value && !status.value.err) { isConfirmed = true; break; }
            }
            if (isConfirmed) confirmedTxs++;
        }

        if (confirmedTxs === 0) return { success: false, message: "All transaction batches dropped by the network." };

        return { success: true, message: `Distributed ${totalPaid.toFixed(4)} SOL across ${instructions.length} recipients.`, signature: lastSig };
    } catch (e: any) {
        return { success: false, message: e.message || "Airdrop failed." };
    } finally {
        if (lock) await (lock as any).release().catch(() => {});
    }
}

export async function executeIndividualAirdrop(telegramId: string, guildId: string, targetRank: number, amountSol: number): Promise<{ success: boolean; message: string; signature?: string }> {
    let lock;
    try {
        lock = await redlock.acquire([`lock:guild_airdrop:${guildId}`], 60000);
        const signer = await getGuildOwnerSigner(telegramId, guildId);
        if (!signer) return { success: false, message: "Not the guild owner or no active vault." };

        const lb = await getLeaderboard(guildId, Math.max(targetRank, 50));
        const target = lb.find(m => m && m.rank === targetRank);
        if (!target || !target.walletAddress || target.walletAddress === "Unknown") {
            return { success: false, message: `No member found at rank #${targetRank}.` };
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const vTx = new VersionedTransaction(new TransactionMessage({
            payerKey: signer.vaultPubkey, recentBlockhash: blockhash,
            instructions: [SystemProgram.transfer({
                fromPubkey: signer.vaultPubkey, toPubkey: new PublicKey(target.walletAddress),
                lamports: Math.floor(amountSol * LAMPORTS_PER_SOL)
            })]
        }).compileToV0Message());
        vTx.sign([signer.keypair]);

        const sig = await connection.sendRawTransaction(Buffer.from(vTx.serialize()), { skipPreflight: true });

        let confirmed = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
            if (status?.value && !status.value.err) { confirmed = true; break; }
        }
        if (!confirmed) return { success: false, message: "Transaction dropped by network." };

        return { success: true, message: `Sent ${amountSol} SOL to @${target.username} (#${targetRank}).`, signature: sig };
    } catch (e: any) {
        return { success: false, message: e.message || "Airdrop failed." };
    } finally {
        if (lock) await (lock as any).release().catch(() => {});
    }
}