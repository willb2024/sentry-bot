import pLimit from 'p-limit';

export const dexScreenerLimiter = pLimit(5); // 5 concurrent requests
export const rugCheckLimiter = pLimit(3);    // 3 concurrent requests
export const jitoLimiter = pLimit(2);        // 2 concurrent requests
export const pumpFunLimiter = pLimit(4);     // 4 concurrent requests
