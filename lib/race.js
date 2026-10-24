// lib/race.js — assembles one race: which race, the field, ratings, this weekend's practice and
// qualifying, weather, the simulation and every per-driver number the tabs show. The result is
// cached per race for a few minutes so the products (odds, matchups, parlays, DFS, plays) all
// price from the same simulation.

const { fetchSchedule, fetchWeekend, fetchLive } = require('./nascar');
const { loadHistory, saveSnapshot } = require('./store');
const { prepare, rateDriver, rankZ, calibrate } = require('./ratings');
const { simulateRace, summarize, finishDistribution } = require('./simulator');
const { raceWeather } = require('./weather');
const { TYPES } = require('./tracks');
const { hashSeed } = require('./rng');

const SIMS = 15000;
const CACHE_MS = 5 * 60 * 1000;
const RACE_WINDOW_MS = 5 * 3600 * 1000;
const cache = new Map();
let calibCache = { key: null, params: null };

const american = p => (!p || p <= 0 ? '—' : p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);

async function listRaces(season = new Date().getUTCFullYear()) {
  const sched = await fetchSchedule(season);
  return sched.filter(r => !r.exhibition);
}

async function pickRace({ raceId = null, season = null } = {}) {
  const year = season || new Date().getUTCFullYear();
  let races = await listRaces(year);
  if (raceId) {
    const r = races.find(x => x.id === String(raceId));
    if (r) return r;
    const prev = await listRaces(year - 1).catch(() => []);
    const p = prev.find(x => x.id === String(raceId));
    if (p) return p;
    throw Object.assign(new Error(`Race ${raceId} not found`), { status: 404 });
  }
  const now = Date.now();
  let r = races.find(x => Date.parse(x.date) + RACE_WINDOW_MS > now);
  if (!r) { races = await listRaces(year + 1).catch(() => []); r = races[0]; }
  if (!r) { races = await listRaces(year); r = races[races.length - 1]; }
  if (!r) throw Object.assign(new Error('No races found on the schedule'), { status: 404 });
  return r;
}

function raceState(race, weekend) {
  const t = Date.parse(race.date), now = Date.now();
  if (weekend.complete) return 'post';
  if (now < t) return 'pre';
  return now < t + RACE_WINDOW_MS ? 'in' : 'post';
}

// Driver's DNF tendency relative to the field, shrunk hard toward 1 (most DNFs are luck).
function dnfFactor(entries, baseRate) {
  const n = entries.length, d = entries.filter(e => !e.running).length, K = 25;
  if (!baseRate) return 1;
  return Math.max(0.6, Math.min(1.6, ((d + K * baseRate) / (n + K)) / baseRate));
}

async function buildRace({ raceId = null, season = null } = {}) {
  const race = await pickRace({ raceId, season });
  const weekend = await fetchWeekend(race.season, race.id, { live: true }).catch(() => ({ results: [], runs: [], entries: [], stageResults: [], complete: false }));
  const state = raceState(race, weekend);
  const hist = await loadHistory({ before: race.date });
  const prep = prepare(hist.rows, hist.weekend);
  const calKey = `${hist.rows.length}|${prep.races.at(-1)?.raceId || ''}`;
  if (calibCache.key !== calKey) calibCache = { key: calKey, params: calibrate(prep) };
  const params = calibCache.params;
  const type = race.track.type;
  const atIdx = prep.races.length;

  // The field: entry list from this weekend's feed, else the last race's starters.
  let field = weekend.entries;
  let fieldSource = 'entry list';
  if (!field.length) {
    const last = prep.races.at(-1);
    field = last ? last.rows.map(r => ({ driverId: r.driverId, name: r.name, car: r.car, team: r.team, make: r.make })) : [];
    fieldSource = 'last race (entry list not posted yet)';
  }
  const runOf = kind => weekend.runs.filter(r => r.kind === kind).flatMap(r => r.results);
  const qual = new Map(), prac = new Map();
  for (const x of runOf('qualifying')) if (x.pos && (!qual.has(x.driverId) || x.pos < qual.get(x.driverId).pos)) qual.set(x.driverId, x);
  for (const x of runOf('practice')) if (x.pos && (!prac.has(x.driverId) || x.pos < prac.get(x.driverId).pos)) prac.set(x.driverId, x);
  const resultBy = new Map(weekend.results.map(r => [r.driverId, r]));
  const N = field.length;
  const qualKnown = field.length > 0 && field.every(d => qual.has(d.driverId) || resultBy.get(d.driverId)?.start);

  const drivers = field.map(d => {
    const entries = prep.byDriver.get(d.driverId) || [];
    const rt = rateDriver(entries, atIdx, type);
    const q = qual.get(d.driverId), p = prac.get(d.driverId);
    const start = q?.pos || resultBy.get(d.driverId)?.start || null;
    return {
      id: d.driverId, name: d.name, car: d.car, team: d.team, make: d.make,
      mu: rt.mu, rating: rt, start: qualKnown ? start : null,
      qualZ: qualKnown && start ? rankZ(start, N) : null, pracZ: p ? rankZ(p.pos, N) : null,
      practicePos: p?.pos || null, practiceSpeed: p?.bestSpeed || null, qualPos: start, qualSpeed: q?.bestSpeed || null,
      dnfFactor: dnfFactor(entries.filter(e => e.type === type || type !== 'superspeedway'), params.dnf[type]),
      entries,
    };
  });

  let weather = null;
  try { weather = await raceWeather(race); } catch (err) { weather = { available: false, reason: err.message }; }
  const rainProb = state === 'pre' && weather?.available ? weather.summary.rainEndProb : 0;
  const seed = hashSeed(`${race.id}|${calKey}|${qualKnown}|${rainProb}`);
  const sim = drivers.length ? simulateRace({ drivers, type, laps: race.laps || 300, stageLaps: race.stageLaps, params, rainProb, sims: SIMS, seed }) : null;
  const summary = sim ? summarize(sim) : { drivers: [], rainShare: 0, bigOneShare: 0 };
  const sumBy = new Map(summary.drivers.map(s => [s.id, s]));

  // Rain vs dry: same seed, rain forced off and on, smaller run — who gains if it ends early.
  let rainCompare = null;
  if (sim && rainProb >= 0.03) {
    const dry = summarize(simulateRace({ drivers, type, laps: race.laps || 300, stageLaps: race.stageLaps, params, rainProb: 0, sims: 4000, seed }));
    const wet = summarize(simulateRace({ drivers, type, laps: race.laps || 300, stageLaps: race.stageLaps, params, rainProb: 1, sims: 4000, seed }));
    const wetBy = new Map(wet.drivers.map(x => [x.id, x]));
    rainCompare = dry.drivers.map(x => ({ id: x.id, dryWin: x.win, wetWin: wetBy.get(x.id).win, dryTop10: x.top10, wetTop10: wetBy.get(x.id).top10 }))
      .sort((a, b) => (b.wetWin - b.dryWin) - (a.wetWin - a.dryWin));
  }

  // Live running order (display only; the pre-race simulation is not re-run mid-race).
  let live = null;
  if (state === 'in') {
    try { const l = await fetchLive(); if (l.raceId === race.id) live = l; } catch { live = null; }
  }
  const liveBy = new Map((live?.vehicles || []).map(v => [v.driverId, v]));

  const trackKey = race.track.key;
  const players = drivers.map(d => {
    const s = sumBy.get(d.id) || {};
    const recent = [...d.entries].sort((a, b) => b.idx - a.idx).slice(0, 10).map(e => ({ date: e.date, track: prep.races[e.idx]?.trackKey, type: e.type, start: e.start, finish: e.finish, running: e.running, lapsLed: e.lapsLed, y: +e.y.toFixed(2) }));
    const here = d.entries.filter(e => e.trackKey === trackKey).sort((a, b) => b.idx - a.idx).slice(0, 6).map(e => ({ date: e.date, finish: e.finish, start: e.start, running: e.running, lapsLed: e.lapsLed }));
    const byType = Object.fromEntries(Object.keys(TYPES).map(t => [t, +rateDriver(d.entries, atIdx, t).mu.toFixed(3)]));
    const lv = liveBy.get(d.id);
    const res = resultBy.get(d.id);
    return {
      id: d.id, name: d.name, car: d.car, team: d.team, make: d.make,
      rating: +d.mu.toFixed(3), overall: +d.rating.overall.toFixed(3), starts: d.rating.starts, typeStarts: d.rating.typeStarts, byType,
      practicePos: d.practicePos, practiceSpeed: d.practiceSpeed, qualPos: d.qualPos, qualSpeed: d.qualSpeed, start: d.start,
      dnfFactor: +d.dnfFactor.toFixed(2),
      odds: s.win !== undefined ? { win: s.win, top3: s.top3, top5: s.top5, top10: s.top10, top20: s.top20, fair: { win: american(s.win), top3: american(s.top3), top5: american(s.top5), top10: american(s.top10) } } : null,
      avgFinish: s.avgFinish, avgStart: s.avgStart, dnf: s.dnf, lapsLed: s.lapsLed, ledAny: s.ledAny, fastLaps: s.fastLaps, stagePts: s.stagePts, dfs: s.dfs,
      dist: sim && sim.index.has(d.id) ? finishDistribution(sim, d.id) : [],
      recent, here,
      live: lv ? { pos: lv.pos, lapsLed: lv.lapsLed, lapsCompleted: lv.lapsCompleted } : null,
      result: res?.finish ? { finish: res.finish, start: res.start, lapsLed: res.lapsLed, status: res.status } : null,
    };
  }).sort((a, b) => (b.odds?.win || 0) - (a.odds?.win || 0) || b.rating - a.rating);

  const payload = {
    race: { id: race.id, season: race.season, name: race.name, date: race.date, laps: race.laps, miles: race.miles, stageLaps: race.stageLaps,
      track: { ...race.track, typeLabel: TYPES[type].label, typeNote: TYPES[type].note, feedName: race.trackName } },
    state, fieldSource, qualifyingKnown: qualKnown, practiceKnown: prac.size > 0,
    history: { source: hist.source, races: prep.races.length, driverRaces: hist.rows.length, typeRaces: prep.races.filter(r => r.type === type).length },
    params: { beta: +params.beta.toFixed(3), bQual: +params.bQual.toFixed(3), bPrac: +params.bPrac.toFixed(3), sigma: params.sigma[type], dnfRate: params.dnf[type], cautions: params.cautions[type], bigOne: type === 'superspeedway' ? params.bigOne : null, samples: params.samples },
    sims: sim ? sim.sims : 0, rainShare: summary.rainShare, bigOneShare: summary.bigOneShare,
    weather, rainCompare, live: live ? { lap: live.lap, lapsInRace: live.lapsInRace, flag: live.flag, stage: live.stage } : null,
    players,
    generatedAt: new Date().toISOString(),
  };
  if (state === 'pre' && players.length) saveSnapshot(race, payload).catch(() => {});
  return { payload, sim, race, prep, params };
}

async function getRaceContext(opts = {}) {
  const key = `${opts.raceId || 'current'}|${opts.season || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const p = buildRace(opts);
  cache.set(key, { at: Date.now(), value: p });
  try { return await p; } catch (err) { cache.delete(key); throw err; }
}

function clearRaceCache() { cache.clear(); calibCache = { key: null, params: null }; }

module.exports = { getRaceContext, buildRace, pickRace, listRaces, raceState, american, clearRaceCache, SIMS };
