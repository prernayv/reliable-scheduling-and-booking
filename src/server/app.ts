import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { DateTime } from 'luxon';
import {
  clearSessionCookie,
  hostFromRequest,
  sessionCookie,
  signSession,
  verifyPassword,
  type SessionHost,
} from './auth.js';
import {
  cancelBooking,
  claimWaitlist,
  confirmHold,
  createHold,
  getBooking,
  getWaitlistOffer,
  inviteForToken,
  joinWaitlist,
  listSlots,
  loadEvent,
  rescheduleBooking,
  type SlotDto,
} from './booking.js';
import { getPool, one, rows, withTx } from './db.js';
import { readCalendarFeed, readMetrics, replaceBusyBlocks } from './extensions.js';
import { parseIcs, sampleIcs } from './ics.js';
import { randomBytes } from 'node:crypto';
import { allow, clientIp, publicLimit } from './ratelimit.js';
import { ApiError, isPgError } from './errors.js';
import {
  email,
  idempotencyKey,
  instant,
  intIn,
  isoDate,
  httpUrl,
  requiredString,
  requireObject,
  slug,
  timezone,
  weeklyRules,
  windows,
} from './validate.js';

export const app = new Hono();

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  const started = performance.now();
  await next();
  if (c.req.path.startsWith('/api/')) {
    console.log(
      JSON.stringify({
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      }),
    );
  }
});

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  if (isPgError(err) && err.code === '23505') {
    return c.json({ error: 'That slug or email is already in use', code: 'conflict' }, 409);
  }
  console.error(err);
  return c.json({ error: 'Internal error', code: 'internal' }, 500);
});

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const path = c.req.path;
  const writing =
    c.req.method === 'POST' &&
    (path === '/api/holds' ||
      path.startsWith('/api/holds/') ||
      path === '/api/waitlist' ||
      path.startsWith('/api/waitlist/') ||
      path.startsWith('/api/bookings/'));
  const reading = c.req.method === 'GET' && path.includes('/slots');
  if (writing || reading) {
    const ip = clientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'));
    const kind = reading ? 'read' : 'write';
    if (!allow(`${ip}:${kind}`, publicLimit(kind), 60_000)) {
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
  }
  await next();
});

app.get('/api/health', async (c) => {
  try {
    await getPool().query('SELECT 1');
    return c.json({ ok: true, database: 'up', metrics: await readMetrics(getPool()) });
  } catch {
    return c.json({ ok: false, database: 'down' }, 503);
  }
});

async function readBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_body', 'JSON object body required');
  }
  return requireObject(parsed);
}

async function requireHost(c: Context): Promise<SessionHost> {
  const host = await hostFromRequest(c, getPool());
  if (!host) throw new ApiError(401, 'unauthorized', 'Log in required');
  return host;
}

function eventInput(body: Record<string, unknown>) {
  return {
    name: requiredString('name', body.name, 120),
    slug: slug('slug', body.slug),
    durationMin: intIn('durationMin', body.durationMin, 15, 120),
    capacity: intIn('capacity', body.capacity, 1, 500),
    bufferBeforeMin: intIn('bufferBeforeMin', body.bufferBeforeMin, 0, 30),
    bufferAfterMin: intIn('bufferAfterMin', body.bufferAfterMin, 0, 30),
    minNoticeMin: intIn('minNoticeMin', body.minNoticeMin, 0, 43200),
    horizonDays: intIn('horizonDays', body.horizonDays, 1, 365),
    dailyCap: body.dailyCap == null ? null : intIn('dailyCap', body.dailyCap, 1, 500),
    guestLimit: body.guestLimit === true,
  };
}

function localPair(startsAt: string, endsAt: string, zone: string) {
  const start = DateTime.fromISO(startsAt, { zone: 'utc' }).setZone(zone);
  const end = DateTime.fromISO(endsAt, { zone: 'utc' }).setZone(zone);
  return { localStartsAt: start.toISO(), localEndsAt: end.toISO() };
}

function presentSlots(slots: SlotDto[], zone: string) {
  return slots.map((slot) => ({ ...slot, ...localPair(slot.startsAt, slot.endsAt, zone) }));
}

app.post('/api/auth/login', async (c) => {
  const body = await readBody(c);
  const address = email(body.email);
  const password = requiredString('password', body.password, 200);
  const host = await one<{
    id: string;
    email: string;
    name: string;
    slug: string;
    timezone: string;
    password_hash: string;
  }>(getPool(), `SELECT id, email, name, slug, timezone, password_hash FROM hosts WHERE email = $1`, [address]);
  if (!host || !verifyPassword(password, host.password_hash)) {
    throw new ApiError(401, 'invalid_login', 'Email or password is wrong');
  }
  c.header('Set-Cookie', sessionCookie(signSession(host.id)));
  return c.json({ id: host.id, email: host.email, name: host.name, slug: host.slug, timezone: host.timezone });
});

app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  return c.json(await requireHost(c));
});

app.patch('/api/host/settings', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const zone = timezone(body.timezone);
  await getPool().query(`UPDATE hosts SET timezone = $2 WHERE id = $1`, [host.id, zone]);
  return c.json({ ...host, timezone: zone });
});

app.get('/api/host/events', async (c) => {
  const host = await requireHost(c);
  const events = await rows<{
    id: string;
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
  }>(
    getPool(),
    `SELECT id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days,
            daily_cap, guest_limit
     FROM event_types WHERE host_id = $1 ORDER BY name`,
    [host.id],
  );
  return c.json({
    events: events.map((event) => ({
      id: event.id,
      name: event.name,
      slug: event.slug,
      durationMin: event.duration_min,
      capacity: event.capacity,
      bufferBeforeMin: event.buffer_before_min,
      bufferAfterMin: event.buffer_after_min,
      minNoticeMin: event.min_notice_min,
      horizonDays: event.horizon_days,
      dailyCap: event.daily_cap,
      guestLimit: event.guest_limit,
    })),
  });
});

app.post('/api/host/events', async (c) => {
  const host = await requireHost(c);
  const input = eventInput(await readBody(c));
  const row = await one<{ id: string }>(
    getPool(),
    `INSERT INTO event_types (
       host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days,
       daily_cap, guest_limit
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      host.id,
      input.name,
      input.slug,
      input.durationMin,
      input.capacity,
      input.bufferBeforeMin,
      input.bufferAfterMin,
      input.minNoticeMin,
      input.horizonDays,
      input.dailyCap,
      input.guestLimit,
    ],
  );
  return c.json({ id: row!.id, ...input }, 201);
});

app.patch('/api/host/events/:id', async (c) => {
  const host = await requireHost(c);
  const input = eventInput(await readBody(c));
  const row = await one<{ id: string }>(
    getPool(),
    `UPDATE event_types SET
       name = $3, slug = $4, duration_min = $5, capacity = $6,
       buffer_before_min = $7, buffer_after_min = $8, min_notice_min = $9, horizon_days = $10,
       daily_cap = $11, guest_limit = $12
     WHERE id = $1 AND host_id = $2
     RETURNING id`,
    [
      c.req.param('id'),
      host.id,
      input.name,
      input.slug,
      input.durationMin,
      input.capacity,
      input.bufferBeforeMin,
      input.bufferAfterMin,
      input.minNoticeMin,
      input.horizonDays,
      input.dailyCap,
      input.guestLimit,
    ],
  );
  if (!row) throw new ApiError(404, 'event_not_found', 'Event not found');
  return c.json({ id: row.id, ...input });
});

app.delete('/api/host/events/:id', async (c) => {
  const host = await requireHost(c);
  const id = c.req.param('id');
  const owned = await one(getPool(), `SELECT id FROM event_types WHERE id = $1 AND host_id = $2`, [id, host.id]);
  if (!owned) throw new ApiError(404, 'event_not_found', 'Event not found');
  const booking = await one(
    getPool(),
    `SELECT id FROM bookings WHERE event_type_id = $1 LIMIT 1`,
    [id],
  );
  if (booking) {
    throw new ApiError(409, 'event_has_bookings', 'Events with bookings stay so history is kept');
  }
  await getPool().query(`DELETE FROM event_types WHERE id = $1`, [id]);
  return c.json({ ok: true });
});

app.get('/api/host/availability', async (c) => {
  const host = await requireHost(c);
  const rules = await rows<{ day_of_week: number; start_min: number; end_min: number }>(
    getPool(),
    `SELECT day_of_week, start_min, end_min FROM availability_rules WHERE host_id = $1 ORDER BY day_of_week, start_min`,
    [host.id],
  );
  return c.json({
    rules: rules.map((rule) => ({ dayOfWeek: rule.day_of_week, startMin: rule.start_min, endMin: rule.end_min })),
  });
});

app.put('/api/host/availability', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const rules = weeklyRules(body.rules);
  await withTx(async (tx) => {
    await tx.query(`SELECT id FROM hosts WHERE id = $1 FOR UPDATE`, [host.id]);
    await tx.query(`DELETE FROM availability_rules WHERE host_id = $1`, [host.id]);
    for (const rule of rules) {
      await tx.query(
        `INSERT INTO availability_rules (host_id, day_of_week, start_min, end_min) VALUES ($1, $2, $3, $4)`,
        [host.id, rule.dayOfWeek, rule.startMin, rule.endMin],
      );
    }
  });
  return c.json({ rules });
});

app.get('/api/host/overrides', async (c) => {
  const host = await requireHost(c);
  const found = await rows<{ override_date: string; unavailable: boolean; start_min: number | null; end_min: number | null }>(
    getPool(),
    `SELECT o.override_date::text AS override_date, o.unavailable, w.start_min, w.end_min
     FROM date_overrides o
     LEFT JOIN override_windows w ON w.override_id = o.id
     WHERE o.host_id = $1
     ORDER BY o.override_date, w.start_min`,
    [host.id],
  );
  const byDate = new Map<string, { date: string; unavailable: boolean; windows: { startMin: number; endMin: number }[] }>();
  for (const row of found) {
    const current = byDate.get(row.override_date) ?? { date: row.override_date, unavailable: row.unavailable, windows: [] };
    if (row.start_min !== null && row.end_min !== null) {
      current.windows.push({ startMin: row.start_min, endMin: row.end_min });
    }
    byDate.set(row.override_date, current);
  }
  return c.json({ overrides: [...byDate.values()] });
});

app.put('/api/host/overrides/:date', async (c) => {
  const host = await requireHost(c);
  const date = isoDate('date', c.req.param('date'));
  const body = await readBody(c);
  if (typeof body.unavailable !== 'boolean') {
    throw new ApiError(400, 'invalid_unavailable', 'unavailable must be true or false');
  }
  const spans = body.unavailable ? [] : windows(body.windows);
  await withTx(async (tx) => {
    await tx.query(`SELECT id FROM hosts WHERE id = $1 FOR UPDATE`, [host.id]);
    await tx.query(`DELETE FROM date_overrides WHERE host_id = $1 AND override_date = $2::date`, [host.id, date]);
    const inserted = await one<{ id: string }>(
      tx,
      `INSERT INTO date_overrides (host_id, override_date, unavailable) VALUES ($1, $2::date, $3) RETURNING id`,
      [host.id, date, body.unavailable],
    );
    for (const span of spans) {
      await tx.query(`INSERT INTO override_windows (override_id, start_min, end_min) VALUES ($1, $2, $3)`, [
        inserted!.id,
        span.startMin,
        span.endMin,
      ]);
    }
  });
  return c.json({ date, unavailable: body.unavailable, windows: spans });
});

app.delete('/api/host/overrides/:date', async (c) => {
  const host = await requireHost(c);
  const date = isoDate('date', c.req.param('date'));
  await getPool().query(`DELETE FROM date_overrides WHERE host_id = $1 AND override_date = $2::date`, [host.id, date]);
  return c.json({ ok: true });
});

app.get('/api/host/bookings', async (c) => {
  const host = await requireHost(c);
  const bookings = await rows<{
    id: string;
    starts_at: Date;
    ends_at: Date;
    guest_name: string;
    guest_email: string;
    event_name: string;
    event_slug: string;
  }>(
    getPool(),
    `SELECT b.id, b.starts_at, b.ends_at, b.guest_name, b.guest_email, e.name AS event_name, e.slug AS event_slug
     FROM bookings b
     JOIN event_types e ON e.id = b.event_type_id
     WHERE e.host_id = $1 AND b.status = 'confirmed' AND b.ends_at > now()
     ORDER BY b.starts_at
     LIMIT 200`,
    [host.id],
  );
  return c.json({
    bookings: bookings.map((booking) => ({
      id: booking.id,
      startsAt: booking.starts_at.toISOString(),
      endsAt: booking.ends_at.toISOString(),
      guestName: booking.guest_name,
      guestEmail: booking.guest_email,
      eventName: booking.event_name,
      eventSlug: booking.event_slug,
    })),
  });
});

app.post('/api/host/bookings/:id/cancel', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const reason = requiredString('reason', body.reason, 500);
  const booking = await cancelBooking({ bookingId: c.req.param('id'), hostId: host.id, reason });
  return c.json(booking);
});

app.get('/api/host/notifications', async (c) => {
  const host = await requireHost(c);
  const notes = await rows<{ id: string; kind: string; payload: unknown; created_at: Date }>(
    getPool(),
    `SELECT id, kind, payload, created_at FROM notifications WHERE host_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [host.id],
  );
  return c.json({
    notifications: notes.map((note) => ({
      id: note.id,
      kind: note.kind,
      payload: note.payload,
      createdAt: note.created_at.toISOString(),
    })),
  });
});

function rangeQuery(c: Context) {
  const from = instant('from', c.req.query('from'));
  const to = instant('to', c.req.query('to'));
  const tz = timezone(c.req.query('tz'));
  return { from, to, tz };
}

app.get('/api/hosts/:host/events/:slug/slots', async (c) => {
  const { from, to, tz } = rangeQuery(c);
  const event = await loadEvent(getPool(), c.req.param('host'), c.req.param('slug'));
  const listed = await listSlots(getPool(), event, { from, to, includeFull: true });
  const team = await one<{ n: number }>(
    getPool(),
    `SELECT count(*)::int AS n FROM event_members WHERE event_type_id = $1`,
    [event.id],
  );
  return c.json({
    host: event.host_slug,
    hostName: event.host_name,
    hostTimezone: event.timezone,
    timezone: tz,
    event: {
      name: event.name,
      slug: event.slug,
      durationMin: event.duration_min,
      capacity: event.capacity,
      bufferBeforeMin: event.buffer_before_min,
      bufferAfterMin: event.buffer_after_min,
      minNoticeMin: event.min_notice_min,
      horizonDays: event.horizon_days,
    },
    now: listed.now,
    from: from.toISOString(),
    to: to.toISOString(),
    roundRobin: (team?.n ?? 0) > 0,
    slots: presentSlots(listed.slots, tz),
    full: presentSlots(listed.full, tz),
  });
});

function rejectBot(body: Record<string, unknown>): void {
  if (typeof body.company === 'string' && body.company.trim()) {
    throw new ApiError(400, 'rejected', 'Could not complete that request');
  }
}

app.post('/api/holds', async (c) => {
  const key = idempotencyKey(c.req.header('Idempotency-Key'));
  const body = await readBody(c);
  rejectBot(body);
  const result = await createHold({
    host: slug('host', body.host),
    eventSlug: slug('eventSlug', body.eventSlug),
    startsAt: instant('startsAt', body.startsAt),
    idempotencyKey: key,
    clientIp: clientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip')),
  });
  return c.json(result.body, result.status as 201);
});

app.post('/api/holds/:id/confirm', async (c) => {
  const body = await readBody(c);
  rejectBot(body);
  const booking = await confirmHold(
    c.req.param('id'),
    requiredString('name', body.name, 120),
    email(body.email),
  );
  return c.json(booking);
});

app.get('/api/bookings/:token', async (c) => {
  return c.json(await getBooking(c.req.param('token')));
});

app.get('/api/bookings/:token/slots', async (c) => {
  const { from, to, tz } = rangeQuery(c);
  const booking = await getBooking(c.req.param('token'));
  if (booking.status !== 'confirmed') {
    throw new ApiError(409, 'not_confirmed', 'Only a confirmed booking can be moved');
  }
  const event = await loadEvent(getPool(), booking.hostSlug, booking.eventSlug);
  const listed = await listSlots(getPool(), event, { from, to, excludeBookingId: booking.id });
  return c.json({
    timezone: tz,
    hostTimezone: event.timezone,
    now: listed.now,
    currentStartsAt: booking.startsAt,
    slots: presentSlots(listed.slots, tz),
  });
});

app.post('/api/bookings/:token/reschedule', async (c) => {
  const body = await readBody(c);
  const booking = await rescheduleBooking(c.req.param('token'), instant('startsAt', body.startsAt));
  return c.json(booking);
});

app.post('/api/bookings/:token/cancel', async (c) => {
  const body = await readBody(c);
  const booking = await cancelBooking({
    token: c.req.param('token'),
    reason: requiredString('reason', body.reason, 500),
  });
  return c.json(booking);
});

app.get('/api/bookings/:token/invite.ics', async (c) => {
  const body = await inviteForToken(c.req.param('token'));
  c.header('content-type', 'text/calendar; charset=utf-8');
  c.header('content-disposition', 'attachment; filename="invite.ics"');
  return c.body(body);
});

app.post('/api/waitlist', async (c) => {
  const body = await readBody(c);
  rejectBot(body);
  const joined = await joinWaitlist({
    host: slug('host', body.host),
    eventSlug: slug('eventSlug', body.eventSlug),
    startsAt: instant('startsAt', body.startsAt),
    guestName: requiredString('name', body.name, 120),
    guestEmail: email(body.email),
  });
  return c.json(joined, 201);
});

app.get('/api/waitlist/:token', async (c) => {
  return c.json(await getWaitlistOffer(c.req.param('token')));
});

app.post('/api/waitlist/:token/claim', async (c) => {
  return c.json(await claimWaitlist(c.req.param('token')));
});

app.get('/api/calendar/sample.ics', (c) => {
  c.header('content-type', 'text/calendar; charset=utf-8');
  return c.body(sampleIcs());
});

app.get('/api/embed.js', (c) => {
  c.header('content-type', 'text/javascript; charset=utf-8');
  return c.body(
    `(function(){var s=document.currentScript;if(!s)return;var host=s.getAttribute("data-host");var event=s.getAttribute("data-event");if(!host||!event)return;var frame=document.createElement("iframe");frame.title="Book a time";frame.src=new URL("/embed/"+encodeURIComponent(host)+"/"+encodeURIComponent(event),s.src).href;frame.style.cssText="width:100%;border:0;min-height:640px";s.parentNode&&s.parentNode.insertBefore(frame,s.nextSibling);window.addEventListener("message",function(msg){if(!msg.data||msg.data.type!=="slotbook-height"||msg.source!==frame.contentWindow)return;var height=Number(msg.data.height);if(height>200)frame.style.height=Math.min(height+16,4000)+"px";});})();`,
  );
});

app.get('/api/host/events/:id/members', async (c) => {
  const host = await requireHost(c);
  const event = await one(getPool(), `SELECT id FROM event_types WHERE id = $1 AND host_id = $2`, [c.req.param('id'), host.id]);
  if (!event) throw new ApiError(404, 'event_not_found', 'Event not found');
  const members = await rows<{ slug: string; name: string }>(
    getPool(),
    `SELECT h.slug, h.name FROM event_members m JOIN hosts h ON h.id = m.host_id WHERE m.event_type_id = $1 ORDER BY h.slug`,
    [c.req.param('id')],
  );
  return c.json({ members });
});

app.put('/api/host/events/:id/members', async (c) => {
  const host = await requireHost(c);
  const event = await one(getPool(), `SELECT id FROM event_types WHERE id = $1 AND host_id = $2`, [c.req.param('id'), host.id]);
  if (!event) throw new ApiError(404, 'event_not_found', 'Event not found');
  const body = await readBody(c);
  if (!Array.isArray(body.slugs)) throw new ApiError(400, 'invalid_slugs', 'slugs must be an array');
  if (body.slugs.length > 10) throw new ApiError(400, 'invalid_slugs', 'At most 10 hosts');
  const slugs = [...new Set(body.slugs.map((item) => slug('slug', item)))].filter((item) => item !== host.slug);
  const found = slugs.length
    ? await rows<{ id: string; slug: string; name: string }>(
        getPool(),
        `SELECT id, slug, name FROM hosts WHERE slug = ANY($1::text[])`,
        [slugs],
      )
    : [];
  if (found.length !== slugs.length) throw new ApiError(404, 'host_not_found', 'One of those hosts does not exist');
  await withTx(async (tx) => {
    await tx.query(`DELETE FROM event_members WHERE event_type_id = $1`, [c.req.param('id')]);
    for (const member of found) {
      await tx.query(`INSERT INTO event_members (event_type_id, host_id) VALUES ($1, $2)`, [c.req.param('id'), member.id]);
    }
  });
  return c.json({ members: found.map((member) => ({ slug: member.slug, name: member.name })) });
});

app.get('/api/host/webhooks', async (c) => {
  const host = await requireHost(c);
  const hooks = await rows<{ id: string; url: string; secret: string; created_at: Date }>(
    getPool(),
    `SELECT id, url, secret, created_at FROM webhooks WHERE host_id = $1 ORDER BY created_at`,
    [host.id],
  );
  return c.json({
    webhooks: hooks.map((hook) => ({
      id: hook.id,
      url: hook.url,
      secret: hook.secret,
      createdAt: hook.created_at.toISOString(),
    })),
  });
});

app.post('/api/host/webhooks', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const url = httpUrl(body.url);
  const secret = randomBytes(24).toString('base64url');
  try {
    const row = await one<{ id: string }>(
      getPool(),
      `INSERT INTO webhooks (host_id, url, secret) VALUES ($1, $2, $3) RETURNING id`,
      [host.id, url, secret],
    );
    return c.json({ id: row!.id, url, secret }, 201);
  } catch (err) {
    if (isPgError(err) && err.code === '23505') {
      throw new ApiError(409, 'webhook_exists', 'That URL is already registered');
    }
    throw err;
  }
});

app.delete('/api/host/webhooks/:id', async (c) => {
  const host = await requireHost(c);
  const row = await one(
    getPool(),
    `DELETE FROM webhooks WHERE id = $1 AND host_id = $2 RETURNING id`,
    [c.req.param('id'), host.id],
  );
  if (!row) throw new ApiError(404, 'webhook_not_found', 'Webhook not found');
  return c.json({ ok: true });
});

app.get('/api/host/webhook-deliveries', async (c) => {
  const host = await requireHost(c);
  const deliveries = await rows<{
    id: string;
    url: string;
    status: string;
    attempt: number;
    http_status: number | null;
    error: string | null;
    kind: string;
    created_at: Date;
  }>(
    getPool(),
    `SELECT d.id, w.url, d.status, d.attempt, d.http_status, d.error, n.kind, d.created_at
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     JOIN notifications n ON n.id = d.notification_id
     WHERE w.host_id = $1
     ORDER BY d.created_at DESC
     LIMIT 30`,
    [host.id],
  );
  return c.json({
    deliveries: deliveries.map((row) => ({
      id: row.id,
      url: row.url,
      status: row.status,
      attempt: row.attempt,
      httpStatus: row.http_status,
      error: row.error,
      kind: row.kind,
      createdAt: row.created_at.toISOString(),
    })),
  });
});

app.get('/api/host/busy', async (c) => {
  const host = await requireHost(c);
  const blocks = await rows<{ id: string; starts_at: Date; ends_at: Date; summary: string; source: string }>(
    getPool(),
    `SELECT id, starts_at, ends_at, summary, source FROM busy_blocks WHERE host_id = $1 ORDER BY starts_at LIMIT 100`,
    [host.id],
  );
  return c.json({
    blocks: blocks.map((block) => ({
      id: block.id,
      startsAt: block.starts_at.toISOString(),
      endsAt: block.ends_at.toISOString(),
      summary: block.summary,
      source: block.source,
    })),
  });
});

app.post('/api/host/busy', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const events = parseIcs(requiredString('ics', body.ics, 500_000), host.timezone);
  const imported = await withTx((tx) => replaceBusyBlocks(tx, host.id, 'ics', events));
  return c.json({ imported });
});

app.post('/api/host/busy/feed', async (c) => {
  const host = await requireHost(c);
  const body = await readBody(c);
  const events = await readCalendarFeed(requiredString('url', body.url, 500), host.timezone);
  const imported = await withTx((tx) => replaceBusyBlocks(tx, host.id, 'feed', events));
  return c.json({ imported });
});

app.post('/api/host/busy/sample', async (c) => {
  const host = await requireHost(c);
  const events = parseIcs(sampleIcs(), host.timezone);
  const imported = await withTx((tx) => replaceBusyBlocks(tx, host.id, 'feed', events));
  return c.json({ imported });
});

export function attachClient(target: Hono): void {
  target.use('/*', serveStatic({ root: './dist/client' }));
  target.get('*', serveStatic({ root: './dist/client', path: 'index.html' }));
}
