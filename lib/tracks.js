// lib/tracks.js — every Cup venue the model knows: track type (the unit ratings are pooled by),
// length, surface and coordinates for the weather feed. Matching is by name fragments because
// NASCAR and ESPN spell venues differently ("Charlotte Motor Speedway" vs "Charlotte Roval").
// Coordinates are approximate track centres; a few hundred metres is irrelevant to a forecast.

const TYPES = {
  superspeedway: { label: 'Superspeedway', note: 'Drafting pack racing; big multi-car crashes; finishing order is close to a lottery.' },
  intermediate: { label: 'Intermediate', note: '1.5–2 mile ovals where raw speed and aero balance decide it.' },
  short_concrete: { label: 'Short track, concrete', note: 'Bristol, Dover, Martinsville: tight, physical, track position matters.' },
  short_flat: { label: 'Short / flat', note: 'Flat one-mile-and-under ovals: braking, traction, pit strategy.' },
  large_flat: { label: 'Large flat', note: 'Pocono and Indianapolis: long straights, flat corners, fuel strategy.' },
  road: { label: 'Road / street course', note: 'Turning both ways: a separate skill from ovals.' },
  oneoff: { label: 'One-off', note: 'Darlington and Nashville: tracks unlike any other on the schedule.' },
};

// match: lower-case fragments, any of which identifies the venue. Order matters only where one
// venue's name contains another's (the Charlotte Roval and Indianapolis road course come first).
const TRACKS = [
  { key: 'charlotte-roval', name: 'Charlotte Roval', match: ['roval'], type: 'road', miles: 2.28, lat: 35.3523, lon: -80.6828, surface: 'asphalt' },
  { key: 'indy-road', name: 'Indianapolis Road Course', match: ['indianapolis motor speedway road', 'indy road', 'indianapolis road'], type: 'road', miles: 2.439, lat: 39.795, lon: -86.2347, surface: 'asphalt' },
  { key: 'chicago-street', name: 'Chicago Street Course', match: ['chicago street', 'grant park'], type: 'road', miles: 2.2, lat: 41.8676, lon: -87.615, surface: 'asphalt' },
  { key: 'san-diego-street', name: 'San Diego Street Course', match: ['san diego', 'coronado'], type: 'road', miles: 3.4, lat: 32.6915, lon: -117.2129, surface: 'asphalt' },
  { key: 'daytona-road', name: 'Daytona Road Course', match: ['daytona road'], type: 'road', miles: 3.61, lat: 29.1852, lon: -81.0705, surface: 'asphalt' },
  { key: 'daytona', name: 'Daytona International Speedway', match: ['daytona'], type: 'superspeedway', miles: 2.5, lat: 29.1852, lon: -81.0705, surface: 'asphalt' },
  { key: 'talladega', name: 'Talladega Superspeedway', match: ['talladega'], type: 'superspeedway', miles: 2.66, lat: 33.5672, lon: -86.0656, surface: 'asphalt' },
  { key: 'atlanta', name: 'EchoPark Speedway (Atlanta)', match: ['atlanta', 'echopark'], type: 'superspeedway', miles: 1.54, lat: 33.3836, lon: -84.3166, surface: 'asphalt' },
  { key: 'las-vegas', name: 'Las Vegas Motor Speedway', match: ['las vegas'], type: 'intermediate', miles: 1.5, lat: 36.2719, lon: -115.0103, surface: 'asphalt' },
  { key: 'charlotte', name: 'Charlotte Motor Speedway', match: ['charlotte'], type: 'intermediate', miles: 1.5, lat: 35.3523, lon: -80.6828, surface: 'asphalt' },
  { key: 'texas', name: 'Texas Motor Speedway', match: ['texas motor'], type: 'intermediate', miles: 1.5, lat: 33.0372, lon: -97.2811, surface: 'asphalt' },
  { key: 'kansas', name: 'Kansas Speedway', match: ['kansas'], type: 'intermediate', miles: 1.5, lat: 39.1157, lon: -94.8311, surface: 'asphalt' },
  { key: 'homestead', name: 'Homestead-Miami Speedway', match: ['homestead', 'miami'], type: 'intermediate', miles: 1.5, lat: 25.4519, lon: -80.4089, surface: 'asphalt' },
  { key: 'michigan', name: 'Michigan International Speedway', match: ['michigan'], type: 'intermediate', miles: 2.0, lat: 42.0664, lon: -84.2412, surface: 'asphalt' },
  { key: 'darlington', name: 'Darlington Raceway', match: ['darlington'], type: 'oneoff', miles: 1.366, lat: 34.2953, lon: -79.9054, surface: 'asphalt' },
  { key: 'nashville', name: 'Nashville Superspeedway', match: ['nashville'], type: 'oneoff', miles: 1.33, lat: 36.0453, lon: -86.4108, surface: 'concrete' },
  { key: 'pocono', name: 'Pocono Raceway', match: ['pocono'], type: 'large_flat', miles: 2.5, lat: 41.0553, lon: -75.511, surface: 'asphalt' },
  { key: 'indianapolis', name: 'Indianapolis Motor Speedway', match: ['indianapolis', 'brickyard'], type: 'large_flat', miles: 2.5, lat: 39.795, lon: -86.2347, surface: 'asphalt' },
  { key: 'bristol', name: 'Bristol Motor Speedway', match: ['bristol'], type: 'short_concrete', miles: 0.533, lat: 36.5157, lon: -82.257, surface: 'concrete' },
  { key: 'dover', name: 'Dover Motor Speedway', match: ['dover'], type: 'short_concrete', miles: 1.0, lat: 39.1897, lon: -75.5302, surface: 'concrete' },
  { key: 'martinsville', name: 'Martinsville Speedway', match: ['martinsville'], type: 'short_concrete', miles: 0.526, lat: 36.6341, lon: -79.8517, surface: 'concrete' },
  { key: 'phoenix', name: 'Phoenix Raceway', match: ['phoenix'], type: 'short_flat', miles: 1.0, lat: 33.375, lon: -112.311, surface: 'asphalt' },
  { key: 'richmond', name: 'Richmond Raceway', match: ['richmond'], type: 'short_flat', miles: 0.75, lat: 37.5925, lon: -77.4194, surface: 'asphalt' },
  { key: 'new-hampshire', name: 'New Hampshire Motor Speedway', match: ['new hampshire', 'loudon'], type: 'short_flat', miles: 1.058, lat: 43.3627, lon: -71.4606, surface: 'asphalt' },
  { key: 'iowa', name: 'Iowa Speedway', match: ['iowa'], type: 'short_flat', miles: 0.875, lat: 41.6751, lon: -93.0136, surface: 'asphalt' },
  { key: 'gateway', name: 'World Wide Technology Raceway', match: ['world wide technology', 'gateway', 'madison'], type: 'short_flat', miles: 1.25, lat: 38.651, lon: -90.1355, surface: 'asphalt' },
  { key: 'north-wilkesboro', name: 'North Wilkesboro Speedway', match: ['wilkesboro'], type: 'short_flat', miles: 0.625, lat: 36.1451, lon: -81.0715, surface: 'asphalt' },
  { key: 'bowman-gray', name: 'Bowman Gray Stadium', match: ['bowman gray'], type: 'short_flat', miles: 0.25, lat: 36.0912, lon: -80.2534, surface: 'asphalt' },
  { key: 'rockingham', name: 'Rockingham Speedway', match: ['rockingham'], type: 'short_flat', miles: 1.017, lat: 34.9745, lon: -79.6097, surface: 'asphalt' },
  { key: 'sonoma', name: 'Sonoma Raceway', match: ['sonoma'], type: 'road', miles: 2.52, lat: 38.1611, lon: -122.4547, surface: 'asphalt' },
  { key: 'watkins-glen', name: 'Watkins Glen International', match: ['watkins glen'], type: 'road', miles: 2.45, lat: 42.3369, lon: -76.9272, surface: 'asphalt' },
  { key: 'cota', name: 'Circuit of the Americas', match: ['circuit of the americas', 'cota', 'austin'], type: 'road', miles: 2.3, lat: 30.1328, lon: -97.6411, surface: 'asphalt' },
  { key: 'road-america', name: 'Road America', match: ['road america', 'elkhart'], type: 'road', miles: 4.048, lat: 43.798, lon: -87.9897, surface: 'asphalt' },
  { key: 'mexico-city', name: 'Autódromo Hermanos Rodríguez', match: ['hermanos', 'mexico city'], type: 'road', miles: 2.42, lat: 19.4042, lon: -99.0907, surface: 'asphalt' },
];

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Returns the known track, or a stub typed 'intermediate' (the most common type) so an unknown
// venue still prices — flagged so the UI and health route can show it.
function findTrack(name) {
  const n = norm(name);
  const t = TRACKS.find(t => t.match.some(m => n.includes(m)));
  if (t) return { ...t, known: true };
  return { key: n.replace(/[^a-z0-9]+/g, '-') || 'unknown', name: name || 'Unknown track', type: 'intermediate', miles: null, lat: null, lon: null, surface: null, known: false };
}

module.exports = { TYPES, TRACKS, findTrack };
