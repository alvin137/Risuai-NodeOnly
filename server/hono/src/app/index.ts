import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import api from './api.js'

// import { sessionApp } from './session.js';
import { assetApp } from './asset.js'
import { patchApp } from './api/patch.js';

const app = new Hono()

app.use('*', csrf())
app.use('*', logger())

app.onError((err, c) => {
  console.error('Error occurred:', err);
  console.error("Details: ", err.stack);
  return c.json({ error: 'Internal Server Error' }, 500);
});

//api.route('/session', sessionApp);
api.route('/asset', assetApp);
api.route("/patch", patchApp);
app.route('/api', api);

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