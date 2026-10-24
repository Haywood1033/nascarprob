// lib/plays.js — the Best plays tab: head-to-head targets, finishing-position targets and
// 3/4/5-leg finishing parlays, each with reasons built from the numbers and a section summary.
// With pasted book prices a section ranks by expected value against the book; without, it ranks
// by model strength and says so (most likely is not the same as value).

const { legSeries, priceParlay, autoParlays } = require('./parlay');
const { TYPES } = require('./tracks');

const MIN_EV = 0.03;
const MARKETS = [{ key: 'win', label: 'Win' }, { key: 'top3', label: 'Top 3' }, { key: 'top5', label: 'Top 5' }, { key: 'top10', label: 'Top 10' }];
const PARLAY_MARKETS = ['top3', 'top5', 'top10'];
const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const american = p => (!p || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
const ord = n => `${n}${(n % 100 > 10 && n % 100 < 14) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
const sgn = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

function fieldContext(payload) {
  const ps = payload.players;
  const rank = key => new Map([...ps].sort((a, b) => b[key] - a[key]).map((p, i) => [p.id, i + 1]));
  return { typeLabel: TYPES[payload.race.track.type].label.toLowerCase(), rateRank: rank('rating'), overallRank: rank('overall'), n: ps.length };
}

function reasons(p, ctx, market) {
  const out = [];
  out.push(`Rated ${ord(ctx.rateRank.get(p.id))} of ${ctx.n} on ${ctx.typeLabel} tracks (${sgn(p.rating)}), ${ord(ctx.overallRank.get(p.id))} on all tracks`);
  if (p.start) out.push(`Starts ${ord(p.start)}${p.qualSpeed ? ` (${p.qualSpeed.toFixed(3)} mph)` : ''}`);
  if (p.practicePos) out.push(`${ord(p.practicePos)} in practice`);
  const here = (p.here || []).filter(h => h.finish);
  if (here.length >= 2) out.push(`Here: averaged ${(here.reduce((s, h) => s + h.finish, 0) / here.length).toFixed(1)} over the last ${here.length} races`);
  if ((market === 'win' || market === 'top3') && p.ledAny > 0.3) out.push(`Leads at least one lap in ${pct(p.ledAny)} of simulations`);
  if (p.dnf >= 0.12) out.push(`DNF risk ${pct(p.dnf)} (wrecks and failures)`);
  if (p.typeStarts < 3) out.push(`Only ${p.typeStarts} prior starts on this track type: the rating leans on other tracks`);
  return out;
}

function bookIndex(rows) {
  const by = {};
  for (const r of rows || []) { if (r.market === 'h2h') continue; (by[r.market] ||= new Map()).set(r.id, r); }
  return by;
}

function finishingPlays(payload, sim, books, ctx) {
  const out = {};
  for (const m of MARKETS) {
    const bk = books[m.key];
    const cand = payload.players.filter(p => p.odds && sim.index.has(p.id)).map(p => {
      const prob = p.odds[m.key], b = bk?.get(p.id);
      return { id: p.id, name: p.name, car: p.car, prob, fairOdds: american(prob), book: b ? { raw: b.raw, dec: b.dec, implied: 1 / b.dec, edge: prob - 1 / b.dec, ev: prob * b.dec - 1 } : null, reasons: reasons(p, ctx, m.key) };
    });
    let items, mode;
    if (bk && bk.size) { mode = 'value'; items = cand.filter(c => c.book && c.book.ev >= MIN_EV && c.prob >= 0.03).sort((a, b) => b.book.ev - a.book.ev).slice(0, 6); }
    else { mode = 'model'; items = cand.sort((a, b) => b.prob - a.prob).slice(0, 6); }
    const rest = cand.filter(c => !items.includes(c));
    const avg = a => (a.length ? a.reduce((s, c) => s + c.prob, 0) / a.length : 0);
    const summary = mode === 'value'
      ? (items.length ? `${items.length} ${m.label.toLowerCase()} price${items.length > 1 ? 's' : ''} beat the book by ${pct(MIN_EV)}+ expected profit per $1. The best, ${items[0].name}, is ${pct(items[0].prob, 1)} in the model vs ${pct(items[0].book.implied, 1)} implied by ${items[0].book.raw}.` : `None of your ${m.label.toLowerCase()} prices clears ${pct(MIN_EV)} expected profit against the model.`)
      : `The model's strongest ${m.label.toLowerCase()} candidates: ${pct(avg(items), 1)} on average vs ${pct(avg(rest), 1)} for the rest of the field. Paste prices on the Matchups tab to rank by value instead.`;
    out[m.key] = { label: m.label, mode, summary, items };
  }
  return out;
}

// Head-to-heads: the book's pairs when pasted; otherwise pairs a book would plausibly offer —
// drivers next to each other on all-track rating — ranked by how lopsided the model makes them
// on this track type.
function matchupPlays(payload, sim, bookRows, ctx) {
  const byId = new Map(payload.players.map(p => [p.id, p]));
  const h2h = (bookRows || []).filter(r => r.market === 'h2h' && sim.index.has(r.id) && sim.index.has(r.opp));
  let pairs, mode;
  if (h2h.length) {
    mode = 'value';
    pairs = h2h.map(r => ({ id: r.id, opp: r.opp, dec: r.dec, raw: r.raw }));
  } else {
    mode = 'model';
    const byOverall = [...payload.players].filter(p => sim.index.has(p.id)).sort((a, b) => b.overall - a.overall).slice(0, 30);
    pairs = [];
    for (let i = 0; i + 1 < byOverall.length; i++) pairs.push({ id: byOverall[i].id, opp: byOverall[i + 1].id }, { id: byOverall[i + 1].id, opp: byOverall[i].id });
  }
  const items = pairs.map(x => {
    const prob = legSeries(sim, { kind: 'h2h', id: x.id, opp: x.opp }).prob;
    const a = byId.get(x.id), b = byId.get(x.opp);
    const why = [
      Math.abs(a.rating - b.rating) < 0.03 ? `Even on ${ctx.typeLabel} tracks (${sgn(a.rating)} vs ${sgn(b.rating)})` : `${a.rating > b.rating ? 'Faster' : 'Slower'} on ${ctx.typeLabel} tracks (${sgn(a.rating)} vs ${sgn(b.rating)})`,
      a.start && b.start ? `Starts ${ord(a.start)} vs ${ord(b.start)}` : null,
      a.practicePos && b.practicePos ? `Practice ${ord(a.practicePos)} vs ${ord(b.practicePos)}` : null,
      Math.abs(a.dnf - b.dnf) >= 0.03 ? `DNF risk ${pct(a.dnf)} vs ${pct(b.dnf)}` : null,
      `Average simulated finish ${a.avgFinish} vs ${b.avgFinish}`,
    ].filter(Boolean);
    return { id: x.id, opp: x.opp, name: a.name, oppName: b.name, prob, fairOdds: american(prob), book: x.dec ? { raw: x.raw, dec: x.dec, implied: 1 / x.dec, ev: prob * x.dec - 1 } : null, reasons: why };
  });
  const ranked = mode === 'value' ? items.filter(i => i.book.ev >= MIN_EV).sort((a, b) => b.book.ev - a.book.ev).slice(0, 6) : items.filter(i => i.prob > 0.5).sort((a, b) => b.prob - a.prob).slice(0, 6);
  const summary = mode === 'value'
    ? (ranked.length ? `${ranked.length} of your head-to-head prices beat the model by ${pct(MIN_EV)}+ per $1. Best: ${ranked[0].name} over ${ranked[0].oppName} at ${ranked[0].book.raw} (model ${pct(ranked[0].prob, 1)}).` : 'None of your head-to-head prices clears the bar against the model.')
    : `Pairs a book would plausibly offer (drivers side by side on all-track rating) where this track type splits them most. ${ranked[0] ? `${ranked[0].name} finishes ahead of ${ranked[0].oppName} in ${pct(ranked[0].prob)} of simulations.` : ''}`;
  // `all`: every priced pair (book mode) for the Matchups tab's full list.
  return { mode, summary, items: ranked, all: mode === 'value' ? items.sort((a, b) => b.book.ev - a.book.ev) : [] };
}

function parlayPlays(payload, sim, books) {
  const out = {};
  for (const key of PARLAY_MARKETS) {
    const bk = books[key];
    const candidates = payload.players.filter(p => p.odds).map(p => ({ id: p.id, dec: bk?.get(p.id)?.dec || null }));
    const bySize = {};
    for (const size of [3, 4, 5]) {
      const minJoint = { 3: 0.05, 4: 0.03, 5: 0.02 }[size];
      const res = autoParlays(sim, bk ? candidates.filter(c => c.dec) : candidates, { market: key, size, count: 3, pool: size === 5 ? 11 : 12, minJoint });
      const nameOf = id => payload.players.find(p => p.id === id)?.name || id;
      bySize[size] = { note: res.note, parlays: res.parlays.map(x => ({ joint: x.joint, independent: x.independent, lift: x.lift, fairOdds: american(x.joint), bookDecimal: x.bookDecimal, ev: x.ev, legs: x.legs.map(l => ({ id: l.id, name: nameOf(l.id), prob: l.prob, dec: l.dec })) })) };
    }
    const label = MARKETS.find(m => m.key === key).label;
    const mid = (bySize[4].parlays[0] || bySize[3].parlays[0]);
    const corr = !mid ? '' : mid.lift < 0.97 ? `${pct(1 - mid.lift)} lower than multiplying the legs, because ${label.toLowerCase()} legs compete for the same spots` : mid.lift > 1.03 ? `${pct(mid.lift - 1)} higher than multiplying the legs` : 'close to multiplying the legs';
    const summary = !mid ? `No ${label.toLowerCase()} ticket clears the bar.` : bk
      ? `Built from your ${label.toLowerCase()} prices, every leg +EV on its own. The best ${mid.legs.length}-leg ticket hits in ${pct(mid.joint, 1)} of simulations, ${corr}${mid.ev !== null ? `; expected ${mid.ev >= 0 ? '+' : '−'}$${Math.abs(mid.ev).toFixed(2)} per $1` : ''}.`
      : `The likeliest ${label.toLowerCase()} combinations, priced together inside the simulation. The best ${mid.legs.length}-leg ticket hits in ${pct(mid.joint, 1)} of runs (fair ${mid.fairOdds}), ${corr}. Without prices this is the most likely ticket, not a value ranking.`;
    out[key] = { label, mode: bk ? 'value' : 'model', summary, bySize };
  }
  return out;
}

function buildPlays(payload, sim, bookRows = []) {
  const ctx = fieldContext(payload);
  const books = bookIndex(bookRows);
  return {
    race: { id: payload.race.id, name: payload.race.name, state: payload.state },
    minEv: MIN_EV,
    matchups: matchupPlays(payload, sim, bookRows, ctx),
    finishing: finishingPlays(payload, sim, books, ctx),
    parlays: parlayPlays(payload, sim, books),
    priced: bookRows.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildPlays, reasons, fieldContext, priceParlay, MIN_EV };
