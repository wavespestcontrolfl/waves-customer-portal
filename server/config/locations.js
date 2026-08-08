const WAVES_LOCATIONS = [
  // NOTE: this entry's Google Business Profile is branded "Waves Pest
  // Control Lakewood Ranch" but is physically the BRADENTON office
  // (13649 Luxe Ave, the (941) 318-7612 GBP line). Waves has 5 staffed
  // offices but only 4 GBPs — the Lakewood Ranch office proper (9040 Town
  // Center Pkwy, main line (941) 297-5749) has no GBP and is not a separate
  // entry here. The `id: 'lakewood-ranch'` is kept as-is because it is a
  // stable cross-system key (Twilio default caller ID in twilio-numbers.js,
  // review location_id rows in the DB, GBP_REFRESH_TOKEN_LWR, and the
  // admin GBP location set). Renaming it requires a coordinated migration.
  {
    id: 'bradenton',
    name: 'Lakewood Ranch',
    area: 'Lakewood Ranch / Bradenton',
    address: '13649 Luxe Ave #110, Bradenton, FL 34211',
    latitude: 27.4186,
    longitude: -82.4186,
    phone: '(941) 318-7612',
    phoneRaw: '+19413187612',
    googleAccountId: '115462050041013627815',
    googleLocationId: '11325506936615341094',
    googleLocationResourceName: 'accounts/115462050041013627815/locations/11325506936615341094',
    googlePlaceId: 'ChIJVbBOKGYyTCgRVFz8_lu61Mw',
    googleRefreshTokenEnv: 'GBP_REFRESH_TOKEN_LWR',
    googleReviewUrl: 'https://g.page/r/CVRc_P5butTMEBM/review',
    gbpWebsitePath: '/pest-control-bradenton-fl/',
    gbpUtmContent: 'bradenton-profile',
    gbpUtmAliases: ['bradenton', 'lakewood_ranch', 'lakewood_ranch_profile', 'lwr'],
  },
  {
    id: 'parrish',
    name: 'Parrish',
    area: 'Parrish / Palmetto / Ellenton',
    address: '5155 115th Cir E, Parrish, FL 34219',
    latitude: 27.5698,
    longitude: -82.4265,
    phone: '(941) 297-2817',
    phoneRaw: '+19412972817',
    googleAccountId: '107615291009184011722',
    googleLocationId: '3749219908465956526',
    googleLocationResourceName: 'accounts/107615291009184011722/locations/3749219908465956526',
    googlePlaceId: 'ChIJM32aQRIlw4gRr7goqhbAVpw',
    googleRefreshTokenEnv: 'GBP_REFRESH_TOKEN_PARRISH',
    googleReviewUrl: 'https://g.page/r/Ca-4KKoWwFacEBM/review',
    gbpWebsitePath: '/pest-control-parrish-fl/',
    gbpUtmContent: 'parrish-profile',
    gbpUtmAliases: ['parrish'],
  },
  {
    id: 'sarasota',
    name: 'Sarasota',
    area: 'Sarasota / Siesta Key',
    address: '1450 Pine Warbler PL, Sarasota, FL 34240',
    latitude: 27.3333,
    longitude: -82.3736,
    phone: '(941) 297-2606',
    phoneRaw: '+19412972606',
    googleAccountId: '115143019869062526912',
    googleLocationId: '2262372053807555721',
    googleLocationResourceName: 'accounts/115143019869062526912/locations/2262372053807555721',
    googlePlaceId: 'ChIJeT_63_Y5w4gRGTNLozgSmdw',
    googleRefreshTokenEnv: 'GBP_REFRESH_TOKEN_SARASOTA',
    googleReviewUrl: 'https://g.page/r/CRkzS6M4EpncEBM/review',
    gbpWebsitePath: '/pest-control-sarasota-fl/',
    gbpUtmContent: 'sarasota-profile',
    gbpUtmAliases: ['sarasota'],
  },
  {
    id: 'venice',
    name: 'Venice',
    area: 'Venice / North Port / Englewood',
    address: '1978 S Tamiami Trl #10, Venice, FL 34293',
    latitude: 27.0870,
    longitude: -82.4046,
    phone: '(941) 297-3337',
    phoneRaw: '+19412973337',
    googleAccountId: '111995684974127201844',
    googleLocationId: '9775694678945206688',
    googleLocationResourceName: 'accounts/111995684974127201844/locations/9775694678945206688',
    googlePlaceId: 'ChIJ81vmrblZw4gRREDmlDUpq0E',
    googleRefreshTokenEnv: 'GBP_REFRESH_TOKEN_VENICE',
    googleReviewUrl: 'https://g.page/r/CURA5pQ1KatBEBM/review',
    gbpWebsitePath: '/pest-control-venice-fl/',
    gbpUtmContent: 'venice-profile',
    gbpUtmAliases: ['venice'],
  },
];

const GBP_UTM_PARAMS = {
  source: 'gbp',
  medium: 'organic',
  campaign: 'website-link',
};

function normalizeGbpUtmContent(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function findGbpLocationByUtmContent(value) {
  const normalized = normalizeGbpUtmContent(value);
  if (!normalized) return null;
  return WAVES_LOCATIONS.find((loc) => {
    const aliases = [
      loc.id,
      loc.name,
      loc.area,
      loc.gbpUtmContent,
      `${loc.id}_profile`,
      ...(loc.gbpUtmAliases || []),
    ].map(normalizeGbpUtmContent);
    return aliases.includes(normalized);
  }) || null;
}

function gbpTrackingUrlForLocation(locationOrId) {
  const loc = typeof locationOrId === 'string'
    ? WAVES_LOCATIONS.find((item) => item.id === locationOrId)
    : locationOrId;
  if (!loc) return null;
  const url = new URL(loc.gbpWebsitePath || '/', 'https://www.wavespestcontrol.com');
  url.searchParams.set('utm_source', GBP_UTM_PARAMS.source);
  url.searchParams.set('utm_medium', GBP_UTM_PARAMS.medium);
  url.searchParams.set('utm_campaign', GBP_UTM_PARAMS.campaign);
  url.searchParams.set('utm_content', loc.gbpUtmContent || loc.id);
  return url.href;
}

function isGbpUtmCampaign({ source, medium, campaign } = {}) {
  const s = String(source || '').trim().toLowerCase();
  const m = String(medium || '').trim().toLowerCase();
  const c = String(campaign || '').trim().toLowerCase();
  return s === 'gbp' || (s === 'google' && m === 'organic' && c === 'gbp');
}

// Haversine distance in miles between two lat/lng pairs. Returns Infinity if
// either point is missing a component — caller falls back to city lookup.
function haversineMiles(a, b) {
  if (!a || !b || a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return Infinity;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Nearest GBP to a customer's lat/lng. Falls back to null when the customer
// has no geocode; callers combine this with resolveLocation(city) for safety.
function nearestLocation(latitude, longitude) {
  if (latitude == null || longitude == null) return null;
  const origin = { latitude, longitude };
  let best = null;
  let bestDist = Infinity;
  for (const loc of WAVES_LOCATIONS) {
    const d = haversineMiles(origin, loc);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best;
}

// City → location mapping. Every city the ZIP fallback (utils/zip-to-city.js)
// can emit must have an entry here, or a recovered city would silently route
// to the Bradenton default — e.g. Charlotte-county leads must reach the Venice
// office, not Bradenton.
const CITY_TO_LOCATION = {
  'lakewood ranch': 'bradenton', 'bradenton': 'bradenton', 'university park': 'bradenton',
  'cortez': 'bradenton', 'anna maria': 'bradenton', 'bradenton beach': 'bradenton', 'holmes beach': 'bradenton',
  'oneco': 'bradenton', 'tallevast': 'bradenton', 'myakka city': 'bradenton',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota', 'osprey': 'sarasota', 'longboat key': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice', 'nokomis': 'venice', 'laurel': 'venice',
  'port charlotte': 'venice', 'punta gorda': 'venice', 'placida': 'venice', 'boca grande': 'venice',
  'parrish': 'parrish', 'palmetto': 'parrish', 'ellenton': 'parrish', 'terra ceia': 'parrish',
  // Northern reach into south Hillsborough served by the Parrish office
  // (mirrors the ZIP routing in routes/satisfaction.js).
  'ruskin': 'parrish', 'apollo beach': 'parrish', 'sun city center': 'parrish',
  'wimauma': 'parrish', 'gibsonton': 'parrish', 'riverview': 'parrish',
};

function resolveLocation(city) {
  const key = (city || '').toLowerCase().trim();
  const locId = CITY_TO_LOCATION[key] || 'bradenton';
  return WAVES_LOCATIONS.find(l => l.id === locId) || WAVES_LOCATIONS[0];
}

// ZIP routing derives through the EXISTING canonical ZIP→city map
// (utils/zip-to-city.js — the full county service-area sets, maintained for
// lead recovery) and then the city map below, instead of a parallel ZIP→office
// table (codex #3285 r4: a parallel table shipped 34243 → sarasota while
// zip-to-city correctly classifies it University Park → bradenton). Only
// consulted when the customer's city is missing or unmapped — a mapped city is
// the stronger signal (service-area intent; a ZIP can straddle two offices).

// Review-routing additions on top of CITY_TO_LOCATION, merged from the two
// private city tables review-request.js and routes/satisfaction.js used to keep.
// Two kinds of entry, and only two:
//
//   1. NEIGHBORHOODS that lead routing never needed a key for — they resolve to
//      the same office their parent city does.
//   2. One genuine OVERRIDE, `longboat key`: lead routing sends LBK to Sarasota,
//      but the Bradenton office is ~14mi from the key versus ~18mi for Sarasota,
//      and the Bradenton profile is the one LBK customers have always been asked
//      to review. Keeping it preserves today's behavior.
//
// `palmetto` used to be overridden to Bradenton here. It is NOT any more —
// Palmetto reviews now go to the Parrish profile, which is the office that
// serves Palmetto and what the tokenized /go link already resolved to.
const REVIEW_CITY_EXTRAS = {
  'longboat key': 'bradenton',   // override — see note above
  'braden river': 'bradenton',
  'bee ridge': 'sarasota',
  'gulf gate': 'sarasota',
  'southgate': 'sarasota',
  'fruitville': 'sarasota',
  'kensington park': 'sarasota',
  'indian beach': 'sarasota',
  'bird key': 'sarasota',
  'lake sarasota': 'sarasota',
  'casey key': 'venice',
  'south venice': 'venice',
  'warm mineral springs': 'venice',
  'rotonda west': 'venice',
  'manasota key': 'venice',
  'rubonia': 'parrish',
  'gillette': 'parrish',
  'duette': 'parrish',
};

const REVIEW_CITY_TO_LOCATION = { ...CITY_TO_LOCATION, ...REVIEW_CITY_EXTRAS };

/**
 * THE review-routing resolver. Every surface that asks a customer for a Google
 * review — the tokenized /go redirect, the rate page, the follow-up SMS, the
 * portal satisfaction prompt — must resolve the target profile through this
 * function, so a customer can never be pointed at two different profiles by two
 * different touches in the same conversation.
 *
 * Resolution order, most-authoritative first:
 *   1. city  — the mapped service area, the strongest statement of which office
 *              owns the address. This is what fixes downtown Sarasota: the
 *              Sarasota office sits in 34240 (Fruitville), FARTHER from 34236
 *              than the Bradenton office is, so pure nearest-office math sent
 *              downtown-Sarasota reviews to the Bradenton profile.
 *   2. zip   — fills in when the city is missing or unmapped.
 *   3. geo   — nearest office by straight-line distance; covers addresses with
 *              neither a mapped city nor a mapped ZIP.
 *   4. the location_id already stored on the ask — a LAST-RESORT fallback, not
 *      an override. Deliberate: rows stamped before this resolver existed
 *      carry ids from the old geo-first logic (the downtown-Sarasota
 *      misroute), so a stored id must not pin a sent link to the wrong
 *      profile; re-resolving from the address heals those. The trade-off —
 *      a customer whose ADDRESS changes after a send sees the link re-target
 *      to their new office's profile — is the desired behavior (they review
 *      the office that serves them now).
 *   5. the default office.
 *
 * @param {object} customer  { city, zip, latitude, longitude }
 * @param {object} [opts]    { storedLocationId } — review_requests.location_id
 * @returns {object} a WAVES_LOCATIONS entry (never null)
 */
function resolveReviewLocation(customer = {}, { storedLocationId = null } = {}) {
  const byId = (id) => WAVES_LOCATIONS.find((l) => l.id === id) || null;

  const city = String(customer.city || '').toLowerCase().trim();
  if (city && REVIEW_CITY_TO_LOCATION[city]) {
    const hit = byId(REVIEW_CITY_TO_LOCATION[city]);
    if (hit) return hit;
  }

  const zip = String(customer.zip || '').trim().slice(0, 5);
  if (zip) {
    // Canonical ZIP → city (utils/zip-to-city.js), then the same review city
    // map as step 1 — so ZIP-only rows inherit the review overrides too
    // (34228 → Longboat Key → bradenton). Unknown ZIPs return '' and fall
    // through; require() here avoids a config↔utils import cycle at load.
    const { zipToCity } = require('../utils/zip-to-city');
    const zipCity = String(zipToCity(zip) || '').toLowerCase().trim();
    if (zipCity && REVIEW_CITY_TO_LOCATION[zipCity]) {
      const hit = byId(REVIEW_CITY_TO_LOCATION[zipCity]);
      if (hit) return hit;
    }
  }

  // Null/blank-guard BEFORE Number(): Number(null) === 0 and Number('') === 0,
  // which would route every un-geocoded customer to the office nearest (0,0)
  // instead of falling through (Codex P2 on PR #2588, same guard as the
  // customer-card picker this resolver absorbed).
  const lat = customer.latitude == null || customer.latitude === '' ? NaN : Number(customer.latitude);
  const lng = customer.longitude == null || customer.longitude === '' ? NaN : Number(customer.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const hit = nearestLocation(lat, lng);
    if (hit) return hit;
  }

  if (storedLocationId) {
    const hit = byId(storedLocationId);
    if (hit) return hit;
  }

  return WAVES_LOCATIONS[0];
}

/** resolveReviewLocation, but returning just the canonical location id. */
function resolveReviewLocationId(customer = {}, opts = {}) {
  return resolveReviewLocation(customer, opts).id;
}

// True when a string is a known office city in CITY_TO_LOCATION. Used to keep a
// non-city source area (e.g. "SW Florida" for the brand-wide lawn domain, or
// arbitrary Google Ads utm_content) from being stored as a customer's city.
function isOfficeCity(city) {
  return !!CITY_TO_LOCATION[(city || '').toLowerCase().trim()];
}

// Resolve the office from an ordered list of city/area candidates, returning
// the first that is actually in CITY_TO_LOCATION. resolveLocation() alone maps
// BOTH an unknown city and an empty string to the Bradenton default, so a bare
// resolveLocation(cityA || cityB) can never fall through to cityB when cityA is
// a real-but-unmapped city (e.g. a Places city of "Rotonda West" would shadow a
// known "Venice" source area). Falls back to the default office when none map.
function resolveLocationFromCandidates(candidates = []) {
  for (const candidate of candidates) {
    const key = (candidate || '').toLowerCase().trim();
    if (key && CITY_TO_LOCATION[key]) return resolveLocation(key);
  }
  return resolveLocation('');
}

module.exports = {
  WAVES_LOCATIONS,
  CITY_TO_LOCATION,
  REVIEW_CITY_EXTRAS,
  REVIEW_CITY_TO_LOCATION,
  resolveReviewLocation,
  resolveReviewLocationId,
  GBP_UTM_PARAMS,
  normalizeGbpUtmContent,
  findGbpLocationByUtmContent,
  gbpTrackingUrlForLocation,
  isGbpUtmCampaign,
  resolveLocation,
  resolveLocationFromCandidates,
  isOfficeCity,
  nearestLocation,
  haversineMiles,
};
