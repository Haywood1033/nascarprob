// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// store fetches recent history live from NASCAR's feeds, so the app runs before a DB exists.
// Connection string: DATABASE_URL, or the POSTGRES_URL that Vercel's Supabase (and Neon)
// integrations set. sslmode is stripped from the URL: recent pg versions read sslmode=require as
// full certificate verification, which Supabase's pooler fails; TLS stays on via `ssl` below.
const DB_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'SUPABASE_DB_URL'];
const dbVar = DB_VARS.find(k => process.env[k]) || null;
const hasDb = !!dbVar;
// sslmode=disable is honoured (a local database without TLS); anything else connects over TLS.
const sslOff = () => { try { return new URL(process.env[dbVar]).searchParams.get('sslmode') === 'disable'; } catch { return false; } };
function connectionString() {
  try {
    const u = new URL(process.env[dbVar]);
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return process.env[dbVar]; }
}
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: connectionString(), ssl: sslOff() ? false : { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 8000 });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// One row per driver per race carries the result, the loop data and the green-flag pace
// summary together (they always arrive together and are always read together). Practice and
// qualifying sit in their own table because they exist before a race has results.
const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS nascar_races (
    race_id     VARCHAR(16) PRIMARY KEY,
    season      SMALLINT    NOT NULL,
    name        TEXT,
    track_key   TEXT,
    track_name  TEXT,
    track_type  VARCHAR(20),
    race_date   TIMESTAMPTZ,
    laps        SMALLINT,
    stage_laps  JSONB,
    cautions    SMALLINT,
    exhibition  BOOLEAN DEFAULT FALSE,
    completed   BOOLEAN DEFAULT FALSE,
    synced_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS nascar_results (
    race_id        VARCHAR(16) NOT NULL,
    driver_id      VARCHAR(16) NOT NULL,
    driver_name    TEXT,
    car            VARCHAR(4),
    team           TEXT,
    make           TEXT,
    start_pos      SMALLINT,
    finish_pos     SMALLINT,
    laps_completed SMALLINT,
    laps_led       SMALLINT,
    status         TEXT,
    running        BOOLEAN,
    stage_points   SMALLINT,
    rating         REAL,
    avg_pos        REAL,
    fast_laps      SMALLINT,
    quality_passes SMALLINT,
    pace_pct_off   REAL,
    green_laps     SMALLINT,
    PRIMARY KEY (race_id, driver_id)
  );
  CREATE INDEX IF NOT EXISTS nascar_results_driver ON nascar_results (driver_id);
  CREATE TABLE IF NOT EXISTS nascar_weekend (
    race_id     VARCHAR(16) NOT NULL,
    driver_id   VARCHAR(16) NOT NULL,
    kind        VARCHAR(12) NOT NULL,
    run_name    TEXT,
    pos         SMALLINT,
    best_speed  REAL,
    avg10       REAL,
    PRIMARY KEY (race_id, driver_id, kind)
  );
  CREATE TABLE IF NOT EXISTS nascar_snapshots (
    race_id     VARCHAR(16) PRIMARY KEY,
    season      SMALLINT,
    name        TEXT,
    race_date   TIMESTAMPTZ,
    saved_at    TIMESTAMP DEFAULT NOW(),
    payload     JSONB,
    graded      JSONB,
    graded_at   TIMESTAMP
  );
`;

let ensured = false;
async function ensureTables() {
  if (!hasDb || ensured) return;
  await query(ENSURE_SQL);
  ensured = true;
}

// Resolves with fn's result, or rejects after ms — so a slow database can't hang a page load.
function withTimeout(promise, ms, what = 'database') {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { hasDb, dbVar, DB_VARS, query, ensureTables, withTimeout };
