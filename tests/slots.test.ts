import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { blockedRange, generateSlotStarts, rangesOverlap, seatsRemaining } from '../src/server/slots.js';

describe('slot grid', () => {
  it('skips the spring-forward hour in America/New_York', () => {
    const starts = generateSlotStarts({
      zone: 'America/New_York',
      date: '2026-03-08',
      durationMin: 30,
      windows: [{ startMin: 0, endMin: 300 }],
    });
    const hours = starts.map(
      (start) => DateTime.fromJSDate(start, { zone: 'utc' }).setZone('America/New_York').hour,
    );
    assert.deepEqual(hours, [0, 0, 1, 1, 3, 3, 4, 4]);
    assert.equal(new Set(starts.map((start) => start.getTime())).size, starts.length);
  });

  it('keeps both instances of the repeated hour on fall back', () => {
    const starts = generateSlotStarts({
      zone: 'America/New_York',
      date: '2026-11-01',
      durationMin: 30,
      windows: [{ startMin: 0, endMin: 240 }],
    });
    assert.equal(starts.length, 10);
    assert.equal(new Set(starts.map((start) => start.getTime())).size, starts.length);
    const first = DateTime.fromJSDate(starts[0], { zone: 'utc' }).setZone('America/New_York');
    const last = DateTime.fromJSDate(starts[starts.length - 1], { zone: 'utc' }).setZone('America/New_York');
    assert.equal(first.hour, 0);
    assert.equal(last.hour, 3);
    assert.equal(last.minute, 30);
  });

  it('treats buffer padding as a half-open blocked range', () => {
    const first = blockedRange(new Date('2026-01-01T09:00:00Z'), new Date('2026-01-01T09:30:00Z'), 0, 10);
    const overlapping = blockedRange(new Date('2026-01-01T09:30:00Z'), new Date('2026-01-01T10:00:00Z'), 0, 0);
    const adjacent = blockedRange(new Date('2026-01-01T09:40:00Z'), new Date('2026-01-01T10:10:00Z'), 0, 0);
    assert.equal(rangesOverlap(first, overlapping), true);
    assert.equal(rangesOverlap(first, adjacent), false);
    const remaining = seatsRemaining(
      new Date('2026-01-01T09:40:00Z'),
      new Date('2026-01-01T10:10:00Z'),
      0,
      0,
      1,
      [
        {
          id: 'a',
          startsAt: new Date('2026-01-01T09:00:00Z'),
          endsAt: new Date('2026-01-01T09:30:00Z'),
          bufferBeforeMin: 0,
          bufferAfterMin: 10,
        },
      ],
    );
    assert.equal(remaining, 1);
  });
});
