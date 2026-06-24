const { zipToCity, ZIP_TO_CITY } = require('../utils/zip-to-city');
const { CITY_TO_LOCATION, resolveLocationFromCandidates, isOfficeCity } = require('../config/locations');
const { REVIEW_GBP_BY_CITY } = require('../services/completion-defaults-resolver');

describe('zipToCity', () => {
  test('resolves the Parrish ZIP that triggered the blank-city lead', () => {
    // "87th Street East, FL 34219" came in with no city token; 34219 → Parrish.
    expect(zipToCity('34219')).toBe('Parrish');
  });

  test('covers the three service-area counties', () => {
    expect(zipToCity('34221')).toBe('Palmetto'); // Manatee
    expect(zipToCity('34222')).toBe('Ellenton'); // Manatee
    expect(zipToCity('34238')).toBe('Sarasota'); // Sarasota
    expect(zipToCity('34293')).toBe('Venice'); // Sarasota
    expect(zipToCity('34286')).toBe('North Port'); // Sarasota
    expect(zipToCity('33952')).toBe('Port Charlotte'); // Charlotte
    expect(zipToCity('33950')).toBe('Punta Gorda'); // Charlotte
  });

  test('covers the canonical service-area ZIPs Codex flagged as missing', () => {
    expect(zipToCity('34217')).toBe('Bradenton Beach'); // Anna Maria Island
    expect(zipToCity('34218')).toBe('Holmes Beach');
    expect(zipToCity('34220')).toBe('Palmetto');
    expect(zipToCity('33921')).toBe('Boca Grande'); // Charlotte
    expect(zipToCity('34272')).toBe('Laurel'); // Sarasota
  });

  test('covers the south-Hillsborough ZIPs the Parrish office serves', () => {
    // Mirror routes/satisfaction.js — these route to the Parrish office.
    expect(zipToCity('33572')).toBe('Apollo Beach');
    expect(zipToCity('33573')).toBe('Sun City Center');
    expect(zipToCity('33534')).toBe('Gibsonton');
    expect(zipToCity('33579')).toBe('Riverview');
    expect(resolveLocationFromCandidates(['', '', zipToCity('33573')]).id).toBe('parrish');
  });

  test('every emitted city routes to a real office (no silent Bradenton default)', () => {
    // Guards against adding a ZIP→city without a CITY_TO_LOCATION entry, which
    // would route a recovered city to the wrong office.
    for (const city of new Set(Object.values(ZIP_TO_CITY))) {
      expect(CITY_TO_LOCATION[city.toLowerCase()]).toBeDefined();
    }
  });

  test('every emitted city is also known to the review-routing map', () => {
    // Guards the second routing surface: a recovered city must not silently
    // default to the Bradenton GBP for review links/routing.
    for (const city of new Set(Object.values(ZIP_TO_CITY))) {
      // A defined entry means resolveReviewRouting() won't hit default_fallback.
      expect(REVIEW_GBP_BY_CITY[city.toLowerCase()]).toBeDefined();
    }
  });

  test('34243 (University Park) keeps Bradenton office + review routing, not Sarasota', () => {
    expect(zipToCity('34243')).toBe('University Park');
    expect(resolveLocationFromCandidates(['', '', zipToCity('34243')]).id).toBe('bradenton');
    expect(REVIEW_GBP_BY_CITY['university park']).toBe('bradenton');
  });

  test('accepts ZIP+4 and messy input, using the first 5 digits', () => {
    expect(zipToCity('34221-1234')).toBe('Palmetto');
    expect(zipToCity('FL 34219')).toBe('Parrish');
    expect(zipToCity(34219)).toBe('Parrish');
  });

  test('returns empty string outside the known service area — never guesses', () => {
    expect(zipToCity('90210')).toBe('');
    expect(zipToCity('00000')).toBe('');
  });

  test('returns empty string for missing/invalid input', () => {
    expect(zipToCity('')).toBe('');
    expect(zipToCity(null)).toBe('');
    expect(zipToCity(undefined)).toBe('');
    expect(zipToCity('abc')).toBe('');
  });
});

describe('resolveLocationFromCandidates', () => {
  test('uses the ZIP-derived city when there is no area (main-site 34219 lead)', () => {
    expect(resolveLocationFromCandidates(['', '', 'Parrish']).id).toBe('parrish');
  });

  test('an unmapped structured city falls through to the known source area', () => {
    // The Codex regression: "Rotonda West" is not in CITY_TO_LOCATION; a bare
    // resolveLocation('Rotonda West') would return Bradenton and shadow the
    // Venice source area. The walker must skip it and use the area.
    expect(resolveLocationFromCandidates(['Rotonda West', 'Venice', '']).id).toBe('venice');
  });

  test('a mapped structured city wins over the source area', () => {
    expect(resolveLocationFromCandidates(['Punta Gorda', 'Bradenton', '']).id).toBe('venice');
  });

  test('falls back to the Bradenton default when nothing is routable', () => {
    expect(resolveLocationFromCandidates(['Rotonda West', 'SW Florida', '']).id).toBe('bradenton');
  });
});

describe('stored-city precedence (mirrors lead-webhook resolvedCity)', () => {
  // Mirrors the resolvedCity expression in routes/lead-webhook.js so the
  // ordering is locked: parsed → routable area → ZIP city → raw area.
  const storedCity = (parsedCity, area, zip) => {
    const zipCity = zipToCity(zip) || '';
    return parsedCity || (isOfficeCity(area) ? area : '') || zipCity || area || '';
  };

  test('a non-city source area (SW Florida) loses to the ZIP city', () => {
    expect(isOfficeCity('SW Florida')).toBe(false);
    expect(storedCity('', 'SW Florida', '34219')).toBe('Parrish');
  });

  test('a routable source area still wins (spoke behavior preserved)', () => {
    expect(storedCity('', 'Venice', '34219')).toBe('Venice');
  });

  test('a parsed structured city always wins', () => {
    expect(storedCity('Rotonda West', 'Venice', '34219')).toBe('Rotonda West');
  });

  test('a non-city area is kept only as a last resort when no ZIP city', () => {
    expect(storedCity('', 'SW Florida', '')).toBe('SW Florida');
  });
});
