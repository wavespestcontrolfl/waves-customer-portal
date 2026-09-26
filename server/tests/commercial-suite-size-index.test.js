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

  test('skipWebSearch option bypasses the web-search leg entirely (PR #4840 admin lookup cache-hit path)', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);

    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'office_low' }, { skipWebSearch: true });
    expect(resolveViaWebSearch).not.toHaveBeenCalled();
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
  });
});

describe('opts.deadlineAt — the lookup budget, not each leg\'s own full timeout (primary review PR #4840 r5 P2)', () => {
  test('no deadlineAt (the default): both legs run with no timeoutMs override — unaffected callers keep today\'s behavior', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue(null);
    await resolveCommercialSuiteSize({ address: ADDRESS });
    expect(resolveViaDbprLicense.mock.calls[0][1].timeoutMs).toBeUndefined();
    expect(resolveViaWebSearch.mock.calls[0][1].timeoutMs).toBeUndefined();
  });

  test('plenty of budget left: each leg\'s timeoutMs is capped to the remaining budget, not shortened below its own default', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue(null);
    const deadlineAt = Date.now() + 60000; // way more than either leg's own default (15s / 20s)
    await resolveCommercialSuiteSize({ address: ADDRESS }, { deadlineAt });
    expect(resolveViaDbprLicense.mock.calls[0][1].timeoutMs).toBe(15000);
    expect(resolveViaWebSearch.mock.calls[0][1].timeoutMs).toBe(20000);
  });

  test('a short remaining budget shortens each leg\'s timeoutMs below its own default', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    resolveViaWebSearch.mockResolvedValue(null);
    const deadlineAt = Date.now() + 5000; // less than either leg's own default
    await resolveCommercialSuiteSize({ address: ADDRESS }, { deadlineAt });
    expect(resolveViaDbprLicense.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(5000);
    expect(resolveViaWebSearch.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(5000);
  });

  test('under ~2s remaining, the DBPR leg is skipped entirely — falls straight through to web search / type default', async () => {
    resolveViaWebSearch.mockResolvedValue(null);
    const deadlineAt = Date.now() + 1000;
    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'office_low' }, { deadlineAt });
    expect(resolveViaDbprLicense).not.toHaveBeenCalled();
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
  });

  test('under ~2s remaining after DBPR consumed most of the budget, the web-search leg is skipped too — never blocks past the deadline', async () => {
    resolveViaDbprLicense.mockResolvedValue(null);
    const start = Date.now();
    // Deterministic clock: the first remainingBudgetMs() read (before DBPR)
    // sees plenty left, so DBPR runs; the second (before web search) sees
    // DBPR "consumed" all but 500ms — under MIN_LEG_REMAINING_MS (2000).
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(start + 9500);
    try {
      const result = await resolveCommercialSuiteSize(
        { address: ADDRESS, commercialRiskType: 'office_low' },
        { deadlineAt: start + 10000 },
      );
      expect(resolveViaDbprLicense).toHaveBeenCalledTimes(1); // budget was fine at the first check
      expect(resolveViaWebSearch).not.toHaveBeenCalled(); // budget was thin at the second
      expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('an already-past deadline skips both legs and resolves straight to the type default', async () => {
    const deadlineAt = Date.now() - 1000;
    const result = await resolveCommercialSuiteSize({ address: ADDRESS, commercialRiskType: 'retail_standard' }, { deadlineAt });
    expect(resolveViaDbprLicense).not.toHaveBeenCalled();
    expect(resolveViaWebSearch).not.toHaveBeenCalled();
    expect(result.source).toBe(SOURCES.SUITE_TYPE_DEFAULT);
    expect(result.value).toBe(1500);
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
