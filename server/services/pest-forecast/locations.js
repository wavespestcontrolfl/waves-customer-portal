/**
 * Curated Florida locations for the public Pest Pressure Forecast.
 *
 * The embeddable widget passes a `location` slug; we resolve it to a
 * lat/lng (for the live weather lookup) and a display label. We keep a
 * curated list rather than accepting arbitrary coordinates so the picker on
 * the landing page, the widget, and the forecast all stay in sync and every
 * point sits inside Florida.
 *
 * Waves' own service cities come first (these are where the forecast is most
 * authoritative); major FL metros follow so the widget is useful — and
 * embeddable — well beyond the immediate service area.
 */

// region drives nothing weather-wise (we fetch live by lat/lng) but is exposed
// so the widget/landing can group or label points. sw = Southwest FL service area.
const LOCATIONS = [
  // --- Waves service area (Southwest Florida) ---
  { slug: 'bradenton-fl', label: 'Bradenton, FL', lat: 27.4989, lng: -82.5748, region: 'sw', county: 'Manatee' },
  { slug: 'lakewood-ranch-fl', label: 'Lakewood Ranch, FL', lat: 27.4225, lng: -82.4082, region: 'sw', county: 'Manatee' },
  { slug: 'parrish-fl', label: 'Parrish, FL', lat: 27.5897, lng: -82.4254, region: 'sw', county: 'Manatee' },
  { slug: 'palmetto-fl', label: 'Palmetto, FL', lat: 27.5214, lng: -82.5723, region: 'sw', county: 'Manatee' },
  { slug: 'ellenton-fl', label: 'Ellenton, FL', lat: 27.5223, lng: -82.5279, region: 'sw', county: 'Manatee' },
  { slug: 'sarasota-fl', label: 'Sarasota, FL', lat: 27.3364, lng: -82.5307, region: 'sw', county: 'Sarasota' },
  { slug: 'venice-fl', label: 'Venice, FL', lat: 27.0998, lng: -82.4543, region: 'sw', county: 'Sarasota' },
  { slug: 'north-port-fl', label: 'North Port, FL', lat: 27.0442, lng: -82.2359, region: 'sw', county: 'Sarasota' },
  { slug: 'nokomis-fl', label: 'Nokomis, FL', lat: 27.1217, lng: -82.4445, region: 'sw', county: 'Sarasota' },
  { slug: 'osprey-fl', label: 'Osprey, FL', lat: 27.1958, lng: -82.4904, region: 'sw', county: 'Sarasota' },
  { slug: 'port-charlotte-fl', label: 'Port Charlotte, FL', lat: 26.9762, lng: -82.0906, region: 'sw', county: 'Charlotte' },
  { slug: 'punta-gorda-fl', label: 'Punta Gorda, FL', lat: 26.9298, lng: -82.0454, region: 'sw', county: 'Charlotte' },
  // --- Greater Tampa Bay ---
  { slug: 'tampa-fl', label: 'Tampa, FL', lat: 27.9506, lng: -82.4572, region: 'tampa', county: 'Hillsborough' },
  { slug: 'st-petersburg-fl', label: 'St. Petersburg, FL', lat: 27.7676, lng: -82.6403, region: 'tampa', county: 'Pinellas' },
  { slug: 'clearwater-fl', label: 'Clearwater, FL', lat: 27.9659, lng: -82.8001, region: 'tampa', county: 'Pinellas' },
  { slug: 'brandon-fl', label: 'Brandon, FL', lat: 27.9378, lng: -82.2859, region: 'tampa', county: 'Hillsborough' },
  { slug: 'lakeland-fl', label: 'Lakeland, FL', lat: 28.0395, lng: -81.9498, region: 'central', county: 'Polk' },
  // --- Southwest coast (Lee / Collier) ---
  { slug: 'fort-myers-fl', label: 'Fort Myers, FL', lat: 26.6406, lng: -81.8723, region: 'sw', county: 'Lee' },
  { slug: 'cape-coral-fl', label: 'Cape Coral, FL', lat: 26.5629, lng: -81.9495, region: 'sw', county: 'Lee' },
  { slug: 'naples-fl', label: 'Naples, FL', lat: 26.1420, lng: -81.7948, region: 'south', county: 'Collier' },
  // --- Central / East / South FL metros ---
  { slug: 'orlando-fl', label: 'Orlando, FL', lat: 28.5383, lng: -81.3792, region: 'central', county: 'Orange' },
  { slug: 'jacksonville-fl', label: 'Jacksonville, FL', lat: 30.3322, lng: -81.6557, region: 'north', county: 'Duval' },
  { slug: 'tallahassee-fl', label: 'Tallahassee, FL', lat: 30.4383, lng: -84.2807, region: 'north', county: 'Leon' },
  { slug: 'miami-fl', label: 'Miami, FL', lat: 25.7617, lng: -80.1918, region: 'south', county: 'Miami-Dade' },
  { slug: 'fort-lauderdale-fl', label: 'Fort Lauderdale, FL', lat: 26.1224, lng: -80.1373, region: 'south', county: 'Broward' },
  { slug: 'west-palm-beach-fl', label: 'West Palm Beach, FL', lat: 26.7153, lng: -80.0534, region: 'south', county: 'Palm Beach' },
];

const BY_SLUG = new Map(LOCATIONS.map((l) => [l.slug, l]));

// Waves HQ market — the default when no/unknown location is supplied. Labeled
// generically so an unresolved embed still reads sensibly.
const DEFAULT_LOCATION = {
  slug: 'southwest-florida',
  label: 'Southwest Florida',
  lat: 27.4989,
  lng: -82.5748,
  region: 'sw',
  county: 'Manatee',
};

// Best-effort FL ZIP → nearest curated city. Florida ZIPs run 32xxx–34xxx; we
// map by 3-digit prefix to the closest point we already track. Unknown/out-of-
// state ZIPs fall through to the default.
const ZIP_PREFIX_TO_SLUG = {
  342: 'bradenton-fl',     // Manatee / Sarasota (Bradenton, Sarasota, Venice)
  341: 'fort-myers-fl',    // Lee / Charlotte / Collier
  339: 'fort-myers-fl',    // Fort Myers / Cape Coral
  338: 'lakeland-fl',      // Polk
  337: 'tampa-fl',         // Hillsborough / Pinellas
  336: 'tampa-fl',         // Tampa
  335: 'tampa-fl',         // Tampa / St. Pete
  347: 'orlando-fl',       // Central FL
  328: 'orlando-fl',       // Orlando metro
  327: 'orlando-fl',       // Orlando / Sanford
  329: 'orlando-fl',       // Melbourne / Space Coast (nearest tracked = Orlando)
  322: 'jacksonville-fl',  // Jacksonville
  323: 'tallahassee-fl',   // Tallahassee / Panhandle east
  331: 'miami-fl',         // Miami-Dade
  330: 'fort-lauderdale-fl', // Broward / Hollywood
  333: 'fort-lauderdale-fl', // Fort Lauderdale
  334: 'west-palm-beach-fl',  // Palm Beach / Treasure Coast
};

function resolveZip(zip) {
  const z = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const slug = ZIP_PREFIX_TO_SLUG[z.slice(0, 3)];
  return slug ? BY_SLUG.get(slug) : null;
}

/**
 * Resolve an inbound request into a location. Priority:
 *   1. explicit `location` slug (the widget's contract)
 *   2. `zip` (best-effort prefix match)
 *   3. DEFAULT_LOCATION (Southwest Florida)
 * Always returns a usable location object — never throws.
 */
function resolveLocation({ location, zip } = {}) {
  if (location && BY_SLUG.has(String(location))) return BY_SLUG.get(String(location));
  const byZip = resolveZip(zip);
  if (byZip) return byZip;
  return DEFAULT_LOCATION;
}

function listLocations() {
  return LOCATIONS.map(({ slug, label, region, county }) => ({ slug, label, region, county }));
}

module.exports = { LOCATIONS, DEFAULT_LOCATION, resolveLocation, resolveZip, listLocations, BY_SLUG };
