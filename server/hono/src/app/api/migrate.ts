import { Hono } from "hono";
import path from "node:path";
import { savePath, hexRegex } from "../../utils/util";
import { readdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkAuth } from "../api";
import { kvDelPrefix, clearEntities, db as sqliteDb } from "../../utils/db";
import { flushPendingDb, createBackupAndRotate, invalidateDbCache } from "../../utils/asset.util";

export const migrateApp = new Hono();

let importInProgress = false;

export const BACKUP_IMPORT_MAX_BYTES = Number(process.env.RISU_BACKUP_IMPORT_MAX_BYTES ?? '0');


// ── Save-folder migration endpoints ──────────────────────────────────────────
const migrationMarkerPath = path.join(savePath, '.migrated_to_sqlite');

function scanHexFilesInDir(dirPath: string) {
    let files;
    try {
        files = readdirSync(dirPath);
    } catch {
        return { hexFiles: [], count: 0, totalSize: 0, hasDatabase: false };
    }
    const hexFiles = files.filter(f => hexRegex.test(f));
    let totalSize = 0;
    let hasDatabase = false;
    for (const f of hexFiles) {
        try {
            const stat = require('fs').statSync(path.join(dirPath, f));
            totalSize += stat.size;
        } catch { /* skip unreadable files */ }
        try {
            if (Buffer.from(f, 'hex').toString('utf-8') === 'database/database.bin') hasDatabase = true;
        } catch { /* invalid hex */ }
    }
    return { hexFiles, count: hexFiles.length, totalSize, hasDatabase };
}

function clearExistingData() {
    kvDelPrefix('assets/');
    kvDelPrefix('inlay/');
    kvDelPrefix('inlay_thumb/');
    kvDelPrefix('inlay_meta/');
    kvDelPrefix('inlay_info/');
    clearEntities();
}

async function importHexFilesFromDir(dirPath: string) {
    const { hexFiles, hasDatabase } = scanHexFilesInDir(dirPath);
    if (hexFiles.length === 0) return { imported: 0 };
    if (!hasDatabase) throw new Error('Save folder does not contain database/database.bin');

    await flushPendingDb();
    createBackupAndRotate();
    invalidateDbCache();

    const insert = sqliteDb.query(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = sqliteDb.transaction(() => {
        clearExistingData();
        for (const hexFile of hexFiles) {
            const key = Buffer.from(hexFile, 'hex').toString('utf-8');
            const value = readFileSync(path.join(dirPath, hexFile));
            insert.run(key, value, now);
        }
    });
    run();

    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: hexFiles.length };
}

async function importHexEntries(entries: { key: string, value: Buffer}[]) {
    if (entries.length === 0) return { imported: 0 };
    const hasDb = entries.some(e => e.key === 'database/database.bin');
    if (!hasDb) throw new Error('Data does not contain database/database.bin');

    await flushPendingDb();
    createBackupAndRotate();
    invalidateDbCache();

    const insert = sqliteDb.query(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = sqliteDb.transaction(() => {
        clearExistingData();
        for (const { key, value } of entries) {
            insert.run(key, value, now);
        }
    });
    run();

    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: entries.length };
}

migrateApp.post('/save-folder/scan', async (c, next) => {
    //if (!await checkAuth(req, res)) return;
    //if (!checkActiveSession(req, res)) return;
    try {
        const body = await c.req.json();
        const folderPath = body.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                return c.json({ error: 'Path is not a directory' }, 400);
            }
        } catch {
            return c.json({ error: 'Cannot access directory' }, 400);
        }
        const { count, totalSize, hasDatabase } = scanHexFilesInDir(resolved);
        return c.json({ count, totalSize, hasDatabase });
    } catch (error) {
        throw error;
    }
});

migrateApp.post('/save-folder/execute', async (c, next) => {
    //if (!await checkAuth(req, res)) return;
    //if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        return c.json({ error: 'Another import is already in progress' }, 409);
    }
    importInProgress = true;
    try {
        const body = await c.req.json();
        const folderPath = body.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                return c.json({ error: 'Path is not a directory' }, 400);
            }
        } catch {
            return c.json({ error: 'Cannot access directory' }, 400);
        }
        const result = await importHexFilesFromDir(resolved);
        return c.json({ ok: true, imported: result.imported });
    } catch (error) {
        return c.json({ error: error.message || 'Import failed' }, 400);
    } finally {
        importInProgress = false;
    }
});

migrateApp.post('/save-folder/upload', async (c, next) => {
    //if (!await checkAuth(req, res)) return;
    //if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        return c.json({ error: 'Another import is already in progress' }, 409);
    }
    importInProgress = true;

    try {
        const body = c.req.raw.body;
        if (!body) return c.json({ error: 'No body' }, 400);

        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.length;
            if (BACKUP_IMPORT_MAX_BYTES > 0 && totalSize > BACKUP_IMPORT_MAX_BYTES) {
                reader.cancel();
                return c.json({ error: 'Zip file exceeds max allowed size' }, 413);
            }
            chunks.push(value);
        }
        const zipBuffer = Buffer.concat(chunks);

        const fflate = require('fflate');
        let unzipped;
        try {
            unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));
        } catch {
            return c.json({ error: 'Invalid or corrupted zip file' }, 400);
        }

        const entries = [];
        for (const [entryPath, data] of Object.entries(unzipped)) {
            if (data.length === 0) continue;
            const basename = path.basename(entryPath);
            if (!hexRegex.test(basename)) continue;
            try {
                const key = Buffer.from(basename, 'hex').toString('utf-8');
                entries.push({ key, value: Buffer.from(data) });
            } catch { /* invalid hex filename */ }
        }

        if (entries.length === 0) {
            return c.json({ error: 'No compatible hex files found in zip' }, 400);
        }

        const result = await importHexEntries(entries);
        return c.json({ ok: true, imported: result.imported });
    } catch (error) {
        return c.json({ error: error.message || 'Import failed' }, 400);
    } finally {
        importInProgress = false;
    }
});

migrateApp.post('/save-folder/cleanup/scan', async (c, next) => {
    // if (!await checkAuth(c)) return;
    // if (!checkActiveSession(c)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            c.json({ error: 'Migration has not been completed yet' }, 400);
        }
        const { count, totalSize } = scanHexFilesInDir(savePath);
        return c.json({ count, totalSize });
    } catch (error) {
        throw error;
    }
});

migrateApp.post('/save-folder/cleanup/execute', async (c, next) => {
    // if (!await checkAuth(req, res)) return;
    // if (!checkActiveSession(req, res)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            return c.json({ error: 'Migration has not been completed yet' }, 400);
        }
        const { hexFiles } = scanHexFilesInDir(savePath);
        let removed = 0;
        let freedBytes = 0;
        for (const f of hexFiles) {
            try {
                const filePath = path.join(savePath, f);
                const stat = require('fs').statSync(filePath);
                unlinkSync(filePath);
                freedBytes += stat.size;
                removed++;
            } catch { /* skip unremovable files */ }
        }
        return c.json({ok: true, removed, freedBytes});
    } catch (error) {
        throw error;
    }
});

export function setImportProgress(inProgress: boolean) {
    importInProgress = inProgress;
}

export function isImportInProgress() {
    return importInProgress;
}