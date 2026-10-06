// Creates the tables from db/schema.sql. Used by `npm run migrate` and the tests.
import { readFile } from 'node:fs/promises';

export async function migrate(pool) {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
