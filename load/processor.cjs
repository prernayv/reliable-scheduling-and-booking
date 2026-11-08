const { randomUUID } = require('node:crypto');

/** Seat offers copied from the setup response. Each entry can be booked once. */
const offers = [];

function setWindow(context, _events, done) {
  const from = new Date();
  const to = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    tz: 'UTC',
  });
  context.vars.slotUrl = `/api/hosts/demo/events/workshop/slots?${params}`;
  done();
}

function stashSlots(_req, res, _context, _ee, next) {
  let body = {};
  try {
    body = JSON.parse(res.body);
  } catch {
    body = {};
  }
  const capacity = Number(body.event?.capacity || 1);
  for (const slot of body.slots || []) {
    for (let i = 0; i < capacity; i++) offers.push(slot.startsAt);
  }
  return next();
}

function assign(context, _events, done) {
  if (offers.length === 0) {
    done(new Error('No workshop slots left to book. Seed the demo host and widen the horizon.'));
    return;
  }
  const index = Math.floor(Math.random() * offers.length);
  const startsAt = offers.splice(index, 1)[0];
  const id = randomUUID();
  context.vars.startsAt = startsAt;
  context.vars.key = id;
  context.vars.email = `load-${id}@example.com`;
  const bytes = id.replace(/-/g, '');
  context.vars.ip = [10, parseInt(bytes.slice(0, 2), 16), parseInt(bytes.slice(2, 4), 16), parseInt(bytes.slice(4, 6), 16)].join('.');
  done();
}

module.exports = { setWindow, stashSlots, assign };
