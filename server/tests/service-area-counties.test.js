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

  // The 2026-11-23 hold ended when the second technician was hired: every place on it is served and stays unflagged.
  test.each([
    [{ city: 'Port Charlotte', county: 'Charlotte', postal_code: '33980' }],
    [{ city: 'Port Charlotte', county: 'Charlotte', postal_code: '33981' }],
    [{ city: 'Port Charlotte', county: 'Charlotte', postal_code: '33948' }],
    [{ city: 'Gulf Cove', county: 'Charlotte' }],
    [{ city: 'Deep Creek', county: 'Charlotte' }],
    [{ city: 'Rotonda West', county: 'Charlotte', postal_code: '33947' }],
    [{ city: 'Placida', county: 'Charlotte' }],
    [{ city: 'Boca Grande', county: 'Charlotte' }],
    [{ city: 'Babcock Ranch', county: 'Charlotte', postal_code: '33982' }],
    [{ postal_code: '33983', county: 'Charlotte' }],
    [{ city: 'Englewood', county: 'Sarasota', postal_code: '34223' }],
    [{ city: 'Englewood', county: 'Charlotte', postal_code: '34224' }],
  ])('a place held on 2026-11-23 %j is served again and unflagged', (sa) => {
    expect(flagsFor(sa)).not.toContain('out_of_service_area');
  });

  test('a ZIP Punta Gorda shares (33980 / 33982 / 33983) with no city is unverified, not served; a served city on it is not flagged', () => {
    for (const postal_code of ['33980', '33982', '33983']) {
      const flags = flagsFor({ county: 'Charlotte', postal_code });
      expect(flags).toContain('address_unverified');
      expect(flags).not.toContain('out_of_service_area');
      expect(flagsFor({ county: 'Charlotte', city: '  ', postal_code })).toContain('address_unverified');
      expect(flagsFor({ county: 'Charlotte', city: 'Port Charlotte', postal_code })).not.toContain('address_unverified');
      expect(flagsFor({ county: 'Charlotte', city: 'Punta Gorda', postal_code })).toContain('out_of_service_area');
    }
    expect(flagsFor({ county: 'Charlotte', postal_code: '33948' })).not.toContain('address_unverified');
  });

  test('North Port and Venice stay unflagged', () => {
    expect(flagsFor({ city: 'North Port', county: 'Sarasota', postal_code: '34287' })).not.toContain('out_of_service_area');
    expect(flagsFor({ city: 'Venice', county: 'Sarasota', postal_code: '34285' })).not.toContain('out_of_service_area');
  });
});
