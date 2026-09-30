// releaseUnappliedCase (cancellation-resolution/index.js): an accepted case
// whose action changed nothing is released to 'none' — under the accept
// lock, from a fresh read — but never while a receipt or a live plan hold
// stands for it (a concurrent or retried execution that succeeded wins).
const mockRows = { case: null, hold: null, updates: [], locks: [] };
jest.mock('../models/db', () => {
  const trx = (table) => {
    const b = {
      where: () => b, whereIn: () => b, forUpdate: () => b,
      first: async () => (table === 'plan_holds' ? mockRows.hold : mockRows.case),
      update: async (patch) => { mockRows.updates.push(patch); return 1; },
    };
    return b;
  };
  trx.raw = async (sql, bindings) => { mockRows.locks.push(bindings[0]); };
  const fn = jest.fn();
  fn.transaction = async (cb) => cb(trx);
  return fn;
});
jest.mock('../config/feature-gates', () => ({ gateEnvValue: () => null }));

const { releaseUnappliedCase } = require('../services/cancellation-resolution');

beforeEach(() => { mockRows.case = null; mockRows.hold = null; mockRows.updates = []; mockRows.locks = []; });

test('releases an accepted case with no receipt and no standing hold, under the accept lock', async () => {
  mockRows.case = { resolution_outcome: 'accepted', snapshot: JSON.stringify({ accept_key: 'k' }) };
  expect(await releaseUnappliedCase({ caseId: 'case-1', customerId: 'c1', code: 'accept_interrupted' })).toBe(true);
  expect(mockRows.locks).toEqual(['cancel-accept:c1']);
  expect(mockRows.updates[0].resolution_outcome).toBe('none');
  expect(JSON.parse(mockRows.updates[0].snapshot)).toMatchObject({ accept_key: 'k', accept_refused: { code: 'accept_interrupted' } });
});

test('keeps the case when a receipt or a live hold stands, or it is no longer accepted', async () => {
  mockRows.case = { resolution_outcome: 'accepted', snapshot: JSON.stringify({ accept_receipt: { reference: 'X' } }) };
  expect(await releaseUnappliedCase({ caseId: 'case-1', customerId: 'c1', code: 'x' })).toBe(false);
  mockRows.case = { resolution_outcome: 'accepted', snapshot: '{}' };
  mockRows.hold = { id: 'h1' };
  expect(await releaseUnappliedCase({ caseId: 'case-1', customerId: 'c1', code: 'x' })).toBe(false);
  mockRows.hold = null;
  mockRows.case = { resolution_outcome: 'none', snapshot: '{}' };
  expect(await releaseUnappliedCase({ caseId: 'case-1', customerId: 'c1', code: 'x' })).toBe(false);
  expect(mockRows.updates).toHaveLength(0);
});
