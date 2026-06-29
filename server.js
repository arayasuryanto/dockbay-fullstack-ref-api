// Dockbay full-stack reference backend.
// Proves the Dockbay managed-database -> DATABASE_URL auto-injection path:
//   - reads DATABASE_URL from the environment (injected by Dockbay)
//   - connects to the bay-internal managed Postgres
//   - ensures an `items` table + a seed row on boot
//   - GET /          -> 200 (used by Dockbay's Traefik health check)
//   - GET /health    -> 200 { db: "ok" } once the DB is reachable
//   - GET /api/items -> the rows from Postgres
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || '';

// Allow the static frontend (different subdomain) to fetch us.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

let pool = null;
let dbReady = false;
let dbError = null;

if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
}

async function initDb() {
  if (!pool) {
    dbError = 'DATABASE_URL not set';
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM items');
  if (rows[0].n === 0) {
    await pool.query(
      'INSERT INTO items (name) VALUES ($1), ($2), ($3)',
      ['Dockbay managed Postgres works', 'DATABASE_URL was auto-injected', 'Full-stack reference bay']
    );
  }
  dbReady = true;
  dbError = null;
}

// Root: health-check target for Traefik (must be 2xx/3xx for the deploy to go live).
app.get('/', (req, res) => {
  res.json({
    service: 'dockbay-fullstack-ref-api',
    db: dbReady ? 'ok' : 'pending',
    hasDatabaseUrl: Boolean(DATABASE_URL),
    pushTest: 'webhook-confirmed',
  });
});

// Liveness of the DB connection specifically.
app.get('/health', async (req, res) => {
  if (!pool) return res.status(503).json({ db: 'no-url', error: dbError });
  try {
    await pool.query('SELECT 1');
    return res.json({ db: 'ok' });
  } catch (err) {
    return res.status(503).json({ db: 'error', error: String(err.message || err) });
  }
});

app.get('/api/items', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_URL not set' });
  try {
    const { rows } = await pool.query('SELECT id, name, created FROM items ORDER BY id');
    return res.json({ items: rows });
  } catch (err) {
    return res.status(503).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}; DATABASE_URL ${DATABASE_URL ? 'present' : 'MISSING'}`);
  // Retry init: the managed Postgres may take a moment to accept connections.
  let tries = 0;
  const attempt = () => {
    initDb()
      .then(() => console.log('db init ok'))
      .catch((err) => {
        tries += 1;
        console.error(`db init failed (try ${tries}): ${err.message}`);
        if (tries < 30) setTimeout(attempt, 2000);
      });
  };
  attempt();
});
