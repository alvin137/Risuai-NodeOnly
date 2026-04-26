import { Hono } from "hono";
import { createBackupAndRotate, DB_HEX_KEY, dbCache, ensureChatStore, fullChatStore, persistDbCacheWithChats, queueStorageOperation, reassembleFullDb, restoreColdStorageChat, SAVE_INTERVAL, saveTimers, stripChatsFromDb } from "../../utils/asset.util";
import { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } from "../../utils/util";
import { kvGet, kvSet } from "../../utils/db";


export const chatApp = new Hono();


// GET /api/chat-content/:chaId/:chatIndex — retrieve full chat from server
chatApp.get('/:chaId/:chatIndex', async (c) => {
    // if (!await checkAuth(req, res)) { return; }
    try {
        const chaId = c.req.param("chaId");
        const chatIndex = parseInt(c.req.param("chatIndex"), 10);
        const expectedChatId = c.req.header('x-chat-id');

        await ensureChatStore();
        // First try fullChatStore (fast path)
        if (fullChatStore === null) throw new Error("fullChatStore not initialized");
        const charChats = fullChatStore.get(chaId);
        if (charChats && expectedChatId) {
            const chat = charChats.get(expectedChatId);
            if (chat) {
                if (!restoreColdStorageChat(chat)) {
                    return c.json({ error: 'Cold storage restore failed' }, 500);
                }
                const encoded = Buffer.from(encodeRisuSaveLegacy(chat));
                c.header('Content-Type', 'application/octet-stream');
                return c.body(encoded);
            }
        }

        // Fallback: load from disk and find by index
        const raw = kvGet('database/database.bin');
        if (!raw) {
            return c.json({ error: 'Database not found' }, 404);
        }
        const dbObj = await decodeRisuSave(raw);
        const char = dbObj.characters?.find(cha => cha?.chaId === chaId);
        if (!char?.chats?.[chatIndex]) {
            return c.json({ error: 'Chat not found' }, 404);
        }
        const chat = char.chats[chatIndex];
        // Verify chatId matches if provided
        if (expectedChatId && chat.id !== expectedChatId) {
            return c.json({ error: 'Chat ID mismatch — index may have shifted' }, 409);
        }
        if (!restoreColdStorageChat(chat)) {
            return c.json({ error: 'Cold storage restore failed' }, 500);
        }
        const encoded = Buffer.from(encodeRisuSaveLegacy(chat));
        c.header('Content-Type', 'application/octet-stream');
        return c.body(encoded);
    } catch (error) {
        throw error;
    }
});

// POST /api/chat-content/:chaId/:chatIndex — save chat content to server
chatApp.post('/:chaId/:chatIndex', async (c) => {
    //if (!await checkAuth(req, res)) { return; }
    //if (!checkActiveSession(req, res)) return;
    try {
        return await queueStorageOperation(async () => {
            const chaId = c.req.param("chaId");
            const chatIndex = parseInt(c.req.param("chatIndex"), 10);
            const expectedChatId = c.req.header('x-chat-id');
            let chatData;
            const contentType = c.req.header('Content-Type') || '';
            if (contentType.includes('application/octet-stream')) {
                // Binary msgpack body (application/octet-stream)
                try {
                    const body = await c.req.arrayBuffer();
                    chatData = await decodeRisuSave(Buffer.from(body));
                } catch (e) {
                    return c.json({ error: 'Invalid binary chat data' }, 400);
                }
            } else {
                // JSON body (legacy)
                chatData = await c.req.json();
            }

            if (!chatData || !expectedChatId) {
                return c.json({ error: 'Chat data and x-chat-id required' }, 400);
            }

            await ensureChatStore();
            
            if (fullChatStore === null) throw new Error("fullChatStore not initialized");

            // Update fullChatStore
            if (!fullChatStore.has(chaId)) {
                fullChatStore.set(chaId, new Map());
            }
            fullChatStore.get(chaId)?.set(expectedChatId, chatData);

            // Schedule debounced persist (reuses existing timer mechanism)
            if (saveTimers[DB_HEX_KEY]) {
                clearTimeout(saveTimers[DB_HEX_KEY]);
            }
            saveTimers[DB_HEX_KEY] = setTimeout(async () => {
                try {
                    // If dbCache has stripped DB, persist with merged chats
                    if (dbCache[DB_HEX_KEY]) {
                        await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
                    } else {
                        // No stripped cache — load, merge, save
                        const raw = kvGet('database/database.bin');
                        if (raw) {
                            const dbObj = normalizeJSON(await decodeRisuSave(raw));
                            const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                            kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
                        }
                    }
                    createBackupAndRotate();
                } catch (error) {
                    console.error('[ChatContent] Error persisting chat:', error);
                } finally {
                    delete saveTimers[DB_HEX_KEY];
                }
            }, SAVE_INTERVAL);
            return c.json({ success: true });
        });
    } catch (error) {
        throw error;
    }
});