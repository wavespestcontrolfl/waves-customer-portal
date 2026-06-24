const { zipToCity } = require('../utils/zip-to-city');

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
