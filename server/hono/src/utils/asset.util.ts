import path from "node:path";
import { readFile, stat, access, readdir, mkdir, statfs, writeFile, unlink} from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { decodeRisuSave, encodeRisuSaveLegacy, hasRemoteBlocks, normalizeJSON, savePath } from "./util"
import { kvCopyValue, kvDel, kvGet, kvList, kvListWithSizes, kvSet, kvSize, db as sqliteDb } from "./db";
import { randomUUID } from "node:crypto";

// In-memory database cache for patch-based sync
// dbCache stores the STRIPPED (stubs-only) version matching what the client sees.
// fullChatStore keeps the actual chat data keyed by chaId→chatId.
export let dbCache: Record<string, unknown> = {};
export let saveTimers: Record<string, NodeJS.Timeout> = {};
export const SAVE_INTERVAL = 5000;
export const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');

const inlayDir = path.join(savePath, 'inlays')
const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs')

export let fullChatStore: Map<string, Map<string, unknown>> | null = null; // Map<chaId, Map<chatId, chatObject>> — lazy-initialized

// ETag for database.bin
let dbEtag: string | null = null;

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];
// Slightly above 2GB BLOB ceiling — better-sqlite3 throws RangeError near INT_MAX.
const BLOB_INT_MAX = 2 * 1024 * 1024 * 1024 - 1;


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
export function resolveAssetPayload(key: string, rawValue: Buffer) {
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
    const detected = detectMime(rawValue);
    const contentType = detected !== "application/octet-stream" ? detected : (ASSET_EXT_MIME[ext] || detected);
    return { binary: rawValue, contentType }
}

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 75;
export const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export async function generateThumbnail(buffer: Buffer) {
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


export async function readInlayFile(id: string) {
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

function resolveInlayFilePathSync(id: string) {
    if (!isSafeInlayId(id)) return null;
    try {
        const raw = readFileSync(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        const ext = normalizeInlayExt(parsed?.ext);
        const candidate = getInlayFilePath(id, ext);
        if (existsSync(candidate)) return candidate;
    } catch {}
    // Fallback: scan directory
    try {
        const entries = readdirSync(inlayDir, { withFileTypes: true });
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

export async function writeInlaySidecar(id: string, info: any) {
    await ensureInlayDir();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    await writeFile(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

function writeInlaySidecarSync(id: string, info: any) {
    ensureInlayDirSync();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    writeFileSync(getInlaySidecarPath(id), JSON.stringify(sidecar));
}


//TODO: Fix any
export async function writeInlayFile(id: string, ext: string, buffer: Buffer, info: any = null) {
    await ensureInlayDir();
    await deleteInlayRawFile(id);
    const normalizedExt = normalizeInlayExt(ext);
    await writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    await writeInlaySidecar(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

//TODO: Fix any
export function writeInlayFileSync(id: string, ext: string, buffer: Buffer, info: any = null) {
    ensureInlayDirSync();
    deleteInlayRawFileSync(id);
    const normalizedExt = normalizeInlayExt(ext);
    writeFileSync(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    writeInlaySidecarSync(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

async function deleteInlayRawFile(id: string) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return;
    await unlink(filePath).catch(() => {});
}

function deleteInlayRawFileSync(id: string) {
    const filePath = resolveInlayFilePathSync(id);
    if (!filePath) return;
    try {
        unlinkSync(filePath);
    } catch {
        // ignore
    }
}

export async function deleteInlayFile(id: string) {
    await deleteInlayRawFile(id);
    await unlink(getInlaySidecarPath(id)).catch(() => {});
}

function deleteInlayFileSync(id: string) {
    deleteInlayRawFileSync(id);
    try {
        unlinkSync(getInlaySidecarPath(id));
    } catch {
        // ignore
    }
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

export async function readInlaySidecar(id: string) {
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

export function isSafeInlayId(id: string) {
    return typeof id === 'string' &&
        id.length > 0 &&
        !id.includes('\0') &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..';
}

export function normalizeInlayExt(ext: string) {
    if (typeof ext !== 'string') return 'bin';
    const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
    return normalized || 'bin';
}

const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

export function assertInsideInlayDir(filePath: string) {
    if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
        throw new Error(`Path escapes inlay directory: ${filePath}`);
    }
}

export function getInlayFilePath(id: string, ext: string) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
    assertInsideInlayDir(p);
    return p;
}

export function getInlaySidecarPath(id: string) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.meta.json`);
    assertInsideInlayDir(p);
    return p;
}

export async function ensureInlayDir() {
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

export function computeBufferEtag(buffer: Buffer) {
  const hasher = new Bun.CryptoHasher('md5');
  return hasher.update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject: any) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

let storageOperationQueue = Promise.resolve();
export function queueStorageOperation(operation: () => Promise<any>) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}



// ─── Server-side database backup ─────────────────────────────────────────────
const BACKUP_BUDGET_BYTES = 500 * 1024 * 1024; // 500 MB
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastBackupTime: number | null = null;

export function createBackupAndRotate() {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    lastBackupTime = now;

    const backupKey = `${DB_BACKUP_PREFIX}${(now / 100).toFixed()}.bin`;
    kvCopyValue('database/database.bin', backupKey);

    trimSnapshotsToLimits();
}

export function decodeDataUri(dataUri: string) {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        throw new Error('Invalid data URI');
    }
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) {
        throw new Error('Malformed data URI');
    }
    const meta = dataUri.substring(5, commaIdx);
    return {
        buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
        mime: meta.split(';')[0] || 'application/octet-stream',
    };
}

function encodeDataUri(buffer: Buffer, mime: string) {
    return `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
}

export async function flushPendingDb() {
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
        if (dbCache[DB_HEX_KEY]) {
            await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
        } else if (fullChatStore && fullChatStore.size > 0) {
            // No stripped cache but chat store has data — merge and persist directly
            const raw = kvGet('database/database.bin');
            if (raw) {
                const dbObj = normalizeJSON(await decodeRisuSave(raw));
                const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
            }
        }
        createBackupAndRotate();
    }
}

async function readInlayLegacyInfo(id: string) {
    const value = kvGet(`inlay_info/${id}`);
    if (!value) return null;
    try {
        const parsed = JSON.parse(value.toString('utf-8'));
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

export async function readInlayInfoPayload(id: string) {
    const sidecar = await readInlaySidecar(id);
    if (sidecar) return Buffer.from(JSON.stringify(sidecar));
    const legacy = await readInlayLegacyInfo(id);
    if (legacy) return Buffer.from(JSON.stringify(legacy));
    return kvGet(`inlay_info/${id}`);
}

export async function readInlayAssetPayload(id: string) {
    const file = await readInlayFile(id);
    if (!file) return null;
    const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
    const info = {
        ext: sidecar?.ext || file.ext,
        name: sidecar?.name || id,
        type: sidecar?.type || 'image',
        height: sidecar?.height,
        width: sidecar?.width,
    };
    const data = info.type === 'signature'
        ? file.buffer.toString('utf-8')
        : encodeDataUri(file.buffer, file.mime);
    return Buffer.from(JSON.stringify({
        ...info,
        data,
    }));
}

export async function migrateInlaysToFilesystem() {
    await ensureInlayDir();
    if (existsSync(inlayMigrationMarker)) return;

    const keys = kvList('inlay/');
    for (const key of keys) {
        const id = key.slice('inlay/'.length);
        if (!isSafeInlayId(id)) continue;
        const fileAlreadyExists = await readInlayFile(id);
        if (fileAlreadyExists) {
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            continue;
        }
        const value = kvGet(key);
        if (!value) continue;
        try {
            const parsed = JSON.parse(value.toString('utf-8'));
            const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
            const ext = normalizeInlayExt(parsed?.ext);
            let buffer;
            if (type === 'signature') {
                buffer = Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8');
            } else {
                buffer = decodeDataUri(parsed?.data).buffer;
            }
            const info = (await readInlayLegacyInfo(id)) || {
                ext,
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type,
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
            await writeInlayFile(id, ext, buffer, info);
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
        } catch (error) {
            console.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
        }
    }

    await writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
}


/**
 * Ensure fullChatStore is initialized. Loads from disk if needed.
 */
export async function ensureChatStore() {
    if (fullChatStore) return;
    // Run remote-block migration first so the decode below sees an inline DB.
    // Idempotent — skipped on every subsequent call.
    await migrateRemoteBlocksIfNeeded();
    const raw = kvGet('database/database.bin');
    if (!raw) {
        fullChatStore = new Map();
        return;
    }
    const dbObj = await decodeDatabaseWithPersistentChatIds(raw, {
        createBackup: true,
    });
    initChatStore(dbObj);
}

// Stub metadata fields a JSON Patch may legitimately touch on a `chats[i]`
// entry. Anything else is a chat-internal field — those live in fullChatStore,
// not in dbCache, and should never appear in a /api/patch payload. Keep in
// sync with chatToStub on both server and client.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only add/replace/remove are produced by the legitimate patcher. move/copy
// could alias _stub or other chat-internal fields through `from`, bypassing
// the path-based field allowlist. Reject those op types outright on chat
// paths. test ops can also reveal/manipulate state; deny for symmetry.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove']);

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/;

/**
 * Detect JSON Patch ops that mutate chat-internal fields (anything beyond
 * STUB_METADATA_FIELDS). Such ops are the loss vector: applying them to
 * dbCache leaves a metadata-only chat without `_stub`, which then bypasses
 * fullChat merge in reassembleFullDb and gets persisted as-is.
 *
 * Whole-chat ops (path = `/characters/N/chats/M` or `/characters/N/chats`)
 * are allowed — those replace/add/remove chat slots wholesale and the
 * reassemble guard takes care of validating the resulting state.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Any op that could
 * remove the flag or set it to a falsy value is itself the loss mechanism
 * (reassembleFullDb skips merge when `_stub` is falsy), so it must be
 * blocked at the patch boundary, not just at the persist boundary.
 *
 * `move`/`copy` ops are rejected wholesale on chat-internal paths because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
export function findChatInternalFieldOps(patch) {
    if (!Array.isArray(patch)) return [];
    const violations = [];
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue;

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE);
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null;
        if (!pathMatch && !fromMatch) continue;

        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: (pathMatch && pathMatch[1]) || (fromMatch && fromMatch[1]) || '',
                reason: 'disallowed op type on chat field',
            });
            continue;
        }

        if (pathMatch) {
            const field = pathMatch[1];
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field });
                continue;
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' });
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' });
                }
            }
        }
    }
    return violations;
}

/**
 * Detect chats that lost their `_stub` flag without being upgraded to a real
 * Chat. reassembleFullDb skips merge when `_stub` is falsy, so persisting such
 * a chat would write metadata-only to disk and silently strip messages — the
 * exact data-loss path reported with PATCH `remove /chats/N/{message,...}` ops.
 *
 * A real Chat has `message` (Array). A real stub has `_stub === true`. Anything
 * with neither is a malformed in-between state; treat as a corruption signal.
 */
export function findStubFlagLossChats(fullDb) {
    if (!fullDb?.characters) return [];
    const losses = [];
    for (let ci = 0; ci < fullDb.characters.length; ci++) {
        const char = fullDb.characters[ci];
        if (!char?.chats) continue;
        for (let chi = 0; chi < char.chats.length; chi++) {
            const chat = char.chats[chi];
            if (!chat || typeof chat !== 'object') continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            if (!isStub && !hasMessage) {
                losses.push({
                    chaId: char.chaId,
                    charIndex: ci,
                    chatIndex: chi,
                    chatId: chat.id || null,
                });
            }
        }
    }
    return losses;
}

/**
 * Persist dbCache to disk with full chats merged back in.
 */
export async function persistDbCacheWithChats(filePath: string, decodedKey: string) {
    const strippedDb = dbCache[filePath];
    if (!strippedDb) return;
    await ensureChatStore();
    const fullDb = reassembleFullDb(strippedDb);
    // Disk protection guard: abort persist when reassemble produced metadata-only
    // chats. Writing them would lock the loss in (next /api/read returns the
    // stripped chat with no `_stub`, so hydration never re-merges fullChatStore).
    // Invalidate dbCache so the next request re-reads from disk and rebuilds a
    // consistent stub view; client receives 409 on next /api/patch via hash mismatch.
    if (decodedKey === 'database/database.bin') {
        const losses = findStubFlagLossChats(fullDb);
        if (losses.length > 0) {
            const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
            const err = new Error(
                `persist aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                + `would silently strip messages on disk. sample=[${sample}]`
            );
            recordPersistFailure(err, 'persistDbCacheWithChats:stub-flag-loss');
            delete dbCache[filePath];
            throw err;
        }
    }
    const data = Buffer.from(encodeRisuSaveLegacy(fullDb));
    try {
        kvSet(decodedKey, data);
    } catch (err) {
        // Tag with BLOB size so the visibility layer can surface it to the user.
        // The dominant failure mode (better-sqlite3 INT_MAX) is size-driven.
        if (err && typeof err === 'object') {
            try { err.attemptedSize = data.length; } catch {}
        }
        throw err;
    }
    // Refresh fullChatStore from the persisted snapshot so subsequent
    // /api/chat-content GETs return the same metadata (folderId, modules)
    // that just hit disk. Without this, PATCH-only clears of stub fields
    // leave fullChatStore holding stale fullChat objects, and hydration
    // would resurrect the cleared values until the next /api/read.
    if (decodedKey === 'database/database.bin') {
        initChatStore(fullDb);
    }
}

/**
 * Convert a full chat to a stub (metadata only).
 *
 * Hybrid corruption guard: a chat carrying `_stub: true` AND a real `message`
 * array is the v1.4.x legacy hybrid pattern. The fast-path "if _stub return"
 * would propagate the corruption (server reassemble skips merge for _stub
 * chats with no fullChat lookup match). Treat hybrids as real chats and
 * collapse them to a real stub here.
 */
function chatToStub(chat: any) {
    if (!chat) return chat;
    if (chat._stub && !Array.isArray(chat.message)) return chat;
    const stub: Record<string, any> = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    // Preserve key presence even when the value is null/undefined so the
    // round-trip distinguishes "user cleared" from "field absent". See
    // mergeChatStubWithFullChat — it relies on `in` semantics.
    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
    if ('folderId' in chat) stub.folderId = chat.folderId;
    if ('modules' in chat) stub.modules = chat.modules;
    return stub;
}

/**
 * Initialize fullChatStore from a decoded full database object.
 * Extracts all chat payloads into the store keyed by chaId → chatId.
 *
 * Hybrid corruption recovery: a chat with both `_stub: true` and a real
 * message array is treated as a real chat (its fullChat data is intact).
 * Strip the `_stub` flag in place so subsequent reassemble passes don't
 * reproduce the hybrid on disk.
 */
export function initChatStore(dbObj: any) {
    fullChatStore = new Map();
    if (!dbObj?.characters) return;
    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const charChats = new Map();
        for (const chat of char.chats) {
            if (!chat) continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            // Real stub (no payload) — fullChatStore tracks payloads only.
            if (isStub && !hasMessage) continue;
            // Hybrid: strip the corrupt _stub flag, keep the real chat.
            if (isStub && hasMessage) {
                delete chat._stub;
            }
            if (!chat.id) {
                chat.id = randomUUID();
            }
            charChats.set(chat.id, chat);
        }
        if (charChats.size > 0) {
            fullChatStore.set(char.chaId, charChats);
        }
    }
}

/**
 * Strip full chat data from a decoded database object, replacing with stubs.
 * Returns a new object — does not mutate input.
 */
export function stripChatsFromDb(dbObj: any) {
    if (!dbObj?.characters) return dbObj;
    const stripped = { ...dbObj };
    stripped.characters = dbObj.characters.map((char: any) => {
        if (!char?.chats) return char;
        return { ...char, chats: char.chats.map(chatToStub) };
    });
    return stripped;
}

/**
 * Reassemble a full database from a stripped DB + fullChatStore.
 * Replaces stubs with full chats from the store. Returns a new object.
 */
function mergeChatStubWithFullChat(stub: any, fullChat: any) {
    if (!fullChat) {
        return stub;
    }
    if (!stub || !stub._stub) {
        return fullChat;
    }
    const merged = {
        ...fullChat,
        id: stub.id || fullChat.id || '',
        name: stub.name,
    };
    // Defensive: never let `_stub: true` ride along on a merged chat. If
    // fullChat carries a stale flag (legacy disk corruption), the spread
    // would propagate the hybrid pattern back to disk and re-trigger the
    // chat-data loss path on next round-trip.
    if ('_stub' in merged) delete merged._stub;
    // Use key presence (`in`) so an explicit null/undefined from the client —
    // meaning "user cleared this field" — overwrites fullChat. The previous
    // `!= null` check conflated "cleared" with "absent" and silently kept
    // stale folderId / modules on disk, producing orphan-folder chats.
    if ('lastDate' in stub) merged.lastDate = stub.lastDate;
    if ('folderId' in stub) merged.folderId = stub.folderId;
    if ('modules' in stub) merged.modules = stub.modules;
    return merged;
}

export function reassembleFullDb(strippedDb: any) {
    if (!strippedDb?.characters || !fullChatStore) return strippedDb;
    const full = { ...strippedDb };
    full.characters = strippedDb.characters.map((char: any) => {
        if (!char?.chaId || !char.chats) return char;
        const charChats = fullChatStore!.get(char.chaId);
        if (!charChats) return char;
        return {
            ...char,
            chats: char.chats.map((chat: any) => {
                if (chat && chat._stub && chat.id) {
                    return mergeChatStubWithFullChat(chat, charChats.get(chat.id));
                }
                return chat;
            }),
        };
    });
    return full;
}

// ─── Chat runtime lazy load helpers ─────────────────────────────────────────

function assignMissingChatIds(dbObj: any) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        for (const chat of char.chats) {
            if (!chat || chat._stub || chat.id) continue;
            chat.id = randomUUID();
            changed = true;
        }
    }
    return changed;
}

export function isInvalidBackupPathSegment(name: string) {
    return (
        !name ||
        name.includes('\0') ||
        name.includes('\\') ||
        name.startsWith('/') ||
        name.includes('../') ||
        name.includes('/..') ||
        name === '.' ||
        name === '..'
    );
}

export function normalizeColdStorageStorageKey(nameOrKey: string) {
    let key = nameOrKey;
    if (key.startsWith('coldstorage/')) {
        key = key.slice('coldstorage/'.length);
    }
    if (key.endsWith('.json')) {
        key = key.slice(0, -'.json'.length);
    }
    if (!key || key.includes('/') || isInvalidBackupPathSegment(key)) {
        throw new Error(`Invalid cold storage entry name: ${nameOrKey}`);
    }
    return `coldstorage/${key}`;
}

export function toColdStorageBackupName(storageKey: string) {
    return `${normalizeColdStorageStorageKey(storageKey)}.json`;
}

export function parseColdStorageJsonBuffer(buffer: Buffer, sourceLabel: string, options: { allowPlainJson?: boolean } = {}) {
    const { allowPlainJson = false } = options;
    try {
        const decompressed = Bun.gunzipSync(buffer as Uint8Array<ArrayBuffer>);
        return {
            coldData: JSON.parse(decompressed.toString()),
            format: 'gzip',
        };
    } catch (gzipError) {
        if (!allowPlainJson) {
            throw gzipError;
        }
        try {
            return {
                coldData: JSON.parse(buffer.toString('utf-8')),
                format: 'plain-json',
            };
        } catch (jsonError) {
            // @ts-ignore Just error objects don't always have .message
            throw new Error(`[ColdStorage] failed to parse ${sourceLabel}: gzip=${gzipError.message}; json=${jsonError.message}`);
        }
    }
}

export function encodeColdStorageCanonicalBuffer(coldData: any) {
    return Buffer.from(Bun.gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8')));
}

export function readColdStorageJsonEntry(nameOrKey: string, options: { migrateLegacy?: boolean; allowPlainJsonFallback?: boolean } = {}): any {
    const { migrateLegacy = false, allowPlainJsonFallback = false } = options;
    const canonicalKey = normalizeColdStorageStorageKey(nameOrKey);
    const legacyBackupKey = `${canonicalKey}.json`;

    let storageKey = canonicalKey;
    let value = kvGet(canonicalKey);
    if (!value) {
        storageKey = legacyBackupKey;
        value = kvGet(legacyBackupKey);
    }
    if (!value) {
        return null;
    }

    const parsed = parseColdStorageJsonBuffer(value, storageKey, {
        allowPlainJson: allowPlainJsonFallback || storageKey !== canonicalKey,
    });

    if (migrateLegacy && (storageKey !== canonicalKey || parsed.format !== 'gzip')) {
        kvSet(canonicalKey, encodeColdStorageCanonicalBuffer(parsed.coldData));
        if (storageKey !== canonicalKey) {
            kvDel(storageKey);
        }
    }

    return {
        coldData: parsed.coldData,
        storageKey,
        canonicalKey,
        format: parsed.format,
    };
}

// ── Chat content endpoints (runtime lazy load) ─────────────────────────────

// Cold storage compatibility: restore data stored in coldstorage/ KV entries
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

function restoreColdStorageCharacter(character: any) {
    if (!character?.coldstorage) return true;
    const key = character.coldstorage;
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        console.error(`[ColdStorage] character data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (coldData?.character) {
            Object.assign(character, coldData.character);
            delete character.coldstorage;
            delete character.coldStoragedChats;
        } else {
            console.error(`[ColdStorage] unexpected character cold data format for key: ${key}`);
            return false;
        }
        return true;
    } catch (err) {
        // @ts-ignore
        console.error(`[ColdStorage] character restore failed for key ${key}:`, err.message);
        return false;
    }
}

function promoteFailedColdStorageStub(char: any) {
    const coldKey = char.coldstorage;
    // Fill in missing fields with safe defaults matching createBlankChar() in src/ts/characters.ts.
    // SYNC: if createBlankChar() defaults change, update this object to match.
    const defaults = {
        firstMessage: '', desc: '', notes: '', chatFolders: [],
        emotionImages: [], bias: [], viewScreen: 'none', globalLore: [],
        sdData: [
            ['always', 'solo, 1girl'], ['negative', ''],
            ["|character's appearance", ''], ['current situation', ''],
            ["$character's pose", ''], ["$character's emotion", ''],
            ['current location', ''],
        ],
        utilityBot: false, customscript: [], exampleMessage: '',
        creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
        alternateGreetings: [], tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '',
        firstMsgIndex: -1,
        replaceGlobalNote: '', additionalText: '',
        triggerscript: [
            { comment: '', type: 'manual', conditions: [], effect: [{ type: 'v2Header', code: '', indent: 0 }] },
            { comment: 'New Event', type: 'manual', conditions: [], effect: [] },
        ],
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (char[key] === undefined || char[key] === null) {
            char[key] = value;
        }
    }
    // Force firstMsgIndex to -1 even if stub had 0 — prevents alternateGreetings[0] access on empty array
    char.firstMsgIndex = -1;
    // Ensure chats array is valid
    if (!Array.isArray(char.chats) || char.chats.length === 0) {
        char.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [] }];
    }
    // Leave recovery breadcrumb and remove cold storage markers
    char.desc = `[Cold storage restore failed. Original key: ${coldKey}]\n\n${char.desc || ''}`.trim();
    delete char.coldstorage;
    delete char.coldStoragedChats;
}

export function restoreColdStorageCharactersInDb(dbObj: any) {
    const result: { restored: number, failed: number, failedNames: string[] } = { restored: 0, failed: 0, failedNames: [] };
    if (!Array.isArray(dbObj?.characters)) return result;
    for (let i = 0; i < dbObj.characters.length; i++) {
        const char = dbObj.characters[i];
        if (!char?.coldstorage) continue;
        if (restoreColdStorageCharacter(char)) {
            result.restored++;
        } else {
            result.failed++;
            result.failedNames.push(char.name || `(index ${i})`);
            promoteFailedColdStorageStub(char);
        }
    }
    return result;
}

function isColdStorageChat(chat: any) {
    return chat?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER);
}

export function restoreColdStorageChat(chat: any) {
    if (!isColdStorageChat(chat)) return true;
    const key = chat.message[0].data.slice(COLD_STORAGE_HEADER.length);
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        console.error(`[ColdStorage] data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (Array.isArray(coldData)) {
            chat.message = coldData;
        } else if (coldData?.message) {
            chat.message = coldData.message;
            if (coldData.hypaV3Data) chat.hypaV3Data = coldData.hypaV3Data;
            if (coldData.scriptstate) chat.scriptstate = coldData.scriptstate;
            if (coldData.localLore) chat.localLore = coldData.localLore;
        }
        chat.lastDate = Date.now();
        return true;
    } catch (err) {
        // @ts-ignore
        console.error(`[ColdStorage] restore failed for key ${key}:`, err.message);
        return false;
    }
}

// Recovers chats whose folderId points to a deleted folder. The previous merge
// layer silently kept stale folderId on disk when a user moved a chat out of a
// folder, then later deleting that folder produced orphans invisible in the
// sidebar (rendered into neither the no-folder section nor any folder section).
// Boot-time normalize so historical corruption self-heals; new corruption is
// blocked by the merge fix in mergeChatStubWithFullChat.
function normalizeOrphanFolderIds(dbObj: any) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        const validIds = new Set((char.chatFolders ?? []).map(f => f?.id).filter(Boolean));
        for (const chat of char.chats) {
            if (!chat) continue;
            if (chat.folderId && !validIds.has(chat.folderId)) {
                chat.folderId = null;
                changed = true;
            }
        }
    }
    return changed;
}


export async function decodeDatabaseWithPersistentChatIds(raw: Uint8Array, options: { createBackup?: boolean; migrationResult?: any } = {}) {
    const { createBackup = false, migrationResult = null } = options;
    // Convert legacy REMOTE-block layouts to inline format before decoding.
    // If migration ran it overwrote database.bin, so the caller's `raw` is
    // stale and we re-read from KV. Idempotent on the no-op path.
    const migration = await migrateRemoteBlocksIfNeeded();
    if (migration.ran) {
        const fresh = kvGet('database/database.bin');
        if (fresh) raw = fresh;
    }

    const dbObj = normalizeJSON(await decodeRisuSave(raw));
    let needsPersist = false;

    const hadMissingIds = assignMissingChatIds(dbObj);
    if (hadMissingIds) needsPersist = true;

    const hadOrphanFolderIds = normalizeOrphanFolderIds(dbObj);
    if (hadOrphanFolderIds) needsPersist = true;

    // One-time migration: restore upstream cold storage characters to full characters.
    // This runs when upstream data first enters NodeOnly (backup import or save folder copy).
    // After restore, the coldstorage field is removed and the clean DB is persisted.
    // Failed characters are promoted to safe blank characters — their KV data is preserved for manual recovery.
    const coldRestoreResult = restoreColdStorageCharactersInDb(dbObj);
    if (coldRestoreResult.restored > 0 || coldRestoreResult.failed > 0) needsPersist = true;
    if (coldRestoreResult.failed > 0) {
        console.error(`[ColdStorage] ${coldRestoreResult.failed} character(s) could not be restored and were converted to safe blank characters. Cold storage KV data is preserved.`);
        for (const name of coldRestoreResult.failedNames) {
            console.error(`[ColdStorage]   - "${name}"`);
        }
    }

    if (needsPersist) {
        kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(dbObj)));
        if (createBackup) {
            createBackupAndRotate();
        }
    }
    if (migrationResult) {
        migrationResult.coldStorageFailed = coldRestoreResult.failed;
    }
    return dbObj;
}

export async function listInlayFiles() {
    await ensureInlayDir();
    const entries = await readdir(inlayDir, { withFileTypes: true });
    return entries
        .filter((entry) => (
            entry.isFile() &&
            entry.name !== '.migrated_to_fs' &&
            !entry.name.endsWith('.meta.json')
        ))
        .map((entry) => {
            const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
            const id = entry.name.slice(0, -(ext.length + 1));
            return { id, ext, filePath: path.join(inlayDir, entry.name) };
        })
        .filter((entry) => isSafeInlayId(entry.id));
}

export function invalidateDbCache() {
    delete dbCache[DB_HEX_KEY];
    fullChatStore = null;
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
    }
    // Should handle dbEtag
    setDbetag(null);
}

export async function readAndLoadValue(key: string) {
    // Flush pending patches before reading database.bin
    if (key === "database/database.bin") {
      await flushPendingDb();
    }

    let value = null;
    if (key.startsWith("inlay/")) {
      value = await readInlayAssetPayload(key.slice("inlay/".length));
    } else if (key.startsWith("inlay_info/")) {
      value = await readInlayInfoPayload(key.slice("inlay_info/".length));
    } else {
      value = kvGet(key);
    }

    return value;
}

export function setDbCache(key: string, value: unknown) {
    dbCache[key] = value;
}

// Returns stripped data from the database
export async function getStrippedData(value: Buffer, filePath: string) {
  const dbObj = await decodeDatabaseWithPersistentChatIds(value, {
    createBackup: true,
  });
  initChatStore(dbObj);
  const stripped = normalizeJSON(stripChatsFromDb(dbObj));
  // Populate dbCache so patch endpoint uses the same data
  setDbCache(filePath, stripped);

  return stripped;
}

export function setDbetag(etag: string | null) {
    dbEtag = etag;
}

export function getDbetag() {
    return dbEtag;
}

// ─── Persist failure tracking (Stage 1 visibility) ───────────────────────────
// Debounced persist runs in setTimeout, so failures cannot be returned in the
// triggering response. Record the latest failure here and surface it on the
// next /api/patch response. Cleared on next successful persist.
let lastPersistFailure = null;

export function recordPersistFailure(error, source) {
    const message = String(error?.message || error || 'unknown error');
    const attemptedSize = typeof error?.attemptedSize === 'number' ? error.attemptedSize : null;
    // Preserve timestamp when the failure is identical to the last one — every
    // debounce cycle re-records the same failure, and clients dedupe by ts.
    // Without this guard a fresh ts every 5s would re-fire the toast.
    if (lastPersistFailure
        && lastPersistFailure.source === source
        && lastPersistFailure.message === message
        && lastPersistFailure.attemptedSize === attemptedSize) {
        return;
    }
    lastPersistFailure = {
        timestamp: Date.now(),
        message,
        attemptedSize,
        source,
    };
}

export function clearPersistFailure() {
    lastPersistFailure = null;
}

export function currentPersistWarning() {
    return lastPersistFailure;
}

// ─── Server-side database backup (DB-only snapshots) ────────────────────────
//
// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
export const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
export const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
export const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
export const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024; // 500 MB
// Safety bounds to keep a stray PUT from making the system unusable.
export const SNAPSHOT_LIMIT_MIN_COUNT = 1;
export const SNAPSHOT_LIMIT_MAX_COUNT = 100;
export const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;        // 10 MB
export const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

function readSnapshotConfigInt(key, fallback, min, max) {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        const n = parseInt(Buffer.from(raw).toString('utf-8').trim(), 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    } catch { return fallback; }
}

export function getSnapshotLimits() {
    return {
        maxCount: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_DEFAULT_COUNT,
            SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MAX_COUNT,
        ),
        maxBytes: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_DEFAULT_BYTES,
            SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES,
        ),
    };
}

// Walk newest → oldest; keep within both limits, delete the rest. The most
// recent snapshot is always kept (even if it alone exceeds the byte limit) so
// we never end up with zero backups after a config change.
export function trimSnapshotsToLimits() {
    const { maxCount, maxBytes } = getSnapshotLimits();
    const entries = kvListWithSizes(DB_BACKUP_PREFIX)
        .map((it) => {
            const tsRaw = parseInt(it.key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            return { key: it.key, size: it.size, ts: Number.isFinite(tsRaw) ? tsRaw : 0 };
        })
        .sort((a, b) => b.ts - a.ts);

    let runningBytes = 0;
    const toDelete = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e == null) continue;
        const isFirst = i === 0;
        const fitsByCount = i < maxCount;
        const fitsByBytes = runningBytes + e.size <= maxBytes;
        if (isFirst || (fitsByCount && fitsByBytes)) {
            runningBytes += e.size;
        } else {
            toDelete.push(e.key);
        }
    }
    for (const key of toDelete) kvDel(key);
    return { kept: entries.length - toDelete.length, removed: toDelete.length };
}

// ─── Remote-block migration ─────────────────────────────────────────────────
//
// Background: upstream RisuAI (and very early NodeOnly versions) split each
// character's data out of database.bin into a separate `remotes/<chaId>.local.bin`
// file. The main database.bin then carries a REMOTE pointer block instead of the
// character payload. The server-side RisuSaveDecoder used to skip those blocks
// outright, so any decode pass — /api/read, /api/chat-content fallback, chat
// store init — saw the character as missing and lost its chats.
//
// NodeOnly never wanted this split (`disableRemoteSaving` is hardcoded to
// true), so we one-shot convert any leftover REMOTE blocks to inline raw blocks
// the first time a server with such data boots. The reencoded database.bin is
// stored in legacy msgpack format, which has no block structure at all — so
// the REMOTE code path becomes unreachable for future decodes.
//
// Idempotent via a KV marker. The marker lives in KV (not on disk) so a backup
// import — which wipes most KV prefixes and INSERTs a new database.bin — naturally
// clears it, letting the new contents be re-evaluated.

export const REMOTE_MIGRATION_MARKER_KEY = 'migration/disable-remote-saving';
const REMOTE_MIGRATION_MARKER_VALUE = Buffer.from('done', 'utf-8');

function isRemoteMigrationDone() {
    const value = kvGet(REMOTE_MIGRATION_MARKER_KEY);
    return value !== null && value.length > 0;
}

function markRemoteMigrationDone() {
    kvSet(REMOTE_MIGRATION_MARKER_KEY, REMOTE_MIGRATION_MARKER_VALUE);
}

/**
 * Convert any leftover REMOTE blocks in database.bin into inline raw blocks.
 * Safe to call repeatedly: idempotent via KV marker.
 */
export async function migrateRemoteBlocksIfNeeded() {
    if (isRemoteMigrationDone()) return { ran: false, reason: 'already-done' };

    const raw = kvGet('database/database.bin');
    if (!raw) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-database' };
    }

    if (!hasRemoteBlocks(raw)) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-remote-blocks' };
    }

    console.info('[Migration] REMOTE blocks detected in database.bin; converting to inline format');

    // Pre-migration backup so a botched migration can be rolled back manually.
    // Use a dedicated prefix — `database/dbbackup-` is on a 20-snapshot rotation
    // whose timestamp parser would assign this entry ts=0 (because of the
    // non-numeric suffix), making it the first to evict. The migration safety
    // net must outlive ordinary backup churn.
    const backupKey = `migration-backup/pre-remote-fix-${Date.now()}.bin`;
    kvCopyValue('database/database.bin', backupKey);

    const dbObj = await decodeRisuSave(raw, {
        resolveRemote: async (name) => {
            const value = kvGet(`remotes/${name}.local.bin`);
            return value || null;
        },
    });

    const reEncoded = encodeRisuSaveLegacy(dbObj, true);

    // Single transaction so swap + marker move together.
    // remotes/ files are intentionally NOT deleted here: pre-migration
    // dbbackup-* snapshots and the migration-backup we just wrote both
    // only carry database.bin (kvCopyValue is single-key). If a user later
    // restores one of those snapshots — which holds REMOTE pointers —
    // resolveRemote needs the remotes/<id>.local.bin payloads to still
    // exist, otherwise every REMOTE-pointed character drops on the next
    // decode and the backup is effectively dead. The orphans don't grow
    // (NodeOnly's disableRemoteSaving = true on writes), so leaving them
    // costs a few MB of disk for full backup recoverability.
    sqliteDb.transaction(() => {
        kvSet('database/database.bin', Buffer.from(reEncoded));
        markRemoteMigrationDone();
    })();

    // Reset in-memory caches whose contents were derived from the pre-migration
    // bytes — next reader recomputes from the migrated database.bin.
    invalidateDbCache();
    dbEtag = null;

    const characterCount = Array.isArray(dbObj.characters) ? dbObj.characters.length : 0;
    console.info(`[Migration] Remote-block migration complete. Inlined ${characterCount} character(s); pre-migration backup at ${backupKey}`);
    return { ran: true, characterCount, backupKey };
}

export async function png2Webp(pngBuffer: Buffer) {
    return await sharp(pngBuffer).webp({ lossless: true }).toBuffer();
}