import winston from 'winston';



function safeSerialize(value: any, seen = new WeakSet()): any {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: (value as any).code,
    };
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const out: Record<string, any> = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      out[key] = safeSerialize(value[key], seen);
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