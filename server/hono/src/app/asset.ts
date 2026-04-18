// import { sessionAuthMiddleware } from "./session.js";
import { Hono } from "hono";

import { kvGet, kvGetUpdatedAt } from "../utils/db.js";
import { readInlayFile, readInlaySidecar, resolveAssetPayload, THUMB_IMAGE_EXTS, generateThumbnail } from "../utils/asset.util.js";


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

