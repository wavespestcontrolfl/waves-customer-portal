const { deriveStatus, buildAddressLines, STATUSES, validateAddress } = require('../services/address-validation');

describe('buildAddressLines', () => {
  test('street + city/state/zip → two lines', () => {
    expect(buildAddressLines({ street_line_1: '17451 State Road 62', city: 'Parrish', state: 'FL', postal_code: '34219' }))
      .toEqual(['17451 State Road 62', 'Parrish FL 34219']);
  });
  test('includes street_line_2 on line 1', () => {
    expect(buildAddressLines({ street_line_1: '100 Main St', street_line_2: 'Apt 4', city: 'Bradenton', state: 'FL' }))
      .toEqual(['100 Main St Apt 4', 'Bradenton FL']);
  });
  test('city only (no street) still validates (locality-level)', () => {
    expect(buildAddressLines({ city: 'Sarasota', state: 'FL' })).toEqual(['Sarasota FL']);
  });
  test('nothing usable → [] (validateAddress will no-op to not_attempted)', () => {
    expect(buildAddressLines({ street_line_1: null, city: null, postal_code: null })).toEqual([]);
    expect(buildAddressLines(null)).toEqual([]);
    expect(buildAddressLines({ postal_code: '34219' })).toEqual([]); // zip alone isn't worth an API call
  });
});

// Minimal Google AV `result` shapes for the pure status mapper.
function result({ complete = true, granularity = 'PREMISE', inferred = false, replaced = false, unconfirmed = false } = {}) {
  return {
    verdict: {
      addressComplete: complete,
      validationGranularity: granularity,
      hasInferredComponents: inferred,
      hasReplacedComponents: replaced,
      hasUnconfirmedComponents: unconfirmed,
    },
    address: {
      addressComponents: [
        { componentType: 'street_number', componentName: { text: '17451' } },
        { componentType: 'route', componentName: { text: 'Florida 62' } },
        { componentType: 'locality', componentName: { text: 'Parrish' } },
        { componentType: 'administrative_area_level_1', componentName: { text: 'FL' } },
        { componentType: 'postal_code', componentName: { text: '34219' } },
      ],
    },
  };
}

describe('deriveStatus (Google AV → provider-neutral status)', () => {
  test('clean in-area premise → validated_accept', () => {
    const r = deriveStatus(result(), 'Manatee County');
    expect(r.status).toBe(STATUSES.VALIDATED_ACCEPT);
    expect(r.inServiceArea).toBe(true);
    expect(r.normalized.postal_code).toBe('34219');
  });

  test('inferred-only (benign normalization / missing zip filled) in-area → validated_accept', () => {
    // Google sets hasInferred on nearly every clean address (expands abbreviations,
    // fills a missing zip). That is NOT a correction — it stays validated_accept.
    expect(deriveStatus(result({ inferred: true }), 'Sarasota County').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });

  test('replaced material (bad zip rewritten) in-area → corrected (trust the correction)', () => {
    const r = deriveStatus(result({ replaced: true }), 'Manatee County');
    expect(r.status).toBe(STATUSES.CORRECTED);
  });

  test('unconfirmed material → confirm_needed (genuinely unverified, never auto-route)', () => {
    expect(deriveStatus(result({ unconfirmed: true }), 'Charlotte County').status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('replaced AND unconfirmed → confirm_needed (uncertainty dominates a correction)', () => {
    expect(deriveStatus(result({ replaced: true, unconfirmed: true }), 'Manatee County').status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('in-area unknown county (null) → confirm_needed, never accept', () => {
    expect(deriveStatus(result(), null).status).toBe(STATUSES.CONFIRM_NEEDED);
  });

  test('complete premise but out-of-area county → out_of_service_area', () => {
    const r = deriveStatus(result(), 'Fulton County');
    expect(r.status).toBe(STATUSES.OUT_OF_SERVICE_AREA);
    expect(r.inServiceArea).toBe(false);
  });

  test('not premise-level (ROUTE) → missing_component', () => {
    expect(deriveStatus(result({ granularity: 'ROUTE' }), 'Manatee County').status).toBe(STATUSES.MISSING_COMPONENT);
  });

  test('premise-level but flagged incomplete → ambiguous', () => {
    expect(deriveStatus(result({ complete: false, granularity: 'PREMISE' }), 'Manatee County').status).toBe(STATUSES.AMBIGUOUS);
  });

  test('incomplete / garbage geocoded out-of-area → missing_component, not out_of_service_area', () => {
    const r = deriveStatus(result({ complete: false, granularity: 'OTHER' }), 'Gunnison County');
    expect(r.status).toBe(STATUSES.MISSING_COMPONENT);
  });

  test('county normalization handles "X County" and case', () => {
    expect(deriveStatus(result(), 'manatee').status).toBe(STATUSES.VALIDATED_ACCEPT);
    expect(deriveStatus(result(), 'DESOTO COUNTY').status).toBe(STATUSES.VALIDATED_ACCEPT);
  });
});

describe('validateAddress deadline handling', () => {
  const realFetch = global.fetch;
  const realEnabled = process.env.ADDRESS_VALIDATION_ENABLED;
  const realKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.ADDRESS_VALIDATION_ENABLED = 'true';
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (realEnabled === undefined) delete process.env.ADDRESS_VALIDATION_ENABLED;
    else process.env.ADDRESS_VALIDATION_ENABLED = realEnabled;
    if (realKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = realKey;
  });

  // A stalled Google connection must not hang the caller (e.g. the call
  // processor sitting in processing_status='processing'); the run deadline
  // aborts the fetch and validateAddress fails closed to api_unavailable.
  test('fails closed when the caller run deadline is already spent', async () => {
    global.fetch = (_url, opts = {}) => {
      if (opts.signal?.aborted) {
        const e = new Error('aborted'); e.name = 'AbortError';
        return Promise.reject(e);
      }
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError';
          reject(e);
        });
      });
    };
    const spent = new AbortController();
    spent.abort();
    const res = await validateAddress({
      addressLines: ['123 Main St', 'Bradenton FL 34205'],
      signal: spent.signal,
    });
    expect(res.status).toBe(STATUSES.API_UNAVAILABLE);
  });
});

describe('reverse geocode timeout budget', () => {
  const realFetch = global.fetch;
  const realEnabled = process.env.ADDRESS_VALIDATION_ENABLED;
  const realKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.ADDRESS_VALIDATION_ENABLED = 'true';
    process.env.GOOGLE_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (realEnabled === undefined) delete process.env.ADDRESS_VALIDATION_ENABLED;
    else process.env.ADDRESS_VALIDATION_ENABLED = realEnabled;
    if (realKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = realKey;
  });

  const AV_RESULT = {
    result: {
      verdict: { addressComplete: true, validationGranularity: 'PREMISE' },
      address: {
        addressComponents: [
          { componentType: 'street_number', componentName: { text: '17451' } },
          { componentType: 'route', componentName: { text: 'Florida 62' } },
          { componentType: 'locality', componentName: { text: 'Parrish' } },
          { componentType: 'administrative_area_level_1', componentName: { text: 'FL' } },
          { componentType: 'postal_code', componentName: { text: '34219' } },
        ],
      },
      geocode: { location: { latitude: 27.58, longitude: -82.42 } },
    },
    responseId: 'resp-1',
  };
  const GEO_RESULT = {
    results: [{ address_components: [{ types: ['administrative_area_level_2'], long_name: 'Manatee County' }] }],
  };

  // The AV POST's 30s AbortSignal.timeout starts ticking before the request;
  // if the reverse geocode reused it, a slow first call would leave the
  // geocode a near-zero budget — it aborts instantly, county comes back null,
  // and a valid in-area address silently downgrades to confirm_needed. The
  // geocode must get its OWN fresh per-call cap while still honoring the
  // caller's run deadline.
  test('reverse geocode gets a fresh signal, still bound by the caller deadline', async () => {
    const caller = new AbortController();
    const seen = [];
    global.fetch = async (url, opts = {}) => {
      seen.push({ url: String(url), signal: opts.signal });
      if (String(url).includes('addressvalidation.googleapis.com')) {
        return { ok: true, json: async () => AV_RESULT };
      }
      // Reverse geocode: fresh budget (not the AV POST's spent signal), and
      // the caller's run deadline must still propagate into it.
      expect(opts.signal).not.toBe(seen[0].signal);
      expect(opts.signal.aborted).toBe(false);
      caller.abort();
      expect(opts.signal.aborted).toBe(true);
      return { ok: true, json: async () => GEO_RESULT };
    };

    const res = await validateAddress({
      addressLines: ['17451 State Road 62', 'Parrish FL 34219'],
      signal: caller.signal,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toContain('maps.googleapis.com');
    expect(res.county).toBe('Manatee County');
    expect(res.status).toBe(STATUSES.VALIDATED_ACCEPT);
  });
});
