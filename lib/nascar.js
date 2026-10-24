// lib/nascar.js — NASCAR's public JSON feeds (cf.nascar.com), parsed into the shapes the model
// uses. These are undocumented feeds, so every field is read through `pick` with the spellings
// seen in the wild, and anything missing degrades to null instead of throwing. /api/health
// reports what each feed actually returned, which is how a shape change gets noticed.

const { fetchJson, TTL } = require('./http');
const { findTrack } = require('./tracks');

const CUP = 1;
const BASE = 'https://cf.nascar.com';
const URLS = {
  raceList: year => `${BASE}/cacher/${year}/race_list_basic.json`,
  weekend: (year, raceId, series = CUP) => `${BASE}/cacher/${year}/${series}/${raceId}/weekend-feed.json`,
  lapTimes: (year, raceId, series = CUP) => `${BASE}/cacher/${year}/${series}/${raceId}/lap-times.json`,
  loop: (year, raceId, series = CUP) => `${BASE}/loopstats/prod/${year}/${series}/${raceId}.json`,
  live: () => `${BASE}/live/feeds/live-feed.json`,
};

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function pick(o, keys) {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}
const str = v => (v === undefined || v === null ? null : String(v));

// ── Schedule ────────────────────────────────────────────────────────────────────────────
// race_list_basic is keyed by series ("series_1" = Cup). Exhibitions (the Clash, the All-Star
// Race, Duels) carry no points and very different formats; they are kept on the list but
// flagged so ratings and grading can skip them.
const EXHIBITION_RE = /clash|all-?star|duel|open\b|exhibition/i;
function parseRace(r, season) {
  const name = str(pick(r, ['race_name', 'raceName', 'name'])) || 'Race';
  const trackName = str(pick(r, ['track_name', 'trackName', 'track'])) || '';
  const date = str(pick(r, ['race_date', 'date_scheduled', 'raceDate', 'date']));
  const winner = pick(r, ['winner_driver_id', 'winnerDriverId']);
  const stages = [pick(r, ['stage_1_laps']), pick(r, ['stage_2_laps']), pick(r, ['stage_3_laps'])].map(num).filter(v => v > 0);
  return {
    id: str(pick(r, ['race_id', 'raceId', 'id'])),
    season: Number(season),
    name,
    track: findTrack(`${trackName} ${/road|street|roval/i.test(name) ? name : ''}`.trim() || name),
    trackName,
    date: date ? new Date(/Z|[+-]\d\d:?\d\d$/.test(date) ? date : `${date}Z`).toISOString() : null,
    laps: num(pick(r, ['scheduled_laps', 'scheduledLaps', 'laps'])),
    miles: num(pick(r, ['scheduled_distance', 'scheduledDistance'])),
    stageLaps: stages,
    winnerId: winner ? str(winner) : null,
    exhibition: EXHIBITION_RE.test(name) || pick(r, ['race_type_id']) === 2,
  };
}

async function fetchSchedule(year, { ttlMs = TTL.long } = {}) {
  const raw = await fetchJson(URLS.raceList(year), { ttlMs });
  const list = raw?.[`series_${CUP}`] || raw?.series_1 || (Array.isArray(raw) ? raw : []);
  return list.map(r => parseRace(r, year)).filter(r => r.id && r.date).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Weekend feed: entry list, practice/qualifying runs, results ─────────────────────────
const RUN_TYPE = { 1: 'practice', 2: 'qualifying', 3: 'race' };
function parseRun(run) {
  const name = str(pick(run, ['run_name', 'runName'])) || '';
  const t = num(pick(run, ['run_type', 'runType']));
  const kind = RUN_TYPE[t] || (/qual/i.test(name) ? 'qualifying' : /pract/i.test(name) ? 'practice' : /race/i.test(name) ? 'race' : 'other');
  const results = (pick(run, ['results', 'Results']) || []).map(x => ({
    driverId: str(pick(x, ['driver_id', 'driverId', 'NASCARDriverID'])),
    name: str(pick(x, ['driver_name', 'driver_fullname', 'full_name', 'FullName'])),
    car: str(pick(x, ['car_number', 'vehicle_number', 'Number'])),
    pos: num(pick(x, ['finishing_position', 'position', 'qualifying_position'])),
    bestSpeed: num(pick(x, ['best_lap_speed', 'best_speed', 'speed'])),
    bestTime: num(pick(x, ['best_lap_time', 'best_time'])),
    avg10: num(pick(x, ['best_10_lap_average', 'avg_10_lap', 'ten_lap_average'])),
    laps: num(pick(x, ['laps_completed', 'laps'])),
  })).filter(x => x.driverId);
  return { id: str(pick(run, ['run_id', 'runId'])), name, kind, results };
}

function parseResult(x) {
  const status = str(pick(x, ['finishing_status', 'status', 'finishingStatus'])) || 'Running';
  return {
    driverId: str(pick(x, ['driver_id', 'driverId'])),
    name: str(pick(x, ['driver_fullname', 'driver_name', 'full_name'])),
    car: str(pick(x, ['car_number', 'vehicle_number'])),
    team: str(pick(x, ['team_name', 'owner_fullname'])),
    make: str(pick(x, ['car_make', 'manufacturer', 'vehicle_manufacturer'])),
    start: num(pick(x, ['starting_position', 'start_position', 'starting_pos'])),
    finish: num(pick(x, ['finishing_position', 'finish_position', 'position'])),
    lapsCompleted: num(pick(x, ['laps_completed', 'laps'])),
    lapsLed: num(pick(x, ['laps_led'])) || 0,
    status,
    running: /running/i.test(status),
    points: num(pick(x, ['points_earned', 'points'])),
  };
}

async function fetchWeekend(season, raceId, { live = false } = {}) {
  const raw = await fetchJson(URLS.weekend(season, raceId), { ttlMs: live ? TTL.live : TTL.short });
  const wr = (pick(raw, ['weekend_race', 'weekendRace']) || [])[0] || {};
  const runs = (pick(raw, ['weekend_runs', 'weekendRuns']) || []).map(parseRun);
  const results = (pick(wr, ['results']) || []).map(parseResult).filter(r => r.driverId);
  const stageRes = (pick(wr, ['stage_results', 'stageResults']) || []).map(s => ({
    stage: num(pick(s, ['stage_number', 'stage'])),
    order: (pick(s, ['results']) || []).map(x => str(pick(x, ['driver_id', 'driverId']))).filter(Boolean),
  }));
  const cautions = num(pick(wr, ['number_of_cautions', 'cautions']));
  const entries = new Map();
  for (const r of results) entries.set(r.driverId, { driverId: r.driverId, name: r.name, car: r.car, team: r.team, make: r.make });
  for (const run of runs) for (const x of run.results) if (!entries.has(x.driverId)) entries.set(x.driverId, { driverId: x.driverId, name: x.name, car: x.car });
  return {
    raceId: str(raceId), season: Number(season),
    results, runs, stageResults: stageRes, cautions,
    leadChanges: num(pick(wr, ['number_of_lead_changes'])),
    entries: [...entries.values()],
    // A race is complete when results carry finishing positions for most of the field.
    complete: results.length >= 20 && results.filter(r => r.finish).length >= results.length * 0.9,
  };
}

// ── Lap times → green-flag pace ──────────────────────────────────────────────────────────
// For each driver, the median lap time over green-flag laps (skipping each restart lap and
// lap 1), as a percentage behind the fastest median in the field. Pace on track is the best
// single measure of how fast a car was, independent of pit road, wrecks and strategy.
function greenPace(raw) {
  const flags = pick(raw, ['flags', 'Flags']) || [];
  const yellow = new Set();
  for (const f of flags) {
    const lap = num(pick(f, ['LapsCompleted', 'lap', 'Lap']));
    const state = num(pick(f, ['FlagState', 'flag_state', 'state']));
    if (lap !== null && state !== null && state !== 1) { yellow.add(lap); yellow.add(lap + 1); }
  }
  const drivers = pick(raw, ['laps', 'Laps', 'drivers']) || [];
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const out = [];
  for (const d of drivers) {
    const id = str(pick(d, ['NASCARDriverID', 'driver_id', 'driverId']));
    const laps = (pick(d, ['Laps', 'laps']) || [])
      .map(l => ({ lap: num(pick(l, ['Lap', 'lap'])), t: num(pick(l, ['LapTime', 'lap_time', 'time'])) }))
      .filter(l => l.lap > 1 && l.t > 0 && !yellow.has(l.lap));
    if (!id || laps.length < 10) continue;
    // Drop the slowest quarter: pit-cycle and traffic laps that survived the flag filter.
    const times = laps.map(l => l.t).sort((a, b) => a - b).slice(0, Math.max(5, Math.floor(laps.length * 0.75)));
    out.push({ driverId: id, median: med(times), greenLaps: laps.length });
  }
  const best = Math.min(...out.map(o => o.median));
  return out.map(o => ({ ...o, pctOff: best > 0 ? +((o.median / best - 1) * 100).toFixed(3) : null }));
}

async function fetchLapPace(season, raceId) {
  return greenPace(await fetchJson(URLS.lapTimes(season, raceId), { ttlMs: TTL.long }));
}

// ── Loop data (driver rating, average running position, fastest laps, quality passes) ──
function parseLoop(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  const drivers = (arr.find(x => pick(x, ['drivers']))?.drivers) || pick(arr[0], ['drivers']) || [];
  return drivers.map(d => ({
    driverId: str(pick(d, ['driver_id', 'driverId'])),
    rating: num(pick(d, ['rating', 'driver_rating'])),
    avgPos: num(pick(d, ['avg_ps', 'average_position', 'avgPos'])),
    fastLaps: num(pick(d, ['fast_laps', 'fastest_laps'])),
    ledLaps: num(pick(d, ['lead_laps', 'laps_led'])),
    top15Laps: num(pick(d, ['top15_laps'])),
    qualityPasses: num(pick(d, ['quality_passes'])),
    greenPasses: num(pick(d, ['passes_gf', 'green_flag_passes'])),
    laps: num(pick(d, ['laps'])),
  })).filter(d => d.driverId);
}

async function fetchLoop(season, raceId) {
  return parseLoop(await fetchJson(URLS.loop(season, raceId), { ttlMs: TTL.long }));
}

// ── Live feed ────────────────────────────────────────────────────────────────────────────
const FLAG = { 1: 'green', 2: 'caution', 3: 'red', 4: 'white', 8: 'checkered', 9: 'pre-race' };
function parseLive(raw) {
  const vehicles = (pick(raw, ['vehicles']) || []).map(v => {
    const led = (pick(v, ['laps_led']) || []).reduce((s, x) => s + Math.max(0, (num(x.end_lap) || 0) - (num(x.start_lap) || 0) + 1), 0);
    return {
      driverId: str(pick(v.driver || {}, ['driver_id', 'driverId'])),
      name: str(pick(v.driver || {}, ['full_name', 'name'])),
      car: str(pick(v, ['vehicle_number'])),
      pos: num(pick(v, ['running_position'])),
      lapsLed: led,
      lapsCompleted: num(pick(v, ['laps_completed'])),
      delta: num(pick(v, ['delta'])),
      status: num(pick(v, ['status'])),
      onTrack: pick(v, ['is_on_track']) !== false,
    };
  }).filter(v => v.driverId);
  const stage = pick(raw, ['stage']) || {};
  return {
    raceId: str(pick(raw, ['race_id'])),
    seriesId: num(pick(raw, ['series_id'])),
    lap: num(pick(raw, ['lap_number'])),
    lapsInRace: num(pick(raw, ['laps_in_race'])),
    flag: FLAG[num(pick(raw, ['flag_state']))] || 'unknown',
    stage: { num: num(pick(stage, ['stage_num'])), endsLap: num(pick(stage, ['finish_at_lap'])) },
    vehicles: vehicles.sort((a, b) => (a.pos || 99) - (b.pos || 99)),
  };
}

async function fetchLive() {
  return parseLive(await fetchJson(URLS.live(), { ttlMs: 15 * 1000, timeoutMs: 8000 }));
}

module.exports = { CUP, URLS, fetchSchedule, fetchWeekend, fetchLapPace, fetchLoop, fetchLive, parseRace, parseRun, parseResult, greenPace, parseLoop, parseLive };
