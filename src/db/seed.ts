import { pathToFileURL } from 'node:url';
import { closePool, getPool, one, rows } from '../server/db.js';
import { loadEnv } from '../server/env.js';
import { hashPassword } from '../server/auth.js';

export const DEMO_EMAIL = 'demo@slotbook.dev';
export const DEMO_PASSWORD = 'demo-password';
export const DEMO_SLUG = 'demo';

export async function seed(): Promise<void> {
  loadEnv();
  const pool = getPool();
  const existing = await one<{ id: string }>(pool, 'SELECT id FROM hosts WHERE slug = $1', [DEMO_SLUG]);
  let hostId = existing?.id;
  if (!hostId) {
    const inserted = await one<{ id: string }>(
      pool,
      `INSERT INTO hosts (email, name, slug, timezone, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [DEMO_EMAIL, 'Demo Host', DEMO_SLUG, 'Asia/Kolkata', hashPassword(DEMO_PASSWORD)],
    );
    hostId = inserted!.id;
    console.log(`seeded host ${DEMO_SLUG} (${DEMO_EMAIL} / ${DEMO_PASSWORD})`);
  }

  const events = [
    {
      name: 'Intro call',
      slug: 'intro',
      duration: 30,
      capacity: 1,
      bufferBefore: 0,
      bufferAfter: 10,
      notice: 60,
      horizon: 30,
    },
    {
      name: 'Group workshop',
      slug: 'workshop',
      duration: 60,
      capacity: 4,
      bufferBefore: 0,
      bufferAfter: 0,
      notice: 240,
      horizon: 21,
    },
  ];
  for (const event of events) {
    await pool.query(
      `INSERT INTO event_types (
         host_id, name, slug, duration_min, capacity, buffer_before_min, buffer_after_min, min_notice_min, horizon_days
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (host_id, slug) DO NOTHING`,
      [
        hostId,
        event.name,
        event.slug,
        event.duration,
        event.capacity,
        event.bufferBefore,
        event.bufferAfter,
        event.notice,
        event.horizon,
      ],
    );
  }

  const rules = await rows(pool, 'SELECT id FROM availability_rules WHERE host_id = $1 LIMIT 1', [hostId]);
  if (rules.length === 0) {
    for (const day of [1, 2, 3, 4, 5]) {
      await pool.query(
        `INSERT INTO availability_rules (host_id, day_of_week, start_min, end_min) VALUES ($1, $2, 540, 720)`,
        [hostId, day],
      );
      await pool.query(
        `INSERT INTO availability_rules (host_id, day_of_week, start_min, end_min) VALUES ($1, $2, 780, 1020)`,
        [hostId, day],
      );
    }
    console.log('seeded Mon–Fri 09:00–12:00 and 13:00–17:00 Asia/Kolkata');
  }
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  seed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
