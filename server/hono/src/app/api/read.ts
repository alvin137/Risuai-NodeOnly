import { Hono } from "hono";
import { checkAuth } from "../api";
import { encodeRisuSaveLegacy, isHex, normalizeJSON } from "../../utils/util";
import { readInlayAssetPayload, readInlayInfoPayload, decodeDatabaseWithPersistentChatIds, stripChatsFromDb, initChatStore, flushPendingDb, dbCache, computeBufferEtag } from "../../utils/asset.util";
import { kvGet } from "../../utils/db";

export const readApp = new Hono();

readApp.get("", async (c, next) => {
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

  try {
    const key = Buffer.from(filePath, "hex").toString("utf-8");
    // Flush pending patches before reading database.bin
    if (key === "database/database.bin") {
      await flushPendingDb();
    }
    let value = null;
    if (key.startsWith("inlay/")) {
      value = await readInlayAssetPayload(key.slice("inlay/".length));
    } else if (key.startsWith("inlay_info/")) {
      value = await readInlayInfoPayload(key.slice("inlay_info/".length));
    }
    if (value === null) {
      value = kvGet(key);
    }
    if (value === null) {
      return c.json({ error: "Not Found" }, 404);
    } else {
      // Strip chat payloads from database.bin — client gets stubs only
      if (key === "database/database.bin") {
        try {
          const dbObj = await decodeDatabaseWithPersistentChatIds(value, {
            createBackup: true,
          });
          initChatStore(dbObj);
          const stripped = normalizeJSON(stripChatsFromDb(dbObj));
          // Populate dbCache so patch endpoint uses the same data
          dbCache[filePath] = stripped;
          value = Buffer.from(encodeRisuSaveLegacy(stripped, true));
        } catch (e) {
          console.error(
            "[Read] Failed to strip chats from database.bin:",
            e.message,
          );
          return next(e);
        }
        let dbEtag = computeBufferEtag(value);
        if (c.req.header("if-none-match") === dbEtag) {
          return c.status(304);
        }
        c.header("x-db-etag", dbEtag);
      }
      c.header("Content-Type", "application/octet-stream");
      return c.body(value);
    }
  } catch (error) {
    console.error("[Read] Error processing read request:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
