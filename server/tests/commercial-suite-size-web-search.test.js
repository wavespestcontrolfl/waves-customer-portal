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
  test('accepts "Suite 102 … 1,450 SF" when 102 is the target unit', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop',
      businessType: 'restaurant',
      suiteSqft: 1450,
      suiteSqftQuote: 'Suite 102 is a 1,450 SF restaurant space available for lease.',
      suiteSqftUrl: 'https://www.loopnet.com/example',
    }, { buildingSqft: 46031, unit: '102' });
    expect(result).toEqual(expect.objectContaining({ value: 1450, businessName: 'Test Taco Shop', businessType: 'restaurant' }));
    expect(result.evidence[0].url).toBe('https://www.loopnet.com/example');
  });

  test('no unit known at all -> never accepts a sqft, even with no building size and a plausible-looking quote', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop',
      suiteSqft: 1400,
      suiteSqftQuote: 'The shopping plaza is a 46,000 sq ft retail center with retail space available.',
    }, { buildingSqft: null }); // no unit passed
    // businessName still comes through — discovering the tenant is useful
    // even when the size figure is rejected.
    expect(result).toEqual({ value: null, businessName: 'Test Taco Shop', businessType: null });
  });

  test('rejects a quote naming a DIFFERENT suite number than the target unit', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Taco Shop',
      suiteSqft: 1400,
      suiteSqftQuote: 'Suite 104 leases at 1,400 sq ft.',
    }, { buildingSqft: 46031, unit: '102' });
    expect(result.value).toBeNull();
  });

  test('a bare "space" mention with no bound unit number is not accepted (the fixed overquote class)', () => {
    const result = acceptWebSearchResult({
      suiteSqft: 40000,
      suiteSqftQuote: '40,000 sq ft of retail space available in this shopping plaza.',
    }, { buildingSqft: 46031, unit: '102' });
    expect(result).toBeNull();
  });

  test('rejects a figure that is actually the whole-building total (>50% of known building size), even when it names the right suite', () => {
    const result = acceptWebSearchResult({
      businessName: 'Test Plaza LLC',
      suiteSqft: 40000,
      suiteSqftQuote: 'Suite 102 spans 40,000 sq ft.',
    }, { buildingSqft: 46031, unit: '102' });
    expect(result.value).toBeNull();
  });

  test('rejects an out-of-range suite figure (too small / too large), returning null with nothing else to report', () => {
    expect(acceptWebSearchResult({
      suiteSqft: 50, suiteSqftQuote: 'Suite 102 is 50 sq ft.',
    }, { unit: '102' })).toBeNull();
    expect(acceptWebSearchResult({
      suiteSqft: 50000, suiteSqftQuote: 'Suite 102 is 50,000 sq ft.',
    }, { unit: '102' })).toBeNull();
  });

  test('returns null outright when nothing at all was found', () => {
    expect(acceptWebSearchResult({ suiteSqft: null, suiteSqftQuote: '' }, { unit: '102' })).toBeNull();
  });

  test('accepts a suite figure with no known building size to compare against', () => {
    const result = acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Unit 102 leases at 1,400 sq ft.',
    }, { buildingSqft: null, unit: '102' });
    expect(result.value).toBe(1400);
  });

  test('the target unit itself may carry a designator ("#102", "Suite 102") — address-normalizer never hands over a bare number', () => {
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Suite 102 is 1,400 sq ft.',
    }, { unit: '#102' }).value).toBe(1400);
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Suite 102 is 1,400 sq ft.',
    }, { unit: 'Suite 102' }).value).toBe(1400);
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Suite 104 is 1,400 sq ft.', // wrong suite
    }, { unit: '#102' })).toBeNull();
  });

  test('matches "Ste. 102", "#102", and reversed "102 Suite" phrasing, all bound to the target unit', () => {
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Ste. 102 is 1,400 sq ft.',
    }, { unit: '102' }).value).toBe(1400);
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'Unit #102 leases at 1,400 sq ft.',
    }, { unit: '102' }).value).toBe(1400);
    expect(acceptWebSearchResult({
      suiteSqft: 1400, suiteSqftQuote: 'The 102 Suite space is 1,400 sq ft.',
    }, { unit: '102' }).value).toBe(1400);
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
