import { serve } from '@hono/node-server';
import { app, attachClient } from './app.js';
import { dispatchReminders, drainWebhooks, sweepExpiredHolds } from './extensions.js';
import { loadEnv } from './env.js';

loadEnv();

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; using a development default');
}

if (process.env.NODE_ENV === 'production') {
  attachClient(app);
}

async function tick(): Promise<void> {
  try {
    const expired = await sweepExpiredHolds();
    const reminders = await dispatchReminders();
    const delivered = await drainWebhooks();
    if (expired || reminders || delivered) {
      console.log(JSON.stringify({ worker: true, expired, reminders, delivered }));
    }
  } catch (err) {
    console.error(JSON.stringify({ worker: true, error: err instanceof Error ? err.message : 'failed' }));
  }
}

setInterval(() => void tick(), 5000);
void tick();

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Slotbook API listening on http://localhost:${port}`);
});
