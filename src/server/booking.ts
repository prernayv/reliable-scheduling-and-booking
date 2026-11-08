import { createHash } from 'node:crypto';
import type pg from 'pg';
import { newManageToken } from './auth.js';
import { dbNow, getPool, one, rows, withTx } from './db.js';
import { ApiError, isPgError } from './errors.js';
import {
  assertDailyCap,
  blocksSlot,
  dayUsage,
  expireEventHolds,
  guestAlreadyBooked,
  inviteFor,
  loadBusyBlocks,
  localDay,
  overlapsBusy,
  promoteWaitlist,
  recordNotification,
  scheduleReminders,
  cancelReminders,
  bump,
} from './extensions.js';
import { classifySlot, listTeamSlots, teamHostIds } from './team.js';
import {
  eachZonedDate,
  generateSlotStarts,
  seatsRemaining,
  slotIsOffered,
  weekdayOf,
  windowsForDate,
  type BusyInterval,
  type Window,
} from './slots.js';

const HOLD_MINUTES = 5;

type EventRow = {
  id: string;
  host_id: string;
  name: string;
  slug: string;
  duration_min: number;
  capacity: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  daily_cap: number | null;
  guest_limit: boolean;
  host_slug: string;
  host_name: string;
  timezone: string;
};

type BookingRow = {
  id: string;
  event_type_id: string;
  starts_at: Date;
  ends_at: Date;
  buffer_before_min: number;
  buffer_after_min: number;
  status: string;
  expires_at: Date | null;
  guest_name: string | null;
  guest_email: string | null;
  manage_token: string | null;
  cancel_reason: string | null;
  ics_sequence?: number;
  assigned_host_id?: string | null;
  assigned_host_name?: string | null;
};

export type SlotDto = { startsAt: string; endsAt: string; remaining: number };

export type HoldDto = {
  id: string;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
  now: string;
};

export type BookingDto = {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  guestName: string | null;
  guestEmail: string | null;
  manageToken: string | null;
  manageUrl: string | null;
  cancelReason: string | null;
  eventName: string;
  eventSlug: string;
  hostSlug: string;
  hostName: string;
  hostTimezone: string;
  durationMin: number;
  calendarUrl: string | null;
  assignedHostName: string | null;
};

function iso(date: Date): string {
  return date.toISOString();
}

function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function lockHost(tx: pg.PoolClient, hostId: string): Promise<void> {
  const locked = await one(tx, 'SELECT id FROM hosts WHERE id = $1 FOR UPDATE', [hostId]);
  if (!locked) throw new ApiError(404, 'host_not_found', 'Host not found');
}

async function lockEvent(tx: pg.PoolClient, eventId: string): Promise<EventRow> {
  const event = await one<EventRow>(
    tx,
    `SELECT e.id, e.host_id, e.name, e.slug, e.duration_min, e.capacity,
            e.buffer_before_min, e.buffer_after_min, e.min_notice_min, e.horizon_days,
            e.daily_cap, e.guest_limit,
            h.slug AS host_slug, h.name AS host_name, h.timezone
     FROM event_types e
     JOIN hosts h ON h.id = e.host_id
     WHERE e.id = $1
     FOR UPDATE OF e`,
    [eventId],
  );
  if (!event) throw new ApiError(404, 'event_not_found', 'Event not found');
  return event;
}

export async function loadEvent(db: pg.Pool | pg.PoolClient, host: string, slug: string): Promise<EventRow> {
  const event = await one<EventRow>(
    db,
    `SELECT e.id, e.host_id, e.name, e.slug, e.duration_min, e.capacity,
            e.buffer_before_min, e.buffer_after_min, e.min_notice_min, e.horizon_days,
            e.daily_cap, e.guest_limit,
            h.slug AS host_slug, h.name AS host_name, h.timezone
     FROM event_types e
     JOIN hosts h ON h.id = e.host_id
     WHERE h.slug = $1 AND e.slug = $2`,
    [host, slug],
  );
  if (!event) throw new ApiError(404, 'event_not_found', 'Event not found');
  return event;
}

type RuleRow = { day_of_week: number; start_min: number; end_min: number };
type OverrideRow = { override_date: string; unavailable: boolean; start_min: number | null; end_min: number | null };

async function loadSchedule(
  db: pg.Pool | pg.PoolClient,
  hostId: string,
  dates: string[],
): Promise<{
  rules: Array<{ dayOfWeek: number; startMin: number; endMin: number }>;
  overrides: Map<string, { unavailable: boolean; windows: Window[] }>;
}> {
  const rules = await rows<RuleRow>(
    db,
    `SELECT day_of_week, start_min, end_min FROM availability_rules WHERE host_id = $1`,
    [hostId],
  );
  const from = dates[0];
  const to = dates[dates.length - 1];
  const overrideRows = await rows<OverrideRow>(
    db,
    `SELECT o.override_date::text AS override_date, o.unavailable, w.start_min, w.end_min
     FROM date_overrides o
     LEFT JOIN override_windows w ON w.override_id = o.id
     WHERE o.host_id = $1 AND o.override_date BETWEEN $2::date AND $3::date
     ORDER BY w.start_min`,
    [hostId, from, to],
  );
  const overrides = new Map<string, { unavailable: boolean; windows: Window[] }>();
  for (const row of overrideRows) {
    const current = overrides.get(row.override_date) ?? { unavailable: row.unavailable, windows: [] };
    if (row.start_min !== null && row.end_min !== null) {
      current.windows.push({ startMin: row.start_min, endMin: row.end_min });
    }
    overrides.set(row.override_date, current);
  }
  return {
    rules: rules.map((rule) => ({
      dayOfWeek: rule.day_of_week,
      startMin: rule.start_min,
      endMin: rule.end_min,
    })),
    overrides,
  };
}

async function loadBusy(
  db: pg.Pool | pg.PoolClient,
  eventId: string,
  rangeStart: Date,
  rangeEnd: Date,
  excludeId: string | null,
): Promise<BusyInterval[]> {
  const busy = await rows<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    buffer_before_min: number;
    buffer_after_min: number;
  }>(
    db,
    `SELECT id, starts_at, ends_at, buffer_before_min, buffer_after_min
     FROM bookings
     WHERE event_type_id = $1
       AND ($2::uuid IS NULL OR id <> $2::uuid)
       AND (
         status = 'confirmed'
         OR (status = 'held' AND expires_at > now())
       )
       AND starts_at < $4::timestamptz
       AND ends_at > $3::timestamptz`,
    [eventId, excludeId, new Date(rangeStart.getTime() - 60 * 60_000), new Date(rangeEnd.getTime() + 60 * 60_000)],
  );
  return busy.map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
  }));
}

export async function listSlots(
  db: pg.Pool | pg.PoolClient,
  event: EventRow,
  opts: { from: Date; to: Date; excludeBookingId?: string | null; includeFull?: boolean },
): Promise<{ now: string; slots: SlotDto[]; full: SlotDto[] }> {
  if (opts.from >= opts.to) throw new ApiError(400, 'invalid_range', '`from` must be before `to`');
  const span = opts.to.getTime() - opts.from.getTime();
  if (span > 62 * 24 * 60 * 60_000) {
    throw new ApiError(400, 'invalid_range', 'Range cannot exceed 62 days');
  }
  const teamIds = await teamHostIds(db, event.id, event.host_id);
  if (teamIds) return listTeamSlots(db, event, teamIds, opts);
  const now = await dbNow(db);
  const dates = eachZonedDate(event.timezone, opts.from, opts.to);
  const schedule = await loadSchedule(db, event.host_id, dates);
  const durationMs = event.duration_min * 60_000;
  const candidates: Date[] = [];
  for (const date of dates) {
    const windows = windowsForDate(weekdayOf(event.timezone, date), schedule.rules, schedule.overrides.get(date));
    for (const start of generateSlotStarts({
      zone: event.timezone,
      date,
      durationMin: event.duration_min,
      windows,
    })) {
      if (
        slotIsOffered(start, {
          from: opts.from,
          to: opts.to,
          now,
          minNoticeMin: event.min_notice_min,
          horizonDays: event.horizon_days,
        })
      ) {
        candidates.push(start);
      }
    }
  }
  const busy = await loadBusy(
    db,
    event.id,
    opts.from,
    opts.to,
    opts.excludeBookingId ?? null,
  );
  const blocks = await loadBusyBlocks(db, event.host_id, opts.from, opts.to);
  const usage =
    event.daily_cap == null ? null : await dayUsage(db, event.id, event.timezone, opts.excludeBookingId ?? null);
  const slots: SlotDto[] = [];
  const full: SlotDto[] = [];
  for (const start of candidates) {
    const end = new Date(start.getTime() + durationMs);
    if (blocksSlot(blocks, start, end)) continue;
    const capLeft =
      event.daily_cap == null
        ? Number.POSITIVE_INFINITY
        : event.daily_cap - (usage?.get(localDay(event.timezone, start)) ?? 0);
    if (capLeft < 1) continue;
    const remaining = Math.min(
      capLeft,
      seatsRemaining(start, end, event.buffer_before_min, event.buffer_after_min, event.capacity, busy),
    );
    const dto = { startsAt: iso(start), endsAt: iso(end), remaining: Math.max(remaining, 0) };
    if (remaining > 0) slots.push(dto);
    else if (opts.includeFull) full.push(dto);
  }
  return { now: iso(now), slots, full };
}

function assertExactSlot(event: EventRow, schedule: Awaited<ReturnType<typeof loadSchedule>>, start: Date, now: Date): void {
  const dates = eachZonedDate(event.timezone, start, new Date(start.getTime() + 1));
  const offered = new Set<number>();
  for (const date of dates) {
    const windows = windowsForDate(weekdayOf(event.timezone, date), schedule.rules, schedule.overrides.get(date));
    for (const slot of generateSlotStarts({
      zone: event.timezone,
      date,
      durationMin: event.duration_min,
      windows,
    })) {
      if (
        slotIsOffered(slot, {
          from: new Date(start.getTime() - 1),
          to: new Date(start.getTime() + 1),
          now,
          minNoticeMin: event.min_notice_min,
          horizonDays: event.horizon_days,
        })
      ) {
        offered.add(slot.getTime());
      }
    }
  }
  if (!offered.has(start.getTime())) {
    throw new ApiError(409, 'slot_unavailable', 'That time is not available');
  }
}

function withInvite(
  event: EventRow,
  booking: BookingRow,
  method: 'REQUEST' | 'CANCEL',
  extra: Record<string, unknown> = {},
) {
  return bookingPayload(event, booking, { ...extra, ics: inviteFor(event, booking, method) });
}

function bookingPayload(event: EventRow, booking: BookingRow, extra: Record<string, unknown> = {}) {
  return {
    bookingId: booking.id,
    eventSlug: event.slug,
    eventName: event.name,
    hostSlug: event.host_slug,
    guestName: booking.guest_name,
    guestEmail: booking.guest_email,
    startsAt: iso(booking.starts_at),
    endsAt: iso(booking.ends_at),
    manageUrl: booking.manage_token ? `/manage/${booking.manage_token}` : null,
    ...extra,
  };
}

export function toBookingDto(event: EventRow, booking: BookingRow): BookingDto {
  return {
    id: booking.id,
    status: booking.status,
    startsAt: iso(booking.starts_at),
    endsAt: iso(booking.ends_at),
    guestName: booking.guest_name,
    guestEmail: booking.guest_email,
    manageToken: booking.manage_token,
    manageUrl: booking.manage_token ? `/manage/${booking.manage_token}` : null,
    cancelReason: booking.cancel_reason,
    eventName: event.name,
    eventSlug: event.slug,
    hostSlug: event.host_slug,
    hostName: event.host_name,
    hostTimezone: event.timezone,
    durationMin: event.duration_min,
    calendarUrl: booking.manage_token ? `/api/bookings/${booking.manage_token}/invite.ics` : null,
    assignedHostName: booking.assigned_host_name ?? null,
  };
}

type StoredResponse = { status: number; body: unknown };

export async function createHold(input: {
  host: string;
  eventSlug: string;
  startsAt: Date;
  idempotencyKey: string;
  clientIp: string;
}): Promise<StoredResponse> {
  const requestHash = hashRequest({
    host: input.host,
    eventSlug: input.eventSlug,
    startsAt: input.startsAt.toISOString(),
  });

  return withTx(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [input.idempotencyKey]);
    const existing = await one<{ request_hash: string; status_code: number; response_body: unknown }>(
      tx,
      `SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1`,
      [input.idempotencyKey],
    );
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(409, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request');
      }
      return { status: existing.status_code, body: existing.response_body };
    }

    const lookedUp = await loadEvent(tx, input.host, input.eventSlug);
    await lockHost(tx, lookedUp.host_id);
    const event = await lockEvent(tx, lookedUp.id);
    await expireEventHolds(tx, event);
    const holdCap = Number(process.env.HOLD_CAP || 8);
    if (Number.isFinite(holdCap) && holdCap > 0) {
      const active = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM bookings
         WHERE client_ip = $1 AND status = 'held' AND expires_at > now()`,
        [input.clientIp],
      );
      if ((active?.n ?? 0) >= holdCap) {
        throw new ApiError(429, 'too_many_holds', 'Too many active holds from this network. Finish one or wait for it to expire.');
      }
    }
    const now = await dbNow(tx);
    const endsAt = new Date(input.startsAt.getTime() + event.duration_min * 60_000);
    const pick = await classifySlot(tx, event, input.startsAt, endsAt, null, { lock: true });
    let assignedHostId: string | null = null;
    if (pick.kind === 'team') {
      await assertDailyCap(tx, event, input.startsAt, null);
      if (pick.absent || !pick.hostId) throw new ApiError(409, 'slot_unavailable', 'That time was just taken');
      assignedHostId = pick.hostId;
    } else {
      const dates = eachZonedDate(event.timezone, input.startsAt, new Date(input.startsAt.getTime() + 1));
      const schedule = await loadSchedule(tx, event.host_id, dates);
      assertExactSlot(event, schedule, input.startsAt, now);
      const busy = await loadBusy(tx, event.id, input.startsAt, endsAt, null);
      const remaining = seatsRemaining(
        input.startsAt,
        endsAt,
        event.buffer_before_min,
        event.buffer_after_min,
        event.capacity,
        busy,
      );
      if (remaining < 1) throw new ApiError(409, 'slot_unavailable', 'That time was just taken');
      if (await overlapsBusy(tx, event.host_id, input.startsAt, endsAt)) {
        throw new ApiError(409, 'slot_unavailable', 'That time is not available');
      }
      await assertDailyCap(tx, event, input.startsAt, null);
    }

    const inserted = await one<BookingRow>(
      tx,
      `INSERT INTO bookings (
         event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min, status, expires_at,
         assigned_host_id, client_ip
       ) VALUES ($1, $2, $3, $4, $5, 'held', now() + interval '5 minutes', $6, $7)
       RETURNING id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
                 status, expires_at, guest_name, guest_email, manage_token, cancel_reason, assigned_host_id`,
      [event.id, input.startsAt, endsAt, event.buffer_before_min, event.buffer_after_min, assignedHostId, input.clientIp],
    );
    if (!inserted?.expires_at) throw new Error('hold insert failed');
    const body: HoldDto = {
      id: inserted.id,
      startsAt: iso(inserted.starts_at),
      endsAt: iso(inserted.ends_at),
      expiresAt: iso(inserted.expires_at),
      now: iso(now),
    };
    await tx.query(
      `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
       VALUES ($1, $2, 201, $3::jsonb)`,
      [input.idempotencyKey, requestHash, JSON.stringify(body)],
    );
    return { status: 201, body };
  });
}

async function reloadBooking(tx: pg.PoolClient, id: string): Promise<BookingRow> {
  const booking = await one<BookingRow>(
    tx,
    `SELECT id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
            status, expires_at, guest_name, guest_email, manage_token, cancel_reason, assigned_host_id
     FROM bookings WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!booking) throw new ApiError(404, 'hold_not_found', 'Hold not found');
  return booking;
}

export async function confirmHold(id: string, guestName: string, guestEmail: string): Promise<BookingDto> {
  const outcome = await withTx(async (tx) => {
    const peek = await one<{ event_type_id: string; host_id: string }>(
      tx,
      `SELECT b.event_type_id, e.host_id
       FROM bookings b JOIN event_types e ON e.id = b.event_type_id
       WHERE b.id = $1`,
      [id],
    );
    if (!peek) throw new ApiError(404, 'hold_not_found', 'Hold not found');
    await lockHost(tx, peek.host_id);
    const event = await lockEvent(tx, peek.event_type_id);
    await expireEventHolds(tx, event);
    const booking = await reloadBooking(tx, id);

    if (booking.status === 'confirmed') {
      if (booking.guest_name === guestName && booking.guest_email === guestEmail) {
        return { kind: 'ok' as const, booking: toBookingDto(event, booking) };
      }
      throw new ApiError(409, 'already_confirmed', 'This hold was confirmed with different guest details');
    }
    if (booking.status !== 'held') {
      return { kind: 'expired' as const };
    }
    if (event.guest_limit && (await guestAlreadyBooked(tx, event.id, guestEmail, booking.id))) {
      await tx.query(`UPDATE bookings SET status = 'expired', updated_at = now() WHERE id = $1`, [booking.id]);
      await bump(tx, 'hold_expiries', 1);
      await promoteWaitlist(tx, event, booking.starts_at);
      return { kind: 'guest_limit' as const };
    }

    const token = newManageToken();
    const updated = await one<BookingRow>(
      tx,
      `UPDATE bookings
       SET status = 'confirmed', expires_at = NULL, guest_name = $2, guest_email = $3,
           manage_token = $4, updated_at = now()
       WHERE id = $1
       RETURNING id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
                 status, expires_at, guest_name, guest_email, manage_token, cancel_reason, ics_sequence`,
      [id, guestName, guestEmail, token],
    );
    if (!updated) throw new Error('confirm failed');
    await scheduleReminders(tx, updated.id, updated.starts_at);
    await recordNotification(tx, event.host_id, 'booking.confirmed', withInvite(event, updated, 'REQUEST'));
    return { kind: 'ok' as const, booking: toBookingDto(event, updated) };
  });
  if (outcome.kind === 'expired') {
    throw new ApiError(409, 'hold_expired', 'This hold is no longer active');
  }
  if (outcome.kind === 'guest_limit') {
    throw new ApiError(409, 'guest_limit', 'You already have a booking for this event');
  }
  return outcome.booking;
}

async function bookingByToken(db: pg.Pool | pg.PoolClient, token: string): Promise<{ event: EventRow; booking: BookingRow }> {
  const booking = await one<BookingRow & { host_slug: string }>(
    db,
    `SELECT b.id, b.event_type_id, b.starts_at, b.ends_at, b.buffer_before_min, b.buffer_after_min,
            b.status, b.expires_at, b.guest_name, b.guest_email, b.manage_token, b.cancel_reason
     FROM bookings b
     WHERE b.manage_token = $1`,
    [token],
  );
  if (!booking) throw new ApiError(404, 'booking_not_found', 'Booking not found');
  const event = await one<EventRow>(
    db,
    `SELECT e.id, e.host_id, e.name, e.slug, e.duration_min, e.capacity,
            e.buffer_before_min, e.buffer_after_min, e.min_notice_min, e.horizon_days,
            e.daily_cap, e.guest_limit,
            h.slug AS host_slug, h.name AS host_name, h.timezone
     FROM event_types e JOIN hosts h ON h.id = e.host_id
     WHERE e.id = $1`,
    [booking.event_type_id],
  );
  if (!event) throw new ApiError(404, 'event_not_found', 'Event not found');
  return { event, booking };
}

export async function getBooking(token: string): Promise<BookingDto> {
  const { event, booking } = await bookingByToken(getPool(), token);
  return toBookingDto(event, booking);
}

export async function rescheduleBooking(token: string, startsAt: Date): Promise<BookingDto> {
  return withTx(async (tx) => {
    const found = await bookingByToken(tx, token);
    await lockHost(tx, found.event.host_id);
    const event = await lockEvent(tx, found.event.id);
    await expireEventHolds(tx, event);
    const booking = await reloadBooking(tx, found.booking.id);
    if (booking.status !== 'confirmed' || booking.manage_token !== token) {
      throw new ApiError(409, 'not_confirmed', 'Only a confirmed booking can be rescheduled');
    }
    if (booking.starts_at.getTime() === startsAt.getTime()) return toBookingDto(event, booking);

    const now = await dbNow(tx);
    const endsAt = new Date(startsAt.getTime() + event.duration_min * 60_000);
    const pick = await classifySlot(tx, event, startsAt, endsAt, booking.id, {
      lock: true,
      prefer: booking.assigned_host_id ?? null,
    });
    let assignedHostId = booking.assigned_host_id ?? null;
    if (pick.kind === 'team') {
      await assertDailyCap(tx, event, startsAt, booking.id);
      if (pick.absent || !pick.hostId) throw new ApiError(409, 'slot_unavailable', 'That time was just taken');
      assignedHostId = pick.hostId;
    } else {
      const dates = eachZonedDate(event.timezone, startsAt, new Date(startsAt.getTime() + 1));
      const schedule = await loadSchedule(tx, event.host_id, dates);
      assertExactSlot(event, schedule, startsAt, now);
      const busy = await loadBusy(tx, event.id, startsAt, endsAt, booking.id);
      const remaining = seatsRemaining(
        startsAt,
        endsAt,
        event.buffer_before_min,
        event.buffer_after_min,
        event.capacity,
        busy,
      );
      if (remaining < 1) throw new ApiError(409, 'slot_unavailable', 'That time was just taken');
      if (await overlapsBusy(tx, event.host_id, startsAt, endsAt)) {
        throw new ApiError(409, 'slot_unavailable', 'That time is not available');
      }
      await assertDailyCap(tx, event, startsAt, booking.id);
    }

    const previousStartsAt = iso(booking.starts_at);
    const previousStart = booking.starts_at;
    const updated = await one<BookingRow>(
      tx,
      `UPDATE bookings
       SET starts_at = $2, ends_at = $3, buffer_before_min = $4, buffer_after_min = $5,
           assigned_host_id = $6, ics_sequence = ics_sequence + 1, updated_at = now()
       WHERE id = $1
       RETURNING id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
                 status, expires_at, guest_name, guest_email, manage_token, cancel_reason, ics_sequence, assigned_host_id`,
      [booking.id, startsAt, endsAt, event.buffer_before_min, event.buffer_after_min, assignedHostId],
    );
    if (!updated) throw new Error('reschedule failed');
    await scheduleReminders(tx, updated.id, updated.starts_at);
    await recordNotification(
      tx,
      event.host_id,
      'booking.rescheduled',
      withInvite(event, updated, 'REQUEST', { previousStartsAt }),
    );
    await promoteWaitlist(tx, event, previousStart);
    return toBookingDto(event, updated);
  });
}

export async function cancelBooking(opts: {
  token?: string;
  bookingId?: string;
  hostId?: string;
  reason: string;
}): Promise<BookingDto> {
  return withTx(async (tx) => {
    let bookingId = opts.bookingId ?? null;
    if (opts.token) {
      const found = await bookingByToken(tx, opts.token);
      bookingId = found.booking.id;
    }
    if (!bookingId) throw new ApiError(404, 'booking_not_found', 'Booking not found');
    const peek = await one<{ host_id: string; event_type_id: string }>(
      tx,
      `SELECT e.host_id, b.event_type_id
       FROM bookings b JOIN event_types e ON e.id = b.event_type_id
       WHERE b.id = $1`,
      [bookingId],
    );
    if (!peek) throw new ApiError(404, 'booking_not_found', 'Booking not found');
    if (opts.hostId && peek.host_id !== opts.hostId) {
      throw new ApiError(404, 'booking_not_found', 'Booking not found');
    }
    await lockHost(tx, peek.host_id);
    const event = await lockEvent(tx, peek.event_type_id);
    const booking = await reloadBooking(tx, bookingId);
    if (booking.status === 'cancelled') return toBookingDto(event, booking);
    if (booking.status !== 'confirmed') {
      throw new ApiError(409, 'not_confirmed', 'Only a confirmed booking can be cancelled');
    }
    const updated = await one<BookingRow>(
      tx,
      `UPDATE bookings
       SET status = 'cancelled', cancel_reason = $2, ics_sequence = ics_sequence + 1, updated_at = now()
       WHERE id = $1
       RETURNING id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
                 status, expires_at, guest_name, guest_email, manage_token, cancel_reason, ics_sequence`,
      [booking.id, opts.reason],
    );
    if (!updated) throw new Error('cancel failed');
    await cancelReminders(tx, updated.id);
    await recordNotification(
      tx,
      event.host_id,
      'booking.cancelled',
      withInvite(event, updated, 'CANCEL', { reason: opts.reason }),
    );
    await promoteWaitlist(tx, event, updated.starts_at);
    return toBookingDto(event, updated);
  });
}

export async function joinWaitlist(input: {
  host: string;
  eventSlug: string;
  startsAt: Date;
  guestName: string;
  guestEmail: string;
}): Promise<{ id: string; status: string }> {
  return withTx(async (tx) => {
    const lookedUp = await loadEvent(tx, input.host, input.eventSlug);
    await lockHost(tx, lookedUp.host_id);
    const event = await lockEvent(tx, lookedUp.id);
    await expireEventHolds(tx, event);
    const endsAt = new Date(input.startsAt.getTime() + event.duration_min * 60_000);
    const pick = await classifySlot(tx, event, input.startsAt, endsAt, null, { lock: true });
    if (pick.kind === 'team') {
      if (pick.absent) throw new ApiError(409, 'slot_unavailable', 'That time is not available');
      if (pick.hostId) throw new ApiError(409, 'slot_open', 'That time still has a free seat');
    } else {
      const now = await dbNow(tx);
      const dates = eachZonedDate(event.timezone, input.startsAt, new Date(input.startsAt.getTime() + 1));
      const schedule = await loadSchedule(tx, event.host_id, dates);
      assertExactSlot(event, schedule, input.startsAt, now);
      if (await overlapsBusy(tx, event.host_id, input.startsAt, endsAt)) {
        throw new ApiError(409, 'slot_unavailable', 'That time is not available');
      }
      const busy = await loadBusy(tx, event.id, input.startsAt, endsAt, null);
      const remaining = seatsRemaining(
        input.startsAt,
        endsAt,
        event.buffer_before_min,
        event.buffer_after_min,
        event.capacity,
        busy,
      );
      if (remaining > 0) throw new ApiError(409, 'slot_open', 'That time still has a free seat');
    }
    if (event.guest_limit && (await guestAlreadyBooked(tx, event.id, input.guestEmail, '00000000-0000-0000-0000-000000000000'))) {
      throw new ApiError(409, 'guest_limit', 'You already have a booking for this event');
    }
    try {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO waitlist_entries (event_type_id, starts_at, ends_at, guest_name, guest_email, status)
         VALUES ($1, $2, $3, $4, $5, 'waiting')
         RETURNING id`,
        [event.id, input.startsAt, endsAt, input.guestName, input.guestEmail],
      );
      return { id: row!.id, status: 'waiting' };
    } catch (err) {
      if (isPgError(err) && err.code === '23505') {
        throw new ApiError(409, 'already_waiting', 'You are already waiting for this time');
      }
      throw err;
    }
  });
}

export async function claimWaitlist(token: string): Promise<BookingDto> {
  const peek = await one<{ id: string; host_id: string; event_type_id: string }>(
    getPool(),
    `SELECT w.id, e.host_id, w.event_type_id
     FROM waitlist_entries w
     JOIN event_types e ON e.id = w.event_type_id
     WHERE w.claim_token = $1`,
    [token],
  );
  if (!peek) throw new ApiError(404, 'waitlist_not_found', 'Waitlist offer not found');
  const outcome = await withTx(async (tx) => {
    await lockHost(tx, peek.host_id);
    const event = await lockEvent(tx, peek.event_type_id);
    await expireEventHolds(tx, event);
    const entry = await one<{
      id: string;
      status: string;
      hold_id: string | null;
      guest_name: string;
      guest_email: string;
    }>(
      tx,
      `SELECT id, status, hold_id, guest_name, guest_email FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
      [peek.id],
    );
    if (!entry || entry.status !== 'offered' || !entry.hold_id) {
      throw new ApiError(409, 'offer_expired', 'This waitlist offer is no longer active');
    }
    const booking = await reloadBooking(tx, entry.hold_id);
    if (booking.status !== 'held') {
      throw new ApiError(409, 'offer_expired', 'This waitlist offer is no longer active');
    }
    if (event.guest_limit && (await guestAlreadyBooked(tx, event.id, entry.guest_email, booking.id))) {
      await tx.query(`UPDATE bookings SET status = 'expired', updated_at = now() WHERE id = $1`, [booking.id]);
      await tx.query(`UPDATE waitlist_entries SET status = 'expired' WHERE id = $1`, [entry.id]);
      await promoteWaitlist(tx, event, booking.starts_at);
      throw new ApiError(409, 'guest_limit', 'You already have a booking for this event');
    }
    const manage = newManageToken();
    const updated = await one<BookingRow>(
      tx,
      `UPDATE bookings
       SET status = 'confirmed', expires_at = NULL, guest_name = $2, guest_email = $3,
           manage_token = $4, updated_at = now()
       WHERE id = $1
       RETURNING id, event_type_id, starts_at, ends_at, buffer_before_min, buffer_after_min,
                 status, expires_at, guest_name, guest_email, manage_token, cancel_reason, ics_sequence`,
      [booking.id, entry.guest_name, entry.guest_email, manage],
    );
    if (!updated) throw new Error('claim failed');
    await tx.query(`UPDATE waitlist_entries SET status = 'booked' WHERE id = $1`, [entry.id]);
    await scheduleReminders(tx, updated.id, updated.starts_at);
    await recordNotification(tx, event.host_id, 'booking.confirmed', withInvite(event, updated, 'REQUEST'));
    return toBookingDto(event, updated);
  });
  return outcome;
}

export async function getWaitlistOffer(token: string): Promise<{
  status: string;
  eventName: string;
  hostName: string;
  guestName: string;
  startsAt: string;
  endsAt: string;
  expiresAt: string | null;
}> {
  const row = await one<{
    status: string;
    event_name: string;
    host_name: string;
    guest_name: string;
    starts_at: Date;
    ends_at: Date;
    expires_at: Date | null;
  }>(
    getPool(),
    `SELECT w.status, e.name AS event_name, h.name AS host_name, w.guest_name,
            w.starts_at, w.ends_at, b.expires_at
     FROM waitlist_entries w
     JOIN event_types e ON e.id = w.event_type_id
     JOIN hosts h ON h.id = e.host_id
     LEFT JOIN bookings b ON b.id = w.hold_id
     WHERE w.claim_token = $1`,
    [token],
  );
  if (!row) throw new ApiError(404, 'waitlist_not_found', 'Waitlist offer not found');
  return {
    status: row.status,
    eventName: row.event_name,
    hostName: row.host_name,
    guestName: row.guest_name,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

export async function inviteForToken(token: string): Promise<string> {
  const { event, booking } = await bookingByToken(getPool(), token);
  const method = booking.status === 'cancelled' ? 'CANCEL' : 'REQUEST';
  const row = await one<{ ics_sequence: number }>(
    getPool(),
    `SELECT ics_sequence FROM bookings WHERE id = $1`,
    [booking.id],
  );
  return inviteFor(event, { ...booking, ics_sequence: row?.ics_sequence ?? 0 }, method);
}

export { HOLD_MINUTES };
