// Runs the SQL files in db/migrations/ in order, each one only once.
// Applied files are recorded in the schema_migrations table.
// Used by `npm run migrate` and the tests.
import { readdir, readFile } from 'node:fs/promises';

const DIR = new URL('../db/migrations/', import.meta.url);
const LOCK_ID = 7_310_001;   // any fixed number; stops two processes migrating at once

// Everything happens in ONE transaction with a transaction-level lock.
// (Neon's connection pooler hands out a different connection per
// transaction, so session-level locks could get stuck.)
export async function migrate(pool, log = () => {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map(r => r.name));

    const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, DIR), 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        throw new Error(`${file}: ${err.message}`);
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
    await client.query('COMMIT');
    applied.forEach(file => log(`Applied ${file}`));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
