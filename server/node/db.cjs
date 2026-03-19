'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'risuai.db');
const db = new Database(dbPath);

// WAL mode: better concurrent read performance, single-writer
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');       // 64 MB (default 2 MB) — reduce disk I/O for large blobs
db.pragma('temp_store = MEMORY');       // keep temp tables in RAM
db.pragma('busy_timeout = 5000');       // wait up to 5 s on lock contention
db.pragma('mmap_size = 268435456');     // 256 MB memory-mapped I/O for faster reads

// ─── KV table (replaces /save/ hex files) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);

// ─── Entity tables (Phase 3-2) ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id         TEXT    PRIMARY KEY,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  );

  CREATE TABLE IF NOT EXISTS chats (
    char_id    TEXT    NOT NULL,
    chat_id    TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
    PRIMARY KEY (char_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id         TEXT    PRIMARY KEY DEFAULT 'root',
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  );

  CREATE TABLE IF NOT EXISTS presets (
    id         TEXT    PRIMARY KEY,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  );

  CREATE TABLE IF NOT EXISTS modules (
    id         TEXT    PRIMARY KEY,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);

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
    if (hexFiles.length === 0) {
        fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
        return;
    }

    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const insert = db.prepare(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = db.transaction(() => {
        for (const hexFile of hexFiles) {
            const key = Buffer.from(hexFile, 'hex').toString('utf-8');
            const value = fs.readFileSync(path.join(savePath, hexFile));
            insert.run(key, value, now);
        }
    });
    run();

    fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
    console.log(`[DB] Migration complete. Original files preserved in /save/`);
}

migrateFromSaveDir();

// ─── KV operations ────────────────────────────────────────────────────────────
const stmtKvGet    = db.prepare(`SELECT value FROM kv WHERE key = ?`);
const stmtKvSet    = db.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvDel    = db.prepare(`DELETE FROM kv WHERE key = ?`);
const stmtKvList   = db.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvPrefixSizes = db.prepare(`SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvSize      = db.prepare(`SELECT LENGTH(value) as size FROM kv WHERE key = ?`);
const stmtKvUpdatedAt = db.prepare(`SELECT updated_at FROM kv WHERE key = ?`);

function kvGet(key) {
    const row = stmtKvGet.get(key);
    return row ? row.value : null;
}

function kvSet(key, value) {
    stmtKvSet.run(key, value, Date.now());
}

function kvDel(key) {
    stmtKvDel.run(key);
}

function kvSize(key) {
    const row = stmtKvSize.get(key);
    return row ? row.size : null;
}

function kvGetUpdatedAt(key) {
    const row = stmtKvUpdatedAt.get(key);
    return row ? row.updated_at : null;
}

function kvDelPrefix(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    stmtKvDelPrefix.run(`${escaped}%`);
}

function kvList(prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtKvPrefix.all(`${escaped}%`).map(r => r.key);
    }
    return stmtKvList.all().map(r => r.key);
}

function kvListWithSizes(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return stmtKvPrefixSizes.all(`${escaped}%`).map(r => ({ key: r.key, size: r.size }));
}

// ─── Entity operations (Phase 3-2) ───────────────────────────────────────────
const stmtCharGet    = db.prepare(`SELECT data FROM characters WHERE id = ?`);
const stmtCharSet    = db.prepare(`INSERT OR REPLACE INTO characters (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtCharDel    = db.prepare(`DELETE FROM characters WHERE id = ?`);
const stmtCharList   = db.prepare(`SELECT id, updated_at FROM characters ORDER BY updated_at DESC`);

const stmtChatGet    = db.prepare(`SELECT data FROM chats WHERE char_id = ? AND chat_id = ?`);
const stmtChatSet    = db.prepare(`INSERT OR REPLACE INTO chats (char_id, chat_id, data, updated_at) VALUES (?, ?, ?, ?)`);
const stmtChatDel    = db.prepare(`DELETE FROM chats WHERE char_id = ? AND chat_id = ?`);
const stmtChatDelAll = db.prepare(`DELETE FROM chats WHERE char_id = ?`);
const stmtChatList   = db.prepare(`SELECT chat_id FROM chats WHERE char_id = ?`);

const stmtSettingsGet = db.prepare(`SELECT data FROM settings WHERE id = 'root'`);
const stmtSettingsSet = db.prepare(`INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES ('root', ?, ?)`);

const stmtPresetGet  = db.prepare(`SELECT data FROM presets WHERE id = ?`);
const stmtPresetSet  = db.prepare(`INSERT OR REPLACE INTO presets (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtPresetDel  = db.prepare(`DELETE FROM presets WHERE id = ?`);
const stmtPresetList = db.prepare(`SELECT id FROM presets`);

const stmtModGet     = db.prepare(`SELECT data FROM modules WHERE id = ?`);
const stmtModSet     = db.prepare(`INSERT OR REPLACE INTO modules (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtModDel     = db.prepare(`DELETE FROM modules WHERE id = ?`);
const stmtModList    = db.prepare(`SELECT id FROM modules`);
const stmtClearCharacters = db.prepare(`DELETE FROM characters`);
const stmtClearChats = db.prepare(`DELETE FROM chats`);
const stmtClearSettings = db.prepare(`DELETE FROM settings`);
const stmtClearPresets = db.prepare(`DELETE FROM presets`);
const stmtClearModules = db.prepare(`DELETE FROM modules`);

function checkpointWal(mode = 'TRUNCATE') {
    return db.pragma(`wal_checkpoint(${mode})`);
}

function clearEntities() {
    stmtClearCharacters.run();
    stmtClearChats.run();
    stmtClearSettings.run();
    stmtClearPresets.run();
    stmtClearModules.run();
}

module.exports = {
    db,
    // KV
    kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt,
    // Characters
    charGet:  (id) => { const r = stmtCharGet.get(id); return r ? r.data : null; },
    charSet:  (id, data) => stmtCharSet.run(id, data, Date.now()),
    charDel:  (id) => { stmtChatDelAll.run(id); stmtCharDel.run(id); },
    charList: () => stmtCharList.all(),
    // Chats
    chatGet:  (charId, chatId) => { const r = stmtChatGet.get(charId, chatId); return r ? r.data : null; },
    chatSet:  (charId, chatId, data) => stmtChatSet.run(charId, chatId, data, Date.now()),
    chatDel:  (charId, chatId) => stmtChatDel.run(charId, chatId),
    chatList: (charId) => stmtChatList.all(charId).map(r => r.chat_id),
    // Settings
    settingsGet: () => { const r = stmtSettingsGet.get(); return r ? r.data : null; },
    settingsSet: (data) => stmtSettingsSet.run(data, Date.now()),
    // Presets
    presetGet:  (id) => { const r = stmtPresetGet.get(id); return r ? r.data : null; },
    presetSet:  (id, data) => stmtPresetSet.run(id, data, Date.now()),
    presetDel:  (id) => stmtPresetDel.run(id),
    presetList: () => stmtPresetList.all().map(r => r.id),
    // Modules
    moduleGet:  (id) => { const r = stmtModGet.get(id); return r ? r.data : null; },
    moduleSet:  (id, data) => stmtModSet.run(id, data, Date.now()),
    moduleDel:  (id) => stmtModDel.run(id),
    moduleList: () => stmtModList.all().map(r => r.id),
    clearEntities,
    checkpointWal,
};
