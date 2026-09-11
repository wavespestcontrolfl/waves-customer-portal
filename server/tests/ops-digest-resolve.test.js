// resolveOpsDigest (fall-off rule, owner 2026-09-11): retires the admin
// ops_digest rows carrying the key (and source when given) that are not
// yet resolved — keyed off the resolved marker, not read_at, so a bell the
// owner already opened still clears. read_at is stamped only if null;
// metadata merged with resolved/resolvedAt/resolvedBy; nothing deleted. A
// DB failure reads as 0 so the runner retries next clean run.

const mockDb = jest.fn();
mockDb.fn = { now: jest.fn(() => 'NOW()') };
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
// transaction: a trx that is the same builder factory; its raw records the advisory lock
const mockTrxRaw = jest.fn(async () => undefined);
mockDb.transaction = jest.fn(async (fn) => {
  const trx = (table) => mockDb(table);
  trx.raw = (sql, bindings) => (/pg_advisory/.test(String(sql)) ? mockTrxRaw(sql, bindings) : { sql, bindings });
  return fn(trx);
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveOpsDigest, CATEGORY } = require('../services/ops-digest');

function chain(updateResult) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.update = jest.fn(async () => updateResult);
  return q;
}

beforeEach(() => { mockDb.mockReset(); mockDb.raw.mockClear(); mockDb.transaction.mockClear(); mockTrxRaw.mockClear(); });

test('retires not-yet-resolved rows (read or unread) by opsKey + source and stamps resolved metadata', async () => {
  const q = chain(2);
  mockDb.mockReturnValue(q);
  const n = await resolveOpsDigest({ key: 'e22-schedule-integrity:overlaps', source: 'ops-crons', resolvedBy: 'ops-crons:3-clean-runs' });
  expect(n).toBe(2);
  expect(mockDb).toHaveBeenCalledWith('notifications');
  expect(q.where).toHaveBeenCalledWith({ recipient_type: 'admin', category: CATEGORY });
  // Never scoped to unread: an opened FIX/ACT must still clear.
  expect(q.whereNull).not.toHaveBeenCalled();
  expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(metadata->>'resolved', '') <> 'true'");
  expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'opsKey' = ?", ['e22-schedule-integrity:overlaps']);
  expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'source' = ?", ['ops-crons']);
  const patch = q.update.mock.calls[0][0];
  // read_at only stamped when still null — an owner's earlier read stands.
  expect(patch.read_at).toEqual({ sql: 'COALESCE(read_at, NOW())', bindings: undefined });
  // dedupeKey is removed so a recurrence inside the rolling window rings again.
  expect(patch.metadata.sql).toBe("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb");
  const merged = JSON.parse(patch.metadata.bindings[0]);
  expect(merged).toMatchObject({ resolved: true, resolvedBy: 'ops-crons:3-clean-runs' });
  expect(typeof merged.resolvedAt).toBe('string');
});

test('source: null scopes to rows with NO source (the in-process senders)', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  expect(await resolveOpsDigest({ key: 'lead-to-cash-invariants', source: null })).toBe(1);
  expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'source' IS NULL");
  expect(q.whereRaw).not.toHaveBeenCalledWith("metadata->>'source' = ?", expect.anything());
});

test('no source filter when source is omitted; blank key is a no-op', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  expect(await resolveOpsDigest({ key: 'k1' })).toBe(1);
  expect(q.whereRaw).toHaveBeenCalledTimes(2); // resolved marker + opsKey, no source clause
  expect(await resolveOpsDigest({ key: '   ' })).toBe(0);
  expect(await resolveOpsDigest({})).toBe(0);
});

test('a DB failure reads as 0, never throws', async () => {
  const q = chain(0);
  q.update = jest.fn(async () => { throw new Error('boom'); });
  mockDb.mockReturnValue(q);
  await expect(resolveOpsDigest({ key: 'k2', source: 'ops-crons' })).resolves.toBe(0);
});

test('lockKey: the retire runs in a transaction under the same advisory lock notifyAdmin dedupe takes', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  const n = await resolveOpsDigest({ key: 'e22:overlaps', source: 'ops-crons', lockKey: 'ops-crons:e22:overlaps' });
  expect(n).toBe(1);
  expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  expect(mockTrxRaw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['admin:ops-crons:e22:overlaps']);
  expect(q.update).toHaveBeenCalledTimes(1);
});

test('no lockKey: no transaction, no lock', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  await resolveOpsDigest({ key: 'k' });
  expect(mockDb.transaction).not.toHaveBeenCalled();
  expect(mockTrxRaw).not.toHaveBeenCalled();
});

test('notAfter: only rows observed at or before the clean run retire (metadata.observedAt, else created_at)', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  await resolveOpsDigest({ key: 'k', source: 'ops-crons', notAfter: '2026-09-11T11:10:00.000Z' });
  expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(NULLIF(metadata->>'observedAt', '')::timestamptz, created_at) <= ?::timestamptz", ['2026-09-11T11:10:00.000Z']);
});

test('alsoRetire: the companion bell category keyed by a metadata field retires in the same call (unread rows only)', async () => {
  const main = chain(1); const companion = chain(2);
  mockDb.mockReturnValueOnce(main).mockReturnValueOnce(companion);
  const n = await resolveOpsDigest({ key: 'call-extraction-eval', source: null, alsoRetire: { category: 'eval_regression', field: 'evalKey' } });
  expect(n).toBe(1);
  expect(companion.where).toHaveBeenCalledWith({ recipient_type: 'admin', category: 'eval_regression' });
  expect(companion.whereNull).toHaveBeenCalledWith('read_at');
  expect(companion.whereRaw).toHaveBeenCalledWith('metadata->>? = ?', ['evalKey', 'call-extraction-eval']);
  expect(companion.update).toHaveBeenCalledTimes(1);
});

