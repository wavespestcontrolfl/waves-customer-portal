/**
 * notifyAdmin dedupeWindowMs — the ROLLING variant of the admin dedupeKey
 * (GH codex P1 on #3709: one shared mechanism for every admin emitter).
 * Without a window the key dedupes forever (unchanged behavior); with one,
 * only rows younger than the window count, under the same stable lock.
 */
const calls = { where: [], whereRaw: [], raw: [], locks: [] };
let existingRow = null;
jest.mock('../models/db', () => {
  const builder = {
    where: jest.fn((...a) => { calls.where.push(a); return builder; }),
    whereRaw: jest.fn((...a) => { calls.whereRaw.push(a); return builder; }),
    modify: jest.fn((fn) => { fn(builder); return builder; }),
    first: jest.fn(async () => existingRow),
  };
  const trx = jest.fn(() => builder);
  trx.raw = jest.fn((expr, bindings) => { calls.raw.push([expr, bindings]); if (/advisory/.test(expr)) calls.locks.push(bindings[0]); return { expr, bindings }; });
  const db = jest.fn(() => builder);
  db.transaction = jest.fn(async (fn) => fn(trx));
  db.raw = trx.raw;
  db.fn = { now: () => 'now' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const NotificationService = require('../services/notification-service');

beforeEach(() => {
  calls.where.length = 0; calls.whereRaw.length = 0; calls.raw.length = 0; calls.locks.length = 0;
  existingRow = null;
  jest.spyOn(NotificationService, 'create').mockResolvedValue({ id: 'n-new' });
});
afterEach(() => jest.restoreAllMocks());

test('dedupeKey alone dedupes forever (no created_at predicate) under the admin:<key> lock', async () => {
  const out = await NotificationService.notifyAdmin('estimate_hot_view', 't', 'b', { dedupeKey: 'estimate_hot_view:est-1' });
  expect(out).toMatchObject({ id: 'n-new', deduped: false });
  expect(calls.locks).toEqual(['admin:estimate_hot_view:est-1']);
  expect(calls.whereRaw).toEqual([["metadata->>'dedupeKey' = ?", ['estimate_hot_view:est-1']]]);
  expect(calls.where.some((a) => a[0] === 'created_at')).toBe(false);
});

test('dedupeWindowMs narrows the existence check to rows younger than the window', async () => {
  await NotificationService.notifyAdmin('estimate_hot_view', 't', 'b', { dedupeKey: 'estimate_hot_view:est-1', dedupeWindowMs: 24 * 3600000 });
  const created = calls.where.find((a) => a[0] === 'created_at');
  expect(created).toBeTruthy();
  expect(created[1]).toBe('>');
  expect(created[2]).toEqual({ expr: "NOW() - (? * interval '1 millisecond')", bindings: [86400000] });
  expect(calls.locks).toEqual(['admin:estimate_hot_view:est-1']);
});

test('a row inside the window dedupes; the create never runs', async () => {
  existingRow = { id: 'n-0' };
  const out = await NotificationService.notifyAdmin('estimate_hot_view', 't', 'b', { dedupeKey: 'k', dedupeWindowMs: 1000 });
  expect(out).toMatchObject({ id: 'n-0', deduped: true });
  expect(NotificationService.create).not.toHaveBeenCalled();
});

test('an invalid window is ignored (forever dedupe), never a broken predicate', async () => {
  await NotificationService.notifyAdmin('estimate_hot_view', 't', 'b', { dedupeKey: 'k', dedupeWindowMs: 'soon' });
  expect(calls.where.some((a) => a[0] === 'created_at')).toBe(false);
});
