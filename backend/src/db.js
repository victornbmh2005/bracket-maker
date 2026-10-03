import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy backend/.env.example to backend/.env and fill it in.');
}

// The Neon connection string already includes sslmode=require.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// Neon closes idle connections; log it instead of crashing the server.
pool.on('error', err => console.error('Database connection error:', err.message));

// Runs fn(client) inside BEGIN/COMMIT, rolling back if it throws.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
