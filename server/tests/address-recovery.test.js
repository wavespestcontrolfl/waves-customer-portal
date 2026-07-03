/**
 * Address recovery — second-chance lookup for streets Google Address
 * Validation couldn't resolve (transcription garbles: "Seafoam Trail" heard
 * as "C Phone Trl"). All network/model calls are injected via deps.
 */

const { recoverStreetAddress, houseNumberOf } = require('../services/address-validation/recovery');

// The real-world shape that motivated this module: caller said "5039 Seafoam
// Trail", the transcriber wrote "5039 C Phone Trl", AV returned
// missing_component, and the raw garble persisted to the lead + customer.
const GARBLED = { address_line1: '5039 C Phone Trl', city: 'Lakewood Ranch', state: 'FL', zip: '34211' };

const avAccept = (overrides = {}) => ({
  status: 'validated_accept',
  county: 'Manatee County',
  normalized: { street_line_1: '5039 Seafoam Trail', city: 'Lakewood Ranch', state: 'FL', postal_code: '34211-1407' },
  ...overrides,
});

const deps = ({ autocomplete, phonetic, validate }) => ({
  autocomplete: autocomplete || (async () => []),
  phonetic: phonetic || (async () => []),
  validate: validate || (async () => avAccept()),
});

describe('houseNumberOf', () => {
  test('leading house number', () => {
    expect(houseNumberOf('5039 C Phone Trl')).toBe('5039');
    expect(houseNumberOf('5039 Seafoam Trail, Lakewood Ranch, FL, USA')).toBe('5039');
  });
  test('no house number → null', () => {
    expect(houseNumberOf('Seafoam Trail')).toBeNull();
    expect(houseNumberOf('')).toBeNull();
  });
});

describe('recoverStreetAddress — guards', () => {
  test('not attempted for a status AV already resolved', async () => {
    for (const avStatus of ['validated_accept', 'corrected', 'out_of_service_area', 'not_attempted', 'api_unavailable']) {
      const out = await recoverStreetAddress({ extracted: GARBLED, avStatus, deps: deps({}) });
      expect(out.attempted).toBe(false);
      expect(out.recovered).toBeNull();
    }
  });

  test('not attempted without a house number to anchor on', async () => {
    const out = await recoverStreetAddress({
      extracted: { ...GARBLED, address_line1: 'C Phone Trl' },
      avStatus: 'missing_component',
      deps: deps({ autocomplete: async () => ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] }),
    });
    expect(out.attempted).toBe(false);
  });

  test('not attempted without any locality context (no city, no zip)', async () => {
    const out = await recoverStreetAddress({
      extracted: { address_line1: '5039 C Phone Trl' },
      avStatus: 'missing_component',
      deps: deps({}),
    });
    expect(out.attempted).toBe(false);
  });

  test('kill switch ADDRESS_RECOVERY_ENABLED=false', async () => {
    process.env.ADDRESS_RECOVERY_ENABLED = 'false';
    try {
      const out = await recoverStreetAddress({ extracted: GARBLED, avStatus: 'missing_component', deps: deps({}) });
      expect(out.attempted).toBe(false);
    } finally {
      delete process.env.ADDRESS_RECOVERY_ENABLED;
    }
  });
});

describe('recoverStreetAddress — phase 1 (autocomplete on the street as heard)', () => {
  test('single house-number-matching prediction, confirmed → recovered', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({
        autocomplete: async () => ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'],
      }),
    });
    expect(out.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail', city: 'Lakewood Ranch', state: 'FL' });
    expect(out.method).toBe('autocomplete');
  });

  test('prediction with a DIFFERENT house number is ignored', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({
        autocomplete: async () => ['5063 Simons Ct, Lakewood Ranch, FL, USA'],
        phonetic: async () => [],
      }),
    });
    expect(out.attempted).toBe(true);
    expect(out.recovered).toBeNull();
    expect(out.candidates).toEqual([]);
  });
});

describe('recoverStreetAddress — phase 2 (phonetic re-hearing)', () => {
  const phase2 = ({ validate } = {}) => deps({
    // Phase 1 finds nothing for the garble (the observed behavior for
    // "5039 C Phone Trail" — Autocomplete returns ZERO_RESULTS).
    autocomplete: async (input) => (input.includes('Seafoam') ? ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] : []),
    phonetic: async () => ['Seafoam Trail', 'Sea Fawn Trail'],
    validate,
  });

  test('one candidate confirms at the caller ZIP → recovered', async () => {
    const out = await recoverStreetAddress({ extracted: GARBLED, avStatus: 'missing_component', deps: phase2() });
    expect(out.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail', zip: '34211-1407' });
    expect(out.method).toBe('phonetic');
    expect(out.candidates).toContain('5039 Seafoam Trail, Lakewood Ranch, FL, USA');
  });

  test('AV rejects the candidate (not a premise) → candidates surfaced, nothing adopted', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: phase2({ validate: async () => ({ status: 'missing_component', normalized: null }) }),
    });
    expect(out.recovered).toBeNull();
    expect(out.candidates).toContain('5039 Seafoam Trail, Lakewood Ranch, FL, USA');
  });

  test('confirmed premise in a DIFFERENT ZIP than the caller stated → rejected', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: phase2({
        validate: async () => avAccept({
          normalized: { street_line_1: '5039 Seafoam Trail', city: 'Venice', state: 'FL', postal_code: '34285' },
        }),
      }),
    });
    expect(out.recovered).toBeNull();
  });

  test('no caller ZIP → city must corroborate instead', async () => {
    const noZip = { ...GARBLED, zip: null };
    const good = await recoverStreetAddress({ extracted: noZip, avStatus: 'missing_component', deps: phase2() });
    expect(good.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail' });

    const cityMismatch = await recoverStreetAddress({
      extracted: { ...noZip, city: 'Venice' },
      avStatus: 'missing_component',
      deps: deps({
        autocomplete: async (input) => (input.includes('Seafoam') ? ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] : []),
        phonetic: async () => ['Seafoam Trail'],
      }),
    });
    expect(cityMismatch.recovered).toBeNull();
  });

  test('TWO distinct confirmed premises = genuine ambiguity → candidates only', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({
        autocomplete: async (input) => {
          if (input.includes('Seafoam')) return ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'];
          if (input.includes('Sea Fawn')) return ['5039 Sea Fawn Court, Lakewood Ranch, FL, USA'];
          return [];
        },
        phonetic: async () => ['Seafoam Trail', 'Sea Fawn Court'],
        validate: async ({ addressLines }) => avAccept({
          normalized: {
            street_line_1: addressLines[0].split(',')[0],
            city: 'Lakewood Ranch',
            state: 'FL',
            postal_code: '34211',
          },
        }),
      }),
    });
    expect(out.recovered).toBeNull();
    expect(out.candidates.length).toBe(2);
  });

  test('same premise reached via two candidates still counts as ONE → recovered', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({
        // Both re-hearings autocomplete to the same premise (dedup by text).
        autocomplete: async (input) => (input.includes('Seafoam') || input.includes('Sea Foam')
          ? ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] : []),
        phonetic: async () => ['Seafoam Trail', 'Sea Foam Trail'],
      }),
    });
    expect(out.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail' });
  });
});

describe('recoverStreetAddress — fail-open', () => {
  test('provider throwing yields attempted-but-nothing, never an exception', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({ autocomplete: async () => { throw new Error('quota'); } }),
    });
    expect(out.attempted).toBe(true);
    expect(out.recovered).toBeNull();
  });

  test('autocomplete API failure (null) is treated as no predictions', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      deps: deps({ autocomplete: async () => null, phonetic: async () => ['Seafoam Trail'] }),
    });
    expect(out.attempted).toBe(true);
    expect(out.recovered).toBeNull();
  });
});

describe('recoverStreetAddress — phase 1.5 (upstream dictation candidates)', () => {
  test('decoder-supplied street alternatives are tried before the phonetic model call', async () => {
    let phoneticCalled = false;
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      extraStreetCandidates: ['Seafoam Trail'],
      deps: deps({
        autocomplete: async (input) => (input.includes('Seafoam') ? ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] : []),
        phonetic: async () => { phoneticCalled = true; return []; },
      }),
    });
    expect(out.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail' });
    expect(out.method).toBe('dictation');
    expect(phoneticCalled).toBe(false);
  });

  test('falls through to phonetic when dictation candidates find nothing', async () => {
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      extraStreetCandidates: ['Wrong Street'],
      deps: deps({
        autocomplete: async (input) => (input.includes('Seafoam') ? ['5039 Seafoam Trail, Lakewood Ranch, FL, USA'] : []),
        phonetic: async () => ['Seafoam Trail'],
      }),
    });
    expect(out.recovered).toMatchObject({ address_line1: '5039 Seafoam Trail' });
    expect(out.method).toBe('phonetic');
  });
});
