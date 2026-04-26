import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import { compress } from 'hono/compress'
import { bodyLimit } from 'hono/body-limit'
import path, { join } from 'path'
import fs from "node:fs/promises"
import api from './api.js'
import { proxyApp } from './proxy.js'

import { sessionApp } from './session.js';
import { assetApp } from './asset.js'
import { patchApp } from './api/patch.js';
import { chatApp } from './api/chat.js'

const app = new Hono();

const sslPath = join(process.cwd(), 'server/node/ssl/certificate');


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
app.route('/api', api);
app.route("/", proxyApp);

app.all('*', async (c) => {
  const url = new URL(c.req.url);
  const res = await fetch(`http://localhost:6001${url.pathname}${url.search}`, {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-expect-error
    duplex: 'half',
  })

  const resHeaders = new Headers(res.headers)
  resHeaders.delete('content-encoding')
  resHeaders.delete('content-length')

  return new Response(res.body, {
    status: res.status,
    headers: resHeaders,
    statusText: res.statusText,
  })
})

export default app