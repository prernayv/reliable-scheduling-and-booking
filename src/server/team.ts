import type pg from 'pg';
import { DateTime } from 'luxon';
import { dbNow, one, rows } from './db.js';
import {
  blockedRange,
  eachZonedDate,
  generateSlotStarts,
  rangesOverlap,
  seatsRemaining,
  slotIsOffered,
  weekdayOf,
  windowsForDate,
  type BusyInterval,
  type Window,
} from './slots.js';

type Db = pg.Pool | pg.PoolClient;

export type Schedulable = {
  id: string;
  host_id: string;
  timezone: string;
  duration_min: number;
  capacity: number;
  buffer_before_min: number;
  buffer_after_min: number;
  min_notice_min: number;
  horizon_days: number;
  daily_cap: number | null;
};

type Member = {
  id: string;
  timezone: string;
  rules: Array<{ dayOfWeek: number; startMin: number; endMin: number }>;
  overrides: Map<string, { unavailable: boolean; windows: Window[] }>;
  offered: Set<number>;
};

type Occupancy = BusyInterval & { eventTypeId: string; hostId: string };

export type SlotPick =
  | { kind: 'solo' }
  | { kind: 'team'; hostId: string | null; absent: boolean };

function localDay(zone: string, instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(zone).toISODate() ?? '';
}

export async function teamHostIds(db: Db, eventId: string, ownerId: string): Promise<string[] | null> {
  const extra = await rows<{ host_id: string }>(
    db,
    `SELECT host_id FROM event_members WHERE event_type_id = $1 AND host_id <> $2 ORDER BY host_id`,
    [eventId, ownerId],
  );
  if (extra.length === 0) return null;
  return [ownerId, ...extra.map((row) => row.host_id)];
}

async function loadMembers(
  db: Db,
  ids: string[],
  from: Date,
  to: Date,
  event: Schedulable,
  now: Date,
): Promise<Member[]> {
  const hosts = await rows<{ id: string; timezone: string }>(
    db,
    `SELECT id, timezone FROM hosts WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const rules = await rows<{ host_id: string; day_of_week: number; start_min: number; end_min: number }>(
    db,
    `SELECT host_id, day_of_week, start_min, end_min FROM availability_rules WHERE host_id = ANY($1::uuid[])`,
    [ids],
  );
  let spanStart = '9999-12-31';
  let spanEnd = '0001-01-01';
  const datesByHost = new Map<string, string[]>();
  for (const host of hosts) {
    const dates = eachZonedDate(host.timezone, from, to);
    datesByHost.set(host.id, dates);
    if (dates[0] && dates[0] < spanStart) spanStart = dates[0];
    const last = dates[dates.length - 1];
    if (last && last > spanEnd) spanEnd = last;
  }
  const overrideRows = await rows<{
    host_id: string;
    override_date: string;
    unavailable: boolean;
    start_min: number | null;
    end_min: number | null;
  }>(
    db,
    `SELECT o.host_id, o.override_date::text AS override_date, o.unavailable, w.start_min, w.end_min
     FROM date_overrides o
     LEFT JOIN override_windows w ON w.override_id = o.id
     WHERE o.host_id = ANY($1::uuid[]) AND o.override_date BETWEEN $2::date AND $3::date`,
    [ids, spanStart, spanEnd],
  );
  const overridesByHost = new Map<string, Map<string, { unavailable: boolean; windows: Window[] }>>();
  for (const row of overrideRows) {
    const map = overridesByHost.get(row.host_id) ?? new Map();
    const current = map.get(row.override_date) ?? { unavailable: row.unavailable, windows: [] };
    if (row.start_min !== null && row.end_min !== null) {
      current.windows.push({ startMin: row.start_min, endMin: row.end_min });
    }
    map.set(row.override_date, current);
    overridesByHost.set(row.host_id, map);
  }

  return hosts.map((host) => {
    const hostRules = rules
      .filter((rule) => rule.host_id === host.id)
      .map((rule) => ({ dayOfWeek: rule.day_of_week, startMin: rule.start_min, endMin: rule.end_min }));
    const overrides = overridesByHost.get(host.id) ?? new Map();
    const offered = new Set<number>();
    for (const date of datesByHost.get(host.id) ?? []) {
      const windows = windowsForDate(weekdayOf(host.timezone, date), hostRules, overrides.get(date));
      for (const start of generateSlotStarts({
        zone: host.timezone,
        date,
        durationMin: event.duration_min,
        windows,
      })) {
        if (
          slotIsOffered(start, {
            from,
            to,
            now,
            minNoticeMin: event.min_notice_min,
            horizonDays: event.horizon_days,
          })
        ) {
          offered.add(start.getTime());
        }
      }
    }
    return { id: host.id, timezone: host.timezone, rules: hostRules, overrides, offered };
  });
}

async function loadOccupancy(db: Db, ids: string[], from: Date, to: Date, excludeId: string | null): Promise<Occupancy[]> {
  const found = await rows<{
    id: string;
    event_type_id: string;
    starts_at: Date;
    ends_at: Date;
    buffer_before_min: number;
    buffer_after_min: number;
    assigned_host_id: string | null;
    owner_id: string;
  }>(
    db,
    `SELECT b.id, b.event_type_id, b.starts_at, b.ends_at, b.buffer_before_min, b.buffer_after_min,
            b.assigned_host_id, e.host_id AS owner_id
     FROM bookings b
     JOIN event_types e ON e.id = b.event_type_id
     WHERE ($4::uuid IS NULL OR b.id <> $4::uuid)
       AND (b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > now()))
       AND b.starts_at < $3 AND b.ends_at > $2
       AND (
         b.assigned_host_id = ANY($1::uuid[])
         OR (b.assigned_host_id IS NULL AND e.host_id = ANY($1::uuid[]))
       )`,
    [ids, new Date(from.getTime() - 60 * 60_000), new Date(to.getTime() + 60 * 60_000), excludeId],
  );
  return found.map((row) => ({
    id: row.id,
    eventTypeId: row.event_type_id,
    hostId: row.assigned_host_id ?? row.owner_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bufferBeforeMin: row.buffer_before_min,
    bufferAfterMin: row.buffer_after_min,
  }));
}

async function loadBlocks(
  db: Db,
  ids: string[],
  from: Date,
  to: Date,
): Promise<Array<{ hostId: string; startsAt: Date; endsAt: Date }>> {
  const found = await rows<{ host_id: string; starts_at: Date; ends_at: Date }>(
    db,
    `SELECT host_id, starts_at, ends_at FROM busy_blocks
     WHERE host_id = ANY($1::uuid[]) AND starts_at < $3 AND ends_at > $2`,
    [ids, from, to],
  );
  return found.map((row) => ({ hostId: row.host_id, startsAt: row.starts_at, endsAt: row.ends_at }));
}

function hostFree(
  member: Member,
  event: Schedulable,
  start: Date,
  end: Date,
  occupancy: Occupancy[],
  blocks: Array<{ hostId: string; startsAt: Date; endsAt: Date }>,
): boolean {
  if (!member.offered.has(start.getTime())) return false;
  const a = start.getTime();
  const b = end.getTime();
  if (blocks.some((block) => block.hostId === member.id && block.startsAt.getTime() < b && a < block.endsAt.getTime())) {
    return false;
  }
  const mine = occupancy.filter((row) => row.hostId === member.id);
  const slotRange = blockedRange(start, end, event.buffer_before_min, event.buffer_after_min);
  const elsewhere = mine.filter((row) => row.eventTypeId !== event.id);
  if (
    elsewhere.some((row) =>
      rangesOverlap(slotRange, blockedRange(row.startsAt, row.endsAt, row.bufferBeforeMin, row.bufferAfterMin)),
    )
  ) {
    return false;
  }
  const here = mine.filter((row) => row.eventTypeId === event.id);
  return seatsRemaining(start, end, event.buffer_before_min, event.buffer_after_min, event.capacity, here) >= 1;
}

async function dayCount(db: Db, event: Schedulable, start: Date, excludeId: string | null): Promise<number> {
  if (event.daily_cap == null) return 0;
  const row = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM bookings
     WHERE event_type_id = $1
       AND ($2::uuid IS NULL OR id <> $2::uuid)
       AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))
       AND ((starts_at AT TIME ZONE $3)::date) = $4::date`,
    [event.id, excludeId, event.timezone, localDay(event.timezone, start)],
  );
  return row?.n ?? 0;
}

export async function classifySlot(
  db: Db,
  event: Schedulable,
  start: Date,
  end: Date,
  excludeId: string | null,
  opts: { lock: boolean; prefer?: string | null },
): Promise<SlotPick> {
  const ids = await teamHostIds(db, event.id, event.host_id);
  if (!ids) return { kind: 'solo' };
  if (opts.lock) {
    await db.query(`SELECT id FROM hosts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
  }
  const now = await dbNow(db);
  const members = await loadMembers(db, ids, start, new Date(start.getTime() + 1), event, now);
  const offered = members.some((member) => member.offered.has(start.getTime()));
  if (!offered) return { kind: 'team', hostId: null, absent: true };
  if (event.daily_cap != null && (await dayCount(db, event, start, excludeId)) >= event.daily_cap) {
    return { kind: 'team', hostId: null, absent: false };
  }
  const occupancy = await loadOccupancy(db, ids, start, end, excludeId);
  const blocks = await loadBlocks(db, ids, start, end);
  const free = members.filter((member) => hostFree(member, event, start, end, occupancy, blocks));
  if (free.length === 0) return { kind: 'team', hostId: null, absent: false };
  if (opts.prefer && free.some((member) => member.id === opts.prefer)) {
    return { kind: 'team', hostId: opts.prefer, absent: false };
  }
  const counts = await rows<{ id: string; n: number }>(
    db,
    `SELECT assigned_host_id AS id, count(*)::int AS n
     FROM bookings
     WHERE assigned_host_id = ANY($1::uuid[])
       AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))
     GROUP BY 1`,
    [ids],
  );
  const load = new Map(counts.map((row) => [row.id, row.n]));
  free.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  return { kind: 'team', hostId: free[0].id, absent: false };
}

export async function listTeamSlots(
  db: Db,
  event: Schedulable,
  ids: string[],
  opts: { from: Date; to: Date; excludeBookingId?: string | null; includeFull?: boolean },
): Promise<{ now: string; slots: Array<{ startsAt: string; endsAt: string; remaining: number }>; full: Array<{ startsAt: string; endsAt: string; remaining: number }> }> {
  const now = await dbNow(db);
  const members = await loadMembers(db, ids, opts.from, opts.to, event, now);
  const starts = [...new Set(members.flatMap((member) => [...member.offered]))].sort((a, b) => a - b);
  const occupancy = await loadOccupancy(db, ids, opts.from, opts.to, opts.excludeBookingId ?? null);
  const blocks = await loadBlocks(db, ids, opts.from, opts.to);
  const usage = new Map<string, number>();
  if (event.daily_cap != null) {
    const found = await rows<{ day: string; n: number }>(
      db,
      `SELECT ((starts_at AT TIME ZONE $2)::date)::text AS day, count(*)::int AS n
       FROM bookings
       WHERE event_type_id = $1
         AND ($3::uuid IS NULL OR id <> $3::uuid)
         AND (status = 'confirmed' OR (status = 'held' AND expires_at > now()))
       GROUP BY 1`,
      [event.id, event.timezone, opts.excludeBookingId ?? null],
    );
    for (const row of found) usage.set(row.day, row.n);
  }
  const slots: Array<{ startsAt: string; endsAt: string; remaining: number }> = [];
  const full: Array<{ startsAt: string; endsAt: string; remaining: number }> = [];
  for (const ms of starts) {
    const start = new Date(ms);
    const end = new Date(ms + event.duration_min * 60_000);
    const free = members.filter((member) => hostFree(member, event, start, end, occupancy, blocks)).length;
    const capLeft = event.daily_cap == null ? Number.POSITIVE_INFINITY : event.daily_cap - (usage.get(localDay(event.timezone, start)) ?? 0);
    const remaining = Math.max(Math.min(capLeft, free), 0);
    const dto = { startsAt: start.toISOString(), endsAt: end.toISOString(), remaining };
    if (remaining > 0) slots.push(dto);
    else if (opts.includeFull) full.push(dto);
  }
  return { now: now.toISOString(), slots, full };
}
