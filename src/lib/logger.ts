// src/lib/logger.ts
import winston from 'winston';

const SENSITIVE_PATTERN = /(secret|privatekey|private_key|encryption_key|seckey|mnemonic|seed|turnkey|pk[0-9]|withdrawalpin)/i;

function safeSerialize(value: any, seen = new WeakSet()): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Redact 64-byte secret key buffers (Solana Keypair secrets)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length === 64) return '[REDACTED:KEYPAIR_SECRET]';
    return `[Buffer: ${value.length} bytes]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: (value as any).code,
      status: (value as any).status || (value as any).response?.status,
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

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
      if (SENSITIVE_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }

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