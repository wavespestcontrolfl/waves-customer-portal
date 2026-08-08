/**
 * The ONE review-routing resolver (config/locations.js).
 *
 * Before this existed there were three answers to "which Google profile does
 * this customer review?" — routes/review-gate.js resolved by straight-line
 * distance, services/review-request.js by its own city table, and
 * routes/satisfaction.js by a third city+ZIP table. The two bugs those
 * disagreements produced are pinned below.
 */

const {
  resolveReviewLocation,
  resolveReviewLocationId,
  nearestLocation,
} = require('../config/locations');

// Downtown Sarasota (34236). The Sarasota office sits in 34240 (Fruitville),
// ~10.5mi east of downtown, while the Bradenton office is ~9.6mi north — so
// nearest-office math picks BRADENTON for a downtown-Sarasota address.
const DOWNTOWN_SARASOTA = { latitude: 27.336, longitude: -82.545 };
// Palmetto (34221).
const PALMETTO = { latitude: 27.5214, longitude: -82.5723 };

describe('review location resolver', () => {
  describe('the bugs it was written to fix', () => {
    test('downtown Sarasota resolves to the Sarasota profile, not Bradenton', () => {
      // Proof the geo fallback alone gets this wrong:
      expect(nearestLocation(DOWNTOWN_SARASOTA.latitude, DOWNTOWN_SARASOTA.longitude).id)
        .toBe('bradenton');

      // The mapped city outranks it.
      expect(resolveReviewLocationId({ city: 'Sarasota', zip: '34236', ...DOWNTOWN_SARASOTA }))
        .toBe('sarasota');
      // ...and the ZIP alone is enough when the city is missing.
      expect(resolveReviewLocationId({ zip: '34236', ...DOWNTOWN_SARASOTA })).toBe('sarasota');
    });

    test('Palmetto resolves to the Parrish profile by city AND by ZIP', () => {
      expect(resolveReviewLocationId({ city: 'Palmetto', ...PALMETTO })).toBe('parrish');
      expect(resolveReviewLocationId({ zip: '34221', ...PALMETTO })).toBe('parrish');
      // 34221 used to map to the Bradenton/LWR profile in satisfaction.js.
      expect(resolveReviewLocationId({ zip: '34221' })).not.toBe('bradenton');
    });
  });

  describe('resolution order: city -> zip -> geo -> stored -> default', () => {
    test('a mapped city wins over a conflicting ZIP', () => {
      expect(resolveReviewLocationId({ city: 'Venice', zip: '34211' })).toBe('venice');
    });

    test('ZIP fills in when the city is unmapped', () => {
      expect(resolveReviewLocationId({ city: 'Rotonda', zip: '33948' })).toBe('venice');
    });

    test('geo fills in when neither city nor ZIP is mapped', () => {
      expect(resolveReviewLocationId({ city: 'Nowhere', zip: '99999', ...DOWNTOWN_SARASOTA }))
        .toBe('bradenton');
    });

    test('the ask stored location is used only when nothing else resolves', () => {
      expect(resolveReviewLocationId({}, { storedLocationId: 'venice' })).toBe('venice');
      // ...and never re-targets an ask whose customer has a mapped city.
      expect(resolveReviewLocationId({ city: 'Parrish' }, { storedLocationId: 'venice' }))
        .toBe('parrish');
    });

    test('an empty customer falls back to the default office', () => {
      expect(resolveReviewLocationId({})).toBe('bradenton');
      expect(resolveReviewLocationId({}, { storedLocationId: 'not-a-real-office' })).toBe('bradenton');
    });
  });

  describe('service-area mappings that must not drift', () => {
    test.each([
      ['Parrish', 'parrish'],
      ['Ellenton', 'parrish'],
      ['Terra Ceia', 'parrish'],
      ['Ruskin', 'parrish'],
      ['Apollo Beach', 'parrish'],
      ['Bradenton', 'bradenton'],
      ['Lakewood Ranch', 'bradenton'],
      ['Anna Maria', 'bradenton'],
      ['Siesta Key', 'sarasota'],
      ['Bee Ridge', 'sarasota'],
      ['Venice', 'venice'],
      ['North Port', 'venice'],
      ['Port Charlotte', 'venice'],
      ['Englewood', 'venice'],
    ])('%s -> %s', (city, expected) => {
      expect(resolveReviewLocationId({ city })).toBe(expected);
    });

    test('Longboat Key keeps its deliberate Bradenton override', () => {
      // Lead routing sends LBK to Sarasota; reviews have always gone to the
      // Bradenton profile, which is also the nearer office.
      expect(resolveReviewLocationId({ city: 'Longboat Key' })).toBe('bradenton');
    });

    test('city and ZIP matching is case- and whitespace-insensitive', () => {
      expect(resolveReviewLocationId({ city: '  pArRiSh  ' })).toBe('parrish');
      expect(resolveReviewLocationId({ zip: ' 34236-1234 ' })).toBe('sarasota');
    });
  });

  test('always returns a real location object carrying a review URL', () => {
    for (const c of [{}, { city: 'Venice' }, { zip: '34221' }, DOWNTOWN_SARASOTA]) {
      const loc = resolveReviewLocation(c);
      expect(loc).toBeTruthy();
      expect(typeof loc.id).toBe('string');
      expect(loc.googleReviewUrl).toMatch(/^https:\/\/g\.page\//);
    }
  });
});
