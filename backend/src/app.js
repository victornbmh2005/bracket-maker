// Builds the Express app. server.js starts it; tests start it on a random port.
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import openapi from './openapi.js';
import { pool } from './db.js';
import { HttpError } from './validate.js';
import tournaments from './routes/tournaments.js';
import participants from './routes/participants.js';
import runs from './routes/runs.js';

export const app = express();

// Only these websites may call the API from a browser.
export const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins }));

// Big enough to import a tournament full of uploaded images.
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.redirect('/api/docs'));

// Swagger UI: try every endpoint from the browser
app.get('/api/openapi.json', (req, res) => res.json(openapi));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Bracket Maker API' }));

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/tournaments', tournaments);
app.use('/api/participants', participants);
app.use('/api/runs', runs);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Turns thrown errors into JSON responses.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});
