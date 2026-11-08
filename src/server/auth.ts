import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { one } from './db.js';
import type { Db } from './db.js';

const COOKIE = 'slotbook_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionHost = {
  id: string;
  email: string;
  name: string;
  slug: string;
  timezone: string;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function secret(): string {
  return process.env.SESSION_SECRET || 'dev-only-change-me';
}

export function signSession(hostId: string): string {
  const payload = Buffer.from(JSON.stringify({ hostId, exp: Date.now() + SESSION_MS })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token: string | undefined): { hostId: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { hostId?: string; exp?: number };
    if (!body.hostId || typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    return { hostId: body.hostId };
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === name) return rest.join('=');
  }
  return undefined;
}

export async function hostFromRequest(c: Context, db: Db): Promise<SessionHost | null> {
  const session = readSession(cookieValue(c.req.header('cookie'), COOKIE));
  if (!session) return null;
  return one<SessionHost>(
    db,
    `SELECT id, email, name, slug, timezone FROM hosts WHERE id = $1`,
    [session.hostId],
  );
}

export function newManageToken(): string {
  return randomBytes(32).toString('base64url');
}
