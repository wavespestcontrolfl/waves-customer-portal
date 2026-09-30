/**
 * Call-address on-file assist (GATE_CALL_ADDRESS_ONFILE_ASSIST). Synthetic
 * names and addresses only. Network/model calls are injected.
 */

const { recoverStreetAddress } = require('../services/address-validation/recovery');
const { buildAddressLines } = require('../services/address-validation');
const {
  onFileStreetCandidates, validateWithOnFileAssist, isStreetOnlyRequest,
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
