// Commit side of an Intelligence Bar monthly-rate edit (owner 2026-10-06): the
// card named the one bill line that changes and pinned the bill it was built
// from. At commit the bill must be unchanged, then only that line moves.
jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.whereNull = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.first = jest.fn();
  qb.select = jest.fn(() => Promise.resolve([]));
  qb.update = jest.fn(() => Promise.resolve(1));
  const db = jest.fn(() => qb);
  db.transaction = jest.fn(async (cb) => cb(db));
  db.raw = jest.fn(() => Promise.resolve());
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadComponents = jest.fn();
const mockSetLine = jest.fn(async () => undefined);
const mockSyncScalar = jest.fn(async () => undefined);
jest.mock('../services/plan-rate-ledger', () => {
  const actual = jest.requireActual('../services/plan-rate-ledger');
  return {
    ...actual,
    loadComponents: (...a) => mockLoadComponents(...a),
    setLineForScalarWrite: (...a) => mockSetLine(...a),
    syncScalarWriteToLedger: (...a) => mockSyncScalar(...a),
  };
});

const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');
const { ledgerPin } = require('../services/intelligence-bar/rate-change');

const CUSTOMER_ID = 'cust-1';
const row = { id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Sample', monthly_rate: '41.33', waveguard_tier: 'Bronze', billing_mode: 'monthly_membership' };
const pest = [{ family_key: 'pest_control', monthly_rate: '41.33' }];

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.__qb.first.mockResolvedValue({ ...row });
  mockLoadComponents.mockResolvedValue(pest);
});

test('an unchanged bill moves only the named line', async () => {
  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID, updates: { monthly_rate: 102.66 },
    _rate_family: 'lawn_care', _rate_ledger_pin: ledgerPin(pest, '41.33'),
  });
  expect(result.error).toBeUndefined();
  expect(mockSetLine).toHaveBeenCalledWith(db, CUSTOMER_ID,
    { familyKey: 'lawn_care', previousScalar: '41.33', newScalar: 102.66 }, { source: 'ib_update' });
  expect(mockSyncScalar).not.toHaveBeenCalled();
});

test('a bill that changed since the card refuses as preview_changed and writes no line', async () => {
  mockLoadComponents.mockResolvedValue([{ family_key: 'pest_control', monthly_rate: '45.00' }]);
  const result = await executeTool('update_customer', {
    customer_id: CUSTOMER_ID, updates: { monthly_rate: 102.66 },
    _rate_family: 'lawn_care', _rate_ledger_pin: ledgerPin(pest, '41.33'),
  });
  expect(result.preview_changed).toBe(true);
  expect(result.error).toMatch(/monthly bill changed/);
  expect(mockSetLine).not.toHaveBeenCalled();
});

test('whole_bill keeps the one-line reset, and so does a card with no rate pin', async () => {
  await executeTool('update_customer', {
    customer_id: CUSTOMER_ID, updates: { monthly_rate: 60.33 },
    _rate_family: 'whole_bill', _rate_ledger_pin: ledgerPin(pest, '41.33'),
  });
  await executeTool('update_customer', { customer_id: CUSTOMER_ID, updates: { monthly_rate: 60.33 } });
  expect(mockSyncScalar).toHaveBeenCalledTimes(2);
  expect(mockSetLine).not.toHaveBeenCalled();
});

test('bulk rate: a customer who has a bill by commit time is skipped and reported, never overwritten', async () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  db.__qb.select.mockResolvedValue([
    { id: A, first_name: 'Ann', last_name: 'Sample', monthly_rate: '41.33' },
    { id: B, first_name: 'Bo', last_name: 'Sample', monthly_rate: '0' },
  ]);
  const result = await executeTool('bulk_update_customers', { customer_ids: [A, B], updates: { monthly_rate: 50 } });
  expect(result.skipped_customers).toEqual([expect.objectContaining({ customer_id: A, rate_blocked: true })]);
  expect(result.warning).toMatch(/already had a monthly bill/);
  // Every write after the skip targets only B (the fake query builder ignores
  // whereIn, so the id lists it was given are the evidence).
  const lists = db.__qb.whereIn.mock.calls.map(([, ids]) => ids);
  expect(lists[0]).toEqual([A, B]);
  for (const ids of lists.slice(1)) expect(ids).toEqual([B]);
});
