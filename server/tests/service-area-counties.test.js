const { isInServiceAreaCounty, computeDeterministicTriageFlags } = require('../services/call-triage-flags');

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

// Owner ruling 2026-10-22: the city of Punta Gorda is not served although its
// county (Charlotte) is, so the county test alone cannot refuse it.
describe('Punta Gorda triage flag', () => {
  const extraction = (service_address) => ({
    meta: { is_voicemail: false, is_spam: false },
    property: { service_address },
  });
  const flagsFor = (sa) => computeDeterministicTriageFlags(extraction(sa));

  test('Charlotte county itself stays served', () => {
    expect(isInServiceAreaCounty('Charlotte County')).toBe(true);
  });

  test('Punta Gorda + Charlotte county is flagged out_of_service_area', () => {
    expect(flagsFor({ city: 'Punta Gorda', county: 'Charlotte', postal_code: '33950' })).toContain('out_of_service_area');
    expect(flagsFor({ city: 'Punta Gorda', county: 'Charlotte', postal_code: '33983' })).toContain('out_of_service_area');
  });

  test('a Punta Gorda-only ZIP alone is flagged', () => {
    expect(flagsFor({ county: 'Charlotte', postal_code: '33950' })).toContain('out_of_service_area');
  });

  test('Port Charlotte (33980, 33948) and Englewood stay unflagged', () => {
    expect(flagsFor({ city: 'Port Charlotte', county: 'Charlotte', postal_code: '33980' })).not.toContain('out_of_service_area');
    expect(flagsFor({ city: 'Port Charlotte', county: 'Charlotte', postal_code: '33948' })).not.toContain('out_of_service_area');
    expect(flagsFor({ city: 'Englewood', county: 'Charlotte', postal_code: '34223' })).not.toContain('out_of_service_area');
    expect(flagsFor({ postal_code: '33983', county: 'Charlotte' })).not.toContain('out_of_service_area');
  });
});
