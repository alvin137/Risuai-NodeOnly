import { Hono } from "hono";
import path from "node:path";
import { listInlayFiles, getInlaySidecarPath, dbCache, DB_HEX_KEY, ensureChatStore, fullChatStore, queueStorageOperation, flushPendingDb, invalidateDbCache, initChatStore, computeBufferEtag, getDbetag, SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES, SNAPSHOT_LIMIT_MAX_COUNT, trimSnapshotsToLimits, setDbetag, getSnapshotLimits, SNAPSHOT_LIMIT_DEFAULT_COUNT, SNAPSHOT_LIMIT_DEFAULT_BYTES, REMOTE_MIGRATION_MARKER_KEY, decodeDatabaseWithPersistentChatIds } from "../../utils/asset.util";
import { kvSize, kvListWithSizes, kvList, kvGet, checkpointWal, kvSet, kvDel, kvCopyValue, db as sqliteDb } from "../../utils/db";
import { decodeRisuSave } from "../../utils/util";
import { checkAuth } from "../api";
import fs from "node:fs/promises";
import { backupsDir, DEFAULT_BACKUPS_DIR, listColdStorageBackupEntries } from "./backup";
import { checkActiveSession } from "../session";


export const dbApp = new Hono();

// ── Storage dashboard endpoints ──────────────────────────────────────────────

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];
// Slightly above 2GB BLOB ceiling — better-sqlite3 throws RangeError near INT_MAX.
const BLOB_INT_MAX = 2 * 1024 * 1024 * 1024 - 1;

function statsBasename(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '/').split('/').pop();
}

// Mirrors src/ts/globalApi.svelte.ts:getUncleanables — every asset reference reachable from the DB.
function buildUncleanableSet(dbObj) {
    const set = new Set();
    const add = (v) => {
        const bn = statsBasename(v);
        if (bn) set.add(bn);
    };
    if (!dbObj) return set;
    add(dbObj.customBackground);
    add(dbObj.userIcon);
    if (Array.isArray(dbObj.characters)) {
        for (const cha of dbObj.characters) {
            if (!cha) continue;
            add(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) add(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) add(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) add(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) add(a?.uri);
        }
    }
    if (Array.isArray(dbObj.modules)) {
        for (const m of dbObj.modules) if (Array.isArray(m?.assets)) for (const a of m.assets) add(a?.[1]);
    }
    if (Array.isArray(dbObj.personas)) for (const p of dbObj.personas) add(p?.icon);
    if (Array.isArray(dbObj.characterOrder)) {
        for (const item of dbObj.characterOrder) {
            if (item && typeof item === 'object' && 'imgFile' in item) add(item.imgFile);
        }
    }
    return set;
}

function statSafe(p) {
    try { return require('fs').statSync(p); } catch { return null; }
}

async function diskFreeStat(dirPath) {
    try {
        const sf = await fs.statfs(dirPath);
        return { free: sf.bsize * sf.bavail, total: sf.bsize * sf.blocks };
    } catch { return { free: null, total: null }; }
}

// Sum the on-disk inlay payload (image files + sidecar JSONs in save/inlays).
// Returns 0 if the directory is missing. Used by both the backup-size
// estimator and the dashboard inlay total — kv inlay/* prefixes don't
// reflect filesystem bytes after the inlay→fs migration.
async function sumInlayFsBytes() {
    let total = 0;
    try {
        const inlayFiles = await listInlayFiles();
        await Promise.all(inlayFiles.map(async (entry) => {
            try {
                const st = await fs.stat(entry.filePath);
                total += st.size;
            } catch { /* missing — skip */ }
            try {
                const sst = await fs.stat(getInlaySidecarPath(entry.id));
                total += sst.size;
            } catch { /* sidecar may not exist */ }
        }));
    } catch { /* dir missing */ }
    return total;
}

// Estimated server-backup size — mirrors the enumeration in
// /api/backup/server/save without writing anything. Inlay files live on the
// filesystem (post-migration), so we have to fs.stat them rather than read
// kvSize. Cost: ~5-50 ms typical, ~200 ms for users with thousands of inlays.
async function estimateServerBackupSize() {
    let total = 0;
    total += kvSize(DB_BLOB_KEY) || 0;
    for (const it of kvListWithSizes('assets/')) total += it.size;
    for (const it of kvListWithSizes('inlay_meta/')) total += it.size;
    for (const e of listColdStorageBackupEntries()) total += e.size;
    total += await sumInlayFsBytes();
    return total;
}

dbApp.get('/stats', async (c, next) => {
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const walPath = dbFilePath + '-wal';
        const shmPath = dbFilePath + '-shm';

        const files = {
            db: statSafe(dbFilePath)?.size ?? 0,
            wal: statSafe(walPath)?.size ?? 0,
            shm: statSafe(shmPath)?.size ?? 0,
        };

        const disk = await diskFreeStat(saveDir);
        // Backup destination disk — same as save/ in the default config but
        // can diverge when the user points backupsDir at a different mount.
        // Surfaced separately so backup-side warnings target the right disk.
        // `sameAsSaveDir` is true when both paths land on the same filesystem
        // (compared by Stat.dev). Dashboard uses this to decide whether to
        // count file backups against the save/ disk in the storage chart.
        let backupDisk;
        if (backupsDir === DEFAULT_BACKUPS_DIR) {
            backupDisk = { ...disk, path: backupsDir, sameAsSaveDir: true };
        } else {
            const bDisk = await diskFreeStat(backupsDir);
            let sameAsSaveDir = false;
            try {
                const saveStat = require('fs').statSync(saveDir);
                const bStat = require('fs').statSync(backupsDir);
                sameAsSaveDir = saveStat.dev === bStat.dev;
            } catch { /* non-fatal */ }
            backupDisk = { ...bDisk, path: backupsDir, sameAsSaveDir };
        }

        const pageSize = sqliteDb.query('PRAGMA page_size').get().page_size;
        const pageCount = sqliteDb.query('PRAGMA page_count').get().page_count;
        const freelistCount = sqliteDb.query('PRAGMA freelist_count').get().freelist_count;
        const journalMode = sqliteDb.query('PRAGMA journal_mode').get().journal_mode;
        const autoVacuum = sqliteDb.query('PRAGMA auto_vacuum').get().auto_vacuum;
        const reclaimable = freelistCount * pageSize;

        const dbBlobSize = kvSize(DB_BLOB_KEY) || 0;

        // Prefix breakdown — split database/ into the live blob vs rotated backups.
        const prefixes = {};
        prefixes[DB_BLOB_KEY] = { totalSize: dbBlobSize, count: dbBlobSize > 0 ? 1 : 0 };
        const backupKeys = kvList(DB_BACKUP_PREFIX);
        let backupTotal = 0;
        let backupOldest = null, backupNewest = null;
        for (const k of backupKeys) {
            const sz = kvSize(k) || 0;
            backupTotal += sz;
            const tsRaw = parseInt(k.slice(DB_BACKUP_PREFIX.length, -4), 10);
            if (Number.isFinite(tsRaw)) {
                const ts = tsRaw * 100;
                if (!backupOldest || ts < backupOldest) backupOldest = ts;
                if (!backupNewest || ts > backupNewest) backupNewest = ts;
            }
        }
        prefixes[DB_BACKUP_PREFIX] = { totalSize: backupTotal, count: backupKeys.length };
        for (const p of ASSET_PREFIXES) {
            const items = kvListWithSizes(p);
            let total = 0;
            for (const it of items) total += it.size;
            prefixes[p] = { totalSize: total, count: items.length };
        }

        const kvRows = sqliteDb.prepare('SELECT COUNT(*) AS c FROM kv').get().c;
        const kvTotalBytes = sqliteDb.prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS s FROM kv').get().s;

        let fileBackups = { count: 0, totalSize: 0, oldest: null, newest: null };
        try {
            const entries = await fs.readdir(backupsDir, { withFileTypes: true });
            for (const e of entries) {
                if (!e.isFile() || !BACKUP_FILENAME_REGEX.test(e.name)) continue;
                const st = await fs.stat(path.join(backupsDir, e.name));
                fileBackups.count++;
                fileBackups.totalSize += st.size;
                const ts = st.mtimeMs;
                if (!fileBackups.oldest || ts < fileBackups.oldest) fileBackups.oldest = ts;
                if (!fileBackups.newest || ts > fileBackups.newest) fileBackups.newest = ts;
            }
        } catch { /* backups dir may not exist */ }

        // Quick estimates from in-memory cache only — never decode the BLOB just for stats.
        let trashed = { count: 0, expiredCount: 0, available: false };
        let orphan = { count: 0, totalSize: 0, available: false };
        const stripped = dbCache[DB_HEX_KEY];
        if (stripped?.characters) {
            const now = Date.now();
            const GRACE = 1000 * 60 * 60 * 24 * 3;
            for (const c of stripped.characters) {
                if (c?.trashTime) {
                    trashed.count++;
                    if (c.trashTime + GRACE < now) trashed.expiredCount++;
                }
            }
            trashed.available = true;
        }
        if (stripped) {
            const uncleanable = buildUncleanableSet(stripped);
            for (const it of kvListWithSizes('assets/')) {
                if (!uncleanable.has(statsBasename(it.key))) {
                    orphan.count++;
                    orphan.totalSize += it.size;
                }
            }
            orphan.available = true;
        }

        const estimatedBackupSize = await estimateServerBackupSize();
        // Inlay payload now lives on the filesystem (post-migration) rather
        // than in kv `inlay/*` prefixes. Surface explicitly so the dashboard
        // chart can include it in the inlay slice instead of underreporting.
        const inlayFsBytes = await sumInlayFsBytes();

        return c.json({
            files,
            disk,
            backupDisk,
            sqlite: { pageSize, pageCount, freelistCount, reclaimable, journalMode, autoVacuum },
            blob: { dbSize: dbBlobSize, intMax: BLOB_INT_MAX },
            prefixes,
            kvRows,
            kvTotalBytes,
            estimatedBackupSize,
            inlayFsBytes,
            backups: {
                kv: { count: backupKeys.length, totalSize: backupTotal, oldest: backupOldest, newest: backupNewest },
                file: fileBackups,
            },
            trashed,
            orphan,
            etag: getDbetag(),
        });
    } catch (err) { next(err); }
});

dbApp.get('/stats/characters', async (c, next) => {
    try {
        await ensureChatStore();
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            return c.json({ characters: [], orphan: { count: 0, totalSize: 0 }, chatBytesNote: 'estimate' });
        }
        const dbObj = await decodeRisuSave(raw);

        const assetSize = new Map();
        for (const it of kvListWithSizes('assets/')) {
            assetSize.set(statsBasename(it.key), it.size);
        }
        // remotes/<chaId>.local.bin (+ optional .meta sidecar) → bucket by chaId.
        const remoteSize = new Map();
        for (const it of kvListWithSizes('remotes/')) {
            const bn = statsBasename(it.key).replace(/\.meta$/, '');
            const chaId = bn.replace(/\.local\.bin$/, '');
            if (chaId) remoteSize.set(chaId, (remoteSize.get(chaId) || 0) + it.size);
        }

        const claimed = new Set();
        const characters = [];
        const list = Array.isArray(dbObj.characters) ? dbObj.characters : [];
        for (const cha of list) {
            if (!cha) continue;
            const refs = [];
            const collect = (v) => { if (v) refs.push(statsBasename(v)); };
            collect(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) collect(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) collect(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) collect(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) collect(a?.uri);

            // Same asset shared across characters is attributed to the first one we see — avoids double-counting.
            let imgBytes = 0;
            for (const bn of refs) {
                if (!bn || claimed.has(bn)) continue;
                const sz = assetSize.get(bn);
                if (sz != null) {
                    imgBytes += sz;
                    claimed.add(bn);
                }
            }
            const remoteBytes = remoteSize.get(cha.chaId) || 0;

            let chatBytes = 0;
            const charChats = fullChatStore?.get(cha.chaId);
            if (charChats) {
                for (const chat of charChats.values()) {
                    try { chatBytes += JSON.stringify(chat).length; } catch { /* skip un-serializable */ }
                }
            }

            // Card body = the character row minus chats (which we count separately).
            // Asset URIs themselves are tiny strings — leaving them in card body is fine.
            let cardBytes = 0;
            try {
                const { chats: _drop, ...body } = cha;
                cardBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            characters.push({
                chaId: cha.chaId || '',
                name: cha.name || '',
                image: cha.image || '',
                trashed: !!cha.trashTime,
                cardBytes,
                imgBytes: imgBytes + remoteBytes,
                chatBytes,
                totalBytes: cardBytes + imgBytes + remoteBytes + chatBytes,
            });
        }

        const uncleanable = buildUncleanableSet(dbObj);
        let orphanCount = 0, orphanTotal = 0;
        for (const it of kvListWithSizes('assets/')) {
            if (!uncleanable.has(statsBasename(it.key))) {
                orphanCount++;
                orphanTotal += it.size;
            }
        }

        characters.sort((a, b) => b.totalBytes - a.totalBytes);
        return c.json({
            characters,
            orphan: { count: orphanCount, totalSize: orphanTotal },
            chatBytesNote: 'JSON.stringify estimate; on-disk msgpack ~0.6×',
            etag: getDbetag(),
        });
    } catch (err) { next(err); }
});

// Per-module breakdown — modules live inside database.bin (no separate kv keys
// for module bodies), so size = JSON.stringify of the module + sum of its
// referenced assets. Assets attribution is independent from /characters; an
// asset shared between a character and a module would be counted in both.
dbApp.get('/stats/modules', async (c, next) => {
    try {
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            return c.json({ modules: [] });
        }
        const dbObj = await decodeRisuSave(raw);
        const list = Array.isArray(dbObj.modules) ? dbObj.modules : [];

        const assetSize = new Map();
        for (const it of kvListWithSizes('assets/')) {
            assetSize.set(statsBasename(it.key), it.size);
        }

        const modules = [];
        for (const m of list) {
            if (!m) continue;

            let bodyBytes = 0;
            try {
                const { assets: _drop, ...body } = m;
                bodyBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            let assetBytes = 0;
            const seen = new Set();
            if (Array.isArray(m.assets)) {
                for (const a of m.assets) {
                    const bn = statsBasename(a?.[1]);
                    if (!bn || seen.has(bn)) continue;
                    seen.add(bn);
                    const sz = assetSize.get(bn);
                    if (sz != null) assetBytes += sz;
                }
            }

            modules.push({
                id: m.id || m.namespace || m.name || '',
                name: m.name || m.namespace || '',
                bodyBytes,
                assetBytes,
                totalBytes: bodyBytes + assetBytes,
            });
        }

        modules.sort((a, b) => b.totalBytes - a.totalBytes);
        return c.json({ modules, etag: getDbetag() });
    } catch (err) { next(err); }
});

dbApp.post('/optimize', async (c, next) => {
    if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const preDbSize = statSafe(dbFilePath)?.size ?? 0;

        const { free } = await diskFreeStat(saveDir);
        if (preDbSize > 0 && free != null && free < preDbSize * 1.2) {
            return c.json({
                error: 'Insufficient disk space for VACUUM',
                required: Math.ceil(preDbSize * 1.2),
                free,
            }, 400);
        }

        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            try { checkpointWal('TRUNCATE'); } catch (e) { console.warn('[Optimize] checkpoint failed:', e?.message || e); }
            sqliteDb.exec('VACUUM');
            // VACUUM streams the whole DB through the WAL; without this checkpoint the
            // -wal file stays inflated until the next 5-min background TRUNCATE.
            try { checkpointWal('TRUNCATE'); } catch (e) { console.warn('[Optimize] post-VACUUM checkpoint failed:', e?.message || e); }
            const elapsed = Date.now() - t0;
            const postDbSize = statSafe(dbFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preDbSize,
                postDbSize,
                reclaimed: Math.max(0, preDbSize - postDbSize),
            };
        });
        return c.json(result);
    } catch (err) { next(err); }
});

// ── Snapshot list (database/dbbackup-* keys) ─────────────────────────────────

dbApp.get('/snapshots/limits', async (c, next) => {
    try {
        const { maxCount, maxBytes } = getSnapshotLimits();
        const items = kvListWithSizes(DB_BACKUP_PREFIX);
        const currentBytes = items.reduce((s, it) => s + it.size, 0);
        return c.json({
            maxCount,
            maxBytes,
            currentCount: items.length,
            currentBytes,
            bounds: {
                minCount: SNAPSHOT_LIMIT_MIN_COUNT,
                maxCount: SNAPSHOT_LIMIT_MAX_COUNT,
                minBytes: SNAPSHOT_LIMIT_MIN_BYTES,
                maxBytes: SNAPSHOT_LIMIT_MAX_BYTES,
            },
            defaults: {
                count: SNAPSHOT_LIMIT_DEFAULT_COUNT,
                bytes: SNAPSHOT_LIMIT_DEFAULT_BYTES,
            },
        });
    } catch (err) { next(err); }
});

dbApp.put('/snapshots/limits', async (c, next) => {
    if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
    try {
        const rawCount = Number(c.req.json().maxCount);
        const rawBytes = Number(c.req.json().maxBytes);
        if (!Number.isFinite(rawCount) || rawCount < SNAPSHOT_LIMIT_MIN_COUNT || rawCount > SNAPSHOT_LIMIT_MAX_COUNT) {
            return c.json({ error: `maxCount out of range (${SNAPSHOT_LIMIT_MIN_COUNT}-${SNAPSHOT_LIMIT_MAX_COUNT})` }, 400);
        }
        if (!Number.isFinite(rawBytes) || rawBytes < SNAPSHOT_LIMIT_MIN_BYTES || rawBytes > SNAPSHOT_LIMIT_MAX_BYTES) {
            return c.json({ error: `maxBytes out of range` }, 400);
        }
        const maxCount = Math.floor(rawCount);
        const maxBytes = Math.floor(rawBytes);
        kvSet(SNAPSHOT_LIMIT_COUNT_KEY, Buffer.from(String(maxCount), 'utf-8'));
        kvSet(SNAPSHOT_LIMIT_BYTES_KEY, Buffer.from(String(maxBytes), 'utf-8'));
        const trim = trimSnapshotsToLimits();
        const items = kvListWithSizes(DB_BACKUP_PREFIX);
        const currentBytes = items.reduce((s, it) => s + it.size, 0);
        return c.json({
            maxCount, maxBytes,
            currentCount: items.length,
            currentBytes,
            removed: trim.removed,
        });
    } catch (err) { next(err); }
});

dbApp.get('/snapshots', async (c, next) => {
    try {
        const items = kvListWithSizes(DB_BACKUP_PREFIX);
        const out = items.map((it) => {
            const tsRaw = parseInt(it.key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            const ts = Number.isFinite(tsRaw) ? tsRaw * 100 : null;
            return { key: it.key, size: it.size, timestamp: ts };
        }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        return c.json({ snapshots: out });
    } catch (err) { next(err); }
});

dbApp.delete('/snapshots', async (c, next) => {
    if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
    try {
        const key = typeof c.req.query("key") === 'string' ? c.req.query("key") : '';
        // Restrict to snapshot prefix — never let this endpoint touch other kv keys.
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return c.json({ error: 'Invalid snapshot key' }, 400);
        }
        kvDel(key);
        return c.json({ ok: true });
    } catch (err) { next(err); }
});

// Restore a snapshot atomically server-side: copy snapshot blob → live blob,
// invalidate caches, rebuild chat store. Client-side setDatabase + reload is
// racy because the patch-sync save loop is debounced and the reload can fire
// before the snapshot data lands on disk.
dbApp.post('/snapshots/restore', async (c, next) => {
    if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
    try {
        const key = typeof c.req.json()?.key === 'string' ? c.req.json().key : '';
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return c.json({ error: 'Invalid snapshot key' }, 400);
        }
        const blob = kvGet(key);
        if (!blob) {
            return c.json({ error: 'Snapshot not found' }, 404);
        }
        await queueStorageOperation(async () => {
            // Drain any pending debounced persist first — same pattern as
            // /api/db/optimize. Without this, an in-flight save could land
            // after kvCopyValue and overwrite the restored snapshot.
            await flushPendingDb();
            kvCopyValue(key, DB_BLOB_KEY);
            invalidateDbCache();
            // Snapshot may pre-date the remote-block migration. Clear the marker
            // so migrateRemoteBlocksIfNeeded re-evaluates against the restored
            // bytes instead of skipping based on the prior post-migration state.
            kvDel(REMOTE_MIGRATION_MARKER_KEY);
            // Pre-warm chat store from the just-restored blob so subsequent
            // /api/read fetches and patch-sync baselines see the new data.
            // Use decodeDatabaseWithPersistentChatIds so it runs the migration
            // (now unmarked) and refreshes stale raw if the snapshot was a
            // REMOTE-block format.
            try {
                const raw = kvGet(DB_BLOB_KEY);
                if (raw) {
                    const dbObj = await decodeDatabaseWithPersistentChatIds(raw, {
                        createBackup: false,
                    });
                    initChatStore(dbObj);
                    // Migration may have rewritten database.bin — etag must
                    // reflect the post-migration bytes the next /api/read sends.
                    const finalRaw = kvGet(DB_BLOB_KEY);
                    if (finalRaw) setDbetag(computeBufferEtag(Buffer.from(finalRaw)));
                }
            } catch (e) {
                console.warn('[Snapshot restore] post-restore decode failed:', e?.message || e);
            }
        });
        return c.json({ ok: true });
    } catch (err) { next(err); }
});

dbApp.post('/wal-checkpoint', async (c, next) => {
    if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const walFilePath = path.join(saveDir, 'risuai.db-wal');
        const preWalSize = statSafe(walFilePath)?.size ?? 0;

        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            checkpointWal('TRUNCATE');
            const elapsed = Date.now() - t0;
            const postWalSize = statSafe(walFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preWalSize,
                postWalSize,
                reclaimed: Math.max(0, preWalSize - postWalSize),
            };
        });
        return c.json(result);
    } catch (err) { throw err; }
});