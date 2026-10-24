// lib/book.js — pasted sportsbook prices → priced legs the model can rank against. One line per
// price, comma or tab separated, American or decimal odds:
//   Driver Name, win, +450
//   Driver Name, top 10, -150
//   Driver A vs Driver B, h2h, -120, +100      (second price is optional: Driver B's side)
// Names are matched to the field leniently (lib/names). Lines that don't parse are returned so
// the UI can show exactly what was skipped and why.

const { buildMatcher } = require('./names');

const MARKET = [
  [/^(win|winner|outright|to win)$/, 'win'],
  [/^top\s*-?\s*3$/, 'top3'], [/^top\s*-?\s*5$/, 'top5'], [/^top\s*-?\s*10$/, 'top10'], [/^top\s*-?\s*20$/, 'top20'],
  [/^(h2h|head\s*to\s*head|matchup|vs)$/, 'h2h'],
];

function toDecimal(raw) {
  const s = String(raw || '').trim().replace('−', '-').replace(/^\+/, '+');
  if (!s) return null;
  if (/^[+-]\d+$/.test(s)) { const a = Number(s); return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  const d = Number(s);
  return Number.isFinite(d) && d > 1 && d < 1000 ? d : null;
}

function parseBook(text, players) {
  const match = buildMatcher(players);
  const rows = [], skipped = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(/\t|,(?![^"]*")/).map(s => s.trim().replace(/^"|"$/g, ''));
    if (parts.length < 3) { skipped.push({ line: raw, why: 'Needs at least: name, market, odds' }); continue; }
    const mkt = MARKET.find(([re]) => re.test(parts[1].toLowerCase()))?.[1];
    if (!mkt) { skipped.push({ line: raw, why: `Unknown market "${parts[1]}"` }); continue; }
    if (mkt === 'h2h') {
      const [a, b] = parts[0].split(/\s+(?:vs\.?|v\.?|over)\s+/i);
      const pa = a && match(a), pb = b && match(b);
      if (!pa || !pb) { skipped.push({ line: raw, why: `Couldn't match ${!pa ? `"${a || ''}"` : `"${b || ''}"`} to a driver in this race` }); continue; }
      const da = toDecimal(parts[2]), db = toDecimal(parts[3]);
      if (!da) { skipped.push({ line: raw, why: `Couldn't read the odds "${parts[2]}"` }); continue; }
      rows.push({ market: 'h2h', id: pa.id, opp: pb.id, dec: da, raw: parts[2] });
      if (db) rows.push({ market: 'h2h', id: pb.id, opp: pa.id, dec: db, raw: parts[3] });
      continue;
    }
    const p = match(parts[0]);
    if (!p) { skipped.push({ line: raw, why: `Couldn't match "${parts[0]}" to a driver in this race` }); continue; }
    const dec = toDecimal(parts[2]);
    if (!dec) { skipped.push({ line: raw, why: `Couldn't read the odds "${parts[2]}"` }); continue; }
    rows.push({ market: mkt, id: p.id, dec, raw: parts[2] });
  }
  return { rows, skipped };
}

module.exports = { parseBook, toDecimal };
