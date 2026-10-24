// lib/dfs.js — fantasy projections from the race simulation, for the Classic format: 6 drivers,
// $50,000 cap. Points per driver per run use lib/simulator's scoring (finish points, ±1 per
// place gained or lost from the start, 0.25 per lap led, 0.45 per fastest lap), so a projection
// is consistent with the same driver's finishing odds. The split shows where the points come
// from: in this format a fast car starting deep (place differential) is often the best value.
//
// Salaries come from the site's CSV export (Position, Name + ID, Name, ID, Roster Position,
// Salary, ...); names are matched to the field leniently.

const { buildMatcher } = require('./names');
const { finishPoints, dfsPoints } = require('./simulator');

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseSalaries(text, players) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { rows: [], unmatched: [], error: 'Empty file' };
  const head = parseCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const iName = col(['name']), iSal = col(['salary']), iId = col(['id']);
  if (iName < 0 || iSal < 0) return { rows: [], unmatched: [], error: 'Expected a CSV with Name and Salary columns (the site\'s salary export).' };
  const match = buildMatcher(players);
  const rows = [], unmatched = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const salary = Number(String(c[iSal] || '').replace(/[$,]/g, ''));
    if (!c[iName] || !salary) continue;
    const p = match(c[iName]);
    if (!p) { unmatched.push(c[iName]); continue; }
    rows.push({ id: p.id, siteId: iId >= 0 ? c[iId] : null, name: p.name, salary });
  }
  return { rows, unmatched };
}

// Who leads the most laps in each run (ties to the first found): the "dominator" of that race.
function mostLedShares(sim) {
  const S = sim.sims, P = sim.players, out = new Float64Array(P);
  for (let k = 0; k < S; k++) {
    let best = -1, bi = 0;
    for (let i = 0; i < P; i++) { const v = sim.lapsLed[k + i * S]; if (v > best) { best = v; bi = i; } }
    out[bi]++;
  }
  return out.map(v => v / S);
}

// A sample of every driver's fantasy points race by race, for the browser to score whole
// lineups (points × 10 as Int16, driver-major, base64). 2,000 evenly spaced runs of 15,000.
function simSample(sim, ids, n = 2000) {
  const S = sim.sims, step = Math.max(1, Math.floor(S / n)), m = Math.min(n, Math.floor(S / step));
  const data = new Int16Array(ids.length * m);
  ids.forEach((id, r) => { const i = sim.index.get(id); for (let j = 0; j < m; j++) data[r * m + j] = Math.round(dfsPoints(sim, i, j * step) * 10); });
  return { n: m, ids, data: Buffer.from(data.buffer).toString('base64') };
}

function projections(sim, payload, salaries) {
  const S = sim.sims;
  const mostLed = mostLedShares(sim);
  const salBy = new Map((salaries || []).map(r => [r.id, r]));
  return payload.players.filter(p => sim.index.has(p.id)).map(p => {
    const i = sim.index.get(p.id);
    let fin = 0, diff = 0, led = 0, fast = 0;
    const pts = new Float32Array(S);
    for (let k = 0; k < S; k++) {
      const f = sim.finishPos[k + i * S], st = sim.startPos[k + i * S];
      fin += finishPoints(f); diff += st - f; led += 0.25 * sim.lapsLed[k + i * S]; fast += 0.45 * sim.fastLaps[k + i * S];
      pts[k] = dfsPoints(sim, i, k);
    }
    const sorted = Float32Array.from(pts).sort(), q = x => +sorted[Math.min(S - 1, Math.floor(x * S))].toFixed(1);
    const mean = (fin + diff + led + fast) / S, sal = salBy.get(p.id);
    return {
      id: p.id, name: p.name, car: p.car, start: p.start, avgStart: p.avgStart, avgFinish: p.avgFinish,
      salary: sal?.salary || null, siteId: sal?.siteId || null,
      points: +mean.toFixed(2), p10: q(0.1), p50: q(0.5), p90: q(0.9),
      split: { finish: +(fin / S).toFixed(1), placeDiff: +(diff / S).toFixed(1), lapsLed: +(led / S).toFixed(1), fastLaps: +(fast / S).toFixed(1) },
      value: sal ? +((mean / sal.salary) * 1000).toFixed(2) : null,
      domPts: +((led + fast) / S).toFixed(1), mostLed: +mostLed[i].toFixed(4),
    };
  }).sort((a, b) => b.points - a.points);
}

module.exports = { parseSalaries, projections, simSample, mostLedShares, parseCsvLine };
