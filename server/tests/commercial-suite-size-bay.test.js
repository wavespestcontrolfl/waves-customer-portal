/**
 * Plaza "Bay" unit designator for commercial suite sizing (Codex #4840
 * r11 P2): address splitting and the suite-scope decision.
 */

// Suite sizing ships dark behind GATE_COMMERCIAL_SUITE_SIZING; these tests exercise it ON.
process.env.GATE_COMMERCIAL_SUITE_SIZING = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/commercial-suite-size');

const { _private: routePrivate } = require('../routes/property-lookup-v2');

const SUITE_SIZING_ON = { commercialSuiteSizing: true };

function plazaSuiteRecord(overrides = {}) {
  return {
    formattedAddress: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    propertyType: 'Commercial',
    squareFootage: 46031,
    unitCount: 1,
    _source: 'county',
    _parcel: { landUseDescription: 'Community Shopping Centers (1555)' },
    _fieldEvidence: {
      propertyType: { value: 'Commercial', confidence: 'high', sourceType: 'county', fieldVerify: false, score: 100 },
    },
    ...overrides,
  };
}


// Codex #4840 r11 P2: a plaza "Bay 12" address is a suite. The shared parser
// has no Bay designator, so suiteAddressParts spells it Suite and the scope
// check recognizes it; street names containing "Bay" stay street text.
describe('plaza "Bay" designator', () => {
  const { suiteAddressParts } = require('../services/commercial-suite-size/address-parts');
  const { resolveCommercialSuiteScope } = routePrivate;

  test.each([
    ['4400 Test Commons Pkwy E Bay 12, Bradenton, FL 00000', 'Suite 12'],
    ['4400 Test Commons Pkwy E, Bay 12, Bradenton, FL 00000', 'Suite 12'],
    ['Bay 12, 4400 Test Commons Pkwy E, Bradenton, FL 00000', 'Suite 12'],
    ['4400 Test Commons Pkwy E Bay A, Bradenton, FL 00000', 'Suite A'],
  ])('%s splits the unit out as %s', (address, unit) => {
    const parts = suiteAddressParts(address);
    expect(parts.unit).toBe(unit);
    expect(parts.street).toBe('4400 Test Commons Pkwy E');
  });

  test.each(['4400 Bay St, Bradenton, FL 00000', '4400 Baywood Dr, Bradenton, FL 00000', '100 Tampa Bay Blvd, Tampa, FL 00000'])(
    '%s keeps "Bay" as street text',
    (address) => { expect(suiteAddressParts(address).unit).toBe(''); },
  );

  test('a Bay address on a plaza record is suite-scoped', () => {
    const scope = resolveCommercialSuiteScope(plazaSuiteRecord(), '4400 Test Commons Pkwy E Bay 12, Bradenton, FL 00000', 'office_retail', SUITE_SIZING_ON);
    expect(scope.applies).toBe(true);
  });

  test.each(['4400 Space Coast Blvd, Bradenton, FL 00000', '4400 Spc Coast Blvd, Bradenton, FL 00000'])(
    '%s is a street, not a suite (Codex #4840 r12 P2)',
    (address) => {
      expect(resolveCommercialSuiteScope(plazaSuiteRecord(), address, 'office_retail', SUITE_SIZING_ON).applies).toBe(false);
    },
  );

  test('a Space 12 plaza address is still suite-scoped', () => {
    const scope = resolveCommercialSuiteScope(plazaSuiteRecord(), '4400 Test Commons Pkwy E Space 12, Bradenton, FL 00000', 'office_retail', SUITE_SIZING_ON);
    expect(scope.applies).toBe(true);
  });

  test('a Bay St street address is not suite-scoped', () => {
    const scope = resolveCommercialSuiteScope(plazaSuiteRecord(), '4400 Bay St, Bradenton, FL 00000', 'office_retail', SUITE_SIZING_ON);
    expect(scope.applies).toBe(false);
  });
});

// Codex #4840 r14 P1s.
describe('association subtype and verified suite stories', () => {
  const { resolveCommercialSuiteScope } = routePrivate;
  const { buildEnrichedProfile } = require('../routes/property-lookup-v2');
  const ADDRESS = '4400 Test Commons Pkwy E #102, Bradenton, FL 00000';

  test.each(['hoa_common_area_commercial', 'multifamily_common_area_residential'])(
    'a property the county types as an association (%s) is never suite-scoped',
    (subtype) => {
      expect(resolveCommercialSuiteScope(plazaSuiteRecord(), ADDRESS, subtype, SUITE_SIZING_ON).applies).toBe(false);
    },
  );

  test('a story count verified on the suite address survives the suite blanking as verified', () => {
    const record = plazaSuiteRecord({
      stories: 2,
      _storiesSource: 'verified',
    });
    const profile = buildEnrichedProfile(record, null, 27.5, -82.45, null, null, ADDRESS, SUITE_SIZING_ON);
    expect(profile.stories).toBe(2);
    expect(profile.storiesSource).toBe('verified');
  });

  test('an unverified building story count still defaults the suite to one floor', () => {
    const profile = buildEnrichedProfile(plazaSuiteRecord({ stories: 3 }), null, 27.5, -82.45, null, null, ADDRESS, SUITE_SIZING_ON);
    expect(profile.stories).toBe(1);
    expect(profile.storiesSource).toBe('default');
  });
});
