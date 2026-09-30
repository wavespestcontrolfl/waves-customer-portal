// GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL (owner ruling 2026-09-30): a web-form
// lead whose on-file address came from their own form, who does not repeat it
// on the call, books to that form address even when Google confirms only the
// STREET (a new-build street in Parrish / Lakewood Ranch). The office gets an
// address_readback card. Synthetic names and addresses only.
const CallRecordingProcessor = require('../services/call-recording-processor');
const { canAutoRoute } = require('../services/call-triage-flags');
const { callLeadFormAddressStreetLevelLive } = require('../config/feature-gates');

const {
  summarizeKnownCaller,
  failOpenKnownCustomer,
  trustValidatedNewLeadAddress,
  buildFailOpenRoutingContext,
  onFileAddressIsFromWebForm,
  streetLevelMatch,
  buildStreetLevelReadbackItem,
} = CallRecordingProcessor._test;

const GATE = 'GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL';
const ANI = '+19415550100';

const lead = (extra = {}) => summarizeKnownCaller({
  id: 'lead-1', first_name: 'Form', pipeline_stage: 'new_lead',
  address_line1: '1234 Sample Newbuild Trl', city: 'Parrish', state: 'FL', zip: '34219', ...extra,
});
// What Google says for a house it has not indexed on a street it knows.
const routeLevel = (extra = {}) => ({
  status: 'missing_component', granularity: 'ROUTE', inServiceArea: null, county: null,
  normalized: { street_line_1: 'Sample Newbuild Trail', city: 'Parrish', state: 'FL', postal_code: '34219' },
  ...extra,
});
const confirmed = (serviceAddress = {}) => ({
  triage_flags: ['missing_service_address'],
  confidence: { overall: 0.9 },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-05T13:00:00-04:00' },
  consent: {},
  property: { service_address: serviceAddress },
});
const yesForm = jest.fn(async () => true);

let saved;
beforeEach(() => { saved = process.env[GATE]; yesForm.mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });
const gateOn = () => { process.env[GATE] = 'true'; };

describe('gate reader', () => {
  test('strict === "true", off by default', () => {
    delete process.env[GATE];
    expect(callLeadFormAddressStreetLevelLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', '']) { process.env[GATE] = v; expect(callLeadFormAddressStreetLevelLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(callLeadFormAddressStreetLevelLive()).toBe(true);
  });
});

describe('gate off: nothing changes', () => {
  test('a street-level answer earns no trust and the form lookup never runs', async () => {
    delete process.env[GATE];
    const out = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm });
    expect(out.addressTrusted).toBe(false);
    expect(out.onFileStreetLevel).toBeUndefined();
    expect(out.onFileAddressVerdict).toEqual({
      status: 'missing_component', inServiceArea: null,
      address: { line1: '1234 sample newbuild trl', line2: '', city: 'parrish', state: 'fl', zip: '34219' },
    });
    expect(yesForm).not.toHaveBeenCalled();
    expect(failOpenKnownCustomer(out)).toBeNull();
  });

  test('a persisted street-level verdict replays as untrusted', () => {
    delete process.env[GATE];
    const customer = { id: 'lead-1', pipeline_stage: 'new_lead', address_line1: '1234 Sample Newbuild Trl', city: 'Parrish', state: 'FL', zip: '34219' };
    const verdict = {
      status: 'street_level_form_accept', inServiceArea: true,
      address: { line1: '1234 sample newbuild trl', line2: '', city: 'parrish', state: 'fl', zip: '34219' },
      streetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219' },
    };
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound' }, customer, failOpenEnabled: true, onFileAddressVerdict: verdict }).options.knownCustomer).toBeNull();
  });
});

describe('gate on: street-level match on a web-form address', () => {
  test('books to the form address: trusted address-only, evidence persisted, routes on file, read-back card filed', async () => {
    gateOn();
    const out = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm });
    expect(yesForm).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      addressTrusted: true, addressOnly: true, addressState: 'FL',
      onFileStreetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219' },
      onFileAddressVerdict: {
        status: 'street_level_form_accept', inServiceArea: true,
        address: { line1: '1234 sample newbuild trl', city: 'parrish', state: 'fl', zip: '34219' },
        streetLevel: { granularity: 'ROUTE' },
      },
    });
    const known = failOpenKnownCustomer(out);
    expect(known).toMatchObject({ addressOnly: true, hasAddress: true, addressLine1: '1234 Sample Newbuild Trl', addressZip: '34219' });

    // The routing gate books it to the on-file address (no address stated on the call).
    const routing = canAutoRoute(confirmed(), { failOpen: true, callerAni: ANI, contactPhone: ANI, knownCustomer: known });
    expect(routing.allowed).toBe(true);
    expect(routing.usesOnFileAddress).toBe(true);

    // ...and the office gets the existing read-back card, advisory, address lane.
    const item = buildStreetLevelReadbackItem({ knownCaller: out, routingResult: routing, callLogId: 'call-1', extraction: confirmed() });
    expect(item).toMatchObject({ call_log_id: 'call-1', reason_code: 'address_readback', severity: 'advisory', category: 'address_review' });
    expect(JSON.parse(item.payload)).toMatchObject({
      flag: 'address_readback', address_source: 'web_form_on_file',
      address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219',
      google_granularity: 'ROUTE', google_street: 'Sample Newbuild Trail',
    });
  });

  test('the persisted verdict replays as trusted for the offline audits; a moved record does not', () => {
    gateOn();
    const customer = { id: 'lead-1', pipeline_stage: 'new_lead', address_line1: '1234 Sample Newbuild Trl', city: 'Parrish', state: 'FL', zip: '34219' };
    const verdict = {
      status: 'street_level_form_accept', inServiceArea: true,
      address: { line1: '1234 sample newbuild trl', line2: '', city: 'parrish', state: 'fl', zip: '34219' },
      streetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219' },
    };
    const ctx = (c, v = verdict) => buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: v } }, customer: c, contactPhone: ANI, failOpenEnabled: true });
    expect(ctx(customer).options.knownCustomer).toMatchObject({ addressOnly: true, addressLine1: '1234 Sample Newbuild Trl' });
    expect(ctx({ ...customer, address_line1: '99 Moved Ln' }).options.knownCustomer).toBeNull();
    expect(ctx(customer, { ...verdict, streetLevel: undefined }).options.knownCustomer).toBeNull();
    expect(ctx(customer, { ...verdict, inServiceArea: null }).options.knownCustomer).toBeNull();
  });

  test('Google reporting the county in area is fine; a county out of area is not', async () => {
    gateOn();
    const inArea = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel({ inServiceArea: true, county: 'Manatee County' }), extraction: confirmed(), isFormAddress: yesForm });
    expect(inArea.addressTrusted).toBe(true);
    const out = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel({ inServiceArea: false, county: 'Lee County' }), extraction: confirmed(), isFormAddress: yesForm });
    expect(out.addressTrusted).toBe(false);
  });
});

describe('gate on: every other case keeps its existing path', () => {
  const run = (knownCaller, verdict, extraction = confirmed(), isFormAddress = yesForm) => trustValidatedNewLeadAddress(knownCaller, { validate: async () => verdict, extraction, isFormAddress });

  test('a house-level match (validated_accept) is the unchanged path: no form lookup, no street-level evidence', async () => {
    gateOn();
    const out = await run(lead(), { status: 'validated_accept', inServiceArea: true });
    expect(out).toMatchObject({ addressTrusted: true, addressOnly: true, onFileAddressVerdict: { status: 'validated_accept' } });
    expect(out.onFileStreetLevel).toBeUndefined();
    expect(yesForm).not.toHaveBeenCalled();
    expect(buildStreetLevelReadbackItem({ knownCaller: out, routingResult: { usesOnFileAddress: true }, callLogId: 'c' })).toBeNull();
  });

  test('a caller who states a different address takes the normal validation path: no lookup at all', async () => {
    gateOn();
    const validate = jest.fn(async () => routeLevel());
    const out = await trustValidatedNewLeadAddress(lead(), {
      validate, isFormAddress: yesForm,
      extraction: confirmed({ street_line_1: '99 Other Rd', city: 'Sarasota', postal_code: '34231' }),
    });
    expect(validate).not.toHaveBeenCalled();
    expect(yesForm).not.toHaveBeenCalled();
    expect(out.addressTrusted).toBe(false);
  });

  test('a lead whose address did not come from a web form is not trusted', async () => {
    gateOn();
    const out = await run(lead(), routeLevel(), confirmed(), jest.fn(async () => false));
    expect(out.addressTrusted).toBe(false);
    expect(out.onFileAddressVerdict.status).toBe('missing_component');
  });

  test('out of area: Google county out of area, or an out-of-area ZIP, never trusts', async () => {
    gateOn();
    expect((await run(lead(), routeLevel({ status: 'out_of_service_area', inServiceArea: false }))).addressTrusted).toBe(false);
    expect((await run(lead({ zip: '34103', city: 'Naples' }), routeLevel({ normalized: { street_line_1: 'Sample Newbuild Trail', city: 'Naples', state: 'FL', postal_code: '34103' } }))).addressTrusted).toBe(false);
    expect((await run(lead({ state: 'GA' }), routeLevel())).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ normalized: { street_line_1: 'Sample Newbuild Trail', city: 'Parrish', state: 'GA', postal_code: '34219' } }))).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ normalized: { street_line_1: 'Sample Newbuild Trail', city: 'Parrish', state: 'FL', postal_code: '34203' } }))).addressTrusted).toBe(false);
  });

  test('a street Google does not know (not route-level) or a different street never trusts', async () => {
    gateOn();
    expect((await run(lead(), routeLevel({ granularity: 'OTHER' }))).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ granularity: null, normalized: { street_line_1: null, city: null, state: 'FL', postal_code: null } }))).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ normalized: { street_line_1: 'Other Street Boulevard', city: 'Parrish', state: 'FL', postal_code: '34219' } }))).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ status: 'confirm_needed' }))).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel({ status: 'ambiguous' }))).addressTrusted).toBe(false);
    expect((await run(lead(), null)).addressTrusted).toBe(false);
  });

  test('a form address with no house number is never booked on a street match', async () => {
    gateOn();
    const out = await run(lead({ address_line1: 'Sample Newbuild Trl' }), routeLevel());
    expect(out.addressTrusted).toBe(false);
    expect(yesForm).not.toHaveBeenCalled();
  });

  test('a call that did not confirm a booking keeps its address review', async () => {
    gateOn();
    expect((await run(lead(), routeLevel(), { ...confirmed(), scheduling: { status: 'none' } })).addressTrusted).toBe(false);
    expect((await run(lead(), routeLevel(), null)).addressTrusted).toBe(false);
  });

  test('an established customer is trusted as before and never asks Google or the form lookup', async () => {
    gateOn();
    const validate = jest.fn();
    const won = await trustValidatedNewLeadAddress(summarizeKnownCaller({ id: 'c1', pipeline_stage: 'won', address_line1: '1 A St', zip: '34219' }), { validate, extraction: confirmed(), isFormAddress: yesForm });
    expect(won).toMatchObject({ addressTrusted: true, addressOnly: false });
    expect(validate).not.toHaveBeenCalled();
    expect(yesForm).not.toHaveBeenCalled();
  });
});

describe('streetLevelMatch (pure)', () => {
  test('numbered streets compare exactly, suffix spelling does not matter', () => {
    gateOn();
    const known = lead({ address_line1: '4021 14th Ave E' });
    const n = (street) => ({ street_line_1: street, city: 'Parrish', state: 'FL', postal_code: '34219' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('14th Avenue East') }))).toBeNull();   // directional word is part of the name: fail closed
    expect(streetLevelMatch(known, routeLevel({ normalized: n('14th Ave E') }))).toMatchObject({ granularity: 'ROUTE' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('4th Ave E') }))).toBeNull();
    expect(streetLevelMatch(known, routeLevel({ normalized: n('114th Ave E') }))).toBeNull();
  });
});

describe('onFileAddressIsFromWebForm', () => {
  const connWith = (rows, calls = []) => (table) => {
    const q = {
      where: (w) => { calls.push({ table, where: w }); return q; },
      whereIn: (col, vals) => { calls.push({ col, vals }); return q; },
      whereNull: (col) => { calls.push({ isNull: col }); return q; },
      select: () => q,
      limit: async () => rows,
    };
    return q;
  };

  test('true only for a live form lead at the same house and street', async () => {
    const known = lead();
    const calls = [];
    expect(await onFileAddressIsFromWebForm(known, connWith([{ address: '1234 Sample Newbuild Trail, Parrish, FL 34219', zip: '34219' }], calls))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      { table: 'leads', where: { customer_id: 'lead-1' } },
      { col: 'first_contact_channel', vals: ['form', 'website_quote'] },
      { isNull: 'deleted_at' },
    ]));
    // A different house, street or ZIP on the form is not the on-file address.
    expect(await onFileAddressIsFromWebForm(known, connWith([{ address: '1299 Sample Newbuild Trail, Parrish, FL 34219', zip: '34219' }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, connWith([{ address: '1234 Other Street, Parrish, FL 34219', zip: '34219' }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, connWith([{ address: '1234 Sample Newbuild Trail', zip: '34203' }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, connWith([]))).toBe(false);
  });

  test('fails closed with no customer id, no house number, or a lookup error', async () => {
    expect(await onFileAddressIsFromWebForm(lead({ id: null }), connWith([{ address: '1234 Sample Newbuild Trail' }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(lead({ address_line1: 'Sample Newbuild Trl' }), connWith([{ address: 'Sample Newbuild Trail' }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(lead(), () => { throw new Error('db down'); })).toBe(false);
  });
});

describe('buildStreetLevelReadbackItem', () => {
  test('no card unless the booking really dispatches to the street-level on-file address', async () => {
    gateOn();
    const out = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm });
    expect(buildStreetLevelReadbackItem({ knownCaller: out, routingResult: { allowed: true }, callLogId: 'c' })).toBeNull();
    expect(buildStreetLevelReadbackItem({ knownCaller: out, routingResult: { usesOnFileAddress: false }, callLogId: 'c' })).toBeNull();
    expect(buildStreetLevelReadbackItem({ knownCaller: lead(), routingResult: { usesOnFileAddress: true }, callLogId: 'c' })).toBeNull();
    expect(buildStreetLevelReadbackItem({ knownCaller: null, routingResult: null, callLogId: 'c' })).toBeNull();
  });
});
