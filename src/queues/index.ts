// src/queues/index.ts
import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { processDcaOrders } from '../services/dca.service.js';
import { processGuardOrders } from '../services/grpc.service.js';
import { processLimitOrders } from '../services/engine.service.js';
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
                logger.error(`${name} worker processing exception`, { error: error.message });
                throw error;
            }
        }, { connection: redis });

        worker.on('error', (err) => {
            logger.error(`🔴 [${name.toUpperCase()} WORKER ERROR]`, { error: err.message });
            setTimeout(() => {
                if (worker) {
                    worker.close().catch(() => {});
                    worker = null;
                }
                create();
            }, 5000);
        });

        worker.on('closed', () => {
            logger.warn(`⚠️ [${name.toUpperCase()} WORKER] Connection closed. Restarting worker...`);
            setTimeout(create, 5000);
        });

        return worker;
    };

    return create();
}

// 🟢 Auto-healing workers with auto-recovery
createWorker('dca', async (job) => { 
    if (job.data?.bot) await processDcaOrders(job.data.bot); 
});

createWorker('guard', async (job) => { 
    if (job.data?.bot) await processGuardOrders(job.data.bot); 
});

createWorker('limit', async (job) => { 
    if (job.data?.bot) await processLimitOrders(job.data.bot); 
});