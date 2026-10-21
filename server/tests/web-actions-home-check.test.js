/**
 * GATE_REPORT_WEB_ACTIONS: the photo answer says "your plan covers this" only for a visit
 * PROVABLY at the customer's primary home (shared visit-scope chain, unit-aware).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { visitIsAtPrimaryHome } = require('../services/service-report/web-actions');

// Minimal knex stand-in: one array of rows per table; where() filters by equality.
function fakeDb(tables = {}, { failOn = null } = {}) {
  return (table) => {
    let filters = {};
    const rows = () => (tables[table] || []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    const q = {
      where(cond) { filters = { ...filters, ...cond }; return q; },
      first() {
        if (failOn === table) return Promise.reject(new Error('lookup failed'));
        return Promise.resolve(rows()[0]);
      },
      select() { return Promise.resolve(rows()); },
      distinct() { return Promise.resolve(rows()); },
      columnInfo() { return Promise.resolve({ service_address_line1: {}, service_address_line2: {}, service_address_city: {}, service_address_zip: {}, property_id: {}, source_estimate_id: {} }); },
    };
    return q;
  };
}

const HOME = { cust_address_line1: '12 Palm Way', cust_address_line2: null, cust_city: 'Bradenton', cust_zip: '34205', customer_id: 'c1' };
const stamp = (line1, line2 = null) => ({ service_address_line1: line1, service_address_line2: line2, service_address_city: 'Bradenton', service_address_zip: '34205' });

describe('visitIsAtPrimaryHome', () => {
  test('a visit stamped at the home is at home', async () => {
    await expect(visitIsAtPrimaryHome({ ...HOME, ...stamp('12 Palm Way') }, fakeDb())).resolves.toBe(true);
  });

  test('a different unit at the same street address is not the home', async () => {
    const home = { ...HOME, cust_address_line2: 'Unit 4' };
    await expect(visitIsAtPrimaryHome({ ...home, ...stamp('12 Palm Way', 'Unit 4') }, fakeDb())).resolves.toBe(true);
    await expect(visitIsAtPrimaryHome({ ...home, ...stamp('12 Palm Way', 'Unit 9') }, fakeDb())).resolves.toBe(false);
  });

  test('another street is not the home', async () => {
    await expect(visitIsAtPrimaryHome({ ...HOME, ...stamp('90 Other Rd') }, fakeDb())).resolves.toBe(false);
  });

  test('an unstamped visit linked to a secondary property is not the home; linked to the home property it is', async () => {
    const db = fakeDb({
      customer_properties: [
        { id: 'p-home', address_line1: '12 Palm Way', address_line2: null, city: 'Bradenton', zip: '34205' },
        { id: 'p-rental', address_line1: '55 Beach Dr', address_line2: null, city: 'Bradenton', zip: '34205' },
      ],
    });
    await expect(visitIsAtPrimaryHome({ ...HOME, property_id: 'p-rental' }, db)).resolves.toBe(false);
    await expect(visitIsAtPrimaryHome({ ...HOME, property_id: 'p-home' }, db)).resolves.toBe(true);
  });

  test('a visit created from an estimate for another address is not the home', async () => {
    const db = fakeDb({ estimates: [{ id: 'e1', address: '77 Elm St, Bradenton, FL 34205' }] });
    await expect(visitIsAtPrimaryHome({ ...HOME, source_estimate_id: 'e1' }, db)).resolves.toBe(false);
  });

  test('unprovable: a link that resolves to nothing, or a failed read, withholds coverage', async () => {
    await expect(visitIsAtPrimaryHome({ ...HOME, property_id: 'gone' }, fakeDb({ customer_properties: [] }))).resolves.toBe(false);
    await expect(visitIsAtPrimaryHome({ ...HOME, property_id: 'p1' }, fakeDb({ customer_properties: [{ id: 'p1' }] }, { failOn: 'customer_properties' }))).resolves.toBe(false);
  });

  test('unprovable: no evidence on the visit and a multi-home account, or no customer address', async () => {
    const multi = fakeDb({ customers: [{ id: 'c1', has_multi_home: true }] });
    await expect(visitIsAtPrimaryHome({ ...HOME }, multi)).resolves.toBe(false);
    const two = fakeDb({
      customers: [{ id: 'c1', has_multi_home: false }],
      customer_properties: [
        { customer_id: 'c1', address_line1: '12 Palm Way', city: 'Bradenton', zip: '34205' },
        { customer_id: 'c1', address_line1: '55 Beach Dr', city: 'Bradenton', zip: '34205' },
      ],
    });
    await expect(visitIsAtPrimaryHome({ ...HOME }, two)).resolves.toBe(false);
    await expect(visitIsAtPrimaryHome({ customer_id: 'c1', ...stamp('12 Palm Way') }, fakeDb())).resolves.toBe(false);
  });

  test('no evidence on the visit but a proven single-premises account is at home', async () => {
    const single = fakeDb({ customers: [{ id: 'c1', has_multi_home: false }], customer_properties: [], scheduled_services: [] });
    await expect(visitIsAtPrimaryHome({ ...HOME }, single)).resolves.toBe(true);
  });
});
