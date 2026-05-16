import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import { compress } from 'hono/compress'
import { bodyLimit } from 'hono/body-limit'
import { verify } from 'hono/jwt'
import api from './api.js'
import { cleanupJob, PROXY_STREAM_DEFAULT_TIMEOUT_MS, PROXY_STREAM_GC_INTERVAL_MS, proxyApp, proxyStreamJobs } from './proxy.js'

import { parseSessionCookie, sessionApp, sessions } from './session.js';
import { assetApp } from './asset.js'
import { patchApp } from './api/patch.js';
import { chatApp } from './api/chat.js'
import { migrateApp } from './api/migrate.js'
import { checkpointWal } from '../utils/db.js'
import { flushPendingDb, migrateInlaysToFilesystem, migrateRemoteBlocksIfNeeded } from '../utils/asset.util.js'
import { tunnelApp, stopTunnel } from './api/tunnel.js'
import { backupApp } from './api/backup.js'
import { dbApp } from './api/db.js'
import { jwtSecret } from '../utils/util.js'
import { loginApp } from './api/login.js'

const app = new Hono();



app.use('*', csrf())
// app.use('*', logger())
app.use("*", compress());
app.use('*', async (c, next) => {
  if (c.req.path === '/api/backup/import') {
    return next();
  }

  return bodyLimit({
    maxSize: 2 * 1024 * 1024 * 1024,
  })(c, next);
});

app.onError((err, c) => {
  console.error('Error occurred:', err);
  console.error("Details: ", err.stack);
  return c.json({ error: 'Internal Server Error' }, 500);
});

const publicPaths = ['/', '/api/login', '/api/test_auth', '/api/token/refresh', '/api/set_password', '/api/backup/server/save', '/api/backup/export', '/api/update-check', '/api/self-update']
const proxyExcludedPaths = ['/proxy', '/proxy2', '/proxy-stream-jobs']
function isPublicPath(path: string): boolean {
  if (publicPaths.includes(path)) return true
  if (path.startsWith('/api/asset/')) return true
  if (path.startsWith('/hub-proxy')) return true // Hub-proxy handles jwt itself
  if (proxyExcludedPaths.includes(path) || path.startsWith('/proxy-stream-jobs')) return false // Proxy paths need jwt
  if (!path.startsWith('/api')) return true
  return false
}

app.use('*', async (c, next) => {
  if (isPublicPath(c.req.path)) return next()

  const token = c.req.header('risu-auth')
  if (token) {
    try {
      const payload = await verify(token, jwtSecret)
      c.set('jwtPayload', payload)
      return next()
    } catch {
      console.log(`[Auth] Invalid token: ${c.req.method} ${c.req.path}`)
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  const sessionToken = parseSessionCookie(c.req)
  if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
    return next()
  }

  console.log(`[Auth] No auth: ${c.req.method} ${c.req.path}`)
  return c.json({ error: 'Unauthorized' }, 401)
})

api.route('/session', sessionApp);
api.route('/asset', assetApp);
api.route("/patch", patchApp);
api.route("/chat-content", chatApp);
api.route("/migrate", migrateApp);
api.route("/backup", backupApp);
api.route("/tunnel", tunnelApp);
api.route("/db", dbApp);
api.route("/", loginApp);
app.route('/api', api);
app.route("/", proxyApp);


await migrateInlaysToFilesystem();
await migrateRemoteBlocksIfNeeded();

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of proxyStreamJobs.entries()) {
    if (!job.done && now >= job.deadlineAt && !job.abortController.signal.aborted) {
      job.abortController.abort();
    }
    if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
      cleanupJob(jobId);
      continue;
    }
    if (!job.done && now - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
      cleanupJob(jobId);
    }
  }
}, PROXY_STREAM_GC_INTERVAL_MS);

// WAL 체크포인트
setInterval(() => {
  try { checkpointWal('TRUNCATE'); }
  catch { /* non-fatal */ }
}, 5 * 60 * 1000);

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    console.log(`[Server] Received ${sig}, flushing pending data...`);
    stopTunnel();
    try { await flushPendingDb(); } catch (e) { console.error('[Server] Flush error:', e); }
    try { checkpointWal('TRUNCATE'); } catch { /* non-fatal */ }
    process.exit(0);
  });
}

export default app
