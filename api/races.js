// GET /api/races?season={year} — the Cup schedule for the race picker (exhibitions left out).
const { listRaces } = require('../lib/race');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const season = numParam(req, 'season', new Date().getUTCFullYear(), { min: 2022, max: 2100 });
    const races = await listRaces(season);
    send(res, 200, { season, races: races.map(r => ({ id: r.id, name: r.name, date: r.date, track: r.track.name, type: r.track.type, laps: r.laps })) }, 3600);
  } catch (err) { fail(res, err); }
};
