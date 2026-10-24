// POST /api/plays?race={id}  body: { book: "<pasted prices>" } — Best plays: head-to-head and
// finishing targets and 3/4/5-leg parlays, ranked by value when prices are pasted, by model
// strength when not. Returns the parsed book too, so the UI shows what was matched or skipped.
const { getRaceContext } = require('../lib/race');
const { buildPlays } = require('../lib/plays');
const { parseBook } = require('../lib/book');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload, sim } = await getRaceContext({ raceId: param(req, 'race') });
    if (!sim) return send(res, 409, { error: 'No field for this race yet, so there is nothing to price.' });
    const book = parseBook(body(req).book || '', payload.players);
    send(res, 200, { ...buildPlays(payload, sim, book.rows), book: { matched: book.rows.length, skipped: book.skipped } });
  } catch (err) { fail(res, err); }
};
