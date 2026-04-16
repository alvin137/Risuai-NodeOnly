import app from './app/index.js'
import { serveStatic } from 'hono/bun'

app.use('*', serveStatic({ root: '../../../dist' }))
export default {
    port: 6002,
    fetch: app.fetch,
}