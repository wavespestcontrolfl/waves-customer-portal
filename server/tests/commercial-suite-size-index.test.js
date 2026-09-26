jest.mock('../services/commercial-suite-size/dbpr-food-license');
jest.mock('../services/commercial-suite-size/web-search-leg');

const { resolveViaDbprLicense } = require('../services/commercial-suite-size/dbpr-food-license');
const { resolveViaWebSearch } = require('../services/commercial-suite-size/web-search-leg');
const { resolveCommercialSuiteSize, SOURCES } = require('../services/commercial-suite-size');

const ADDRESS = { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveCommercialSuiteSize — priority order (caller/tech-stated -> license -> type default)', () => {
  test('DBPR license wins over the type default, and web search is never even called', async () => {
    resolveViaDbprLicense.mockResolvedValue({
      value: 1400, businessName: 'Test Taco Shop', seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS });
    expect(result.source).toBe(SOURCES.LICENSE_SEATS);
    expect(result.value).toBe(1400);
    expect(result.businessType).toBe('restaurant_food');
    // A sized DBPR match short-circuits before the web-search leg runs at
    // all — the leg is display-only and has nothing left to contribute.
    expect(resolveViaWebSearch).not.toHaveBeenCalled();
  });

  test('web search can never size a suite — only SOURCES.SUITE_TYPE_DEFAULT exists once DBPR misses', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue({ businessName: 'Test Retail Co', businessType: 'retail' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'retail_standard' });
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    expect(result.value).toBe(1500); // retail_standard default, NOT anything web-search reported
    expect(result.businessName).toBe('Test Retail Co'); // display field only
    expect(SOURCES.COMMERCIAL_LISTING).toBeUndefined(); // the rung is gone entirely
  });

  test('a web-search-reported businessType never picks the type-default size — only commercialRiskType/commercialSubtype do', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    // The web leg claims "restaurant" (1800 default) but the caller's own
    // commercialRiskType says retail (1500) — the model's businessType must
    // be ignored for sizing purposes (AGENTS.md).
    resolveViaWebSearch.mockResolvedValue({ businessName: 'Test Retail Co', businessType: 'restaurant' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'retail_standard' });
    expect(result.value).toBe(1500);
  });

  test('the evidence label matches the key that actually selected the value, never the web-reported businessType (primary review PR #4840 r4 P2)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    // The web leg reports "restaurant" on an office/retail profile — the
    // label must read office_retail (what sized it), not "restaurant" (what
    // the model guessed and had zero say over).
    resolveViaWebSearch.mockResolvedValue({ businessName: 'Test Retail Co', businessType: 'restaurant' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialSubtype: 'office_retail' });
    expect(result.value).toBe(1500);
    expect(result.businessType).toBe('restaurant'); // still rides the result for display
    expect(result.evidence[0].detail).toContain('office_retail');
    expect(result.evidence[0].detail).not.toContain('restaurant');
  });

  test('falls to the type default when nothing resolves, but keeps a businessName either leg discovered', async () => {
    resolveViaDbprLicense.mockResolvedValue({ value: null, businessName: 'Test Discovered Name' });
    resolveViaWebSearch.mockResolvedValue({ businessType: null });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'restaurant_food' });
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    expect(result.value).toBe(1800); // restaurant default, from commercialRiskType
    expect(result.confidence).toBe('low');
    expect(result.businessName).toBe('Test Discovered Name');
  });

  test('a leg throwing is fail-open — resolution still completes via the type default', async () => {
    resolveViaDbprLicense.mockRejectedValue(new Error('boom'));
    resolveViaWebSearch.mockRejectedValue(new Error('boom too'));

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'office_low' });
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    expect(result.value).toBe(1500);
  });

  test('resolveCommercialSuiteSize never forwards a buildingSqft param anywhere — the field was removed with the sizing rung', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue(null);
    await resolveCommercialSuiteSize({ address: ADDRESS });
    const dbprCallArg = resolveViaDbprLicense.mock.calls[0][0];
    const webCallArg = resolveViaWebSearch.mock.calls[0][0];
    expect(dbprCallArg.buildingSqft).toBeUndefined();
    expect(webCallArg.buildingSqft).toBeUndefined();
  });
});

describe('suiteAddressParts', () => {
  const { suiteAddressParts } = require('../services/commercial-suite-size');
  test('unit-first address splits into street + unit', () => {
    const p = suiteAddressParts('Unit 102, 4400 Test Commons Pkwy E, Bradenton, FL 00000');
    expect(p.street).toMatch(/^4400 Test Commons Pkwy E/i);
    expect(String(p.unit)).toMatch(/102/);
    expect(p.zip).toBe('00000');
  });
  test('street-first address with trailing unit still splits', () => {
    const p = suiteAddressParts('4400 Test Commons Pkwy E Unit 102, Bradenton, FL 00000');
    expect(p.street).toMatch(/^4400 Test Commons Pkwy E$/i);
    expect(String(p.unit)).toMatch(/102/);
  });
});
