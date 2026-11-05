/**
 * The Claude's-queue readers and writers in notification-service.js ("Send to Claude" #7498/#7546, ideas #7548):
 * the fenced writes take the alert's dedupe lock, re-check their fence inside the transaction and report the rows
 * they wrote; the readers are role-scoped. Measured by the customer-backend coverage floor
 * (jest.customer-coverage.config.js), next to the other admin halves of this module.
 */
const mockState = { first: [], update: 1, calls: [] };
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'forUpdate']) {
      b[m] = jest.fn((...a) => { mockState.calls.push([table, m, ...a]); return b; });
    }
    b.modify = jest.fn((fn) => { fn(b); return b; });
    b.first = jest.fn(async (...a) => { mockState.calls.push([table, 'first', ...a]); return mockState.first.length ? mockState.first.shift() : null; });
    b.update = jest.fn(async (patch) => { mockState.calls.push([table, 'update', patch]); return mockState.update; });
    b.count = jest.fn(async (...a) => { mockState.calls.push([table, 'count', ...a]); return [{ count: '2' }]; });
    return b;
  };
  const raw = jest.fn((expr, bindings) => { mockState.calls.push(['raw', expr, bindings]); return { expr, bindings }; });
  const trx = jest.fn((table) => makeBuilder(table));
  trx.raw = raw;
  trx.fn = { now: () => 'now()' };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = raw;
  db.fn = { now: () => 'now()' };
  db.transaction = jest.fn(async (fn) => fn(trx));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const NotificationService = require('../services/notification-service');

const ID = '00000000-0000-4000-8000-0000000000c1';
const AT = '2026-11-03T20:00:00.000Z';
const locks = () => mockState.calls.filter((c) => c[0] === 'raw' && /advisory/.test(c[1])).map((c) => c[2][0]);
const updates = () => mockState.calls.filter((c) => c[1] === 'update').map((c) => c[2]);
const rawTexts = () => mockState.calls.filter((c) => c[1] === 'whereRaw').map((c) => c[2]);

beforeEach(() => { mockState.first = []; mockState.update = 1; mockState.calls = []; });

describe('readers', () => {
  test('getAdminNotificationForExplainer returns the row, or null when it is gone', async () => {
    mockState.first = [{ id: ID, version: 'v1' }];
    expect(await NotificationService.getAdminNotificationForExplainer(ID, { role: 'admin' })).toEqual({ id: ID, version: 'v1' });
    expect(await NotificationService.getAdminNotificationForExplainer(ID, { role: 'admin' })).toBeNull();
  });

  test('getAdminNotificationState answers done/version, or null when the row is gone', async () => {
    mockState.first = [{ done_at: null, version: 'v2' }];
    const state = await NotificationService.getAdminNotificationState(ID, { role: 'admin' });
    expect(state).toBeTruthy();
    expect(await NotificationService.getAdminNotificationState(ID, { role: 'admin' })).toBeNull();
  });

  test('isAdminOwnerOnly is true only for a row flagged ownerOnly', async () => {
    mockState.first = [{ owner_only: true }, { owner_only: false }];
    expect(await NotificationService.isAdminOwnerOnly(ID, { role: 'admin' })).toBe(true);
    expect(await NotificationService.isAdminOwnerOnly(ID, { role: 'admin' })).toBe(false);
    expect(await NotificationService.isAdminOwnerOnly(ID, { role: 'admin' })).toBe(false); // gone
  });
});

describe('getAdminNotifications owner-only rows', () => {
  const ownerOnlySql = "COALESCE(metadata->>'ownerOnly', '') <> 'true'";
  test('hides ownerOnly rows unless fullAccess is true (the default hides them)', async () => {
    await NotificationService.getAdminNotifications(51, 0, { role: 'admin' });
    expect(rawTexts()).toEqual(expect.arrayContaining([ownerOnlySql]));
    mockState.calls = [];
    await NotificationService.getAdminNotifications(51, 0, { role: 'admin', fullAccess: false });
    expect(rawTexts()).toEqual(expect.arrayContaining([ownerOnlySql]));
  });
  test('fullAccess lists them', async () => {
    await NotificationService.getAdminNotifications(51, 0, { role: 'admin', fullAccess: true });
    expect(rawTexts()).not.toEqual(expect.arrayContaining([ownerOnlySql]));
  });
});

describe('getAdminUnreadCount owner-only rows', () => {
  const ownerOnlySql = "COALESCE(metadata->>'ownerOnly', '') <> 'true'";
  test('an owner-only row counts for the owner login alone (the default does not count it)', async () => {
    expect(await NotificationService.getAdminUnreadCount({ role: 'admin' })).toBe(2);
    expect(rawTexts()).toEqual(expect.arrayContaining([ownerOnlySql]));
    mockState.calls = [];
    expect(await NotificationService.getAdminUnreadCount({ role: 'admin', fullAccess: true })).toBe(2);
    expect(rawTexts()).not.toEqual(expect.arrayContaining([ownerOnlySql]));
  });
});

describe('saveAdminExplainer', () => {
  test('writes the summary only at the version it was written for', async () => {
    mockState.update = 0;
    expect(await NotificationService.saveAdminExplainer(ID, 'v9', { happened: 'x', steps: [] })).toBe(0);
    expect(rawTexts().some((t) => /md5/.test(t))).toBe(true);
    expect(updates()).toEqual([{ explainer: JSON.stringify({ happened: 'x', steps: [] }) }]);
  });
});

describe('markAdminSentToClaude', () => {
  test('a keyed row takes its dedupe lock and merges the patch at the version the admin saw', async () => {
    mockState.first = [{ dedupe_key: 'unpriced-series:abc' }];
    expect(await NotificationService.markAdminSentToClaude(ID, 'v1', { claudeQueue: 'sent-to-claude' })).toBe(1);
    expect(locks()).toEqual(['admin:unpriced-series:abc']);
    expect(rawTexts()).toEqual(expect.arrayContaining(["COALESCE(metadata->>'feed', '') <> 'activity'"]));
    expect(JSON.parse(updates()[0].metadata.bindings[0])).toEqual({ claudeQueue: 'sent-to-claude' });
  });

  test('a missing row writes nothing; an unkeyed row takes no lock', async () => {
    expect(await NotificationService.markAdminSentToClaude(ID, 'v1', {})).toBe(0);
    mockState.first = [{ dedupe_key: null }];
    await NotificationService.markAdminSentToClaude(ID, 'v1', {});
    expect(locks()).toEqual([]);
  });
});

describe('markAdminUnsentFromClaude', () => {
  test('restores who and severity from the stamp, inside the lock and the fence', async () => {
    mockState.first = [{ dedupe_key: 'k1' }, { was: { who: 'person', severity: 'needs-you' } }];
    expect(await NotificationService.markAdminUnsentFromClaude(ID, AT, 'admin')).toBe(1);
    expect(locks()).toEqual(['admin:k1']);
    expect(rawTexts()).toEqual(expect.arrayContaining(["metadata->'sentToClaude'->>'startedAt' IS NULL"]));
    const restore = JSON.parse(updates()[0].metadata.bindings[0]);
    expect(restore).toMatchObject({ who: 'person', severity: 'needs-you', unsentFromClaude: { by: 'admin' } });
  });

  test('a null was drops the keys; a missing row or a fence miss writes nothing', async () => {
    mockState.first = [{ dedupe_key: null }, { was: { who: null, severity: null } }];
    await NotificationService.markAdminUnsentFromClaude(ID, AT, 'admin');
    const restore = JSON.parse(updates()[0].metadata.bindings[0]);
    expect(restore).not.toHaveProperty('who');
    expect(restore).not.toHaveProperty('severity');
    mockState.calls = [];
    expect(await NotificationService.markAdminUnsentFromClaude(ID, AT, 'admin')).toBe(0); // gone
    mockState.first = [{ dedupe_key: null }, null];
    expect(await NotificationService.markAdminUnsentFromClaude(ID, AT, 'admin')).toBe(0); // fence miss
    expect(updates()).toEqual([]);
  });
});

describe('markAdminIdeaCancelled', () => {
  test('closes an untouched idea as done, inside the lock and the fence', async () => {
    mockState.first = [{ dedupe_key: 'owner-idea:0123456789abcdef' }, { id: ID }];
    expect(await NotificationService.markAdminIdeaCancelled(ID, AT, 'admin', 'Cancelled by the owner.')).toBe(1);
    expect(locks()).toEqual(['admin:owner-idea:0123456789abcdef']);
    expect(rawTexts()).toEqual(expect.arrayContaining(["metadata->'sentToClaude'->>'kind' = ?"]));
    expect(mockState.calls.filter((c) => c[1] === 'whereRaw' && /->>'kind' = \?/.test(c[2])).map((c) => c[3])).toEqual([['owner-idea'], ['owner-idea']]);
    expect(updates()[0]).toMatchObject({ done_by: 'admin' });
  });

  test('a guarded copy is fenced on its own kind', async () => {
    mockState.first = [{ dedupe_key: 'claude-copy:p1' }, { id: ID }];
    expect(await NotificationService.markAdminIdeaCancelled(ID, AT, 'admin', 'Cancelled by the owner.', 'guarded-copy')).toBe(1);
    expect(locks()).toEqual(['admin:claude-copy:p1']);
    expect(mockState.calls.filter((c) => c[1] === 'whereRaw' && /->>'kind' = \?/.test(c[2])).map((c) => c[3])).toEqual([['guarded-copy'], ['guarded-copy']]);
  });

  test('a missing row or a started, changed or done idea writes nothing', async () => {
    expect(await NotificationService.markAdminIdeaCancelled(ID, AT, 'admin', 'x')).toBe(0);
    mockState.first = [{ dedupe_key: null }, null];
    expect(await NotificationService.markAdminIdeaCancelled(ID, AT, 'admin', 'x')).toBe(0);
    expect(updates()).toEqual([]);
  });
});
