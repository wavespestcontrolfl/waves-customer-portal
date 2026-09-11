// Pins what NotificationService.notifyAdmin's refreshOnDedupe actually does
// with dedupeVersion, because services/ops-digest.js resolveOpsDigest's
// ordering guarantee depends on it (pre-push P1 on #4397: the guarantee was
// asserted in a PR that did not touch this file).
//
// The semantics are "version CHANGED", not "version is newer", and the
// metadata merge takes the INCOMING object verbatim — so an older run
// re-posting a key lowers metadata.observedAt. That is exactly why
// resolveOpsDigest compares GREATEST(observedAt, created_at).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockUpdates = [];
const mockExisting = { row: null };
jest.mock('../models/db', () => {
  const builder = () => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'andWhere', 'orderBy', 'select', 'returning']) b[m] = jest.fn(() => b);
    b.first = jest.fn(async () => mockExisting.row);
    b.update = jest.fn(async (patch) => { mockUpdates.push(patch); return 1; });
    b.insert = jest.fn(() => ({ returning: async () => [{ id: 'new-row' }] }));
    return b;
  };
  const db = jest.fn(() => builder());
  db.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn(() => builder());
    trx.raw = jest.fn(async () => ({}));
    return fn(trx);
  });
  return db;
});

const NotificationService = require('../services/notification-service');

beforeEach(() => { mockUpdates.length = 0; mockExisting.row = null; });

test('a DIFFERENT dedupeVersion refreshes the standing row — including an OLDER one', async () => {
  mockExisting.row = {
    id: 'n1',
    title: 'FIX: x',
    body: 'b',
    link: '/admin/agents?tab=activity',
    metadata: { opsKey: 'k', dedupeVersion: '2026-09-11T11:05:00.000Z', observedAt: '2026-09-11T11:05:00.000Z' },
  };
  // An OLDER run re-posts the same key (slow request, out of order).
  const out = await NotificationService.notifyAdmin('ops_digest', 'FIX: x', 'b', {
    link: '/admin/agents?tab=activity',
    bell: true,
    dedupeKey: 'ops-crons:k',
    dedupeWindowMs: 24 * 60 * 60 * 1000,
    refreshOnDedupe: true,
    dedupeVersion: '2026-09-11T11:00:00.000Z',
    metadata: { opsKey: 'k', observedAt: '2026-09-11T11:00:00.000Z' },
  });

  expect(out.deduped).toBe(true);
  expect(out.refreshed).toBe(true);
  expect(mockUpdates).toHaveLength(1);
  const merged = JSON.parse(mockUpdates[0].metadata);
  // The older observation WINS the merge — the documented hazard.
  expect(merged.observedAt).toBe('2026-09-11T11:00:00.000Z');
  expect(merged.dedupeVersion).toBe('2026-09-11T11:00:00.000Z');
});

test('an IDENTICAL dedupeVersion and content is a plain dedupe — no rewrite, no re-bell', async () => {
  const meta = { opsKey: 'k', dedupeVersion: '2026-09-11T11:05:00.000Z', observedAt: '2026-09-11T11:05:00.000Z' };
  mockExisting.row = { id: 'n1', title: 'FIX: x', body: 'b', link: '/admin/x', metadata: meta };
  const out = await NotificationService.notifyAdmin('ops_digest', 'FIX: x', 'b', {
    link: '/admin/x',
    bell: true,
    dedupeKey: 'ops-crons:k',
    dedupeWindowMs: 24 * 60 * 60 * 1000,
    refreshOnDedupe: true,
    dedupeVersion: '2026-09-11T11:05:00.000Z',
    metadata: meta,
  });
  expect(out.deduped).toBe(true);
  expect(out.refreshed).toBeUndefined();
  expect(mockUpdates).toHaveLength(0);
});
