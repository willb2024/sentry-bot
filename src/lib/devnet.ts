// src/lib/devnet.ts
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { connection as mainnetConnection } from './connection.js';
import { redis } from './redis.js';
import dotenv from 'dotenv';

dotenv.config();

const DEVNET_ENABLED = process.env.DEVNET_ENABLED === 'true';

// 🟢 Fail-closed: Requires explicit DEVNET_TELEGRAM_IDS in .env
const DEVNET_IDS = (process.env.DEVNET_TELEGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const devnetConnection = new Connection(
    process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    { commitment: 'confirmed' }
);

export function isDevnetEligible(telegramId?: string): boolean {
    if (!DEVNET_ENABLED || !telegramId) return false;
    return DEVNET_IDS.includes(telegramId);
}

export async function isDevnetActive(telegramId?: string): Promise<boolean> {
    if (!isDevnetEligible(telegramId)) return false;
    return (await redis.get(`devnet:active:${telegramId}`)) === 'true';
}

export async function setDevnetMode(telegramId: string, active: boolean): Promise<boolean> {
    if (!isDevnetEligible(telegramId)) return false;
    await redis.set(`devnet:active:${telegramId}`, active ? 'true' : 'false');
    return true;
}

export async function getConnectionFor(telegramId?: string): Promise<Connection> {
    return (await isDevnetActive(telegramId)) ? devnetConnection : (mainnetConnection as unknown as Connection);
}

export function getDevnetConnection(): Connection { 
    return devnetConnection; 
}

// 🟢 Fail-closed: Refuses to load or decrypt mainnet treasury keys while in devnet mode
export async function getTreasuryConfigFor(telegramId?: string) {
    if (await isDevnetActive(telegramId)) {
        const address = process.env.DEVNET_TREASURY_WALLET_ADDRESS || '';
        const encryptedKey = process.env.DEVNET_TREASURY_PRIVATE_KEY_ENCRYPTED || '';
        if (!address || !encryptedKey) {
            throw new Error('Devnet treasury not configured. Set DEVNET_TREASURY_WALLET_ADDRESS and DEVNET_TREASURY_PRIVATE_KEY_ENCRYPTED. Refusing to fall back to the mainnet treasury.');
        }
        return { address, encryptedKey, isDevnet: true };
    }
    return {
        address: process.env.TREASURY_WALLET_ADDRESS || '',
        encryptedKey: process.env.TREASURY_PRIVATE_KEY_ENCRYPTED || '',
        isDevnet: false
    };
}

export async function requestDevnetAirdrop(address: string, sol = 2): Promise<{ ok: boolean; msg: string; sig?: string }> {
    try {
        const pubkey = new PublicKey(address);
        const sig = await devnetConnection.requestAirdrop(pubkey, Math.floor(sol * LAMPORTS_PER_SOL));
        const bh = await devnetConnection.getLatestBlockhash('confirmed');
        await devnetConnection.confirmTransaction(
            { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
            'confirmed'
        );
        return { ok: true, msg: `Airdropped ${sol} devnet SOL.`, sig };
    } catch (e: any) {
        return { 
            ok: false, 
            msg: e?.message?.includes('429') || e?.message?.includes('limit')
                ? 'Faucet rate-limited. Please wait 30s or use https://faucet.solana.com with your W1 address.'
                : `Airdrop failed: ${e.message}` 
        };
    }
}

export const DEVNET_UNSUPPORTED_MSG =
    `🧪 <b>DEVNET MODE — UNSUPPORTED OPERATION</b>\n\n` +
    `Pump.fun, Jupiter, Raydium and Jito do not exist on Devnet, so token swaps, ` +
    `guards, and launchpad deployments cannot execute on this network.\n\n` +
    `<b>Devnet is used for testing:</b> Vault generation, deposits, balances, withdrawals, ` +
    `sub-wallet sweeps, affiliate payouts, and guild airdrops.\n\n` +
    `<i>For swap and guard testing, use <code>/sim</code>.</i>`;