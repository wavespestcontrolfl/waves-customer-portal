// whereEstimateOnCustomerRecord (owner 2026-10-03): the estimates a customer's
// record lists are the ones the customer owns plus an estimate nobody owns
// whose typed phone is the customer's own. A read rule only. The first block
// pins the query shape without a database; the second runs it on Postgres
// (CI). All identities are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const knexLib = require('knex');

describe('whereEstimateOnCustomerRecord — query shape', () => {
  const { whereEstimateOnCustomerRecord } = require('../services/call-commitments');
  const builder = knexLib({ client: 'pg' });
  const sqlFor = (customer) => whereEstimateOnCustomerRecord(builder('estimates'), customer).toSQL();
  const ID = '11111111-1111-4111-8111-111111111111';

  test('a customer with a usable phone gets the owned arm and the unowned-phone arm, keyed on the phone identity', () => {
    const { sql, bindings } = sqlFor({ id: ID, phone: '(941) 555-0142' });
    expect(sql).toContain('estimates.customer_id = ?');
    expect(sql).toMatch(/COALESCE\(estimates\.customer_id,[\s\S]*IS NULL AND[\s\S]*estimates\.customer_phone/);
    expect(bindings[bindings.length - 1]).toBe('9415550142');
  });

  test('no phone, an incomplete phone or a carrier placeholder ties nothing: owned estimates only', () => {
    for (const phone of [null, '', '555-0142', 'anonymous', '+17378742833']) {
      const { sql, bindings } = sqlFor({ id: ID, phone });
      expect(sql).not.toContain('customer_phone');
      expect(bindings.every((b) => b === ID)).toBe(true);
    }
  });

  test('a number from another country keeps its country code in the key', () => {
    const { bindings } = sqlFor({ id: ID, phone: '+449415550142' });
    expect(bindings[bindings.length - 1]).toBe('+449415550142');
  });
});

const maybeDescribe = process.env.DATABASE_URL ? describe : describe.skip;

maybeDescribe('whereEstimateOnCustomerRecord (live Postgres)', () => {
  let db;
  let whereEstimateOnCustomerRecord;
  const made = { leads: [], estimates: [], customers: [] };
  beforeAll(() => {
    db = require('../models/db');
    ({ whereEstimateOnCustomerRecord } = require('../services/call-commitments'));
  });
  afterAll(async () => {
    for (const table of ['leads', 'estimates', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  });
  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };

  test('lists owned, lead-owned and unowned same-phone estimates; never another customer\'s, another lead owner\'s or a shared-suffix foreign number', async () => {
    const customer = await insert('customers', { first_name: 'Record', phone: '+15555557201' });
    const other = await insert('customers', { first_name: 'Other', phone: '+15555557202' });
    const est = (row) => insert('estimates', { status: 'sent', ...row });
    const owned = await est({ customer_id: customer.id });
    const byPhone = await est({ customer_phone: '(555) 555-7201' });
    const leadOwned = await est({ customer_phone: '+15555557299' });
    await insert('leads', { first_name: 'Record', phone: '+15555557299', status: 'estimate_sent', customer_id: customer.id, estimate_id: leadOwned.id });
    // Same typed phone, but the estimate belongs to someone else.
    const othersLinked = await est({ customer_id: other.id, customer_phone: '+15555557201' });
    const othersLead = await est({ customer_phone: '+15555557201' });
    await insert('leads', { first_name: 'Other', phone: '+15555557201', status: 'estimate_sent', customer_id: other.id, estimate_id: othersLead.id });
    const foreign = await est({ customer_phone: '+445555557201' });
    const stranger = await est({ customer_phone: '+15555557203' });

    const ids = (await whereEstimateOnCustomerRecord(db('estimates'), customer).select('id')).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([owned.id, byPhone.id, leadOwned.id]));
    for (const excluded of [othersLinked, othersLead, foreign, stranger]) expect(ids).not.toContain(excluded.id);
    expect(ids).toHaveLength(3);
  });
});
