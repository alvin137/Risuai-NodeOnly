import { Hono } from "hono";
import { kvDel, kvList } from "../utils/db.js"
import { savePath } from "../utils/util.js";
import { listInlayFiles, readInlaySidecar, writeInlayFile } from "../utils/asset.util.js";
import "./asset.js";
import { registerCrud } from "./api/crud.js";

import path from "node:path";
import fs from "node:fs/promises";
import { streamSSE } from "hono/streaming";
import sharp from "sharp";
import { registerUpdateApi } from "./api/update.js";


const api = new Hono();

//api.route("/patch", patchApp);


registerCrud(api);
registerUpdateApi(api);

// TODO: Need to setup rateLimit



api.get('/list', async (c) => {

    const keyPrefix = c.req.header('key-prefix') ?? '';
    const data = await getKeysByPrefix(keyPrefix);

    return c.json({ success: true, content: data });
});




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

export default api;