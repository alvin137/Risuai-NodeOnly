import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import api from './api.js'

// import { sessionApp } from './session.js';
import { assetApp } from './asset.js'

const app = new Hono()

app.use('*', csrf())
app.use('*', logger())

//api.route('/session', sessionApp);
api.route('/asset', assetApp);
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