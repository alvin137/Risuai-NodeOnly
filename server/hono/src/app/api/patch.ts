import { Hono } from "hono";
import { calculateHash, decodeRisuSave, encodeRisuSaveLegacy, isHex, normalizeJSON } from "../../utils/util";
import { kvCopyValue, kvDel, kvGet, kvList, kvSet, kvSize } from "../../utils/db";
import { checkAuth } from "../api";
import { applyPatch } from "fast-json-patch";
import { randomUUID } from "node:crypto";

export const patchApp = new Hono();

// Configuration flags for patch-based sync
const enablePatchSync = true;

// In-memory database cache for patch-based sync
// dbCache stores the STRIPPED (stubs-only) version matching what the client sees.
// fullChatStore keeps the actual chat data keyed by chaId→chatId.
let dbCache: Record<string, unknown> = {};
let saveTimers: Record<string, NodeJS.Timeout> = {};
const SAVE_INTERVAL = 5000;
let fullChatStore: Map<string, Map<string, unknown>> | null = null; // Map<chaId, Map<chatId, chatObject>> — lazy-initialized

// ETag for database.bin
let dbEtag: string | null = null;

function computeBufferEtag(buffer: Buffer) {
  const hasher = new Bun.CryptoHasher('md5');
  return hasher.update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject: any) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation: () => Promise<any>) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');

// ─── Server-side database backup ─────────────────────────────────────────────
const BACKUP_BUDGET_BYTES = 500 * 1024 * 1024; // 500 MB
const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastBackupTime: number | null = null;

function createBackupAndRotate() {
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

patchApp.post("", async(c) => {
  if (!enablePatchSync) {
    return c.json({error: 'Patch sync is disabled'}, 503);
  }
  //const auth = await checkAuth(c);
  //if (auth instanceof Response) return auth;

  //if (!checkActiveSession(c)) return ;
  const filePath = c.req.header("file-path");
  const body = await c.req.json();
  const patch = body.patch;
  const expectedHash = body.expectedHash;

  if (!filePath || !patch || !expectedHash) 
    return c.json({error: 'Missing required fields'}, 400);
  if (!isHex(filePath))
    return c.json({error: 'Invalid file path'}, 400);

  try {
    return await queueStorageOperation(async () => {
      const decodedKey = Buffer.from(filePath, "hex").toString("utf-8");
      
      if (!dbCache[filePath]) {
        const fileContent = kvGet(decodedKey);
        if (fileContent) {
          const decoded = decodedKey === "database/database.bin"
            ? await decodeDatabaseWithPersistentChatIds(fileContent)
            : normalizeJSON(await decodeRisuSave(fileContent));
          if (decodedKey === "database/database.bin") {
            initChatStore(decoded);
            dbCache[filePath] = normalizeJSON(stripChatsFromDb(decoded));
        } else {
          dbCache[filePath] = {};
        }
      }
    }

    // TODO: Because of still developing things, skip hash check for now.
    
    // const serverHash = calculateHash(dbCache[filePath]).toString(16);

    // if (expectedHash !== serverHash) {
    //   console.log(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
    //   let currentEtag = undefined;
    //   if (decodedKey === "database/database.bin") {
    //     currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
    //     dbEtag = currentEtag;
    //   }
    //   return c.json({error: "Hash mismatch", currentEtag}, 409);
    // }
    
    let result;
    try {
      result = applyPatch(dbCache[filePath], patch, true);
    } catch (patchErr) {
      delete dbCache[filePath];
      throw patchErr;
    }

    if (saveTimers[filePath]) {
      clearTimeout(saveTimers[filePath]);
    }
    saveTimers[filePath] = setTimeout(async () => {
      try {
        if (decodedKey === "database/database.bin") {
          await persistDbCacheWithChats(filePath, decodedKey);
        } else {
          const data = Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]));
          kvSet(decodedKey, data);
        }
        if (decodedKey === "database/database.bin") {
          createBackupAndRotate();
        }
      } catch (error) {
        console.error(`Error saving ${decodedKey}:`, error);
      } finally {
        delete saveTimers[filePath];
      }
    }, SAVE_INTERVAL);

    if (decodedKey === "database/database.bin") {
      dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
    }

    return c.json({success: true, appliedOperations: result.length, etag: decodedKey === "database/database.bin" ? dbEtag: undefined});
  })
  } catch (error) {
    console.error("Error applying patch:", error);
    return c.json({error: 'Failed to apply patch'}, 500);
}
})

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

function restoreColdStorageCharactersInDb(dbObj: any) {
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

function restoreColdStorageChat(chat: any) {
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

async function decodeDatabaseWithPersistentChatIds(raw: Uint8Array, options: { createBackup?: boolean; migrationResult?: any } = {}) {
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
function initChatStore(dbObj: any) {
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
function stripChatsFromDb(dbObj: any) {
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
async function persistDbCacheWithChats(filePath: string, decodedKey: string) {
    const strippedDb = dbCache[filePath];
    if (!strippedDb) return;
    await ensureChatStore();
    const fullDb = reassembleFullDb(strippedDb);
    const data = Buffer.from(encodeRisuSaveLegacy(fullDb));
    kvSet(decodedKey, data);
}