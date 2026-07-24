// src/lib/rpc-limiter.ts

export class RpcRateLimiter {
    private queue: (() => void)[] = [];
    private readonly maxPerSecond: number;

    // 🟢 BOOTED TO 20 REQ/SEC FOR QUICKNODE
    constructor(maxPerSecond = 20) {
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

// 🟢 BOOTED TO 20 REQ/SEC FOR QUICKNODE
export const rpcLimiter = new RpcRateLimiter(20);