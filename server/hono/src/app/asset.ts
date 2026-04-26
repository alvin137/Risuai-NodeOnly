// import { sessionAuthMiddleware } from "./session.js";
import { Hono } from "hono";

import { kvGet, kvGetUpdatedAt, kvSet, db as sqliteDb } from "../utils/db.js";
import { readInlayFile, readInlaySidecar, resolveAssetPayload, THUMB_IMAGE_EXTS, generateThumbnail, readInlayInfoPayload } from "../utils/asset.util.js";


export const assetApp = new Hono();

// add Sessionauthmiddleware
assetApp.get("/:hexKey", async (c) => {
  try {
    const key = Buffer.from(c.req.param("hexKey"), "hex").toString("utf-8");
    if (key.startsWith("inlay/")) {
      const id = key.slice("inlay/".length);
      const file = await readInlayFile(id);
      if (file) {
        const etag = `"${Math.floor(file.mtimeMs)}"`;
        if (c.req.header("if-none-match") === etag) {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
          return c.status(304);
        }
        c.header("Content-Type", file.mime)
        c.header("Cache-Control", "public, max-age=31536000, immutable");
        c.header("ETag", etag);
        return c.body(new Uint8Array(file.buffer));
      }
      c.header("Cache-Control", "no-store")
      return c.status(404);
    }

    if (key.startsWith("inlay_thumb/")) {
      const id = key.slice("inlay_thumb/".length);
      const sidecar = await readInlaySidecar(id);
      if (!sidecar || sidecar.type !== "image" || !THUMB_IMAGE_EXTS.has(sidecar.ext)) {
        return c.status(404);
      }
      const file = await readInlayFile(id);
      if (!file) return c.body(null, 404, { 'Cache-Control': 'no-store' });
      const etag = `"thumb-${Math.floor(file.mtimeMs)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304, { "Cache-Control": "public, max-age=31536000, immutable"});
      }
      const thumb = await generateThumbnail(file.buffer);
      c.header("Content-Type", "image/webp")
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      c.header("ETag", etag);
      return c.body(Uint8Array.from(thumb));
    }

    const updatedAt = kvGetUpdatedAt(key);
    if (updatedAt === null) return c.body(null, 404, { 'Cache-Control': 'no-store' });

    const etag = `"${updatedAt}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304, { "Cache-Control": "public, max-age=31536000, immutable"});
    }

    const data = kvGet(key);
    if (!data) return c.body(null, 404, { 'Cache-Control': 'no-store' });

    const { binary, contentType } = resolveAssetPayload(key, Buffer.from(data));
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("ETag", etag);
    return c.body(Uint8Array.from(binary));
    
  } catch (e) {
    console.error(`[Asset] Error processing request for ${c.req.param("hexKey")}:`, e);
  }
});

// ─── Bulk asset endpoints (3-2-B) ─────────────────────────────────────────────
const BULK_BATCH = 50;

assetApp.post('/bulk-read', async (c) => {
    //if(!await checkAuth(req, res)){ return; }
    try {
        const keys = c.req.raw.body; // string[] — decoded key strings
        if(!Array.isArray(keys)){
          return c.json({ error: 'Body must be a JSON array of keys' }, 400);
        }

        const acceptsBinary = (c.req.header('accept') || '').includes('application/octet-stream');

        if (acceptsBinary) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            // Eliminates ~33% base64 overhead
            const entries = [];
            let totalSize = 4; // count header
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = kvGet(key);
                    }
                    if (value !== null) {
                        const keyBuf = Buffer.from(key, 'utf-8');
                        const valBuf = Buffer.from(value);
                        entries.push({ keyBuf, valBuf });
                        totalSize += 4 + keyBuf.length + 4 + valBuf.length;
                    }
                }
            }
            const out = Buffer.allocUnsafe(totalSize);
            let offset = 0;
            out.writeUInt32BE(entries.length, offset); offset += 4;
            for (const { keyBuf, valBuf } of entries) {
                out.writeUInt32BE(keyBuf.length, offset); offset += 4;
                keyBuf.copy(out, offset); offset += keyBuf.length;
                out.writeUInt32BE(valBuf.length, offset); offset += 4;
                valBuf.copy(out, offset); offset += valBuf.length;
            }
            return c.body(out, 200, { 'Content-Type': 'application/octet-stream'});
        } else {
            // Legacy JSON+base64 fallback
            const results = [];
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = kvGet(key);
                    }
                    if (value !== null) {
                        results.push({ key, value: Buffer.from(value).toString('base64') });
                    }
                }
            }
            return c.json(results);
        }
    } catch(error){ throw error; }
});

assetApp.post('/bulk-write', async (c, next) => {
    // if(!await checkAuth(req, res)){ return; }
    // if (!checkActiveSession(req, res)) return;
    try {
        const entries = c.req.raw.body; // {key: string, value: base64}[]
        if(!Array.isArray(entries)){
          return c.json({ error: 'Body must be a JSON array of {key, value}' }, 400);
        }
        for(let i = 0; i < entries.length; i += BULK_BATCH){
            const batch = entries.slice(i, i + BULK_BATCH);
            const writeBatch = sqliteDb.transaction(() => {
                for(const { key, value } of batch){
                    kvSet(key, Buffer.from(value, 'base64'));
                }
            });
            writeBatch();
        }
        return c.json({ success: true, count: entries.length });
    } catch(error){ throw error; }
});

