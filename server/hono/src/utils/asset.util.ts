import path from "node:path";
import { readFile, stat, access, readdir, mkdir, statfs} from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import sharp from "sharp";
import { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON, savePath } from "./util"
import { kvCopyValue, kvDel, kvGet, kvList, kvSet, kvSize } from "./db";
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
    const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue)
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

function isSafeInlayId(id: string) {
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

    const backupKey = `database/dbbackup-${(now / 100).toFixed()}.bin`;
    kvCopyValue('database/database.bin', backupKey);

    const backupKeys = kvList('database/dbbackup-')
        .sort((a, b) => {
            const aTs = parseInt(a.slice(18, -4));
            const bTs = parseInt(b.slice(18, -4));
            return bTs - aTs;
        });

    const dbSize = kvSize('database/database.bin') || 1;
    const maxBackups = Math.min(20, Math.max(3, Math.floor(BACKUP_BUDGET_BYTES / dbSize)));

    while (backupKeys.length > maxBackups) {
        kvDel(backupKeys.pop() || "");
    }
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


/**
 * Ensure fullChatStore is initialized. Loads from disk if needed.
 */
async function ensureChatStore() {
    if (fullChatStore) return;
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

/**
 * Persist dbCache to disk with full chats merged back in.
 */
export async function persistDbCacheWithChats(filePath: string, decodedKey: string) {
    const strippedDb = dbCache[filePath];
    if (!strippedDb) return;
    await ensureChatStore();
    const fullDb = reassembleFullDb(strippedDb);
    const data = Buffer.from(encodeRisuSaveLegacy(fullDb));
    kvSet(decodedKey, data);
}

/**
 * Convert a full chat to a stub (metadata only).
 */
function chatToStub(chat: any) {
    if (!chat || chat._stub) return chat;
    const stub: Record<string, any> = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    if (chat.lastDate != null) stub.lastDate = chat.lastDate;
    if (chat.folderId != null) stub.folderId = chat.folderId;
    if (chat.modules != null) stub.modules = chat.modules;
    return stub;
}

/**
 * Initialize fullChatStore from a decoded full database object.
 * Extracts all chat payloads into the store keyed by chaId → chatId.
 */
export function initChatStore(dbObj: any) {
    fullChatStore = new Map();
    if (!dbObj?.characters) return;
    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const charChats = new Map();
        for (const chat of char.chats) {
            if (chat && !chat._stub) {
                if (!chat.id) {
                    chat.id = randomUUID();
                }
                charChats.set(chat.id, chat);
            }
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
    if (stub.lastDate != null) merged.lastDate = stub.lastDate;
    if (stub.folderId != null) merged.folderId = stub.folderId;
    if (stub.modules != null) merged.modules = stub.modules;
    return merged;
}

function reassembleFullDb(strippedDb: any) {
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

function isInvalidBackupPathSegment(name: string) {
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

function normalizeColdStorageStorageKey(nameOrKey: string) {
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

function toColdStorageBackupName(storageKey: string) {
    return `${normalizeColdStorageStorageKey(storageKey)}.json`;
}

function parseColdStorageJsonBuffer(buffer: Buffer, sourceLabel: string, options: { allowPlainJson?: boolean } = {}) {
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

function encodeColdStorageCanonicalBuffer(coldData: any) {
    return Buffer.from(Bun.gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8')));
}

function readColdStorageJsonEntry(nameOrKey: string, options: { migrateLegacy?: boolean; allowPlainJsonFallback?: boolean } = {}): any {
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

export async function decodeDatabaseWithPersistentChatIds(raw: Uint8Array, options: { createBackup?: boolean; migrationResult?: any } = {}) {
    const { createBackup = false, migrationResult = null } = options;
    const dbObj = normalizeJSON(await decodeRisuSave(raw));
    let needsPersist = false;

    const hadMissingIds = assignMissingChatIds(dbObj);
    if (hadMissingIds) needsPersist = true;

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

