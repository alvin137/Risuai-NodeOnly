import { Hono } from "hono";
import { decodeRisuSave, encodeRisuSaveLegacy, isHex, normalizeJSON, calculateHash } from "../../utils/util";
import { kvGet, kvSet } from "../../utils/db";
import { applyPatch } from "fast-json-patch";
import { dbCache, saveTimers, SAVE_INTERVAL, queueStorageOperation, decodeDatabaseWithPersistentChatIds, initChatStore, stripChatsFromDb, persistDbCacheWithChats, createBackupAndRotate, computeBufferEtag, setDbetag, getDbetag } from "../../utils/asset.util";

export const patchApp = new Hono();

// Configuration flags for patch-based sync
const enablePatchSync = true;


// TODO: Add authentication and session checks as needed
// TODO: make dbCache to getter, setter
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
          dbCache[filePath] = decoded;
        }
      } else {
        dbCache[filePath] = normalizeJSON(dbCache[filePath]);
      }
    }

    // TODO: Because of still developing things, skip hash check for now.
    
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
      setDbetag(computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]))));
    }

    return c.json({success: true, appliedOperations: result.length, etag: decodedKey === "database/database.bin" ? getDbetag(): undefined});
  })
  } catch (error) {
    console.error("Error applying patch:", error);
    return c.json({error: 'Failed to apply patch'}, 500);
}
})

