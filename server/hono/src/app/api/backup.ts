import { Hono } from 'hono';
import { createBackupAndRotate, decodeDatabaseWithPersistentChatIds, decodeDataUri, encodeColdStorageCanonicalBuffer, ensureInlayDir, flushPendingDb, getInlaySidecarPath, initChatStore, invalidateDbCache, isInvalidBackupPathSegment, isSafeInlayId, listInlayFiles, normalizeColdStorageStorageKey, normalizeInlayExt, parseColdStorageJsonBuffer, readColdStorageJsonEntry, REMOTE_MIGRATION_MARKER_KEY, toColdStorageBackupName } from '../../utils/asset.util';
import { checkpointWal, clearEntities, kvDel, kvDelPrefix, kvGet, kvList, kvListWithSizes, kvSet, kvSet, kvSize, db as sqliteDb } from '../../utils/db';
import path from 'node:path';
import fs from 'node:fs/promises';
import { stream, streamText } from "hono/streaming"
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { inlayDir, inlayMigrationMarker, savePath } from '../../utils/util';
import { BACKUP_IMPORT_MAX_BYTES, isImportInProgress, setImportProgress } from './migrate';

export const backupApp = new Hono();

const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;
// Minimum free disk space headroom multiplier: require 2× the backup size to be free
const BACKUP_DISK_HEADROOM = 2;

// Heartbeat interval for NDJSON import progress stream. 5 s by default —
// shorter than every common reverse-proxy response timeout (nginx 60 s, Cloudflare
// 100 s). Operators behind more aggressive proxies can tighten this. Clamped to
// 100 ms so a misconfiguration can't spam the socket.
const BACKUP_NDJSON_HEARTBEAT_MS = Math.max(
    100,
    Number(process.env.BACKUP_NDJSON_HEARTBEAT_MS ?? '5000') || 5000,
);

// Server-side backup directory (outside save/ to avoid bloating updater copies).
// Configurable at runtime via the kv key `config/server-backup-path`. When the
// user changes the path the old directory is left in place (existing backups
// stay where they were); only future backups land at the new path.
export const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
export const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';

function readBackupsDirConfig() {
    try {
        const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
        if (!raw) return DEFAULT_BACKUPS_DIR;
        const text = Buffer.from(raw).toString('utf-8').trim();
        return text || DEFAULT_BACKUPS_DIR;
    } catch { return DEFAULT_BACKUPS_DIR; }
}

export let backupsDir = readBackupsDirConfig();

if(!existsSync(backupsDir)){
    try { mkdirSync(backupsDir, { recursive: true }); }
    catch { backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupsDir, { recursive: true }); }
}
const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

export function listColdStorageBackupEntries() {
    const canonicalKeys = Array.from(new Set(
        kvList('coldstorage/').map((key) => normalizeColdStorageStorageKey(key))
    )).sort((a, b) => a.localeCompare(b));

    return canonicalKeys.map((storageKey) => {
        const entry = readColdStorageJsonEntry(storageKey, {
            migrateLegacy: true,
            allowPlainJsonFallback: true,
        });
        if (!entry) {
            throw new Error(`[ColdStorage] missing cold storage entry while exporting: ${storageKey}`);
        }
        const plainJson = Buffer.from(JSON.stringify(entry.coldData), 'utf-8');
        return {
            kind: 'buffer',
            buffer: plainJson,
            backupName: toColdStorageBackupName(storageKey),
            sortKey: toColdStorageBackupName(storageKey),
            size: plainJson.length,
        };
    });
}

function parseInlayBackupName(name: string) {
    if (!name.startsWith('inlay/')) return null;
    const suffix = name.slice('inlay/'.length);
    if (!suffix || suffix.includes('/')) return null;
    const dotIdx = suffix.lastIndexOf('.');
    if (dotIdx <= 0) {
        return { id: suffix, ext: null };
    }
    return {
        id: suffix.slice(0, dotIdx),
        ext: suffix.slice(dotIdx + 1),
    };
}

function parseInlaySidecarBackupName(name: string) {
    if (!name.startsWith('inlay_sidecar/')) return null;
    const id = name.slice('inlay_sidecar/'.length);
    if (!isSafeInlayId(id)) return null;
    return { id };
}

function encodeBackupEntry(name: string, data: any) {
    const encodedName = Buffer.from(name, 'utf-8');
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32LE(encodedName.length, 0);
    const dataLength = Buffer.allocUnsafe(4);
    dataLength.writeUInt32LE(data.length, 0);
    return Buffer.concat([nameLength, encodedName, dataLength, data]);
}


async function checkDiskSpace(requiredBytes: number) {
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const stats = await fs.statfs(saveDir);
        const availableBytes = stats.bavail * stats.bsize;
        return { ok: availableBytes >= requiredBytes, available: availableBytes };
    } catch {
        // statfs unavailable on this platform — skip check
        return { ok: true, available: -1 };
    }
}

function resolveBackupStorageKey(name: string) {
    if (Buffer.byteLength(name, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new Error(`Backup entry name too long: ${name.slice(0, 64)}`);
    }

    if (name === 'database.risudat') {
        return 'database/database.bin';
    }

    if (
        name.startsWith('inlay_thumb/') ||
        name.startsWith('inlay_meta/')
    ) {
        if (isInvalidBackupPathSegment(name)) {
            throw new Error(`Invalid backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay/')) {
        const parsed = parseInlayBackupName(name);
        if (!parsed || !isSafeInlayId(parsed.id)) {
            throw new Error(`Invalid inlay backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay_sidecar/')) {
        const parsed = parseInlaySidecarBackupName(name);
        if (!parsed) {
            throw new Error(`Invalid inlay sidecar backup entry name: ${name}`);
        }
        return name;
    }

    // Upstream backups transport cold storage as coldstorage/<uuid>.json.
    // Normalize back to the runtime KV key: coldstorage/<uuid>.
    if (name.startsWith('coldstorage/')) {
        return normalizeColdStorageStorageKey(name);
    }

    if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
        throw new Error(`Invalid asset backup entry name: ${name}`);
    }

    return `assets/${name}`;
}

function parseBackupChunk(buffer, onEntry) {
    let offset = 0;
    while (offset + 4 <= buffer.length) {
        const nameLength = buffer.readUInt32LE(offset);
        if (offset + 4 + nameLength > buffer.length) {
            break;
        }
        const nameStart = offset + 4;
        const nameEnd = nameStart + nameLength;
        const name = buffer.subarray(nameStart, nameEnd).toString('utf-8');
        if (nameEnd + 4 > buffer.length) {
            break;
        }
        const dataLength = buffer.readUInt32LE(nameEnd);
        const dataStart = nameEnd + 4;
        const dataEnd = dataStart + dataLength;
        if (dataEnd > buffer.length) {
            break;
        }
        onEntry(name, buffer.subarray(dataStart, dataEnd));
        offset = dataEnd;
    }
    return buffer.subarray(offset);
}

// ─── Shared backup import logic ─────────────────────────────────────────────
// Accepts any async iterable of Buffer chunks (HTTP request body, file stream, etc.)
async function importBackupFromSource(dataSource: any, { maxBytes = 0, totalBytes = 0, onProgress = null }: any = {}) {
    const BATCH_SIZE = 5000;
    // Defer Buffer.concat until enough bytes for the next entry are buffered.
    // Concatenating on every chunk arrival is O(n²) when a single entry (e.g.
    // database.risudat) far exceeds chunk size.
    let pendingChunks = [];
    let pendingTotal = 0;
    let nextEntryThreshold = 8;
    let hasDatabase = false;
    let assetsRestored = 0;
    let bytesReceived = 0;
    let batchCount = 0;
    const seenEntryNames = new Set();
    const importedInlayIds = new Set();
    const importedSidecarIds = new Set();
    const explicitSidecarMap = new Map();
    const legacyInlayInfoMap = new Map();

    const stagingDir = path.join(savePath, 'inlays_import_staging');
    const backupInlayDir = path.join(savePath, 'inlays_import_backup');
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(backupInlayDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    function stagingInlayFilePath(id, ext) {
        return path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
    }
    function stagingSidecarPath(id) {
        return path.join(stagingDir, `${id}.meta.json`);
    }
    function writeStagingInlayFileSync(id, ext, buffer, info) {
        const normalizedExt = normalizeInlayExt(ext);
        writeFileSync(stagingInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        const sidecar = {
            ext: normalizedExt,
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }
    function writeStagingSidecarSync(id, info) {
        const sidecar = {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }

    await flushPendingDb();
    createBackupAndRotate();

    sqliteDb.exec('PRAGMA synchronous = OFF');

    sqliteDb.exec('BEGIN');
    kvDelPrefix('assets/');
    kvDelPrefix('inlay/');
    kvDelPrefix('inlay_thumb/');
    kvDelPrefix('inlay_meta/');
    kvDelPrefix('inlay_info/');
    kvDelPrefix('coldstorage/');
    // Same reasoning as clearExistingData (save-folder import path): wipe stale
    // remote payloads from the prior user before this backup's contents land.
    // .bin backups never carry REMOTE blocks today, so the migration won't
    // resolveRemote on them — but keeping the two import paths consistent
    // avoids a contamination regression if that ever changes (upstream sync,
    // plugin-generated buffers, etc.).
    kvDelPrefix('remotes/');
    // Allow remote-block migration to re-evaluate against the new database.bin.
    // (.bin backups themselves never carry REMOTE blocks — legacy msgpack
    // format only — but a fresh import is a clear "data changed" signal.)
    kvDel(REMOTE_MIGRATION_MARKER_KEY);
    clearEntities();

    try {
        for await (const chunk of dataSource) {
            bytesReceived += chunk.length;
            if (maxBytes > 0 && bytesReceived > maxBytes) {
                throw new Error(`Backup exceeds max allowed size (${maxBytes} bytes)`);
            }
            if (onProgress) onProgress(bytesReceived, totalBytes);

            pendingChunks.push(Buffer.from(chunk));
            pendingTotal += chunk.length;
            if (pendingTotal < nextEntryThreshold) continue;

            const buffer = pendingChunks.length === 1
                ? pendingChunks[0]
                : Buffer.concat(pendingChunks, pendingTotal);
            pendingChunks = [];
            pendingTotal = 0;

            const remaining = parseBackupChunk(buffer, (name, data) => {
                if (seenEntryNames.has(name)) {
                    throw new Error(`Duplicate backup entry: ${name}`);
                }
                seenEntryNames.add(name);

                const inlayRaw = parseInlayBackupName(name);
                const inlaySidecar = parseInlaySidecarBackupName(name);

                if (inlayRaw) {
                    importedInlayIds.add(inlayRaw.id);
                    if (inlayRaw.ext) {
                        writeStagingInlayFileSync(inlayRaw.id, inlayRaw.ext, data, legacyInlayInfoMap.get(inlayRaw.id) || { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' });
                    } else if (data.length > 0 && data[0] === 0x7b) {
                        const parsed = JSON.parse(data.toString('utf-8'));
                        const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                        const ext = normalizeInlayExt(parsed?.ext);
                        const buffer = type === 'signature'
                            ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                            : decodeDataUri(parsed?.data).buffer;
                        writeStagingInlayFileSync(inlayRaw.id, ext, buffer, legacyInlayInfoMap.get(inlayRaw.id) || {
                            ext,
                            name: typeof parsed?.name === 'string' ? parsed.name : inlayRaw.id,
                            type,
                            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                        });
                    } else {
                        writeStagingInlayFileSync(inlayRaw.id, 'bin', data, legacyInlayInfoMap.get(inlayRaw.id) || {
                            ext: 'bin',
                            name: inlayRaw.id,
                            type: 'image',
                        });
                    }
                    if (explicitSidecarMap.has(inlayRaw.id)) {
                        writeStagingSidecarSync(inlayRaw.id, explicitSidecarMap.get(inlayRaw.id));
                    } else if (!importedSidecarIds.has(inlayRaw.id)) {
                        const legacyInfo = legacyInlayInfoMap.get(inlayRaw.id);
                        if (legacyInfo) {
                            writeStagingSidecarSync(inlayRaw.id, legacyInfo);
                        }
                    }
                    assetsRestored += 1;
                } else if (inlaySidecar) {
                    const parsed = JSON.parse(data.toString('utf-8'));
                    explicitSidecarMap.set(inlaySidecar.id, parsed);
                    writeStagingSidecarSync(inlaySidecar.id, parsed);
                    importedSidecarIds.add(inlaySidecar.id);
                } else if (name.startsWith('inlay_info/')) {
                    const id = name.slice('inlay_info/'.length);
                    if (!isSafeInlayId(id)) {
                        throw new Error(`Invalid legacy inlay info entry name: ${name}`);
                    }
                    const parsed = JSON.parse(data.toString('utf-8'));
                    legacyInlayInfoMap.set(id, {
                        ext: normalizeInlayExt(parsed?.ext),
                        name: typeof parsed?.name === 'string' ? parsed.name : id,
                        type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                        height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                        width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                    });
                    if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                        writeStagingSidecarSync(id, legacyInlayInfoMap.get(id));
                    }
                } else if (name.startsWith('inlay_thumb/')) {
                    // Skip deprecated thumbnail entries from legacy backups
                } else {
                    const storageKey = resolveBackupStorageKey(name);
                    const storageValue = storageKey.startsWith('coldstorage/')
                        ? encodeColdStorageCanonicalBuffer(
                            parseColdStorageJsonBuffer(data, name, { allowPlainJson: true }).coldData
                        )
                        : data;
                    kvSet(storageKey, storageValue);
                    if (storageKey === 'database/database.bin') {
                        hasDatabase = true;
                    } else {
                        assetsRestored += 1;
                    }
                }

                batchCount++;
                if (batchCount >= BATCH_SIZE) {
                    sqliteDb.exec('COMMIT');
                    sqliteDb.exec('BEGIN');
                    batchCount = 0;
                }
            });

            if (remaining.length === 0) {
                nextEntryThreshold = 8;
            } else {
                pendingChunks.push(remaining);
                pendingTotal = remaining.length;
                if (remaining.length < 4) {
                    nextEntryThreshold = 8;
                } else {
                    const nameLen = remaining.readUInt32LE(0);
                    const headerEnd = 4 + nameLen + 4;
                    if (remaining.length < headerEnd) {
                        nextEntryThreshold = headerEnd;
                    } else {
                        const dataLen = remaining.readUInt32LE(4 + nameLen);
                        nextEntryThreshold = headerEnd + dataLen;
                    }
                }
            }
        }

        if (pendingTotal > 0) {
            throw new Error('Backup stream ended with incomplete entry');
        }
        if (!hasDatabase) {
            throw new Error('Backup does not contain database.risudat');
        }
        for (const [id, info] of legacyInlayInfoMap.entries()) {
            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                writeStagingSidecarSync(id, info);
            }
        }
        sqliteDb.exec('COMMIT');
    } catch (error) {
        try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    } finally {
        sqliteDb.exec('PRAGMA synchronous = NORMAL');
    }

    await ensureInlayDir();
    try {
        if (existsSync(inlayDir)) {
            await fs.rename(inlayDir, backupInlayDir);
        }
        await fs.rename(stagingDir, inlayDir);
        await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
    } catch (swapError) {
        if (existsSync(backupInlayDir)) {
            await fs.rm(inlayDir, { recursive: true, force: true }).catch(() => {});
            await fs.rename(backupInlayDir, inlayDir).catch(() => {});
        }
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw swapError;
    }

    invalidateDbCache();

    // Trigger cold storage migration now so import result includes failure count.
    const dbRaw = kvGet('database/database.bin');
    let coldStorageFailed = 0;
    if (dbRaw) {
        const migration = {};
        const dbObj = await decodeDatabaseWithPersistentChatIds(dbRaw, {
            createBackup: false,
            migrationResult: migration,
        });
        coldStorageFailed = migration.coldStorageFailed || 0;
        initChatStore(dbObj);
    }

    try {
        checkpointWal('TRUNCATE');
    } catch (checkpointError) {
        console.warn('[Backup Import] WAL checkpoint after import failed:', checkpointError);
    }

    console.log(`[Backup Import] Complete: ${assetsRestored} assets restored, ${(bytesReceived / 1024 / 1024).toFixed(1)}MB processed`);
    if (coldStorageFailed > 0) {
        console.error(`[Backup Import] ${coldStorageFailed} cold storage character(s) could not be restored`);
    }
    return { assetsRestored, bytesReceived, coldStorageFailed };
}

// ── Server-side backup endpoints ────────────────────────────────────────────

// Save current data as a .bin backup file on the server
backupApp.post('/server/save', async (c) => {
  try {
    await flushPendingDb();

      // Pre-flight disk check — bail before streaming if the target dir
      // can't fit the backup. Avoids wasted minutes + half-written tmp files.
      try {
          const estimate = await estimateServerBackupSize();
          const required = Math.ceil(estimate * 1.05); // 5% safety margin
          const sf = await fs.statfs(backupsDir);
          const free = sf.bsize * sf.bavail;
          if (estimate > 0 && free < required) {
              return c.json({
                  error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB, free ${(free / 1024 / 1024).toFixed(0)} MB)`,
                  code: 'insufficient_space',
                  required,
                  free,
              }, 400);
          }
      } catch (e) {
          // Non-fatal: log and proceed. statfs may be unavailable, in which
          // case the streaming fallback path below still fails gracefully.
          console.warn('[Backup] pre-flight disk check failed:', e?.message || e);
      }

    const inlayFiles = await listInlayFiles();
    const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
      const stat = await fs.stat(entry.filePath);
      return { kind: 'file', sourcePath: entry.filePath, backupName: `inlay/${entry.id}.${entry.ext}`, size: stat.size };
    }));
    const sidecarEntries = (await Promise.all(inlayFiles.map(async (entry) => {
      const sidecarPath = getInlaySidecarPath(entry.id);
      try {
        const stat = await fs.stat(sidecarPath);
        return { kind: 'sidecar', sourcePath: sidecarPath, backupName: `inlay_sidecar/${entry.id}`, size: stat.size };
      } catch { return null; }
    }))).filter(Boolean);

    const namespacedEntries = [
      ...kvListWithSizes('assets/').map((e) => ({ kind: 'kv', key: e.key, backupName: path.basename(e.key), size: e.size })),
      ...listColdStorageBackupEntries(),
      ...kvListWithSizes('inlay_meta/').map((e) => ({ kind: 'kv', key: e.key, backupName: e.key, size: e.size })),
      ...inlayEntries,
      ...sidecarEntries,
    ];

    const totalEntries = namespacedEntries.length + 1;
    const totalBytes = namespacedEntries.reduce((sum, e) => sum + e.size, 0);

    const filename = `risu-backup-${Date.now()}.bin`;
    const finalPath = path.join(backupsDir, filename);
    const tmpPath = finalPath + '.tmp';

    c.header('content-type', 'application/x-ndjson');

    return stream(c, async (s) => {
      const { createWriteStream: createFsWriteStream } = require('fs');
      const writeStream = createFsWriteStream(tmpPath);

      let closed = false;
      let writeComplete = false;

      s.onAbort(() => {
        closed = true;
        writeStream.destroy(new Error('Client aborted the request'));
      });

      try {
        await new Promise<void>((resolve, reject) => {
          writeStream.on('error', reject);
          (async () => {
            let written = 0;
            let bytesWritten = 0;
            for (const entry of namespacedEntries) {
              if (closed) break;
              const value = entry.kind === 'kv'
                ? kvGet(entry.key)
                : entry.kind === 'buffer'
                  ? entry.buffer
                  : await fs.readFile(entry.sourcePath);
              if (value) {
                const ok = writeStream.write(encodeBackupEntry(entry.backupName, value));
                if (!ok) await new Promise(r => writeStream.once('drain', r));
                bytesWritten += value.length;
              }
              written++;
              if (written % 50 === 0 || written === namespacedEntries.length) {
                await s.write(JSON.stringify({ type: 'progress', current: written, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
              }
            }
            if (closed) throw new Error('Client disconnected during backup save');
            const dbValue = kvGet('database/database.bin');
            if (dbValue) {
              const ok = writeStream.write(encodeBackupEntry('database.risudat', dbValue));
              if (!ok) await new Promise(r => writeStream.once('drain', r));
              bytesWritten += dbValue.length;
            }
            await s.write(JSON.stringify({ type: 'progress', current: totalEntries, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
            writeStream.end(resolve);
          })().catch(reject);
        });

        await fs.rename(tmpPath, finalPath);
        writeComplete = true;

        const stat = await fs.stat(finalPath);
        console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        await s.write(JSON.stringify({ type: 'done', ok: true, filename, size: stat.size }) + '\n');
      } catch (innerError) {
        if (!writeComplete) {
          await fs.unlink(tmpPath).catch(() => {});
        }
        await s.write(JSON.stringify({ type: 'error', message: (innerError as Error).message }) + '\n');
      }
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// List backup files on the server
backupApp.get('/server/list', async (c, next) => {
    //if (!await checkAuth(req, res)) { return; }
    try {
        let entries;
        try {
            entries = await fs.readdir(backupsDir, { withFileTypes: true });
        } catch {
            return c.json({ backups: [] });
        }
        const backups = [];
        for (const entry of entries) {
            if (!entry.isFile() || !BACKUP_FILENAME_REGEX.test(entry.name)) continue;
            const stat = await fs.stat(path.join(backupsDir, entry.name));
            const tsMatch = entry.name.match(/^risu-backup-(\d+)\.bin$/);
            backups.push({
                filename: entry.name,
                size: stat.size,
                createdAt: tsMatch ? Number(tsMatch[1]) : stat.mtimeMs,
            });
        }
        backups.sort((a, b) => b.createdAt - a.createdAt);
        return c.json({ backups });
    } catch (error) {
        throw error;
    }
});

backupApp.post('/server/restore', async (c) => {
  // if (!await checkAuth(c)) return;
  // if (!checkActiveSession(c)) return;

  if (isImportInProgress()) {
    return c.json({ error: 'Another import is already in progress' }, 409);
  }
  setImportProgress(true);

  try {
    const body = await c.req.json();
    const filename = body?.filename;
    if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
      return c.json({ error: 'Invalid backup filename' }, 400);
    }

    const filePath = path.join(backupsDir, filename);
    let fileStat;
    try {
      fileStat = await fs.stat(filePath);
    } catch {
      return c.json({ error: 'Backup file not found' }, 404);
    }

    const disk = await checkDiskSpace(fileStat.size * BACKUP_DISK_HEADROOM);
    if (!disk.ok) {
      return c.json({
        error: 'Insufficient disk space',
        available: disk.available,
        required: fileStat.size * BACKUP_DISK_HEADROOM,
      }, 507);
    }

    c.header('content-type', 'application/x-ndjson');

    return stream(c, async (s) => {
      try {
        let lastProgressWrite = 0;
        const fileStream = Bun.file(filePath).stream();
        const result = await importBackupFromSource(fileStream, {
          totalBytes: fileStat.size,
          onProgress: (received: number, total: number) => {
            const now = Date.now();
            if (now - lastProgressWrite < 200) return;
            lastProgressWrite = now;
            s.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
          },
        });
        await s.write(JSON.stringify({
          type: 'done',
          ok: true,
          assetsRestored: result.assetsRestored,
          coldStorageFailed: result.coldStorageFailed,
        }) + '\n');
      } catch (error) {
        await s.write(JSON.stringify({ type: 'error', message: (error as Error).message }) + '\n');
      } finally {
        setImportProgress(false);
      }
    });
  } catch (error) {
    setImportProgress(false);
    return c.json({ error: (error as Error).message }, 500);
  }
});

// Delete a server backup file
backupApp.delete('/server/:filename', async (c, next) => {
    // if (!await checkAuth(req, res)) { return; }
    // if (!checkActiveSession(req, res)) return;
    try {
        const filename = c.req.param("filename");
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            return c.json({ error: 'Invalid backup filename' }, 400);
        }
        const filePath = path.join(backupsDir, filename);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return c.json({ error: 'Backup file not found' }, 404);
            }
            throw err;
        }
        return c.json({ ok: true });
    } catch (error) {
       throw error;
    }
});

// Download a server backup file
backupApp.get('/server/download/:filename', async (c, next) => {
    //if (!await checkAuth(req, res)) { return; }
    try {
        const filename = c.req.param("filename");
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            return c.json({ error: 'Invalid backup filename' }, 400);
        }
        const filePath = path.join(backupsDir, filename);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            return c.json({ error: 'Backup file not found' }, 404);
        }
        return new Response(Bun.file(filePath), {
            headers: {
                'content-type': 'application/octet-stream',
                'content-disposition': `attachment; filename="${filename}"`,
                'content-length': stat.size.toString(),
            }
        });
    } catch (error) {
        throw error;
    }
});

backupApp.get('/export', async (c) => {
  try {
    // ?target=upstream excludes NodeOnly-only inlay namespaces (inlay/,
    // inlay_sidecar/, inlay_meta/). Their entry names contain a slash,
    // which upstream RisuAI's import treats as a path under assets/ and
    // fails with ENOENT. The export becomes lossy on inlay images but
    // imports cleanly into upstream.
    const target = c.req.query("target") === 'upstream' ? 'upstream' : 'nodeonly';
    await flushPendingDb();

    const inlayFiles = target === 'upstream' ? [] : await listInlayFiles();
    const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
      const stat = await fs.stat(entry.filePath);
      return {
        kind: 'file',
        sourcePath: entry.filePath,
        backupName: `inlay/${entry.id}.${entry.ext}`,
        sortKey: `inlay/${entry.id}`,
        size: stat.size,
      };
    }));
    const sidecarEntries = await Promise.all(inlayFiles.map(async (entry) => {
      const sidecarPath = getInlaySidecarPath(entry.id);
      try {
        const stat = await fs.stat(sidecarPath);
        return {
          kind: 'sidecar',
          sourcePath: sidecarPath,
          backupName: `inlay_sidecar/${entry.id}`,
          sortKey: `inlay_sidecar/${entry.id}`,
          size: stat.size,
        };
      } catch { return null; }
    }));
    const inlayMetaEntries = target === 'upstream' ? [] : kvListWithSizes('inlay_meta/').map((entry) => ({
            kind: 'kv',
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
    }));

    const namespacedEntries = [
      ...kvListWithSizes('assets/').map((entry) => ({
        kind: 'kv', key: entry.key,
        backupName: path.basename(entry.key),
        sortKey: entry.key, size: entry.size,
      })),
      ...listColdStorageBackupEntries(),
      ...inlayMetaEntries,
      ...inlayEntries,
      ...sidecarEntries.filter(Boolean),
    ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const dbSize = kvSize('database/database.bin');
    const totalBytes = namespacedEntries.reduce((sum, entry) => {
      return sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size;
    }, 0) + (dbSize ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSize : 0);

    const filenameSuffix = target === 'upstream' ? '-upstream' : '';

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // 백그라운드에서 스트리밍 쓰기
    (async () => {
      try {
        for (const entry of namespacedEntries) {
          const value = entry.kind === 'kv'
            ? kvGet(entry.key)
            : entry.kind === 'buffer'
              ? entry.buffer
              : await fs.readFile(entry.sourcePath);
          if (value) {
            await writer.write(encodeBackupEntry(entry.backupName, value));
          }
        }
        if (dbSize) {
          const dbValue = kvGet('database/database.bin');
          if (dbValue) {
            await writer.write(encodeBackupEntry('database.risudat', dbValue));
          }
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e);
      }
    })();

    return new Response(readable, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="risu-backup-${Date.now()}${filenameSuffix}.bin"`,
        'content-length': String(totalBytes),
        'x-risu-backup-assets': String(namespacedEntries.length),
      },
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// Pre-flight check: auth + size + disk space before client starts uploading
backupApp.post('/import/prepare', async (c, next) => {
    // if (!await checkAuth(req, res)) { return; }
    // if (!checkActiveSession(req, res)) return;
    try {
        if (isImportInProgress()) {
            return c.json({ error: 'Another import is already in progress' }, 409);
        }
        const body = await c.req.json();
        const size = Number(body.size ?? 0);
        if (BACKUP_IMPORT_MAX_BYTES > 0 && size > BACKUP_IMPORT_MAX_BYTES) {
            return c.json({ error: 'Backup exceeds max allowed size' }, 413);
        }

        if (size > 0) {
            const disk = await checkDiskSpace(size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                return c.json({
                    error: 'Insufficient disk space',
                    available: disk.available,
                    required: size * BACKUP_DISK_HEADROOM,
                }, 507);
            }
        }

        return c.json({ ok: true });
    } catch (error) {
        throw error;
    }
});

backupApp.post('/import', async (c, next) => {
    // if(!await checkAuth(req, res)){ return; }
    // if (!checkActiveSession(req, res)) return;

    if (isImportInProgress()) {
        return c.json({ error: 'Another import is already in progress' }, 409);
    }
    setImportProgress(true);

    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (BACKUP_IMPORT_MAX_BYTES > 0 && Number.isFinite(contentLength) && contentLength > BACKUP_IMPORT_MAX_BYTES) {
        return c.json({ error: 'Backup exceeds max allowed size' }, 413);
    }


    // NDJSON streaming keeps the response socket alive during long
    // post-upload work (WAL checkpoint, cold-storage migration). Without it
    // a reverse proxy in front of the server can hit its response timeout
    // and bounce the request back to the client as 502 Bad Gateway.
    const wantsNdjson = String(c.req.header('accept') ?? '').includes('application/x-ndjson');
    let heartbeatTimer = null;

    if (!wantsNdjson) {
    // Simple path — no streaming
        try {
        const result = await importBackupFromSource(c.req, { maxBytes: BACKUP_IMPORT_MAX_BYTES });
        return c.json({
            ok: true,
            assetsRestored: result.assetsRestored,
            bytesReceived: result.bytesReceived,
        });
        } finally {
        setImportProgress(false);
        }
    }

    // TODO: AI Generated, need to review

    return streamText(c, async (stream) => {
    // Set headers for NDJSON streaming
    // Note: Hono's streamText sets text/plain by default;
    // override via the response init below instead.

    let heartbeatTimer: Timer | undefined;

    try {
      heartbeatTimer = setInterval(async () => {
        try {
          await stream.write('{"type":"heartbeat"}\n');
        } catch { /* stream already closed */ }
      }, 15_000);

      let lastProgressWrite = 0;
      const totalBytes = Number.isFinite(contentLength) ? contentLength : 0;

      const result = await importBackupFromSource(c.req, {
        maxBytes: BACKUP_IMPORT_MAX_BYTES,
        totalBytes,
        onProgress: async (received: number, total: number) => {
          const now = Date.now();
          if (now - lastProgressWrite < 200) return;
          lastProgressWrite = now;
          try {
            await stream.write(
              JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n'
            );
          } catch { /* client disconnected */ }
        },
      });

      await stream.write(
        JSON.stringify({
          type: 'done',
          ok: true,
          assetsRestored: result.assetsRestored,
          coldStorageFailed: result.coldStorageFailed,
        }) + '\n'
      );
    } catch (error) {
      try {
        await stream.write(
          JSON.stringify({
            type: 'error',
            message: (error as Error)?.message || 'backup import failed',
          }) + '\n'
        );
      } catch { /* stream already closed */ }
    } finally {
      clearInterval(heartbeatTimer);
      setImportProgress(false);
    }
  }, {
    // Response init — override content-type and add proxy hints
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ── Boot-time backup reminder ───────────────────────────────────────────────

const BOOT_REMINDER_KEY = 'config/boot-backup-reminder';

function readBootReminder() {
    try {
        const raw = kvGet(BOOT_REMINDER_KEY);
        if (!raw) return false;
        return Buffer.from(raw).toString('utf-8').trim() === '1';
    } catch { return false; }
}

backupApp.get('/boot-reminder', async (c, next) => {
    // if (!await checkAuth(c)) return;
    try {
        return c.json({ enabled: readBootReminder() });
    } catch (err) { next(err); }
});

backupApp.put('/boot-reminder', async (c, next) => {
    // if (!await checkAuth(c)) return;
    // if (!checkActiveSession(c)) return;
    try {
        const enabled = !!c.req.json().enabled;
        kvSet(BOOT_REMINDER_KEY, Buffer.from(enabled ? '1' : '0', 'utf-8'));
        return c.json({ enabled });
    } catch (err) { next(err); }
});

// ── Backup directory configuration ──────────────────────────────────────────

backupApp.get('/server/path', async (c, next) => {
    // if (!await checkAuth(c)) return;
    try {
        return c.json({
            path: backupsDir,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) { next(err); }
});

backupApp.put('/server/path', async (c, next) => {
    // if (!await checkAuth(c)) return;
    // if (!checkActiveSession(c)) return;
    try {
        const next = typeof c.req.json()?.path === 'string' ? c.req.json().path.trim() : '';
        if (!next) {
            return c.json({ error: 'Path required' }, 400);
        }
        const resolved = path.resolve(next);
        // Ensure parent exists / target is writable. Create the dir if missing.
        try {
            if (!existsSync(resolved)) {
                mkdirSync(resolved, { recursive: true });
            }
            // Probe writability with a tmpfile.
            const probe = path.join(resolved, `.risu-write-probe-${Date.now()}`);
            require('fs').writeFileSync(probe, '');
            require('fs').unlinkSync(probe);
        } catch (e) {
            return c.json({ error: 'Path is not writable: ' + (e?.message || String(e)) }, 400);
        }
        const previous = backupsDir;
        backupsDir = resolved;
        kvSet(BACKUP_PATH_CONFIG_KEY, Buffer.from(resolved, 'utf-8'));
        return c.json({
            path: backupsDir,
            previous,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) { next(err); }
});