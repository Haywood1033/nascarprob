// GET /api/status — what history the model is running on (database seasons, or live feeds).
const { dataStatus } = require('../lib/store');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await dataStatus()); } catch (err) { fail(res, err); }
};
