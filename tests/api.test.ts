import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { hashPassword } from '../src/server/auth.js';
import { app } from '../src/server/app.js';
import { closePool, getPool, one } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';
import { migrate } from '../src/db/migrate.js';

loadEnv();

const hostSlug = 'test-host';
let hostId = '';

async function call(
  path: string,
  init: { method?: string; body?: unknown; key?: string; cookie?: string } = {},
) {
  const response = await app.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.key ? { 'idempotency-key': init.key } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json, headers: response.headers };
}

function tomorrowAt(hour: number, minute = 0): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCHours(hour, minute, 0, 0);
  return day.toISOString();
}

async function wipeBookings() {
  await getPool().query(`DELETE FROM notifications WHERE host_id = $1`, [hostId]);
  await getPool().query(
    `DELETE FROM bookings WHERE event_type_id IN (SELECT id FROM event_types WHERE host_id = $1)`,
    [hostId],
  );
  await getPool().query(`DELETE FROM date_overrides WHERE host_id = $1`, [hostId]);
  await getPool().query(`DELETE FROM idempotency_keys WHERE key LIKE 'test-%'`);
  await getPool().query(`UPDATE hosts SET timezone = 'UTC' WHERE id = $1`, [hostId]);
  await getPool().query(`UPDATE event_types SET min_notice_min = 0 WHERE host_id = $1`, [hostId]);
}

describe('booking API', { concurrency: 1 }, () => {
  before(async () => {
    await migrate();
    await getPool().query(
      `DELETE FROM bookings WHERE event_type_id IN (
         SELECT id FROM event_types WHERE host_id IN (SELECT id FROM hosts WHERE slug = $1)
       )`,
      [hostSlug],
    );
    await getPool().query(`DELETE FROM hosts WHERE slug = $1`, [hostSlug]);
    const host = await one<{ id: string }>(
      getPool(),
      `INSERT INTO hosts (email, name, slug, timezone, password_hash)
       VALUES ('test-host@slotbook.dev', 'Test Host', $1, 'UTC', $2)
       RETURNING id`,
      [hostSlug, hashPassword('test-password')],
    );
    hostId = host!.id;
    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      await getPool().query(
        `INSERT INTO availability_rules (host_id, day_of_week, start_min, end_min) VALUES ($1, $2, 540, 1020)`,
        [hostId, day],
      );
    }
    await getPool().query(
      `INSERT INTO event_types (
         host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days
       ) VALUES ($1, 'Seat', 'seat', 30, 1, 0, 0, 0, 60)`,
      [hostId],
    );
    await getPool().query(
      `INSERT INTO event_types (
         host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days
       ) VALUES ($1, 'Group', 'group', 30, 3, 0, 0, 0, 60)`,
      [hostId],
    );
    await getPool().query(
      `INSERT INTO event_types (
         host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days
       ) VALUES ($1, 'Padded', 'padded', 30, 1, 0, 30, 0, 60)`,
      [hostId],
    );
  });

  beforeEach(wipeBookings);
  after(async () => {
    await closePool();
  });

  it('holds one seat under concurrent requests and replays the idempotency key', async () => {
    const startsAt = tomorrowAt(10);
    const keys = Array.from({ length: 8 }, () => `test-${randomUUID()}`);
    const results = await Promise.all(
      keys.map((key) => call('/api/holds', { key, body: { host: hostSlug, eventSlug: 'seat', startsAt } })),
    );
    const created = results.filter((result) => result.status === 201);
    assert.equal(created.length, 1);

    const replay = await call('/api/holds', {
      key: keys[results.findIndex((result) => result.status === 201)],
      body: { host: hostSlug, eventSlug: 'seat', startsAt },
    });
    assert.equal(replay.status, 201);
    assert.equal((replay.json as { id: string }).id, (created[0].json as { id: string }).id);

    const mismatch = await call('/api/holds', {
      key: keys[results.findIndex((result) => result.status === 201)],
      body: { host: hostSlug, eventSlug: 'seat', startsAt: tomorrowAt(11) },
    });
    assert.equal(mismatch.status, 409);
    assert.equal((mismatch.json as { code: string }).code, 'idempotency_key_reuse');

    const count = await one<{ n: number }>(
      getPool(),
      `SELECT count(*)::int AS n
       FROM bookings b JOIN event_types e ON e.id = b.event_type_id
       WHERE e.host_id = $1 AND b.status = 'held'`,
      [hostId],
    );
    assert.equal(count!.n, 1);
  });

  it('lets a group event take exactly its capacity', async () => {
    const startsAt = tomorrowAt(11);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call('/api/holds', {
          key: `test-${randomUUID()}`,
          body: { host: hostSlug, eventSlug: 'group', startsAt },
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 201).length, 3);
  });

  it('keeps the buffer after a meeting clear', async () => {
    const first = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'padded', startsAt: tomorrowAt(9) },
    });
    assert.equal(first.status, 201);
    const blocked = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'padded', startsAt: tomorrowAt(9, 30) },
    });
    assert.equal(blocked.status, 409);
    const open = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'padded', startsAt: tomorrowAt(10) },
    });
    assert.equal(open.status, 201);
  });

  it('ignores a client-supplied expiry and frees the seat when the hold lapses', async () => {
    const startsAt = tomorrowAt(12);
    const held = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt, expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    assert.equal(held.status, 201);
    const body = held.json as { id: string; now: string; expiresAt: string };
    assert.equal(Date.parse(body.expiresAt) - Date.parse(body.now), 5 * 60 * 1000);

    await getPool().query(`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [body.id]);
    const again = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt },
    });
    assert.equal(again.status, 201);
    const late = await call(`/api/holds/${body.id}/confirm`, { body: { name: 'Ada', email: 'ada@example.com' } });
    assert.equal(late.status, 409);
    const expired = await one<{ status: string }>(getPool(), `SELECT status FROM bookings WHERE id = $1`, [body.id]);
    assert.equal(expired!.status, 'expired');
  });

  it('confirms once, moves, and cancels without duplicate notifications', async () => {
    const startsAt = tomorrowAt(13);
    const held = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt },
    });
    const id = (held.json as { id: string }).id;
    const first = await call(`/api/holds/${id}/confirm`, { body: { name: 'Ada Lovelace', email: 'Ada@Example.com' } });
    assert.equal(first.status, 200);
    const token = (first.json as { manageToken: string }).manageToken;
    const replay = await call(`/api/holds/${id}/confirm`, { body: { name: 'Ada Lovelace', email: 'ada@example.com' } });
    assert.equal(replay.status, 200);
    const clash = await call(`/api/holds/${id}/confirm`, { body: { name: 'Grace', email: 'grace@example.com' } });
    assert.equal(clash.status, 409);

    const moved = await call(`/api/bookings/${token}/reschedule`, { body: { startsAt: tomorrowAt(14) } });
    assert.equal(moved.status, 200);
    assert.equal((moved.json as { startsAt: string }).startsAt, tomorrowAt(14));

    const other = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt: tomorrowAt(15) },
    });
    const otherId = (other.json as { id: string }).id;
    const otherBooking = await call(`/api/holds/${otherId}/confirm`, { body: { name: 'Grace', email: 'grace@example.com' } });
    const blocked = await call(`/api/bookings/${token}/reschedule`, { body: { startsAt: tomorrowAt(15) } });
    assert.equal(blocked.status, 409);
    const still = await call(`/api/bookings/${token}`);
    assert.equal((still.json as { startsAt: string }).startsAt, tomorrowAt(14));

    const cancelled = await call(`/api/bookings/${token}/cancel`, { body: { reason: 'Plans changed' } });
    assert.equal(cancelled.status, 200);
    const cancelledAgain = await call(`/api/bookings/${token}/cancel`, { body: { reason: 'Plans changed' } });
    assert.equal(cancelledAgain.status, 200);

    const notes = await one<{ n: number }>(
      getPool(),
      `SELECT count(*)::int AS n FROM notifications WHERE host_id = $1`,
      [hostId],
    );
    assert.equal(notes!.n, 4);
    assert.equal((otherBooking.json as { status: string }).status, 'confirmed');

    const freed = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt: tomorrowAt(14) },
    });
    assert.equal(freed.status, 201);
  });

  it('hides a day off and a too-soon slot', async () => {
    const day = tomorrowAt(9).slice(0, 10);
    const login = await call('/api/auth/login', { body: { email: 'test-host@slotbook.dev', password: 'test-password' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const saved = await call(`/api/host/overrides/${day}`, {
      method: 'PUT',
      cookie,
      body: { unavailable: true, windows: [] },
    });
    assert.equal(saved.status, 200);

    const from = new Date(tomorrowAt(0));
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const slots = await call(
      `/api/hosts/${hostSlug}/events/seat/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&tz=UTC`,
    );
    assert.equal(slots.status, 200);
    assert.equal(slots.headers.get('cache-control'), 'no-store');
    assert.equal((slots.json as { slots: unknown[] }).slots.length, 0);

    const held = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt: tomorrowAt(9) },
    });
    assert.equal(held.status, 409);

    await call(`/api/host/overrides/${day}`, { method: 'DELETE', cookie });
    await getPool().query(`UPDATE event_types SET min_notice_min = 3000 WHERE slug = 'seat' AND host_id = $1`, [hostId]);
    const tooSoon = await call('/api/holds', {
      key: `test-${randomUUID()}`,
      body: { host: hostSlug, eventSlug: 'seat', startsAt: tomorrowAt(9) },
    });
    assert.equal(tooSoon.status, 409);
    await getPool().query(`UPDATE event_types SET min_notice_min = 0 WHERE slug = 'seat' AND host_id = $1`, [hostId]);
  });

  it('offers 09:00 in Asia/Kolkata as 03:30 UTC', async () => {
    await getPool().query(`UPDATE hosts SET timezone = 'Asia/Kolkata' WHERE id = $1`, [hostId]);
    const monday = DateTime.now().setZone('Asia/Kolkata').startOf('day').plus({ days: 1 });
    let day = monday;
    while (day.weekday !== 1) day = day.plus({ days: 1 });
    const expected = day.set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO();
    const from = day.startOf('day').toUTC().toJSDate();
    const to = day.endOf('day').toUTC().toJSDate();
    const slots = await call(
      `/api/hosts/${hostSlug}/events/seat/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&tz=Asia/Kolkata`,
    );
    const starts = (slots.json as { slots: { startsAt: string }[] }).slots.map((slot) => Date.parse(slot.startsAt));
    assert.ok(starts.includes(Date.parse(expected!)));
    await getPool().query(`UPDATE hosts SET timezone = 'UTC' WHERE id = $1`, [hostId]);
  });
});
