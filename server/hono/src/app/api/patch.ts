import { Hono } from "hono";
import { decodeRisuSave, encodeRisuSaveLegacy, isHex, normalizeJSON, calculateHash } from "../../utils/util";
import { kvGet, kvSet } from "../../utils/db";
import { applyPatch } from "fast-json-patch";
import { dbCache, saveTimers, SAVE_INTERVAL, queueStorageOperation, decodeDatabaseWithPersistentChatIds, initChatStore, stripChatsFromDb, persistDbCacheWithChats, createBackupAndRotate, computeBufferEtag, setDbetag, getDbetag, findChatInternalFieldOps, clearPersistFailure, recordPersistFailure, currentPersistWarning } from "../../utils/asset.util";
import { checkActiveSession } from "../session";

export const patchApp = new Hono();

// Configuration flags for patch-based sync
const enablePatchSync = true;


// TODO: Add authentication and session checks as needed
// TODO: make dbCache to getter, setter
patchApp.post("", async(c) => {
  if (!enablePatchSync) {
    return c.json({error: 'Patch sync is disabled'}, 503);
  }

  if (!checkActiveSession(c)) return c.json({ error: 'Session deactivated' }, 423);
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
          dbCache[filePath] = decoded;
        }
      } else {
        dbCache[filePath] = normalizeJSON(dbCache[filePath]);
      }
    }

      // Reject patch ops that touch chat-internal fields. Lazy loading
      // strips chats to stubs in dbCache; the only legitimate chat ops
      // are stub metadata (id, name, _stub, lastDate, folderId, modules)
      // or whole-chat add/replace/remove. Field-level ops on chats —
      // particularly remove of message/hypaV3Data/scriptstate/etc —
      // strip the `_stub` flag and cause silent on-disk data loss when
      // reassembleFullDb later sees the metadata-only chat. Reject as
      // 409 so the client falls through to a full write and rebases its
      // patcher baseline. See findStubFlagLossChats for the disk-side
      // partner guard.
      const chatInternalOps = decodedKey === 'database/database.bin'
        ? findChatInternalFieldOps(patch)
        : [];
      if (chatInternalOps.length > 0) {
        const sample = chatInternalOps.slice(0, 5).map(v => `${v.op} ${v.path}`).join(', ');
        console.warn(
          `[Patch] Rejected ${chatInternalOps.length} chat-internal field op(s) `
          + `(would corrupt lazy-loaded chats): ${sample}`
        );
        let currentEtag;
        try {
          currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
          setDbetag(currentEtag);
        } catch { }
        return c.json({
          error: 'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
          code: 'CHAT_GUARD_REJECTED',
          chatGuardRejected: true,
          currentEtag,
        }, 409);
      }
    
    const serverHash = calculateHash(dbCache[filePath]).toString(16);

    if (expectedHash !== serverHash) {
      console.log(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
      let currentEtag = undefined;
      if (decodedKey === "database/database.bin") {
        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
        setDbetag(currentEtag);
      }
      return c.json({error: "Hash mismatch", currentEtag}, 409);
    }
    
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
          try {
            kvSet(decodedKey, data);
          } catch (err) {
            if (err && typeof err === 'object') {
              try { err.attemptedSize = data.length; } catch { }
            }
            throw err;
          }
        }
        // Persist succeeded — clear before backup so a backup-only
        // failure isn't attributed to data loss.
        clearPersistFailure();
        if (decodedKey === "database/database.bin") {
          try {
            createBackupAndRotate();
          } catch (backupErr) {
            console.warn(`[Patch] Backup rotation failed for ${decodedKey}:`, backupErr);
          }
        }
      } catch (error) {
        console.error(`Error saving ${decodedKey}:`, error);
        recordPersistFailure(error, `patch:${decodedKey}`);
      } finally {
        delete saveTimers[filePath];
      }
    }, SAVE_INTERVAL);

    if (decodedKey === "database/database.bin") {
      setDbetag(computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]))));
    }

    const responsePayload = {
      success: true,
      appliedOperations: result.length,
      etag: decodedKey === "database/database.bin" ? getDbetag() : undefined,
    };

    const persistWraning = currentPersistWarning();
    if (persistWraning) {
      responsePayload.persistWarning = persistWraning;
    }

    return c.json(responsePayload);
  });
  } catch (error) {
    console.error("Error applying patch:", error);
    return c.json({error: 'Failed to apply patch'}, 500);
}
})

