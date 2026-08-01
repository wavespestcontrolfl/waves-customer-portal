/**
 * buildCallContext fails CLOSED when the customer lookup is unavailable —
 * parity with the SMS-origin path (buildSmsThreadContext already reds out
 * with 'customer_lookup_unavailable'). A failed query is not a no-match: an
 * existing member could be hiding behind the error, and continuing would
 * quote them as a new prospect (dropping membership discounts and fee
 * waivers) while loading phone-scoped history whose shared-line safety
 * cannot be established. The red-lane bell in maybeDraftEstimateForCall
 * owns the manual path for these.
 */

let mockCallRow = null;
let mockCustomersFail = false;
let mockCustomerRows = [];
// Overrides customers .first() when set (loadGroundedCustomerById); falls
// back to mockCustomerRows[0] so the buildCallContext tests keep working.
let mockCustomerFirstRow;
// Makes ONLY the customers .first() path throw (grounded reload), leaving
// the phone-lookup `then` path healthy.
let mockCustomerFirstFail = false;
// Rows for the phone-scoped history loads (conflict-suppression pins).
let mockLeadRow = null;
let mockEstimateRows = [];
// Records the customers-table whereRaw/orWhereRaw SQL so the SMS-path
// contact-slot pin can assert which phone columns the lookup matched.
let mockCustomerWhereSql = [];

jest.mock('../models/db', () => {
  const db = (table) => ({
    select() { return this; },
    where(arg) {
      if (typeof arg === 'function') arg.call(this);
      return this;
    },
    whereRaw(sql) {
      if (table === 'customers') mockCustomerWhereSql.push(sql);
      return this;
    },
    orWhereRaw(sql) {
      if (table === 'customers') mockCustomerWhereSql.push(sql);
      return this;
    },
    orWhere() { return this; },
    whereNull() { return this; },
    whereNot() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async first() {
      if (table === 'call_log') return mockCallRow;
      if (table === 'customers') {
        if (mockCustomersFail || mockCustomerFirstFail) throw new Error('db down');
        if (mockCustomerFirstRow !== undefined) return mockCustomerFirstRow;
        return mockCustomerRows[0] || null;
      }
      if (table === 'leads') return mockLeadRow;
      return null;
    },
    then(resolve, reject) {
      if (table === 'customers' && mockCustomersFail) {
        return Promise.reject(new Error('db down')).then(resolve, reject);
      }
      if (table === 'customers') return Promise.resolve(mockCustomerRows).then(resolve, reject);
      if (table === 'estimates') return Promise.resolve(mockEstimateRows).then(resolve, reject);
      return Promise.resolve([]).then(resolve, reject);
    },
    catch() { return this; },
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildCallContext, buildSmsThreadContext } = require('../services/estimator-engine/context-builder');

const CALL = (overrides = {}) => ({
  id: 'call-1',
  twilio_call_sid: 'CA-test-1',
  direction: 'inbound',
  from_phone: '+19415550123',
  to_phone: '+19415551111',
  duration_seconds: 120,
  created_at: '2026-07-01T12:00:00.000Z',
  transcription: 'Caller: hi, I would like a quote for quarterly pest control at my home please.',
  customer_id: null,
  ...overrides,
});

beforeEach(() => {
  mockCallRow = null;
  mockCustomersFail = false;
  mockCustomerRows = [];
  mockCustomerFirstRow = undefined;
  mockCustomerFirstFail = false;
  mockLeadRow = null;
  mockEstimateRows = [];
  mockCustomerWhereSql = [];
  delete process.env.GATE_ESTIMATOR_SCOPE_GUARDS;
});

afterAll(() => {
  delete process.env.GATE_ESTIMATOR_SCOPE_GUARDS;
});

test('processor-resolved customer whose load fails ⇒ customer_lookup_unavailable (no phone rematch)', async () => {
  mockCallRow = CALL({ customer_id: 'cust-9' });
  mockCustomersFail = true;

  const context = await buildCallContext('call-1');

  expect(context.error).toBe('customer_lookup_unavailable');
  expect(context.call).toMatchObject({ id: 'call-1' });
  expect(context.customer).toBeUndefined();
});

test('processor-resolved customer whose row is GONE (null, not thrown) also fails closed', async () => {
  // Deleted/stale customer_id: a phone rematch could select another
  // shared-line profile or price the known caller as a prospect.
  mockCallRow = CALL({ customer_id: 'cust-gone' });
  mockCustomerRows = [];

  const context = await buildCallContext('call-1');

  expect(context.error).toBe('customer_lookup_unavailable');
  expect(context.call).toMatchObject({ id: 'call-1' });
});

test('phone lookup that ERRORS ⇒ customer_lookup_unavailable, matching the SMS path', async () => {
  mockCallRow = CALL();
  mockCustomersFail = true;

  const context = await buildCallContext('call-1');

  expect(context.error).toBe('customer_lookup_unavailable');
  expect(context.call).toMatchObject({ id: 'call-1' });
});

test('a healthy lookup still builds full context (regression)', async () => {
  mockCallRow = CALL();
  mockCustomerRows = [{
    id: 'cust-1', first_name: 'Pat', last_name: 'Member', phone: '+19415550123',
    email: null, address_line1: '1 St', city: 'Venice', state: 'FL', zip: '34285',
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', member_since: '2025-01-01',
    lawn_type: null, property_sqft: 1800, lot_sqft: 8000, property_type: 'Single Family',
    company_name: null,
  }];

  const context = await buildCallContext('call-1');

  expect(context.error).toBeUndefined();
  expect(context.customer).toMatchObject({ id: 'cust-1' });
  expect(context.isExistingCustomer).toBe(true);
});

test('a genuine NO-MATCH (empty result, no error) still builds lead context (regression)', async () => {
  mockCallRow = CALL();
  mockCustomerRows = [];

  const context = await buildCallContext('call-1');

  expect(context.error).toBeUndefined();
  expect(context.customer).toBeNull();
  expect(context.isExistingCustomer).toBe(false);
});

describe('buildSmsThreadContext sender lookup (GATE_ESTIMATOR_SCOPE_GUARDS)', () => {
  // A service-contact sender must not lose the customer on the DRAFT
  // context (estimate would persist customer_id null) — but only gate-on:
  // gate-off keeps the primary-phone-only lookup byte-identical.
  const SMS_ARGS = {
    phone: '+19415550123',
    triggerBody: 'can I get a quote for quarterly pest control at my home please?',
  };

  test('gate ON matches the configured service-contact phone slots', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    await buildSmsThreadContext(SMS_ARGS);
    const joined = mockCustomerWhereSql.join('\n');
    expect(joined).toContain('service_contact_phone');
    expect(joined).toContain('service_contact2_phone');
    expect(joined).toContain('service_contact3_phone');
  });

  test('gate OFF keeps the primary-phone-only lookup (dark ship)', async () => {
    await buildSmsThreadContext(SMS_ARGS);
    const joined = mockCustomerWhereSql.join('\n');
    expect(joined).toContain('phone');
    expect(joined).not.toContain('service_contact');
  });

  test('call-path lookups never include contact slots, even gate ON', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCallRow = CALL();
    mockCustomerRows = [];
    await buildCallContext('call-1');
    expect(mockCustomerWhereSql.join('\n')).not.toContain('service_contact');
  });
});

describe('buildSmsThreadContext grounded-customer fallback (GATE_ESTIMATOR_SCOPE_GUARDS)', () => {
  const SMS_ARGS = {
    phone: '+19415550123',
    triggerBody: 'can I get a quote for quarterly pest control at my home please?',
  };
  const GROUNDED_ROW = {
    id: 'cust-77', first_name: 'Pat', last_name: 'Homeowner', phone: '+19415559999',
    email: null, address_line1: '4021 Coral Bay Loop', city: 'Venice', state: 'FL', zip: '34285',
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', member_since: '2025-01-01',
    lawn_type: null, property_sqft: 1800, lot_sqft: 8000, property_type: 'Single Family',
    company_name: null, active: true,
  };

  test('gate ON, no phone match: the triage-grounded customer is loaded by id with a provenance flag', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.error).toBeUndefined();
    expect(context.customer).toMatchObject({ id: 'cust-77' });
    expect(context.customerGroundedByAddress).toBe(true);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate ON: a grounded row failing the real-customer gates is NOT linked', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = { ...GROUNDED_ROW, active: false };
    let context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customer).toBeNull();
    expect(context.customerGroundedByAddress).toBeUndefined();

    mockCustomerFirstRow = { ...GROUNDED_ROW, pipeline_stage: 'new_lead' };
    context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customer).toBeNull();
    expect(context.customerGroundedByAddress).toBeUndefined();
  });

  test('gate ON: a REAL phone-matched customer wins over the grounded id', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...GROUNDED_ROW, id: 'cust-1' }];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customer).toMatchObject({ id: 'cust-1' });
    expect(context.customerGroundedByAddress).toBeUndefined();
  });

  test('gate ON: a webhook-minted PROSPECT phone match loses to the grounded customer', async () => {
    // The Twilio webhook creates an active pipeline_stage='new_lead'
    // customers row for first contacts BEFORE the pipeline runs — that
    // shell must not beat the real customer triage matched by address.
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...GROUNDED_ROW, id: 'prospect-1', pipeline_stage: 'new_lead' }];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customer).toMatchObject({ id: 'cust-77' });
    expect(context.customerGroundedByAddress).toBe(true);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate ON: a prospect phone match with a groundedConflict never grounds', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...GROUNDED_ROW, id: 'prospect-1', pipeline_stage: 'new_lead' }];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77', groundedConflict: true });
    expect(context.customer).toMatchObject({ id: 'prospect-1' });
    expect(context.customerGroundedByAddress).toBeUndefined();
  });

  test('gate OFF: groundedCustomerId is inert (byte-identical legacy path)', async () => {
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customer).toBeNull();
    expect(context.customerGroundedByAddress).toBeUndefined();
    expect(context.isExistingCustomer).toBe(false);
  });

  test('gate ON: a SECONDARY-property scope overrides the profile address and nulls the measurements', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '77 Rental Cove', line2: null, city: 'North Port', zip: '34287', isPrimary: false },
    });
    expect(context.customer).toMatchObject({
      id: 'cust-77',
      address_line1: '77 Rental Cove',
      city: 'North Port',
      zip: '34287',
      // The profile's measurements describe the PRIMARY parcel — nulled so
      // the property-facts lookup gathers the quoted property.
      property_sqft: null,
      lot_sqft: null,
    });
    expect(context.customerGroundedByAddress).toBe(true);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate ON: a unit-carrying scope folds the unit INTO address_line1 (every consumer reads line1)', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '4021 Coral Bay Loop', line2: 'Apt 6', city: 'Venice', zip: '34285', isPrimary: true },
    });
    expect(context.customer).toMatchObject({
      // addressFromContext, the composer profile block, and the
      // saved-address comparison all build from line1 + city + zip and
      // ignore line2 — the unit must live in line1 or they see a unitless
      // street.
      address_line1: '4021 Coral Bay Loop Apt 6',
      address_line2: 'Apt 6',
      property_sqft: null,
      lot_sqft: null,
    });

    // …and the address the downstream comparison actually builds no longer
    // reads as the same parcel as a DIFFERENT unit on that street. Before
    // the fold-in it was unitless, so sameStreetAddress compared equal.
    const { sameStreetAddress } = require('../services/estimator-engine/address-compare');
    const savedAddress = [context.customer.address_line1, context.customer.city, context.customer.zip]
      .filter(Boolean).join(', ');
    expect(savedAddress).toBe('4021 Coral Bay Loop Apt 6, Venice, 34285');
    expect(sameStreetAddress(savedAddress, '4021 Coral Bay Loop Apt 1, Venice, 34285')).toBe(false);
    expect(sameStreetAddress(savedAddress, '4021 Coral Bay Loop Apt 6, Venice, 34285')).toBe(true);
  });

  test('gate ON: a scope address that already carries the unit is not double-suffixed', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '4021 Coral Bay Loop Apt 6', line2: 'Apt 6', city: 'Venice', zip: '34285', isPrimary: true },
    });
    expect(context.customer.address_line1).toBe('4021 Coral Bay Loop Apt 6');
  });

  test('gate ON: a primary scope without a unit keeps the profile as-is', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '4021 Coral Bay Loop', line2: null, city: 'Venice', zip: '34285', isPrimary: true },
    });
    expect(context.customer).toMatchObject({
      address_line1: '4021 Coral Bay Loop',
      property_sqft: 1800,
      lot_sqft: 8000,
    });
    expect(context.customerGroundedByAddress).toBe(true);
  });

  test('gate OFF: groundedScope is inert too', async () => {
    mockCustomerRows = [];
    mockCustomerFirstRow = GROUNDED_ROW;
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '77 Rental Cove', line2: null, city: 'North Port', zip: '34287', isPrimary: false },
    });
    expect(context.customer).toBeNull();
    expect(context.customerGroundedByAddress).toBeUndefined();
  });

  test('gate ON: a REAL phone-matched customer naming their OWN secondary property gets the scope override', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    // Phone match IS the grounded customer (same id) — identity from the
    // phone, but the quoted PROPERTY comes from the scope.
    mockCustomerRows = [{ ...GROUNDED_ROW, id: 'cust-77' }];
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '77 Rental Cove', line2: null, city: 'North Port', zip: '34287', isPrimary: false },
    });
    expect(context.customer).toMatchObject({
      id: 'cust-77',
      address_line1: '77 Rental Cove',
      city: 'North Port',
      zip: '34287',
      property_sqft: null,
      lot_sqft: null,
    });
    // Identity provenance is still the phone — no address-grounding flag.
    expect(context.customerGroundedByAddress).toBeUndefined();
    expect(context.customerPhoneAmbiguous).toBe(false);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate ON: a real phone match with a PRIMARY no-unit scope keeps the profile as-is', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...GROUNDED_ROW, id: 'cust-77' }];
    const context = await buildSmsThreadContext({
      ...SMS_ARGS,
      groundedCustomerId: 'cust-77',
      groundedScope: { address: '4021 Coral Bay Loop', line2: null, city: 'Venice', zip: '34285', isPrimary: true },
    });
    expect(context.customer).toMatchObject({
      address_line1: '4021 Coral Bay Loop',
      property_sqft: 1800,
      lot_sqft: 8000,
    });
  });

  test('gate ON: a TRANSIENT grounded-reload error fails CLOSED (customer_lookup_unavailable)', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstFail = true;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.error).toBe('customer_lookup_unavailable');
    expect(context.customer).toBeUndefined();
  });

  test('gate ON: a genuine grounded no-match still proceeds as a prospect', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = null;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.error).toBeUndefined();
    expect(context.customer).toBeNull();
  });
});

describe('buildSmsThreadContext conflict suppresses phone-scoped history', () => {
  const SMS_ARGS = {
    phone: '+19415550123',
    triggerBody: 'can I get a quote for pest control at 900 Other Property Rd please?',
  };
  const PHONE_MATCHED = {
    id: 'cust-1', first_name: 'Sender', last_name: 'Customer', phone: '+19415550123',
    email: 'a@example.test', address_line1: '1 Primary St', city: 'Venice', state: 'FL', zip: '34285',
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', member_since: '2025-01-01',
    lawn_type: null, property_sqft: 1800, lot_sqft: 8000, property_type: 'Single Family',
    company_name: null, active: true,
  };
  const LEAD = { id: 'lead-1', first_name: 'Sender', phone: '+19415550123', address: '1 Primary St', twilio_call_sid: null };
  const ESTIMATES = [{ id: 'est-1', status: 'sent', monthly_total: 60 }];

  test('gate ON + conflict: no lead, no prior estimates (A\'s history must not shape B\'s draft)', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [PHONE_MATCHED];
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: true });
    expect(context.customerPhoneAmbiguous).toBe(true);
    expect(context.lead).toBeNull();
    expect(context.priorEstimates).toEqual([]);
  });

  test('gate ON, no conflict: lead and prior estimates load as usual', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [PHONE_MATCHED];
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: false });
    expect(context.lead).toMatchObject({ id: 'lead-1' });
    expect(context.priorEstimates).toEqual(ESTIMATES);
  });

  test('gate OFF: the conflict flag never suppresses history (byte-identical)', async () => {
    mockCustomerRows = [PHONE_MATCHED];
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: true });
    expect(context.lead).toMatchObject({ id: 'lead-1' });
    expect(context.priorEstimates).toEqual(ESTIMATES);
  });

  test('gate ON + ADDRESS-GROUNDED (off-file coordinator): the sender\'s own stale history is suppressed', async () => {
    // No phone match at all ⇒ no conflict flag ⇒ the r14 suppression did
    // not fire, yet the coordinator's number can carry ANOTHER client's
    // lead and estimates onto customer B's draft.
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [];
    mockCustomerFirstRow = { ...PHONE_MATCHED, id: 'cust-77' };
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customerGroundedByAddress).toBe(true);
    expect(context.customer).toMatchObject({ id: 'cust-77' });
    expect(context.lead).toBeNull();
    expect(context.priorEstimates).toEqual([]);
    // The thread itself is the conversation being answered — it stays.
    expect(context.transcript.length).toBeGreaterThan(0);
  });

  test('gate ON: a REAL phone-matched customer keeps their own phone-scoped history', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [PHONE_MATCHED];
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-1' });
    expect(context.customerGroundedByAddress).toBeUndefined();
    expect(context.lead).toMatchObject({ id: 'lead-1' });
    expect(context.priorEstimates).toEqual(ESTIMATES);
  });

  test('gate OFF: an address-grounded id never suppresses history either', async () => {
    mockCustomerRows = [];
    mockCustomerFirstRow = { ...PHONE_MATCHED, id: 'cust-77' };
    mockLeadRow = LEAD;
    mockEstimateRows = ESTIMATES;
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedCustomerId: 'cust-77' });
    expect(context.customerGroundedByAddress).toBeUndefined();
    expect(context.lead).toMatchObject({ id: 'lead-1' });
    expect(context.priorEstimates).toEqual(ESTIMATES);
  });
});

describe('buildSmsThreadContext distinct-customer conflict (GATE_ESTIMATOR_SCOPE_GUARDS)', () => {
  const SMS_ARGS = {
    phone: '+19415550123',
    triggerBody: 'can I get a quote for pest control at 900 Other Property Rd please?',
  };
  const PHONE_MATCHED = {
    id: 'cust-1', first_name: 'Sender', last_name: 'Customer', phone: '+19415550123',
    email: 'a@example.test', address_line1: '1 Primary St', city: 'Venice', state: 'FL', zip: '34285',
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', member_since: '2025-01-01',
    lawn_type: null, property_sqft: 1800, lot_sqft: 8000, property_type: 'Single Family',
    company_name: null, active: true,
  };

  test('gate ON + conflict: phone-matched customer downgrades to the ambiguous (name-only) posture', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [PHONE_MATCHED];
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: true });
    // The profile stays for the composer's name-only rendering, but the
    // ambiguity flag blocks customer_id, address, and membership context.
    expect(context.customer).toMatchObject({ id: 'cust-1' });
    expect(context.customerPhoneAmbiguous).toBe(true);
    expect(context.isExistingCustomer).toBe(false);
  });

  test('gate ON, no conflict: the phone-matched customer keeps full trust', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [PHONE_MATCHED];
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: false });
    expect(context.customerPhoneAmbiguous).toBe(false);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate OFF: the conflict flag is inert (byte-identical legacy path)', async () => {
    mockCustomerRows = [PHONE_MATCHED];
    const context = await buildSmsThreadContext({ ...SMS_ARGS, groundedConflict: true });
    expect(context.customerPhoneAmbiguous).toBe(false);
    expect(context.isExistingCustomer).toBe(true);
  });
});

describe('buildSmsThreadContext isExistingCustomer requires active (gate on)', () => {
  const SMS_ARGS = {
    phone: '+19415550123',
    triggerBody: 'can I get a quote for quarterly pest control at my home please?',
  };
  const ROW = {
    id: 'cust-1', first_name: 'Former', last_name: 'Customer', phone: '+19415550123',
    email: null, address_line1: '1 St', city: 'Venice', state: 'FL', zip: '34285',
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', member_since: '2025-01-01',
    lawn_type: null, property_sqft: 1800, lot_sqft: 8000, property_type: 'Single Family',
    company_name: null,
  };

  test('gate ON: inactive former customer keeps the profile but is NOT an existing customer', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...ROW, active: false }];
    const context = await buildSmsThreadContext(SMS_ARGS);
    expect(context.customer).toMatchObject({ id: 'cust-1' });
    expect(context.isExistingCustomer).toBe(false);
  });

  test('gate ON: an active established customer still is', async () => {
    process.env.GATE_ESTIMATOR_SCOPE_GUARDS = 'true';
    mockCustomerRows = [{ ...ROW, active: true }];
    const context = await buildSmsThreadContext(SMS_ARGS);
    expect(context.isExistingCustomer).toBe(true);
  });

  test('gate OFF: the legacy stage-only predicate is unchanged', async () => {
    mockCustomerRows = [{ ...ROW, active: false }];
    const context = await buildSmsThreadContext(SMS_ARGS);
    expect(context.isExistingCustomer).toBe(true);
  });
});
