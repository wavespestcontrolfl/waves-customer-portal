const countyZips = require('../config/county-zips');
const TaxCalculator = require('../services/tax-calculator');
const ComplianceService = require('../services/compliance');

// The ZIP arrays exactly as they were hardcoded in tax-calculator.js and
// compliance.js before being centralized into config/county-zips.js. This is
// the regression anchor: the extraction must not have changed a single ZIP.
const ORIGINAL = {
  MANATEE_ZIPS: ['34201', '34202', '34203', '34204', '34205', '34206', '34207', '34208', '34209', '34210',
    '34211', '34212', '34219', '34221', '34222', '34243', '34250', '34251', '34280', '34281', '34282'],
  SARASOTA_ZIPS: ['34228', '34229', '34230', '34231', '34232', '34233', '34234', '34235', '34236', '34237',
    '34238', '34239', '34240', '34241', '34242', '34260', '34275', '34276', '34277', '34278', '34286', '34287', '34288', '34289', '34292', '34293'],
  CHARLOTTE_ZIPS: ['33947', '33948', '33949', '33950', '33952', '33953', '33954', '33955', '33980', '33981', '33982', '33983'],
  LEE_ZIPS: ['33901', '33903', '33904', '33905', '33907', '33908', '33909', '33912', '33913', '33914',
    '33916', '33917', '33919', '33920', '33921', '33922', '33924', '33928', '33931', '33936',
    '33956', '33957', '33965', '33966', '33967', '33971', '33972', '33973', '33974', '33976',
    '33990', '33991', '33993', '34134', '34135'],
  COLLIER_ZIPS: ['34102', '34103', '34104', '34105', '34108', '34109', '34110', '34112', '34113', '34114',
    '34116', '34117', '34119', '34120', '34140', '34141', '34142', '34145'],
};

// Deliberate additions since the extraction — every one listed here, so the
// anchor above stays the extraction record and each later change is explicit.
const ADDED_SINCE_EXTRACTION = {
  SARASOTA_ZIPS: ['34285'], // Venice proper — was tax-invisible (fell back to 7%, no county)
};
const EXPECTED = Object.fromEntries(Object.entries(ORIGINAL).map(([key, zips]) => [
  key, [...zips, ...(ADDED_SINCE_EXTRACTION[key] || [])].sort(),
]));

describe('county-zips = the extraction anchor plus the documented additions', () => {
  for (const key of Object.keys(ORIGINAL)) {
    test(`${key} matches the original hardcoded array plus documented additions`, () => {
      expect([...countyZips[key]].sort()).toEqual(EXPECTED[key]);
    });
  }
  test('no ZIP appears in two tax counties', () => {
    const seen = new Map();
    for (const key of Object.keys(ORIGINAL)) {
      for (const z of countyZips[key]) {
        expect(seen.get(z)).toBeUndefined();
        seen.set(z, key);
      }
    }
  });
});

describe('tax-calculator.inferCountyFromZip is unchanged (5 counties, Capitalized)', () => {
  const expectations = [
    ['MANATEE_ZIPS', 'Manatee'],
    ['SARASOTA_ZIPS', 'Sarasota'],
    ['CHARLOTTE_ZIPS', 'Charlotte'],
    ['LEE_ZIPS', 'Lee'],
    ['COLLIER_ZIPS', 'Collier'],
  ];
  for (const [key, county] of expectations) {
    test(`every ${key} ZIP → ${county}`, () => {
      for (const z of ORIGINAL[key]) expect(TaxCalculator.inferCountyFromZip(z)).toBe(county);
    });
  }
  test('out-of-area / malformed / blank → null; ZIP+4 handled', () => {
    expect(TaxCalculator.inferCountyFromZip('90210')).toBeNull();
    expect(TaxCalculator.inferCountyFromZip('33572')).toBeNull(); // south Hillsborough — not a tax county here
    expect(TaxCalculator.inferCountyFromZip('')).toBeNull();
    expect(TaxCalculator.inferCountyFromZip(null)).toBeNull();
    expect(TaxCalculator.inferCountyFromZip('34219-1234')).toBe('Manatee'); // uses first 5 digits
  });
  test('34285 (Venice proper) → Sarasota — was null, so calculateTax fell back to 7% with no county', () => {
    expect(TaxCalculator.inferCountyFromZip('34285')).toBe('Sarasota');
  });
});

describe('compliance.inferCountyFromZipInternal is unchanged (3 counties, _county suffix)', () => {
  const f = ComplianceService.inferCountyFromZipInternal;
  const expectations = [
    ['MANATEE_ZIPS', 'manatee_county'],
    ['SARASOTA_ZIPS', 'sarasota_county'],
    ['CHARLOTTE_ZIPS', 'charlotte_county'],
  ];
  for (const [key, county] of expectations) {
    test(`every ${key} ZIP → ${county}`, () => {
      for (const z of ORIGINAL[key]) expect(f(z)).toBe(county);
    });
  }
  test('Lee/Collier and out-of-area → null (compliance has no Lee/Collier)', () => {
    expect(f('33901')).toBeNull(); // Lee — tax maps this, compliance does not
    expect(f('34102')).toBeNull(); // Collier
    expect(f('90210')).toBeNull();
    expect(f('')).toBeNull();
  });
  test('34285 (Venice proper) → sarasota_county (shares the tax set)', () => {
    expect(f('34285')).toBe('sarasota_county');
  });
});
