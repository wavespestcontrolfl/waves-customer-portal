/**
 * 07-19 admin audit (P1-1, tool scope): the customer-reading tech tools take a
 * customer_id/name straight from the caller. Without an ownership check a
 * technician could POST /execute with ANOTHER customer's id and read their
 * address, CRM notes, and gate/lockbox codes. get_stop_details,
 * get_service_history, and check_customer_status now require the customer to be
 * on the authenticated technician's route (a scheduled_service assigned to
 * them); admins (no techId) stay unrestricted.
 */

const state = { customers: [], scheduled_services: [], property_preferences: [], service_records: [], invoices: [] };

jest.mock('../models/db', () => {
  function query(table) {
    const preds = [];
    const api = {
      where(a, op, val) {
        if (typeof a === 'function') return api; // name-search callback: unused in these tests
        if (typeof a === 'object') {
          Object.entries(a).forEach(([k, v]) => preds.push((r) => r[k] === v));
        } else if (val === undefined) {
          preds.push((r) => r[a] === op); // where(col, value)
        } else if (op === '>=') {
          preds.push((r) => r[a] >= val);
        } else if (op === '<=') {
          preds.push((r) => r[a] <= val);
        } else {
          preds.push((r) => r[a] === val);
        }
        return api;
      },
      whereNotIn(col, arr) { preds.push((r) => !arr.includes(r[col])); return api; },
      whereIn(col, arr) { preds.push((r) => arr.includes(r[col])); return api; },
      whereILike() { return api; },
      whereRaw() { return api; },
      orderBy() { return api; },
      orderByRaw() { return api; },
      distinct() { return api; },
      limit() { return api; },
      leftJoin() { return api; },
      select() { return api; },
      first() {
        const match = (state[table] || []).find((r) => preds.every((p) => p(r)));
        return Promise.resolve(match ? { ...match } : undefined);
      },
      then(resolve) { return Promise.resolve((state[table] || []).filter((r) => preds.every((p) => p(r)))).then(resolve); },
    };
    return api;
  }
  const db = (table) => query(table);
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const { etDateString, addETDays } = require('../utils/datetime-et');
const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

const today = () => etDateString(new Date());
const daysAgo = (n) => etDateString(addETDays(new Date(), -n));

// The customer-name field each tool returns on a successful read — used to
// assert the happy path actually executed (not merely "didn't say not-found").
const RESULT_NAME = {
  get_stop_details: (r) => r.customer?.name,
  get_service_history: (r) => r.customer,
  check_customer_status: (r) => r.name,
};

beforeEach(() => {
  state.customers = [
    { id: 'cust-mine', first_name: 'Mine', last_name: 'Customer' },
    { id: 'cust-theirs', first_name: 'Their', last_name: 'Customer' },
    { id: 'cust-stale', first_name: 'Stale', last_name: 'Customer' },
    { id: 'cust-cancelled', first_name: 'Cancelled', last_name: 'Customer' },
  ];
  state.scheduled_services = [
    { id: 'svc-1', customer_id: 'cust-mine', technician_id: 'tech-1', status: 'scheduled', scheduled_date: today() },
    { id: 'svc-2', customer_id: 'cust-theirs', technician_id: 'tech-2', status: 'scheduled', scheduled_date: today() },
    // Assigned to tech-1 but 45 days old — outside the ET access window.
    { id: 'svc-3', customer_id: 'cust-stale', technician_id: 'tech-1', status: 'completed', scheduled_date: daysAgo(45) },
    // Assigned to tech-1 today but cancelled — a dead status.
    { id: 'svc-4', customer_id: 'cust-cancelled', technician_id: 'tech-1', status: 'cancelled', scheduled_date: today() },
  ];
  state.property_preferences = [{ customer_id: 'cust-mine' }];
  state.service_records = [];
  state.invoices = [];
});

describe.each([
  ['get_stop_details'],
  ['get_service_history'],
  ['check_customer_status'],
])('%s technician scope', (tool) => {
  test('another tech\'s customer returns a generic not-found (no existence oracle)', async () => {
    const r = await executeTechTool(tool, { customer_id: 'cust-theirs' }, { techId: 'tech-1' });
    expect(r).toEqual({ error: 'Customer not found' });
  });

  test('a stale (outside 7-day window) assignment does not authorize', async () => {
    const r = await executeTechTool(tool, { customer_id: 'cust-stale' }, { techId: 'tech-1' });
    expect(r).toEqual({ error: 'Customer not found' });
  });

  test('a cancelled assignment does not authorize', async () => {
    const r = await executeTechTool(tool, { customer_id: 'cust-cancelled' }, { techId: 'tech-1' });
    expect(r).toEqual({ error: 'Customer not found' });
  });

  test('a current assignment reaches their own customer and the tool executes', async () => {
    const r = await executeTechTool(tool, { customer_id: 'cust-mine' }, { techId: 'tech-1' });
    expect(r.error).toBeUndefined();
    expect(RESULT_NAME[tool](r)).toBe('Mine Customer');
  });

  test('an admin (no techId) is unrestricted and the tool executes', async () => {
    const r = await executeTechTool(tool, { customer_id: 'cust-theirs' }, {});
    expect(r.error).toBeUndefined();
    expect(RESULT_NAME[tool](r)).toBe('Their Customer');
  });

  test('a name search resolves the ASSIGNED customer in SQL, not the first row (P1)', async () => {
    // An unassigned customer sorts ahead of the assigned one; the whereIn scope
    // must resolve the technician's customer, not miss it.
    state.customers = [
      { id: 'cust-theirs', first_name: 'Pat', last_name: 'Customer' }, // unassigned, first
      { id: 'cust-mine', first_name: 'Pat', last_name: 'Customer' }, // assigned to tech-1
    ];
    const r = await executeTechTool(tool, { customer_name: 'Pat Customer' }, { techId: 'tech-1' });
    expect(r.error).toBeUndefined();
    expect(RESULT_NAME[tool](r)).toBe('Pat Customer');
  });
});
