/**
 * resolveCallSupervision — the ONE reader of per-call supervision
 * (codex #3560 P2/P0): stamp wins; legacy rows derive from the case once and
 * backfill; a failed case read is unsupervised with NO backfill.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const db = require('../models/db');
const { resolveCallSupervision } = require('../services/collections/outbound-voice/supervision');

function chain({ first, updateResult = [{ id: 'cl-1' }], firstThrows = null } = {}) {
  const q = {};
  ['where', 'whereRaw', 'update'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => { if (firstThrows) throw firstThrows; return first; });
  q.returning = jest.fn(async () => updateResult);
  return q;
}
const ROW = { id: 'cl-1' };
const META = { collectionCaseId: 'case-1' };

beforeEach(() => { jest.clearAllMocks(); });

test('an explicit stamp is authoritative — no DB reads at all', async () => {
  expect(await resolveCallSupervision({ row: ROW, meta: { ...META, collectionsSupervised: true } })).toBe(true);
  expect(await resolveCallSupervision({ row: ROW, meta: { ...META, collectionsSupervised: false } })).toBe(false);
  expect(db).not.toHaveBeenCalled();
});

test.each([
  ['admin:adam@wavespestcontrol.com', true],
  ['system:autodial', false],
  [null, false],
])('legacy row: approved_by=%s ⇒ %s, and the verdict is backfilled onto the call row', async (approvedBy, expected) => {
  const caseChain = chain({ first: { approved_by: approvedBy } });
  const backfill = chain();
  db.mockImplementation((t) => (t === 'collection_cases' ? caseChain : backfill));
  expect(await resolveCallSupervision({ row: ROW, meta: META })).toBe(expected);
  expect(backfill.where).toHaveBeenCalledWith({ id: 'cl-1' });
  expect(backfill.whereRaw).toHaveBeenCalledWith(expect.stringContaining("collectionsSupervised"));
  const [patch] = backfill.update.mock.calls[0];
  expect(patch.metadata.bindings).toEqual([JSON.stringify({ collectionsSupervised: expected })]);
});

test('case read failure ⇒ unsupervised and NO backfill (a retry can still succeed)', async () => {
  const caseChain = chain({ firstThrows: new Error('boom') });
  const backfill = chain();
  db.mockImplementation((t) => (t === 'collection_cases' ? caseChain : backfill));
  expect(await resolveCallSupervision({ row: ROW, meta: META })).toBe(false);
  expect(backfill.update).not.toHaveBeenCalled();
});

test('losing the backfill race returns the PERSISTED stamp, not the local derivation (hook P1)', async () => {
  const caseChain = chain({ first: { approved_by: 'admin:x' } }); // local derivation says true
  const backfill = chain({ updateResult: [] }); // whereRaw matched nothing — someone else stamped
  const reread = chain({ first: { metadata: { collectionsSupervised: false } } });
  const callLogs = [backfill, reread];
  db.mockImplementation((t) => (t === 'collection_cases' ? caseChain : callLogs.shift()));
  expect(await resolveCallSupervision({ row: ROW, meta: META })).toBe(false);
  expect(reread.first).toHaveBeenCalledWith('metadata');
});

test('a lost race with an unreadable/absent stored stamp falls back to the local derivation', async () => {
  const caseChain = chain({ first: { approved_by: 'admin:x' } });
  const backfill = chain({ updateResult: [] });
  const reread = chain({ first: { metadata: null } });
  const callLogs = [backfill, reread];
  db.mockImplementation((t) => (t === 'collection_cases' ? caseChain : callLogs.shift()));
  expect(await resolveCallSupervision({ row: ROW, meta: META })).toBe(true);
});

test('backfill failure does not change the verdict', async () => {
  const caseChain = chain({ first: { approved_by: 'admin:x' } });
  const backfill = chain(); backfill.returning = jest.fn(async () => { throw new Error('locked'); });
  db.mockImplementation((t) => (t === 'collection_cases' ? caseChain : backfill));
  expect(await resolveCallSupervision({ row: ROW, meta: META })).toBe(true);
});

test('no case linkage ⇒ unsupervised, no reads', async () => {
  expect(await resolveCallSupervision({ row: ROW, meta: {} })).toBe(false);
  expect(db).not.toHaveBeenCalled();
});
