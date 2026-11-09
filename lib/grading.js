// lib/grading.js — grades each saved pre-race snapshot (the last projection before the green
// flag) against the result once the race is synced. Nothing from after the green flag ever
// touches a snapshot, so the Accuracy tab is an honest out-of-sample record.

const db = require('./db');
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));

function gradeOne(payload, results) {
  const fin = new Map(results.map(r => [r.driver_id, r.finish_pos]));
  const ps = payload.players.filter(p => p.odds && fin.has(p.id));
  if (ps.length < 20) return null;
  const n = ps.length;
  const markets = { win: 1, top5: 5, top10: 10 };
  const out = { drivers: n, markets: {} };
  for (const [k, N] of Object.entries(markets)) {
    let b = 0, bb = 0, ll = 0;
    for (const p of ps) { const hit = fin.get(p.id) <= N ? 1 : 0, q = p.odds[k]; b += (q - hit) ** 2; bb += (N / n - hit) ** 2; ll -= hit ? Math.log(clip(q)) : Math.log(1 - clip(q)); }
    out.markets[k] = { brier: +(b / n).toFixed(5), baseline: +(bb / n).toFixed(5), skill: +(1 - b / bb).toFixed(4), logLoss: +(ll / n).toFixed(4) };
  }
  const byWin = [...ps].sort((a, b) => b.odds.win - a.odds.win);
  const w = ps.find(p => fin.get(p.id) === 1);
  out.winner = w ? { id: w.id, name: w.name, modelWin: w.odds.win, modelRank: byWin.indexOf(w) + 1 } : null;
  out.favorite = { id: byWin[0].id, name: byWin[0].name, win: byWin[0].odds.win, finish: fin.get(byWin[0].id) };
  return out;
}

async function gradeAll({ deadline = Date.now() + 20000 } = {}) {
  if (!db.hasDb) return { newlyGraded: [], note: 'No database: grading needs saved snapshots.' };
  await db.ensureTables();
  const todo = await db.query(`SELECT s.race_id, s.payload FROM nascar_snapshots s JOIN nascar_races r ON r.race_id = s.race_id WHERE r.completed AND s.graded IS NULL`);
  const newly = [];
  for (const row of todo.rows) {
    if (Date.now() > deadline) break;
    const res = await db.query(`SELECT driver_id, finish_pos FROM nascar_results WHERE race_id=$1`, [row.race_id]);
    const g = gradeOne(row.payload, res.rows);
    if (!g) continue;
    await db.query(`UPDATE nascar_snapshots SET graded=$2, graded_at=NOW() WHERE race_id=$1`, [row.race_id, JSON.stringify(g)]);
    newly.push(row.race_id);
  }
  return { newlyGraded: newly };
}

// The graded record is read straight from the database (with a retry for a cold connection) and is
// never hidden by the storage status line: a slow status check can only add a warning, not blank the
// record. New results are graded first only within a short budget, so the page isn't held up.
async function listGrades() {
  const store = require('./store');
  if (!db.hasDb) { const storage = await store.snapshotStatus(); return { races: [], totals: null, storage, note: storage.note }; }
  await gradeAll({ deadline: Date.now() + 4000 }).catch(() => {});
  const q = ms => db.withTimeout(db.query(`SELECT race_id, name, race_date, saved_at, graded FROM nascar_snapshots WHERE graded IS NOT NULL ORDER BY race_date DESC LIMIT 60`), ms);
  const [r, storage] = await Promise.all([q(10000).catch(() => q(15000)).catch(err => ({ error: err.message })), store.snapshotStatus()]);
  if (r.error) return { races: [], totals: null, storage: { ...storage, connected: false, variable: db.dbVar, error: r.error }, note: r.error };
  // Rows graded before the spelling change stored the field as `favourite`; read either.
  const races = r.rows.map(x => { const { favourite, ...g } = x.graded || {}; return { raceId: x.race_id, name: x.name, date: x.race_date, savedAt: x.saved_at, ...g, favorite: g.favorite || favourite }; });
  const avg = k => (races.length ? races.reduce((s, x) => s + x.markets[k].skill, 0) / races.length : null);
  return { storage, races, totals: races.length ? { races: races.length, skill: { win: avg('win'), top5: avg('top5'), top10: avg('top10') }, winnerInModelTop5: races.filter(x => x.winner && x.winner.modelRank <= 5).length } : null };
}

module.exports = { gradeOne, gradeAll, listGrades };
