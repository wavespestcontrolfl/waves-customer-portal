/**
 * Admin alert quiet fall-off, the parts that need no database: the gate states (off writes and reads nothing,
 * shadow reads only), what the closing UPDATE carries, the SQL scope both the read and the write share, the
 * per-tick cap, a ringing refresh dropping a Reopen's hold stamp, and the 10-minute cron. The rules against
 * live Postgres are in admin-alert-quiet-fall-off-db.test.js.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const logger = require('../services/logger');
const fallOff = require('../services/admin-alert-quiet-fall-off');
const NotificationService = require('../services/notification-service');
const { alertQuietFallOffMode } = require('../config/feature-gates');

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-05T15:00:00.000Z');
const offline = knex({ client: 'pg' });

// A fake connection: select pages come from `pages`, the closing UPDATE answers with the ids it was given.
function fakeConn({ pages = [], landed = null } = {}) {
  const calls = { selects: [], updates: [], transactions: 0 };
  const trx = (table) => {
    const q = { ids: null, patch: null };
    const b = {
      whereIn: (_col, ids) => { q.ids = ids; return b; },
      where: () => b, whereNull: () => b, whereRaw: () => b,
      update: (patch) => { q.patch = patch; calls.updates.push(q); return b; },
      returning: async () => (landed ? landed(q.ids) : q.ids.map((id) => ({ id, category: 'alert' }))),
    };
    expect(table).toBe('notifications');
    return b;
  };
  trx.raw = jest.fn((sql, bindings) => (String(sql).startsWith('SET LOCAL') ? Promise.resolve({}) : { sql, bindings }));
  trx.fn = { now: jest.fn() };
  const conn = (table) => {
    const b = {
      where: () => b, whereNull: () => b, whereRaw: () => b, select: () => b, orderBy: () => b,
      limit: (n) => { calls.selects.push(n); const page = pages.shift() || []; return Promise.resolve(page.slice(0, n)); },
    };
    expect(table).toBe('notifications');
    return b;
  };
  conn.transaction = async (fn) => { calls.transactions += 1; return fn(trx); };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  return { conn, calls };
}
const rows = (n, category = 'alert') => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, category }));

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
    const { conn, calls } = fakeConn({ pages: [rows(3)] });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'off', conn });
    expect(out).toEqual({ skipped: true, reason: 'gate_off' });
    expect(calls.selects).toEqual([]);
    expect(calls.transactions).toBe(0);
  });

  test('shadow counts by category and logs, and starts no write', async () => {
    const { conn, calls } = fakeConn({ pages: [[...rows(2, 'alert'), ...rows(1, 'schedule')]] });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'shadow', conn });
    expect(out).toMatchObject({ mode: 'shadow', scanned: 3, wouldClose: 3, closed: 0, byCategory: { alert: 2, schedule: 1 } });
    expect(calls.transactions).toBe(0);
    expect(calls.updates).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shadow: would close 3 of 3 candidate(s), by category {"alert":2,"schedule":1}'));
  });
});

describe('the closing write', () => {
  test('true marks done as quiet-72h with the plain resolution, at the tick time, keeping a person\'s read', async () => {
    const { conn, calls } = fakeConn({ pages: [rows(2)] });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'true', conn });
    expect(out).toMatchObject({ mode: 'true', scanned: 2, closed: 2, byCategory: { alert: 2 } });
    expect(calls.transactions).toBe(1);
    const { patch, ids } = calls.updates[0];
    expect(ids).toEqual(['id-0', 'id-1']);
    expect(patch.done_by).toBe('quiet-72h');
    expect(patch.done_at.sql).toBe('COALESCE(done_at, ?::timestamptz)');
    expect(patch.done_at.bindings).toEqual([now]);
    expect(patch.resolution.bindings).toEqual(['No new activity for 3 days', 'No new activity for 3 days']);
    expect(patch.read_at.sql).toContain('COALESCE(read_at');
  });

  test('counts only the rows that landed (a ring between the read and the write wins)', async () => {
    const { conn } = fakeConn({ pages: [rows(3)], landed: (ids) => [{ id: ids[0], category: 'alert' }] });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'true', conn });
    expect(out).toMatchObject({ scanned: 3, closed: 1 });
  });

  test('a tick closes at most the cap, reading no more than it may still close', async () => {
    const { conn, calls } = fakeConn({ pages: [rows(2), rows(2), rows(2)] });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'true', conn, pageSize: 2, cap: 3 });
    expect(out.closed).toBe(3);
    expect(calls.selects).toEqual([2, 1]);
  });

  test('a lock timeout skips the batch instead of waiting or throwing', async () => {
    const { conn } = fakeConn({ pages: [rows(2)] });
    const failing = Object.assign(() => { throw new Error('unused'); }, conn);
    failing.transaction = async () => { throw Object.assign(new Error('lock'), { code: '55P03' }); };
    const select = (table) => conn(table);
    const wrapped = Object.assign((table) => select(table), { transaction: failing.transaction, raw: conn.raw });
    const out = await fallOff.runAdminAlertQuietFallOff({ now, mode: 'true', conn: wrapped });
    expect(out.closed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped (55P03)'));
  });
});

describe('the scope the read and the write share', () => {
  const cutoff = new Date(now.getTime() - 72 * HOUR);
  const compiled = () => {
    const query = offline('notifications');
    fallOff.applyFallOffScope(query, { cutoff, now });
    return query.select('id').toSQL().toNative();
  };

  test('open admin bell rows only, never Activity-only or Claude-queue rows', () => {
    const { sql } = compiled();
    expect(sql).toContain('"recipient_type" = $1');
    expect(sql).toContain('"done_at" is null');
    expect(sql).toContain("COALESCE(metadata->>'feed', '') <> 'activity'");
    expect(sql).toContain("metadata->'claudeQueue' IS NULL");
    expect(sql).toContain("metadata->'sentToClaude' IS NULL");
  });

  test('the money categories are bound from the one exported list', () => {
    expect(fallOff.KEEP_UNTIL_SETTLED_CATEGORIES).toEqual(['billing', 'payment']);
    expect(compiled().bindings).toContainEqual(['billing', 'payment']);
  });

  test('a row stays open only when its FIRST registry match is periodic: the SQL is built from the ordered registry', () => {
    const { RERING } = require('../services/admin-alert-retention');
    const { bindings } = compiled();
    const [prefixes, kinds] = bindings.filter((b) => Array.isArray(b) && b.length > 2).slice(-2);
    expect(prefixes).toEqual(RERING.flatMap((e) => e.prefixes));
    expect(kinds).toEqual(RERING.flatMap((e) => e.prefixes.map(() => e.kind)));
    // The event entry for the send key is listed before the periodic prefix it overlaps.
    expect(prefixes.indexOf('payroll-mercury-key-send')).toBeLessThan(prefixes.indexOf('payroll-mercury-key'));
    const { sql } = fallOff.periodicHoldSql();
    expect(sql).toContain('WITH ORDINALITY');
    expect(sql).toContain('ORDER BY t.ord LIMIT 1');
  });

  test('last activity is created_at and the four stamps, a junk stamp cannot throw, and the cutoff is 72 hours back', () => {
    const { sql, bindings } = compiled();
    const expr = sql.match(/GREATEST\(created_at,.*\) < \$\d+::timestamptz/s)[0];
    for (const key of ['rungAt', 'observedAt', 'lastFailureAt', 'quietHoldFrom']) {
      expect(expr).toContain(`metadata->>'${key}'`);
      // An ISO-shaped but impossible time ('2026-13-99T15:00:00Z') is rejected before any cast.
      expect(expr).toContain(`pg_input_is_valid(metadata->>'${key}', 'timestamptz')`);
    }
    expect(expr.match(/CASE WHEN/g)).toHaveLength(8); // shape test, then future test, per stamp
    expect(bindings.filter((b) => typeof b === 'string' && b.startsWith('^[0-9]{4}-'))).toHaveLength(4);
    expect(bindings).toContain(cutoff.toISOString());
    expect(bindings).toContain(new Date(now.getTime() + 24 * HOUR).toISOString());
  });
});

describe('one definition of "a sign of life" for both sweeps', () => {
  test('the fall-off reads the retention sweep\'s own list, and it includes the Reopen hold stamp', () => {
    const retention = require('../services/admin-alert-retention');
    expect(retention.ACTIVITY_STAMP_KEYS).toEqual(['rungAt', 'observedAt', 'lastFailureAt', NotificationService._private.QUIET_HOLD_KEY]);
    const { sql } = fallOff.lastActivity(now);
    for (const key of retention.ACTIVITY_STAMP_KEYS) expect(sql).toContain(`metadata->>'${key}'`);
  });

  test('retention counts a Reopen\'s hold as activity and ignores an impossible time', () => {
    const { lastActivityMs } = require('../services/admin-alert-retention');
    const created = new Date('2026-09-01T00:00:00Z');
    const hold = '2026-11-05T10:00:00.000Z';
    const nowMs = new Date('2026-11-05T15:00:00Z').getTime();
    expect(lastActivityMs({ created_at: created }, { quietHoldFrom: hold }, nowMs)).toBe(Date.parse(hold));
    expect(lastActivityMs({ created_at: created }, { quietHoldFrom: '2026-13-99T15:00:00Z' }, nowMs)).toBe(created.getTime());
  });
});

describe('a ringing refresh and the Reopen hold', () => {
  const { mergeRefreshMetadata } = NotificationService._private;
  const held = { dedupeKey: 'k', quietHoldFrom: '2026-11-04T10:00:00.000Z' };
  test('a ring drops the hold stamp and stamps rungAt', () => {
    const out = mergeRefreshMetadata(held, { dedupeKey: 'k' }, true);
    expect(out.quietHoldFrom).toBeUndefined();
    expect(out.rungAt).toEqual(expect.any(String));
  });
  test('a quiet refresh leaves the hold alone', () => {
    expect(mergeRefreshMetadata(held, { dedupeKey: 'k' }, false).quietHoldFrom).toBe(held.quietHoldFrom);
  });
});

describe('the 10-minute cron', () => {
  test('is registered once, off the relevance sweep\'s minutes, gate-checked before any lock', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    const at = src.indexOf("cron.schedule('6,16,26,36,46,56 * * * *'");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 600);
    expect(block.indexOf("alertQuietFallOffMode() === 'off'")).toBeLessThan(block.indexOf('runExclusive('));
    expect(block).toContain("runExclusive('admin-alert-quiet-fall-off'");
    expect(src.match(/'6,16,26,36,46,56 \* \* \* \*'/g)).toHaveLength(1);
  });
});
