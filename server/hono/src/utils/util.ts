import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const HTTP = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE: 422,
    INTERNAL: 500,
} as const;

export const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)) {
    mkdirSync(savePath)
}

const jwtSecretPath = path.join(savePath, '__jwt_secret')
export let jwtSecret: string;
if (existsSync(jwtSecretPath)) {
    jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim()
} else {
    jwtSecret = randomBytes(64).toString('hex')
    writeFileSync(jwtSecretPath, jwtSecret, 'utf-8')
}

export async function badRequest(c: Context, msg: string) {
    return c.json({error: msg}, HTTP.BAD_REQUEST);
}