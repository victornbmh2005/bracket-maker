// Creates the tables from db/schema.sql. Usage: npm run migrate
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';

const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');

try {
  await pool.query(sql);
  console.log('Database schema is up to date.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
