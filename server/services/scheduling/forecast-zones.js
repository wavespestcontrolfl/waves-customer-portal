/**
 * The day board's forecast areas (owner 2026-10-24: one rain figure per stop, by time of day and the area the tech is
 * in): each area's NWS forecast point, its board label and color, and the rules that place a stop or an address in an
 * area. Moved unchanged from routes/admin-schedule.js, so the 07:05 notice's rain note names the same areas the board
 * shows (day-replan/rain-note.js, owner 2026-11-19 D3).
 */

// `fallback` is the zone for a city and ZIP no rule matches.
function getZone(city, zip, fallback = 'lakewood_ranch') {
  const c = (city || '').toLowerCase();
  const z = zip || '';
  if (['parrish', 'ellenton'].includes(c) || z === '34219') return 'parrish';
  if (c === 'palmetto') return 'palmetto';
  // Myakka City sits east of Lakewood Ranch — the eastern zone (explicit,
  // not a fallthrough).
  if (c.includes('lakewood') || c === 'myakka city' || ['34202', '34211', '34212'].includes(z)) return 'lakewood_ranch';
  if (c.includes('bradenton')) return 'bradenton_north';
  // Longboat Key + Siesta Key are Sarasota barrier islands.
  if (['sarasota', 'longboat key', 'siesta key'].includes(c)) return 'sarasota';
  // Osprey sits between Sarasota and Venice on the 41 corridor, same as
  // Nokomis; North Venice is Venice. The deep-south corridor (Englewood
  // through Boca Grande) rides the same Venice route day — before this,
  // these cities fell through to the lakewood_ranch default and their
  // appointments carried a mis-stamped zone the south-zone day funnel
  // (zone-day-funnel.js) would reject as evidence of a Venice-day stop.
  if ([
    'venice', 'north venice', 'nokomis', 'osprey', 'north port',
    'englewood', 'port charlotte', 'punta gorda', 'murdock',
    'rotonda west', 'placida', 'boca grande',
  ].includes(c)) return 'venice_north_port';
  return fallback;
}

const ZONE_COLORS = {
  parrish: '#10b981', palmetto: '#34d399', lakewood_ranch: '#0ea5e9',
  bradenton_north: '#6366f1', bradenton_south: '#8b5cf6',
  sarasota: '#f59e0b', venice_north_port: '#ef4444', ellenton: '#14b8a6',
};

const ZONE_LABELS = {
  parrish: 'Parrish', palmetto: 'Palmetto', lakewood_ranch: 'Lakewood Ranch',
  bradenton_north: 'Bradenton N', bradenton_south: 'Bradenton S',
  sarasota: 'Sarasota', venice_north_port: 'Venice/N.Port', ellenton: 'Ellenton',
};

// City-center coordinates per getZone value, for the day board's per-zone
// rain outlook. Values come from services/pest-forecast/locations.js
// (parrish→Parrish, palmetto→Palmetto, lakewood_ranch→Lakewood Ranch,
// bradenton_north→Bradenton, sarasota→Sarasota, venice_north_port→Venice).
// The NWS cache keys on 2-decimal-rounded coords, so nearby zones dedupe.
const ZONE_COORDS = {
  parrish: { lat: 27.5897, lng: -82.4254 },
  palmetto: { lat: 27.5214, lng: -82.5723 },
  lakewood_ranch: { lat: 27.4225, lng: -82.4082 },
  bradenton_north: { lat: 27.4989, lng: -82.5748 },
  sarasota: { lat: 27.3364, lng: -82.5307 },
  venice_north_port: { lat: 27.0998, lng: -82.4543 },
};

// The forecast zone of a day-board stop, read from its scheduled_services row:
// the stored zone, never the card's display zone, which defaults to Lakewood
// Ranch for a city and ZIP no rule places. A stored zone with a forecast point
// stays; else the row's city and ZIP place the stop, else the stored zone read
// as a place name by the same rules (self-booking stores the service zone's
// first name: 'bradenton', 'venice', 'port charlotte'; a board zone key such
// as 'bradenton_south' is not a place name); a stop none of these place has
// no forecast zone (owner 2026-11-02, "leave the rain for all";
// 11-19: 18 of 84 stops, stored 'bradenton', showed no rain). The day query
// fills each missing stamp field from the primary address, so a stamp for
// another property reads only its own city and ZIP ("no pin beats a wrong
// pin", services/stamped-address.js).
function stopForecastZone(row) {
  if (ZONE_COORDS[row.zone]) return row.zone;
  const ownAddress = require('../stamped-address').stampedAddressDiverges(row);
  const city = ownAddress ? row.service_address_city : row.city;
  // getZone matches 5-digit ZIPs exactly: '34211-1234' reads as '34211'.
  const zip = require('../customer-properties').normalizeZip(ownAddress ? row.service_address_zip : row.zip);
  return getZone(city, zip, ZONE_COLORS[row.zone] ? null : getZone(row.zone, null, null));
}

module.exports = { getZone, ZONE_COLORS, ZONE_LABELS, ZONE_COORDS, stopForecastZone };
