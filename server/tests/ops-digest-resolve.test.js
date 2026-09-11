// resolveOpsDigest (fall-off rule, owner 2026-09-11): retires only UNREAD
// admin ops_digest rows carrying the key (and source when given) — read_at
// stamped, metadata merged with resolved/resolvedAt/resolvedBy, nothing
// deleted. A DB failure reads as 0 so the runner retries next clean run.

const mockDb = jest.fn();
mockDb.fn = { now: jest.fn(() => 'NOW()') };
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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

beforeEach(() => { mockDb.mockReset(); mockDb.raw.mockClear(); });

test('retires unread rows by opsKey + source and stamps resolved metadata', async () => {
  const q = chain(2);
  mockDb.mockReturnValue(q);
  const n = await resolveOpsDigest({ key: 'e22-schedule-integrity:overlaps', source: 'ops-crons', resolvedBy: 'ops-crons:3-clean-runs' });
  expect(n).toBe(2);
  expect(mockDb).toHaveBeenCalledWith('notifications');
  expect(q.where).toHaveBeenCalledWith({ recipient_type: 'admin', category: CATEGORY });
  expect(q.whereNull).toHaveBeenCalledWith('read_at');
  expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'opsKey' = ?", ['e22-schedule-integrity:overlaps']);
  expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'source' = ?", ['ops-crons']);
  const patch = q.update.mock.calls[0][0];
  expect(patch.read_at).toBe('NOW()');
  expect(patch.metadata.sql).toBe("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
  const merged = JSON.parse(patch.metadata.bindings[0]);
  expect(merged).toMatchObject({ resolved: true, resolvedBy: 'ops-crons:3-clean-runs' });
  expect(typeof merged.resolvedAt).toBe('string');
});

test('no source filter when source is omitted; blank key is a no-op', async () => {
  const q = chain(1);
  mockDb.mockReturnValue(q);
  expect(await resolveOpsDigest({ key: 'k1' })).toBe(1);
  expect(q.whereRaw).toHaveBeenCalledTimes(1);
  expect(await resolveOpsDigest({ key: '   ' })).toBe(0);
  expect(await resolveOpsDigest({})).toBe(0);
});

test('a DB failure reads as 0, never throws', async () => {
  const q = chain(0);
  q.update = jest.fn(async () => { throw new Error('boom'); });
  mockDb.mockReturnValue(q);
  await expect(resolveOpsDigest({ key: 'k2', source: 'ops-crons' })).resolves.toBe(0);
});
