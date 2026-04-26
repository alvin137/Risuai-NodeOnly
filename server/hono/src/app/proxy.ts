import { Hono, type Context, type Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { getConnInfo } from "hono/bun";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises"
import path from "node:path";

export const proxyApp = new Hono();

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const hubURL = 'https://sv.risuai.xyz';

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