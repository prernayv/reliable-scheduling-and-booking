import { DateTime } from 'luxon';

export type Window = { startMin: number; endMin: number };

export type BusyInterval = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMin: number;
  bufferAfterMin: number;
};

const MINUTE = 60_000;

/**
 * Local clock time on a calendar date, or null when that clock time does not
 * exist (spring-forward gap). Ambiguous times (fall-back) keep Luxon's earlier
 * offset. Minute 1440 is the next local midnight.
 */
export function atMinute(
  zone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): DateTime | null {
  if (minuteOfDay === 1440) {
    const next = DateTime.fromObject({ year, month, day }, { zone }).plus({ days: 1 }).startOf('day');
    return next.isValid ? next : null;
  }
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone },
  );
  if (!dt.isValid) return null;
  if (dt.year !== year || dt.month !== month || dt.day !== day || dt.hour !== hour || dt.minute !== minute) {
    return null;
  }
  return dt;
}

/** Real-time slot starts inside each window. Step is the event duration. */
export function generateSlotStarts(opts: {
  zone: string;
  date: string;
  durationMin: number;
  windows: Window[];
}): Date[] {
  const [year, month, day] = opts.date.split('-').map(Number);
  if (!year || !month || !day) return [];
  const step = opts.durationMin * MINUTE;
  const seen = new Set<number>();
  const starts: Date[] = [];

  for (const window of opts.windows) {
    const startLocal = atMinute(opts.zone, year, month, day, window.startMin);
    const endLocal = atMinute(opts.zone, year, month, day, window.endMin);
    if (!startLocal || !endLocal) continue;
    const endMs = endLocal.toUTC().toMillis();
    let cursor = startLocal.toUTC();
    if (endMs <= cursor.toMillis()) continue;
    while (cursor.toMillis() + step <= endMs) {
      const ms = cursor.toMillis();
      if (!seen.has(ms)) {
        seen.add(ms);
        starts.push(new Date(ms));
      }
      cursor = cursor.plus({ milliseconds: step });
    }
  }

  starts.sort((a, b) => a.getTime() - b.getTime());
  return starts;
}

export function eachZonedDate(zone: string, from: Date, to: Date): string[] {
  let day = DateTime.fromJSDate(from, { zone: 'utc' }).setZone(zone).startOf('day').minus({ days: 1 });
  const last = DateTime.fromJSDate(to, { zone: 'utc' }).setZone(zone).startOf('day').plus({ days: 1 });
  const out: string[] = [];
  for (; day <= last; day = day.plus({ days: 1 })) {
    const iso = day.toISODate();
    if (iso) out.push(iso);
  }
  return out;
}

export function slotIsOffered(
  start: Date,
  opts: { from: Date; to: Date; now: Date; minNoticeMin: number; horizonDays: number },
): boolean {
  const t = start.getTime();
  if (t < opts.from.getTime() || t >= opts.to.getTime()) return false;
  if (t < opts.now.getTime() + opts.minNoticeMin * MINUTE) return false;
  const horizonEnd = opts.now.getTime() + opts.horizonDays * 24 * 60 * MINUTE;
  if (t >= horizonEnd) return false;
  return true;
}

export function blockedRange(
  startsAt: Date,
  endsAt: Date,
  bufferBeforeMin: number,
  bufferAfterMin: number,
): [number, number] {
  return [startsAt.getTime() - bufferBeforeMin * MINUTE, endsAt.getTime() + bufferAfterMin * MINUTE];
}

export function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

export function seatsRemaining(
  start: Date,
  end: Date,
  bufferBeforeMin: number,
  bufferAfterMin: number,
  capacity: number,
  busy: BusyInterval[],
): number {
  const mine = blockedRange(start, end, bufferBeforeMin, bufferAfterMin);
  let used = 0;
  for (const booking of busy) {
    const other = blockedRange(
      booking.startsAt,
      booking.endsAt,
      booking.bufferBeforeMin,
      booking.bufferAfterMin,
    );
    if (rangesOverlap(mine, other)) used += 1;
  }
  return capacity - used;
}

export function windowsForDate(
  weekday: number,
  rules: Array<{ dayOfWeek: number; startMin: number; endMin: number }>,
  override: { unavailable: boolean; windows: Window[] } | undefined,
): Window[] {
  if (override) return override.unavailable ? [] : override.windows;
  return rules
    .filter((rule) => rule.dayOfWeek === weekday)
    .map((rule) => ({ startMin: rule.startMin, endMin: rule.endMin }))
    .sort((a, b) => a.startMin - b.startMin);
}

export function weekdayOf(zone: string, isoDate: string): number {
  const dt = DateTime.fromISO(isoDate, { zone });
  return dt.weekday;
}
