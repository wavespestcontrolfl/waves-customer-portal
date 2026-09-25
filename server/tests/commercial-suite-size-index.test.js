jest.mock('../services/commercial-suite-size/dbpr-food-license');
jest.mock('../services/commercial-suite-size/web-search-leg');

const { resolveViaDbprLicense } = require('../services/commercial-suite-size/dbpr-food-license');
const { resolveViaWebSearch } = require('../services/commercial-suite-size/web-search-leg');
const { resolveCommercialSuiteSize, SOURCES } = require('../services/commercial-suite-size');

const ADDRESS = { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveCommercialSuiteSize — priority order', () => {
  test('DBPR license wins over web search and type default', async () => {
    resolveViaDbprLicense.mockResolvedValue({
      value: 1400, businessName: 'Test Taco Shop', seats: 25,
      evidence: [{ source: 'license_seats', detail: '25 seats -> 1,400 sq ft' }],
    });
    resolveViaWebSearch.mockResolvedValue({ value: 2000, businessName: 'Wrong Name' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS });
    expect(result.source).toBe(SOURCES.LICENSE_SEATS);
    expect(result.value).toBe(1400);
    expect(result.businessType).toBe('restaurant_food');
    expect(resolveViaWebSearch).not.toHaveBeenCalled();
  });

  test('web search wins over the type default when DBPR has nothing', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue({
      value: 1800, businessName: 'Test Retail Co', businessType: 'retail',
      evidence: [{ source: 'commercial_listing', detail: 'per listing' }],
    });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'retail_standard' });
    expect(result.source).toBe(SOURCES.COMMERCIAL_LISTING);
    expect(result.value).toBe(1800);
    expect(result.businessName).toBe('Test Retail Co');
  });

  test('falls to the type default when nothing resolves, but keeps a businessName either leg discovered', async () => {
    resolveViaDbprLicense.mockResolvedValue({ value: null, businessName: 'Test Discovered Name' });
    resolveViaWebSearch.mockResolvedValue({ value: null, businessType: 'restaurant' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'restaurant_food' });
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    expect(result.value).toBe(1800); // restaurant default
    expect(result.confidence).toBe('low');
    expect(result.businessName).toBe('Test Discovered Name');
  });

  test('a leg throwing is fail-open — resolution still completes via the next source', async () => {
    resolveViaDbprLicense.mockRejectedValue(new Error('boom'));
    resolveViaWebSearch.mockResolvedValue({ value: 1500, businessType: 'office' });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS });
    expect(result.value).toBe(1500);
    expect(result.source).toBe(SOURCES.COMMERCIAL_LISTING);
  });

  test('skipWebSearch option bypasses the web-search leg entirely', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue({ value: 2000 });

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'office_low' }, { skipWebSearch: true });
    expect(resolveViaWebSearch).not.toHaveBeenCalled();
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
  });
});
