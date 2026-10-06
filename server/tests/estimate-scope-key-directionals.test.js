// Property scope keys: a street DIRECTIONAL spelled out ("East") and abbreviated
// ("E") key the same house. The Google-formatted estimate address
// "4610 61st Dr E, Bradenton, FL 34203, USA" and the property row
// "4610 61st Drive East" are one house; the keys differed ("...drivee" vs
// "...driveeast"), so an estimate-linked visit read as another premises.
// Synthetic addresses only.

const linkage = require('../services/estimate-property-linkage');
const { sameResolvedProperty } = require('../services/service-report/visit-property-scope');

const property = (line1, city = 'Bradenton', zip = '34203', line2 = null) => linkage.normalizedStampedStreet(line1, line2, city, zip);
const estimate = (raw) => linkage.normalizedEstimateStreet(raw);

describe('scope keys canonicalize street directionals', () => {
  test('one-line estimate "Dr E" is the property "Drive East"', () => {
    const est = estimate('4610 61st Dr E, Bradenton, FL 34203, USA');
    const prop = property('4610 61st Drive East');
    expect(est).toBe(prop);
    expect(sameResolvedProperty(est, prop)).toBe(true);
  });

  test('every directional abbreviation matches its spelled-out form', () => {
    const pairs = [['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West'], ['NE', 'Northeast'], ['NW', 'Northwest'], ['SE', 'Southeast'], ['SW', 'Southwest']];
    for (const [abbr, full] of pairs) {
      expect(property(`100 ${abbr} Test Palm Way`)).toBe(property(`100 ${full} Test Palm Way`));
      expect(property(`100 Test Palm Way ${abbr}.`)).toBe(property(`100 Test Palm Way ${full}`));
    }
  });

  test('a different house in the same zip, or the opposite directional, stays another premises', () => {
    const prop = property('4610 61st Drive East');
    expect(sameResolvedProperty(estimate('4612 61st Dr E, Bradenton, FL 34203, USA'), prop)).toBe(false);
    expect(sameResolvedProperty(estimate('4610 61st Dr W, Bradenton, FL 34203, USA'), prop)).toBe(false);
    expect(sameResolvedProperty(estimate('4610 61st Dr, Bradenton, FL 34203, USA'), prop)).toBe(false);
  });
});
