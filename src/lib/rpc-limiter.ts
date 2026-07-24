// src/lib/rpc-limiter.ts

export class RpcRateLimiter {
    private queue: (() => void)[] = [];
    private inFlight = 0;
    private readonly maxPerSecond: number;

    constructor(maxPerSecond = 4) {
        this.maxPerSecond = maxPerSecond;
        setInterval(() => this.drain(), Math.ceil(1000 / this.maxPerSecond));
    }

    private drain() {
        if (this.queue.length === 0) return;
        const next = this.queue.shift();
        if (next) next();
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await new Promise<void>(resolve => this.queue.push(resolve));
        return fn();
    }
}

export const rpcLimiter = new RpcRateLimiter(8);