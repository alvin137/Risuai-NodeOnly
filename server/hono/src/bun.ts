import path from 'path'
import app from './app/index.js'
import { serveStatic } from 'hono/bun'
import { Hono } from 'hono';

app.use('*', async (c, next) => {
  if (c.req.path === '/' || c.req.path.endsWith('/')) {
    return next();
  }
  return serveStatic({
    root: path.join(process.cwd(), "dist"),
    onFound: (_path, c) => {
      c.header("Cache-Control", "public, max-age=0");
    },
  })(c, next);
});

app.use("/assets", serveStatic({ 
    root: path.join(process.cwd(), "dist/assets"), 
    onFound: (path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
    }
}));



export default {
    port: 6002,
    fetch: app.fetch,
    maxRequestBodySize: 2* 1024 * 1024 * 1024,
}