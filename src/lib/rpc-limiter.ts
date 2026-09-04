// src/lib/rpc-limiter.ts
export class RpcRateLimiter {
    private queue: (() => void)[] = [];
    private readonly maxPerSecond: number;
    private readonly tickMs: number;
    private tokens: number = 0;

    constructor(maxPerSecond = Number(process.env.RPC_LIMITER_PER_SEC || 15)) {
        this.maxPerSecond = maxPerSecond;
        this.tickMs = 100;
        this.tokens = maxPerSecond;
        setInterval(() => this.drain(), this.tickMs);
    }

    private drain() {
        this.tokens += (this.maxPerSecond * this.tickMs) / 1000;
        if (this.tokens > this.maxPerSecond) {
            this.tokens = this.maxPerSecond;
        }

        while (this.tokens >= 1 && this.queue.length > 0) {
            this.tokens -= 1;
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