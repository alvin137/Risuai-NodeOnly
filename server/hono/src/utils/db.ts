import { Database } from "bun:sqlite"
import path from "node:path";
import fs from "node:fs";

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'risuai.db');
const db = new Database(dbPath);

// WAL mode: better concurrent read performance, single-writer
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -64000');       // 64 MB (default 2 MB) — reduce disk I/O for large blobs
db.exec('PRAGMA temp_store = MEMORY');       // keep temp tables in RAM
db.exec('PRAGMA busy_timeout = 5000');       // wait up to 5 s on lock contention
db.exec('PRAGMA mmap_size = 268435456');     // 256 MB memory-mapped I/O for faster reads

// ─── KV table (replaces /save/ hex files) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);

// Entity tables (characters, chats, settings, presets, modules) were used in
// a previous version. The tables are no longer created or used, but existing
// databases may still contain them. They are left in place (orphaned) to avoid
// destructive DDL on upgrade. clearEntities() handles cleanup during import.

// ─── Migration: /save/ hex files → kv table ──────────────────────────────────
const savePath = path.join(process.cwd(), 'save');
const migrationMarker = path.join(process.cwd(), 'save', '.migrated_to_sqlite');

function migrateFromSaveDir() {
    if (!fs.existsSync(savePath)) return;
    if (fs.existsSync(migrationMarker)) return;

    const hexRegex = /^[0-9a-fA-F]+$/;
    let files;
    try {
        files = fs.readdirSync(savePath);
    } catch {
        return;
    }

    const hexFiles = files.filter(f => hexRegex.test(f));
    if (hexFiles.length === 0) return;

    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const insert = db.query(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = db.transaction(() => {
      for (const f of hexFiles) {
        if (!f) continue;
        const key = Buffer.from(f, 'hex').toString('utf-8');
        const value = fs.readFileSync(path.join(savePath, f));
        insert.run(key, value, now);
      }
    });
    run();

    fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
    console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
    console.log(`[DB] To free disk space, remove migrated files via Settings > Clean Up Save Folder.`);
}

migrateFromSaveDir();

// ─── KV operations ────────────────────────────────────────────────────────────
const stmtKvGet    = db.query<{value: Uint8Array}, [string]>(`SELECT value FROM kv WHERE key = ?`);
const stmtKvSet    = db.query<unknown, [string, Uint8Array, number]>(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvDel    = db.query<unknown, [string]>(`DELETE FROM kv WHERE key = ?`);
const stmtKvList   = db.query<{key: string}, []>(`SELECT key FROM kv`);
const stmtKvPrefix = db.query<{key: string}, [string]>(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvPrefixSizes = db.query<{key: string, size: number}, [string]>(`SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.query<unknown, [string]>(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvSize      = db.query<{size: number}, [string]>(`SELECT LENGTH(value) as size FROM kv WHERE key = ?`);
const stmtKvUpdatedAt = db.query<{updated_at: number}, [string]>(`SELECT updated_at FROM kv WHERE key = ?`);
const stmtKvCopy = db.query<unknown, [string, number, string]>(
    `INSERT OR REPLACE INTO kv (key, value, updated_at) SELECT ?, value, ? FROM kv WHERE key = ?`
);

function kvGet(key: string) {
    const row = stmtKvGet.get(key);
    return row ? row.value : null;
}

function kvSet(key: string, value: any) {
    stmtKvSet.run(key, value, Date.now());
}

function kvDel(key: string) {
    stmtKvDel.run(key);
}

function kvSize(key: string) {
    const row = stmtKvSize.get(key);
    return row ? row.size : null;
}

function kvGetUpdatedAt(key: string) {
    const row = stmtKvUpdatedAt.get(key);
    return row ? row.updated_at : null;
}

function kvCopyValue(srcKey: string, dstKey: string) {
    stmtKvCopy.run(dstKey, Date.now(), srcKey);
}

function kvDelPrefix(prefix: string) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    stmtKvDelPrefix.run(`${escaped}%`);
}

function kvList(prefix?: string) {
    const safePrefix = prefix || undefined;
    if (safePrefix) {
        const escaped = safePrefix.replace(/[\\%_]/g, '\\$&');
        return stmtKvPrefix.all(`${escaped}%`).map(r => r.key);
    }
    return stmtKvList.all().map(r => r.key);
}

function kvListWithSizes(prefix: string) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return stmtKvPrefixSizes.all(`${escaped}%`).map(r => ({ key: r.key, size: r.size }));
}

function checkpointWal(mode = 'TRUNCATE') {
    return db.exec(`PRAGMA wal_checkpoint(${mode})`);
}

function clearEntities() {
    // Entity tables may still exist from previous versions — clear them during backup import
    const tables = ['characters', 'chats', 'settings', 'presets', 'modules'];
    for (const table of tables) {
        const exists = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        if (exists) db.exec(`DELETE FROM ${table}`);
    }
}

export {
    db,
    // KV
    kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue,
    clearEntities,
    checkpointWal,
};
