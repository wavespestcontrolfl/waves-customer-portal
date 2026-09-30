// GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL (owner ruling 2026-09-30): a web-form
// lead whose on-file address came from their own form, who does not repeat it
// on the call, books to that form address even when Google confirms only the
// STREET (a new-build street in Parrish / Lakewood Ranch). The visit itself holds
// pending for the office's address confirmation, with one admin bell. Synthetic names and addresses only.
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
  buildStreetLevelHold,
  buildStreetLevelHoldAlert,
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
  test('books to the form address: trusted address-only, evidence persisted, routes on file, hold built', async () => {
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

    // ...and the booking is held: the visit itself is the hold.
    const hold = buildStreetLevelHold({ knownCaller: out, routingResult: routing });
    expect(hold).toMatchObject({ address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219', google_street: 'Sample Newbuild Trail', customer_name: 'Form' });
    expect(buildStreetLevelHold({ knownCaller: out, routingResult: { allowed: true } })).toBeNull();
    expect(buildStreetLevelHold({ knownCaller: lead(), routingResult: routing })).toBeNull();
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
    expect(buildStreetLevelHold({ knownCaller: out, routingResult: { usesOnFileAddress: true } })).toBeNull();
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


describe('area, house number and call-origin provenance', () => {
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

});

describe('units', () => {
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
});

describe('county-confirmed and shared-ZIP area proof', () => {
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
});

describe('visit hold (owner ruling 2026-09-30)', () => {
  const fs = require('fs');
  const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
  const sa = require('../services/call-booking-source-actions');
  const held = { source_action: 'call_street_level_review', status: 'pending', customer_confirmed: false };

  test('the marker is a pending office-review, dispatch-owned source action within varchar(30)', () => {
    expect(sa.CALL_STREET_LEVEL_REVIEW_SOURCE_ACTION).toBe('call_street_level_review');
    expect(sa.CALL_STREET_LEVEL_REVIEW_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
    expect(sa.OFFICE_REVIEW_PENDING_SOURCE_ACTIONS).toContain('call_street_level_review');
    expect(sa.DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toContain('call_street_level_review');
  });

  test('isStreetLevelAddressHold: only this marker, still pending, unconfirmed; and it is not a field-confirmable review booking', () => {
    expect(sa.isStreetLevelAddressHold(held)).toBe(true);
    for (const patch of [{ status: 'confirmed' }, { status: 'cancelled' }, { customer_confirmed: true }, { source_action: 'voice_agent' }, { source_action: 'ai_call_pipeline' }]) {
      expect(sa.isStreetLevelAddressHold({ ...held, ...patch })).toBe(false);
    }
    expect(sa.isStreetLevelAddressHold(null)).toBe(false);
    expect(sa.isPendingOutboundReviewBooking(held)).toBe(false);   // tech-track dispatch-implies-confirm never confirms it
    expect(sa.isPendingOutboundReviewBooking({ ...held, source_action: 'voice_agent' })).toBe(true);
  });

  test('the booking insert holds the visit pending, unconfirmed and marked, only while the on-file proof binds', () => {
    const src = read('../services/call-recording-processor.js');
    expect(src).toContain("const streetLevelHoldApplies = !!v2StreetLevelHold && onFileAuthority.useOnFileAddress;");
    expect(src).toContain("status: streetLevelHoldApplies ? 'pending' : 'confirmed',");
    expect(src).toContain('customer_confirmed: !streetLevelHoldApplies,');
    expect(src).toContain('confirmed_at: streetLevelHoldApplies ? null : new Date(),');
    expect(src).toContain("source_action: streetLevelHoldApplies ? CALL_STREET_LEVEL_REVIEW_SOURCE_ACTION : 'ai_call_pipeline',");
    // The default (gate off / no hold) insert is unchanged in effect: confirmed, customer_confirmed, ai_call_pipeline.
    expect(src).toContain("v2StreetLevelHold = buildStreetLevelHold({ knownCaller, routingResult });");
  });

  test('NO customer text or email at booking for a held visit, and none from a replay repair', () => {
    const src = read('../services/call-recording-processor.js');
    // The confirmation section skips both channels before any send branch.
    const skipAt = src.indexOf("if (scheduledServiceId && streetLevelHeldVisit) {");
    const sendAt = src.indexOf('} else if (scheduledServiceId) {', skipAt);
    expect(skipAt).toBeGreaterThan(0);
    expect(sendAt).toBeGreaterThan(skipAt);
    expect(src.slice(skipAt, sendAt)).toContain("smsSkippedReason: 'street_level_address_hold'");
    expect(src.slice(skipAt, sendAt)).not.toMatch(/deliverConfirmationByChannel|smsAttempt/);
    // The implied-consent hold card is not filed for a held visit either.
    expect(src).toContain('if (scheduledServiceId && !streetLevelHeldVisit && !v2SmsBlocked && holdImpliedSmsLeg) {');
    // A replay's confirmation repairs stand down (replaySlotVerified stays false).
    expect(src).toMatch(/if \(isStreetLevelAddressHold\(svc\)\) \{\s*logger\.info\(`\[call-proc\] replay of \$\{svc\.id\}: street-level address hold — no confirmation repair`\);\s*\} else try \{/);
    // Lead conversion waits for the office confirm.
    expect(src).toMatch(/if \(booking && isStreetLevelAddressHold\(booking\)\) return false;/);
  });

  test('the one admin bell per visit: notifyAdmin, bell:true, deduped on the visit id, says what to do, links to the visit', () => {
    const hold = { address_on_file: '1234 Sample Newbuild Trl, Parrish, FL, 34219', google_street: 'Sample Newbuild Trail', customer_name: 'Form Lead' };
    const a = buildStreetLevelHoldAlert({ hold, visitId: 'visit-9', callSid: 'CA1', scheduledDate: '2026-10-05T00:00:00.000Z', windowStart: '13:00:00' });
    expect(a.category).toBe('schedule');
    expect(a.title).toBe('Confirm address before dispatch');
    expect(a.body).toContain('Form Lead, 1234 Sample Newbuild Trl, Parrish, FL, 34219, 2026-10-05 13:00');
    expect(a.body).toMatch(/confirm the visit \(or correct its address, or cancel\)/i);
    expect(a.opts).toMatchObject({ bell: true, dedupeKey: 'street-level-address-hold:visit-9', link: '/admin/schedule?serviceId=visit-9' });
    expect(a.opts.metadata).toMatchObject({ scheduledServiceId: 'visit-9', callSid: 'CA1' });
    // Same dedupe key on a reprocess of the same visit; a different visit rings separately.
    expect(buildStreetLevelHoldAlert({ hold, visitId: 'visit-9' }).opts.dedupeKey).toBe(a.opts.dedupeKey);
    expect(buildStreetLevelHoldAlert({ hold, visitId: 'visit-10' }).opts.dedupeKey).not.toBe(a.opts.dedupeKey);
    // Wired through the shared notifyAdmin, after the booking committed.
    const src = read('../services/call-recording-processor.js');
    expect(src).toMatch(/notifyAdmin\(alert\.category, alert\.title, alert\.body, alert\.opts\)/);
  });

  test('only the office confirm, cancel or skip leave the hold: every other transition and any reschedule is refused', () => {
    const js = read('../services/job-status.js');
    expect(js).toMatch(/isStreetLevelAddressHold\(legacyRow\)\s*&& !\['pending', 'confirmed'\]\.includes\(String\(toStatus \|\| ''\)\)/);
    expect(js).toContain("code: 'STREET_LEVEL_ADDRESS_HOLD'");
    // The guard sits inside the block that cancel/skip bypass.
    expect(js.indexOf("const legacyRow = await t('scheduled_services')")).toBeLessThan(js.indexOf("code: 'STREET_LEVEL_ADDRESS_HOLD'"));
    const rb = read('../services/rebooker.js');
    expect(rb.split('refuseStreetLevelAddressHold(service);').length - 1).toBe(2);   // rescheduleOnce + rescheduleSeries
    const oc = read('../services/outbound-review-confirm.js');
    expect(oc).toMatch(/isStreetLevelAddressHold\(row\)\) \{\s*return false;/);   // no lazy activation of a held row
  });

  test('the triage-card machinery is gone', () => {
    const src = read('../services/call-recording-processor.js');
    for (const gone of ['address_readback_form_street', 'recordStreetLevelReadback', 'buildStreetLevelReadbackWrite', 'buildStreetLevelReadbackItem', 'streetLevelReadbackEligibleRow', 'v2StreetLevelReadbackItem']) {
      expect(src).not.toContain(gone);
    }
    expect(read('../routes/admin-triage.js')).not.toContain('address_readback_form_street');
    expect(read('../services/call-routing-gates.js')).not.toContain('address_readback_form_street');
  });
});

describe('shared ZIPs need Google\'s own county (owner ruling 2026-09-30)', () => {
  const lookup = require('../services/property-lookup/ai-property-lookup');
  const n = (zip, city = 'Boca Grande') => ({ street_line_1: 'Sample Newbuild Trail', city, state: 'FL', postal_code: zip });

  test('33955 and 33921 (Charlotte / Lee) fail closed with no county, and clear only with a served county', () => {
    gateOn();
    for (const zip of ['33955', '33921']) {
      const k = lead({ city: 'Punta Gorda', zip });
      expect(streetLevelMatch(k, routeLevel({ inServiceArea: null, normalized: n(zip) }))).toBeNull();
      expect(streetLevelMatch(k, routeLevel({ inServiceArea: true, county: 'Charlotte County', normalized: n(zip) }))).toMatchObject({ areaBasis: 'google_county' });
      expect(streetLevelMatch(k, routeLevel({ inServiceArea: false, county: 'Lee County', normalized: n(zip) }))).toBeNull();
    }
  });

  test('every ZIP on the imported shared sets, and the service-area map\'s multi-county ZIPs, needs a county', () => {
    gateOn();
    const { SHARED_SERVICE_AREA_ZIPS } = require('../config/address-county');
    const shared = new Set([...lookup.MANATEE_SHARED_ZIPS, ...lookup.SARASOTA_SHARED_ZIPS, ...lookup.CHARLOTTE_SHARED_ZIPS, ...SHARED_SERVICE_AREA_ZIPS]);
    expect(shared.has('33955') && shared.has('33921') && shared.has('34228')).toBe(true);
    for (const zip of shared) {
      expect(streetLevelMatch(lead({ zip }), routeLevel({ inServiceArea: null, normalized: n(zip, 'Parrish') }))).toBeNull();
    }
    // The sets are imported from ai-property-lookup, not copied.
    expect(require('fs').readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8')).toContain("require('./property-lookup/ai-property-lookup')");
  });

  test('an unambiguous served ZIP still works on the ZIP path', () => {
    gateOn();
    expect(streetLevelMatch(lead(), routeLevel())).toMatchObject({ areaBasis: 'google_zip' });
    expect(streetLevelMatch(lead({ city: 'Venice', zip: '34292' }), routeLevel({ normalized: n('34292', 'Venice') }))).toMatchObject({ areaBasis: 'google_zip' });
  });
});
