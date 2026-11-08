import { DateTime } from 'luxon';

export type IcsEvent = { startsAt: Date; endsAt: Date; summary: string };

function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parseStamp(value: string, params: string, zone: string): Date | null {
  const dateOnly = /VALUE=DATE/i.test(params) || /^\d{8}$/.test(value);
  if (dateOnly) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!match) return null;
    const local = DateTime.fromObject(
      { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
      { zone },
    );
    return local.isValid ? local.toUTC().toJSDate() : null;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return null;
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1];
  const stampZone = match[7] === 'Z' ? 'utc' : tzid || zone;
  const local = DateTime.fromObject(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
    },
    { zone: stampZone },
  );
  return local.isValid ? local.toUTC().toJSDate() : null;
}

/** Pull VEVENT ranges out of an uploaded calendar. All-day events use the host timezone. */
export function parseIcs(text: string, zone: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let inEvent = false;
  let start: Date | null = null;
  let end: Date | null = null;
  let summary = '';
  let startIsDate = false;

  const flush = () => {
    if (start && !end && startIsDate) {
      end = new Date(start.getTime() + 24 * 60 * 60_000);
    }
    if (start && end && end > start) events.push({ startsAt: start, endsAt: end, summary });
    inEvent = false;
    start = null;
    end = null;
    summary = '';
    startIsDate = false;
  };

  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      flush();
      inEvent = true;
      continue;
    }
    if (line === 'END:VEVENT') {
      const was = inEvent;
      inEvent = true;
      if (was) flush();
      continue;
    }
    if (!inEvent) continue;
    const split = line.indexOf(':');
    if (split < 0) continue;
    const left = line.slice(0, split);
    const value = line.slice(split + 1).trim();
    const name = left.split(';')[0].toUpperCase();
    if (name === 'DTSTART') {
      startIsDate = /VALUE=DATE/i.test(left) || /^\d{8}$/.test(value);
      start = parseStamp(value, left, zone);
    } else if (name === 'DTEND') {
      end = parseStamp(value, left, zone);
    } else if (name === 'SUMMARY') {
      summary = value.replace(/\\n/g, ' ').replace(/\\,/g, ',').slice(0, 200);
    }
  }
  return events;
}

function icsStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export function renderInvite(input: {
  bookingId: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  summary: string;
  startsAt: Date;
  endsAt: Date;
  guestEmail: string;
  hostName: string;
}): string {
  const status = input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotbook//EN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:booking-${input.bookingId}@slotbook`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(input.startsAt)}`,
    `DTEND:${icsStamp(input.endsAt)}`,
    `SUMMARY:${icsText(input.summary)}`,
    `ORGANIZER;CN=${icsText(input.hostName)}:MAILTO:host@slotbook.local`,
    `ATTENDEE;CN=${icsText(input.guestEmail)};RSVP=TRUE:MAILTO:${input.guestEmail}`,
    `SEQUENCE:${input.sequence}`,
    `STATUS:${status}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** A one-hour block at 15:00 UTC tomorrow, used as the mocked calendar feed. */
export function sampleIcs(now = new Date()): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 15, 0, 0));
  const end = new Date(start.getTime() + 60 * 60_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotbook//EN',
    'BEGIN:VEVENT',
    'UID:sample-busy@slotbook',
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    'SUMMARY:External busy',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
