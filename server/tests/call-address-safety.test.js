const { canAutoRoute, statesNewAddress, dispatchesToOnFileAddress } = require('../services/call-triage-flags');
const { buildAddressLines, validateAddress } = require('../services/address-validation');
const { recoverStreetAddress } = require('../services/address-validation/recovery');
const { parseRawAddress } = require('../utils/address-normalizer');

const ANI = '+19415550100';
const v2 = (over = {}) => ({
  meta: { schema_version: '1.7.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'unknown', on_site_authorization: false },
  property: { service_address: {} },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-11T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
  ...over,
});

describe('stated geography takes precedence over a service-area hint', () => {
  const originalFetch = global.fetch;
  const originalEnabled = process.env.ADDRESS_VALIDATION_ENABLED;
  const originalKey = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
  let providerResult;
  beforeEach(() => {
    process.env.ADDRESS_VALIDATION_ENABLED = 'true';
    process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY = 'synthetic-test-key';
    providerResult = {
      verdict: { addressComplete: true, validationGranularity: 'PREMISE', hasReplacedComponents: true },
      address: { addressComponents: [{ componentType: 'administrative_area_level_1', componentName: { text: 'FL' } }] },
      geocode: { location: { latitude: 27, longitude: -82 } },
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: providerResult }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ address_components: [{ types: ['administrative_area_level_2'], long_name: 'Manatee County' }] }] }) });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnabled === undefined) delete process.env.ADDRESS_VALIDATION_ENABLED;
    else process.env.ADDRESS_VALIDATION_ENABLED = originalEnabled;
    if (originalKey === undefined) delete process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
    else process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY = originalKey;
  });
  test.each([null, 'FL'])('a raw non-Florida state survives a structured state of %s', async state => {
    const sa = { street_line_1: '100 Example Street', city: 'Greenville', state, raw_text: '100 Example Street, Greenville, South Carolina' };
    const lines = buildAddressLines(sa);
    expect(lines).toEqual(['100 Example Street', 'Greenville SC']);
    const av = await validateAddress({ addressLines: lines, administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('SC');
    expect(av.status).toBe('out_of_service_area');
    const deps = { autocomplete: jest.fn().mockResolvedValue([]), phonetic: jest.fn().mockResolvedValue([]), validate: jest.fn() };
    const recovery = await recoverStreetAddress({ avStatus: av.status, extracted: { address_line1: '100 Example Street', city: 'Parrish', state: null }, deps });
    expect(recovery.attempted).toBe(false);
    expect(deps.autocomplete).not.toHaveBeenCalled();
    expect(canAutoRoute(v2({ property: { service_address: sa }, triage_flags: ['out_of_service_area'] }), { contactPhone: ANI, addressValidation: av }).allowed).toBe(false);
  });
  test('a fragment with no contrary state keeps the Florida hint', async () => {
    const av = await validateAddress({ addressLines: buildAddressLines({ street_line_1: '100 Example Street', city: 'Parrish' }), administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('FL');
    expect(av.status).toBe('corrected');
  });
  test.each([
    ['ambiguous', { addressComplete: false }, 'FL'],
    ['missing component', { validationGranularity: 'ROUTE' }, 'FL'],
    ['unconfirmed', { hasUnconfirmedComponents: true }, 'FL'],
    ['missing provider state', { addressComplete: false }, null],
    ['matching non-Florida state', { addressComplete: false }, 'SC'],
  ])('explicit non-Florida geography cannot enter recovery after %s', async (_label, verdict, providerState) => {
    Object.assign(providerResult.verdict, verdict);
    providerResult.address.addressComponents = providerState
      ? [{ componentType: 'administrative_area_level_1', componentName: { text: providerState } }] : [];
    const sa = { street_line_1: '100 Example Street', city: 'Greenville', state: null, raw_text: '100 Example Street, Greenville, South Carolina' };
    const av = await validateAddress({ addressLines: buildAddressLines(sa), administrativeArea: 'FL' });
    expect(av).toMatchObject({ status: 'out_of_service_area', inServiceArea: false });
    const deps = { autocomplete: jest.fn().mockResolvedValue([]), phonetic: jest.fn().mockResolvedValue([]), validate: jest.fn() };
    expect((await recoverStreetAddress({ avStatus: av.status, extracted: { address_line1: '100 Example Street', city: 'Parrish', state: null }, deps })).attempted).toBe(false);
    expect(deps.autocomplete).not.toHaveBeenCalled();
    expect(canAutoRoute(v2({ property: { service_address: sa } }), { contactPhone: ANI, addressValidation: av }).allowed).toBe(false);
  });
  test.each(['123 Main St NE', '123 Main Ct'])('a bare street token is not an explicit state: %s', async street => {
    const sa = { street_line_1: street, city: 'Bradenton', state: 'FL', raw_text: street };
    expect(parseRawAddress(street)).toMatchObject({ line1: street, city: '', state: '' });
    expect(buildAddressLines(sa)).toEqual([street, 'Bradenton FL']);
    await validateAddress({ addressLines: [street], administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('FL');
    expect(statesNewAddress(v2({ property: { service_address: sa } }), { hasAddress: true, addressLine1: street, addressCity: 'Bradenton' })).toBe(false);
  });
  // codex r11 P1: a unit value that is also a state code ("Apt CT") sits on
  // the STREET line and is not geography.
  test('an alphabetic unit value that is also a state code is not an explicit state', async () => {
    const lines = buildAddressLines({ street_line_1: '100 Main St', street_line_2: 'Apt CT', city: 'Bradenton' });
    expect(lines).toEqual(['100 Main St Apt CT', 'Bradenton']);
    const av = await validateAddress({ addressLines: lines, administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('FL');
    expect(av.status).not.toBe('out_of_service_area');
  });

  test.each(['123 Main Street, Lincoln NE', '123 Main Street Lincoln NE'])('a state in a locality tail remains explicit: %s', async raw_text => {
    const lines = buildAddressLines({ street_line_1: '123 Main Street', city: 'Lincoln', state: 'FL', raw_text });
    expect(lines).toEqual(['123 Main Street', 'Lincoln NE']);
    const av = await validateAddress({ addressLines: lines, administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('NE');
    expect(av.status).toBe('out_of_service_area');
  });
  test.each([
    ['123 Main Street', '123 Main Street CT', 'CT'],
    ['123 Main St', '123 Main Street CT', 'CT'],
    ['123 Main Street', '123 Main Street NE', 'NE'],
    ['123 Main St NE', '123 Main Street NE CT', 'CT'],
  ])('a structured street boundary preserves the state in %s / %s', async (street_line_1, raw_text, state) => {
    const lines = buildAddressLines({ street_line_1, raw_text, state: 'FL' });
    expect(lines).toEqual([street_line_1, state]);
    const av = await validateAddress({ addressLines: lines, administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe(state);
    expect(av.status).toBe('out_of_service_area');
  });
  test.each([['CT'], ['CT 06001'], ['NE']])('a separate state line survives validation: %s', async tail => {
    const av = await validateAddress({ addressLines: ['123 Main Street', tail], administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe(tail.slice(0, 2));
    expect(av.status).toBe('out_of_service_area');
  });
  test.each([
    '123 Main Street CT 06001.', '123 Main Street CT 06001-1234.', '123 Main Street CT 06001,',
  ])('terminal punctuation on the state+ZIP tail does not swallow the state (P1): %s', async raw_text => {
    const lines = buildAddressLines({ street_line_1: '123 Main Street', raw_text, state: null, city: null, postal_code: null });
    expect(lines[0]).toBe('123 Main Street');
    expect(lines[1]).toMatch(/^CT/);
    const av = await validateAddress({ addressLines: lines, administrativeArea: 'FL' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address.administrativeArea).toBe('CT');
    expect(av.status).toBe('out_of_service_area');
  });
  test('an incomplete Florida result without a provider state can still recover', async () => {
    providerResult.verdict.addressComplete = false;
    providerResult.address.addressComponents = [];
    const av = await validateAddress({ addressLines: ['123 Main Street', 'Bradenton FL'] });
    expect(av.status).toBe('ambiguous');
  });
  test('the shared validator stays unpinned when no hint or state was supplied', async () => {
    await validateAddress({ addressLines: ['100 Example Street', 'Greenville'] });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).address).not.toHaveProperty('administrativeArea');
  });
  test.each([{ state: 'SC' }, { city: 'Parrish', raw_text: 'Parrish, South Carolina' }])('a contrary state cannot reuse the saved Florida address: %j', service_address => {
    const ex = v2({ property: { service_address } });
    const knownCustomer = { hasAddress: true, addressLine1: '100 Example Street', addressCity: 'Parrish' };
    expect(statesNewAddress(ex, knownCustomer)).toBe(true);
    expect(canAutoRoute(ex, { failOpen: true, callerAni: ANI, contactPhone: ANI, knownCustomer,
      addressValidation: { status: 'confirm_needed', inServiceArea: null } }).allowed).toBe(false);
  });
});

describe('every stated address component preserves the saved property identity', () => {
  const saved = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressCity: 'Sarasota', addressZip: '34240' };
  test.each([
    { street_line_1: saved.addressLine1 },
    { raw_text: saved.addressLine1 },
    { street_line_1: saved.addressLine1, city: saved.addressCity },
  ])('a building restatement without the saved unit stays in review: %j', service_address => {
    const knownCustomer = { ...saved, addressLine2: 'Apt 4B' };
    const ex = v2({ property: { service_address }, triage_flags: ['address_unverified'] });
    expect(statesNewAddress(ex, knownCustomer)).toBe(true);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer })).toBe(false);
    expect(canAutoRoute(ex, { contactPhone: ANI, failOpen: true, knownCustomer,
      addressValidation: { status: 'ambiguous', inServiceArea: true, granularity: 'PREMISE', missingComponents: ['subpremise'] } }).allowed).toBe(false);
  });
  test('a locality-only restatement still uses the complete saved address', () => {
    const ex = v2({ property: { service_address: { city: saved.addressCity } } });
    expect(statesNewAddress(ex, { ...saved, addressLine2: 'Apt 4B' })).toBe(false);
  });
  test.each(['34240.', '34240,', '34240-1234'])('a punctuated or ZIP+4 raw ZIP still restates the on-file address (P2): %s', raw_text => {
    const ex = v2({ property: { service_address: { raw_text, postal_code: saved.addressZip } } });
    expect(statesNewAddress(ex, saved)).toBe(false);
  });
  test.each([
    [{ unit: 'Apt 45' }, { addressLine2: 'Bldg 4 Apt 5' }],
    ...['Bldg 9', 'Building 9', 'Floor 2', 'Lot 7', 'Space 3'].map(unit => [{ raw_text: `500 Sample Tower Blvd ${unit}` }, {}]),
    [{ street_line_1: '123 Palm Drive' }, { addressLine1: '123 Palm Street Drive' }],
    [{ street_line_1: '123 Palm Street Drive' }, { addressLine1: '123 Palm Drive' }],
    [{ street_line_1: '500 Sample Tower Avenue' }, {}],
    [{ raw_text: '500 Sample Tower Avenue' }, {}],
    [{ raw_text: '5 Main St, Sarasota', city: 'Sarasota' }, { addressLine1: '7 Main St' }],
    [{ street_line_1: '7 Main St', raw_text: '5 Main St' }, { addressLine1: '7 Main St' }],
    ...[{ city: 'Sarasota' }, { postal_code: '34240' }, { street_line_1: '500 Sample Tower Blvd' }].map(part => [{ ...part, subdivision_or_community: 'Lakewood Ranch' }, {}]),
    ...['Bayview Loop', 'Oak Grove', 'Harbor Cove', 'Lake Ridge'].map(street => [{ raw_text: street, city: 'Sarasota' }, {}]),
  ])('a conflicting or uncomparable component stays in review: %j', (service_address, extra) => {
    const knownCustomer = { ...saved, ...extra };
    const ex = v2({ property: { service_address } });
    expect(statesNewAddress(ex, knownCustomer)).toBe(true);
    expect(canAutoRoute(ex, { failOpen: true, callerAni: ANI, contactPhone: ANI, knownCustomer,
      addressValidation: { status: 'missing_component', inServiceArea: true } }).allowed).toBe(false);
  });
  test('canonical structural aliases keep their components', () => {
    const known = { ...saved, addressLine2: 'Bldg 4 Apt 5' };
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: saved.addressLine1, unit: 'Building 4 Suite 5' } } }), known)).toBe(false);
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: 'Building 4 Suite 5, 500 Sample Tower Blvd, Sarasota, FL 34240' } } }), known)).toBe(false);
  });
});


describe('finding 3 — address fragments and on-file restatements', () => {
  const onFile = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressLine2: null, addressCity: 'Parrish', addressZip: '34219' };

  test('a bare house number is not sent to Google', () => {
    expect(buildAddressLines({ street_line_1: '2468' })).toEqual([]);
    expect(buildAddressLines({ street_line_1: '2468', city: 'Bradenton', state: 'FL' })).toEqual(['Bradenton FL']);
    expect(buildAddressLines({ street_line_1: '2468', street_line_2: 'Apt 4', city: 'Bradenton' })).toEqual(['Bradenton']); // codex r2: a unit is not a street name
    expect(buildAddressLines({ street_line_1: '2468 Sample Palm Street', city: 'Bradenton' })).toEqual(['2468 Sample Palm Street', 'Bradenton']);
  });

  test('"I\'m in Parrish" from the Parrish customer is a restatement, not a new address (audit #58)', () => {
    const ex = v2({ property: { service_address: { city: 'Parrish', raw_text: "I'm in Parrish." } } });
    expect(statesNewAddress(ex)).toBe(true);
    expect(statesNewAddress(ex, onFile)).toBe(false);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: onFile })).toBe(true);
  });

  // codex P2: a raw locality phrase that ALSO carries the already-agreed
  // state and/or ZIP (not just the bare city) must still read as a
  // restatement — appending "FL" or the saved ZIP to the city name is not
  // new street evidence.
  test.each([
    { city: 'Parrish', state: 'FL', raw_text: 'Parrish FL' },
    { city: 'Parrish', state: 'FL', postal_code: '34219', raw_text: 'Parrish, FL 34219' },
    { city: 'Parrish', raw_text: '34219 Parrish' },
  ])('a locality phrase padded with the saved state/ZIP is still a restatement: %j', service_address => {
    const ex = v2({ property: { service_address } });
    expect(statesNewAddress(ex, onFile)).toBe(false);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: onFile })).toBe(true);
  });

  // codex r9 P1: a DIFFERENT ZIP in the raw phrase is a contradiction the
  // caller voiced — the digits must not be stripped away behind the city.
  test('a locality phrase carrying a non-matching ZIP is NOT treated as a restatement', () => {
    const ex = v2({ property: { service_address: { city: 'Parrish', raw_text: '34203 Parrish' } } });
    expect(statesNewAddress(ex, onFile)).toBe(true);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: onFile })).toBe(false);
  });

  // codex r9 P2: a spoken directional ("North") and the saved abbreviation
  // ("N") name the same street.
  test('an expanded directional still restates the on-file street', () => {
    const saved = { ...onFile, addressLine1: '1234 N Sample Palm Dr' };
    const ex = v2({ property: { service_address: { street_line_1: '1234 North Sample Palm Drive', city: 'Parrish' } } });
    expect(statesNewAddress(ex, saved)).toBe(false);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: saved })).toBe(true);
  });

  test('a locality phrase with an extra unmatched word is NOT treated as a restatement', () => {
    const ex = v2({ property: { service_address: { raw_text: 'Parrish Heights FL' } } });
    expect(statesNewAddress(ex, onFile)).toBe(true);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: onFile })).toBe(false);
  });

  test('restating the on-file street books on the on-file address', () => {
    const ex = v2({ property: { service_address: { street_line_1: '1234 Sample Palm Drive', city: 'Parrish' } }, triage_flags: ['address_unverified'] });
    const r = canAutoRoute(ex, { contactPhone: ANI, failOpen: true, knownCustomer: onFile, addressValidation: { status: 'missing_component', inServiceArea: true } });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toContain('address_unverified');
  });

  test.each(['same address', 'same as before', 'yes'])('an acknowledgment selects the complete saved address: %s', raw_text => {
    const ex = v2({ property: { service_address: { raw_text } }, triage_flags: ['address_unverified'] });
    for (const addressLine2 of [null, 'Apt 4B']) {
      const knownCustomer = { ...onFile, addressLine2 };
      const opts = { contactPhone: ANI, failOpen: true, knownCustomer,
        addressValidation: { status: 'missing_component', inServiceArea: true } };
      expect(statesNewAddress(ex, knownCustomer)).toBe(false);
      expect(dispatchesToOnFileAddress(ex, opts)).toBe(true);
      expect(canAutoRoute(ex, opts)).toMatchObject({ allowed: true, usesOnFileAddress: true });
    }
    expect(statesNewAddress(ex, { hasAddress: false })).toBe(true);
    expect(statesNewAddress(ex, null)).toBe(true);
  });

  test.each([
    { street_line_1: '9876 Other Grove Circle' }, { city: 'Sarasota' },
    { postal_code: '34240' }, { unit: 'Apt 4B' }, { state: 'SC' },
    { subdivision_or_community: 'Lakewood Ranch' },
  ])('an acknowledgment cannot override conflicting address evidence: %j', conflict => {
    const ex = v2({ property: { service_address: { raw_text: 'same address', ...conflict } } });
    const opts = { contactPhone: ANI, failOpen: true, knownCustomer: onFile,
      addressValidation: { status: 'missing_component', inServiceArea: true } };
    expect(statesNewAddress(ex, onFile)).toBe(true);
    expect(dispatchesToOnFileAddress(ex, opts)).toBe(false);
    expect(canAutoRoute(ex, opts).allowed).toBe(false);
  });

  test('a DIFFERENT city, ZIP, street or a unit is still a new address', () => {
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Sarasota' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { postal_code: '34203' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '1236 Sample Palm Dr' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '1234 Other Grove Cir' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { unit: 'Apt 4B' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { subdivision_or_community: 'Lakewood Ranch' } } }), onFile)).toBe(true);
  });

  test('raw_text only: accepted when it carries the on-file house number and street word', () => {
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: 'twelve thirty four sample palm, same as before' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '1234 sample palm, same as before' } } }), onFile)).toBe(false);
  });

  test('no on-file address → every stated component is new (unchanged contract)', () => {
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Parrish' } } }), { hasAddress: false })).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Parrish' } } }), null)).toBe(true);
  });
});

describe('regressions', () => {
  // codex r12 P2s: an alphabetic unit value that is also a state code is a
  // unit, not geography, in the matcher too; and a compound unit the parser
  // splits across line1/city is one unit, not two independent fragments.
  test('an alphabetic unit value that is also a state code restates the saved unit', () => {
    const saved = { hasAddress: true, addressLine1: '100 Main St', addressLine2: 'Apt CT', addressCity: 'Bradenton', addressZip: '34205' };
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '100 Main St Apt CT' } } }), saved)).toBe(false);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '100 Main St', unit: 'Apt CT', raw_text: '100 Main St Apt CT' } } }), saved)).toBe(false);
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '100 Main St Apt NE' } } }), saved)).toBe(true);
  });

  test('a comma-free compound unit restates the saved compound unit', () => {
    const saved = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Bldg 4 Apt 5', addressCity: 'Sarasota', addressZip: '34240' };
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '500 Sample Tower Blvd Bldg 4 Apt 5' } } }), saved)).toBe(false);
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '500 Sample Tower Blvd Bldg 4 Apt 6' } } }), saved)).toBe(true);
  });

  // codex r11 P1: every unit the raw phrase names is compared, not just
  // the first one found.
  test('a raw phrase naming two units is a new address when either differs from the saved unit', () => {
    const condo = { hasAddress: true, addressLine1: '500 Main St', addressLine2: 'Apt 4', addressCity: 'Sarasota', addressZip: '34240' };
    const stated = raw_text => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(stated('Apt 4, 500 Main St Apt 5'), condo)).toBe(true);
    expect(statesNewAddress(stated('Apt 4, 500 Main St'), condo)).toBe(false);
  });

  // codex r10 P1: a hyphen between two digits is a real separator.
  test('a digit-digit hyphen in a unit is not formatting: Apt 4-5 is not Apt 45, but 4-5 restates 4-5', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4-5', addressCity: 'Sarasota', addressZip: '34240' };
    const stated = unit => v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', unit } } });
    expect(statesNewAddress(stated('Apt 45'), condo)).toBe(true);
    expect(statesNewAddress(stated('#4-5'), condo)).toBe(false);
    expect(statesNewAddress(stated('Apt 4-5'), { ...condo, addressLine2: 'Apt 45' })).toBe(true);
  });

  test('a restated unit keeps its digits: Apt 5B is a new address, #4B and Unit 4-B are the on-file one (P1)', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const stated = (unit) => v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', unit } } });
    expect(statesNewAddress(stated('Apt 5B'), condo)).toBe(true);
    expect(statesNewAddress(stated('#4B'), condo)).toBe(false);
    expect(statesNewAddress(stated('Unit 4-B'), condo)).toBe(false);
    expect(statesNewAddress(stated('Apt 4B'), { ...condo, addressLine2: null })).toBe(true);
  });

  test('a unit spoken inside raw_text is compared too (r2 P1)', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const raw = (raw_text) => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(raw('500 sample tower apt 5b'), condo)).toBe(true);
    expect(statesNewAddress(raw('500 Sample Tower Blvd #4B'), condo)).toBe(false);
    expect(statesNewAddress(raw('500 sample tower, unit 4-b'), condo)).toBe(false);
    expect(statesNewAddress(raw('500 sample tower apt 4b'), { ...condo, addressLine2: null })).toBe(true);
    // codex r3: the structured street must not answer before the raw unit is compared
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', raw_text: '500 Sample Tower Blvd Apt 5B' } } }), condo)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', raw_text: '500 Sample Tower Blvd Apt 4B' } } }), condo)).toBe(false);
  });

  test('raw street names match as whole tokens, so a directional prefix cannot vouch for another street (r3 P1)', () => {
    const lake = { hasAddress: true, addressLine1: '123 W Lake Dr', addressLine2: null, addressCity: 'Sarasota', addressZip: '34240' };
    const raw = (raw_text) => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(raw('123 New Palm Ave'), lake)).toBe(true);
    expect(statesNewAddress(raw('123 Wrong Road'), lake)).toBe(true);
    expect(statesNewAddress(raw('123 w lake, same place'), lake)).toBe(false);
  });

  test('a raw street with no house number is new-address evidence even beside a matching city (r4 P1)', () => {
    const lake = { hasAddress: true, addressLine1: '123 W Lake Dr', addressLine2: null, addressCity: 'Sarasota', addressZip: '34240' };
    const said = (raw_text, extra = {}) => v2({ property: { service_address: { raw_text, ...extra } } });
    expect(statesNewAddress(said('Oak Avenue, Sarasota', { city: 'Sarasota' }), lake)).toBe(true);
    expect(statesNewAddress(said('over on Oak Avenue'), lake)).toBe(true);
    expect(statesNewAddress(said('on W Lake, same place', { city: 'Sarasota' }), lake)).toBe(false);
    expect(statesNewAddress(said("I'm in Sarasota, same place", { city: 'Sarasota' }), lake)).toBe(false);
  });

  test('raw words naming another street override a structured street that happens to match the file (r5 P1)', () => {
    const palm = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressLine2: null, addressCity: 'Parrish', addressZip: '34219' };
    const both = (raw_text) => v2({ property: { service_address: { street_line_1: '1234 Sample Palm Drive', raw_text } } });
    expect(statesNewAddress(both('9876 Other Grove Circle, Parrish'), palm)).toBe(true);
    expect(statesNewAddress(both('1236 Sample Palm Drive'), palm)).toBe(true);
    expect(statesNewAddress(both('1234 sample palm drive, same as always'), palm)).toBe(false);
    expect(statesNewAddress(both('yes, same place'), palm)).toBe(false);
  });

  test.each([
    '1234 Sample Palm Grove Circle',
    '1234 Grove Sample Palm Circle',
    '1234 Palm Sample Drive',
    '1234 Sample Palm Drive North',
    '1234 Sample Palm Street Drive',
  ])('the complete raw street name must agree before reusing the on-file address: %s', (raw_text) => {
    const palm = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressCity: 'Parrish', addressZip: '34219' };
    for (const street_line_1 of [undefined, '1234 Sample Palm Drive']) {
      const ex = v2({ property: { service_address: { raw_text, street_line_1 } }, triage_flags: ['address_unverified'] });
      expect(statesNewAddress(ex, palm)).toBe(true);
      expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: palm })).toBe(false);
      expect(canAutoRoute(ex, {
        contactPhone: ANI, failOpen: true, knownCustomer: palm,
        addressValidation: { status: 'missing_component', inServiceArea: true },
      }).allowed).toBe(false);
    }
  });

  test('a complete raw address still accepts matching locality and unit components', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const ex = v2({ property: { service_address: { raw_text: '500 Sample Tower Boulevard Apt 4B Sarasota FL 34240' } } });
    expect(statesNewAddress(ex, condo)).toBe(false);
  });

  test('a trailing street direction must agree and must not be discarded as a locality', () => {
    const north = { hasAddress: true, addressLine1: '1234 Sample Palm Dr North', addressCity: 'Parrish', addressZip: '34219' };
    const stated = raw_text => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(stated('1234 Sample Palm Drive North'), north)).toBe(false);
    expect(statesNewAddress(stated('1234 Sample Palm Drive South'), north)).toBe(true);
    expect(statesNewAddress(stated('1234 Sample Palm Drive North, Sarasota'), north)).toBe(true);
  });
});
