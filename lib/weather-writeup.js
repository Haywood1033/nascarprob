// lib/weather-writeup.js — the Weather tab's written briefing, generated from the numbers (no
// free text from anywhere else): the call in one line, then track temperature, rain timing
// against the stage ends, wind, and what changes in the odds if rain ends it early.

const { TYPES } = require('./tracks');
const pct = p => `${Math.round(p * 100)}%`;
const time = (iso, lon) => {
  const local = new Date(Date.parse(iso) + Math.round((lon || 0) / 15) * 3600e3);
  const h = local.getUTCHours(), m = local.getUTCMinutes();
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

function writeup(payload) {
  const wx = payload.weather;
  if (!wx?.available) return { headline: 'No forecast for this race yet.', sections: [] };
  const s = wx.summary, race = payload.race, type = race.track.type, lon = race.track.lon;
  const nameOf = id => payload.players.find(p => p.id === id)?.name || id;
  const rain = s.rainEndProb || 0;
  const hot = (s.trackTempHigh ?? 0) >= 120;
  const headline = rain >= 0.25
    ? `Rain is a real factor: about a ${pct(rain)} chance it ends the race after halfway, which favours whoever runs up front early.`
    : rain >= 0.08
      ? `Mostly dry, with a ${pct(rain)} chance rain cuts it short after halfway.`
      : hot ? `Dry and hot: a slick track that rewards cars good on long runs.` : `Dry, ordinary conditions: speed decides it, not weather.`;
  const sections = [];
  sections.push({
    title: 'Track temperature',
    text: s.trackTempAtGreen !== null
      ? `Air ${Math.round(s.tempAtGreen)}°F at the green flag, track around ${s.trackTempAtGreen}°F${s.trackTempHigh && s.trackTempHigh > s.trackTempAtGreen + 4 ? `, peaking near ${s.trackTempHigh}°F` : ''} (an estimate from air temperature and sun). ${hot ? 'Hot asphalt loses grip as a run goes on: tire falloff grows and cars that hold speed late gain.' : s.night ? 'A night race: the track cools and gains grip as it goes, which helps cars that were loose in practice.' : 'Not hot enough to make tire wear the story.'}`
      : 'No temperature data.',
  });
  sections.push({
    title: 'Rain timing',
    text: s.secondHalfWet !== null
      ? `Of ${s.members} forecast runs, ${pct(s.firstHalfWet)} show rain before halfway (${time(wx.halfway, lon)} local) and ${pct(s.secondHalfWet)} after it. Rain early usually means a delay; rain after the stage 2 end can make the race official on the spot. The model plays out a rain-shortened finish in ${pct(payload.rainShare)} of simulations.`
      : `Peak hourly rain chance during the race: ${s.rainChanceMax ?? 0}%. No ensemble data, so the shortened-race chance comes from the single forecast.`,
  });
  sections.push({
    title: 'Wind',
    text: `${s.windAvg ?? '—'} mph from the ${s.windDir} on average during the race. ${type === 'superspeedway' ? (s.windAvg >= 12 ? 'Strong enough to change which lane the draft favours and to make cars loose off the corners in traffic.' : 'Light enough that the draft behaves normally.') : s.windAvg >= 15 ? 'A strong crosswind unsettles cars on corner entry; balance matters more than usual.' : 'Not a factor at this speed on this kind of track.'}`,
  });
  if (payload.rainCompare?.length) {
    const up = payload.rainCompare.slice(0, 3).filter(x => x.wetWin > x.dryWin);
    const down = payload.rainCompare.slice(-3).filter(x => x.wetWin < x.dryWin).reverse();
    sections.push({
      title: 'If rain ends it early',
      text: `A finish at the end of stage 2 helps cars that run up front early and hurts those who come on late or have strategy to play out.${up.length ? ` Gaining most: ${up.map(x => `${nameOf(x.id)} (${pct(x.dryWin)} → ${pct(x.wetWin)})`).join(', ')}.` : ''}${down.length ? ` Losing most: ${down.map(x => `${nameOf(x.id)} (${pct(x.dryWin)} → ${pct(x.wetWin)})`).join(', ')}.` : ''}`,
    });
  }
  return { headline, sections, typeNote: TYPES[type].note };
}

module.exports = { writeup };
