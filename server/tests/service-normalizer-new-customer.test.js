/**
 * isNewCustomer — the schedule view's "New customer — first visit" verdict.
 * Owner 2026-11-02: an annual prepay customer's done quarterly visit had no
 * service record behind it, so her next visit read as a first visit. A
 * completed visit on the schedule now counts as history too.
 */
const { isNewCustomer, hasCompletedVisit } = require('../utils/service-normalizer');

// Minimal knex fake: service_records answers a count, scheduled_services a
// first() row; each table records the where() it was given.
function fakeDb({ completedRecords = 0, completedVisit = null } = {}) {
  const calls = [];
  const db = (table) => {
    const rec = { table, where: null };
    calls.push(rec);
    const b = {
      where: (w) => { rec.where = w; return b; },
      count: () => b,
      first: async () => (table === 'service_records' ? { cnt: String(completedRecords) } : completedVisit),
    };
    return b;
  };
  db.calls = calls;
  return db;
}

describe('isNewCustomer', () => {
  test('no completed record and no completed visit is a new customer', async () => {
    expect(await isNewCustomer(fakeDb(), 'cust-1')).toBe(true);
  });

  test('a completed visit with no service record is not a new customer', async () => {
    const db = fakeDb({ completedVisit: { id: 'svc-done' } });
    expect(await isNewCustomer(db, 'cust-1')).toBe(false);
    expect(db.calls.find((c) => c.table === 'scheduled_services').where).toEqual({ customer_id: 'cust-1', status: 'completed' });
  });

  test('a completed service record answers without reading the schedule', async () => {
    const db = fakeDb({ completedRecords: 2 });
    expect(await isNewCustomer(db, 'cust-1')).toBe(false);
    expect(db.calls.map((c) => c.table)).toEqual(['service_records']);
  });

  test('no customer id stays a new customer, and has no completed visit', async () => {
    expect(await isNewCustomer(fakeDb({ completedVisit: { id: 'x' } }), null)).toBe(true);
    expect(await hasCompletedVisit(fakeDb({ completedVisit: { id: 'x' } }), null)).toBe(false);
  });
});
