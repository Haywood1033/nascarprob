// GET /api/backtest?races=30 — leak-free backtest of the most recent completed races.
const { runBacktest } = require('../lib/backtest');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const out = await runBacktest({ races: numParam(req, 'races', 30, { min: 5, max: 120 }), sims: numParam(req, 'sims', 3000, { min: 1000, max: 8000 }) });
    send(res, 200, out); // never CDN-cached: the answer changes whenever history is synced
  } catch (err) { fail(res, err); }
};
