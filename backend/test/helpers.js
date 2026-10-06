// Starts the API against the TEST database (a Neon branch), never the real one.
import { once } from 'node:events';

export async function startApi() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Add your Neon "test" branch connection string to backend/.env');
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must point to a different database (the Neon test branch), not the live one');
  }
  // db.js reads DATABASE_URL when it's first imported, so set it before importing the app.
  process.env.DATABASE_URL = testUrl;
  const { pool } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { app } = await import('../src/app.js');
  await migrate(pool);

  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}/api`;

  // call('POST', '/tournaments', {name}) → {status, data, headers}
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
  }

  async function stop() {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }

  return { call, stop };
}

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';
