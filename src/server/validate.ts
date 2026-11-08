import { DateTime, IANAZone } from 'luxon';
import { ApiError } from './errors.js';
import type { Window } from './slots.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_HOST_SLUGS = new Set(['login', 'dashboard', 'manage', 'api', 'assets', 'book', 'embed', 'waitlist']);

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_body', 'JSON object body required');
  }
  return value as Record<string, unknown>;
}

export function intIn(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function requiredString(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_' + name, `${name} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be 1–${max} characters`);
  }
  return trimmed;
}

export function slug(name: string, value: unknown): string {
  const text = requiredString(name, value, 60);
  if (!SLUG.test(text)) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be lowercase letters, numbers, and hyphens`);
  }
  return text;
}

export function hostSlug(value: unknown): string {
  const text = slug('slug', value);
  if (RESERVED_HOST_SLUGS.has(text)) {
    throw new ApiError(400, 'invalid_slug', 'That host slug is reserved');
  }
  return text;
}

export function email(value: unknown): string {
  const text = requiredString('email', value, 254).toLowerCase();
  if (!EMAIL.test(text)) throw new ApiError(400, 'invalid_email', 'Enter a valid email');
  return text;
}

export function timezone(value: unknown): string {
  const text = requiredString('timezone', value, 80);
  if (text === 'local' || text === 'system' || !IANAZone.isValidZone(text)) {
    throw new ApiError(400, 'invalid_timezone', 'Timezone must be an IANA name such as Asia/Kolkata');
  }
  return text;
}

export function instant(name: string, value: unknown): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be an ISO timestamp`);
  }
  return date;
}

export function windows(value: unknown): Window[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, 'invalid_windows', 'Add at least one time window');
  }
  if (value.length > 12) throw new ApiError(400, 'invalid_windows', 'At most 12 windows');
  const parsed = value.map((item) => {
    const row = requireObject(item);
    const startMin = intIn('startMin', row.startMin, 0, 1439);
    const endMin = intIn('endMin', row.endMin, 1, 1440);
    if (startMin >= endMin) {
      throw new ApiError(400, 'invalid_windows', 'Window end must be after its start');
    }
    return { startMin, endMin };
  });
  parsed.sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].startMin < parsed[i - 1].endMin) {
      throw new ApiError(400, 'invalid_windows', 'Windows on the same day cannot overlap');
    }
  }
  return parsed;
}

export function isoDate(name: string, value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be YYYY-MM-DD`);
  }
  if (!DateTime.fromISO(value, { zone: 'utc' }).isValid) {
    throw new ApiError(400, 'invalid_' + name, `${name} must be YYYY-MM-DD`);
  }
  return value;
}

export function weeklyRules(value: unknown): Array<{ dayOfWeek: number; startMin: number; endMin: number }> {
  if (!Array.isArray(value)) throw new ApiError(400, 'invalid_rules', 'rules must be an array');
  if (value.length > 70) throw new ApiError(400, 'invalid_rules', 'Too many windows');
  const parsed = value.map((item) => {
    const row = requireObject(item);
    const dayOfWeek = intIn('dayOfWeek', row.dayOfWeek, 1, 7);
    const startMin = intIn('startMin', row.startMin, 0, 1439);
    const endMin = intIn('endMin', row.endMin, 1, 1440);
    if (startMin >= endMin) throw new ApiError(400, 'invalid_rules', 'Window end must be after its start');
    return { dayOfWeek, startMin, endMin };
  });
  const byDay = new Map<number, Array<{ startMin: number; endMin: number }>>();
  for (const rule of parsed) {
    const list = byDay.get(rule.dayOfWeek) ?? [];
    list.push(rule);
    byDay.set(rule.dayOfWeek, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < list.length; i++) {
      if (list[i].startMin < list[i - 1].endMin) {
        throw new ApiError(400, 'invalid_rules', 'Windows on the same day cannot overlap');
      }
    }
  }
  return parsed;
}

export function httpUrl(value: unknown): string {
  const text = requiredString('url', value, 500);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError(400, 'invalid_url', 'URL must be http or https');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_url', 'URL must be http or https');
  }
  return url.toString();
}

export function idempotencyKey(value: string | undefined): string {
  if (!value || value.trim() !== value || value.length < 8 || value.length > 200) {
    throw new ApiError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key header is required (8–200 characters)',
    );
  }
  return value;
}
