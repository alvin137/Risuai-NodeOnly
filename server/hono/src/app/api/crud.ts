import { Hono } from "hono";
import { unlink } from "node:fs/promises";
import { checkAuth } from "../api";
import { decodeRisuSave, encodeRisuSaveLegacy, isHex, normalizeJSON } from "../../utils/util";
import { initChatStore, flushPendingDb, dbCache, computeBufferEtag, queueStorageOperation, normalizeInlayExt, decodeDataUri, writeInlayFile, writeInlaySidecar, ensureChatStore, reassembleFullDb, DB_HEX_KEY, saveTimers, createBackupAndRotate, getInlaySidecarPath, deleteInlayFile, readAndLoadValue, getStrippedData, setDbetag, getDbetag } from "../../utils/asset.util";
import { kvDel, kvSet } from "../../utils/db";

export function registerCrud(api: Hono) {

  api.get("/read", async (c) => {
    const auth = await checkAuth(c);

    //if (auth instanceof Response) return auth;

    const filePath = c.req.header("file-path");
    if (!filePath) {
      console.log("no path");
      return c.json({ error: "Invalid Request" }, 400);
    }

    if (!isHex(filePath)) {
      console.log("not hex");
      return c.json({ error: "Invalid Request" }, 400);
    }

    const key = Buffer.from(filePath, "hex").toString("utf-8");
    let value = await readAndLoadValue(key);

    if (value === null) return c.body(null);

    // Strip chat payloads from database.bin — client gets stubs only
    if (key === "database/database.bin") {
      const stripped = await getStrippedData(value, filePath);
      value = Buffer.from(encodeRisuSaveLegacy(stripped, true));
      setDbetag(computeBufferEtag(value));
      if (c.req.header("if-none-match") === getDbetag()) {
        return c.body(null, 304);
      }

      // Already set dbEtag before, why making error?
      c.header("x-db-etag", getDbetag() ?? "");
    }
    c.header("Content-Type", "application/octet-stream");
    return c.body(value);
  });

api.post("/write", async (c) => {
    const auth = await checkAuth(c);
    //if (auth instanceof Response) return auth;

    // if (!checkActiveSession(req, res)) return;
    const filePath = c.req.header('file-path');
    const raw = await c.req.arrayBuffer();
    const fileContent = Buffer.from(raw);
    if (!filePath || !fileContent) {
        return c.json({ error: 'File path required' }, 400);
    }
    if(!isHex(filePath)){
        return c.json({ error: 'Invalid Path' }, 400);
    }
    try {
        return await queueStorageOperation(async () => {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');

            // ETag conflict detection for database.bin
            if (key === 'database/database.bin') {
                const ifMatch = c.req.header('x-if-match');
                if (ifMatch && getDbetag() && ifMatch !== getDbetag()) {
                    return c.json({
                        error: 'ETag mismatch - concurrent modification detected',
                        currentEtag: getDbetag()
                    }, 409);
                }
            }

            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = type === 'signature'
                    ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                    : decodeDataUri(parsed?.data).buffer;
                await writeInlayFile(id, ext, buffer, {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                });
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
            } else if (key.startsWith('inlay_info/')) {
                const id = key.slice('inlay_info/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                await writeInlaySidecar(id, parsed);
                kvDel(key);
            } else if (key === 'database/database.bin') {
                // Client sends stubs-only DB — merge full chats from server before persisting
                try {
                    const incomingDb = await decodeRisuSave(fileContent);
                    await ensureChatStore();
                    const fullDb = reassembleFullDb(incomingDb);
                    const mergedContent = Buffer.from(encodeRisuSaveLegacy(fullDb));
                    // Re-init chat store from merged result
                    initChatStore(fullDb);
                    kvSet(key, mergedContent);
                } catch (e) {
                    console.error('[Write] Failed to merge chats into database.bin:', e.message);
                    // Do NOT write stubs-only to disk — that would permanently
                    // destroy existing full chat data. Preserve disk as-is.
                    return c.json({ error: 'Database merge failed' }, 500);
                }
            } else {
                kvSet(key, fileContent);
            }

            // Update ETag, backup, and invalidate cache after database.bin write
            if (key === 'database/database.bin') {
                delete dbCache[DB_HEX_KEY];
                if (saveTimers[DB_HEX_KEY]) {
                    clearTimeout(saveTimers[DB_HEX_KEY]);
                    delete saveTimers[DB_HEX_KEY];
                }
                // ETag based on stripped version (what client sees)
                setDbetag(computeBufferEtag(fileContent));
                createBackupAndRotate();
            }
            // TODO: handle dbEtag
            return c.json({
                success: true,
                etag: key === 'database/database.bin' ? getDbetag() : undefined
            });
        });
    } catch (error) {
        throw error;
    }
});

api.get("/remove", async (c) => {
    const auth = await checkAuth(c);
    //if (auth instanceof Response) return auth;

    const filePath = c.req.header('file-path');
    if (!filePath) {
        return c.json({ error: 'File path required' }, 400);
    }
    if(!isHex(filePath)){
        return c.json({ error: 'Invalid Path' }, 400);
    }
    try {
        const key = Buffer.from(filePath, 'hex').toString('utf-8');
        if (key.startsWith('inlay/')) {
            const id = key.slice('inlay/'.length)
            await deleteInlayFile(id)
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            return c.json({ success: true });
        }
        if (key.startsWith('inlay_info/')) {
            await unlink(getInlaySidecarPath(key.slice('inlay_info/'.length))).catch(() => {});
        }
        kvDel(key);
        return c.json({ success: true });
    } catch (error) {
        throw error;
    }
});

// TODO: Add sessionauthmiddleware 
api.post('/db/flush', async (c) => {
    //if (!checkActiveSession(c)) return;
    try {
        return await queueStorageOperation(async () => {
            await flushPendingDb();
            return c.json({
                success: true,
                etag: getDbetag() ?? undefined
            });
        });
    } catch (error) {
        throw error;
    }
});
}