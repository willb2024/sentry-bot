// src/queues/index.ts
import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { processDcaOrders } from '../services/dca.service.js';
import { processGuardOrders } from '../services/grpc.service.js';
import { processLimitOrders } from '../services/engine.service.js';
import { getBotInstance } from '../lib/bot-instance.js';
import { logger } from '../lib/logger.js';

export const dcaQueue = new Queue('dca', { connection: redis });
export const guardQueue = new Queue('guard', { connection: redis });
export const limitQueue = new Queue('limit', { connection: redis });

function createWorker(name: string, processor: (job: Job) => Promise<void>) {
    let worker: Worker | null = null;
    const create = () => {
        worker = new Worker(name, async (job: Job) => {
            try {
                await processor(job);
            } catch (error: any) {
                logger.error(`${name} worker exception`, { error: error.message });
                throw error;
            }
        }, { connection: redis });

        worker.on('error', (err) => {
            logger.error(`🔴 [${name.toUpperCase()} WORKER ERROR]`, { error: err.message });
            setTimeout(() => {
                if (worker) { worker.close().catch(() => {}); worker = null; }
                create();
            }, 5000);
        });

        return worker;
    };
    return create();
}

// 🟢 Consume singleton bot instance inside workers
createWorker('dca', async () => { await processDcaOrders(getBotInstance()); });
createWorker('guard', async () => { await processGuardOrders(getBotInstance()); });
createWorker('limit', async () => { await processLimitOrders(getBotInstance()); });