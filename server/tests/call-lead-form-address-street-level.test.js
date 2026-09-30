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
  buildStreetLevelReadbackWrite,
  recordStreetLevelReadback,
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
const { parseRawAddress } = require('../utils/address-normalizer');
// A lead row as the web form leaves it: the form endpoint's normalized address snapshot in extracted_data.
const formRow = (address, zip) => {
  const p = parseRawAddress(address);
  return { first_contact_channel: 'form', address, zip, extracted_data: { stage: 'lead_webhook_received', address: { line1: p.line1, city: p.city, zip: p.zip || zip || '' } } };
};

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
      streetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219', areaBasis: 'google_zip' },
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
      streetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219', areaBasis: 'google_zip' },
    };
    const ctx = (c, v = verdict) => buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: v } }, customer: c, contactPhone: ANI, failOpenEnabled: true });
    expect(ctx(customer).options.knownCustomer).toMatchObject({ addressOnly: true, addressLine1: '1234 Sample Newbuild Trl' });
    expect(ctx({ ...customer, address_line1: '99 Moved Ln' }).options.knownCustomer).toBeNull();
    expect(ctx(customer, { ...verdict, streetLevel: undefined }).options.knownCustomer).toBeNull();
    expect(ctx(customer, { ...verdict, inServiceArea: null }).options.knownCustomer).toBeNull();
    expect(ctx(customer, { ...verdict, streetLevel: { granularity: 'ROUTE', route: 'x', zip: '34219' } }).options.knownCustomer).toBeNull();   // no recorded area basis
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
    expect(streetLevelMatch(known, routeLevel({ normalized: n('14th Avenue East') }))).toMatchObject({ granularity: 'ROUTE' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('14th Ave E') }))).toMatchObject({ granularity: 'ROUTE' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('14th Avenue West') }))).toBeNull();
    expect(streetLevelMatch(known, routeLevel({ normalized: n('4th Ave E') }))).toBeNull();
    expect(streetLevelMatch(known, routeLevel({ normalized: n('114th Ave E') }))).toBeNull();
  });
});

describe('street type is part of the street (codex pre-push P1)', () => {
  test('Dr / Drive are one street; Drive is not Court, Lane or Way', async () => {
    gateOn();
    const known = lead({ address_line1: '1234 Sample Palm Dr' });
    const n = (street) => ({ street_line_1: street, city: 'Parrish', state: 'FL', postal_code: '34219' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('Sample Palm Drive') }))).toMatchObject({ granularity: 'ROUTE' });
    expect(streetLevelMatch(known, routeLevel({ normalized: n('Sample Palm Dr') }))).toMatchObject({ granularity: 'ROUTE' });
    for (const other of ['Sample Palm Court', 'Sample Palm Ct', 'Sample Palm Lane', 'Sample Palm Way', 'Sample Palm']) {
      expect(streetLevelMatch(known, routeLevel({ normalized: n(other) }))).toBeNull();
    }
    const out = await trustValidatedNewLeadAddress(known, { validate: async () => routeLevel({ normalized: n('Sample Palm Court') }), extraction: confirmed(), isFormAddress: yesForm });
    expect(out.addressTrusted).toBe(false);
    expect(yesForm).not.toHaveBeenCalled();
  });

  test('the form-provenance check keeps the street type too', async () => {
    const known = lead({ address_line1: '1234 Sample Palm Dr' });
    const conn = (address) => () => ({ where() { return this; }, whereIn() { return this; }, whereNull() { return this; }, select() { return this; }, orderBy() { return this; }, limit: async () => [formRow(address, '34219')] });
    expect(await onFileAddressIsFromWebForm(known, conn('1234 Sample Palm Drive, Parrish, FL 34219'))).toBe(true);
    expect(await onFileAddressIsFromWebForm(known, conn('1234 Sample Palm Dr Parrish FL 34219'))).toBe(true);
    expect(await onFileAddressIsFromWebForm(known, conn('1234 Sample Palm Court, Parrish, FL 34219'))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn('1234 Sample Palm Ct Parrish FL 34219'))).toBe(false);
  });

  test('the WHOLE street must match: an extra directional or street word never hides as a city (codex pre-push r2 P1)', async () => {
    const known = lead({ address_line1: '1234 Sample Palm Dr' });
    const conn = (address) => () => ({ where() { return this; }, whereIn() { return this; }, whereNull() { return this; }, select() { return this; }, orderBy() { return this; }, limit: async () => [formRow(address, null)] });
    for (const typed of [
      '1234 Sample Palm Drive East',
      '1234 Sample Palm Drive East, Parrish, FL 34219',
      '1234 Sample Palm Drive East Parrish FL 34219',
      '1234 Sample Palm Drive Circle',
      '1234 Sample Palm Drive Circle Parrish FL 34219',
      '1234 Sample Palm Dr Bradenton FL 34219',
    ]) {
      expect(await onFileAddressIsFromWebForm(known, conn(typed))).toBe(false);
    }
    for (const typed of ['1234 Sample Palm Dr', '1234 Sample Palm Drive, Parrish', '1234 Sample Palm Dr, Parrish, FL 34219']) {
      expect(await onFileAddressIsFromWebForm(known, conn(typed))).toBe(true);
    }
  });
});

describe('onFileAddressIsFromWebForm', () => {
  const connWith = (rows, calls = []) => (table) => {
    const q = {
      where: (w) => { calls.push({ table, where: w }); return q; },
      whereIn: (col, vals) => { calls.push({ col, vals }); return q; },
      whereNull: (col) => { calls.push({ isNull: col }); return q; },
      select: () => q,
      orderBy: () => q,
      limit: async () => rows.map((r) => formRow(r.address, r.zip)),
    };
    return q;
  };

  test('true only for a live form lead at the same house and street', async () => {
    const known = lead();
    const calls = [];
    expect(await onFileAddressIsFromWebForm(known, connWith([{ address: '1234 Sample Newbuild Trail, Parrish, FL 34219', zip: '34219' }], calls))).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      { table: 'leads', where: { customer_id: 'lead-1' } },
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

describe('codex round 1 on #5381', () => {
  test('P1: Google must affirm the area itself — its own ZIP and state, or a service county', async () => {
    gateOn();
    const run = (verdict) => trustValidatedNewLeadAddress(lead(), { validate: async () => verdict, extraction: confirmed(), isFormAddress: yesForm });
    const n = (extra) => ({ street_line_1: 'Sample Newbuild Trail', city: 'Parrish', state: 'FL', postal_code: '34219', ...extra });
    // No county and no ZIP or state from Google: the form's ZIP alone is not a witness.
    expect((await run(routeLevel({ normalized: n({ postal_code: null }) }))).addressTrusted).toBe(false);
    expect((await run(routeLevel({ normalized: n({ state: null }) }))).addressTrusted).toBe(false);
    expect((await run(routeLevel({ normalized: n({ postal_code: '34203' }) }))).addressTrusted).toBe(false);
    // Google's own ZIP and state agree: trusted, and the basis is recorded.
    const zipOnly = await run(routeLevel());
    expect(zipOnly.addressTrusted).toBe(true);
    expect(zipOnly.onFileAddressVerdict.streetLevel.areaBasis).toBe('google_zip');
    const county = await run(routeLevel({ inServiceArea: true, county: 'Manatee County' }));
    expect(county.onFileAddressVerdict.streetLevel.areaBasis).toBe('google_county');
  });

  test('P1: the whole house number counts, alphabetic suffix included', async () => {
    const known = lead({ address_line1: '123A Sample Newbuild Trl' });
    const conn = (address) => () => ({ where() { return this; }, whereNull() { return this; }, orderBy() { return this; }, select() { return this; }, limit: async () => [formRow(address, '34219')] });
    expect(await onFileAddressIsFromWebForm(known, conn('123A Sample Newbuild Trail, Parrish, FL 34219'))).toBe(true);
    expect(await onFileAddressIsFromWebForm(known, conn('123B Sample Newbuild Trail, Parrish, FL 34219'))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn('123 Sample Newbuild Trail, Parrish, FL 34219'))).toBe(false);
    expect(await onFileAddressIsFromWebForm(lead({ address_line1: '123 Sample Newbuild Trl' }), conn('123A Sample Newbuild Trail, Parrish, FL 34219'))).toBe(false);
    // Google rewriting the house number is not the form's house.
    gateOn();
    const g = (street) => routeLevel({ normalized: { street_line_1: street, city: 'Parrish', state: 'FL', postal_code: '34219' } });
    expect(streetLevelMatch(known, g('123A Sample Newbuild Trail'))).toMatchObject({ granularity: 'ROUTE' });
    expect(streetLevelMatch(known, g('123B Sample Newbuild Trail'))).toBeNull();
    expect(streetLevelMatch(known, g('Sample Newbuild Trail'))).toMatchObject({ granularity: 'ROUTE' });
  });

  test('P2: a web form attached to a call-origin lead counts; a call-only lead does not', async () => {
    const known = lead();
    const conn = (rows) => () => ({ where() { return this; }, whereNull() { return this; }, orderBy() { return this; }, select() { return this; }, limit: async () => rows });
    const formAddr = { line1: '1234 Sample Newbuild Trl', city: 'Parrish', state: 'FL', zip: '34219' };
    // Voicemail text-back / phone-match attach: channel stays 'call', the form's typed address is in extracted_data.
    for (const stage of ['lead_webhook_received', 'property_lookup_started', 'quote_calculated']) {
      expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', address: '9 Call Spoken Ln', extracted_data: { stage, address: formAddr } }]))).toBe(true);
    }
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', extracted_data: JSON.stringify({ stage: 'lead_webhook_received', address: formAddr }) }]))).toBe(true);
    // The form's typed address must be the on-file one.
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', extracted_data: { stage: 'lead_webhook_received', address: { ...formAddr, line1: '1299 Sample Newbuild Trl' } } }]))).toBe(false);
    // A call-origin lead with no form evidence (the call's own address lives in leads.address) never qualifies.
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', address: '1234 Sample Newbuild Trl', zip: '34219', extracted_data: { source: 'voice_agent' } }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', address: '1234 Sample Newbuild Trl', extracted_data: { stage: 'voicemail', address: formAddr } }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'call', address: '1234 Sample Newbuild Trl', extracted_data: null }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'manual', address: '1234 Sample Newbuild Trl', zip: '34219' }]))).toBe(false);
    // An addressless form later enriched by a call: leads.address is call-derived, the form snapshot is empty or absent.
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'form', address: '1234 Sample Newbuild Trl', zip: '34219', extracted_data: { stage: 'lead_webhook_received', address: { line1: '', city: '', zip: '' } } }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'form', address: '1234 Sample Newbuild Trl', zip: '34219', extracted_data: { stage: 'lead_webhook_received' } }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'website_quote', address: '1234 Sample Newbuild Trl', zip: '34219', extracted_data: null }]))).toBe(false);
    // ...while the same form row WITH its snapshot on any channel qualifies.
    expect(await onFileAddressIsFromWebForm(known, conn([{ first_contact_channel: 'website_quote', extracted_data: { stage: 'quote_calculated', address: formAddr } }]))).toBe(true);
  });

  test('P1: the card is built for the booking transaction, not written at approval', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
    // The only writer of the item is inside the scheduled_services transaction, unguarded, after the visit insert.
    const writes = src.split('v2StreetLevelReadbackItem').length - 1;
    expect(src).toMatch(/v2StreetLevelReadbackItem = buildStreetLevelReadbackItem\(/);
    const insertAt = src.indexOf('await recordStreetLevelReadbackFor(created);');
    const visitInsertAt = src.indexOf(".insert(insertData)");
    expect(insertAt).toBeGreaterThan(visitInsertAt);
    expect(src).not.toMatch(/db\('triage_items'\)\s*\.insert\(streetLevelReadback\)/);
    expect(writes).toBeGreaterThanOrEqual(4);
  });
});

describe('codex round 2 on #5381', () => {
  test('P1: a unit-bearing address is outside the street-level lane, on either side', async () => {
    gateOn();
    const formAddr = { line1: '1234 Sample Newbuild Trl', line2: 'Apt 4', city: 'Parrish', state: 'FL', zip: '34219' };
    const conn = (rows) => () => ({ where() { return this; }, whereNull() { return this; }, orderBy() { return this; }, select() { return this; }, limit: async () => rows });
    // A form for Apt 4 never vouches for anything — not Apt 4, and not an on-file edit to Apt 5.
    expect(await onFileAddressIsFromWebForm(lead(), conn([{ first_contact_channel: 'form', extracted_data: { stage: 'lead_webhook_received', address: formAddr } }]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(lead({ address_line2: 'Apt 5' }), conn([{ first_contact_channel: 'form', extracted_data: { stage: 'lead_webhook_received', address: formAddr } }]))).toBe(false);
    // An on-file unit alone (form without one) is excluded too, and a unit-free form row still works for a unit-free record.
    const plain = { first_contact_channel: 'form', extracted_data: { stage: 'lead_webhook_received', address: { ...formAddr, line2: '' } } };
    expect(await onFileAddressIsFromWebForm(lead({ address_line2: 'Apt 5' }), conn([plain]))).toBe(false);
    expect(await onFileAddressIsFromWebForm(lead(), conn([plain]))).toBe(true);
    // Google's street-level answer never books a unit, and the whole path stays untrusted.
    expect(streetLevelMatch(lead({ address_line2: 'Apt 5' }), routeLevel())).toBeNull();
    const out = await trustValidatedNewLeadAddress(lead({ address_line2: 'Apt 5' }), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm });
    expect(out.addressTrusted).toBe(false);
    expect(yesForm).not.toHaveBeenCalled();
    // A persisted street-level verdict cannot be replayed onto a record that now carries a unit.
    const verdict = {
      status: 'street_level_form_accept', inServiceArea: true,
      address: { line1: '1234 sample newbuild trl', line2: 'apt 5', city: 'parrish', state: 'fl', zip: '34219' },
      streetLevel: { granularity: 'ROUTE', route: 'Sample Newbuild Trail', zip: '34219', areaBasis: 'google_zip' },
    };
    const customer = { id: 'lead-1', pipeline_stage: 'new_lead', address_line1: '1234 Sample Newbuild Trl', address_line2: 'Apt 5', city: 'Parrish', state: 'FL', zip: '34219' };
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound' }, customer, failOpenEnabled: true, onFileAddressVerdict: verdict }).options.knownCustomer).toBeNull();
  });

  describe('P1: the read-back card refreshes an open row on a reprocess', () => {
    const knex = require('knex')({ client: 'pg' });
    const item = () => {
      const routing = { usesOnFileAddress: true };
      return trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm })
        .then((k) => buildStreetLevelReadbackItem({ knownCaller: k, routingResult: routing, callLogId: 'call-1', extraction: confirmed() }));
    };

    test('the write is an upsert on the open-card index that merges the current payload and returns the row', async () => {
      gateOn();
      const q = buildStreetLevelReadbackWrite(knex, await item(), 'visit-9').toSQL();
      const sql = q.sql.replace(/\s+/g, ' ');
      expect(sql).toMatch(/insert into "triage_items"/);
      expect(sql).toMatch(/on conflict \(call_log_id, reason_code\) WHERE status IN \('open', 'in_progress'\) do update set/i);
      expect(sql).toMatch(/"payload" = COALESCE\(triage_items\.payload, '\{\}'::jsonb\) \|\| excluded\.payload/);
      expect(sql).not.toMatch(/do nothing/i);
      expect(sql).toMatch(/returning "id"/);
      const payload = JSON.parse(q.bindings.find((b) => typeof b === 'string' && b.includes('address_source')));
      expect(payload).toMatchObject({ scheduled_service_id: 'visit-9', address_source: 'web_form_on_file', address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219' });
      expect(payload.confirmation_question).toMatch(/house number/);
    });

    test('a landed row is returned; nothing landing throws so the booking rolls back', async () => {
      gateOn();
      const conn = (rows) => Object.assign(() => ({ insert: () => ({ onConflict: () => ({ merge: () => ({ returning: async () => rows }) }) }) }), { raw: (x) => x, fn: { now: () => 'now' } });
      expect(await recordStreetLevelReadback(conn([{ id: 7 }]), await item(), 'visit-9')).toEqual({ id: 7 });   // insert OR update of the open row
      await expect(recordStreetLevelReadback(conn([]), await item(), 'visit-9')).rejects.toThrow(/not recorded/);
      await expect(recordStreetLevelReadback(conn(undefined), await item(), 'visit-9')).rejects.toThrow(/not recorded/);
    });

    test('the booking transaction uses the helper, unguarded', () => {
      const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
      expect(src).toContain('await recordStreetLevelReadback(trx, v2StreetLevelReadbackItem, row.id, { callLogId: call.id });');
      expect(src).toContain('await recordStreetLevelReadbackFor(created);');
      expect(src).not.toMatch(/\.\.\.v2StreetLevelReadbackItem,[\s\S]{0,200}\.ignore\(\)/);
    });
  });
});

describe('codex round 3 on #5381', () => {
  const src = () => require('fs').readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');

  test('P2: a county Google confirms on the routing allowlist (DeSoto) is the area proof; without a county the ZIP set still governs', () => {
    gateOn();
    const desoto = lead({ city: 'Arcadia', zip: '34266' });
    const n = (extra) => ({ street_line_1: 'Sample Newbuild Trail', city: 'Arcadia', state: 'FL', postal_code: '34266', ...extra });
    const withCounty = routeLevel({ inServiceArea: true, county: 'DeSoto County', normalized: n() });
    expect(streetLevelMatch(desoto, withCounty)).toMatchObject({ granularity: 'ROUTE', areaBasis: 'google_county' });
    // County-confirmed: Google's ZIP may be absent, but a conflicting one still rejects, and state must be FL.
    expect(streetLevelMatch(desoto, routeLevel({ inServiceArea: true, normalized: n({ postal_code: null }) }))).toMatchObject({ areaBasis: 'google_county' });
    expect(streetLevelMatch(desoto, routeLevel({ inServiceArea: true, normalized: n({ postal_code: '34203' }) }))).toBeNull();
    expect(streetLevelMatch(desoto, routeLevel({ inServiceArea: true, normalized: n({ state: 'GA' }) }))).toBeNull();
    // No county: a ZIP outside the served set is refused even when Google echoes it.
    expect(streetLevelMatch(desoto, routeLevel({ inServiceArea: null, normalized: n() }))).toBeNull();
    // ...and an out-of-area county never qualifies, whatever the ZIP.
    expect(streetLevelMatch(lead(), routeLevel({ inServiceArea: false }))).toBeNull();
    // Manatee with no county still works through the ZIP path.
    expect(streetLevelMatch(lead(), routeLevel())).toMatchObject({ areaBasis: 'google_zip' });
  });

  test('P1: the upsert takes the shared per-call triage lock first', async () => {
    gateOn();
    const order = [];
    const conn = Object.assign(() => ({ insert: () => ({ onConflict: () => ({ merge: () => ({ returning: async () => { order.push('upsert'); return [{ id: 1 }]; } }) }) }) }), {
      raw: (sql, bindings) => { if (/advisory/.test(sql)) order.push(['lock', sql, bindings]); return sql; },
      fn: { now: () => 'now' },
    });
    const k = await trustValidatedNewLeadAddress(lead(), { validate: async () => routeLevel(), extraction: confirmed(), isFormAddress: yesForm });
    const item = buildStreetLevelReadbackItem({ knownCaller: k, routingResult: { usesOnFileAddress: true }, callLogId: 'call-1', extraction: confirmed() });
    await recordStreetLevelReadback(conn, item, 'visit-9');
    expect(order[0][0]).toBe('lock');
    expect(order[0][1]).toMatch(/pg_advisory_xact_lock/);
    expect(order[0][2]).toEqual(['triage-call-review', 'call-1']);
    expect(order[1]).toBe('upsert');
  });

  test('P1: a reprocess that reuses the booking (call-linked reuse and idempotency reuse) refiles the card too', () => {
    const s = src();
    const calls = s.split('await recordStreetLevelReadbackFor(').length - 1;
    expect(calls).toBe(3);   // fresh insert, findExistingCallAppointment reuse, idempotency-conflict reuse
    expect(s).toMatch(/if \(existing\) \{\s*reusedExistingSchedule = true;\s*await recordStreetLevelReadbackFor\(existing\);/);
    expect(s).toMatch(/if \(existingByKey\) \{\s*reusedExistingSchedule = true;\s*await recordStreetLevelReadbackFor\(existingByKey\);/);
    expect(s).toMatch(/await recordStreetLevelReadbackFor\(created\);/);
    // Only this call's own AI booking, never an attached human booking or a dead row; proof must bind.
    const helper = s.slice(s.indexOf('const recordStreetLevelReadbackFor'), s.indexOf('const existing = await findExistingCallAppointment'));
    expect(helper).toContain("booking_source || 'phone_call') !== 'phone_call'");
    expect(helper).toContain("['cancelled', 'rescheduled', 'skipped']");
    expect(helper).toContain('authority.useOnFileAddress');
    // address_readback stays out of SUPERSEDE_KEPT_REASON_CODES: the AV low-confidence read-back keeps its replace-on-new-recording semantics.
    expect(require('../services/call-routing-gates').SUPERSEDE_KEPT_REASON_CODES).not.toContain('address_readback');
  });

  test('P2: the call-level review state opens once the card has committed with the booking', () => {
    const s = src();
    expect(s).toMatch(/if \(streetLevelReadbackFiled && svc && !svc\.__held && !bridgeNeedsConfirmation\.includes\('address_readback'\)\) \{\s*bridgeNeedsConfirmation\.push\('address_readback'\);/);
    // The push comes after the booking transaction resolved, never inside it.
    expect(s.indexOf("bridgeNeedsConfirmation.push('address_readback')")).toBeGreaterThan(s.indexOf('const svc = await db.transaction(async (trx) => {'));
    expect(s.indexOf("bridgeNeedsConfirmation.push('address_readback')")).toBeGreaterThan(s.indexOf('await recordStreetLevelReadbackFor(existingByKey)'));
  });
});
