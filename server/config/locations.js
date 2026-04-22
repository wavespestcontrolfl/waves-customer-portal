const WAVES_LOCATIONS = [
  {
    id: 'lakewood-ranch',
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
  },
  {
    id: 'parrish',
    name: 'Parrish',
    area: 'Parrish / Palmetto / Ellenton',
    address: '5155 115th Dr E, Parrish, FL 34219',
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
  },
];

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
  'lakewood ranch': 'lakewood-ranch', 'bradenton': 'lakewood-ranch', 'university park': 'lakewood-ranch',
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota', 'osprey': 'sarasota',
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice', 'nokomis': 'venice', 'port charlotte': 'venice',
  'parrish': 'parrish', 'palmetto': 'parrish', 'ellenton': 'parrish', 'ruskin': 'parrish', 'apollo beach': 'parrish',
};

function resolveLocation(city) {
  const key = (city || '').toLowerCase().trim();
  const locId = CITY_TO_LOCATION[key] || 'lakewood-ranch';
  return WAVES_LOCATIONS.find(l => l.id === locId) || WAVES_LOCATIONS[0];
}

module.exports = { WAVES_LOCATIONS, CITY_TO_LOCATION, resolveLocation, nearestLocation, haversineMiles };
