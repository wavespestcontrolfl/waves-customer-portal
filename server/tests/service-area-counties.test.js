const { isInServiceAreaCounty } = require('../services/call-triage-flags');

// Owner ruling 2026-09-30: DeSoto County (Arcadia) is not served. It had been
// listed as a service-area county in call triage since the extraction prompt
// was written, while no city or ZIP map ever included a DeSoto town.
describe('service-area counties', () => {
  test('the three served counties are in, in any casing or with the suffix', () => {
    expect(isInServiceAreaCounty('Manatee')).toBe(true);
    expect(isInServiceAreaCounty('sarasota county')).toBe(true);
    expect(isInServiceAreaCounty('CHARLOTTE')).toBe(true);
  });

  test('DeSoto is out, like any other unserved county', () => {
    expect(isInServiceAreaCounty('DeSoto')).toBe(false);
    expect(isInServiceAreaCounty('DeSoto County')).toBe(false);
    expect(isInServiceAreaCounty('Lee')).toBe(false);
    expect(isInServiceAreaCounty(null)).toBe(false);
  });
});
