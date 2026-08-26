// src/lib/logger.ts — Full File with Circular Reference & Socket Immunity
import winston from 'winston';

function safeSerialize(value: any, seen = new WeakSet()): any {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle BigInt serialization
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Handle Errors and extract only safe metadata
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: (value as any).code,
      status: (value as any).status || (value as any).response?.status,
    };
  }

  // Handle Objects & Arrays
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    // Filter out Node.js native streams, sockets, and HTTP parsers
    if (
      value.constructor?.name === 'TLSSocket' ||
      value.constructor?.name === 'Socket' ||
      value.constructor?.name === 'HTTPParser' ||
      value.constructor?.name === 'ClientRequest' ||
      value.constructor?.name === 'IncomingMessage'
    ) {
      return `[${value.constructor.name}]`;
    }

    const out: Record<string, any> = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      // Skip deep socket/request/response internal trees
      if (
        key === 'socket' || 
        key === 'parser' || 
        key === 'request' || 
        key === 'response' || 
        key === 'req' || 
        key === 'res' || 
        key === '_httpMessage' ||
        key === 'client' ||
        key === 'agent'
      ) {
        out[key] = `[Skipped:${key}]`;
        continue;
      }

      try {
        out[key] = safeSerialize(value[key], seen);
      } catch (_) {
        out[key] = '[Unserializable]';
      }
    }
    return out;
  }

  return value;
}

const safeFormat = winston.format((info) => {
  return safeSerialize(info);
});

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  safeFormat(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  ],
});