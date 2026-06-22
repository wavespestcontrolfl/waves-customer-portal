/**
 * buildFallbackPropertyDataQuality must emit missingCriticalFields.
 *
 * The provisional-estimate guard and the property panel's "Missing" badges read
 * propertyDataQuality.missingCriticalFields. The real buildPropertyDataQuality
 * emits it; the fallback (used when rc._dataQuality is absent) historically did
 * not, so a thin fallback lookup looked like nothing was missing and a 3/4
 * 'medium' quote skipped the provisional warning before sending.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private: routePrivate } = require('../routes/property-lookup-v2');
const { buildFallbackPropertyDataQuality } = routePrivate;

describe('buildFallbackPropertyDataQuality', () => {
  test('no record → all four critical fields missing', () => {
    const q = buildFallbackPropertyDataQuality(null);
    expect(q.level).toBe('low');
    expect(q.verifiedCriticalFields).toBe(0);
    expect(q.missingCriticalFields).toEqual([
      'squareFootage', 'lotSize', 'stories', 'propertyType',
    ]);
  });

  test('3/4 present → the one absent field is listed (the codex P2 case)', () => {
    const q = buildFallbackPropertyDataQuality({
      squareFootage: 2000, lotSize: 8000, stories: 1, propertyType: '', // type missing
    });
    expect(q.level).toBe('medium'); // 3/4 still reads medium...
    expect(q.verifiedCriticalFields).toBe(3);
    expect(q.fieldVerifyCount).toBe(1);
    expect(q.missingCriticalFields).toEqual(['propertyType']); // ...but the gap is now visible
  });

  test('all four present → nothing missing', () => {
    const q = buildFallbackPropertyDataQuality({
      squareFootage: 2000, lotSize: 8000, stories: 2, propertyType: 'Townhome',
    });
    expect(q.verifiedCriticalFields).toBe(4);
    expect(q.missingCriticalFields).toEqual([]);
    expect(q.fieldVerifyCount).toBe(0);
  });
});
