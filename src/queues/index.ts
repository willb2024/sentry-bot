// src/queues/index.ts
import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { processDcaOrders } from '../services/dca.service.js';
import { processGuardOrders } from '../services/grpc.service.js';
import { processLimitOrders } from '../services/engine.service.js';
import { logger } from '../lib/logger.js';

// Initialize Queues
export const dcaQueue = new Queue('dca', { connection: redis });
export const guardQueue = new Queue('guard', { connection: redis });
export const limitQueue = new Queue('limit', { connection: redis });

// Initialize Workers
new Worker('dca', async (job: Job) => {
    if (job.data.bot) await processDcaOrders(job.data.bot);
}, { connection: redis }).on('error', err => logger.error('DCA Worker Error', { error: err.message }));

new Worker('guard', async (job: Job) => {
    if (job.data.bot) await processGuardOrders(job.data.bot);
}, { connection: redis }).on('error', err => logger.error('Guard Worker Error', { error: err.message }));

new Worker('limit', async (job: Job) => {
    if (job.data.bot) await processLimitOrders(job.data.bot);
}, { connection: redis }).on('error', err => logger.error('Limit Worker Error', { error: err.message }));