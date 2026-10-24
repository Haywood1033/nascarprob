// End to end through the real route handlers over the synthetic world: race payload, plays
// with pasted prices, a custom parlay, DFS projections, health and the backtest.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMockFetch } = require('./fixtures');

const NOW = '2026-10-24T15:00:00Z';
const realNow = Date.now;
let world;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; world = installMockFetch({ now: NOW }); });
test.after(() => { world.restore(); Date.now = realNow; });

function call(name, { query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json(b) { resolve({ code, body: b }); }, end() { resolve({ code }); } };
    require(`../api/${name}.js`)({ method: body ? 'POST' : 'GET', query, body }, res).catch(reject);
  });
}

test('race payload: field, odds, weather, briefing', async () => {
  const { code, body } = await call('race');
  assert.equal(code, 200);
  assert.equal(body.race.id, world.next.id);
  assert.equal(body.state, 'pre');
  assert.equal(body.players.length, 38);
  assert.ok(body.qualifyingKnown);
  const sum = body.players.reduce((s, p) => s + p.odds.win, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
  assert.ok(body.players.every(p => p.dist.length === 38));
  assert.ok(body.weather.available);
  assert.ok(body.weather.summary.rainEndProb > 0);
  assert.ok(body.briefing.headline.length > 10);
});

test('plays: value mode with prices, model mode without', async () => {
  const race = (await call('race')).body;
  const fav = race.players[0];
  const model = (await call('plays', { body: { book: '' } })).body;
  assert.equal(model.finishing.win.mode, 'model');
  assert.equal(model.finishing.win.items[0].id, fav.id);
  const priced = (await call('plays', { body: { book: `${fav.name}, win, +2000\n${fav.name} vs ${race.players[1].name}, h2h, +150, -180\nNo One, win, +100` } })).body;
  assert.equal(priced.finishing.win.mode, 'value');
  assert.equal(priced.finishing.win.items[0].id, fav.id);
  assert.equal(priced.book.matched, 3);
  assert.equal(priced.book.skipped.length, 1);
  assert.equal(priced.matchups.mode, 'value');
  assert.ok(priced.matchups.all.length === 2);
});

test('custom parlay and DFS projections', async () => {
  const race = (await call('race')).body;
  const [a, b] = race.players;
  const p = (await call('parlay', { body: { legs: [{ kind: 'finish', id: a.id, market: 'top5' }, { kind: 'finish', id: b.id, market: 'top5' }] } })).body;
  assert.ok(p.joint > 0 && p.joint < p.legs[0].prob);
  const csv = ['Position,Name + ID,Name,ID,Roster Position,Salary', ...race.players.map((x, i) => `D,${x.name} (${i}),${x.name},${i},D,${Math.max(5000, 11500 - i * 170)}`)].join('\n');
  const d = (await call('dfs', { body: { csv } })).body;
  assert.equal(d.salaries.matched, 38);
  const top = d.projections[0];
  assert.ok(Math.abs(top.points - (top.split.finish + top.split.placeDiff + top.split.lapsLed + top.split.fastLaps)) < 0.3);
});

test('health reports every feed', async () => {
  const { body } = await call('health');
  assert.ok(body.ok, JSON.stringify(body.checks.filter(c => !c.ok)));
  assert.ok(body.checks.length >= 7);
});

test('backtest scores races leak-free and beats the no-skill baseline', async () => {
  const { body } = await call('backtest', { query: { races: '8', sims: '1000' } });
  assert.equal(body.racesScored, 8);
  assert.ok(body.markets.top10.skillVsBaseline > 0);
});
