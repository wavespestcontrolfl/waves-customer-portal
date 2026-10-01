// Address -> county for the three core service counties (Manatee, Sarasota,
// Charlotte). Shared by the irrigation-restriction resolver and the field
// report so a straddling-city or service-area correction lands in ONE place.

const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, SERVICE_AREA_COUNTY_ZIPS } = require('./county-zips');
// Watering jurisdiction by ZIP. A ZIP the service-area map lists under MORE
// THAN ONE county straddles a line (34228 Longboat Key, 34243 University
// Park / SRQ, 34223–34224 Englewood): NOTHING address-level may decide it —
// not the tax map (a filing convention, not a jurisdiction: 34228 files as
// Sarasota while its north end is Manatee's) and not the city map either,
// because the USPS city spans the same line ("Sarasota" 34243 reaches into
// Manatee). Such a ZIP fails closed to the technician-confirmed profile
// county, else no plan (codex gh-r29, gh-r33). Elsewhere the tax map speaks
// first and the FULLER service-area map covers the ZIPs it omits (Cortez
// 34215, Anna Maria, Ellenton…).
const { SERVICE_AREA_ZIP_COUNTY, SHARED_SERVICE_AREA_ZIPS } = (() => {
  const seen = {};
  for (const [county, zips] of Object.entries(SERVICE_AREA_COUNTY_ZIPS)) {
    for (const z of zips) seen[z] = seen[z] ? 'shared' : county;
  }
  return {
    SERVICE_AREA_ZIP_COUNTY: Object.freeze(Object.fromEntries(Object.entries(seen).filter(([, c]) => c !== 'shared'))),
    SHARED_SERVICE_AREA_ZIPS: Object.freeze(new Set(Object.entries(seen).filter(([, c]) => c === 'shared').map(([z]) => z))),
  };
})();
const ZIP_COUNTY = Object.freeze(Object.fromEntries([
  ...MANATEE_ZIPS.map((z) => [z, 'Manatee']),
  ...SARASOTA_ZIPS.map((z) => [z, 'Sarasota']),
  ...CHARLOTTE_ZIPS.map((z) => [z, 'Charlotte']),
].filter(([z]) => !SHARED_SERVICE_AREA_ZIPS.has(z))));

// Service-area cities → county, for customers whose turf profile carries no
// county. Only cities that sit wholly in one county; a city that straddles
// counties (Lakewood Ranch, Longboat Key, Englewood — and the Sarasota
// POSTAL city, which reaches Manatee County through shared ZIP 34243) is
// deliberately absent → unknown → no plan (fail closed) until an
// address-level lane exists (codex gh-r38).
const CITY_COUNTY = Object.freeze({
  bradenton: 'Manatee', parrish: 'Manatee', palmetto: 'Manatee', ellenton: 'Manatee',
  duette: 'Manatee',
  'anna maria': 'Manatee', 'holmes beach': 'Manatee',
  'bradenton beach': 'Manatee', myakka: 'Manatee', 'myakka city': 'Manatee',
  venice: 'Sarasota', 'north port': 'Sarasota', nokomis: 'Sarasota',
  osprey: 'Sarasota', 'siesta key': 'Sarasota', 'laurel': 'Sarasota',
  'north venice': 'Sarasota', 'lake sarasota': 'Sarasota',
  'port charlotte': 'Charlotte', 'punta gorda': 'Charlotte', 'rotonda west': 'Charlotte',
});

/**
 * The county an ADDRESS is in: ZIP first (the tax/compliance map, then the
 * fuller service-area map), then a whole-county city. A ZIP the service-area
 * map lists under more than one county returns null (fail closed).
 */
function resolveAddressCounty({ zip = null, city = null } = {}) {
  const zip5 = String(zip || '').trim().slice(0, 5);
  if (SHARED_SERVICE_AREA_ZIPS.has(zip5)) return null;
  const cCity = String(city || '').trim().toLowerCase();
  return ZIP_COUNTY[zip5] || SERVICE_AREA_ZIP_COUNTY[zip5] || CITY_COUNTY[cCity] || null;
}

module.exports = { resolveAddressCounty, CITY_COUNTY, ZIP_COUNTY, SERVICE_AREA_ZIP_COUNTY, SHARED_SERVICE_AREA_ZIPS };
