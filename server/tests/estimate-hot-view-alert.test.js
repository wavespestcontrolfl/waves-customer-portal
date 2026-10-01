/**
 * Owner-side "reading it now" bell (GATE_ESTIMATE_HOT_VIEW_ALERT).
 * Invariants:
 *   - gate off → nothing (no DB read, no bell);
 *   - the rule's LIVE params decide the match (DB-tunable knobs), engine
 *     defaults fill a missing knob;
 *   - one bell per estimate per 24h, deduped DURABLY through notifyAdmin's
 *     shared rolling-window dedupe (stable per-estimate key, never a
 *     service-local lock — GH codex P1 on #3709) (the
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
// alertEpisodesLive defaults to killed here so the pre-episode cases below keep
// exercising the notifyAdmin path; the episodes cases turn it on explicitly.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), alertEpisodesLive: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(),
  openAdminAlertKeys: jest.fn(),
  closeAdminAlertKeys: jest.fn(),
}));
jest.mock('../services/notification-bell-policy', () => {
  const actual = jest.requireActual('../services/notification-bell-policy');
  return { ...actual, bellAllowed: jest.fn(async () => false) };
});

const logger = require('../services/logger');
const bellPolicy = require('../services/notification-bell-policy');
const { isEnabled, alertEpisodesLive } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const alertEpisodes = require('../services/admin-alert-episodes');
const {
  HOT_VIEW_CATEGORY,
  maybeRaiseHotViewAlert,
  closeSettledHotViewAlerts,
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
  alertEpisodesLive.mockReturnValue(false);
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

  test('a match raises ONE bell with the category, deep link, metadata and the shared rolling dedupe', async () => {
    const notify = jest.fn(async () => ({ id: 'n-1', deduped: false }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3), session(4)], rule: RULE, now: NOW, notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'sent' });
    expect(notify).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notify.mock.calls[0];
    expect(category).toBe(HOT_VIEW_CATEGORY);
    expect(title).toBe('Test Customer is reading their estimate again');
    expect(body).toBe('4th visit in 72h — $75.08/mo, 123 Fixture Way, Testville, FL');
    expect(opts.link).toBe('/admin/estimates?estimateId=est-1');
    expect(opts.metadata).toEqual({ estimateId: 'est-1', customerId: 'cust-1', sessions: 4 });
    // The dedupe is notifyAdmin's: a STABLE per-estimate key (never a time
    // bucket, so two opens straddling a day boundary contend on one lock)
    // plus the rolling 24h window. No service-local lock or read.
    expect(opts.dedupeKey).toBe('estimate_hot_view:est-1');
    expect(opts.dedupeWindowMs).toBe(24 * 3600000);
    expect(opts.connection).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('raised for estimate est-1'));
  });

  test('a second match inside 24h is reported deduped by the shared mechanism', async () => {
    const notify = jest.fn(async () => ({ id: 'n-0', deduped: true }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, notify, gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'deduped' });
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a failed-closed notify (null: lock or read failure) is reported, never re-tried here', async () => {
    const notify = jest.fn(async () => null);
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, notify, gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'notify_failed' });
  });

  test('a suppressed bell (policy) is terminal success, not a retry', async () => {
    const notify = jest.fn(async () => ({ id: null, suppressed: true }));
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify, gateOn: () => true });
    expect(out).toEqual({ raised: true, reason: 'suppressed' });
  });

  test('notify throwing is swallowed and logged (a DB failure inside notifyAdmin surfaces as its null, see notify_failed)', async () => {
    const out = await maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, notify: jest.fn(async () => { throw new Error('boom'); }), gateOn: () => true });
    expect(out).toEqual({ raised: false, reason: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  test('a nameless estimate still reads sensibly', async () => {
    const notify = jest.fn(async () => ({ id: 'n-1' }));
    await maybeRaiseHotViewAlert({ estimate: { id: 'est-2', monthly_total: 0 }, sessions: [session(1), session(2), session(3)], rule: RULE, now: NOW, dbh: fakeDb(), notify, gateOn: () => true });
    expect(notify.mock.calls[0][1]).toBe('A customer is reading their estimate again');
    expect(notify.mock.calls[0][2]).toBe('3rd visit in 72h');
  });
});

describe('maybeRaiseHotViewAlert — alert episodes', () => {
  const sessions3 = [session(1), session(2), session(3)];
  const call = (extra = {}) => maybeRaiseHotViewAlert({ estimate: ESTIMATE, sessions: sessions3, rule: RULE, now: NOW, gateOn: () => true, ...extra });

  test('episodes live: the raise goes through the reopen wrapper with exactly the notify options, never notifyAdmin', async () => {
    alertEpisodesLive.mockReturnValue(true);
    const raise = jest.fn(async () => ({ id: 'n-1', deduped: false, rang: true }));
    const notify = jest.fn();
    const out = await call({ raise, notify });
    expect(out).toEqual({ raised: true, reason: 'sent' });
    expect(notify).not.toHaveBeenCalled();
    const [category, title, body, opts] = raise.mock.calls[0];
    expect(category).toBe(HOT_VIEW_CATEGORY);
    expect(title).toBe('Test Customer is reading their estimate again');
    expect(body).toBe('3rd visit in 72h — $75.08/mo, 123 Fixture Way, Testville, FL');
    expect(opts).toEqual({
      link: '/admin/estimates?estimateId=est-1',
      metadata: { estimateId: 'est-1', customerId: 'cust-1', sessions: 3 },
      dedupeKey: 'estimate_hot_view:est-1',
      dedupeWindowMs: 24 * 3600000,
    });
  });

  test('the default raise seam is the shared raiseAdminAlertWithReopen', async () => {
    alertEpisodesLive.mockReturnValue(true);
    alertEpisodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n-1', deduped: false, rang: true });
    expect(await call()).toEqual({ raised: true, reason: 'sent' });
    expect(alertEpisodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('episodes killed: the pre-episode notifyAdmin call, the wrapper untouched', async () => {
    const raise = jest.fn();
    const notify = jest.fn(async () => ({ id: 'n-1', deduped: false }));
    expect(await call({ raise, notify })).toEqual({ raised: true, reason: 'sent' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(raise).not.toHaveBeenCalled();
  });

  test('a standing row is a silent dedupe; a reopen (refreshed + rang) is a raise; a refresh that did not ring is a dedupe', async () => {
    alertEpisodesLive.mockReturnValue(true);
    const silent = jest.fn(async () => ({ id: 'n-0', deduped: true, rang: false }));
    expect(await call({ raise: silent })).toEqual({ raised: false, reason: 'deduped' });
    const reopened = jest.fn(async () => ({ id: 'n-0', deduped: true, refreshed: true, rung: true, rang: true }));
    expect(await call({ raise: reopened })).toEqual({ raised: true, reason: 'reopened' });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('raised for estimate est-1'));
    const quiet = jest.fn(async () => ({ id: 'n-0', deduped: true, refreshed: true, rung: false, rang: false }));
    expect(await call({ raise: quiet })).toEqual({ raised: false, reason: 'deduped' });
  });

  test('a suppressed bell and a failed raise keep their reasons under the wrapper', async () => {
    alertEpisodesLive.mockReturnValue(true);
    expect(await call({ raise: jest.fn(async () => ({ id: null, suppressed: true, rang: true })) })).toEqual({ raised: true, reason: 'suppressed' });
    expect(await call({ raise: jest.fn(async () => null) })).toEqual({ raised: false, reason: 'notify_failed' });
    expect(await call({ raise: jest.fn(async () => { throw new Error('boom'); }) })).toEqual({ raised: false, reason: 'error' });
  });

  test('gate off / category silent / below threshold never reach the wrapper', async () => {
    alertEpisodesLive.mockReturnValue(true);
    const raise = jest.fn();
    expect((await call({ raise, gateOn: () => false })).reason).toBe('gate_off');
    bellPolicy.bellAllowed.mockResolvedValue(false);
    expect((await call({ raise })).reason).toBe('category_silent');
    bellPolicy.bellAllowed.mockResolvedValue(true);
    expect((await call({ raise, sessions: [session(1)] })).reason).toBe('below_threshold');
    expect(raise).not.toHaveBeenCalled();
  });
});

describe('closeSettledHotViewAlerts', () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const keyOf = (n) => `estimate_hot_view:${id(n)}`;
  // A minimal estimates read: whereIn(ids).select(...) resolving the fixture
  // rows; each close runs in a transaction whose re-read (where({id}).first())
  // resolves the row as `now` says it is (defaults to the same fixtures).
  function fakeConn(rows, { now = rows } = {}) {
    const conn = jest.fn(() => {
      const b = { whereIn: jest.fn(() => b), select: jest.fn(async () => rows) };
      return b;
    });
    const trx = jest.fn(() => {
      let wanted = null;
      const b = { where: jest.fn(({ id: rowId }) => { wanted = rowId; return b; }), first: jest.fn(async () => now.find((r) => r.id === wanted) || undefined) };
      return b;
    });
    trx.raw = jest.fn(async () => {});
    conn.transaction = jest.fn(async (fn) => fn(trx));
    conn.trx = trx;
    return conn;
  }
  const rows = [
    { id: id(1), status: 'sent', archived_at: null },
    { id: id(2), status: 'accepted', archived_at: null },
    { id: id(3), status: 'declined', archived_at: null },
    { id: id(4), status: 'expired', archived_at: null },
    { id: id(5), status: 'viewed', archived_at: new Date('2026-09-20T00:00:00Z') },
    { id: id(6), status: 'viewed', archived_at: null },
    // Terminal beats archived: reported as the status.
    { id: id(7), status: 'accepted', archived_at: new Date('2026-09-21T00:00:00Z') },
  ];
  const run = (over = {}) => closeSettledHotViewAlerts({ now: NOW, conn: fakeConn(rows), gateOn: () => true, ...over });

  beforeEach(() => {
    alertEpisodesLive.mockReturnValue(true);
    alertEpisodes.closeAdminAlertKeys.mockImplementation(async (conn, keys) => keys.length);
  });

  test('closes accepted / declined / expired / archived / gone estimates and leaves open ones', async () => {
    alertEpisodes.openAdminAlertKeys.mockResolvedValue([1, 2, 3, 4, 5, 6, 7].map(keyOf).concat(keyOf(9), 'estimate_hot_view:not-a-uuid'));
    const out = await run();
    expect(alertEpisodes.openAdminAlertKeys).toHaveBeenCalledWith(expect.any(Function), 'estimate_hot_view:');
    const closedBy = alertEpisodes.closeAdminAlertKeys.mock.calls.reduce((by, [, keys, reason]) => ({ ...by, [reason]: [...(by[reason] || []), ...keys] }), {});
    expect(closedBy).toEqual({
      'estimate accepted': [keyOf(2), keyOf(7)],
      'estimate declined': [keyOf(3)],
      'estimate expired': [keyOf(4)],
      'estimate archived': [keyOf(5)],
      'estimate gone': [keyOf(9), 'estimate_hot_view:not-a-uuid'],
    });
    expect(alertEpisodes.closeAdminAlertKeys.mock.calls.every((c) => c[3].now === NOW)).toBe(true);
    // The open estimates (ids 1 and 6) are never named.
    const allClosed = Object.values(closedBy).flat();
    expect(allClosed).not.toContain(keyOf(1));
    expect(allClosed).not.toContain(keyOf(6));
    expect(out).toMatchObject({ ran: true, open: 9, closed: 7 });
    expect(out.reasons['estimate accepted']).toBe(2);
  });

  test('only open estimates: nothing is closed', async () => {
    alertEpisodes.openAdminAlertKeys.mockResolvedValue([keyOf(1), keyOf(6)]);
    expect(await run()).toMatchObject({ ran: true, open: 2, closed: 0 });
    expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('no open bells: no estimates read at all', async () => {
    alertEpisodes.openAdminAlertKeys.mockResolvedValue([]);
    const conn = fakeConn(rows);
    expect(await run({ conn })).toMatchObject({ ran: true, open: 0, closed: 0 });
    expect(conn).not.toHaveBeenCalled();
  });

  test('a key whose estimate is not a uuid is closed as gone without querying estimates', async () => {
    alertEpisodes.openAdminAlertKeys.mockResolvedValue(['estimate_hot_view:est-1']);
    const conn = fakeConn(rows);
    await run({ conn });
    expect(conn).not.toHaveBeenCalled();
    expect(conn.trx).not.toHaveBeenCalled();
    expect(alertEpisodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn.trx, ['estimate_hot_view:est-1'], 'estimate gone', { now: NOW, resolution: 'Estimate gone' });
  });

  test('each close re-reads its estimate under the raise path\'s own advisory lock: one made active again since the first read is left open', async () => {
    alertEpisodes.openAdminAlertKeys.mockResolvedValue([keyOf(5), keyOf(2)]);
    // Between the batch read and the close, estimate 5 was unarchived (and may be hot again).
    const reopened = rows.map((r) => (r.id === id(5) ? { ...r, archived_at: null } : r));
    const conn = fakeConn(rows, { now: reopened });
    const out = await run({ conn });
    expect(conn.trx.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${keyOf(5)}`]);
    expect(alertEpisodes.closeAdminAlertKeys.mock.calls.map(([, keys]) => keys)).toEqual([[keyOf(2)]]);
    expect(out).toMatchObject({ closed: 1, reasons: { 'estimate accepted': 1 } });
  });

  test('gate off: nothing runs (no key read, no close)', async () => {
    const out = await run({ gateOn: () => false });
    expect(out).toMatchObject({ ran: false, closed: 0 });
    expect(alertEpisodes.openAdminAlertKeys).not.toHaveBeenCalled();
    expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('defaults to the estimateHotViewAlert gate reader', async () => {
    isEnabled.mockReturnValue(false);
    expect((await closeSettledHotViewAlerts({ now: NOW, conn: fakeConn(rows) })).ran).toBe(false);
    expect(isEnabled).toHaveBeenCalledWith('estimateHotViewAlert');
    isEnabled.mockReturnValue(false);
  });

  test('episodes killed: nothing runs', async () => {
    alertEpisodesLive.mockReturnValue(false);
    const out = await run();
    expect(out.ran).toBe(false);
    expect(alertEpisodes.openAdminAlertKeys).not.toHaveBeenCalled();
    expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failing read is swallowed and logged, never thrown', async () => {
    alertEpisodes.openAdminAlertKeys.mockRejectedValue(new Error('db down'));
    const out = await run();
    expect(out).toMatchObject({ ran: true, closed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
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
