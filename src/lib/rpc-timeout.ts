// src/lib/rpc-timeout.ts
export async function withTimeout<T>(promise: Promise<T>, ms = 3500, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    try {
        const result = await Promise.race([promise, timeout]);
        clearTimeout(timer!);
        return result;
    } catch (_) {
        clearTimeout(timer!);
        return fallback;
    }
}