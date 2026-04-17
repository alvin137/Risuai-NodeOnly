import path from "node:path";
import { readFile, stat, access, readdir, mkdir, statfs} from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
// import { sessionAuthMiddleware } from "./session.js";
import sharp from "sharp";
import { Hono } from "hono";

import { savePath } from "../utils/util.js";
import { kvGet, kvGetUpdatedAt } from "../utils/db.js";

const inlayDir = path.join(savePath, 'inlays')
const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs')

// ── Direct asset serving (F-1) ─────────────────────────────────────────────
// Serves KV-stored assets as proper HTTP responses with long-term caching.
// Key is hex-encoded to safely pass through URL. Auth via session cookie.
//
// Storage formats differ by key prefix:
//   assets/*        → raw binary (Uint8Array)
//   inlay/*         → JSON { data: "data:<mime>;base64,...", ext, type, ... }
//   inlay_thumb/*   → JSON { data: "data:<mime>;base64,...", ext, type, ... }

/**
 * Extract raw binary and content-type from a KV value.
 * Handles both raw binary (assets/) and JSON+base64 wrapped (inlay/) formats.
 */
function resolveAssetPayload(key: string, rawValue: Buffer) {
    // inlay/ and inlay_thumb/ keys store JSON with base64 data URI
    if (key.startsWith('inlay/') || key.startsWith('inlay_thumb/')) {
        try {
            const json = JSON.parse(rawValue.toString('utf-8'))
            const dataUri = json.data
            if (typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                // Parse "data:<mime>;base64,<payload>"
                const commaIdx = dataUri.indexOf(',')
                const meta = dataUri.substring(5, commaIdx) // after "data:"
                const mime = meta.split(';')[0]
                const binary = Buffer.from(dataUri.substring(commaIdx + 1), 'base64')
                return { binary, contentType: mime || 'application/octet-stream' }
            }
            // Fallback: ext field
            const ext = (json.ext || '').toLowerCase()
            const mime = ASSET_EXT_MIME[ext] || 'application/octet-stream'
            return { binary: rawValue, contentType: mime }
        } catch {
            // JSON parse failed — treat as raw binary
        }
    }

    // assets/* and others: raw binary
    const ext = key.split('.').pop()?.toLowerCase()
    if (!ext) return { binary: rawValue, contentType: 'application/octet-stream' }
    const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue)
    return { binary: rawValue, contentType }
}

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 75;
const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

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

async function generateThumbnail(buffer: Buffer) {
    return sharp(buffer)
        .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toBuffer();
}



// MIME detection by magic bytes (fallback when key has no extension)
function detectMime(buf: Buffer) {
    if (!buf || buf.length < 12) return 'application/octet-stream'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
    if (buf[0] === 0x1a && buf[1] === 0x45) return 'video/webm'
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'
    return 'application/octet-stream'
}
const ASSET_EXT_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
}

async function checkDiskSpace(requiredBytes: number) {
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const stats = await statfs(saveDir);
        const availableBytes = stats.bavail * stats.bsize;
        return { ok: availableBytes >= requiredBytes, available: availableBytes };
    } catch {
        // statfs unavailable on this platform — skip check
        return { ok: true, available: -1 };
    }
}

async function readInlayFile(id: string) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return null;
    const ext = normalizeInlayExt(path.extname(filePath).slice(1));
    const buffer = await readFile(filePath);
    const stats = await stat(filePath);
    return {
        buffer,
        ext,
        filePath,
        mtimeMs: stats.mtimeMs,
        mime: getMimeFromExt(ext, buffer),
    };
}

async function resolveInlayFilePath(id: string) {
    if (!isSafeInlayId(id)) return null;
    const sidecar = await readInlaySidecar(id);
    if (sidecar) {
        const candidate = getInlayFilePath(id, sidecar.ext);
        try { await access(candidate); return candidate; } catch {}
    }
    // Fallback: scan directory (covers pre-sidecar files or mismatched ext)
    try {
        const entries = await readdir(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

async function readInlaySidecar(id: string) {
    try {
        const raw = await readFile(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

function isSafeInlayId(id: string) {
    return typeof id === 'string' &&
        id.length > 0 &&
        !id.includes('\0') &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..';
}

function normalizeInlayExt(ext: string) {
    if (typeof ext !== 'string') return 'bin';
    const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
    return normalized || 'bin';
}

const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

function assertInsideInlayDir(filePath: string) {
    if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
        throw new Error(`Path escapes inlay directory: ${filePath}`);
    }
}

function getInlayFilePath(id: string, ext: string) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
    assertInsideInlayDir(p);
    return p;
}

function getInlaySidecarPath(id: string) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.meta.json`);
    assertInsideInlayDir(p);
    return p;
}

async function ensureInlayDir() {
    await mkdir(inlayDir, { recursive: true });
}

function ensureInlayDirSync() {
    if (!existsSync(inlayDir)) {
        mkdirSync(inlayDir, { recursive: true });
    }
}

function getMimeFromExt(ext: string, buffer: Buffer) {
  return ASSET_EXT_MIME[normalizeInlayExt(ext)] || detectMime(buffer);
}
