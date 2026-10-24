// GET /api/health — fetches every feed the model depends on and reports what came back, so a
// changed or missing NASCAR feed shows up here first. ?race={id} adds an audit of one race:
// what each feed returned for it and how it parsed.
const nascar = require('../lib/nascar');
const { raceWeather } = require('../lib/weather');
const { dataStatus } = require('../lib/store');
const { param, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t, ...detail }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}

module.exports = async (req, res) => {
  const year = new Date().getUTCFullYear();
  let schedule = [];
  const checks = [];
  checks.push(await check('Schedule (race list)', async () => {
    schedule = await nascar.fetchSchedule(year);
    const prev = await nascar.fetchSchedule(year - 1).catch(() => []);
    const unknown = schedule.filter(r => !r.track.known).map(r => r.trackName);
    return { races: schedule.length, previousSeason: prev.length, firstRace: schedule[0]?.name, unknownTracks: [...new Set(unknown)] };
  }));
  const now = Date.now();
  const done = [...schedule].reverse().find(r => Date.parse(r.date) + 6 * 3600e3 < now && !r.exhibition);
  const next = schedule.find(r => Date.parse(r.date) + 5 * 3600e3 > now && !r.exhibition);
  if (done) {
    checks.push(await check(`Weekend feed: last race (${done.name})`, async () => {
      const w = await nascar.fetchWeekend(done.season, done.id);
      return { results: w.results.length, complete: w.complete, runs: w.runs.map(r => `${r.kind}: ${r.results.length}`), stages: w.stageResults.length, cautions: w.cautions, sample: w.results[0] || null };
    }));
    checks.push(await check('Loop data: last race', async () => { const l = await nascar.fetchLoop(done.season, done.id); return { drivers: l.length, withRating: l.filter(x => x.rating !== null).length, sample: l[0] || null }; }));
    checks.push(await check('Lap times: last race', async () => { const p = await nascar.fetchLapPace(done.season, done.id); return { drivers: p.length, sample: p[0] || null }; }));
  }
  if (next) {
    checks.push(await check(`Weekend feed: next race (${next.name})`, async () => {
      const w = await nascar.fetchWeekend(next.season, next.id);
      return { entries: w.entries.length, runs: w.runs.map(r => `${r.kind}: ${r.results.length}`) };
    }));
    checks.push(await check('Weather (Open-Meteo)', async () => {
      const wx = await raceWeather(next);
      return wx.available ? { hours: wx.hours.length, rainEndProb: wx.summary.rainEndProb, members: wx.summary.members } : { note: wx.reason };
    }));
  }
  checks.push(await check('Live feed', async () => { const l = await nascar.fetchLive(); return { raceId: l.raceId, lap: l.lap, flag: l.flag, vehicles: l.vehicles.length }; }));
  checks.push(await check('History store', async () => dataStatus()));

  let audit = null;
  const raceId = param(req, 'race');
  if (raceId) {
    const race = schedule.find(r => r.id === String(raceId)) || (await nascar.fetchSchedule(year - 1).catch(() => [])).find(r => r.id === String(raceId));
    audit = race ? await check(`Audit ${race.name}`, async () => {
      const w = await nascar.fetchWeekend(race.season, race.id);
      return { race, results: w.results.length, entries: w.entries.length, runs: w.runs.map(r => ({ name: r.name, kind: r.kind, results: r.results.length })), stageResults: w.stageResults.map(s => s.order.length), cautions: w.cautions, complete: w.complete };
    }) : { ok: false, error: `Race ${raceId} not on the ${year} or ${year - 1} schedule` };
  }
  send(res, 200, { ok: checks.every(c => c.ok), generatedAt: new Date().toISOString(), checks, audit });
};
