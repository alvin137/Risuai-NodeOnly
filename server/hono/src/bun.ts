import path from 'path'
import app from './app/index.js'
import { serveStatic } from 'hono/bun'
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import fs from "node:fs/promises"
import htmlparser from "node-html-parser";
import { getHttpsOptions } from './utils/util.js';

// Configuration flags for patch-based sync
const enablePatchSync = true;

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

app.get("/", async (c, next) => {
  const clientIP = getConnInfo(c).remote.address || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
      const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
      const root = htmlparser.parse(mainIndex.toString())
      const head = root.querySelector('head')
      if (!head) throw new Error("No <head> in index.html")
      head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}</script>` + head.innerHTML
      
      c.body(root.toString());
    } catch (error) {
      throw new Error(`Failed to read index.html: ${error.message}`);
    }
});


const httpsOptions = await getHttpsOptions();

export default {
    port: 6002,
    fetch: app.fetch,
    maxRequestBodySize: 2* 1024 * 1024 * 1024,
    ...(httpsOptions && {
      tls: {
        cert: httpsOptions.cert,
        key: httpsOptions.key,
      }
    })
}