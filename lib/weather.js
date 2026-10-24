// lib/weather.js — race-day weather at the track (Open-Meteo, free, no key).
//   forecast  api.open-meteo.com/v1/forecast          hourly temperature, cloud, rain, wind
//   ensemble  ensemble-api.open-meteo.com/v1/ensemble  GFS 31-member precipitation
//
// What matters for a stock car race:
//   - rain: NASCAR races don't run in rain on ovals. Rain after halfway (end of stage 2) can make
//     the race official right there, which hands the win to whoever leads at that point. The
//     share of ensemble members wet in the second half of the race window is the input.
//   - track temperature: hot, sunny asphalt loses grip; long-run cars gain. Estimated as air
//     temperature plus a solar term scaled by clear sky (a heuristic, labelled as such).
//   - wind: matters most in superspeedway draft lines and as a crosswind on long straights.

const { fetchJson, TTL } = require('./http');

const CARDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = deg => (deg === null || deg === undefined ? '—' : CARDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
const WET = 0.02; // inches in an hour: enough to stop an oval race
const RACE_HOURS = { superspeedway: 3.3, intermediate: 3.1, short_concrete: 3.2, short_flat: 2.9, large_flat: 3.2, road: 2.8, oneoff: 3.4 };
const UNITS = 'wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=GMT';

function conditionLabel(code) {
  if (code === null || code === undefined) return 'Unknown';
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return code >= 65 ? 'Heavy rain' : 'Rain';
  if (code <= 82) return 'Showers';
  return 'Thunderstorms';
}

const day = (iso, n = 0) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

function trackTemp(air, cloud, hourUtc, lon) {
  // Local solar hour from longitude; sun heats the surface roughly 10:00–17:00 local.
  const solar = ((hourUtc + lon / 15) % 24 + 24) % 24;
  const sun = Math.max(0, Math.sin(((solar - 7) / 12) * Math.PI));
  return Math.round(air + 32 * sun * (1 - (cloud ?? 50) / 100));
}

async function raceWeather(race) {
  const t = race.track;
  if (t.lat === null || t.lat === undefined) return { available: false, reason: `No coordinates for ${race.trackName || t.name}.` };
  const start = day(race.date, -1), end = day(race.date, 1);
  const q = `latitude=${t.lat}&longitude=${t.lon}&start_date=${start}&end_date=${end}&${UNITS}`;
  const [det, ens] = await Promise.all([
    fetchJson(`https://api.open-meteo.com/v1/forecast?${q}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m`, { ttlMs: TTL.short }),
    fetchJson(`https://ensemble-api.open-meteo.com/v1/ensemble?${q}&hourly=precipitation&models=gfs025`, { ttlMs: TTL.short }).catch(() => null),
  ]);
  const h = det.hourly || {};
  const green = Date.parse(race.date), dur = (RACE_HOURS[t.type] || 3.1) * 3600e3, half = green + dur / 2, finish = green + dur;
  const at = i => Date.parse(`${h.time[i]}Z`);
  const rows = (h.time || []).map((_, i) => ({
    time: new Date(at(i)).toISOString(), temp: h.temperature_2m?.[i] ?? null, humidity: h.relative_humidity_2m?.[i] ?? null,
    rainChance: h.precipitation_probability?.[i] ?? null, rain: h.precipitation?.[i] ?? null, cloud: h.cloud_cover?.[i] ?? null,
    wind: h.wind_speed_10m?.[i] ?? null, dir: h.wind_direction_10m?.[i] ?? null, dirLabel: cardinal(h.wind_direction_10m?.[i]),
    condition: conditionLabel(h.weather_code?.[i]),
  })).map(r => ({ ...r, trackTemp: r.temp === null ? null : trackTemp(r.temp, r.cloud, new Date(r.time).getUTCHours(), t.lon) }));
  const window = rows.filter(r => { const x = Date.parse(r.time); return x >= green - 3600e3 && x <= finish + 3600e3; });
  const during = rows.filter(r => { const x = Date.parse(r.time); return x >= green && x < finish; });

  // Ensemble: share of members wet in each half of the race window.
  let firstHalfWet = null, secondHalfWet = null, members = 0;
  if (ens?.hourly) {
    const eh = ens.hourly, keys = Object.keys(eh).filter(k => k === 'precipitation' || k.startsWith('precipitation_member'));
    members = keys.length;
    const eat = i => Date.parse(`${eh.time[i]}Z`);
    const wetIn = (a, b) => keys.filter(k => eh[k].some((v, i) => v >= WET && eat(i) >= a && eat(i) < b)).length / (keys.length || 1);
    firstHalfWet = wetIn(green, half); secondHalfWet = wetIn(half, finish);
  }
  const det2 = during.filter(r => Date.parse(r.time) >= half);
  const detWet = det2.length ? Math.max(...det2.map(r => (r.rainChance ?? 0) / 100)) : 0;
  const secondHalf = secondHalfWet ?? detWet;
  // Not every wet hour ends a race (short showers get dried and restarted): 60% of the wet share.
  const rainEndProb = +Math.min(0.85, 0.6 * secondHalf).toFixed(3);
  const temps = during.map(r => r.temp).filter(v => v !== null);
  const tt = during.map(r => r.trackTemp).filter(v => v !== null);
  const g = during[0] || window[0] || {};
  return {
    available: true, generatedAt: new Date().toISOString(),
    greenFlag: race.date, expectedFinish: new Date(finish).toISOString(), halfway: new Date(half).toISOString(),
    hours: window,
    summary: {
      condition: g.condition, tempAtGreen: g.temp ?? null, tempHigh: temps.length ? Math.max(...temps) : null, tempLow: temps.length ? Math.min(...temps) : null,
      trackTempAtGreen: g.trackTemp ?? null, trackTempHigh: tt.length ? Math.max(...tt) : null,
      cloudAvg: during.length ? Math.round(during.reduce((s, r) => s + (r.cloud ?? 0), 0) / during.length) : null,
      windAvg: during.length ? +(during.reduce((s, r) => s + (r.wind ?? 0), 0) / during.length).toFixed(1) : null,
      windDir: g.dirLabel || '—',
      rainChanceMax: during.length ? Math.max(...during.map(r => r.rainChance ?? 0)) : null,
      firstHalfWet, secondHalfWet, members,
      rainEndProb,
      night: Number.isFinite(g.temp) && (((new Date(race.date).getUTCHours() + t.lon / 15) % 24 + 24) % 24) >= 18.5,
    },
  };
}

module.exports = { raceWeather, cardinal, conditionLabel, trackTemp, RACE_HOURS, WET };
