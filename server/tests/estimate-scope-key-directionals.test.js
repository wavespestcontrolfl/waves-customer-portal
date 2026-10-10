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

describe('directionals expand in the street only, never in a unit identifier', () => {
  test('"Apt E" and "Apt East" are distinct units; the same unit still matches itself', () => {
    expect(property('100 Main St', 'Bradenton', '34203', 'Apt E')).not.toBe(property('100 Main St', 'Bradenton', '34203', 'Apt East'));
    expect(property('100 Main St, Apt E')).not.toBe(property('100 Main St, Apt East'));
    expect(property('100 Main St #E')).not.toBe(property('100 Main St #East'));
    expect(property('100 Main St, Unit W')).not.toBe(property('100 Main St, Unit West'));
    // A bare line2 is a unit too.
    expect(property('100 Main St', 'Bradenton', '34203', 'E')).not.toBe(property('100 Main St', 'Bradenton', '34203', 'East'));
    // Same unit spelled in line 1 or line 2 still keys alike.
    expect(property('100 Main St Apt E')).toBe(property('100 Main St', 'Bradenton', '34203', 'Apt E'));
    expect(property('100 Main St, Apt E.')).toBe(property('100 Main St Apt E'));
  });

  test('a unit does not stop the street directional from matching', () => {
    expect(property('4610 61st Dr E, Apt 4')).toBe(property('4610 61st Drive East', 'Bradenton', '34203', 'Apt 4'));
    expect(property('4610 61st Dr E Apt E')).toBe(property('4610 61st Drive East', 'Bradenton', '34203', 'Apt E'));
    expect(property('4610 61st Dr E Apt E')).not.toBe(property('4610 61st Drive East', 'Bradenton', '34203', 'Apt East'));
    expect(estimate('4610 61st Dr E, Bradenton, FL 34203, USA')).toBe(property('4610 61st Drive East'));
  });
});

