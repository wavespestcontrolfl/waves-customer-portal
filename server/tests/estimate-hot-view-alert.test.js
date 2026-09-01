/**
 * Owner-side "reading it now" bell (GATE_ESTIMATE_HOT_VIEW_ALERT).
 * Invariants:
 *   - gate off → nothing (no DB read, no bell);
 *   - the rule's LIVE params decide the match (DB-tunable knobs), engine
 *     defaults fill a missing knob;
 *   - one bell per estimate per 24h, deduped DURABLY against the
 *     notifications table under one stable per-estimate advisory lock (the
 *     concurrent-open race);
 *   - the bell carries the category, deep link and metadata the admin
 *     Estimates page and push settings key on;
 *   - never throws: notify or DB failures are swallowed and logged;
 *   - the category is owner-overridable under the bell policy (silent by
 *     default, owner ruling 2026-08-28).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/notification-bell-policy', () => {
  const actual = jest.requireActual('../services/notification-bell-policy');
  return { ...actual, bellAllowed: jest.fn(async () => false) };
});

const logger = require('../services/logger');
const bellPolicy = require('../services/notification-bell-policy');
const { isEnabled } = require('../config/feature-gates');
const {
  HOT_VIEW_CATEGORY,
  maybeRaiseHotViewAlert,
  _private: { ordinal, moneyPerMonth },
} = require('../services/estimate-hot-view-alert');

const NOW = new Date('2026-09-01T18:00:00Z');
const H = 3600000;
const session = (hoursAgo) => ({ startedAt: new Date(NOW.getTime() - hoursAgo * H), endedAt: new Date(NOW.getTime() - hoursAgo * H + 5 * 60000) });
const RULE = { rule_key: 'multi_view_high_intent', params: { minSessions: 3, windowHours: 72 } };
// Synthetic fixture only — never a real customer's name or address (AGENTS.md).
const ESTIMATE = { id: 'est-1', customer_id: 'cust-1', customer_name: 'Test Customer', address: '123 Fixture Way, Testville, FL', monthly_total: '75.08' };

function fakeDb({ existing = null, throwOnRead = false } = {}) {
  const reads = [];
  const dbh = jest.fn((table) => {
    reads.push(table);
    const b = {
      where: jest.fn(() => b),
      whereRaw: jest.fn(() => b),
      first: jest.fn(async () => { if (throwOnRead) throw new Error('db down'); return existing; }),
    };
    return b;
  });
  dbh.raw = jest.fn((expr) => expr);
  dbh.reads = reads;
  return dbh;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Most cases below model an owner who enabled the category; the
  // silent-by-default contract has its own tests.
  bellPolicy.bellAllowed.mockResolvedValue(true);
});

describe('ordinal / money formatting', () => {
  test('English ordinals incl. the 11-13 exception', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
  });
  test('monthly money drops trailing .00 and skips zero', () => {
    expect(moneyPerMonth('75.08')).toBe('$75.08/mo');
    expect(moneyPerMonth(38)).toBe('$38/mo');
    expect(moneyPerMonth(0)).toBeNull();
    expect(moneyPerMonth(null)).toBeNull();
  });
});

describe('maybeRaiseHotViewAlert', () => {
  test('gate off → no DB read, no bell', async () => {
    const dbh = fakeDb();
    const notify = jest.fn();
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh, notify, gateOn: () => false });
    expect(out).toEqual({ raised: false, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('defaults to the feature-gate reader when no gateOn is injected', async () => {
    isEnabled.mockReturnValueOnce(false);
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify: jest.fn() });
    expect(isEnabled).toHaveBeenCalledWith('estimateHotViewAlert');
    expect(out.reason).toBe('gate_off');
  });

  test('category silent (owner has not enabled it) → no DB read, no bell, regardless of the bell-policy gate (pre-push codex P1)', async () => {
    bellPolicy.bellAllowed.mockResolvedValue(false);
    const dbh = fakeDb();
    const notify = jest.fn();
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh, notify, gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'category_silent' });
    expect(bellPolicy.bellAllowed).toHaveBeenCalledWith({ category: HOT_VIEW_CATEGORY });
    expect(dbh).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('the real policy reader keeps the category silent with no owner override (not on the allowlist)', async () => {
    // Exercise the ACTUAL bellAllowed against an empty override set: absent
    // preference row → silent. This is the shipped default.
    const actual = jest.requireActual('../services/notification-bell-policy');
    const overrides = jest.spyOn(actual._private, 'loadCategoryOverrides');
    let allowed;
    try {
      // loadCategoryOverrides is called through the module's own binding, so
      // stub the DB read it wraps instead: an empty preferences table.
      const db = require('../models/db');
      db.mockImplementation(() => ({
        where: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(),
        select: jest.fn(async () => []), then: (res) => Promise.resolve([]).then(res),
      }));
      actual.clearOverrideCache();
      allowed = await actual.bellAllowed({ category: HOT_VIEW_CATEGORY });
    } finally {
      overrides.mockRestore();
    }
    expect(allowed).toBe(false);
  });

  test('below the rule threshold → no bell (live params, not defaults)', async () => {
    const dbh = fakeDb();
    const notify = jest.fn();
    // 3 sessions but the tuned rule wants 4.
    const out = await maybeRaiseHotViewAlert({
      estimate: ESTIMATE, sessions: [session(1), session(2), session(3)],
      rule: { params: { minSessions: 4, windowHours: 72 } }, now: NOW, dbh, notify, gateOn: () => true,
    });
    expect(out).toEqual({ raised: false, reason: 'below_threshold' });
    // 3 sessions, but only 2 inside a tightened 24h window.
    const out2 = await maybeRaiseHotViewAlert({
      estimate: ESTIMATE, sessions: [session(1), session(2), session(30)],
      rule: { params: { minSessions: 3, windowHours: 24 } }, now: NOW, dbh, notify, gateOn: () => true,
    });
    expect(out2).toEqual({ raised: false, reason: 'below_threshold' });
    expect(notify).not.toHaveBeenCalled();
    expect(dbh).not.toHaveBeenCalled();
  });

  test('missing knobs fall back to the engine defaults (3 sessions / 72h)', async () => {
    const notify = jest.fn(async () => ({ id: 'n-1' }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(20), session(70)], rule: { params: {} }, now: NOW, dbh: fakeDb(), notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'sent' });
    expect(notify.mock.calls[0][2]).toBe('3rd visit in 72h — $75.08/mo, 123 Fixture Way, Testville, FL');
  });

  test('a match raises ONE bell with the category, deep link and metadata', async () => {
    const dbh = fakeDb();
    const notify = jest.fn(async () => ({ id: 'n-1', deduped: false }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3), session(4)], rule: RULE, now: NOW, dbh, notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'sent' });
    expect(dbh.reads).toEqual(['notifications']);
    expect(notify).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notify.mock.calls[0];
    expect(category).toBe(HOT_VIEW_CATEGORY);
    expect(title).toBe('Test Customer is reading their estimate again');
    expect(body).toBe('4th visit in 72h — $75.08/mo, 123 Fixture Way, Testville, FL');
    expect(opts.link).toBe('/admin/estimates?estimateId=est-1');
    expect(opts.metadata).toEqual({ estimateId: 'est-1', customerId: 'cust-1', sessions: 4 });
    // Unserialized (mock) path: no trx connection is threaded through.
    expect(opts.connection).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('raised for estimate est-1'));
  });

  test('a second match inside 24h is deduped against the notifications table', async () => {
    const dbh = fakeDb({ existing: { id: 'n-0' } });
    const notify = jest.fn();
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh, notify, gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'deduped' });
    expect(notify).not.toHaveBeenCalled();
    // The lookup is scoped to this estimate, the category and the 24h window.
    const builder = dbh.mock.results[0].value;
    expect(builder.where).toHaveBeenCalledWith({ recipient_type: 'admin', category: HOT_VIEW_CATEGORY });
    expect(builder.whereRaw).toHaveBeenCalledWith("metadata->>'estimateId' = ?", ['est-1']);
    expect(builder.where).toHaveBeenCalledWith('created_at', '>', "NOW() - interval '24 hours'");
  });

  test('with a real knex: the check and the send run under ONE stable per-estimate advisory lock (pre-push codex P1)', async () => {
    // Two opens straddling a day boundary must contend on the same lock —
    // the key is the estimate id alone, never a time bucket.
    const events = [];
    const dbh = fakeDb();
    const trx = jest.fn((table) => { events.push(`read:${table}`); return dbh(table); });
    trx.raw = jest.fn((expr, bindings) => { if (/advisory/.test(expr)) events.push(`lock:${bindings[0]}`); return expr; });
    dbh.transaction = jest.fn(async (fn) => { events.push('begin'); const r = await fn(trx); events.push('commit'); return r; });
    const notify = jest.fn(async (...args) => { events.push('notify'); return { id: 'n-1' }; });
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh, notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'sent' });
    expect(events).toEqual(['begin', 'lock:estimate_hot_view:est-1', 'read:notifications', 'notify', 'commit']);
    // The bell insert rides the SAME transaction as the existence check.
    expect(notify.mock.calls[0][3].connection).toBe(trx);
  });

  test('with a real knex: a row inside the window short-circuits under the lock without a send', async () => {
    const dbh = fakeDb({ existing: { id: 'n-0' } });
    const trx = jest.fn((table) => dbh(table));
    trx.raw = jest.fn((expr) => expr);
    dbh.transaction = jest.fn(async (fn) => fn(trx));
    const notify = jest.fn();
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh, notify, gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'deduped' });
    expect(notify).not.toHaveBeenCalled();
  });

  test('a suppressed bell (policy) is terminal success, not a retry', async () => {
    const notify = jest.fn(async () => ({ id: null, suppressed: true }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'suppressed' });
  });

  test('notify throwing or the DB failing is swallowed and logged', async () => {
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify: jest.fn(async () => { throw new Error('boom'); }), gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    const out2 = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb({ throwOnRead: true }), notify: jest.fn(), gateOn: () => true });
    expect(out2).toEqual({ raised: false, reason: 'error' });
  });

  test('a nameless estimate still reads sensibly', async () => {
    const notify = jest.fn(async () => ({ id: 'n-1' }));
    await maybeRaiseHotViewAlert({ estimate: { id: 'est-2', monthly_total: 0 }, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify, gateOn: () => true });
    expect(notify.mock.calls[0][1]).toBe('A customer is reading their estimate again');
    expect(notify.mock.calls[0][2]).toBe('3rd visit in 72h');
  });
});

describe('bell policy', () => {
  test('estimate_hot_view is owner-overridable (silent by default, owner ruling 2026-08-28)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/notification-bell-policy'), 'utf8');
    const allowStart = src.indexOf('CATEGORY_BELL_ALLOWLIST = new Set([');
    const allowlistBlock = src.slice(allowStart, src.indexOf(']);', allowStart));
    const overridableStart = src.indexOf('OVERRIDABLE_CATEGORIES = [');
    const overridableBlock = src.slice(overridableStart, src.indexOf('];', overridableStart));
    expect(allowlistBlock).not.toContain("'estimate_hot_view'");
    expect(overridableBlock).toContain("'estimate_hot_view'");
  });
});
