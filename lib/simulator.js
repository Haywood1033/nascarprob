// lib/simulator.js — Monte Carlo race simulation. Each run:
//   1. race-day speed s_i = beta·rating + bQual·qualifying z + bPrac·practice z + noise(σ_type);
//      with no qualifying yet, a qualifying order is drawn from the ratings first.
//   2. incidents: each car has a DNF hazard (track-type rate, nudged by the driver's own
//      history); at superspeedways a multi-car crash ("the big one") happens with some
//      probability and collects a random share of the field together. A DNF lap is drawn.
//   3. rain: with the forecast probability, the race ends at the end of stage 2 (official).
//   4. running cars finish in speed order, DNFs behind them by laps completed.
//   5. the race is split into green-run segments (one per caution + 1). Each segment's leader is
//      the fastest car on that run (speed + segment noise), the last one is the winner; fastest
//      laps in a segment go to running cars in proportion to exp(κ·speed).
//   6. stage ends score the top 10 (10..1) from a noisier order.
// Every market (win, top N, matchups, parlays, DFS points) is counted from these same runs, so
// correlations — teammates in the same wreck, a leader who also leads laps — come for free.

const { makeRng } = require('./rng');
const { rankZ } = require('./ratings');

const KAPPA_FAST = 2.2;

function simulateRace({ drivers, type, laps, stageLaps = [], params, rainProb = 0, sims = 15000, seed = 1 }) {
  const rng = makeRng(seed);
  const P = drivers.length, S = sims;
  const sigma = params.sigma[type] ?? 0.7;
  const isSS = type === 'superspeedway';
  const indiv = isSS ? params.dnf.individual ?? 0.07 : params.dnf[type] ?? 0.08;
  const segments = Math.max(2, Math.round((params.cautions[type] ?? 7) + 1));
  const L1 = stageLaps[0] || Math.round(laps * 0.25), L2 = L1 + (stageLaps[1] || Math.round(laps * 0.25));

  const finishPos = new Uint8Array(P * S), startPos = new Uint8Array(P * S), dnf = new Uint8Array(P * S);
  const lapsLed = new Uint16Array(P * S), fastLaps = new Float32Array(P * S), stagePts = new Uint8Array(P * S);
  const rained = new Uint8Array(S), bigOne = new Uint8Array(S);
  const knownStart = drivers.every(d => d.start);

  const s = new Float64Array(P), dnfLap = new Float64Array(P), tmp = new Float64Array(P);
  const idx = Array.from({ length: P }, (_, i) => i);

  for (let k = 0; k < S; k++) {
    // 1. qualifying (drawn when not yet run) and race-day speed
    let qz;
    if (knownStart) {
      for (let i = 0; i < P; i++) startPos[k + i * S] = drivers[i].start;
      qz = drivers.map(d => d.qualZ ?? rankZ(d.start, P));
    } else {
      for (let i = 0; i < P; i++) tmp[i] = drivers[i].mu + rng.normal() * 0.8;
      idx.sort((a, b) => tmp[b] - tmp[a]);
      qz = new Array(P);
      idx.forEach((i, r) => { startPos[k + i * S] = r + 1; qz[i] = rankZ(r + 1, P); });
    }
    for (let i = 0; i < P; i++) s[i] = params.beta * drivers[i].mu + params.bQual * qz[i] + params.bPrac * (drivers[i].pracZ ?? 0) + rng.normal() * sigma;

    // 2–3. incidents and rain
    const rain = rng.uniform() < rainProb;
    rained[k] = rain ? 1 : 0;
    const raceLaps = rain ? L2 : laps;
    const big = isSS && rng.uniform() < params.bigOne.prob;
    bigOne[k] = big ? 1 : 0;
    const bigLap = big ? Math.floor(laps * (0.3 + rng.uniform() * 0.65)) : 0;
    for (let i = 0; i < P; i++) {
      dnfLap[i] = Infinity;
      if (rng.uniform() < indiv * (drivers[i].dnfFactor || 1)) dnfLap[i] = 5 + rng.uniform() * (laps - 10);
      if (big && rng.uniform() < params.bigOne.share) dnfLap[i] = Math.min(dnfLap[i], bigLap);
      if (dnfLap[i] > raceLaps) dnfLap[i] = Infinity;
      dnf[k + i * S] = dnfLap[i] < Infinity ? 1 : 0;
    }

    // 4. finishing order: running by speed, then DNFs by laps completed
    idx.sort((a, b) => {
      const da = dnfLap[a] < Infinity, db = dnfLap[b] < Infinity;
      if (da !== db) return da ? 1 : -1;
      return da ? dnfLap[b] - dnfLap[a] : s[b] - s[a];
    });
    idx.forEach((i, r) => { finishPos[k + i * S] = r + 1; });
    const winner = idx[0];

    // 5. segments: leaders and fastest laps
    const segs = rain ? Math.max(1, Math.round(segments * (L2 / laps))) : segments;
    const segLen = raceLaps / segs;
    for (let g = 0; g < segs; g++) {
      const a = g * segLen, mid = a + segLen / 2;
      let lead = -1, best = -Infinity, z = 0;
      for (let i = 0; i < P; i++) {
        if (dnfLap[i] <= mid) continue;
        const v = s[i] + rng.normal() * sigma * 0.8;
        if (v > best) { best = v; lead = i; }
        tmp[i] = Math.exp(KAPPA_FAST * s[i]); z += tmp[i];
      }
      if (g === segs - 1) lead = winner;
      const len = Math.round((g + 1) * segLen) - Math.round(a);
      if (lead >= 0) lapsLed[k + lead * S] += len;
      for (let i = 0; i < P; i++) if (dnfLap[i] > mid) fastLaps[k + i * S] += (len * tmp[i]) / z;
    }

    // 6. stage points from a noisier running order at each stage end
    for (const end of rain ? [L1, L2] : [L1, L2]) {
      const alive = [];
      for (let i = 0; i < P; i++) if (dnfLap[i] > end) { alive.push(i); tmp[i] = s[i] + rng.normal() * sigma * 0.6; }
      alive.sort((a, b) => tmp[b] - tmp[a]);
      alive.slice(0, 10).forEach((i, r) => { stagePts[k + i * S] += 10 - r; });
    }
  }
  return { sims: S, players: P, ids: drivers.map(d => d.id), index: new Map(drivers.map((d, i) => [d.id, i])), finishPos, startPos, dnf, lapsLed, fastLaps, stagePts, rained, bigOne, laps };
}

// Fantasy scoring of the common Classic format (verify against the site's rules page):
// finish points 45 / 42 / then 41 down by one, ±1 per place gained or lost, 0.25 per lap led,
// 0.45 per fastest lap.
function finishPoints(pos) { return pos === 1 ? 45 : pos === 2 ? 42 : Math.max(0, 44 - pos); }
function dfsPoints(sim, i, k) {
  const S = sim.sims, f = sim.finishPos[k + i * S], st = sim.startPos[k + i * S];
  return finishPoints(f) + (st - f) + 0.25 * sim.lapsLed[k + i * S] + 0.45 * sim.fastLaps[k + i * S];
}

function summarize(sim) {
  const S = sim.sims, out = [];
  for (let i = 0; i < sim.players; i++) {
    let win = 0, t3 = 0, t5 = 0, t10 = 0, t20 = 0, fsum = 0, dnf = 0, led = 0, fast = 0, stage = 0, ssum = 0, lead1 = 0;
    const pts = new Float32Array(S);
    for (let k = 0; k < S; k++) {
      const f = sim.finishPos[k + i * S];
      if (f === 1) win++; if (f <= 3) t3++; if (f <= 5) t5++; if (f <= 10) t10++; if (f <= 20) t20++;
      fsum += f; dnf += sim.dnf[k + i * S]; led += sim.lapsLed[k + i * S]; fast += sim.fastLaps[k + i * S]; stage += sim.stagePts[k + i * S];
      ssum += sim.startPos[k + i * S]; if (sim.lapsLed[k + i * S] > 0) lead1++;
      pts[k] = dfsPoints(sim, i, k);
    }
    const sorted = Float32Array.from(pts).sort();
    const q = p => +sorted[Math.min(S - 1, Math.floor(p * S))].toFixed(1);
    out.push({
      id: sim.ids[i], win: win / S, top3: t3 / S, top5: t5 / S, top10: t10 / S, top20: t20 / S,
      avgFinish: +(fsum / S).toFixed(1), avgStart: +(ssum / S).toFixed(1), dnf: dnf / S, ledAny: lead1 / S,
      lapsLed: +(led / S).toFixed(1), fastLaps: +(fast / S).toFixed(1), stagePts: +(stage / S).toFixed(1),
      dfs: { mean: +(pts.reduce((a, b) => a + b, 0) / S).toFixed(1), p10: q(0.1), p50: q(0.5), p90: q(0.9) },
    });
  }
  return { drivers: out, rainShare: sim.rained.reduce((a, b) => a + b, 0) / S, bigOneShare: sim.bigOne.reduce((a, b) => a + b, 0) / S };
}

// Finish distribution of one driver (share of runs at each position), for the drawer chart.
function finishDistribution(sim, id) {
  const i = sim.index.get(id), S = sim.sims, d = new Array(sim.players).fill(0);
  for (let k = 0; k < S; k++) d[sim.finishPos[k + i * S] - 1]++;
  return d.map(v => +(v / S).toFixed(4));
}

module.exports = { simulateRace, summarize, finishDistribution, finishPoints, dfsPoints, KAPPA_FAST };
