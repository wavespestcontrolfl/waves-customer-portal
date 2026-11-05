/**
 * The quiet policy of admin-alert-retention.js (owner rulings 2026-11-04 "IF THE ALERT IS OVER 3 DAYS OLD,, IT SHOULD
 * FALL OFF" and 2026-11-05 "A": money alerts stay until settled), the parts that need no database: the gate states,
 * what a pass judges and writes through its io edges, the per-tick cap, the money list, the first-match RERING hold,
 * the Reopen hold surviving a quiet refresh, and the 10-minute cron. The rules against live Postgres are in
 * admin-alert-retention-quiet-db.test.js. The nightly policy's own tests are untouched.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const retention = require('../services/admin-alert-retention');
const NotificationService = require('../services/notification-service');
const { alertQuietFallOffMode } = require('../config/feature-gates');

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-05T15:00:00.000Z');
const old = new Date(now.getTime() - 100 * HOUR);
const row = (id, metadata = {}, extra = {}) => ({
  id, category: 'alert', created_at: old, created_at_cursor: old.toISOString(), version: `v-${id}`, metadata, ...extra,
});

// A fake io: pages come from `pages`; expire answers with the rows it was given.
function fakeIo({ pages = [], landed = null } = {}) {
  const calls = { limits: [], expired: [], saved: [], recorded: [] };
  return {
    calls,
    io: {
      page: async ({ limit }) => { calls.limits.push(limit); return (pages.shift() || []).slice(0, limit); },
      expire: async (rows, ctx) => { calls.expired.push({ ids: rows.map((r) => r.id), ctx }); return landed ? landed(rows) : rows.length; },
      loadCursor: async () => null,
      saveCursor: async (mode, cursor) => { calls.saved.push([mode, cursor]); },
      record: async (summary) => { calls.recorded.push(summary); },
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('GATE_ALERT_QUIET_FALL_OFF', () => {
  afterEach(() => { delete process.env.GATE_ALERT_QUIET_FALL_OFF; });
  test('only shadow and true count; unset and anything else is off', () => {
    expect(alertQuietFallOffMode()).toBe('off');
    for (const [value, mode] of [['shadow', 'shadow'], [' TRUE ', 'true'], ['1', 'off'], ['on', 'off'], ['false', 'off']]) {
      process.env.GATE_ALERT_QUIET_FALL_OFF = value;
      expect(alertQuietFallOffMode()).toBe(mode);
    }
  });

  test('off reads and writes nothing', async () => {
    const { io, calls } = fakeIo({ pages: [[row('a')]] });
    expect(await retention.runAdminAlertQuietPolicy({ now, mode: 'off', io })).toEqual({ skipped: true, reason: 'gate_off' });
    expect(calls.limits).toEqual([]);
    expect(calls.saved).toEqual([]);
  });

  test('shadow counts by category and logs; it writes and records nothing', async () => {
    const { io, calls } = fakeIo({ pages: [[row('a'), row('b'), row('c', {}, { category: 'schedule' })]] });
    const out = await retention.runAdminAlertQuietPolicy({ now, mode: 'shadow', io });
    expect(out).toMatchObject({ mode: 'shadow', scanned: 3, written: 3, expire: { total: 3, byCategory: { alert: 2, schedule: 1 } } });
    expect(calls.expired).toEqual([]);
    expect(calls.recorded).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shadow: scanned 3, would close 3'));
  });

  test('shadow counts past the live cap, and says when the scan stopped before the end', async () => {
    const pages = () => [[row('a'), row('b')], [row('c'), row('d')], [row('e')]];
    const stopped = fakeIo({ pages: pages() });
    const partial = await retention.runAdminAlertQuietPolicy({ now, mode: 'shadow', io: stopped.io, batchSize: 2, cap: 1, maxBatches: 2 });
    expect(partial).toMatchObject({ written: 4, expire: { total: 4 }, complete: false });
    expect(stopped.calls.limits).toEqual([2, 2]);
    const whole = fakeIo({ pages: pages() });
    const full = await retention.runAdminAlertQuietPolicy({ now, mode: 'shadow', io: whole.io, batchSize: 2, cap: 1 });
    expect(full).toMatchObject({ written: 5, complete: true });
  });
});

describe('a live pass', () => {
  test('closes as one batch through the retention writer, at the tick time, and records the run', async () => {
    const { io, calls } = fakeIo({ pages: [[row('a'), row('b')]] });
    const out = await retention.runAdminAlertQuietPolicy({ now, mode: 'true', io });
    expect(out).toMatchObject({ mode: 'true', scanned: 2, written: 2, runId: now.toISOString() });
    expect(calls.expired).toEqual([{ ids: ['a', 'b'], ctx: { runId: now.toISOString(), now } }]);
    expect(calls.recorded).toHaveLength(1);
    expect(calls.saved).toEqual([['true', null]]);
  });

  test('a run that closed nothing is not recorded (144 passes a day must not fill the run log)', async () => {
    const recent = row('fresh', { rungAt: new Date(now.getTime() - HOUR).toISOString() });
    const { io, calls } = fakeIo({ pages: [[recent]] });
    const out = await retention.runAdminAlertQuietPolicy({ now, mode: 'true', io });
    expect(out).toMatchObject({ written: 0, kept: { refreshed: 1 } });
    expect(calls.recorded).toEqual([]);
  });

  test('counts only the rows that landed (a ring between the read and the write wins)', async () => {
    const { io } = fakeIo({ pages: [[row('a'), row('b'), row('c')]], landed: (rows) => rows.length - 2 });
    expect((await retention.runAdminAlertQuietPolicy({ now, mode: 'true', io })).written).toBe(1);
  });

  test('a tick closes at most the cap, reading no more than it may still close', async () => {
    const { io, calls } = fakeIo({ pages: [[row('a'), row('b')], [row('c'), row('d')], [row('e'), row('f')]] });
    const out = await retention.runAdminAlertQuietPolicy({ now, mode: 'true', io, batchSize: 2, cap: 3 });
    expect(out.written).toBe(3);
    expect(calls.limits).toEqual([2, 1]);
    // The budget ran out with rows left: the place is saved for the next tick.
    expect(calls.saved[0][1]).toEqual({ at: old.toISOString(), id: 'c' });
  });
});

describe('what a pass judges', () => {
  const plan = (rows) => {
    const summary = { kept: { refreshed: 0 }, held: { periodic: 0 }, expire: { byCategory: {} } };
    return { due: retention.planQuietPage(rows, now, summary).map((r) => r.id), summary };
  };

  test('a recent sign of life keeps a row; an old one, junk and far-future stamps do not', () => {
    const { due, summary } = plan([
      row('rung', { rungAt: new Date(now.getTime() - 10 * HOUR).toISOString() }),
      row('hold', { quietHoldFrom: new Date(now.getTime() - 10 * HOUR).toISOString() }),
      row('observed', { observedAt: new Date(now.getTime() - 71.9 * HOUR).toISOString() }),
      row('stale', { rungAt: new Date(now.getTime() - 80 * HOUR).toISOString() }),
      row('junk', { rungAt: 'not a time', observedAt: 12 }),
      row('impossible', { rungAt: '2026-13-99T15:00:00Z', quietHoldFrom: '2026-02-31T10:00:00Z' }),
      row('future', { rungAt: new Date(now.getTime() + 400 * HOUR).toISOString() }),
    ]);
    expect(due).toEqual(['stale', 'junk', 'impossible', 'future']);
    expect(summary.kept.refreshed).toBe(3);
  });

  test('a row is held only when its FIRST registry match is periodic', () => {
    const { due, summary } = plan([
      row('send', { dedupeKey: 'payroll-mercury-key-send:x' }),
      row('poll', { dedupeKey: 'payroll-mercury-key:x' }),
      row('canary', { dedupeKey: 'sms-draft-canary:x' }),
      row('event', { dedupeKey: 'stock-shortfall:x' }),
      row('none', { dedupeKey: 'something-else:x' }),
    ]);
    expect(due).toEqual(['send', 'event', 'none']);
    expect(summary.held.periodic).toBe(2);
    const { RERING } = retention;
    const prefixes = RERING.flatMap((e) => e.prefixes);
    expect(prefixes.indexOf('payroll-mercury-key-send')).toBeLessThan(prefixes.indexOf('payroll-mercury-key'));
  });

  test('the money list is exactly the owner\'s eight categories (owner ruling 2026-11-05 "A")', () => {
    // billing and payment are money owed (payment_failed and bill_payment_error both write 'payment'); dispute, refund,
    // payout and payroll are money at risk; tax is money owed; llm_cost is spend.
    expect(retention.KEEP_UNTIL_SETTLED_CATEGORIES).toEqual(['billing', 'payment', 'dispute', 'refund', 'tax', 'payout', 'payroll', 'llm_cost']);
  });

  test('one list of stamps for both policies, the quiet closer matches the notification service, the run is a retention stamp', () => {
    expect(retention.ACTIVITY_STAMP_KEYS).toEqual(['rungAt', 'observedAt', 'lastFailureAt', NotificationService._private.QUIET_HOLD_KEY]);
    expect(retention.QUIET_BY).toBe(NotificationService._private.QUIET_FALL_OFF_DONE_BY);
    expect(retention.QUIET_RESOLUTION).toBe('No new activity for 3 days');
    expect(retention.QUIET_HOURS).toBe(72);
    expect(retention.QUIET_TICK_CAP).toBe(200);
  });
});

describe('the Reopen hold', () => {
  const { mergeRefreshMetadata, KEEP_DB_HOLD_SQL } = NotificationService._private;
  const held = { dedupeKey: 'k', quietHoldFrom: '2026-11-04T10:00:00.000Z' };
  test('a ring drops the hold stamp and stamps rungAt; a quiet refresh leaves it alone', () => {
    const rung = mergeRefreshMetadata(held, { dedupeKey: 'k' }, true);
    expect(rung.quietHoldFrom).toBeUndefined();
    expect(rung.rungAt).toEqual(expect.any(String));
    expect(mergeRefreshMetadata(held, { dedupeKey: 'k' }, false).quietHoldFrom).toBe(held.quietHoldFrom);
  });

  test('the refresh write keeps the DATABASE row\'s hold in SQL, with jsonb_exists and never a bare ? operator', () => {
    expect(KEEP_DB_HOLD_SQL).toContain("jsonb_exists(metadata, 'quietHoldFrom')");
    expect(KEEP_DB_HOLD_SQL).toContain("metadata -> 'quietHoldFrom'");
    // Two bindings only: the merged JSON and whether the refresh rang. A third ? would be a knex binding.
    expect(KEEP_DB_HOLD_SQL.match(/\?/g)).toHaveLength(2);
  });
});

describe('the 10-minute cron', () => {
  test('is registered once, gate-checked inside its try and before any lock, and calls the retention module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    const at = src.indexOf("cron.schedule('6,16,26,36,46,56 * * * *'");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 700);
    expect(block.indexOf('try {')).toBeLessThan(block.indexOf("alertQuietFallOffMode() === 'off'"));
    expect(block.indexOf("alertQuietFallOffMode() === 'off'")).toBeLessThan(block.indexOf('runExclusive('));
    expect(block).toContain("runExclusive('admin-alert-quiet-fall-off'");
    expect(block).toContain("require('./admin-alert-retention').runAdminAlertQuietPolicy()");
    expect(src.match(/'6,16,26,36,46,56 \* \* \* \*'/g)).toHaveLength(1);
  });
});
