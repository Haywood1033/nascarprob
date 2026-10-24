// lib/parlay.js — every bet priced inside the race simulation, so correlations are real: two
// top-5 legs compete for the same five spots, a head-to-head winner is more likely to also run
// top 10, a superspeedway crash sinks several legs at once.
//
// Leg shapes:
//   { kind: 'finish', id, market: win|top3|top5|top10|top20, dec? }
//   { kind: 'h2h', id, opp, dec? }       — id finishes ahead of opp (DNFs ordered by laps run)
// Stock car results have no ties, so a leg either hits or misses in each run.

const FINISH_N = { win: 1, top3: 3, top5: 5, top10: 10, top20: 20 };

function legKey(l) { return l.kind === 'h2h' ? `h|${l.id}|${l.opp}|${l.dec || 0}` : `f|${l.id}|${l.market}|${l.dec || 0}`; }

// A leg's hit series is built once per simulation and reused: the parlay search prices the same
// legs in hundreds of combinations.
function legSeries(sim, leg) {
  if (!sim._series) sim._series = new Map();
  const key = legKey(leg);
  let out = sim._series.get(key);
  if (out) return out;
  const S = sim.sims, i = sim.index.get(leg.id);
  const hit = new Uint8Array(S);
  if (leg.kind === 'h2h') {
    const j = sim.index.get(leg.opp);
    for (let k = 0; k < S; k++) hit[k] = sim.finishPos[k + i * S] < sim.finishPos[k + j * S] ? 1 : 0;
  } else {
    const N = FINISH_N[leg.market];
    for (let k = 0; k < S; k++) hit[k] = sim.finishPos[k + i * S] <= N ? 1 : 0;
  }
  let sum = 0; for (let k = 0; k < S; k++) sum += hit[k];
  out = { hit, prob: sum / S };
  sim._series.set(key, out);
  return out;
}

function validLeg(sim, l) {
  if (!sim.index.has(l.id)) return false;
  if (l.kind === 'h2h') return sim.index.has(l.opp) && l.opp !== l.id;
  return l.market in FINISH_N;
}

function priceParlay(sim, legs) {
  if (!legs.length) return { error: 'Add at least one leg.' };
  if (legs.some(l => !validLeg(sim, l))) return { error: 'Unknown driver or market in a leg.' };
  const S = sim.sims, series = legs.map(l => legSeries(sim, l));
  let joint = 0;
  for (let k = 0; k < S; k++) { let h = 1; for (const x of series) { if (!x.hit[k]) { h = 0; break; } } joint += h; }
  joint /= S;
  const independent = series.reduce((a, x) => a * x.prob, 1);
  const allDec = legs.every(l => l.dec > 1);
  const bookDecimal = allDec ? legs.reduce((a, l) => a * l.dec, 1) : null;
  return {
    legs: legs.map((l, n) => ({ ...l, prob: series[n].prob })),
    joint, independent, lift: independent ? joint / independent : null,
    fairDecimal: joint ? 1 / joint : null, bookDecimal, ev: allDec ? joint * bookDecimal - 1 : null,
  };
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop(); }
}

// Best finishing-position tickets in one market. Guardrails (same as golfprob): every leg has a
// real chance (minLeg), with prices only +EV legs, and the ticket must cash often enough not to be
// a lottery ticket (minJoint). Without prices: the most likely tickets, labeled as such.
function autoParlays(sim, candidates, { market = 'top10', size = 3, count = 3, pool = 12, minLeg = 0.1, minJoint = 0.03, rankBy = 'auto' } = {}) {
  const priced = candidates.filter(c => sim.index.has(c.id)).map(c => {
    const leg = { kind: 'finish', id: c.id, market, dec: c.dec || null };
    const prob = legSeries(sim, leg).prob;
    return { ...leg, prob, ev: leg.dec ? prob * leg.dec - 1 : null };
  });
  const byBook = rankBy !== 'joint' && priced.some(c => c.dec);
  const eligible = priced.filter(c => c.prob >= minLeg && (!byBook || (c.dec && c.ev > 0)));
  const ranked = (byBook ? eligible.sort((a, b) => b.ev - a.ev) : eligible.sort((a, b) => b.prob - a.prob)).slice(0, pool);
  const n = Math.min(size, ranked.length);
  if (n < 2) return { byBook, parlays: [], note: `Not enough ${byBook ? '+EV priced ' : ''}legs with a ${Math.round(minLeg * 100)}%+ chance in this market.` };
  const out = [];
  for (const c of combos(ranked, n)) {
    const r = priceParlay(sim, c.map(({ id, dec }) => ({ kind: 'finish', id, market, dec })));
    if (r.joint >= minJoint) out.push(r);
  }
  if (!out.length) return { byBook, parlays: [], note: `No ${n}-leg ticket cashes in at least ${Math.round(minJoint * 100)}% of simulations.` };
  out.sort((a, b) => (byBook ? b.ev - a.ev : b.joint - a.joint));
  return { byBook, parlays: out.slice(0, count), note: n < size ? `Only ${ranked.length} eligible legs, so these are ${n}-leg tickets.` : null };
}

module.exports = { FINISH_N, legSeries, priceParlay, autoParlays, combos };
