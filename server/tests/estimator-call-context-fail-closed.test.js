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

jest.mock('../models/db', () => {
  const db = (table) => ({
    select() { return this; },
    where() { return this; },
    whereRaw() { return this; },
    whereNull() { return this; },
    orderBy() { return this; },
    limit() { return this; },
    async first() {
      if (table === 'call_log') return mockCallRow;
      if (table === 'customers') {
        if (mockCustomersFail) throw new Error('db down');
        return mockCustomerRows[0] || null;
      }
      return null;
    },
    then(resolve, reject) {
      if (table === 'customers' && mockCustomersFail) {
        return Promise.reject(new Error('db down')).then(resolve, reject);
      }
      if (table === 'customers') return Promise.resolve(mockCustomerRows).then(resolve, reject);
      return Promise.resolve([]).then(resolve, reject);
    },
    catch() { return this; },
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildCallContext } = require('../services/estimator-engine/context-builder');

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
