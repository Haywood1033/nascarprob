// POST /api/parlay?race={id}  body: { legs: [{kind:'finish', id, market, dec?} | {kind:'h2h', id, opp, dec?}] }
// Prices a custom ticket inside the race simulation (joint probability, fair odds, EV vs book).
const { getRaceContext } = require('../lib/race');
const { priceParlay } = require('../lib/parlay');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { sim } = await getRaceContext({ raceId: param(req, 'race') });
    const legs = (body(req).legs || []).slice(0, 8).map(l => ({ kind: l.kind === 'h2h' ? 'h2h' : 'finish', id: String(l.id), opp: l.opp ? String(l.opp) : undefined, market: String(l.market || 'top10'), dec: Number(l.dec) > 1 ? Number(l.dec) : null }));
    const r = priceParlay(sim, legs);
    send(res, r.error ? 400 : 200, r.error ? { error: r.error } : r);
  } catch (err) { fail(res, err); }
};
