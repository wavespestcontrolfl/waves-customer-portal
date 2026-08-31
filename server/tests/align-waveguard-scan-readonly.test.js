/**
 * scanAlignment() — the shared scan pass behind the CLI and the daily
 * lead-to-cash sweep. Without `onRepair` it must be READ-ONLY: no update, no
 * transaction, no activity_log insert, regardless of what the analysis finds.
 */
const mockDbCalls = [];
jest.mock('../models/db', () => {
  const rows = { customers: [], scheduled_services: [] };
  const mk = (table) => {
    const b = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereRaw', 'whereRaw', 'whereExists', 'leftJoin', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate']) {
      b[m] = jest.fn(() => b);
    }
    b.columnInfo = jest.fn(async () => ({ active: {}, pipeline_stage: {}, waveguard_tier: {}, monthly_rate: {}, member_since: {}, billing_mode: {}, waveguard_tier_source: {} }));
    b.update = jest.fn(() => { mockDbCalls.push(`update:${table}`); return b; });
    b.insert = jest.fn(() => { mockDbCalls.push(`insert:${table}`); return b; });
    b.first = jest.fn(async () => null);
    b.then = (res, rej) => Promise.resolve(rows[String(table).split(' ')[0]] || []).then(res, rej);
    return b;
  };
  const db = jest.fn((table) => { mockDbCalls.push(`from:${String(table).split(' ')[0]}`); return mk(table); });
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(() => { mockDbCalls.push('transaction'); throw new Error('must not open a transaction'); });
  db.schema = { hasTable: jest.fn(async () => true) };
  db.__rows = rows;
  return db;
});
jest.mock('../services/plan-rate-ledger', () => ({ seedLedgerComponents: jest.fn() }));

const db = require('../models/db');
const { scanAlignment, optionsFromArgs } = require('../scripts/align-waveguard-portal-records');

beforeEach(() => { mockDbCalls.length = 0; });

test('optionsFromArgs defaults are the read-only, members-only pass', () => {
  expect(optionsFromArgs({})).toEqual({ limit: null, customerId: null, includeInactive: false, enrollNoPlan: false });
  expect(optionsFromArgs({ limit: '5', 'customer-id': 'c1', 'include-inactive': true, 'enroll-no-plan': 'true' }))
    .toEqual({ limit: 5, customerId: 'c1', includeInactive: true, enrollNoPlan: true });
});

test('scanAlignment({}) reads candidates and returns the summary shape with zero writes', async () => {
  const out = await scanAlignment({});
  expect(out).toEqual({ checkedCustomers: 0, repairs: [], noPlanEnrollments: 0, noServiceEvidence: [], tierMismatches: [] });
  expect(mockDbCalls.filter((c) => c.startsWith('update:') || c.startsWith('insert:') || c === 'transaction')).toEqual([]);
  expect(mockDbCalls).toContain('from:customers');
});

test('a found repair is reported but NOT applied when no onRepair is passed; onRepair receives it when passed', async () => {
  db.__rows.customers = [{ id: 'm1', waveguard_tier: 'Bronze', monthly_rate: 0, billing_mode: 'monthly_membership', active: true, pipeline_stage: 'active_customer', member_since: '2026-01-01', created_at: new Date('2026-01-01T12:00:00Z') }];
  db.__rows.scheduled_services = [
    { id: 's1', customer_id: 'm1', status: 'scheduled', scheduled_date: new Date('2026-01-10T00:00:00Z'), service_type: 'General Pest Control', is_recurring: true, recurring_ongoing: true },
  ];
  const readOnly = await scanAlignment({});
  expect(readOnly.checkedCustomers).toBe(1);
  expect(readOnly.repairs).toHaveLength(1);
  expect(readOnly.repairs[0]).toMatchObject({ customerId: 'm1', customerUpdates: expect.objectContaining({ monthly_rate: expect.any(Number) }) });
  expect(mockDbCalls.filter((c) => c.startsWith('update:') || c.startsWith('insert:') || c === 'transaction')).toEqual([]);

  const onRepair = jest.fn(async () => {});
  const withHook = await scanAlignment({ onRepair });
  expect(onRepair).toHaveBeenCalledTimes(1);
  expect(onRepair.mock.calls[0][0].customer.id).toBe('m1');
  expect(withHook.repairs).toHaveLength(1);
});
