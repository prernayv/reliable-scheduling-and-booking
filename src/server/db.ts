import pg from 'pg';
import { ApiError, isPgError } from './errors.js';

export type Db = {
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
};

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    pool = new pg.Pool({
      connectionString,
      max: 10,
      application_name: 'slotbook',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function rows<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const found = await rows<T>(db, text, params);
  return found[0] ?? null;
}

export async function withTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already closed */
    }
    if (err instanceof ApiError) throw err;
    if (isPgError(err) && err.code === 'P0001') {
      throw new ApiError(409, 'capacity_exceeded', 'That time was just taken');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function dbNow(db: Db): Promise<Date> {
  const row = await one<{ now: Date }>(db, 'SELECT now() AS now');
  if (!row) throw new Error('database clock unavailable');
  return row.now;
}

/** Wait until Postgres accepts connections. Used by migrate on container start. */
export async function waitForDatabase(): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await getPool().query('SELECT 1');
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last instanceof Error ? last : new Error('Could not connect to Postgres');
}
