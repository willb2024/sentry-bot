// src/lib/http-agent.ts
import https from 'https';
import http from 'http';

// 🟢 Reusable TCP+TLS Keep-Alive Agent (eliminates cold handshakes on every quote/DEX request)
export const keepAliveHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 60,
    maxFreeSockets: 15,
    timeout: 5000,
});

export const keepAliveHttpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 60,
    maxFreeSockets: 15,
    timeout: 5000,
});