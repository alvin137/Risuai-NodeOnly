import { Hono, type Context } from "hono";
import { kvList } from "../utils/db.js"
import { savePath, jwtSecret } from "../utils/util.js";
import { listInlayFiles } from "../utils/asset.util.js";
import "./asset.js";
import { registerCrud } from "./api/crud.js";

import { mkdir, readdir } from "node:fs/promises"
import path from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";


const api = new Hono();

//api.route("/patch", patchApp);


registerCrud(api);

api.get('/list', async (c) => {
    // const auth = await checkAuth(c);
    //if (auth instanceof Response) return auth;

    const keyPrefix = c.req.header('key-prefix') ?? '';
    const data = await getKeysByPrefix(keyPrefix);

    return c.json({ success: true, content: data });
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