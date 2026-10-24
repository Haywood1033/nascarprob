// lib/ratings.js — driver speed ratings by track type, and the calibration that turns a rating
// plus this weekend's practice/qualifying into a race-day expectation.
//
// 1. Every historical driver-race gets a performance score `y`: a blend of green-flag pace,
//    average running position, loop driver rating and finish, each as a z-score within that
//    race's field (so a 38-car field and a 36-car field compare). Finish is left out for cars
//    that didn't finish: a wreck says little about speed.
// 2. A driver's rating for track type T is a weighted mean of their scores: recency halves every
//    HALF_LIFE races, other track types count less (road and superspeedways barely transfer to
//    ovals), and the mean is regressed toward the driver's all-track level with K_SHRINK races
//    of weight. A driver with no history starts below average (ROOKIE_PRIOR): new drivers are.
// 3. calibrate() replays history race by race using only earlier races, and fits by least
//    squares how finish (z, running cars) depends on the rating and on practice/qualifying rank,
//    plus the leftover noise per track type and DNF rates. The simulator draws from exactly that.

const HALF_LIFE = 12;
const K_SHRINK = 3;
const ROOKIE_PRIOR = -0.55;
const COMPONENTS = { pace: 0.35, avgPos: 0.3, rating: 0.15, finish: 0.2 };

// How much a result on one track type informs another. Symmetric; diagonal 1.
const OVAL = ['intermediate', 'short_concrete', 'short_flat', 'large_flat', 'oneoff'];
function typeWeight(a, b) {
  if (a === b) return 1;
  if (a === 'road' || b === 'road') return 0.15;
  if (a === 'superspeedway' || b === 'superspeedway') return 0.25;
  const near = [['intermediate', 'oneoff'], ['short_concrete', 'short_flat'], ['large_flat', 'intermediate'], ['large_flat', 'short_flat']];
  return near.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) ? 0.65 : 0.45;
}

function zscores(values) {
  const v = values.filter(x => x !== null && Number.isFinite(x));
  if (v.length < 5) return values.map(() => null);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  return values.map(x => (x === null || !Number.isFinite(x) ? null : (x - m) / sd));
}

// Rank → normal score, so "qualified 5th of 38" becomes a z comparable across field sizes.
function rankZ(pos, n) {
  if (!pos || !n) return null;
  const p = Math.min(0.995, Math.max(0.005, 1 - (pos - 0.5) / n));
  // Acklam's inverse normal approximation, central region is enough here.
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) { const r = 0.180625 - q * q; return q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r + 3.387132872796366608) / (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1); }
  const r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  const x = (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r + 1.42343711074968357734) / (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  return q < 0 ? -x : x;
}

// history rows (lib/store) → races in date order with a performance score per driver.
function prepare(rows, weekend = []) {
  const byRace = new Map();
  for (const r of rows) { if (!byRace.has(r.raceId)) byRace.set(r.raceId, []); byRace.get(r.raceId).push(r); }
  const wkBy = new Map();
  for (const w of weekend) wkBy.set(`${w.raceId}|${w.driverId}|${w.kind}`, w);
  const races = [...byRace.entries()].map(([raceId, rr]) => ({ raceId, date: rr[0].date, type: rr[0].trackType, trackKey: rr[0].trackKey, laps: rr[0].laps, cautions: rr[0].cautions, rows: rr }))
    .sort((a, b) => a.date.localeCompare(b.date));
  races.forEach((race, idx) => {
    race.idx = idx;
    const n = race.rows.length;
    const pace = zscores(race.rows.map(r => (r.pacePctOff === null ? null : -r.pacePctOff)));
    const avgPos = zscores(race.rows.map(r => (r.avgPos === null ? null : -r.avgPos)));
    const rating = zscores(race.rows.map(r => r.rating));
    const finish = race.rows.map(r => (r.running ? rankZ(r.finish, n) : null));
    const finishAll = race.rows.map(r => rankZ(r.finish, n));
    race.rows.forEach((r, i) => {
      const parts = { pace: pace[i], avgPos: avgPos[i], rating: rating[i], finish: finish[i] };
      let s = 0, w = 0;
      for (const [k, wt] of Object.entries(COMPONENTS)) if (parts[k] !== null) { s += wt * parts[k]; w += wt; }
      // Nothing but a DNF finish: fall back to finish position, heavily shrunk.
      r.y = w > 0 ? s / w : finishAll[i] * 0.5;
      r.finishZ = finish[i];
      const q = wkBy.get(`${race.raceId}|${r.driverId}|qualifying`), p = wkBy.get(`${race.raceId}|${r.driverId}|practice`);
      r.qualZ = rankZ(q?.pos ?? r.start, n);
      r.pracZ = p ? rankZ(p.pos, n) : null;
    });
  });
  const byDriver = new Map();
  for (const race of races) for (const r of race.rows) {
    if (!byDriver.has(r.driverId)) byDriver.set(r.driverId, []);
    byDriver.get(r.driverId).push({ idx: race.idx, type: race.type, y: r.y, running: r.running, date: race.date, trackKey: race.trackKey, finish: r.finish, start: r.start, lapsLed: r.lapsLed, fastLaps: r.fastLaps });
  }
  return { races, byDriver };
}

// Rating for one driver at race index `atIdx` (only races before it) on track type `type`.
function rateDriver(entries, atIdx, type) {
  let sw = 0, swy = 0, aw = 0, awy = 0, sameN = 0, n = 0;
  for (const e of entries) {
    if (e.idx >= atIdx) continue;
    const age = atIdx - e.idx - 1;
    const rec = Math.pow(0.5, age / HALF_LIFE);
    const tw = typeWeight(e.type, type);
    sw += rec * tw; swy += rec * tw * e.y;
    const ow = rec * (e.type === 'road' || e.type === 'superspeedway' ? 0.3 : 1);
    aw += ow; awy += ow * e.y;
    if (e.type === type) sameN++;
    n++;
  }
  const overall = (awy + ROOKIE_PRIOR * K_SHRINK) / (aw + K_SHRINK);
  const mu = (swy + overall * K_SHRINK) / (sw + K_SHRINK);
  return { mu, overall, starts: n, typeStarts: sameN, weight: +sw.toFixed(2) };
}

function rateField(prep, driverIds, atIdx, type) {
  const out = new Map();
  for (const id of driverIds) out.set(id, rateDriver(prep.byDriver.get(id) || [], atIdx, type));
  return out;
}

// Least squares for y = Xb with a small ridge, for the calibration fit.
function ols(X, y, ridge = 1e-3) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c]; }
  for (let a = 0; a < k; a++) A[a][a] += ridge * X.length;
  for (let i = 0; i < k; i++) {
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < k; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < k; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

const DEFAULTS = {
  beta: 0.75, bQual: 0.22, bPrac: 0.1,
  sigma: { superspeedway: 1.0, intermediate: 0.62, short_concrete: 0.7, short_flat: 0.66, large_flat: 0.66, road: 0.72, oneoff: 0.68 },
  dnf: { superspeedway: 0.17, intermediate: 0.08, short_concrete: 0.09, short_flat: 0.07, large_flat: 0.08, road: 0.08, oneoff: 0.09 },
  cautions: { superspeedway: 9, intermediate: 7, short_concrete: 9, short_flat: 7, large_flat: 6, road: 5, oneoff: 8 },
  bigOne: { prob: 0.55, share: 0.22 },
};

// Replay history from `startIdx`: predict each race from earlier races only, then fit the
// coefficients above. Falls back to DEFAULTS where history is too thin to trust a fit.
function calibrate(prep, { minPrior = 8 } = {}) {
  const X = [], Y = [], resid = {}, dnf = {}, cautions = {};
  for (const race of prep.races) {
    (dnf[race.type] ||= []).push(race.rows.filter(r => !r.running).length / race.rows.length);
    if (race.cautions !== null && race.cautions !== undefined) (cautions[race.type] ||= []).push(race.cautions);
    if (race.idx < minPrior) continue;
    const ratings = rateField(prep, race.rows.map(r => r.driverId), race.idx, race.type);
    for (const r of race.rows) {
      if (r.finishZ === null) continue;
      const mu = ratings.get(r.driverId).mu;
      X.push([mu, r.qualZ ?? 0, r.pracZ ?? 0, 1]); Y.push(r.finishZ);
      (resid[race.type] ||= []).push({ mu, q: r.qualZ ?? 0, p: r.pracZ ?? 0, f: r.finishZ });
    }
  }
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  out.samples = X.length;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  if (X.length >= 400) {
    const [beta, bQual, bPrac] = ols(X, Y);
    out.beta = Math.max(0.2, Math.min(1.5, beta));
    out.bQual = Math.max(0, Math.min(0.6, bQual));
    out.bPrac = Math.max(0, Math.min(0.4, bPrac));
    for (const [t, rs] of Object.entries(resid)) {
      if (rs.length < 150) continue;
      const e = rs.map(r => r.f - (out.beta * r.mu + out.bQual * r.q + out.bPrac * r.p));
      const m = mean(e);
      out.sigma[t] = +Math.sqrt(mean(e.map(v => (v - m) ** 2))).toFixed(3);
    }
  }
  for (const [t, v] of Object.entries(dnf)) if (v.length >= 4) out.dnf[t] = +mean(v).toFixed(3);
  for (const [t, v] of Object.entries(cautions)) if (v.length >= 4) out.cautions[t] = +mean(v).toFixed(1);
  // Superspeedway DNFs beyond the oval baseline come from multi-car crashes.
  const base = mean(OVAL.map(t => out.dnf[t]));
  out.dnf.individual = +base.toFixed(3);
  out.bigOne.share = +Math.max(0.05, Math.min(0.45, (out.dnf.superspeedway - base) / out.bigOne.prob)).toFixed(3);
  return out;
}

module.exports = { HALF_LIFE, K_SHRINK, ROOKIE_PRIOR, typeWeight, zscores, rankZ, prepare, rateDriver, rateField, calibrate, DEFAULTS };
