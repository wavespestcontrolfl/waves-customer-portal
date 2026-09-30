/**
 * Call-address on-file assist (GATE_CALL_ADDRESS_ONFILE_ASSIST). Synthetic
 * names and addresses only. Network/model calls are injected.
 */

const { recoverStreetAddress } = require('../services/address-validation/recovery');
const { buildAddressLines } = require('../services/address-validation');
const {
  onFileStreetCandidates, withOnFileStreetCandidate, validateWithOnFileAssist, isStreetOnlyRequest,
  bindAssistCaller, streetResemblesOnFile,
} = require('../services/address-validation/onfile-assist');
const { callAddressOnFileAssistLive } = require('../config/feature-gates');

const GATE = 'GATE_CALL_ADDRESS_ONFILE_ASSIST';
let savedGate;
beforeEach(() => { savedGate = process.env[GATE]; delete process.env[GATE]; });
afterEach(() => { if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate; });
const gateOn = () => { process.env[GATE] = 'true'; };

const KNOWN = {
  addressLine1: '4306 Spoon Blade',
  addressCity: 'Exampleton',
  addressState: 'FL',
  addressZip: '34299',
};

describe('gate reader', () => {
  test('strict === "true", default off', () => {
    expect(callAddressOnFileAssistLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', ' true', '']) {
      process.env[GATE] = v;
      expect(callAddressOnFileAssistLive()).toBe(false);
    }
    process.env[GATE] = 'true';
    expect(callAddressOnFileAssistLive()).toBe(true);
  });
});

describe('item 3 — onFileStreetCandidates', () => {
  test('gate off: nothing, even on a perfect match', () => {
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN })).toEqual([]);
  });

  test('house number matches: the on-file street name is a candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN })).toEqual(['Spoon Blade']);
  });

  test('house number differs: no candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4307 Boone Blade', knownCaller: KNOWN })).toEqual([]);
  });

  test('no on-file address (or none usable): no candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: null })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: { addressLine1: null } })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: { addressLine1: '4306' } })).toEqual([]);
  });

  test('an on-file address stored in another state is not a Florida street candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: { ...KNOWN, addressState: 'NJ' } })).toEqual([]);
  });

  test('spoken street already IS the on-file street: no redundant candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4306 spoon blade', knownCaller: KNOWN })).toEqual([]);
  });

  test('no spoken house number: no candidate', () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: 'Boone Blade', knownCaller: KNOWN })).toEqual([]);
  });
});

describe('item 3 — through recoverStreetAddress', () => {
  const GARBLED = { address_line1: '4306 Boone Blade', city: 'Exampleton', state: 'FL', zip: '34299' };
  const avAccept = {
    status: 'validated_accept',
    county: 'Example County',
    normalized: { street_line_1: '4306 Spoon Blade', city: 'Exampleton', state: 'FL', postal_code: '34299-0001' },
  };
  // Autocomplete only knows the on-file street; the garble finds nothing.
  const autocomplete = async (input) => (/spoon blade/i.test(input) ? ['4306 Spoon Blade, Exampleton, FL, USA'] : []);

  test('gate on + match: the on-file street is recovered once Google confirms the one premise', async () => {
    gateOn();
    const validate = jest.fn(async () => avAccept);
    const phonetic = jest.fn(async () => []);
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      extraStreetCandidates: onFileStreetCandidates({ spokenStreet: GARBLED.address_line1, knownCaller: KNOWN }),
      deps: { autocomplete, phonetic, validate },
    });
    expect(out.recovered).toMatchObject({ address_line1: '4306 Spoon Blade', zip: '34299-0001' });
    expect(out.avResult).toBe(avAccept);
    expect(validate).toHaveBeenCalledWith({ addressLines: ['4306 Spoon Blade, Exampleton, FL, USA'] });
    expect(phonetic).not.toHaveBeenCalled();
  });

  test('gate off: the same call recovers nothing (no on-file candidate, phonetic finds nothing)', async () => {
    const validate = jest.fn(async () => avAccept);
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      extraStreetCandidates: onFileStreetCandidates({ spokenStreet: GARBLED.address_line1, knownCaller: KNOWN }),
      deps: { autocomplete, phonetic: async () => [], validate },
    });
    expect(out.recovered).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  test('Google does not confirm the on-file street: NOT adopted, prediction is a review candidate only', async () => {
    gateOn();
    for (const status of ['ambiguous', 'missing_component', 'confirm_needed', 'out_of_service_area', 'api_unavailable']) {
      const out = await recoverStreetAddress({
        extracted: GARBLED,
        avStatus: 'missing_component',
        extraStreetCandidates: onFileStreetCandidates({ spokenStreet: GARBLED.address_line1, knownCaller: KNOWN }),
        deps: { autocomplete, phonetic: async () => [], validate: async () => ({ ...avAccept, status }) },
      });
      expect(out.recovered).toBeNull();
      expect(out.avResult).toBeNull();
      expect(out.candidates).toEqual(['4306 Spoon Blade, Exampleton, FL, USA']);
    }
  });

  test('confirmed premise in the wrong ZIP is not adopted (caller ZIP must corroborate)', async () => {
    gateOn();
    const out = await recoverStreetAddress({
      extracted: GARBLED,
      avStatus: 'missing_component',
      extraStreetCandidates: onFileStreetCandidates({ spokenStreet: GARBLED.address_line1, knownCaller: KNOWN }),
      deps: {
        autocomplete,
        phonetic: async () => [],
        validate: async () => ({ ...avAccept, normalized: { ...avAccept.normalized, postal_code: '08000' } }),
      },
    });
    expect(out.recovered).toBeNull();
  });

  test('house number mismatch: on-file street never enters the search', async () => {
    gateOn();
    const seen = [];
    const out = await recoverStreetAddress({
      extracted: { ...GARBLED, address_line1: '4399 Boone Blade' },
      avStatus: 'missing_component',
      extraStreetCandidates: onFileStreetCandidates({ spokenStreet: '4399 Boone Blade', knownCaller: KNOWN }),
      deps: { autocomplete: async (i) => { seen.push(i); return []; }, phonetic: async () => [], validate: async () => avAccept },
    });
    expect(out.recovered).toBeNull();
    expect(seen.some((i) => /spoon blade/i.test(i))).toBe(false);
  });
});

describe('item 4 — isStreetOnlyRequest', () => {
  const lines = (sa) => buildAddressLines(sa);
  test('street alone, or street + the service state only', () => {
    const a = { street_line_1: '7417 Monteverdi' };
    expect(isStreetOnlyRequest(a, lines(a))).toBe(true);
    const b = { street_line_1: '7417 Monteverdi', state: 'FL' };
    expect(isStreetOnlyRequest(b, lines(b))).toBe(true);
  });
  test('a city, a ZIP, or a stated other state is not street-only', () => {
    const c = { street_line_1: '7417 Monteverdi', city: 'Exampleton' };
    expect(isStreetOnlyRequest(c, lines(c))).toBe(false);
    const z = { street_line_1: '7417 Monteverdi', postal_code: '34299' };
    expect(isStreetOnlyRequest(z, lines(z))).toBe(false);
    const nj = { street_line_1: '7417 Monteverdi', raw_text: '7417 Monteverdi NJ' };
    expect(isStreetOnlyRequest(nj, lines(nj))).toBe(false);
  });
  test('a spoken city that repeats a street word is still locality (codex r3 P1)', () => {
    const v = { street_line_1: '100 Venice Avenue', raw_text: '100 Venice Avenue, Venice' };
    expect(isStreetOnlyRequest(v, lines(v))).toBe(false);
    const same = { street_line_1: '100 Venice Avenue', raw_text: '100 Venice Ave' };
    expect(isStreetOnlyRequest(same, lines(same))).toBe(true);
  });
  test('a bare house number names no street', () => {
    const n = { street_line_1: '7417' };
    expect(isStreetOnlyRequest(n, lines(n))).toBe(false);
  });
});

describe('item 4 — validateWithOnFileAssist', () => {
  const KNOWN2 = { addressLine1: '7417 Monteverdi Way', addressCity: 'Exampleton', addressState: 'FL', addressZip: '34299' };
  const STREET_ONLY = { street_line_1: '7417 Monteverdi' };
  const inFl = { status: 'validated_accept', inServiceArea: true, normalized: { street_line_1: '7417 Monteverdi Way', city: 'Exampleton', state: 'FL', postal_code: '34299' } };
  const inNj = {
    status: 'out_of_service_area', inServiceArea: false, county: 'Example NJ County',
    normalized: { street_line_1: '7417 Monteverdi Ave', city: 'Nowhere', state: 'NJ', postal_code: '07000' },
  };

  test('gate off: byte-identical call — street only, FL hint, no assist, no reclassification', async () => {
    const validate = jest.fn(async () => inNj);
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, validate });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith({ addressLines: buildAddressLines(STREET_ONLY), administrativeArea: 'FL' });
    expect(out).toBe(inNj);
    expect(out.status).toBe('out_of_service_area');
  });

  test('gate off: out_of_service_area flag still drops the FL hint', async () => {
    const validate = jest.fn(async () => inFl);
    await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, outOfServiceFlagged: true, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: null });
  });

  test('gate on, street-only, house number matches: on-file city + ZIP added as line 2', async () => {
    gateOn();
    const validate = jest.fn(async () => inFl);
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi', 'Exampleton FL 34299'], administrativeArea: 'FL' });
    expect(out).toMatchObject({ status: 'validated_accept', onFileAssist: 'city_zip' });
  });

  test('gate on, street-only, house number differs: no assist', async () => {
    gateOn();
    const validate = jest.fn(async () => inFl);
    const out = await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7418 Monteverdi' }, knownCaller: KNOWN2, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7418 Monteverdi'], administrativeArea: 'FL' });
    expect(out.onFileAssist).toBeUndefined();
  });

  test('gate on, street-only, no on-file address: no assist', async () => {
    gateOn();
    const validate = jest.fn(async () => inFl);
    await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: null, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: 'FL' });
    await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: { addressLine1: null }, validate });
    expect(validate).toHaveBeenLastCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: 'FL' });
  });

  test('gate on, on-file address in another state: no assist', async () => {
    gateOn();
    const validate = jest.fn(async () => inFl);
    await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: { ...KNOWN2, addressState: 'NJ' }, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: 'FL' });
  });

  test('gate on, model flagged out_of_service_area: no on-file geography is forced onto it', async () => {
    gateOn();
    const validate = jest.fn(async () => inFl);
    await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, outOfServiceFlagged: true, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: null });
  });

  test('gate on, a spoken city: not street-only, request unchanged even with a match', async () => {
    gateOn();
    const sa = { street_line_1: '7417 Monteverdi', city: 'Otherville' };
    const validate = jest.fn(async () => inFl);
    await validateWithOnFileAssist({ serviceAddress: sa, knownCaller: KNOWN2, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: buildAddressLines(sa), administrativeArea: 'FL' });
  });

  test('gate on, street-only, non-FL result with no match: missing_component, not out_of_service_area', async () => {
    gateOn();
    const validate = jest.fn(async () => inNj);
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: null, validate });
    expect(out).toMatchObject({ status: 'missing_component', inServiceArea: null, reclassifiedFrom: 'out_of_service_area' });
    expect(out.normalized.state).toBe('NJ');
    expect(out.onFileAssist).toBeUndefined();
  });

  test('gate on: a full state name normalizes too', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ ...inNj, normalized: { ...inNj.normalized, state: 'New Jersey' } }));
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: null, validate });
    expect(out.status).toBe('missing_component');
  });

  test('gate on, street-only, assisted lookup still lands out of state: missing_component and stamped', async () => {
    gateOn();
    const validate = jest.fn(async () => inNj);
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, validate });
    expect(out).toMatchObject({ status: 'missing_component', onFileAssist: 'city_zip' });
  });

  test('gate on: a request that STATES another state stays out_of_service_area', async () => {
    gateOn();
    const sa = { street_line_1: '7417 Monteverdi', raw_text: '7417 Monteverdi NJ', state: null };
    const validate = jest.fn(async () => inNj);
    const out = await validateWithOnFileAssist({ serviceAddress: sa, knownCaller: KNOWN2, validate });
    expect(out.status).toBe('out_of_service_area');
    expect(out.inServiceArea).toBe(false);
  });

  test('gate on: a non-street-only out-of-state result is untouched', async () => {
    gateOn();
    const sa = { street_line_1: '7417 Monteverdi', city: 'Nowhere', postal_code: '07000' };
    const validate = jest.fn(async () => inNj);
    const out = await validateWithOnFileAssist({ serviceAddress: sa, knownCaller: KNOWN2, validate });
    expect(out.status).toBe('out_of_service_area');
  });

  test('gate on: an in-area FL out_of_service_area with a FL state is not reclassified', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ ...inNj, normalized: { ...inNj.normalized, state: 'FL' } }));
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: null, validate });
    expect(out.status).toBe('out_of_service_area');
  });

  test('gate on: api_unavailable and other statuses pass through', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ status: 'api_unavailable' }));
    const out = await validateWithOnFileAssist({ serviceAddress: STREET_ONLY, knownCaller: KNOWN2, validate });
    expect(out.status).toBe('api_unavailable');
  });
});

// ── Codex round 1 ────────────────────────────────────────────────────────

describe('complete house-number token (r1 P1)', () => {
  test('a letter suffix or a hyphenated number never matches a different one', () => {
    gateOn();
    const k = (line) => ({ ...KNOWN, addressLine1: line });
    expect(onFileStreetCandidates({ spokenStreet: '4306B Boone Blade', knownCaller: k('4306A Spoon Blade') })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306A Boone Blade', knownCaller: k('4306A Spoon Blade') })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '12-56 Boone Blade', knownCaller: k('12-34 Spoon Blade') })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: k('4306A Spoon Blade') })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306A Boone Blade', knownCaller: k('4306 Spoon Blade') })).toEqual([]);
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: k('4306 Spoon Blade') })).toEqual(['Spoon Blade']);
  });

  test('the locality assist ignores a suffix-only or hyphenated match too', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ status: 'validated_accept' }));
    const known = { addressLine1: '7417A Monteverdi Way', addressCity: 'Exampleton', addressState: 'FL', addressZip: '34299' };
    await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7417B Monteverdi' }, knownCaller: known, validate });
    expect(validate).toHaveBeenLastCalledWith({ addressLines: ['7417B Monteverdi'], administrativeArea: 'FL' });
    await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7417 Monteverdi' }, knownCaller: known, validate });
    expect(validate).toHaveBeenLastCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: 'FL' });
  });
});

describe('decoder candidates are never displaced (r1 P1)', () => {
  const five = ['Alder Way', 'Birch Way', 'Cedar Way', 'Dogwood Way', 'Elm Way'];

  test('the on-file street is appended after every decoder candidate', () => {
    gateOn();
    const out = withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN, decoderCandidates: five });
    expect(out.slice(0, 5)).toEqual(five);
    expect(out).toEqual([...five, 'Spoon Blade']);
  });

  test('recovery evaluates the first five, so all five decoder hypotheses are still tried', async () => {
    gateOn();
    const tried = [];
    const out = await recoverStreetAddress({
      extracted: { address_line1: '4306 Boone Blade', city: 'Exampleton', state: 'FL', zip: '34299' },
      avStatus: 'missing_component',
      extraStreetCandidates: withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN, decoderCandidates: five }),
      deps: { autocomplete: async (i) => { tried.push(i); return []; }, phonetic: async () => [], validate: async () => ({}) },
    });
    expect(out.recovered).toBeNull();
    for (const c of five) expect(tried.some((i) => i.includes(c))).toBe(true);
    expect(tried.some((i) => /spoon blade/i.test(i))).toBe(false);
  });

  test('with room, both a decoder hypothesis and the on-file street confirm: two premises, not adopted', async () => {
    gateOn();
    const validate = async ({ addressLines }) => ({
      status: 'validated_accept',
      normalized: { street_line_1: /spoon/i.test(addressLines[0]) ? '4306 Spoon Blade' : '4306 Elm Way', city: 'Exampleton', state: 'FL', postal_code: '34299' },
    });
    const autocomplete = async (i) => (/spoon blade/i.test(i) ? ['4306 Spoon Blade, Exampleton, FL'] : /elm way/i.test(i) ? ['4306 Elm Way, Exampleton, FL'] : []);
    const out = await recoverStreetAddress({
      extracted: { address_line1: '4306 Boone Blade', city: 'Exampleton', state: 'FL', zip: '34299' },
      avStatus: 'missing_component',
      extraStreetCandidates: withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN, decoderCandidates: ['Elm Way'] }),
      deps: { autocomplete, phonetic: async () => [], validate },
    });
    expect(out.recovered).toBeNull();
    expect(out.candidates).toHaveLength(2);
  });

  test('gate off: the decoder list comes back as-is; no duplicate of an existing candidate', () => {
    expect(withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN, decoderCandidates: five })).toEqual(five);
    gateOn();
    expect(withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN, decoderCandidates: ['spoon  blade'] })).toEqual(['spoon  blade']);
    expect(withOnFileStreetCandidate({ spokenStreet: '4306 Boone Blade', knownCaller: KNOWN })).toEqual(['Spoon Blade']);
  });
});

describe('raw_text locality blocks the street-only assist (r1 P1)', () => {
  const KNOWN2 = { addressLine1: '7417 Monteverdi Way', addressCity: 'Exampleton', addressState: 'FL', addressZip: '34299' };
  const av = { status: 'validated_accept' };
  const run = (sa, known = KNOWN2, result = av) => {
    const validate = jest.fn(async () => result);
    return validateWithOnFileAssist({ serviceAddress: sa, knownCaller: known, validate }).then((out) => ({ out, validate }));
  };

  test('a locality only in raw_text: not street-only, no on-file city or ZIP injected', async () => {
    gateOn();
    for (const raw_text of ['7417 Monteverdi in Otherville', '7417 Monteverdi Otherville 34288', '7417 Monteverdi, 34288']) {
      const sa = { street_line_1: '7417 Monteverdi', raw_text };
      expect(isStreetOnlyRequest(sa, buildAddressLines(sa))).toBe(false);
      const { validate } = await run(sa);
      expect(validate.mock.calls[0][0].addressLines.join(' ')).not.toMatch(/Exampleton|34299/);
    }
  });

  test('a locality-only raw_text out-of-state result is not reclassified', async () => {
    gateOn();
    const nj = { status: 'out_of_service_area', inServiceArea: false, normalized: { state: 'NJ' } };
    const { out } = await run({ street_line_1: '7417 Monteverdi', raw_text: '7417 Monteverdi in Otherville' }, null, nj);
    expect(out.status).toBe('out_of_service_area');
  });

  test('raw_text that only repeats the street, filler or Florida stays street-only', async () => {
    gateOn();
    for (const raw_text of ['7417 Monteverdi', '7417 Monteverdi Way', "it's 7417 Monteverdi", '7417 Monteverdi Florida', undefined]) {
      const sa = { street_line_1: '7417 Monteverdi Way', raw_text };
      expect(isStreetOnlyRequest(sa, buildAddressLines(sa))).toBe(true);
    }
    const { validate } = await run({ street_line_1: '7417 Monteverdi', raw_text: '7417 Monteverdi Florida' });
    expect(validate.mock.calls[0][0].addressLines).toEqual(['7417 Monteverdi', 'Exampleton FL 34299']);
  });
});

describe('canonical customer binding (r1 P1)', () => {
  const caller = { id: 'cust-A', ...KNOWN };
  const named = (id, ambiguous = false) => jest.fn(async (amb) => { if (ambiguous) amb.candidates = [{ id: 'x' }, { id: 'y' }]; return id ? { id } : null; });

  test('gate off: null and no lookup', async () => {
    const resolveCustomer = named('cust-A');
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer })).toBeNull();
    expect(resolveCustomer).not.toHaveBeenCalled();
  });

  test('name-aware resolution lands on the same customer: bound', async () => {
    gateOn();
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer: named('cust-A') })).toBe(caller);
  });

  test('shared number where the caller resolves to a DIFFERENT customer: not bound', async () => {
    gateOn();
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer: named('cust-B') })).toBeNull();
  });

  test('ambiguous, unresolved, or a failing lookup: not bound', async () => {
    gateOn();
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer: named('cust-A', true) })).toBeNull();
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer: named(null) })).toBeNull();
    expect(await bindAssistCaller({ knownCaller: caller, resolveCustomer: async () => { throw new Error('db'); } })).toBeNull();
  });

  test('call already linked to another customer: not bound, no lookup', async () => {
    gateOn();
    const resolveCustomer = named('cust-A');
    expect(await bindAssistCaller({ knownCaller: caller, callCustomerId: 'cust-B', resolveCustomer })).toBeNull();
    expect(resolveCustomer).not.toHaveBeenCalled();
  });

  test('operator link override: bound only to the linked customer; no known caller: null', async () => {
    gateOn();
    const resolveCustomer = named('cust-B');
    expect(await bindAssistCaller({ knownCaller: caller, callCustomerId: 'cust-A', hasLinkOverride: true, resolveCustomer })).toBe(caller);
    expect(await bindAssistCaller({ knownCaller: caller, callCustomerId: 'cust-B', hasLinkOverride: true, resolveCustomer })).toBeNull();
    expect(resolveCustomer).not.toHaveBeenCalled();
    expect(await bindAssistCaller({ knownCaller: null, resolveCustomer })).toBeNull();
  });

  test('chained over several identities (V1 record, then V2 caller): one disagreement unbinds, and null stays null', async () => {
    gateOn();
    const first = await bindAssistCaller({ knownCaller: caller, resolveCustomer: named('cust-A') });
    expect(first).toBe(caller);
    const second = await bindAssistCaller({ knownCaller: first, resolveCustomer: named('cust-B') });
    expect(second).toBeNull();
    const resolveCustomer = named('cust-A');
    expect(await bindAssistCaller({ knownCaller: second, resolveCustomer })).toBeNull();
    expect(resolveCustomer).not.toHaveBeenCalled();
  });

  test('an unbound (null) caller turns both assist paths into no-ops', async () => {
    gateOn();
    expect(onFileStreetCandidates({ spokenStreet: '4306 Boone Blade', knownCaller: null })).toEqual([]);
    const validate = jest.fn(async () => ({ status: 'validated_accept' }));
    await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7417 Monteverdi' }, knownCaller: null, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi'], administrativeArea: 'FL' });
  });
});

describe('spoken street must resemble the on-file street for the locality assist', () => {
  test('resemblance rules', () => {
    expect(streetResemblesOnFile('Monteverdi', 'Monteverdi Way')).toBe(true);
    expect(streetResemblesOnFile('Monteverdi Wy', 'Monteverdi Way')).toBe(true);
    expect(streetResemblesOnFile('Monteverdi Way', 'Monteverdi Way')).toBe(true);
    expect(streetResemblesOnFile('Monteverdy', 'Monteverdi Way')).toBe(false);
    expect(streetResemblesOnFile('Maple', 'Marple Way')).toBe(false);
    expect(streetResemblesOnFile('Oak', 'Oak Hill Drive')).toBe(false);
    expect(streetResemblesOnFile('Oak Hill', 'Oak Hill Drive')).toBe(true);
    // An on-file direction must be spoken: East and West are different streets (codex r3 P1).
    expect(streetResemblesOnFile('Oak Hill', 'Oak Hill Drive North')).toBe(false);
    expect(streetResemblesOnFile('Oak Hill Drive North', 'Oak Hill Drive North')).toBe(true);
    expect(streetResemblesOnFile('4th Avenue', '4th Avenue East')).toBe(false);
    expect(streetResemblesOnFile('4th Avenue East', '4th Avenue East')).toBe(true);
    expect(streetResemblesOnFile('4th Ave E', '4th Avenue East')).toBe(true);
    expect(streetResemblesOnFile('4th Avenue West', '4th Avenue East')).toBe(false);
    expect(streetResemblesOnFile('Monteverdi Drive', 'Monteverdi Way')).toBe(false);
    expect(streetResemblesOnFile('Sunset', 'Monteverdi Way')).toBe(false);
    expect(streetResemblesOnFile('Monteverdi Way Extension', 'Monteverdi Way')).toBe(false);
    expect(streetResemblesOnFile('4th Avenue', 'Fourth Avenue')).toBe(false);
    expect(streetResemblesOnFile('4th', '4th Avenue East')).toBe(false);
    expect(streetResemblesOnFile('4th Ave E', '4th Avenue East')).toBe(true);
    expect(streetResemblesOnFile('4th Street', '4th Avenue')).toBe(false);
    expect(streetResemblesOnFile('', 'Monteverdi Way')).toBe(false);
  });

  test('a different street with the same house number gets no on-file city or ZIP', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ status: 'validated_accept' }));
    const known = { addressLine1: '7417 Monteverdi Way', addressCity: 'Exampleton', addressState: 'FL', addressZip: '34299' };
    await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7417 Sunset Drive' }, knownCaller: known, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Sunset Drive'], administrativeArea: 'FL' });
  });

  test('the same street spoken without its type still gets it', async () => {
    gateOn();
    const validate = jest.fn(async () => ({ status: 'validated_accept' }));
    const known = { addressLine1: '7417 Monteverdi Way', addressCity: 'Exampleton', addressState: 'FL', addressZip: '34299' };
    await validateWithOnFileAssist({ serviceAddress: { street_line_1: '7417 Monteverdi' }, knownCaller: known, validate });
    expect(validate).toHaveBeenCalledWith({ addressLines: ['7417 Monteverdi', 'Exampleton FL 34299'], administrativeArea: 'FL' });
  });
});
