// GET /api/race?race={id}&season={year} — the race payload every tab reads: the field with
// ratings, odds, DFS projections, weather and the written briefing. No race id = the current or
// next race on the schedule.
const { getRaceContext } = require('../lib/race');
const { writeup } = require('../lib/weather-writeup');
const { param, numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload } = await getRaceContext({ raceId: param(req, 'race'), season: numParam(req, 'season', null) });
    send(res, 200, { ...payload, briefing: writeup(payload) }, payload.state === 'in' ? 0 : 120);
  } catch (err) { fail(res, err); }
};
