import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { jwtSecret } from '../../utils/util';
import { existsSync, readFileSync } from 'fs';
import path from 'node:path';
import { hash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseSessionCookie, sessions } from '../session';
import { rateLimiter } from 'hono-rate-limiter'
import { getConnInfo } from 'hono/bun';

export const loginApp = new Hono();

export let password = "";

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

const loginRouteLimiter = rateLimiter({
  windowMs: 30 * 1000,
  limit: 10,
  standardHeaders: 'draft-6',
  keyGenerator: (c) => getConnInfo(c).remote.address || 'unknown',
  handler: (c) => c.json({ error: 'Too many attempts. Please wait and try again later.' }, 429)
})

// TODO: Add loginRouteLimiter
// Need to route before JWT middleware
loginApp.post('/login', loginRouteLimiter, async (c) => {
    if(password === ''){
        return c.json({error: 'Password not set'}, 400)
    }
    const body = await c.req.json();
    if(body.password && body.password.trim() === password.trim()){
        return c.json({status: 'success', token: await createServerJwt()})
    }
    else{
        return c.json({error: 'Password incorrect'}, 400)
    }
})

// NodeOnly: token refresh endpoint (pairs with server-side JWT)
loginApp.post('/token/refresh', async (c) => {
  const token = c.req.header('risu-auth')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const payload = await verify(token, jwtSecret)
    return c.json({ token: await createServerJwt() })
  } catch (e) {
    if (e.name === 'JwtTokenExpired') {
      return c.json({ token: await createServerJwt() })
    }
    return c.json({ error: 'Unauthorized' }, 401)
  }
})

loginApp.post('/crypto', async (c) => {
    const body = await c.req.json();
    const hasher = new Bun.CryptoHasher('sha256', body.data);
    return c.body(hasher.digest('hex'));
})

// Need to route before JWT middleware
loginApp.post('/set_password', async (c) => {
    if(password === ''){
        const body = await c.req.json();
        password = body.password;
        writeFileSync(passwordPath, password, 'utf-8')
        return c.json({status: 'success'})
    }
    else{
        return c.json({error: 'Password already set'}, 400)
    }
})

// Need to route before JWT middleware
loginApp.get('/test_auth', async(c) => {
    if(!password){
        return c.json({status: 'unset'})
    }
    const token = c.req.header("risu-auth");
    const isValidJwt = token ? await verify(token, jwtSecret).then(() => true).catch(() => false) : false;
    if (isValidJwt) return c.json({status: "success", token: await createServerJwt()});
    const sessionToken = parseSessionCookie(c.req);
    if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
        return c.json({ status: 'success', token: await createServerJwt() })
    }
    return c.json({ status: "incorrect"}, 401);
})

async function createServerJwt() {
  const now = Math.floor(Date.now() / 1000)
  return await sign({ iat: now, exp: now + 5 * 60 }, jwtSecret)
}
