// src/services/vault.service.ts
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

import { prisma } from '../lib/prisma.js';
const ALGORITHM = 'aes-256-gcm';

const rawSecret = process.env.ENCRYPTION_KEY;
if (!rawSecret) {
    console.error("🔴 [FATAL CONFIGURATION ERROR] ENCRYPTION_KEY is missing in your .env file!");
    process.exit(1);
}

// Derive secure 32-byte key via scrypt
const ENCRYPTION_KEY = crypto.scryptSync(rawSecret, 'sentry-salt-v1', 32);

export function encryptKey(privateKeyBase58: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(privateKeyBase58, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

export function decryptKey(encryptedData: string): string | null {
    try {
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {
            console.error("🔴 [DECRYPTION FAULT] Ciphertext format is invalid.");
            return null;
        }
        
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = parts[1];
        const authTag = Buffer.from(parts[2], 'hex');
        
        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e: any) {
        console.error("🔴 [DECRYPTION EXCEPTION] Decryption parity check failed. Reason:", e.message);
        return null; 
    }
}

export function verifyEncryptionKeyHealth(): boolean {
    try {
        const testPayload = "SentryHealthCheckTestString";
        const encrypted = encryptKey(testPayload);
        const decrypted = decryptKey(encrypted);
        if (decrypted !== testPayload) {
            throw new Error("Parity check failed. Encryption and Decryption do not match.");
        }
        console.log("🟢 [VAULT SERVICE] AES-256-GCM Parity Health Check Passed.");
        return true;
    } catch (e: any) {
        console.error("🔴 [VAULT SERVICE] PARITY CHECK FAILED:", e.message);
        process.exit(1);
    }
}

verifyEncryptionKeyHealth();

export async function generateSecureVault(telegramId: string): Promise<{ address: string, subOrgId: string }> {
    const newWallet = Keypair.generate();
    const privateKeyStr = bs58.encode(newWallet.secretKey);
    const pubKeyStr = newWallet.publicKey.toBase58();
    
    const encryptedKey = encryptKey(privateKeyStr);
    
    await prisma.user.update({
        where: { telegramId },
        data: {
            vaultAddress: pubKeyStr,
            turnkeySubOrgId: encryptedKey
        }
    });
    
    return {
        address: pubKeyStr,
        subOrgId: encryptedKey 
    };
}

export async function importPrivateKey(telegramId: string, base58Key: string): Promise<boolean> {
    try {
        const keypair = Keypair.fromSecretKey(bs58.decode(base58Key));
        const pubKeyStr = keypair.publicKey.toBase58();
        const encryptedKey = encryptKey(base58Key);
        
        await prisma.user.update({
            where: { telegramId },
            data: {
                vaultAddress: pubKeyStr,
                turnkeySubOrgId: encryptedKey
            }
        });
        return true;
    } catch (e) {
        return false;
    }
}

export async function exportPrivateKey(telegramId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user || !user.turnkeySubOrgId) return null;
    return decryptKey(user.turnkeySubOrgId);
}

// Inside src/services/vault.service.ts

export async function ensureWalletsExist(telegramId: string, activeCount: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return;
    
    // 🟢 FIX: Directly assign the user's selected active count (1 to 5)
    const updates: any = {
        activeWallets: activeCount
    };

    try {
        if (activeCount >= 2 && !user.vault2) {
            const w = Keypair.generate();
            updates.vault2 = w.publicKey.toBase58();
            updates.pk2 = encryptKey(bs58.encode(w.secretKey));
        }
        if (activeCount >= 3 && !user.vault3) {
            const w = Keypair.generate();
            updates.vault3 = w.publicKey.toBase58();
            updates.pk3 = encryptKey(bs58.encode(w.secretKey));
        }
        if (activeCount >= 4 && !user.vault4) {
            const w = Keypair.generate();
            updates.vault4 = w.publicKey.toBase58();
            updates.pk4 = encryptKey(bs58.encode(w.secretKey));
        }
        if (activeCount >= 5 && !user.vault5) {
            const w = Keypair.generate();
            updates.vault5 = w.publicKey.toBase58();
            updates.pk5 = encryptKey(bs58.encode(w.secretKey));
        }
        
        await prisma.user.update({ where: { id: user.id }, data: updates });
    } catch (e: any) {
        console.error(`🔴 [VAULT] Wallet creation error for ${telegramId}:`, e.message);
        throw e;
    }
}

export function generateRecoveryCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return code;
}

export function hashRecoveryCode(code: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(code.trim().toUpperCase(), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
    try {
        const [salt, hash] = stored.split(':');
        if (!salt || !hash) return false;
        const verifyHash = crypto.scryptSync(code.trim().toUpperCase(), salt, 64);
        const storedHashBuffer = Buffer.from(hash, 'hex');
        if (verifyHash.length !== storedHashBuffer.length) return false;
        return crypto.timingSafeEqual(verifyHash, storedHashBuffer);
    } catch (_) {
        return false;
    }
}