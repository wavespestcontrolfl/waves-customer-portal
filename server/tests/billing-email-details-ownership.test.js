/**
 * Billing email details: every visit / completion record / saved property read
 * goes through ONE ownership-checked path that carries the owning customer id.
 * A stamped pointer that names ANOTHER customer's row reads as "not linked".
 *
 * The db mock applies the `where({...})` object filters to its rows, so a query
 * that forgets the customer id returns the foreign row and these tests fail.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Details = require('../services/billing-email-details');

function mockTables(tables) {
  db.mockImplementation((table) => {
    let rows = tables[table] || [];
    const q = {};
    q.where = jest.fn((cond) => {
      if (cond && typeof cond === 'object') {
        rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      }
      return q;
    });
    ['whereIn', 'whereRaw', 'orderBy', 'join', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => rows[0]);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  });
}

const HOME = { address_line1: '100 Home Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
const stamped = (customerId, line1) => ({
  id: 'ss-1', customer_id: customerId, service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-18',
  service_address_line1: line1, service_address_line2: null, service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34236',
});

describe('invoice property: the visit must belong to the invoice customer', () => {
  test('the customer\'s own stamped visit address is used', async () => {
    mockTables({ scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME))
      .toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('a scheduled_service_id naming ANOTHER customer\'s visit is ignored: falls back to the customer\'s address', async () => {
    mockTables({ scheduled_services: [stamped('someone-else', '9 Foreign Road')] });
    const out = await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME);
    expect(out).toBe('100 Home Lane, Bradenton, FL 34205');
    expect(out).not.toContain('Foreign');
  });

  test('a service record naming another customer\'s visit is ignored too', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('someone-else', '9 Foreign Road')],
    });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', service_record_id: 'sr-1' }, HOME))
      .toBe('100 Home Lane, Bradenton, FL 34205');
  });

  test('another customer\'s service record never supplies a visit', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'someone-else', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', service_record_id: 'sr-1' }, HOME))
      .toBe('100 Home Lane, Bradenton, FL 34205');
  });

  test('a FAILED lookup still omits the Property row (not the primary address)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME)).toBe('');
  });
});

describe('invoice service and date: the visit / record must belong to the invoice customer', () => {
  test('a foreign visit supplies neither service type nor date', async () => {
    mockTables({ scheduled_services: [stamped('someone-else', '9 Foreign Road')] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_type: null, service_date: null, title: 'Lawn Care Visit — August 2026',
    })).toEqual({ label: 'Lawn Care Visit', date: '' });
  });

  test('a foreign completion record supplies neither service type nor date', async () => {
    mockTables({ service_records: [{ id: 'sr-1', customer_id: 'someone-else', service_type: 'Rodent Trapping', service_date: '2026-09-11' }] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', service_record_id: 'sr-1', service_type: null, service_date: null,
    })).toEqual({ label: '', date: '' });
  });

  test('the customer\'s own visit still supplies both', async () => {
    mockTables({ scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_type: null, service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 18, 2026' });
  });
});

describe('invoice service date precedence: the completion record\'s date beats the scheduled date', () => {
  test('invoice has a service but no date; the visit HAS a service type: the record\'s date still wins', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', service_type: 'Quarterly Pest Control', service_date: '2026-09-20' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control', service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 20, 2026' });
  });

  test('no service and no date: visit label, record date', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', service_type: 'Other', service_date: '2026-09-20' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: null, service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 20, 2026' });
  });
});

describe('estimate follow-up property: the saved property must belong to the estimate customer', () => {
  test('the customer\'s own property is used', async () => {
    mockTables({
      customer_properties: [{ id: 'p-1', customer_id: 'c', address_line1: '77 Saved Street', city: 'Parrish', state: 'FL', zip: '34219' }],
      customers: [{ id: 'c', ...HOME }],
    });
    expect(await Details.customerPropertyAddress('c', 'p-1')).toBe('77 Saved Street, Parrish, FL 34219');
  });

  test('another customer\'s property_id falls back to the estimate customer\'s own address', async () => {
    mockTables({
      customer_properties: [{ id: 'p-1', customer_id: 'someone-else', address_line1: '9 Foreign Road', city: 'Tampa', state: 'FL', zip: '33601' }],
      customers: [{ id: 'c', ...HOME }],
    });
    const out = await Details.customerPropertyAddress('c', 'p-1');
    expect(out).toBe('100 Home Lane, Bradenton, FL 34205');
    expect(out).not.toContain('Foreign');
  });

  test('a property with no customer to check it against is never read', async () => {
    mockTables({ customer_properties: [{ id: 'p-1', customer_id: 'someone-else', address_line1: '9 Foreign Road', city: 'Tampa', state: 'FL', zip: '33601' }] });
    expect(await Details.customerPropertyAddress(null, 'p-1')).toBe('');
  });
});
