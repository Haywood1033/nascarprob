// lib/backtest.js — leak-free backtest over completed races. For each race the ratings use only
// races dated before it (rateField's atIdx), the calibration is refit only on earlier races
// (every REFIT races), and the race is simulated from its own qualifying and practice — both
// known before the green flag — with no knowledge of its result. The probabilities are graded
// against what happened.
//
// Scores: Brier and log loss per market against two baselines — no skill (every car gets the
// base rate, 10/field for top 10) and qualifying order alone (the same simulator with every
// rating set to zero) — plus calibration buckets: when the model says 30%, does it happen ~30%?
// Weather is not applied (rain-shortened races are graded as run).

const { loadHistory } = require('./store');
const { prepare, rateField, calibrate } = require('./ratings');
const { simulateRace, summarize } = require('./simulator');
const { hashSeed } = require('./rng');

const MARKETS = [
  { key: 'win', label: 'Win', n: 1 },
  { key: 'top5', label: 'Top 5', n: 5 },
  { key: 'top10', label: 'Top 10', n: 10 },
];
const BINS = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1.0001];
const REFIT = 10;
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));

function score(rows, key) {
  const r = rows.filter(x => x.market === key);
  if (!r.length) return null;
  const brier = p => r.reduce((s, x) => s + (p(x) - x.hit) ** 2, 0) / r.length;
  const ll = p => -r.reduce((s, x) => s + (x.hit ? Math.log(clip(p(x))) : Math.log(1 - clip(p(x)))), 0) / r.length;
  const m = { brier: brier(x => x.model), logLoss: ll(x => x.model) };
  const b = { brier: brier(x => x.base), logLoss: ll(x => x.base) };
  const q = { brier: brier(x => x.qual), logLoss: ll(x => x.qual) };
  return {
    n: r.length,
    model: m, baseline: b, qualifyingOnly: q,
    skillVsBaseline: +(1 - m.brier / b.brier).toFixed(4),
    skillVsQualifying: +(1 - m.brier / q.brier).toFixed(4),
    calibration: BINS.slice(0, -1).map((lo, i) => {
      const inBin = r.filter(x => x.model >= lo && x.model < BINS[i + 1]);
      return { lo, hi: Math.min(1, BINS[i + 1]), n: inBin.length, predicted: inBin.length ? inBin.reduce((s, x) => s + x.model, 0) / inBin.length : null, actual: inBin.length ? inBin.reduce((s, x) => s + x.hit, 0) / inBin.length : null };
    }),
  };
}

async function runBacktest({ races = 30, sims = 3000, warmup = 15, deadline = Date.now() + 50000, history = null } = {}) {
  const hist = history || await loadHistory({ before: new Date() });
  const prep = prepare(hist.rows, hist.weekend);
  const targets = prep.races.filter(r => r.idx >= warmup).slice(-races);
  const rows = [], perRace = [], byType = {};
  let params = null, fittedAt = -1, stoppedEarly = false;
  for (const race of targets) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    if (!params || race.idx - fittedAt >= REFIT) {
      params = calibrate({ races: prep.races.slice(0, race.idx), byDriver: prep.byDriver });
      fittedAt = race.idx;
    }
    const field = race.rows;
    const N = field.length;
    const ratings = rateField(prep, field.map(r => r.driverId), race.idx, race.type);
    const drivers = field.map(r => ({ id: r.driverId, mu: ratings.get(r.driverId).mu, start: r.start || null, qualZ: r.qualZ, pracZ: r.pracZ }));
    const known = drivers.every(d => d.start);
    const run = ds => summarize(simulateRace({ drivers: ds.map(d => ({ ...d, start: known ? d.start : null })), type: race.type, laps: race.laps || 300, params, sims, seed: hashSeed(race.raceId) }));
    const model = new Map(run(drivers).drivers.map(d => [d.id, d]));
    const qual = new Map(run(drivers.map(d => ({ ...d, mu: 0 }))).drivers.map(d => [d.id, d]));
    let raceLL = 0;
    for (const r of field) {
      for (const m of MARKETS) {
        const hit = r.finish <= m.n ? 1 : 0;
        const row = { market: m.key, hit, model: model.get(r.driverId)[m.key], qual: qual.get(r.driverId)[m.key], base: m.n / N, type: race.type };
        rows.push(row); (byType[race.type] ||= []).push(row);
        if (m.key === 'win' && hit) raceLL = -Math.log(clip(row.model));
      }
    }
    const winner = field.find(r => r.finish === 1);
    const top = [...model.values()].sort((a, b) => b.win - a.win)[0];
    perRace.push({ raceId: race.raceId, date: race.date, track: race.trackKey, type: race.type, field: N,
      winner: winner ? { id: winner.driverId, name: winner.name, modelWin: model.get(winner.driverId).win, rank: [...model.values()].sort((a, b) => b.win - a.win).findIndex(x => x.id === winner.driverId) + 1 } : null,
      favourite: { id: top.id, name: field.find(r => r.driverId === top.id)?.name, win: top.win, finish: field.find(r => r.driverId === top.id)?.finish },
      winnerLogLoss: +raceLL.toFixed(3) });
  }
  return {
    generatedAt: new Date().toISOString(), source: hist.source, racesScored: perRace.length, sims, stoppedEarly,
    markets: Object.fromEntries(MARKETS.map(m => [m.key, { label: m.label, ...score(rows, m.key) }])),
    byType: Object.fromEntries(Object.entries(byType).map(([t, r]) => [t, { races: perRace.filter(x => x.type === t).length, top10: score(r, 'top10') && { skillVsBaseline: score(r, 'top10').skillVsBaseline, skillVsQualifying: score(r, 'top10').skillVsQualifying } }])),
    races: perRace.reverse(),
  };
}

module.exports = { runBacktest, score, MARKETS };
