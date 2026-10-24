// Model, simulator, pricing and parsing tests over the synthetic world (tests/fixtures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMockFetch } = require('./fixtures');
const nascar = require('../lib/nascar');
const { prepare, rateDriver, rankZ, calibrate, typeWeight } = require('../lib/ratings');
const { simulateRace, summarize, finishPoints, dfsPoints } = require('../lib/simulator');
const { priceParlay, autoParlays } = require('../lib/parlay');
const { parseBook, toDecimal } = require('../lib/book');
const { parseSalaries } = require('../lib/dfs');
const { findTrack } = require('../lib/tracks');
const { raceRows, weekendRows } = require('../lib/store');
const Opt = require('../lib/dfs-optimizer');
const { DEFAULTS } = require('../lib/ratings');

const NOW = '2026-10-24T15:00:00Z';
const realNow = Date.now;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; });
test.after(() => { Date.now = realNow; });

async function history(world) {
  const sched = (await nascar.fetchSchedule(2026)).filter(r => r.winnerId);
  const rows = [], wk = [];
  for (const race of sched) {
    const weekend = await nascar.fetchWeekend(race.season, race.id);
    rows.push(...raceRows(race, weekend, await nascar.fetchLoop(race.season, race.id), await nascar.fetchLapPace(race.season, race.id)));
    wk.push(...weekendRows(race, weekend));
  }
  return { rows, wk, sched };
}

test('tracks: types and unknown venues', () => {
  assert.equal(findTrack('Talladega Superspeedway').type, 'superspeedway');
  assert.equal(findTrack('Charlotte Motor Speedway Roval').type, 'road');
  assert.equal(findTrack('Charlotte Motor Speedway').type, 'intermediate');
  const u = findTrack('Somewhere Raceway');
  assert.equal(u.known, false);
  assert.equal(u.type, 'intermediate');
});

test('feeds parse: schedule, weekend, loop, lap pace', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const s = await nascar.fetchSchedule(2026);
    assert.equal(s.length, 38);
    const done = s.find(r => r.winnerId);
    const wk = await nascar.fetchWeekend(2026, done.id);
    assert.ok(wk.complete);
    assert.equal(wk.results.length, 38);
    assert.deepEqual(new Set(wk.results.map(r => r.finish)).size, 38);
    assert.ok(wk.runs.some(r => r.kind === 'qualifying'));
    const loop = await nascar.fetchLoop(2026, done.id);
    assert.equal(loop.length, 38);
    const pace = await nascar.fetchLapPace(2026, done.id);
    assert.ok(pace.length >= 30 && pace.some(p => p.pctOff === 0));
    const next = await nascar.fetchWeekend(2026, w.next.id);
    assert.equal(next.results.length, 0);
    assert.equal(next.complete, false);
  } finally { w.restore(); }
});

test('rankZ is symmetric and ordered', () => {
  assert.ok(Math.abs(rankZ(1, 40) + rankZ(40, 40)) < 1e-9);
  assert.ok(rankZ(1, 40) > rankZ(2, 40));
  assert.equal(rankZ(null, 40), null);
});

test('type weights are symmetric, 1 on the diagonal, low across road/oval', () => {
  assert.equal(typeWeight('road', 'road'), 1);
  assert.equal(typeWeight('road', 'intermediate'), typeWeight('intermediate', 'road'));
  assert.ok(typeWeight('road', 'intermediate') < typeWeight('short_flat', 'short_concrete'));
});

test('ratings recover the synthetic skill order and are leak-free', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const { rows, wk } = await history(w);
    const prep = prepare(rows, wk);
    const at = prep.races.length;
    const truth = w.drivers.map(d => [d.id, d.byType.intermediate]);
    const est = new Map(truth.map(([id]) => [id, rateDriver(prep.byDriver.get(id) || [], at, 'intermediate').mu]));
    // Rank correlation between true and estimated skill.
    const rank = arr => { const s = [...arr].sort((a, b) => b[1] - a[1]); return new Map(s.map(([id], i) => [id, i])); };
    const rt = rank(truth), re = rank([...est.entries()]);
    const n = truth.length, d2 = truth.reduce((s, [id]) => s + (rt.get(id) - re.get(id)) ** 2, 0);
    const rho = 1 - (6 * d2) / (n * (n * n - 1));
    assert.ok(rho > 0.8, `rank correlation ${rho.toFixed(2)}`);
    // Leak-free: changing a later race's results must not move a rating taken before it.
    const idx = 20, id = truth[0][0];
    const before = rateDriver(prep.byDriver.get(id), idx, 'intermediate').mu;
    for (const e of prep.byDriver.get(id)) if (e.idx >= idx) e.y = -9;
    assert.equal(rateDriver(prep.byDriver.get(id), idx, 'intermediate').mu, before);
    const params = calibrate(prepare(rows, wk));
    assert.ok(params.beta > 0.2 && params.sigma.intermediate > 0.2);
  } finally { w.restore(); }
});

function toyDrivers(n = 36) { return Array.from({ length: n }, (_, i) => ({ id: String(i), mu: 1.5 - (3 * i) / n, start: i + 1, qualZ: rankZ(i + 1, n), pracZ: null })); }

test('simulator: every run is a permutation; markets add up; laps led within the race', () => {
  const drivers = toyDrivers();
  const sim = simulateRace({ drivers, type: 'superspeedway', laps: 200, stageLaps: [60, 60], params: { ...DEFAULTS, dnf: { ...DEFAULTS.dnf, individual: 0.07 } }, rainProb: 0.3, sims: 3000, seed: 3 });
  const S = sim.sims, P = sim.players;
  for (const k of [0, 17, 2999]) {
    const pos = new Set(); let led = 0;
    for (let i = 0; i < P; i++) { pos.add(sim.finishPos[k + i * S]); led += sim.lapsLed[k + i * S]; }
    assert.equal(pos.size, P);
    assert.ok(led <= (sim.rained[k] ? 120 : 200) + 1);
  }
  const sum = summarize(sim);
  const tot = key => sum.drivers.reduce((s, d) => s + d[key], 0);
  assert.ok(Math.abs(tot('win') - 1) < 1e-9);
  assert.ok(Math.abs(tot('top10') - 10) < 1e-9);
  assert.ok(sum.rainShare > 0.25 && sum.rainShare < 0.35);
  assert.ok(sum.bigOneShare > 0.4);
  assert.ok(sum.drivers[0].win > sum.drivers[30].win);
});

test('DFS scoring', () => {
  assert.equal(finishPoints(1), 45);
  assert.equal(finishPoints(2), 42);
  assert.equal(finishPoints(3), 41);
  assert.equal(finishPoints(40), 4);
  const sim = simulateRace({ drivers: toyDrivers(10), type: 'intermediate', laps: 100, params: DEFAULTS, sims: 50, seed: 1 });
  const k = 0, i = 0, S = sim.sims;
  const f = sim.finishPos[k + i * S], st = sim.startPos[k + i * S];
  assert.ok(Math.abs(dfsPoints(sim, i, k) - (finishPoints(f) + st - f + 0.25 * sim.lapsLed[k + i * S] + 0.45 * sim.fastLaps[k + i * S])) < 1e-6);
});

test('parlays: joint never exceeds a leg; head-to-head sides sum to 1; correlated top-N', () => {
  const sim = simulateRace({ drivers: toyDrivers(), type: 'intermediate', laps: 267, params: DEFAULTS, sims: 4000, seed: 9 });
  const a = priceParlay(sim, [{ kind: 'finish', id: '0', market: 'top5' }, { kind: 'finish', id: '1', market: 'top5' }]);
  assert.ok(a.joint <= Math.min(...a.legs.map(l => l.prob)));
  assert.ok(a.lift < 1, 'two top-5 legs compete for the same spots');
  const x = priceParlay(sim, [{ kind: 'h2h', id: '3', opp: '7' }]).joint, y = priceParlay(sim, [{ kind: 'h2h', id: '7', opp: '3' }]).joint;
  assert.ok(Math.abs(x + y - 1) < 1e-9);
  assert.ok(priceParlay(sim, [{ kind: 'finish', id: 'nope', market: 'top5' }]).error);
  const auto = autoParlays(sim, toyDrivers().map(d => ({ id: d.id })), { market: 'top10', size: 3 });
  assert.equal(auto.parlays.length, 3);
  assert.ok(auto.parlays[0].joint >= auto.parlays[1].joint);
});

test('book parsing: markets, odds formats, h2h, skipped lines', () => {
  const players = [{ id: '1', name: 'Kyle Busch' }, { id: '2', name: 'Kurt Busch' }, { id: '3', name: 'Chase Elliott' }];
  const { rows, skipped } = parseBook('Kyle Busch, win, +450\nChase Elliott, Top 10, 1.80\nKyle Busch vs Chase Elliott, h2h, -120, +100\nNobody, win, +100\nChase Elliott, podium, +300', players);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].dec, 5.5);
  assert.equal(rows[1].market, 'top10');
  assert.equal(rows.filter(r => r.market === 'h2h').length, 2);
  assert.equal(skipped.length, 2);
  assert.ok(Math.abs(toDecimal('-200') - 1.5) < 1e-9);
});

test('salary CSV parse and an exact 6-driver lineup under the cap', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Driver ${String.fromCharCode(65 + i)}` }));
  const csv = ['Position,Name + ID,Name,ID,Roster Position,Salary', ...players.map((p, i) => `D,${p.name} (${i}),${p.name},${100 + i},D,${11000 - i * 500}`), 'D,Ghost (99),Ghost,99,D,5000'].join('\n');
  const s = parseSalaries(csv, players);
  assert.equal(s.rows.length, 12);
  assert.deepEqual(s.unmatched, ['Ghost']);
  const pool = s.rows.map((r, i) => ({ id: r.id, name: r.name, salary: r.salary, points: 60 - i * 3 + (i % 3) * 4 }));
  const out = Opt.buildLineups(pool, { count: 3, minUnique: 1 });
  assert.equal(out.lineups.length, 3);
  for (const l of out.lineups) { assert.equal(l.players.length, 6); assert.ok(l.salary <= 50000); }
});

test('simulation-scored lineups: dominator cap, ceiling ranking, average equals the sum', () => {
  const { simSample, projections } = require('../lib/dfs');
  const n = 30, drivers = toyDrivers(n);
  const sim = simulateRace({ drivers, type: 'intermediate', laps: 267, params: DEFAULTS, sims: 6000, seed: 21 });
  const payload = { players: drivers.map(d => ({ id: d.id, name: `D${d.id}`, start: d.start, avgStart: d.start, avgFinish: 0 })) };
  const sal = drivers.map((d, i) => ({ id: d.id, salary: Math.max(5000, 11800 - i * 230) }));
  const proj = projections(sim, payload, sal);
  const smp = simSample(sim, proj.map(p => p.id), 2000);
  const sample = { n: smp.n, ids: smp.ids, data: new Int16Array(Buffer.from(smp.data, 'base64').buffer.slice(0)) };
  const pool = proj.map(p => ({ id: p.id, name: p.name, salary: p.salary, points: p.points, ceiling: p.p90 }));
  const doms = proj.filter(p => p.mostLed >= 0.08).map(p => p.id);
  assert.ok(doms.length >= 2);
  assert.ok(Math.abs(proj.reduce((s, p) => s + p.mostLed, 0) - 1) < 1e-9);
  const cash = Opt.buildSimLineups(pool, sample, { count: 5, metric: 'mean', dominators: doms, maxDominators: 1 });
  assert.equal(cash.lineups.length, 5);
  for (const l of cash.lineups) {
    assert.ok(l.dominators <= 1 && l.salary <= 50000 && l.players.length === 6);
    assert.ok(Math.abs(l.mean - l.naive) < 2.5, 'averages add (up to sample noise)');
  }
  const gpp = Opt.buildSimLineups(pool, sample, { count: 5, metric: 'ceiling' });
  assert.ok(gpp.lineups[0].ceiling >= cash.lineups[0].ceiling - 1e-9 || gpp.lineups[0].ceiling >= gpp.lineups[1].ceiling);
  for (let i = 1; i < gpp.lineups.length; i++) assert.ok(gpp.lineups[i - 1].ceiling >= gpp.lineups[i].ceiling);
});
