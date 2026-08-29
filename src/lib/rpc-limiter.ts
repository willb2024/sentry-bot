// src/lib/rpc-limiter.ts

export class RpcRateLimiter {
    private queue: (() => void)[] = [];
    private readonly maxPerSecond: number;
    private readonly tickMs: number;
    private readonly perTickAllowance: number;

    constructor(maxPerSecond = Number(process.env.RPC_LIMITER_PER_SEC || 15)) {
        this.maxPerSecond = maxPerSecond;
        // 🟢 FIX: 100ms tick with proportional batch release
        // Handles concurrent multi-wallet bursts without queuing lag
        this.tickMs = 100;
        this.perTickAllowance = Math.max(1, Math.ceil((this.maxPerSecond * this.tickMs) / 1000));
        setInterval(() => this.drain(), this.tickMs);
    }

    private drain() {
        for (let i = 0; i < this.perTickAllowance && this.queue.length > 0; i++) {
            const next = this.queue.shift();
            if (next) next();
        }
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await new Promise<void>((resolve) => this.queue.push(resolve));
        return fn();
    }
}

export const rpcLimiter = new RpcRateLimiter(Number(process.env.RPC_LIMITER_PER_SEC || 15));