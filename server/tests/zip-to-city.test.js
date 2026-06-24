const { zipToCity, ZIP_TO_CITY } = require('../utils/zip-to-city');
const { CITY_TO_LOCATION } = require('../config/locations');

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

  test('every emitted city routes to a real office (no silent Bradenton default)', () => {
    // Guards against adding a ZIP→city without a CITY_TO_LOCATION entry, which
    // would route a recovered city to the wrong office.
    for (const city of new Set(Object.values(ZIP_TO_CITY))) {
      expect(CITY_TO_LOCATION[city.toLowerCase()]).toBeDefined();
    }
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
