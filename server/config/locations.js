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
    gbpUtmContent: 'lakewood_ranch',
    gbpUtmAliases: ['bradenton', 'bradenton_profile', 'lakewood_ranch_profile', 'lwr'],
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
    gbpUtmContent: 'parrish',
    gbpUtmAliases: ['parrish_profile'],
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
    gbpUtmContent: 'sarasota',
    gbpUtmAliases: ['sarasota_profile'],
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
    gbpUtmContent: 'venice',
    gbpUtmAliases: ['venice_profile'],
  },
];

const GBP_UTM_PARAMS = {
  source: 'google',
  medium: 'organic',
  campaign: 'gbp',
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
  const url = new URL(loc.gbpWebsitePath || '/', 'https://wavespestcontrol.com');
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

// City → location mapping
const CITY_TO_LOCATION = {
  'lakewood ranch': 'bradenton', 'bradenton': 'bradenton', 'university park': 'bradenton',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota', 'osprey': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice', 'nokomis': 'venice', 'port charlotte': 'venice',
  'parrish': 'parrish', 'palmetto': 'parrish', 'ellenton': 'parrish', 'ruskin': 'parrish', 'apollo beach': 'parrish',
};

function resolveLocation(city) {
  const key = (city || '').toLowerCase().trim();
  const locId = CITY_TO_LOCATION[key] || 'bradenton';
  return WAVES_LOCATIONS.find(l => l.id === locId) || WAVES_LOCATIONS[0];
}

module.exports = {
  WAVES_LOCATIONS,
  CITY_TO_LOCATION,
  GBP_UTM_PARAMS,
  normalizeGbpUtmContent,
  findGbpLocationByUtmContent,
  gbpTrackingUrlForLocation,
  isGbpUtmCampaign,
  resolveLocation,
  nearestLocation,
  haversineMiles,
};
