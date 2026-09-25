const {
  acceptWebSearchResult,
  webSearchLegEnabled,
  resolveViaWebSearch,
  parseJson,
} = require('../services/commercial-suite-size/web-search-leg');

describe('webSearchLegEnabled (COMMERCIAL_SUITE_WEB_SEARCH kill switch)', () => {
  const ORIGINAL = process.env.COMMERCIAL_SUITE_WEB_SEARCH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
    else process.env.COMMERCIAL_SUITE_WEB_SEARCH = ORIGINAL;
  });

  test('defaults ON when unset', () => {
    delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
    expect(webSearchLegEnabled()).toBe(true);
  });

  test.each(['0', 'false', 'off', 'FALSE'])('disabled by %s', (v) => {
    process.env.COMMERCIAL_SUITE_WEB_SEARCH = v;
    expect(webSearchLegEnabled()).toBe(false);
  });
});

describe('parseJson', () => {
  test('strips markdown fences', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test('returns null on unparsable text', () => {
    expect(parseJson('not json at all')).toBeNull();
  });
});

describe('acceptWebSearchResult — acceptance rules', () => {
  test('accepts a plausible suite figure that names the suite', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop',
      businessType: 'restaurant',
      suiteSqft: 1400,
      suiteSqftQuote: 'Suite 102 is a 1,400 sq ft restaurant space available for lease.',
      suiteSqftUrl: 'https://www.loopnet.com/example',
    }, { buildingSqft: 46031 });
    expect(result).toEqual(expect.objectContaining({ value: 1400, businessName: 'Test Taco Shop', businessType: 'restaurant' }));
    expect(result.evidence[0].url).toBe('https://www.loopnet.com/example');
  });

  test('rejects a figure whose quote never mentions a suite/unit', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop',
      suiteSqft: 1400,
      suiteSqftQuote: 'The shopping plaza is a 46,000 sq ft retail center.',
    }, { buildingSqft: 46031 });
    // businessName still comes through — discovering the tenant is useful
    // even when the size figure is rejected.
    expect(result).toEqual({ value: null, businessName: 'Test Taco Shop', businessType: null });
  });

  test('rejects a figure that is actually the whole-building total (>50% of known building size)', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Plaza LLC',
      suiteSqft: 40000,
      suiteSqftQuote: 'Suite 102 spans 40,000 sq ft.',
    }, { buildingSqft: 46031 });
    expect(result.value).toBeNull();
  });

  test('rejects an out-of-range suite figure (too small / too large), returning null with nothing else to report', () => {
    expect(acceptWebSearchResult({
      suiteSqft: 50, suiteSqftQuote: 'Suite 102 is 50 sq ft.',
    }, {})).toBeNull();
    expect(acceptWebSearchResult({
      suiteSqft: 50000, suiteSqftQuote: 'Suite 102 is 50,000 sq ft.',
    }, {})).toBeNull();
  });

  test('returns null outright when nothing at all was found', () => {
    expect(acceptWebSearchResult({ suiteSqft: null, suiteSqftQuote: '' }, {})).toBeNull();
  });

  test('accepts a suite figure with no known building size to compare against', () => {
    const result = acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Unit 102 leases at 1,400 sq ft.',
    }, { buildingSqft: null });
    expect(result.value).toBe(1400);
  });
});

describe('resolveViaWebSearch — gating', () => {
  test('skipped when the kill switch is off, without calling any client', async () => {
    process.env.COMMERCIAL_SUITE_WEB_SEARCH = 'false';
    const anthropicClient = { messages: { create: jest.fn() } };
    const result = await resolveViaWebSearch(
      { address: { street: '4400 Test Commons Pkwy E', zip: '00000' } },
      { anthropicClient },
    );
    expect(result).toBeNull();
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
    delete process.env.COMMERCIAL_SUITE_WEB_SEARCH;
  });

  test('skipped with no street address', async () => {
    const anthropicClient = { messages: { create: jest.fn() } };
    const result = await resolveViaWebSearch({ address: {} }, { anthropicClient });
    expect(result).toBeNull();
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  test('a model/network failure resolves null, never throws', async () => {
    const anthropicClient = { messages: { create: jest.fn().mockRejectedValue(new Error('boom')) } };
    await expect(resolveViaWebSearch(
      { address: { street: '4400 Test Commons Pkwy E', zip: '00000' } },
      { anthropicClient },
    )).resolves.toBeNull();
  });

  test('parses a successful model response into an accepted result', async () => {
    const anthropicClient = {
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({
            businessName: 'Test Taco Shop', businessType: 'restaurant', suiteSqft: 1400,
            suiteSqftQuote: 'Suite 102 is 1,400 sq ft.', suiteSqftUrl: 'https://www.loopnet.com/x',
          }) }],
        }),
      },
    };
    const result = await resolveViaWebSearch(
      { address: { street: '4400 Test Commons Pkwy E', unit: '102', zip: '00000' }, buildingSqft: 46031 },
      { anthropicClient },
    );
    expect(result.value).toBe(1400);
    expect(anthropicClient.messages.create).toHaveBeenCalledTimes(1);
    const call = anthropicClient.messages.create.mock.calls[0][0];
    expect(call.tools[0].type).toBe('web_search_20250305');
  });
});
