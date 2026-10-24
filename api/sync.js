// GET /api/sync?season=2025 — backfill completed races into Postgres. Each call does as much as
// fits in ~45s and reports `remaining`; call again until it reaches 0. The weekly cron (?cron=1)
// syncs this season and grades last week's snapshot.
const { syncSeason } = require('../lib/store');
const { gradeAll } = require('../lib/grading');
const db = require('../lib/db');
const { param, numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (!db.hasDb) return send(res, 400, { error: 'DATABASE_URL is not set — history sync needs Postgres.' });
    const season = numParam(req, 'season', new Date().getUTCFullYear(), { min: 2022, max: 2100 });
    const result = await syncSeason(season, { deadline: Date.now() + 45000 });
    const grading = param(req, 'cron') ? await gradeAll({ deadline: Date.now() + 8000 }).catch(err => ({ error: err.message })) : null;
    send(res, 200, { ...result, grading });
  } catch (err) { fail(res, err); }
};
