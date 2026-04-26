import { Hono, type Context, type Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { getConnInfo } from "hono/bun";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises"
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";

export const proxyApp = new Hono();

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const hubURL = 'https://sv.risuai.xyz';

// --- Proxy Stream Job constants ---
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 30000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_PENDING_EVENTS = 512;
const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const proxyStreamJobs = new Map();

// --- Proxy Stream: auth helpers ---

function normalizeAuthHeader(authHeader: string | string[] | undefined) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function isAuthorizedProxyRequest(req) {
    //return await checkAuth(req, null, true);
}

async function checkProxyAuth(req, res) {
    //return await checkAuth(req, res);
}

// --- Proxy Stream: network helpers ---

function isPrivateIPv4Host(hostname: string) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

function isLocalNetworkHost(hostname: string) {
    if (typeof hostname !== 'string' || hostname.trim() === '') {
        return false;
    }
    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '').split('%')[0];
    if (!normalizedHost) return false;
    if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost.endsWith('.local')) {
        return true;
    }
    // NodeOnly policy: keep server-side validation aligned with the client helper
    // for Node/self-hosted deployments where single-label LAN or Docker DNS names
    // like "litellm" / "ollama" are valid local targets. Upstream currently only
    // allows localhost/.local/IP here, but NodeOnly routes all local-network-mode
    // traffic through the Node server, so rejecting single-label hosts would make
    // the feature unusable for common self-hosted setups.
    if (/^[a-z0-9_-]+$/i.test(normalizedHost) && !normalizedHost.includes('.')) {
        return true;
    }
    if (net.isIP(normalizedHost) === 4) {
        return isPrivateIPv4Host(normalizedHost);
    }
    if (net.isIP(normalizedHost) === 6) {
        if (normalizedHost.startsWith('::ffff:')) {
            const mapped = normalizedHost.substring(7);
            return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
        }
        if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) {
            return true;
        }
        if (/^fe[89ab]/.test(normalizedHost)) {
            return true;
        }
        return normalizedHost === '::1';
    }
    return false;
}

function sanitizeTargetUrl(raw: string) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!isLocalNetworkHost(parsed.hostname)) {
            return null;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

// --- Proxy Stream: request/response helpers ---

function normalizeForwardHeaders(input: any) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') continue;
        if (typeof value === 'string') {
            normalized[key] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    return normalized;
}

function normalizeProxyResponseHeaders(headers: Record<string, string>) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) continue;
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function normalizeProxyStreamTimeoutMs(timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec: number) {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

// --- Proxy Stream: native HTTP request to local target ---

function requestLocalTargetStream(targetUrl: string, arg: any) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers['content-length']) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let cleanupAbort = () => {};
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            cleanupAbort();
            reject(error);
        };

        const req = client.request(parsedUrl, {
            method: arg.method,
            headers
        }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            cleanupAbort();
            resolve({
                status: res.statusCode || 502,
                headers: normalizeProxyResponseHeaders(res.headers),
                body: res
            });
        });

        req.on('error', (error) => {
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            const onAbort = () => {
                const abortError = new Error('Proxy stream job aborted');
                abortError.name = 'AbortError';
                req.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => arg.signal.removeEventListener('abort', onAbort);
        }

        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

// --- Proxy Stream: job lifecycle ---

function createProxyStreamJob(arg) {
    const jobId = nodeCrypto.randomUUID();
    const timeoutMs = normalizeProxyStreamTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
    const controller = new AbortController();
    const createdAt = Date.now();
    const job = {
        id: jobId,
        createdAt,
        updatedAt: createdAt,
        done: false,
        cleanupAt: 0,
        clients: new Set(),
        pendingEvents: [],
        pendingBytes: 0,
        abortController: controller,
        deadlineAt: createdAt + timeoutMs,
        heartbeatSec,
        timeoutMs
    };
    proxyStreamJobs.set(jobId, job);
    return job;
}

function pushJobEvent(job, event) {
    job.updatedAt = Date.now();
    const text = JSON.stringify(event);
    if (job.clients.size === 0) {
        job.pendingEvents.push(text);
        job.pendingBytes += Buffer.byteLength(text);
        while (
            job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS
            || job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
        ) {
            const removed = job.pendingEvents.shift();
            if (!removed) break;
            job.pendingBytes -= Buffer.byteLength(removed);
        }
        return;
    }
    for (const client of job.clients) {
        if (client.readyState === client.OPEN) {
            client.send(text);
        }
    }
}

function markJobDone(job: any) {
    if (job.done) return;
    job.done = true;
    job.cleanupAt = Date.now() + PROXY_STREAM_DONE_GRACE_MS;
}

function cleanupJob(jobId: string) {
    const job = proxyStreamJobs.get(jobId);
    if (!job) return;
    for (const client of job.clients) {
        try { client.close(); } catch { /* ignore */ }
    }
    proxyStreamJobs.delete(jobId);
}

async function runProxyStreamJob(job: any, arg: any) {
    const targetUrl = sanitizeTargetUrl(arg.targetUrl);
    if (!targetUrl) {
        pushJobEvent(job, { type: 'error', status: 400, message: 'Blocked non-local target URL' });
        markJobDone(job);
        return;
    }

    const headers = normalizeForwardHeaders(arg.headers);
    if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = arg.clientIp;
    }
    const bodyBuffer = arg.bodyBase64 ? Buffer.from(arg.bodyBase64, 'base64') : undefined;

    try {
        const upstreamResponse = await requestLocalTargetStream(targetUrl, {
            method: arg.method,
            headers,
            bodyBuffer,
            timeoutMs: job.timeoutMs,
            signal: job.abortController.signal
        });

        const filteredHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key === 'content-security-policy' || key === 'content-security-policy-report-only' || key === 'clear-site-data') {
                continue;
            }
            filteredHeaders[key] = value;
        }

        pushJobEvent(job, { type: 'upstream_headers', status: upstreamResponse.status, headers: filteredHeaders });

        if (upstreamResponse.body) {
            for await (const value of upstreamResponse.body) {
                if (job.abortController.signal.aborted) break;
                if (value && value.length > 0) {
                    pushJobEvent(job, { type: 'chunk', dataBase64: Buffer.from(value).toString('base64') });
                }
            }
        }
        pushJobEvent(job, { type: 'done' });
        markJobDone(job);
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'Proxy stream job aborted' : `${error}`;
        pushJobEvent(job, { type: 'error', status: 504, message });
        markJobDone(job);
    }
}

// --- Proxy Stream: WebSocket setup ---

function setupProxyStreamWebSocket(server: http.Server | https.Server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (!reqUrl.pathname.startsWith('/proxy-stream-jobs/') || !reqUrl.pathname.endsWith('/ws')) {
                socket.destroy();
                return;
            }

            const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
            if (!await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const pathParts = reqUrl.pathname.split('/').filter(Boolean);
            const jobId = pathParts.length >= 3 ? pathParts[1] : '';
            const job = proxyStreamJobs.get(jobId);
            if (!job) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId);
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    wsServer.on('connection', (ws, _req, jobId) => {
        const job = proxyStreamJobs.get(jobId);
        if (!job) {
            ws.close();
            return;
        }

        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        for (const event of job.pendingEvents) {
            ws.send(event);
        }
        job.pendingEvents = [];
        job.pendingBytes = 0;

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = proxyStreamJobs.get(jobId);
            if (!currentJob) return;
            currentJob.clients.delete(ws);
            if (currentJob.done && currentJob.clients.size === 0) {
                cleanupJob(jobId);
            }
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    });
}

function getRequestTimeoutMs(timeoutHeader: string | undefined) {
    const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs: number | null) {
    if (!timeoutMs) {
        return {
            signal: undefined,
            cleanup: () => {}
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer)
    };
}

const reverseProxyFunc = async (c: Context, next: Next) => {
    // if(!await checkAuth(req, res)){
    //     return;
    // }
    let url = c.req.header("risu-url");
    const urlParam = url ? decodeURIComponent(url) : c.req.query("url");

    if (!urlParam) {
        return c.json({ error: 'URL has no param' }, 400);
    }
    const timeoutMs = getRequestTimeoutMs(c.req.header('risu-timeout-ms'));
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
        // I hate typescript
        const header = c.req.header("risu-header") ? JSON.parse(decodeURIComponent(c.req.header("risu-header") ?? "")) : c.req.header();
        if (c.req.header("x-risu-tk") && !header['x-risu-tk']) {
        header['x-risu-tk'] = c.req.header("x-risu-tk");
    }
    if (c.req.header("risu-location") && !header['risu-location']) {
        header['risu-location'] = c.req.header("risu-location");
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = getConnInfo(c).remote.address;
    }

    if(c.req.header("authorization")?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
        let requestBody = undefined;
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            if (Buffer.isBuffer(c.req.raw.body) || typeof c.req.raw.body === 'string') {
                requestBody = c.req.raw.body;
            }
            else if (c.req.raw.body !== undefined) {
                requestBody = JSON.stringify(c.req.raw.body);
            }
        }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: c.req.method,
            headers: header,
            body: requestBody ?? null,
            signal: timeout.signal ?? null
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj: Record<string, string> = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response body to client
        return new Response(originalBody, {
            status: originalResponse.status,
            headers: headObj
        });
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!c.res.headers) {
                return c.json({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                }, 504);
            } else {
                return c.body(null);
            }
        }
        console.error('[Proxy]', c.req.method, urlParam, err?.cause || err);
        next();
        return;
    } finally {
        timeout.cleanup();
    }
}

const reverseProxyFunc_get = async (c: Context, next: Next) => {
    // if(!await checkAuth(req, res)){
    //     return;
    // }
    
    const urlParam = c.req.header("risu-url") ? decodeURIComponent(c.req.header("risu-url") ?? "") : c.req.query("url");

    if (!urlParam) {
        return c.json({
            error: 'URL has no param'
        }, 400);
    }
    const timeoutMs = getRequestTimeoutMs(c.req.header('risu-timeout-ms'));
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
    const header = c.req.header("risu-header") ? JSON.parse(decodeURIComponent(c.req.header("risu-header") ?? "")) : c.req.header();
    if (c.req.header("x-risu-tk") && !header['x-risu-tk']) {
        header['x-risu-tk'] = c.req.header("x-risu-tk");
    }
    if (c.req.header("risu-location") && !header['risu-location']) {
        header['risu-location'] = c.req.header("risu-location");
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = getConnInfo(c).remote.address;
    }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header ?? null,
            signal: timeout.signal ?? null
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        return new Response(originalBody, {
            status: originalResponse.status,
            headers: head
        })
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!c.res.headers) {
                return c.json({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                }, 504);
            } else {
                return c.body(null);
            }
        }
        next();
        return;
    } finally {
        timeout.cleanup();
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(c: Context) {
    console.log("[Hub Proxy] Incoming request:", c.req.method, c.req.url);
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = c.req.header('x-risu-node-path');
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const url = new URL(c.req.url);
            const pathAndQuery = (url.pathname + url.search).replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...c.req.header() };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            // TODO: Auth
            // if(!await checkAuth(req, res)){
            //     return;
            // }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: c.req.method,
            headers: headersToSend,
            body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
            redirect: 'manual',

            // @ts-expect-error
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            c.header(key, value);
        }
        c.status(response.status as StatusCode);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            if (!redirectUrl) throw new Error('Redirect location header missing');
            const redirectResponse = await fetch(redirectUrl, {
                method: c.req.method,
                headers: newHeaders,
                body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
                redirect: 'manual',
                // @ts-expect-error
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                c.header(key, value);
            }
            c.status(redirectResponse.status as StatusCode);
            if (redirectResponse.body) {
                return c.body(redirectResponse.body);
            } else {
                return c.body(null);
            }
        }
        
        if (response.body) {
            return c.body(response.body);
        } else {
            return c.body(null);
        }
        
    } catch (error) {
        console.error("[Hub Proxy] Error:", error);
        if (!c.res.headers) {
            return c.json({
                error: "Proxy request failed"
            }, 502);
        } else {
            return c.body(null);
        }
    }
}



proxyApp.get('/proxy', reverseProxyFunc_get);
proxyApp.get('/proxy2', reverseProxyFunc_get);
proxyApp.get('/hub-proxy/*', hubProxyFunc);

proxyApp.post('/proxy', reverseProxyFunc);
proxyApp.post('/proxy2', reverseProxyFunc);
proxyApp.put('/proxy', reverseProxyFunc);
proxyApp.put('/proxy2', reverseProxyFunc);
proxyApp.delete('/proxy', reverseProxyFunc);
proxyApp.delete('/proxy2', reverseProxyFunc);
proxyApp.post('/hub-proxy/*', hubProxyFunc);

// --- Proxy Stream Job endpoints ---
proxyApp.post('/proxy-stream-jobs', async (c) => {
    // if (!await checkProxyAuth(c)) {
    //     return;
    // }

    const rawUrl = typeof c.req.raw?.url === 'string' ? c.req.raw.url : '';
    const encodedUrl = encodeURIComponent(rawUrl);
    const url = sanitizeTargetUrl(decodeURIComponent(encodedUrl));
    if (!url) {
        return c.json({ error: 'Invalid target URL. Only local/private network http(s) endpoints are allowed.' }, 400);
    }

    const method = typeof c.req?.method === 'string' ? c.req.method.toUpperCase() : 'POST';
    if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        return c.json({ error: 'Invalid HTTP method' }, 400);
    }
    const body = await c.req.json();
    const bodyBase64 = typeof body?.bodyBase64 === 'string' ? body.bodyBase64 : '';
    if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
        return c.json({ error: 'Request body too large' }, 413);
    }
    if (proxyStreamJobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
        return c.json({ error: 'Too many active stream jobs. Retry shortly.' }, 429);
    }
    const headers = normalizeForwardHeaders(body?.headers);
    const heartbeatSec = normalizeHeartbeatSec(Number(body?.heartbeatSec));
    const job = createProxyStreamJob({
        heartbeatSec,
        timeoutMs: body?.timeoutMs
    });

    void runProxyStreamJob(job, {
        targetUrl: url,
        headers,
        method,
        bodyBase64,
        clientIp: getConnInfo(c).remote.address
    });

    return c.json({
        jobId: job.id,
        heartbeatSec: job.heartbeatSec
    });
});

proxyApp.delete('/proxy-stream-jobs/:jobId', async (c: Context) => {
    // if (!await checkProxyAuth(req, res)) {
    //     return;
    // }
    const job = proxyStreamJobs.get(c.req.param("jobId"));
    if (!job) {
        return c.json({success: true});
    }
    job.abortController.abort();
    markJobDone(job);
    cleanupJob(job.id);
    return c.json({ success: true });
});