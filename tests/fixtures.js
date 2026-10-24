// Synthetic NASCAR + Open-Meteo responses for tests and layout screenshots. Shapes follow
// lib/nascar.js / lib/weather.js; every driver, number and result is generated (fake names,
// fake speeds), never presented as real data.
const { makeRng } = require('../lib/rng');
const { TRACKS } = require('../lib/tracks');

const FIRST = ['Ace', 'Bo', 'Cal', 'Dax', 'Eli', 'Fritz', 'Gage', 'Hal', 'Ike', 'Jett', 'Kyle', 'Lane', 'Mack', 'Nash', 'Otis', 'Pike', 'Quinn', 'Rex', 'Sully', 'Tate'];
const LAST = ['Baxter', 'Colby', 'Dutton', 'Ferris', 'Grady', 'Hollis', 'Kemper', 'Landry', 'Mosley', 'Pruett'];
const MAKES = ['Chevrolet', 'Ford', 'Toyota'];
const TYPE_SIGMA = { superspeedway: 1.6, intermediate: 0.65, short_concrete: 0.8, short_flat: 0.7, large_flat: 0.7, road: 0.8, oneoff: 0.75 };
const TYPE_DNF = { superspeedway: 0.1, intermediate: 0.07, short_concrete: 0.08, short_flat: 0.06, large_flat: 0.07, road: 0.07, oneoff: 0.08 };

function makeDrivers(n = 38, seed = 7) {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => {
    const base = 1.6 - (3.4 * i) / (n - 1) + rng.normal() * 0.15;
    const byType = {};
    for (const t of Object.keys(TYPE_SIGMA)) byType[t] = base + rng.normal() * 0.3 + (t === 'road' && i % 7 === 3 ? 0.9 : 0) + (t === 'superspeedway' ? -base * 0.5 : 0);
    return { id: String(4000 + i), name: `${FIRST[i % 20]} ${LAST[Math.floor(i / 4) % 10]}`, car: String([5, 9, 11, 12, 20, 24, 19, 22, 45, 1, 8, 23, 17, 2, 54, 48, 6, 14, 3, 99, 21, 47, 7, 38, 43, 34, 41, 16, 4, 10, 42, 77, 60, 71, 35, 51, 15, 88][i % 38]), make: MAKES[i % 3], team: `Team ${String.fromCharCode(65 + (i % 9))}`, byType };
  });
}

const OVALS = TRACKS.filter(t => !['daytona-road', 'bowman-gray', 'rockingham', 'san-diego-street', 'indy-road', 'mexico-city'].includes(t.key));

// Seasons of weekly races from mid-February; race times 19:00 UTC on Sundays.
function makeSchedule(seasons) {
  const races = [];
  let id = 5000;
  for (const season of seasons) {
    const start = Date.UTC(season, 1, 16, 19);
    for (let k = 0; k < 38; k++) {
      const t = OVALS[(k + season) % OVALS.length];
      const laps = t.type === 'road' ? 90 : t.miles >= 2 ? 200 : t.miles <= 0.75 ? 400 : 267;
      races.push({ id: String(id++), season, track: t, date: new Date(start + k * 7 * 864e5).toISOString(), laps, stages: [Math.round(laps * 0.25), Math.round(laps * 0.5)] });
    }
  }
  return races;
}

function simulateRace(race, drivers, seed) {
  const rng = makeRng(seed);
  const type = race.track.type;
  const qual = drivers.map(d => ({ d, q: d.byType[type] + rng.normal() * 0.6 })).sort((a, b) => b.q - a.q);
  const startPos = new Map(qual.map((x, i) => [x.d.id, i + 1]));
  const perf = drivers.map(d => ({ d, p: d.byType[type] + rng.normal() * TYPE_SIGMA[type] - (startPos.get(d.id) - 18) * 0.01 }));
  const bigOne = type === 'superspeedway' && rng.uniform() < 0.6;
  const out = new Set();
  for (const x of perf) if (rng.uniform() < TYPE_DNF[type]) out.add(x.d.id);
  if (bigOne) { const ids = perf.map(x => x.d.id).filter(() => rng.uniform() < 0.25); ids.forEach(i => out.add(i)); }
  const running = perf.filter(x => !out.has(x.d.id)).sort((a, b) => b.p - a.p);
  const dnf = perf.filter(x => out.has(x.d.id)).map(x => ({ ...x, lap: Math.floor(rng.uniform() * race.laps * 0.9) + 5 })).sort((a, b) => b.lap - a.lap);
  const order = [...running, ...dnf];
  const ledShares = running.slice(0, 8).map((x, i) => Math.exp(-i * 0.6 + rng.normal() * 0.4));
  const sum = ledShares.reduce((a, b) => a + b, 0);
  let left = race.laps;
  const led = new Map();
  running.slice(0, 8).forEach((x, i) => { const n = i === 7 ? left : Math.min(left, Math.round((race.laps * ledShares[i]) / sum)); led.set(x.d.id, n); left -= n; });
  return order.map((x, i) => {
    const isDnf = out.has(x.d.id);
    const avgPos = Math.max(1, Math.min(drivers.length, (i + 1) * 0.6 + startPos.get(x.d.id) * 0.25 + rng.normal() * 2.5 + 3));
    return {
      driver_id: x.d.id, driver_fullname: x.d.name, car_number: x.d.car, car_make: x.d.make, team_name: x.d.team,
      starting_position: startPos.get(x.d.id), finishing_position: i + 1,
      laps_completed: isDnf ? x.lap : race.laps, laps_led: led.get(x.d.id) || 0,
      finishing_status: isDnf ? (bigOne && rng.uniform() < 0.7 ? 'Accident' : rng.uniform() < 0.5 ? 'Engine' : 'Accident') : 'Running',
      points_earned: Math.max(1, 41 - i),
      _avgPos: +avgPos.toFixed(1), _perf: x.p, _fast: Math.max(0, Math.round((isDnf ? 0.2 : 1) * race.laps * Math.max(0, 0.12 - i * 0.004) + rng.normal())),
    };
  });
}

function installMockFetch({ now, seasons = [2024, 2025, 2026], live = null } = {}) {
  const drivers = makeDrivers();
  const schedule = makeSchedule(seasons);
  const nowMs = Date.parse(now);
  const results = new Map();
  const resultsFor = r => { if (!results.has(r.id)) results.set(r.id, simulateRace(r, drivers, Number(r.id))); return results.get(r.id); };
  const next = schedule.find(r => Date.parse(r.date) + 4 * 3600e3 > nowMs);
  const raceById = new Map(schedule.map(r => [r.id, r]));
  const real = global.fetch;
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const nf = () => ({ ok: false, status: 404, json: async () => ({}) });

  global.fetch = async (url) => {
    const u = String(url);
    let m;
    if ((m = u.match(/cacher\/(\d{4})\/race_list_basic\.json/))) {
      const year = Number(m[1]);
      return ok({ series_1: schedule.filter(r => r.season === year).map(r => {
        const done = Date.parse(r.date) + 4 * 3600e3 < nowMs;
        return { race_id: Number(r.id), race_name: `${r.track.name.split(' ')[0]} ${r.laps * (r.track.miles || 1) > 300 ? 400 : 300} (synthetic)`, track_name: r.track.name, race_date: r.date.replace('.000Z', ''),
          scheduled_laps: r.laps, scheduled_distance: Math.round(r.laps * (r.track.miles || 1)), stage_1_laps: r.stages[0], stage_2_laps: r.stages[1], stage_3_laps: r.laps - r.stages[0] - r.stages[1],
          winner_driver_id: done ? Number(resultsFor(r)[0].driver_id) : null, race_type_id: 1 };
      }) });
    }
    if ((m = u.match(/cacher\/\d{4}\/1\/(\d+)\/weekend-feed\.json/))) {
      const r = raceById.get(m[1]); if (!r) return nf();
      const done = Date.parse(r.date) + 4 * 3600e3 < nowMs;
      const res = resultsFor(r);
      const rng = makeRng(Number(r.id) + 11);
      const pr = drivers.map(d => ({ d, s: d.byType[r.track.type] + rng.normal() * 0.7 })).sort((a, b) => b.s - a.s);
      const runs = [
        { run_id: 1, run_name: 'Practice', run_type: 1, results: pr.map((x, i) => ({ driver_id: Number(x.d.id), driver_name: x.d.name, car_number: x.d.car, finishing_position: i + 1, best_lap_speed: +(180 - i * 0.15).toFixed(3), laps_completed: 30 })) },
        { run_id: 2, run_name: 'Qualifying', run_type: 2, results: [...res].sort((a, b) => a.starting_position - b.starting_position).map(x => ({ driver_id: Number(x.driver_id), driver_name: x.driver_fullname, car_number: x.car_number, finishing_position: x.starting_position, best_lap_speed: +(181 - x.starting_position * 0.12).toFixed(3) })) },
      ];
      const stage = k => { const sr = makeRng(Number(r.id) * 10 + k); return res.map(x => ({ x, v: x._perf + sr.normal() * 0.5 - (k === 1 ? x.starting_position * 0.02 : 0) })).sort((a, b) => b.v - a.v).map(({ x }) => ({ driver_id: Number(x.driver_id) })); };
      return ok({ weekend_race: [{ race_id: Number(r.id), number_of_cautions: r.track.type === 'superspeedway' ? 9 : 6, number_of_lead_changes: 14,
        results: done ? res.map(({ _avgPos, _perf, _fast, ...x }) => ({ ...x, driver_id: Number(x.driver_id) })) : [],
        stage_results: done ? [{ stage_number: 1, results: stage(1).slice(0, 10) }, { stage_number: 2, results: stage(2).slice(0, 10) }] : [] }],
        weekend_runs: Date.parse(r.date) - 3 * 864e5 < nowMs ? runs : [] });
    }
    if ((m = u.match(/loopstats\/prod\/\d{4}\/1\/(\d+)\.json/))) {
      const r = raceById.get(m[1]); if (!r || Date.parse(r.date) + 4 * 3600e3 > nowMs) return nf();
      return ok([{ race_id: Number(r.id), drivers: resultsFor(r).map(x => ({ driver_id: Number(x.driver_id), avg_ps: x._avgPos, rating: +Math.max(25, 150 - x._avgPos * 3.2 - x.finishing_position * 0.6).toFixed(1), fast_laps: x._fast, lead_laps: x.laps_led, quality_passes: Math.round(40 - x._avgPos), laps: x.laps_completed })) }]);
    }
    if ((m = u.match(/cacher\/\d{4}\/1\/(\d+)\/lap-times\.json/))) {
      const r = raceById.get(m[1]); if (!r || Date.parse(r.date) + 4 * 3600e3 > nowMs) return nf();
      const rng = makeRng(Number(r.id) + 3), base = (r.track.miles || 1.5) / 175 * 3600;
      const res = resultsFor(r), best = Math.max(...res.map(x => x._perf));
      const laps = Math.min(r.laps, 120);
      return ok({ laps: res.map(x => ({ Number: x.car_number, FullName: x.driver_fullname, NASCARDriverID: Number(x.driver_id),
        Laps: Array.from({ length: Math.min(laps, x.laps_completed) }, (_, k) => ({ Lap: k + 1, LapTime: +(base * (1 + (best - x._perf) * 0.0025) + Math.abs(rng.normal()) * 0.25).toFixed(3) })) })),
        flags: [{ LapsCompleted: 30, FlagState: 2 }, { LapsCompleted: 31, FlagState: 2 }, { LapsCompleted: 70, FlagState: 2 }] });
    }
    if (u.includes('/live/feeds/live-feed.json')) {
      if (!live || !next) return ok({ race_id: 0, vehicles: [] });
      const res = resultsFor(next);
      return ok({ race_id: Number(next.id), series_id: 1, lap_number: live.lap, laps_in_race: next.laps, flag_state: 1, stage: { stage_num: 2, finish_at_lap: next.stages[0] + next.stages[1] },
        vehicles: [...res].sort((a, b) => a.starting_position - b.starting_position).map((x, i) => ({ running_position: i + 1, vehicle_number: x.car_number, driver: { driver_id: Number(x.driver_id), full_name: x.driver_fullname }, laps_led: i === 0 ? [{ start_lap: 1, end_lap: live.lap }] : [], laps_completed: live.lap, status: 1 })) });
    }
    if (u.includes('ensemble-api.open-meteo')) return ok(meteo(next, true));
    if (u.includes('open-meteo')) return ok(meteo(next, false));
    return nf();
  };
  return { restore: () => { global.fetch = real; }, drivers, schedule, next };
}

// Hourly weather around the next race: dry morning, a band of showers mid-race in the
// ensemble so rain-shortened odds have something to show.
function meteo(race, ensemble) {
  const day = race ? race.date.slice(0, 10) : '2026-10-25';
  const time = [], temp = [], pp = [], pr = [], wind = [], dir = [], cloud = [], hum = [], code = [];
  for (let d = -1; d <= 1; d++) {
    const date = new Date(Date.parse(day) + d * 864e5).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      const race = d === 0 && h >= 20 && h <= 22;
      temp.push(+(64 + 14 * Math.sin(Math.max(0, h - 13) / 12 * Math.PI)).toFixed(0)); pp.push(race ? 45 : 10); pr.push(race ? 0.03 : 0);
      wind.push(+(6 + (h % 8)).toFixed(1)); dir.push(220); cloud.push(race ? 85 : 30); hum.push(race ? 80 : 50); code.push(race ? 61 : 1);
    }
  }
  if (ensemble) {
    const rng = makeRng(23), hourly = { time, precipitation: pr };
    for (let k = 1; k <= 30; k++) hourly[`precipitation_member${String(k).padStart(2, '0')}`] = pr.map((v, i) => (rng.uniform() < (v ? 0.45 : 0.03) ? +(0.02 + rng.uniform() * 0.08).toFixed(3) : 0));
    return { utc_offset_seconds: 0, hourly };
  }
  return { utc_offset_seconds: 0, timezone: 'GMT', hourly: { time, temperature_2m: temp, precipitation_probability: pp, precipitation: pr, wind_speed_10m: wind, wind_direction_10m: dir, cloud_cover: cloud, relative_humidity_2m: hum, weather_code: code } };
}

module.exports = { installMockFetch, makeDrivers, makeSchedule };
