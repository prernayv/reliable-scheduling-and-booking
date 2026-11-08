import { createHmac, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type pg from 'pg';
import { newManageToken } from './auth.js';
import { one, rows, withTx } from './db.js';
import { ApiError } from './errors.js';
import { parseIcs, renderInvite } from './ics.js';
import { classifySlot, teamHostIds } from './team.js';

type Db = pg.Pool | pg.PoolClient;

export type LimitEvent = {
  id: string;
  host_id: string;
  timezone: string;
  daily_cap: number | null;
  duration_min: number;
  capacity: number;
  buffer_before_min: number;
  buffer_after_min: number;
  name: string;
  slug: string;
  host_slug: string;
  host_name: string;
};

export async function bump(db: Db, name: string, by = 1): Promise<void> {
  await db.query(
    `INSERT INTO metric_counters (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = metric_counters.value + EXCLUDED.value`,
    [name, by],
  );
}

export async function setGauge(db: Db, name: string, value: number): Promise<void> {
  await db.query(
    `INSERT INTO metric_counters (name, value) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
    [name, value],
  );
}

export async function readMetrics(db: Db): Promise<Record<string, number>> {
  const found = await rows<{ name: string; value: string }>(db, `SELECT name, value FROM metric_counters`);
  const out: Record<string, number> = {};
  for (const row of found) out[row.name] = Number(row.value);
  return out;
}

export function localDay(zone: string, instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(zone).toISODate() ?? '';
}

export async function dayUsage(
  db: Db,
  eventId: string,
  zone: string,
  excludeId: string | null,
): Promise<Map<string, number>> {
  const found = await rows<{ day: string; n: number }>(
    db,
    `SELECT ((starts_at AT TIME ZONE $2)::date)::text AS day, count(*)::int AS n
     FROM bookings
     WHERE event_type_id = $1
       AND ($3::uuid IS NULL OR id <> $3::uuid)
       AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))
     GROUP BY 1`,
    [eventId, zone, excludeId],
  );
  return new Map(found.map((row) => [row.day, row.n]));
}

export async function overlapsBusy(db: Db, hostId: string, start: Date, end: Date): Promise<boolean> {
  const hit = await one(
    db,
    `SELECT id FROM busy_blocks
     WHERE host_id = $1 AND starts_at < $3 AND ends_at > $2
     LIMIT 1`,
    [hostId, start, end],
  );
  return Boolean(hit);
}

export async function loadBusyBlocks(
  db: Db,
  hostId: string,
  from: Date,
  to: Date,
): Promise<Array<{ startsAt: Date; endsAt: Date }>> {
  const found = await rows<{ starts_at: Date; ends_at: Date }>(
    db,
    `SELECT starts_at, ends_at FROM busy_blocks
     WHERE host_id = $1 AND starts_at < $3 AND ends_at > $2`,
    [hostId, from, to],
  );
  return found.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
}

export function blocksSlot(blocks: Array<{ startsAt: Date; endsAt: Date }>, start: Date, end: Date): boolean {
  const a = start.getTime();
  const b = end.getTime();
  return blocks.some((block) => block.startsAt.getTime() < b && a < block.endsAt.getTime());
}

export async function assertDailyCap(db: Db, event: LimitEvent, start: Date, excludeId: string | null): Promise<void> {
  if (event.daily_cap == null) return;
  const usage = await dayUsage(db, event.id, event.timezone, excludeId);
  const used = usage.get(localDay(event.timezone, start)) ?? 0;
  if (used >= event.daily_cap) {
    throw new ApiError(409, 'daily_cap', 'That day already has the maximum number of bookings');
  }
}

export async function guestAlreadyBooked(db: Db, eventId: string, guestEmail: string, exceptId: string): Promise<boolean> {
  const hit = await one(
    db,
    `SELECT id FROM bookings
     WHERE event_type_id = $1 AND guest_email = $2 AND id <> $3
       AND status = 'confirmed' AND ends_at > now()
     LIMIT 1`,
    [eventId, guestEmail, exceptId],
  );
  return Boolean(hit);
}

const REMINDER_OFFSETS: Array<{ kind: '24h' | '1h'; ms: number }> = [
  { kind: '24h', ms: 24 * 60 * 60_000 },
  { kind: '1h', ms: 60 * 60_000 },
];

export async function scheduleReminders(db: Db, bookingId: string, startsAt: Date): Promise<void> {
  await db.query(`UPDATE reminders SET status = 'cancelled' WHERE booking_id = $1 AND status = 'pending'`, [bookingId]);
  for (const reminder of REMINDER_OFFSETS) {
    const fireAt = new Date(startsAt.getTime() - reminder.ms);
    await db.query(
      `INSERT INTO reminders (booking_id, kind, fire_at, status)
       SELECT $1, $2, $3::timestamptz, 'pending'
       WHERE $3::timestamptz > now()
       ON CONFLICT (booking_id, kind)
       DO UPDATE SET fire_at = EXCLUDED.fire_at, status = 'pending', sent_at = NULL`,
      [bookingId, reminder.kind, fireAt],
    );
  }
}

export async function cancelReminders(db: Db, bookingId: string): Promise<void> {
  await db.query(`UPDATE reminders SET status = 'cancelled' WHERE booking_id = $1 AND status = 'pending'`, [bookingId]);
}

export function inviteFor(
  event: { name: string; host_name: string },
  booking: { id: string; starts_at: Date; ends_at: Date; guest_email: string | null; ics_sequence?: number },
  method: 'REQUEST' | 'CANCEL',
): string {
  return renderInvite({
    bookingId: booking.id,
    sequence: booking.ics_sequence ?? 0,
    method,
    summary: `${event.name} with ${event.host_name}`,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    guestEmail: booking.guest_email ?? 'guest@slotbook.local',
    hostName: event.host_name,
  });
}

type NotifyKind = 'booking.confirmed' | 'booking.rescheduled' | 'booking.cancelled' | 'booking.reminder' | 'booking.waitlist_offered';

export async function recordNotification(
  db: Db,
  hostId: string,
  kind: NotifyKind,
  payload: Record<string, unknown>,
): Promise<void> {
  const note = await one<{ id: string }>(
    db,
    `INSERT INTO notifications (host_id, kind, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [hostId, kind, JSON.stringify(payload)],
  );
  if (kind === 'booking.confirmed') await bump(db, 'bookings_confirmed', 1);
  const hooks = await rows<{ id: string }>(db, `SELECT id FROM webhooks WHERE host_id = $1`, [hostId]);
  for (const hook of hooks) {
    await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, notification_id, attempt, status, next_attempt_at)
       VALUES ($1, $2, 0, 'pending', now())`,
      [hook.id, note!.id],
    );
  }
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

type FetchLike = typeof fetch;

let webhookFetch: FetchLike = globalThis.fetch;

export function setWebhookFetch(next: FetchLike | null): void {
  webhookFetch = next ?? globalThis.fetch;
}

export async function drainWebhooks(limit = 10): Promise<number> {
  const due = await withTx(async (tx) => {
    const claimed = await rows<{
      id: string;
      url: string;
      secret: string;
      attempt: number;
      kind: string;
      payload: unknown;
    }>(
      tx,
      `SELECT d.id, w.url, w.secret, d.attempt, n.kind, n.payload
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       JOIN notifications n ON n.id = d.notification_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= now()
       ORDER BY d.next_attempt_at
       FOR UPDATE OF d SKIP LOCKED
       LIMIT $1`,
      [limit],
    );
    if (claimed.length > 0) {
      await tx.query(
        `UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [claimed.map((row) => row.id)],
      );
    }
    return claimed;
  });

  let delivered = 0;
  for (const row of due) {
    const body = JSON.stringify({ kind: row.kind, payload: row.payload });
    const signature = signWebhook(row.secret, body);
    let httpStatus = 0;
    let error = '';
    try {
      const response = await webhookFetch(row.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-slotbook-signature': signature },
        body,
        signal: AbortSignal.timeout(3000),
      });
      httpStatus = response.status;
      if (response.ok) {
        await getPoolQuery(
          `UPDATE webhook_deliveries SET status = 'delivered', attempt = attempt + 1, http_status = $2, error = NULL WHERE id = $1`,
          [row.id, httpStatus],
        );
        delivered += 1;
        continue;
      }
      error = `HTTP ${httpStatus}`;
    } catch (err) {
      error = err instanceof Error ? err.message : 'delivery failed';
    }
    const attempt = row.attempt + 1;
    if (attempt >= 3) {
      await getPoolQuery(
        `UPDATE webhook_deliveries SET status = 'failed', attempt = $2, http_status = NULLIF($3, 0), error = $4 WHERE id = $1`,
        [row.id, attempt, httpStatus, error],
      );
    } else {
      await getPoolQuery(
        `UPDATE webhook_deliveries
         SET attempt = $2, http_status = NULLIF($3, 0), error = $4, next_attempt_at = now() + ($2 * $2 * interval '1 second')
         WHERE id = $1`,
        [row.id, attempt, httpStatus, error],
      );
    }
  }
  return delivered;
}

async function getPoolQuery(text: string, params: unknown[]): Promise<void> {
  const { getPool } = await import('./db.js');
  await getPool().query(text, params);
}

export async function dispatchReminders(limit = 20): Promise<number> {
  return withTx(async (tx) => {
    const due = await rows<{
      id: string;
      booking_id: string;
      kind: string;
      fire_at: Date;
      host_id: string;
      guest_email: string | null;
      starts_at: Date;
      event_name: string;
    }>(
      tx,
      `SELECT r.id, r.booking_id, r.kind, r.fire_at, e.host_id, b.guest_email, b.starts_at, e.name AS event_name
       FROM reminders r
       JOIN bookings b ON b.id = r.booking_id
       JOIN event_types e ON e.id = b.event_type_id
       WHERE r.status = 'pending' AND r.fire_at <= now() AND b.status = 'confirmed'
       ORDER BY r.fire_at
       FOR UPDATE OF r SKIP LOCKED
       LIMIT $1`,
      [limit],
    );
    let sent = 0;
    let lag = 0;
    for (const reminder of due) {
      await tx.query(`UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = $1`, [reminder.id]);
      lag = Math.max(lag, Date.now() - reminder.fire_at.getTime());
      await recordNotification(tx, reminder.host_id, 'booking.reminder', {
        bookingId: reminder.booking_id,
        reminder: reminder.kind,
        guestEmail: reminder.guest_email,
        eventName: reminder.event_name,
        startsAt: reminder.starts_at.toISOString(),
      });
      sent += 1;
    }
    if (sent > 0) await setGauge(tx, 'notification_lag_ms', lag);
    return sent;
  });
}

export async function promoteWaitlist(tx: pg.PoolClient, event: LimitEvent, startsAt: Date): Promise<void> {
  const endsAt = new Date(startsAt.getTime() + event.duration_min * 60_000);
  if (await teamHostIds(tx, event.id, event.host_id)) {
    const waiting = await rows<{ id: string; guest_name: string; guest_email: string }>(
      tx,
      `SELECT id, guest_name, guest_email FROM waitlist_entries
       WHERE event_type_id = $1 AND starts_at = $2 AND status = 'waiting'
       ORDER BY created_at, id
       FOR UPDATE`,
      [event.id, startsAt],
    );
    for (const entry of waiting) {
      const pick = await classifySlot(tx, event, startsAt, endsAt, null, { lock: true });
      if (pick.kind !== 'team' || !pick.hostId) break;
      if (await guestAlreadyBooked(tx, event.id, entry.guest_email, '00000000-0000-0000-0000-000000000000')) {
        await tx.query(`UPDATE waitlist_entries SET status = 'withdrawn' WHERE id = $1`, [entry.id]);
        continue;
      }
      const hold = await one<{ id: string; expires_at: Date }>(
        tx,
        `INSERT INTO bookings (
           event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min, status, expires_at, assigned_host_id
         ) VALUES ($1, $2, $3, $4, $5, 'held', now() + interval '5 minutes', $6)
         RETURNING id, expires_at`,
        [event.id, startsAt, endsAt, event.buffer_before_min, event.buffer_after_min, pick.hostId],
      );
      const claimToken = newManageToken();
      await tx.query(
        `UPDATE waitlist_entries SET status = 'offered', hold_id = $2, claim_token = $3 WHERE id = $1`,
        [entry.id, hold!.id, claimToken],
      );
      await recordNotification(tx, event.host_id, 'booking.waitlist_offered', {
        eventSlug: event.slug,
        eventName: event.name,
        hostSlug: event.host_slug,
        guestName: entry.guest_name,
        guestEmail: entry.guest_email,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        claimUrl: `/waitlist/${claimToken}`,
        expiresAt: hold!.expires_at.toISOString(),
      });
    }
    return;
  }
  if (await overlapsBusy(tx, event.host_id, startsAt, endsAt)) return;
  const usage = event.daily_cap == null ? null : await dayUsage(tx, event.id, event.timezone, null);
  const usedToday = usage?.get(localDay(event.timezone, startsAt)) ?? 0;

  const taken = await one<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM bookings
     WHERE event_type_id = $1
       AND starts_at = $2
       AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))`,
    [event.id, startsAt],
  );
  let seats = event.capacity - (taken?.n ?? 0);
  if (event.daily_cap != null) seats = Math.min(seats, event.daily_cap - usedToday);
  if (seats < 1) return;

  const waiting = await rows<{ id: string; guest_name: string; guest_email: string }>(
    tx,
    `SELECT id, guest_name, guest_email FROM waitlist_entries
     WHERE event_type_id = $1 AND starts_at = $2 AND status = 'waiting'
     ORDER BY created_at, id
     FOR UPDATE`,
    [event.id, startsAt],
  );

  for (const entry of waiting) {
    if (seats < 1) break;
    if (await guestAlreadyBooked(tx, event.id, entry.guest_email, '00000000-0000-0000-0000-000000000000')) {
      await tx.query(`UPDATE waitlist_entries SET status = 'withdrawn' WHERE id = $1`, [entry.id]);
      continue;
    }
    const hold = await one<{ id: string; expires_at: Date }>(
      tx,
      `INSERT INTO bookings (
         event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'held', now() + interval '5 minutes')
       RETURNING id, expires_at`,
      [event.id, startsAt, endsAt, event.buffer_before_min, event.buffer_after_min],
    );
    const claimToken = newManageToken();
    await tx.query(
      `UPDATE waitlist_entries
       SET status = 'offered', hold_id = $2, claim_token = $3
       WHERE id = $1`,
      [entry.id, hold!.id, claimToken],
    );
    await recordNotification(tx, event.host_id, 'booking.waitlist_offered', {
      eventSlug: event.slug,
      eventName: event.name,
      hostSlug: event.host_slug,
      guestName: entry.guest_name,
      guestEmail: entry.guest_email,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      claimUrl: `/waitlist/${claimToken}`,
      expiresAt: hold!.expires_at.toISOString(),
    });
    seats -= 1;
  }
}

export async function expireEventHolds(tx: pg.PoolClient, event: LimitEvent): Promise<number> {
  const flipped = await tx.query<{ id: string; starts_at: Date }>(
    `UPDATE bookings SET status = 'expired', updated_at = now()
     WHERE event_type_id = $1 AND status = 'held' AND expires_at <= now()
     RETURNING id, starts_at`,
    [event.id],
  );
  if (flipped.rowCount) await bump(tx, 'hold_expiries', flipped.rowCount);
  const ids = flipped.rows.map((item) => item.id);
  if (ids.length > 0) {
    await tx.query(
      `UPDATE waitlist_entries SET status = 'expired'
       WHERE hold_id = ANY($1::uuid[]) AND status = 'offered'`,
      [ids],
    );
  }
  const starts = new Map<number, Date>();
  for (const item of flipped.rows) starts.set(item.starts_at.getTime(), item.starts_at);
  for (const start of starts.values()) await promoteWaitlist(tx, event, start);
  return flipped.rowCount ?? 0;
}

export async function sweepExpiredHolds(): Promise<number> {
  const { getPool } = await import('./db.js');
  const due = await rows<{ event_type_id: string }>(
    getPool(),
    `SELECT DISTINCT event_type_id FROM bookings WHERE status = 'held' AND expires_at <= now()`,
  );
  let expired = 0;
  for (const row of due) {
    expired += await withTx(async (tx) => {
      const event = await one<LimitEvent & { host_slug: string; host_name: string }>(
        tx,
        `SELECT e.id, e.host_id, e.timezone, e.daily_cap, e.duration_min, e.capacity,
                e.buffer_before_min, e.buffer_after_min, e.name, e.slug,
                h.slug AS host_slug, h.name AS host_name
         FROM event_types e JOIN hosts h ON h.id = e.host_id
         WHERE e.id = $1
         FOR UPDATE OF e`,
        [row.event_type_id],
      );
      if (!event) return 0;
      return expireEventHolds(tx, event);
    });
  }
  return expired;
}

export function newClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function replaceBusyBlocks(
  db: Db,
  hostId: string,
  source: string,
  events: Array<{ startsAt: Date; endsAt: Date; summary: string }>,
): Promise<number> {
  await db.query(`DELETE FROM busy_blocks WHERE host_id = $1 AND source = $2`, [hostId, source]);
  for (const event of events) {
    await db.query(
      `INSERT INTO busy_blocks (host_id, starts_at, ends_at, summary, source) VALUES ($1, $2, $3, $4, $5)`,
      [hostId, event.startsAt, event.endsAt, event.summary.slice(0, 200), source],
    );
  }
  return events.length;
}

let calendarFetch: FetchLike = globalThis.fetch;

export function setCalendarFetch(next: FetchLike | null): void {
  calendarFetch = next ?? globalThis.fetch;
}

export async function readCalendarFeed(url: string, zone: string): Promise<ReturnType<typeof parseIcs>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'invalid_url', 'Calendar URL must be http or https');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_url', 'Calendar URL must be http or https');
  }
  if (parsed.hostname === '169.254.169.254' || parsed.hostname === 'metadata.google.internal') {
    throw new ApiError(400, 'invalid_url', 'That calendar URL is not allowed');
  }
  let response: Response;
  try {
    response = await calendarFetch(parsed.toString(), { signal: AbortSignal.timeout(4000) });
  } catch {
    throw new ApiError(400, 'feed_failed', 'Could not read that calendar');
  }
  if (!response.ok) throw new ApiError(400, 'feed_failed', 'Could not read that calendar');
  const text = await response.text();
  if (text.length > 500_000) throw new ApiError(400, 'feed_failed', 'Calendar file is too large');
  return parseIcs(text, zone);
}
