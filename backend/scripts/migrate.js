// Applies new files from db/migrations/. Usage: npm run migrate
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

try {
  await migrate(pool, console.log);
  console.log('Database schema is up to date.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
