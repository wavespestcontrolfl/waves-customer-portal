/**
 * customer-properties.anchorSoleProperty — the write-time half of the
 * sole-property anchor (the 20260903000050 backfill is the other half).
 * Pins the rule and that every spawned-row writer calls it.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => ({}), { virtual: false });
const { anchorSoleProperty } = require('../services/customer-properties');

const COLS = { property_id: true, service_address_line1: true };

function fakeConn(propertiesByCustomer) {
  return (table) => {
    if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
    const q = { _f: null, _l: null };
    q.where = (f) => { q._f = f; return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.select = async () => (propertiesByCustomer[q._f.customer_id] || [])
      .filter((p) => p.active === q._f.active).slice(0, q._l).map((p) => ({ id: p.id }));
    return q;
  };
}

describe('anchorSoleProperty', () => {
  const conn = fakeConn({
    'c-sole': [{ id: 'p1', active: true }, { id: 'p-old', active: false }],
    'c-multi': [{ id: 'p1', active: true }, { id: 'p2', active: true }],
  });

  test('stamps the sole active property on an unstamped row with none', async () => {
    const row = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('p1');
  });

  test('never overrides an explicit stamp', async () => {
    const row = { customer_id: 'c-sole', property_id: 'p-explicit' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('p-explicit');
  });

  test('leaves a row with a stamped service address alone (may be an unregistered address)', async () => {
    const row = { customer_id: 'c-sole', property_id: null, service_address_line1: '9 Elsewhere Rd' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBeNull();
  });

  test('two active properties → null (office places it)', async () => {
    const row = { customer_id: 'c-multi', property_id: null };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBeNull();
  });

  test('cols-guarded: no property_id column → untouched', async () => {
    const row = { customer_id: 'c-sole' };
    await anchorSoleProperty(row, { service_address_line1: true }, conn);
    expect(row.property_id).toBeUndefined();
    await anchorSoleProperty(row, null, conn);
    expect(row.property_id).toBeUndefined();
  });

  test('best-effort: a failing lookup yields null, never throws', async () => {
    const row = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row, COLS, () => { throw new Error('boom'); });
    expect(row.property_id).toBeNull();
  });
});

describe('every spawned-row writer anchors the sole property', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('the recurring seeder resolves the anchor on the parent copy the children are built from', () => {
    const src = read('services/recurring-appointment-seeder.js');
    const i = src.indexOf("anchorSoleProperty(anchoredParent, columns, conn)");
    const j = src.indexOf('buildRecurringFollowUpRows(anchoredParent, {');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  test('every admin-schedule stamp copy on a spawned row is followed by the anchor', () => {
    const src = read('routes/admin-schedule.js');
    const copies = src.match(/copyStampedServiceAddressFields\((\w+), parent, cols\);\n\s*await anchorSoleProperty\(\1, cols, (trx|conn)\);/g) || [];
    const allCopies = src.match(/copyStampedServiceAddressFields\(\w+, parent, cols\);/g) || [];
    expect(allCopies.length).toBeGreaterThan(0);
    expect(copies.length).toBe(allCopies.length);
  });
});
