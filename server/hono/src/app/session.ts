import { checkAuth } from './api';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { Context, HonoRequest, Next } from 'hono';
import { getCookie } from 'hono/cookie';

export const sessionApp = new Hono();

// ── Session store for direct asset URL auth (F-0) ──────────────────────────
// <img src="/api/asset/..."> cannot send custom headers, so we use a session
// cookie issued after initial JWT auth. Single-user environment: Map is fine.
// Sessions are persisted to disk so they survive server restarts.
const SESSION_FILE = path.join(process.cwd(), 'save', '__sessions')
const sessions = new Map() // token → expiresAt (ms)

function loadSessions() {
    try {
        const raw = readFileSync(SESSION_FILE, 'utf-8')
        const now = Date.now()
        for (const [token, exp] of JSON.parse(raw)) {
            if (exp > now) sessions.set(token, exp)
        }
    } catch { /* file missing or corrupt – start fresh */ }
}

function saveSessions() {
    try { writeFileSync(SESSION_FILE, JSON.stringify([...sessions])) }
    catch { /* non-critical */ }
}

loadSessions();

function parseSessionCookie(req: HonoRequest) {
    const cookieHeader = req.header("cookie") || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function sessionAuthMiddleware(c: Context, next: Next) {
    const token = parseSessionCookie(c.req)
    if (token && (sessions.get(token) ?? 0) > Date.now()) return next()
    return c.status(401);
}

// ── Active writer session (single-writer lock) ────────────────────────────────
// Mirrors the BroadcastChannel-based tab lock on the server side so that the
// same protection extends across devices. The last client to call /api/session
// becomes the active writer; older sessions receive 423 on write attempts.
let activeSessionId: string | null = null // string | null

// TODO: Need edit
function checkActiveSession(c: Context) {
    const clientSessionId = c.req.header("x-session-id");
    if (!clientSessionId) return true  // client without session support
    if (!activeSessionId) return true  // no session registered yet
    if (clientSessionId === activeSessionId) return true
    return c.json({ error: 'Session deactivated' }, 423);
}

// ── Session cookie issuance (F-0) ──────────────────────────────────────────
// Called once after JWT auth succeeds. Issues a long-lived cookie so that
// <img src="/api/asset/..."> requests can be authenticated without JS.


sessionApp.post('/', async (c) => {
    const auth = await checkAuth(c);
    if (auth instanceof Response) return auth;
    const clientSessionId = c.req.header('x-session-id');
    if (clientSessionId) {
        activeSessionId = clientSessionId
        console.log('[Session] Active writer session updated')
    }
    const token = nodeCrypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    sessions.set(token, expiresAt)
    // Prune stale sessions (bounded by single-user usage, safe to do inline)
    for (const [t, exp] of sessions) {
        if (exp < Date.now()) sessions.delete(t)
    }
    saveSessions()
    const maxAge = 7 * 24 * 60 * 60 // seconds
    c.res.headers.set('Set-Cookie', `risu-session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`)
    return c.json({ ok: true });
})