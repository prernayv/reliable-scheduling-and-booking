import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool, waitForDatabase } from '../server/db.js';
import { loadEnv } from '../server/env.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'sql');

export async function migrate(): Promise<void> {
  loadEnv();
  await waitForDatabase();
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
  const done = new Set(applied.rows.map((row) => row.id));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

const isDirect = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  migrate()
    .then(async () => {
      const { closePool } = await import('../server/db.js');
      await closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
