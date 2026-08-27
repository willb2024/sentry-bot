// src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// 🟢 FIX 4E: Singleton with clean log configuration & connection reuse
export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error']
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;