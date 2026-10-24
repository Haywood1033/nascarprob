// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// store fetches recent history live from NASCAR's feeds, so the app runs before a DB exists.
const hasDb = !!process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
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

module.exports = { hasDb, query, ensureTables };
