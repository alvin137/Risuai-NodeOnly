import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import { compress } from 'hono/compress'
import { bodyLimit } from 'hono/body-limit'
import api from './api.js'
import { cleanupJob, PROXY_STREAM_DEFAULT_TIMEOUT_MS, PROXY_STREAM_GC_INTERVAL_MS, proxyApp, proxyStreamJobs } from './proxy.js'

import { sessionApp } from './session.js';
import { assetApp } from './asset.js'
import { patchApp } from './api/patch.js';
import { chatApp } from './api/chat.js'
import { migrateApp } from './api/migrate.js'
import { checkpointWal } from '../utils/db.js'
import { flushPendingDb, migrateInlaysToFilesystem } from '../utils/asset.util.js'
import { tunnelApp, stopTunnel } from './api/tunnel.js'
import { backupApp } from './api/backup.js'

const app = new Hono();



app.use('*', csrf())
app.use('*', logger())
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

api.route('/session', sessionApp);
api.route('/asset', assetApp);
api.route("/patch", patchApp);
api.route("/chat-content", chatApp);
api.route("/migrate", migrateApp);
api.route("/backup", backupApp);
api.route("/tunnel", tunnelApp);
app.route('/api', api);
app.route("/", proxyApp);


await migrateInlaysToFilesystem();

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
  try { checkpointWal('RESTART'); }
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