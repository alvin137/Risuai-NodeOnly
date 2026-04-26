import { Hono, type Context } from "hono";
import { kvDel, kvList } from "../utils/db.js"
import { savePath, jwtSecret } from "../utils/util.js";
import { listInlayFiles, readInlaySidecar, writeInlayFile } from "../utils/asset.util.js";
import "./asset.js";
import { registerCrud } from "./api/crud.js";

import path from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import nodeCrypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { streamSSE } from "hono/streaming";
import sharp from "sharp";


const api = new Hono();

//api.route("/patch", patchApp);


registerCrud(api);

// TODO: Need to setup rateLimit
// const loginRouteLimiter = rateLimit({
//     windowMs: 30 * 1000,
//     max: 10,
//     standardHeaders: true,
//     legacyHeaders: false,
//     message: { error: 'Too many attempts. Please wait and try again later.' },
//     validate: { xForwardedForHeader: false }
// });

export let password = "";

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

// NodeOnly: server-issued JWT (see jwt_secret comment above)
function createServerJwt() {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = { iat: now, exp: now + 5 * 60 }
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = nodeCrypto.createHmac('sha256', jwtSecret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url')
    return `${headerB64}.${payloadB64}.${sig}`
}

api.get('/list', async (c) => {
    // const auth = await checkAuth(c);
    //if (auth instanceof Response) return auth;

    const keyPrefix = c.req.header('key-prefix') ?? '';
    const data = await getKeysByPrefix(keyPrefix);

    return c.json({ success: true, content: data });
});

api.get('/test_auth', async(c) => {

    if(!password){
        return c.json({status: 'unset'})
    }
    // TODO: Do auth things
    // else if(!await checkAuth(req, res, true)){
    //     // JWT missing/invalid – fall back to session cookie (survives page refresh)
    //     const sessionToken = parseSessionCookie(req)
    //     if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
    //         res.send({status: 'success', token: createServerJwt()})
    //     } else {
    //         res.send({status: 'incorrect'})
    //     }
    // }
    else{
        return c.json({status: 'success', token: createServerJwt()})
    }
})

// TODO: Add loginRouteLimiter
api.post('/login', async (c) => {
    if(password === ''){
        return c.json({error: 'Password not set'}, 400)
    }
    const body = await c.req.json();
    if(body.password && body.password.trim() === password.trim()){
        return c.json({status: 'success', token: createServerJwt()})
    }
    else{
        return c.json({error: 'Password incorrect'}, 400)
    }
})

// NodeOnly: token refresh endpoint (pairs with server-side JWT)
api.post('/token/refresh', async (c) => {
    //if (!await checkAuth(req, res, false, {allowExpired: true})) return
    return c.json({ token: createServerJwt() })
})

api.post('/crypto', async (c) => {
    try {
        const hash = nodeCrypto.createHash('sha256');
        const body = await c.req.json();
        hash.update(Buffer.from(body.data, 'utf-8'));
        return c.body(hash.digest('hex'));
    } catch (error) {
        return c.json({ error: 'Crypto operation failed' }, 500);
    }
})


api.post('/set_password', async (c) => {
    if(password === ''){
        const body = await c.req.json();
        password = body.password;
        writeFileSync(passwordPath, password, 'utf-8')
        return c.json({status: 'success'})
    }
    else{
        return c.json({error: 'Password already set'}, 400)
    }
})

// ── Inlay bulk compression endpoint ──────────────────────────────────────────
const COMPRESS_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp']);

// Add sessionAuthMiddleware
api.post('/inlays/compress', async (c) => {
  const body = await c.req.json();
  const quality = typeof body.quality === 'number' ? body.quality : 85;

  c.header('cache-control', 'no-cache');
  c.header('connection', 'keep-alive');

  return streamSSE(c, async (s) => {
    const send = (data: any) => {
      s.writeSSE({ data: JSON.stringify(data) });
    };

    try {
      const files = await listInlayFiles();
      const imageFiles: typeof files = [];

      for (const entry of files) {
        if (!COMPRESS_IMAGE_EXTS.has(entry.ext)) continue;
        const sidecar = await readInlaySidecar(entry.id);
        if (sidecar && sidecar.type !== 'image') continue;
        imageFiles.push(entry);
      }

      const total = imageFiles.length;
      let compressed = 0;
      let skipped = 0;
      let totalSaved = 0;

      for (let i = 0; i < imageFiles.length; i++) {
        const entry = imageFiles[i];
        try {
          const original = await fs.readFile(entry.filePath);
          const webpBuf = await sharp(original).webp({ quality }).toBuffer();

          if (webpBuf.length < original.length) {
            const sidecar = await readInlaySidecar(entry.id);
            const info = sidecar || {};
            await writeInlayFile(entry.id, 'webp', webpBuf, { ...info, ext: 'webp' });
            kvDel(`inlay_thumb/${entry.id}`);
            const saved = original.length - webpBuf.length;
            totalSaved += saved;
            compressed++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }

        send({ type: 'progress', current: i + 1, total, compressed, skipped, totalSaved });
      }

      send({ type: 'done', total, compressed, skipped, totalSaved });
    } catch (err) {
      send({ type: 'error', message: (err as Error)?.message || 'Unknown error' });
    }
  });
});


async function getKeysByPrefix(prefix: string): Promise<string[]> {
    if (prefix === 'inlay/') {
        const fileKeys = (await listInlayFiles()).map(entry => `inlay/${entry.id}`);
        return [...new Set([...fileKeys, ...kvList('inlay/')])];
    }
    return kvList(prefix);
}

const inlayDir = path.join(savePath, 'inlays')

interface JwtPayload {
  iat: number; // issued at
  exp: number; // expiration
}

export async function checkAuth(c: Context, { allowExpired = false } = {}): Promise<Response | JwtPayload> {
    const token = c.req.header('risu-auth');
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    const parts = token.split('.');
    if (parts.length !== 3) return c.json({ error: 'Unauthorized' }, 401);

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const hasher = new Bun.CryptoHasher('sha256', jwtSecret);
    const expectedSig = hasher.update(`${headerB64}.${payloadB64}`).digest();
    const actualSig = Buffer.from(signatureB64, 'base64url');

    if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    } catch {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    if (typeof payload !== 'object' || payload === null || typeof (payload as any).exp !== 'number' || typeof (payload as any).iat !== 'number') {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const validPayload = payload as JwtPayload;

    if (!allowExpired) {
        const now = Math.floor(Date.now() / 1000);
        if (validPayload.exp < now) {
            return c.json({ error: 'Unauthorized' }, 401);
        }
    }

    return validPayload;
}

export default api;