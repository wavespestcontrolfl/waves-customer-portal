// ZIP → city fallback for the Waves service area (Manatee / Sarasota /
// Charlotte counties).
//
// Why this exists: website lead forms only capture a structured city when the
// visitor PICKS a Google Places suggestion. If Places autocomplete fails to
// load (missing/blocked Maps key, ad-blocker, slow load) the "pick from the
// dropdown" guard is skipped and the raw typed address submits with no city —
// e.g. "87th Street East, FL 34219". The address normalizer can pull line1 /
// state / zip from that string but there's no city token to extract, so the
// lead lands with a blank city. This map recovers the city from the ZIP.
//
// City values are USPS primary place names (what appears on mail for the ZIP).
// The ZIP set covers the canonical county service-area sets in
// services/property-lookup/ai-property-lookup.js (MANATEE_ZIPS / SARASOTA_ZIPS
// / CHARLOTTE_ZIPS); a few non-delivery / PO-box-only ZIPs from those sets
// (e.g. 34249) are intentionally omitted. Unknown ZIPs return '' — we never
// guess outside the known service area.
//
// IMPORTANT: every city emitted here must also have a CITY_TO_LOCATION entry in
// config/locations.js, or a recovered city routes to the Bradenton default
// instead of the correct office.

const ZIP_TO_CITY = {
  // ── Manatee County ──
  '34201': 'Bradenton',
  '34202': 'Bradenton', // Lakewood Ranch (USPS city = Bradenton)
  '34203': 'Bradenton',
  '34204': 'Bradenton',
  '34205': 'Bradenton',
  '34206': 'Bradenton',
  '34207': 'Bradenton',
  '34208': 'Bradenton',
  '34209': 'Bradenton',
  '34210': 'Bradenton',
  '34211': 'Bradenton', // Lakewood Ranch (USPS city = Bradenton)
  '34212': 'Bradenton',
  '34215': 'Cortez',
  '34216': 'Anna Maria',
  '34217': 'Bradenton Beach',
  '34218': 'Holmes Beach',
  '34219': 'Parrish',
  '34220': 'Palmetto',
  '34221': 'Palmetto',
  '34222': 'Ellenton',
  '34243': 'Sarasota', // University Park — USPS city = Sarasota
  '34250': 'Terra Ceia',
  '34251': 'Myakka City',
  '34264': 'Oneco',
  '34270': 'Tallevast',
  '34280': 'Bradenton',
  '34281': 'Bradenton',
  '34282': 'Bradenton',

  // ── Sarasota County ──
  '34228': 'Longboat Key',
  '34229': 'Osprey',
  '34230': 'Sarasota',
  '34231': 'Sarasota',
  '34232': 'Sarasota',
  '34233': 'Sarasota',
  '34234': 'Sarasota',
  '34235': 'Sarasota',
  '34236': 'Sarasota',
  '34237': 'Sarasota',
  '34238': 'Sarasota',
  '34239': 'Sarasota',
  '34240': 'Sarasota',
  '34241': 'Sarasota',
  '34242': 'Sarasota', // Siesta Key
  '34260': 'Sarasota',
  '34272': 'Laurel',
  '34274': 'Nokomis',
  '34275': 'Nokomis',
  '34276': 'Sarasota',
  '34277': 'Sarasota',
  '34278': 'Sarasota',
  '34284': 'Venice',
  '34285': 'Venice',
  '34286': 'North Port',
  '34287': 'North Port',
  '34288': 'North Port',
  '34289': 'North Port',
  '34290': 'North Port',
  '34291': 'North Port',
  '34292': 'Venice',
  '34293': 'Venice',
  '34223': 'Englewood',
  '34224': 'Englewood',
  '34295': 'Englewood',

  // ── Charlotte County ──
  '33921': 'Boca Grande',
  '33927': 'Placida',
  '33938': 'Port Charlotte',
  '33946': 'Placida',
  '33947': 'Placida',
  '33948': 'Port Charlotte',
  '33949': 'Port Charlotte',
  '33950': 'Punta Gorda',
  '33951': 'Punta Gorda',
  '33952': 'Port Charlotte',
  '33953': 'Port Charlotte',
  '33954': 'Port Charlotte',
  '33955': 'Punta Gorda', // Burnt Store
  '33980': 'Port Charlotte', // Charlotte Harbor
  '33981': 'Port Charlotte', // Gulf Cove / El Jobean
  '33982': 'Punta Gorda',
  '33983': 'Punta Gorda', // Deep Creek
};

// Resolve a city name from a ZIP. Accepts ZIP+4 / messy input; uses the first
// 5 digits. Returns '' for anything outside the known service area.
function zipToCity(zip) {
  const match = String(zip || '').match(/\d{5}/);
  if (!match) return '';
  return ZIP_TO_CITY[match[0]] || '';
}

module.exports = { zipToCity, ZIP_TO_CITY };
