// POST /api/dfs?race={id}  body: { csv: "<salary export>" } — projections (mean, p10/p50/p90 and
// the points split) for every driver, joined to salaries when a CSV is sent. The lineup
// optimizer runs in the browser (lib/dfs-optimizer.js in a Web Worker).
const { getRaceContext } = require('../lib/race');
const { parseSalaries, projections, simSample } = require('../lib/dfs');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload, sim } = await getRaceContext({ raceId: param(req, 'race') });
    if (!sim) return send(res, 409, { error: 'No field for this race yet.' });
    const csv = body(req).csv || '';
    const sal = csv ? parseSalaries(csv, payload.players) : { rows: [], unmatched: [] };
    if (sal.error) return send(res, 400, { error: sal.error });
    const proj = projections(sim, payload, sal.rows);
    // The race-by-race sample only matters once salaries exist (it feeds the lineup scorer).
    const sample = sal.rows.length ? simSample(sim, proj.filter(p => p.salary).map(p => p.id)) : null;
    send(res, 200, { projections: proj, sample, salaries: { matched: sal.rows.length, unmatched: sal.unmatched }, startsKnown: payload.qualifyingKnown });
  } catch (err) { fail(res, err); }
};
