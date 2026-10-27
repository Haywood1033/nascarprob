// lib/store.js — race history, the model's backbone. One row per driver per completed Cup race:
// the result, loop data and green-flag pace together, plus practice/qualifying runs. With
// DATABASE_URL the rows persist (backfilled by /api/sync); without it the most recent races are
// fetched live into memory so the app still works, just with a shorter history.

const db = require('./db');
const { fetchSchedule, fetchWeekend, fetchLoop, fetchLapPace } = require('./nascar');
const { mapLimit } = require('./http');

const FIRST_SEASON = 2022;         // the Next Gen car: one car, so history pools cleanly
const MEMORY_RACES = 40;
const HOUR = 3600 * 1000;

// Combine one race's feeds into driver rows. Loop data and lap times are optional (older or
// missing feeds): their columns are simply null and the ratings fall back to finish/position.
function raceRows(race, weekend, loop = [], pace = []) {
  const loopBy = new Map(loop.map(l => [l.driverId, l]));
  const paceBy = new Map(pace.map(p => [p.driverId, p]));
  const stagePts = new Map();
  for (const s of weekend.stageResults || []) s.order.slice(0, 10).forEach((id, i) => stagePts.set(id, (stagePts.get(id) || 0) + (10 - i)));
  const field = weekend.results.length;
  return weekend.results.filter(r => r.finish).map(r => {
    const l = loopBy.get(r.driverId) || {}, p = paceBy.get(r.driverId) || {};
    return {
      raceId: race.id, season: race.season, date: race.date, trackKey: race.track.key, trackType: race.track.type,
      laps: race.laps, field, cautions: weekend.cautions,
      driverId: r.driverId, name: r.name, car: r.car, team: r.team, make: r.make,
      start: r.start, finish: r.finish, lapsCompleted: r.lapsCompleted, lapsLed: r.lapsLed || l.ledLaps || 0,
      status: r.status, running: r.running, stagePoints: stagePts.get(r.driverId) || 0,
      rating: l.rating ?? null, avgPos: l.avgPos ?? null, fastLaps: l.fastLaps ?? null, qualityPasses: l.qualityPasses ?? null,
      pacePctOff: p.pctOff ?? null, greenLaps: p.greenLaps ?? null,
    };
  });
}

function weekendRows(race, weekend) {
  const out = [];
  for (const run of weekend.runs) {
    if (run.kind !== 'practice' && run.kind !== 'qualifying') continue;
    for (const x of run.results) {
      // Several practice sessions: keep the fastest (lowest position) per driver.
      const prev = out.find(o => o.driverId === x.driverId && o.kind === run.kind);
      if (prev && prev.pos <= (x.pos || 99)) continue;
      if (prev) out.splice(out.indexOf(prev), 1);
      out.push({ raceId: race.id, driverId: x.driverId, kind: run.kind, runName: run.name, pos: x.pos, bestSpeed: x.bestSpeed, avg10: x.avg10 });
    }
  }
  return out;
}

async function fetchRaceBundle(race) {
  const weekend = await fetchWeekend(race.season, race.id);
  const [loop, pace] = await Promise.all([
    fetchLoop(race.season, race.id).catch(() => []),
    fetchLapPace(race.season, race.id).catch(() => []),
  ]);
  return { weekend, rows: raceRows(race, weekend, loop, pace), weekendRows: weekendRows(race, weekend), loopCount: loop.length, paceCount: pace.length };
}

async function upsert(table, cols, rows, conflict, update) {
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150), vals = [], params = [];
    chunk.forEach((r, j) => { vals.push(`(${cols.map((_, k) => `$${j * cols.length + k + 1}`).join(',')})`); params.push(...r); });
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')} ON CONFLICT (${conflict}) DO UPDATE SET ${update}`, params);
  }
}

async function saveRace(race, bundle) {
  await db.ensureTables();
  await db.query(
    `INSERT INTO nascar_races (race_id, season, name, track_key, track_name, track_type, race_date, laps, stage_laps, cautions, exhibition, completed, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (race_id) DO UPDATE SET completed=EXCLUDED.completed, cautions=EXCLUDED.cautions, synced_at=NOW()`,
    [race.id, race.season, race.name, race.track.key, race.trackName || race.track.name, race.track.type, race.date, race.laps, JSON.stringify(race.stageLaps), bundle.weekend.cautions, !!race.exhibition, bundle.weekend.complete]
  );
  if (bundle.rows.length) {
    await upsert('nascar_results',
      ['race_id', 'driver_id', 'driver_name', 'car', 'team', 'make', 'start_pos', 'finish_pos', 'laps_completed', 'laps_led', 'status', 'running', 'stage_points', 'rating', 'avg_pos', 'fast_laps', 'quality_passes', 'pace_pct_off', 'green_laps'],
      bundle.rows.map(r => [r.raceId, r.driverId, r.name, r.car, r.team, r.make, r.start, r.finish, r.lapsCompleted, r.lapsLed, r.status, r.running, r.stagePoints, r.rating, r.avgPos, r.fastLaps, r.qualityPasses, r.pacePctOff, r.greenLaps]),
      'race_id, driver_id', 'finish_pos=EXCLUDED.finish_pos, laps_led=EXCLUDED.laps_led, status=EXCLUDED.status, rating=EXCLUDED.rating, avg_pos=EXCLUDED.avg_pos, pace_pct_off=EXCLUDED.pace_pct_off');
  }
  if (bundle.weekendRows.length) {
    await upsert('nascar_weekend', ['race_id', 'driver_id', 'kind', 'run_name', 'pos', 'best_speed', 'avg10'],
      bundle.weekendRows.map(r => [r.raceId, r.driverId, r.kind, r.runName, r.pos, r.bestSpeed, r.avg10]),
      'race_id, driver_id, kind', 'pos=EXCLUDED.pos, best_speed=EXCLUDED.best_speed, avg10=EXCLUDED.avg10');
  }
}

// Sync completed races for one season that the DB doesn't already have. Stops before the
// serverless deadline and reports what's left, so repeated calls finish a backfill.
async function syncSeason(season, { maxRaces = 14, deadline = Date.now() + 45000 } = {}) {
  await db.ensureTables();
  const schedule = await fetchSchedule(season);
  const done = await db.query(`SELECT race_id FROM nascar_races WHERE completed=TRUE`);
  const have = new Set(done.rows.map(r => r.race_id));
  const now = Date.now();
  const todo = schedule.filter(r => !have.has(r.id) && new Date(r.date).getTime() + 6 * HOUR < now);
  const synced = [], failed = [];
  for (const race of todo.slice(0, maxRaces)) {
    if (Date.now() > deadline) break;
    try {
      const bundle = await fetchRaceBundle(race);
      await saveRace(race, bundle);
      synced.push({ id: race.id, name: race.name, drivers: bundle.rows.length, loop: bundle.loopCount, pace: bundle.paceCount, complete: bundle.weekend.complete });
    } catch (err) {
      failed.push({ id: race.id, name: race.name, error: err.message });
    }
  }
  return { season, scheduleRaces: schedule.length, alreadyStored: have.size, synced, failed, remaining: Math.max(0, todo.length - synced.length - failed.length) };
}

function rowFromDb(r) {
  return {
    raceId: r.race_id, season: r.season, date: new Date(r.race_date).toISOString(), trackKey: r.track_key, trackType: r.track_type,
    laps: r.laps, field: Number(r.field), cautions: r.cautions,
    driverId: r.driver_id, name: r.driver_name, car: r.car, team: r.team, make: r.make,
    start: r.start_pos, finish: r.finish_pos, lapsCompleted: r.laps_completed, lapsLed: r.laps_led, status: r.status, running: r.running,
    stagePoints: r.stage_points, rating: r.rating, avgPos: r.avg_pos, fastLaps: r.fast_laps, qualityPasses: r.quality_passes,
    pacePctOff: r.pace_pct_off, greenLaps: r.green_laps,
  };
}

let memory = null; // { at, rows, weekend }

async function loadFromFeeds() {
  const year = new Date().getUTCFullYear(), now = Date.now();
  const scheds = await Promise.all([year, year - 1].map(y => fetchSchedule(y).catch(() => [])));
  const races = scheds.flat().filter(r => !r.exhibition && new Date(r.date).getTime() + 6 * HOUR < now)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, MEMORY_RACES);
  const bundles = await mapLimit(races, 6, r => fetchRaceBundle(r).catch(() => null));
  return { rows: bundles.flatMap(b => (b ? b.rows : [])), weekend: bundles.flatMap(b => (b ? b.weekendRows : [])) };
}

// Every stored driver-race strictly before `before` — `before` is what keeps a backtest
// leak-free: a race's own result is never visible to its own projection.
async function loadHistory({ before = new Date() } = {}) {
  const beforeIso = new Date(before).toISOString();
  if (db.hasDb) {
    await db.ensureTables();
    const res = await db.query(
      `SELECT r.*, x.season, x.race_date, x.track_key, x.track_type, x.laps, x.cautions,
              COUNT(*) OVER (PARTITION BY r.race_id) AS field
       FROM nascar_results r JOIN nascar_races x ON x.race_id = r.race_id
       WHERE x.completed AND NOT x.exhibition AND x.race_date < $1 AND x.season >= $2`, [beforeIso, FIRST_SEASON]);
    const wk = await db.query(
      `SELECT w.race_id, w.driver_id, w.kind, w.pos, w.best_speed, w.avg10 FROM nascar_weekend w
       JOIN nascar_races x ON x.race_id = w.race_id WHERE x.race_date < $1`, [beforeIso]);
    return {
      rows: res.rows.map(rowFromDb),
      weekend: wk.rows.map(w => ({ raceId: w.race_id, driverId: w.driver_id, kind: w.kind, pos: w.pos, bestSpeed: w.best_speed, avg10: w.avg10 })),
      source: 'database',
    };
  }
  if (!memory || Date.now() - memory.at > 6 * HOUR) memory = { at: Date.now(), ...(await loadFromFeeds()) };
  const raceIds = new Set(memory.rows.filter(r => r.date < beforeIso).map(r => r.raceId));
  return { rows: memory.rows.filter(r => raceIds.has(r.raceId)), weekend: memory.weekend.filter(w => raceIds.has(w.raceId)), source: 'live-feeds' };
}

async function dataStatus() {
  if (!db.hasDb) return { source: 'live-feeds', note: `No DATABASE_URL set — history is the last ${MEMORY_RACES} races fetched live. Add a database and run /api/sync for the full history since ${FIRST_SEASON}.` };
  await db.ensureTables();
  const seasons = await db.query(`SELECT season, COUNT(*)::int AS races, SUM(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completed FROM nascar_races GROUP BY 1 ORDER BY 1`);
  const totals = await db.query(`SELECT COUNT(*)::int AS driver_races, COUNT(DISTINCT driver_id)::int AS drivers,
    SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END)::int AS with_loop, SUM(CASE WHEN pace_pct_off IS NOT NULL THEN 1 ELSE 0 END)::int AS with_pace FROM nascar_results`);
  return { source: 'database', seasons: seasons.rows, totals: totals.rows[0] };
}

async function saveSnapshot(race, payload) {
  if (!db.hasDb) return false;
  await db.ensureTables();
  // Overwritten on every pre-race load; only called while the race is 'pre', so the row ends
  // up holding the last projection before the green flag.
  const res = await db.query(
    `INSERT INTO nascar_snapshots (race_id, season, name, race_date, payload) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (race_id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW(), graded = NULL, graded_at = NULL`,
    [race.id, race.season, race.name, race.date, JSON.stringify(payload)]);
  return res.rowCount > 0;
}

// Save and report: { saved, at } or { saved: false, reason } — never throws, never hangs.
async function saveSnapshotSafely(race, payload) {
  if (!db.hasDb) return { saved: false, reason: `no database connected (set ${db.DB_VARS[0]})` };
  try { await db.withTimeout(saveSnapshot(race, payload), 8000); return { saved: true, at: new Date().toISOString() }; }
  catch (err) { console.error('snapshot save failed', err); return { saved: false, reason: err.message }; }
}

// What the Accuracy tab shows about storage: connected or not, and the latest saved projection.
async function snapshotStatus() {
  if (!db.hasDb) return { connected: false, note: `No database connected, so pre-race projections aren't being saved. Set ${db.DB_VARS[0]} (or ${db.DB_VARS[1]}) to a Postgres connection string.` };
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT COUNT(*)::int AS saved, COUNT(graded)::int AS graded FROM nascar_snapshots`), 8000);
    const last = await db.query(`SELECT name, saved_at FROM nascar_snapshots ORDER BY saved_at DESC LIMIT 1`);
    const races = await db.query(`SELECT COUNT(*)::int AS n FROM nascar_races WHERE completed`);
    return { connected: true, variable: db.dbVar, saved: r.rows[0].saved, graded: r.rows[0].graded, racesSynced: races.rows[0].n, last: last.rows[0] ? { name: last.rows[0].name, savedAt: last.rows[0].saved_at } : null };
  } catch (err) { return { connected: false, variable: db.dbVar, error: err.message, note: `${db.dbVar} is set but the database didn't answer: ${err.message}` }; }
}

module.exports = { FIRST_SEASON, raceRows, weekendRows, fetchRaceBundle, syncSeason, loadHistory, dataStatus, saveSnapshot, saveSnapshotSafely, snapshotStatus };
