// GET /api/live — NASCAR's live feed, parsed: lap, flag, stage and running order. Polled by the
// page during a race; cached 15 seconds at the edge.
const { fetchLive } = require('../lib/nascar');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await fetchLive(), 15); } catch (err) { fail(res, err); }
};
