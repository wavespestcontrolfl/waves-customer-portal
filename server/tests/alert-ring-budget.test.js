/**
 * The admin bell's daily ring budget (GATE_ALERT_RING_BUDGET, services/alert-ring-budget.js): which rows are budgeted,
 * what the 11th does, the count row, fail-open, and gate off. No database: create() runs against an in-memory
 * connection. The same behavior against Postgres (ET midnight, the bell list, the real count row) is in
 * alert-ring-budget-db.test.js (CI).
 */
const mockState = { conn: null };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const handle = (...args) => mockState.conn(...args);
  handle.raw = (sql) => sql;
  return handle;
});
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'count-row' })),
}));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const compose = require('../services/admin-alert-compose');
const budget = require('../services/alert-ring-budget');
const NotificationService = require('../services/notification-service');

const DAY = '2026-11-05';
const today = () => require('../utils/datetime-et').etDateString();
const at = (iso) => new Date(iso);

// An in-memory notifications table behind just the query shapes the budget uses.
function makeConn(seed = []) {
  const store = seed.map((r, i) => ({ id: `s${i}`, recipient_type: 'admin', created_at: new Date(), ...r }));
  const inserted = [];
  const conn = () => {
    const q = {};
    const matched = () => store.filter((r) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      if (/ringBudgetDay/.test(q.sql || '')) return meta.ringBudgetDay === q.bind[0];
      if (/ringBudgetHeld/.test(q.sql || '')) return meta.ringBudgetHeld === q.bind[0];
      return true;
    });
    const chain = {
      where: () => chain,
      whereRaw: (sql, bind) => { q.sql = sql; q.bind = bind; return chain; },
      orderBy: () => chain,
      limit: () => chain,
      count: () => chain,
      first: async () => { if (conn.failCount) throw Object.assign(new Error('boom with a title in it'), { code: '57014' }); return { n: matched().length }; },
      select: async () => matched().map((r) => ({ title: r.title, created_at: r.created_at })),
      insert: (row) => {
        inserted.push(row);
        const out = { id: `n${inserted.length}`, ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
        store.push({ ...out, recipient_type: row.recipient_type, created_at: new Date() });
        return { returning: async () => [out] };
      },
    };
    return chain;
  };
  conn.raw = (sql) => sql;
  conn.inserted = inserted;
  conn.store = store;
  return conn;
}

const stamped = (n, day = DAY) => Array.from({ length: n }, (_, i) => ({ title: `Ring ${i}`, metadata: { ringBudgetDay: day } }));
const write = (conn, over = {}) => NotificationService.create({
  recipientType: 'admin', category: 'inventory', title: 'Low stock: gloves', body: 'Two boxes left.', link: '/admin/inventory', connection: conn, ...over,
});
const metaOfRow = (conn, i = conn.inserted.length - 1) => JSON.parse(conn.inserted[i].metadata);

beforeEach(() => {
  process.env.GATE_ALERT_RING_BUDGET = 'true';
  jest.clearAllMocks();
  mockState.conn = makeConn();
});
afterAll(() => { delete process.env.GATE_ALERT_RING_BUDGET; });

describe('exemption predicate', () => {
  test.each(budget.CUSTOMER_CATEGORIES)('customer category %s is exempt', (category) => {
    expect(budget.exemptReason({ category, metadata: {} })).toBe('customer_contact');
  });

  test.each(budget.SCORECARD_TRIGGER_KEYS)('scorecard trigger %s is exempt, whatever its category', (triggerKey) => {
    expect(budget.exemptReason({ category: 'alert', metadata: { triggerKey } })).toBe('customer_contact');
  });

  test('the weekly scorecard lists are pinned exactly', () => {
    expect([...budget.CUSTOMER_CATEGORIES]).toEqual(['inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'new_lead', 'estimate_hot_view']);
    expect([...budget.SCORECARD_TRIGGER_KEYS]).toEqual([
      'sms_reply', 'new_lead', 'customer_missed_call', 'customer_email_received', 'customer_voicemail_callback',
      'customer_landline_from_call', 'repeat_caller', 'appointment_reschedule_intent', 'reservice_self_booked',
      'bundle_quote_requested', 'estimate_hot_view',
    ]);
  });

  test('every lane the bell policy always admits is exempt', () => {
    const { _private } = jest.requireActual('../services/notification-bell-policy');
    for (const triggerKey of _private.TRIGGER_BELL_ALLOWLIST) {
      expect(budget.exemptReason({ category: 'alert', metadata: { triggerKey } })).not.toBeNull();
    }
    for (const category of _private.CATEGORY_BELL_ALLOWLIST) {
      expect(budget.exemptReason({ category, metadata: {} })).not.toBeNull();
    }
    for (const triggerKey of _private.GATED_TRIGGER_BELL_ALLOWLIST) {
      expect(budget.exemptReason({ category: 'payment', metadata: { triggerKey } })).not.toBeNull();
    }
  });

  test('a declared contact or promise is exempt', () => {
    expect(budget.exemptReason({ category: 'alert', metadata: { contact: true } })).toBe('customer_contact');
    expect(budget.exemptReason({ category: 'alert', metadata: { promise: true } })).toBe('promise');
    // Only the literal true declares it.
    expect(budget.exemptReason({ category: 'alert', metadata: { contact: 'yes', promise: 1 } })).toBeNull();
  });

  test.each(budget.PROMISE_TRIGGER_KEYS)('promise trigger %s is exempt', (triggerKey) => {
    expect(budget.exemptReason({ category: 'alert', metadata: { triggerKey } })).toBe('promise');
  });

  test('a dispatch notice is exempt by category or by dedupe key', () => {
    expect(budget.exemptReason({ category: 'schedule_conflict', metadata: {} })).toBe('dispatch');
    for (const dedupeKey of [
      'rain-pass:visit-1:2026-11-06:09:00', 'auto-dispatch-needs-person:v1:2026-11-06', 'auto-dispatch-reminder-sync:v1:2026-11-06:none',
      'auto-dispatch-reminder-sync-overflow:2026-11-06', 'auto-dispatch-missing-geo:v1:2026-11-06', 'auto-dispatch-proofreader:v1:2026-11-06:no-time:no-tech',
      'auto-dispatch-check-down', 'recurring-dispatch:v1:2026-11-06', 'recurring-no-window:v1:2026-11-06',
    ]) {
      expect(budget.exemptReason({ category: 'system', metadata: { dedupeKey } })).toBe('dispatch');
    }
    expect(budget.exemptReason({ category: 'system', dedupeKey: 'rain-pass:x', metadata: {} })).toBe('dispatch');
  });

  test('the dispatch list matches what the auto-dispatch code raises', () => {
    const dir = path.join(__dirname, '..', 'services', 'auto-dispatch');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(dir);
    const literals = new Set();
    const categories = new Set();
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/'((?:auto-dispatch-|recurring-dispatch:|recurring-no-window:|rain-pass:)[^'`$]*)'/g)) literals.add(m[1]);
      for (const m of src.matchAll(/raiseAdminAlert(?:WithReopen)?\(\s*'([a-z_]+)'/g)) categories.add(m[1]);
    }
    expect(literals.size).toBeGreaterThan(5);
    for (const key of literals) {
      expect(budget.exemptReason({ category: 'system', metadata: { dedupeKey: key } })).toBe('dispatch');
    }
    // The raise sites are the dispatch category plus the check-down notice (a system row under an auto-dispatch- key).
    expect([...categories].every((c) => c === 'schedule_conflict' || c === 'system')).toBe(true);
    expect(categories.has('schedule_conflict')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'check-down-notice.js'), 'utf8')).toMatch(/KEY = 'auto-dispatch-check-down'/);
  });

  test('every registry rule that declares contact or promise is exempt (the real registry)', () => {
    const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
    const declared = Object.entries(TRIGGER_REGISTRY).filter(([, t]) => t.rule?.contact === true || t.rule?.promise === true);
    expect(declared.length).toBeGreaterThan(10);
    for (const [triggerKey, trigger] of declared) {
      expect(budget.exemptReason({ category: trigger.category, metadata: { triggerKey } })).toEqual(expect.stringMatching(/^(customer_contact|promise)$/));
    }
  });

  test('time-critical field work (the combined-booking check\'s urgent case) is exempt; the same check without the marker is budgeted', () => {
    const base = { category: 'alert', metadata: { dedupeKey: 'combined-booking-check:e1', opsKey: 'combined-booking-check' } };
    expect(budget.exemptReason({ ...base, metadata: { ...base.metadata, timeCritical: true } })).toBe('time_critical');
    expect(budget.exemptReason(base)).toBeNull();
    expect(budget.exemptReason({ ...base, metadata: { ...base.metadata, timeCritical: 'true' } })).toBeNull();
  });

  test('an owner-only row is exempt, so its title can never reach the shared count row', () => {
    expect(budget.exemptReason({ category: 'alert', metadata: { ownerOnly: true } })).toBe('owner_only');
    expect(budget.exemptReason({ category: 'alert', metadata: { ownerOnly: 'true' } })).toBe('owner_only');
    expect(budget.exemptReason({ category: 'alert', metadata: { ownerOnly: false } })).toBeNull();
    expect(budget.exemptReason({ category: 'alert', metadata: { ownerOnly: 'false' } })).toBeNull();
  });

  test('the count row\'s read of held rows leaves out owner-only rows (second lock)', async () => {
    const sqls = [];
    const conn = makeConn();
    const real = conn;
    const spy = (...a) => { const c = real(...a); const w = c.whereRaw; c.whereRaw = (sql, b) => { sqls.push(sql); return w(sql, b); }; return c; };
    spy.raw = real.raw;
    mockState.conn = spy;
    await budget.writeCountRow(DAY, spy);
    expect(sqls.some((q) => /COALESCE\(metadata->>'ownerOnly', ''\) <> 'true'/.test(q))).toBe(true);
  });

  test('every tech-visible registry trigger is exempt, so a technician\'s bell never loses a row to the budget', () => {
    const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
    const techVisible = Object.entries(TRIGGER_REGISTRY).filter(([, t]) => t.techVisible);
    expect(techVisible.length).toBeGreaterThan(5);
    for (const [triggerKey, trigger] of techVisible) {
      expect(budget.exemptReason({ category: trigger.category, metadata: { triggerKey } })).not.toBeNull();
    }
    // The ones that are neither customer nor promise are exempt for being tech-visible.
    expect(budget.exemptReason({ category: 'alert', metadata: { triggerKey: 'twilio_failure' } })).toBe('tech_visible');
    expect(budget.exemptReason({ category: 'alert', metadata: { triggerKey: 'completion_sms_failed' } })).toBe('tech_visible');
    // Contrast: a registry trigger that is not tech-visible stays budgeted.
    const plain = Object.entries(TRIGGER_REGISTRY).find(([key, t]) => !t.techVisible && !t.rule?.contact && !t.rule?.promise
      && !budget.CUSTOMER_TRIGGER_KEYS.includes(key) && !budget.PROMISE_TRIGGER_KEYS.includes(key) && !budget.CUSTOMER_CATEGORIES.includes(t.category));
    expect(plain).toBeTruthy();
    expect(budget.exemptReason({ category: plain[1].category, metadata: { triggerKey: plain[0] } })).toBeNull();
  });

  test('the count row is exempt; an ordinary non-customer row and a bell:true row are budgeted', () => {
    expect(budget.exemptReason({ category: 'system', metadata: { ringBudget: 'count' } })).toBe('count_row');
    expect(budget.exemptReason({ category: 'inventory', metadata: {} })).toBeNull();
    expect(budget.exemptReason({ category: 'billing', metadata: { triggerKey: 'invoice_overdue_digest' } })).toBeNull();
    // A watchdog page and the combined-booking check are not auto-dispatch notices: budgeted.
    expect(budget.exemptReason({ category: 'alert', metadata: { dedupeKey: 'unpriced-series:abc' } })).toBeNull();
  });

  test('a registry rule that declares contact or promise is exempt without the alert carrying the flag', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/notification-triggers', () => ({
        TRIGGER_REGISTRY: { fake_contact: { rule: { contact: true } }, fake_promise: { rule: { promise: true } }, fake_plain: { rule: {} } },
      }));
      const isolated = require('../services/alert-ring-budget');
      expect(isolated.exemptReason({ category: 'alert', metadata: { triggerKey: 'fake_contact' } })).toBe('customer_contact');
      expect(isolated.exemptReason({ category: 'alert', metadata: { triggerKey: 'fake_promise' } })).toBe('promise');
      expect(isolated.exemptReason({ category: 'alert', metadata: { triggerKey: 'fake_plain' } })).toBeNull();
    });
    jest.dontMock('../services/notification-triggers');
  });
});

describe('budget decision', () => {
  test('nine stamped rings: the next rings and is stamped with the Eastern day', async () => {
    const conn = makeConn(stamped(9));
    const out = await budget.applyBudget({ connection: conn, category: 'inventory', metadata: { a: 1 }, now: at('2026-11-05T15:00:00Z') });
    expect(out).toMatchObject({ outcome: 'ring', day: DAY, metadata: { a: 1, ringBudgetDay: DAY } });
  });

  test('ten stamped rings: the 11th is held Activity-only, quiet, stamped held, and carries no ring stamp', async () => {
    const conn = makeConn(stamped(10));
    const out = await budget.applyBudget({ connection: conn, category: 'inventory', metadata: { a: 1, ringBudgetDay: 'old' }, now: at('2026-11-05T15:00:00Z') });
    expect(out.outcome).toBe('hold');
    expect(out.metadata).toEqual({ a: 1, feed: 'activity', quiet: true, ringBudgetHeld: DAY });
  });

  test('another day\'s stamps do not count', async () => {
    const conn = makeConn(stamped(10, '2026-11-04'));
    const out = await budget.applyBudget({ connection: conn, category: 'inventory', metadata: {}, now: at('2026-11-05T15:00:00Z') });
    expect(out.outcome).toBe('ring');
  });

  test.each([
    ['an Activity-only row', { feed: 'activity' }],
    ['a quiet row', { quiet: true }],
    ['a row routed to Claude\'s queue', { claudeQueue: 'sms-draft-canary' }],
  ])('%s is not budgeted: no count, no stamp', async (_label, metadata) => {
    const conn = makeConn(stamped(10));
    const out = await budget.applyBudget({ connection: conn, category: 'inventory', metadata, now: at('2026-11-05T15:00:00Z') });
    expect(out).toEqual({ outcome: 'skip', metadata });
  });

  test('an exempt row is never held, even past ten, and is not stamped', async () => {
    const conn = makeConn(stamped(25));
    const out = await budget.applyBudget({ connection: conn, category: 'inbound_sms', metadata: { x: 1 }, now: at('2026-11-05T15:00:00Z') });
    expect(out).toEqual({ outcome: 'exempt', metadata: { x: 1 } });
  });

  test('a count that cannot be read rings as before, still stamped, with one warning that carries no text', async () => {
    const conn = makeConn(stamped(30));
    conn.failCount = true;
    const out = await budget.applyBudget({ connection: conn, category: 'inventory', metadata: {}, now: at('2026-11-05T15:00:00Z') });
    expect(out).toMatchObject({ outcome: 'ring', metadata: { ringBudgetDay: DAY } });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/title/);
  });

  test('the Eastern day follows the zone: 11:59 PM EST and 12:01 AM EST are different days; the fall-back day is one day', async () => {
    const day = (iso) => budget.applyBudget({ connection: makeConn(), category: 'inventory', metadata: {}, now: at(iso) }).then((o) => o.day);
    expect(await day('2026-11-02T04:59:00Z')).toBe('2026-11-01');
    expect(await day('2026-11-02T05:01:00Z')).toBe('2026-11-02');
    // 1:30 AM happens twice on 2026-11-01 (EDT, then EST): same day.
    expect(await day('2026-11-01T05:30:00Z')).toBe('2026-11-01');
    expect(await day('2026-11-01T06:30:00Z')).toBe('2026-11-01');
    expect(await day('2026-11-01T03:59:00Z')).toBe('2026-10-31');
  });
});

describe('create()', () => {
  test('the first ten non-customer rows ring (stamped); the 11th is written Activity-only and held', async () => {
    const conn = makeConn();
    mockState.conn = conn;
    for (let i = 0; i < 10; i += 1) await write(conn, { title: `Alert ${i}`, metadata: { n: i } });
    expect(conn.inserted.map((r) => JSON.parse(r.metadata).ringBudgetDay).filter(Boolean)).toHaveLength(10);
    const eleventh = await write(conn, { title: 'Alert 10', metadata: { n: 10 } });
    const meta = metaOfRow(conn);
    expect(meta).toMatchObject({ feed: 'activity', quiet: true, ringBudgetHeld: expect.any(String), n: 10 });
    expect(meta).not.toHaveProperty('ringBudgetDay');
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(budget.isHeld(eleventh)).toBe(true);
  });

  test('customer contact past the budget still rings and is not stamped', async () => {
    const conn = makeConn(stamped(10, today()));
    await write(conn, { category: 'inbound_sms', title: 'Customer text', metadata: { n: 1 } });
    expect(metaOfRow(conn)).toEqual({ n: 1 });
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a row with no metadata at all is budgeted and gets the stamp', async () => {
    const conn = makeConn();
    await write(conn, {});
    expect(metaOfRow(conn)).toEqual({ ringBudgetDay: expect.any(String) });
  });

  test('a customer-recipient row is never touched', async () => {
    const conn = makeConn();
    await NotificationService.create({ recipientType: 'customer', recipientId: 'c1', category: 'service', title: 'T', body: 'B', connection: conn, metadata: { a: 1 } });
    expect(JSON.parse(conn.inserted[0].metadata)).toEqual({ a: 1 });
  });

  test('gate off: the row is written exactly as before, nothing counted, no count row', async () => {
    process.env.GATE_ALERT_RING_BUDGET = '';
    const conn = makeConn(stamped(40, today()));
    await write(conn, { metadata: { a: 1 } });
    expect(JSON.parse(conn.inserted[0].metadata)).toEqual({ a: 1 });
    await write(conn, {});
    expect(conn.inserted[1].metadata).toBeNull();
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a count failure never fails or blocks the write', async () => {
    const conn = makeConn();
    conn.failCount = true;
    const out = await write(conn, { metadata: { a: 1 } });
    expect(out.id).toBe('n1');
    expect(JSON.parse(conn.inserted[0].metadata)).toMatchObject({ a: 1, ringBudgetDay: expect.any(String) });
  });

  test('a count row that cannot be written leaves the held row written and the call successful', async () => {
    const conn = makeConn(stamped(10, today()));
    mockState.conn = conn;
    compose.raiseAdminAlert.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40001' }));
    const out = await write(conn, {});
    expect(out.id).toBe('n1');
    expect(budget.isHeld(out)).toBe(true);
  });

  test('a held row written on a caller\'s transaction waits for the outermost commit and is skipped on rollback', async () => {
    let settle;
    const executionPromise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const conn = makeConn(stamped(10, today()));
    conn.isTransaction = true;
    conn.executionPromise = executionPromise;
    mockState.conn = makeConn(); // the committed read the count row makes
    await write(conn, {});
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
    settle.reject(new Error('rolled back'));
    await executionPromise.catch(() => {});
    await new Promise((r) => setImmediate(r));
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();

    // A commit writes it.
    let commit;
    const committed = new Promise((resolve) => { commit = resolve; });
    const conn2 = makeConn(stamped(10, today()));
    conn2.isTransaction = true;
    conn2.executionPromise = committed;
    const readConn = makeConn([{ title: 'Alert A', metadata: { ringBudgetHeld: today() } }]);
    mockState.conn = readConn;
    await write(conn2, {});
    commit();
    await committed;
    await new Promise((r) => setImmediate(r));
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
  });
});

describe('count row', () => {
  const held = (titles) => titles.map((title, i) => ({ title, created_at: new Date(`2026-11-05T${String(14 + i).padStart(2, '0')}:05:00Z`), metadata: { ringBudgetHeld: DAY } }));

  test('it is composed as System, fyi, who person, linked to Activity, and passes the composer limits at every size', async () => {
    for (const n of [1, 2, 19, 20, 21, 120]) {
      const composed = compose.composeAdminAlert(budget.countSpec(DAY, n));
      expect(composed.headline).toBe(`System — ${n} more alert${n === 1 ? '' : 's'} held today`);
      expect(composed.headline.length).toBeLessThanOrEqual(compose.MAX_HEADLINE_CHARS);
      expect(composed.why.length).toBeLessThanOrEqual(compose.MAX_WHY_CHARS);
      expect(composed.link).toBe('/admin/agents?tab=activity');
      expect(composed.metadata).toMatchObject({ area: 'System', severity: 'fyi', who: 'person' });
    }
  });

  test('writeCountRow: one keyed fyi bell row, its first write is the ring, later writes are quiet refreshes', async () => {
    const conn = makeConn(held(['Low stock: gloves', 'Vendor receipt needs a look', 'Gate code changed']));
    await budget.writeCountRow(DAY, conn);
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('system');
    expect(spec).toMatchObject({ area: 'System', action: '3 more alerts held today', severity: 'fyi', who: 'person' });
    expect(opts).toMatchObject({ fyiRow: true, bell: true, dedupeKey: `ring-budget:${DAY}`, refreshOnDedupe: true });
    expect(opts.metadata).toMatchObject({ ringBudget: 'count', heldCount: 3 });
    // Never budgeted: it carries the exempt mark and no ring stamp.
    expect(opts.metadata).not.toHaveProperty('ringBudgetDay');
    expect(budget.exemptReason({ category: 'system', metadata: opts.metadata })).toBe('count_row');
    // A refresh never rings.
    expect(opts.ringOnRefresh()).toBe(false);
    // The detail lists the held alerts, Eastern time first.
    expect(opts.detail.split('\n')).toEqual([
      '9:05 AM — Low stock: gloves', '10:05 AM — Vendor receipt needs a look', '11:05 AM — Gate code changed',
    ]);
  });

  test('the detail names each held alert by its own headline and its Eastern time, so the owner can act from the count row', () => {
    const detail = budget.detailFor([
      { title: "Schedule — fix J. Sample's combined booking", created_at: new Date('2026-11-05T18:40:00Z') },
      { title: 'Inventory — gloves are low', created_at: new Date('2026-11-05T21:05:00Z') },
    ]);
    expect(detail).toBe("1:40 PM — Schedule — fix J. Sample's combined booking\n4:05 PM — Inventory — gloves are low");
    // The link opens the Agents Activity tab, which loads GET /admin/agents/activity (the "Held alerts" source).
    expect(budget.countSpec(DAY, 2).link).toBe('/admin/agents?tab=activity');
  });

  test('the refresh re-reads the held rows inside the key\'s lock: new count and list, quiet', async () => {
    const conn = makeConn(held(['One']));
    await budget.writeCountRow(DAY, conn);
    const opts = compose.raiseAdminAlert.mock.calls[0][2];
    conn.store.push(...held(['One', 'Two']).slice(1).map((r, i) => ({ id: `x${i}`, recipient_type: 'admin', ...r })));
    const adjusted = await opts.standingRefresh();
    expect(adjusted).toMatchObject({ title: 'System — 2 more alerts held today', quiet: true, link: '/admin/agents?tab=activity', metadata: { heldCount: 2 } });
    expect(adjusted.detail.split('\n')).toHaveLength(2);
    expect(adjusted.body.length).toBeLessThanOrEqual(compose.MAX_WHY_CHARS);
  });

  test('the list stops at 20 and says how many more', () => {
    const rows = Array.from({ length: 27 }, (_, i) => ({ title: `Alert ${i}`, created_at: new Date('2026-11-05T15:00:00Z') }));
    const lines = budget.detailFor(rows).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe('10:00 AM — Alert 19');
    expect(lines[20]).toBe('+7 more');
    expect(budget.detailFor(rows.slice(0, 20)).split('\n')).toHaveLength(20);
  });

  test('a long title is cut in the list', () => {
    const [line] = budget.detailFor([{ title: 'x'.repeat(300), created_at: new Date('2026-11-05T15:00:00Z') }]).split('\n');
    expect(line.length).toBeLessThan(110);
    expect(line.endsWith('…')).toBe(true);
  });

  test('the refresh read runs on the transaction notifyAdmin passes, never on the pool', async () => {
    const pool = makeConn(held(['One']));
    await budget.writeCountRow(DAY, pool);
    const opts = compose.raiseAdminAlert.mock.calls[0][2];
    const poolReads = [];
    const poolSpy = (...a) => { poolReads.push(a); return pool(...a); };
    poolSpy.raw = pool.raw;
    const trxReads = [];
    const trx = makeConn(held(['One', 'Two']));
    const trxSpy = (...a) => { trxReads.push(a); return trx(...a); };
    trxSpy.raw = trx.raw;
    // Re-compose against the spied pool, as a caller holding it would.
    compose.raiseAdminAlert.mockClear();
    await budget.writeCountRow(DAY, poolSpy);
    const refresh = compose.raiseAdminAlert.mock.calls[0][2].standingRefresh;
    poolReads.length = 0;
    const adjusted = await refresh({}, {}, trxSpy);
    expect(poolReads).toHaveLength(0);
    expect(trxReads.length).toBeGreaterThan(0);
    expect(adjusted.title).toBe('System — 2 more alerts held today');
    expect(opts.standingRefresh).toEqual(expect.any(Function));
  });

  test('nothing held: no count row', async () => {
    await expect(budget.writeCountRow(DAY, makeConn())).resolves.toBeNull();
    expect(compose.raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('refresh of a held row', () => {
  const todayDay = today();

  test('a row held today refreshes quietly; one held on an earlier day takes the ordinary refresh; gate off never holds', () => {
    expect(budget.heldToday({ ringBudgetHeld: todayDay })).toBe(true);
    expect(budget.heldToday({ ringBudgetHeld: '2020-01-01' })).toBe(false);
    expect(budget.heldToday({})).toBe(false);
    expect(budget.heldToday(JSON.stringify({ ringBudgetHeld: todayDay }))).toBe(true);
    process.env.GATE_ALERT_RING_BUDGET = '';
    expect(budget.heldToday({ ringBudgetHeld: todayDay })).toBe(false);
  });

  test('a held row that is refreshed by an exempt emission (it became time-critical) is not kept quiet', () => {
    const held = { ringBudgetHeld: todayDay };
    expect(budget.heldToday(held, { category: 'alert', metadata: { note: 'x' } })).toBe(true);
    expect(budget.heldToday(held, { category: 'alert', metadata: { timeCritical: true } })).toBe(false);
    expect(budget.heldToday(held, { category: 'inbound_sms', metadata: {} })).toBe(false);
  });

  test('a held row is promoted only by a time-critical emission, on any day, and only while the gate is on', () => {
    expect(budget.promotesHeld({ ringBudgetHeld: '2020-01-01' }, { timeCritical: true })).toBe(true);
    expect(budget.promotesHeld({ ringBudgetHeld: todayDay }, JSON.stringify({ timeCritical: true }))).toBe(true);
    expect(budget.promotesHeld({ ringBudgetHeld: todayDay }, { note: 'x' })).toBe(false);
    expect(budget.promotesHeld({ ringBudgetHeld: todayDay }, { timeCritical: 'true' })).toBe(false);
    expect(budget.promotesHeld({ feed: 'activity' }, { timeCritical: true })).toBe(false);
    process.env.GATE_ALERT_RING_BUDGET = '';
    expect(budget.promotesHeld({ ringBudgetHeld: todayDay }, { timeCritical: true })).toBe(false);
  });

  test('a ringing refresh brings a held row back into the bell and drops the held stamp', () => {
    const { mergeRefreshMetadata } = NotificationService._private;
    const out = mergeRefreshMetadata({ dedupeKey: 'k', feed: 'activity', quiet: true, ringBudgetHeld: '2020-01-01' }, { dedupeKey: 'k', note: 'x' }, true);
    expect(out).not.toHaveProperty('ringBudgetHeld');
    expect(out.feed).toBeNull();
    expect(out.quiet).toBe(false);
  });

  test('a quiet refresh keeps the held stamp and the Activity-only feed', () => {
    const { mergeRefreshMetadata } = NotificationService._private;
    const out = mergeRefreshMetadata({ dedupeKey: 'k', feed: 'activity', quiet: true, ringBudgetHeld: todayDay }, { dedupeKey: 'k', note: 'x' }, false);
    expect(out).toMatchObject({ feed: 'activity', quiet: true, ringBudgetHeld: todayDay, note: 'x' });
  });
});

describe('gate reader', () => {
  test('strict true only; a feature-gates mock without the reader reads as off', () => {
    for (const value of ['TRUE', '1', 'yes', ' true', '']) {
      process.env.GATE_ALERT_RING_BUDGET = value;
      expect(budget.enabled()).toBe(false);
    }
    process.env.GATE_ALERT_RING_BUDGET = 'true';
    expect(budget.enabled()).toBe(true);
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
      expect(require('../services/alert-ring-budget').enabled()).toBe(false);
    });
    jest.dontMock('../config/feature-gates');
  });
});

describe('push-only recipients (every admin has bell entries off)', () => {
  const metadata = { triggerKey: 'dashboard_alert', priority: 'normal', payload: {} };
  const recorder = () => { const rows = []; return { rows, write: jest.fn(async (m) => { rows.push(m); return { id: 'r1', metadata: m }; }) }; };

  test('within the budget the push goes and an Activity-only record counts it for the day', async () => {
    const { rows, write } = recorder();
    const out = await budget.budgetPushOnly({ connection: makeConn(stamped(9, today())), category: 'alert', metadata, write });
    expect(out).toEqual({ held: false });
    expect(rows[0]).toMatchObject({ feed: 'activity', quiet: true, severity: 'fyi', ringBudgetPushOnly: true, ringBudgetDay: today(), triggerKey: 'dashboard_alert' });
  });

  test('past the budget the push is held: a held row is written and the count row follows', async () => {
    const { rows, write } = recorder();
    const conn = makeConn(stamped(10, today()));
    mockState.conn = conn;
    const out = await budget.budgetPushOnly({ connection: conn, category: 'alert', metadata, write });
    expect(out).toEqual({ held: true });
    expect(rows[0]).toMatchObject({ feed: 'activity', quiet: true, ringBudgetHeld: today() });
    expect(rows[0]).not.toHaveProperty('ringBudgetDay');
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('an exempt alert is untouched, and a failed record write reads as not held (the push goes)', async () => {
    const { write } = recorder();
    expect(await budget.budgetPushOnly({ connection: makeConn(stamped(30, today())), category: 'inbound_sms', metadata: {}, write })).toEqual({ held: false });
    expect(write).not.toHaveBeenCalled();
    const failing = jest.fn(async () => null);
    expect(await budget.budgetPushOnly({ connection: makeConn(stamped(30, today())), category: 'alert', metadata, write: failing })).toEqual({ held: false });
    const throwing = jest.fn(async () => { throw new Error('x'); });
    expect(await budget.budgetPushOnly({ connection: makeConn(stamped(30, today())), category: 'alert', metadata, write: throwing })).toEqual({ held: false });
  });
});

describe('Activity feed item', () => {
  test('a held alert reads as a digest item under Held alerts; its stamped severity sets the status', () => {
    const { buildActivity } = require('../services/agent-activity');
    const row = (id, title, meta) => ({ id, title, body: 'b', detail: null, link: '/admin/inventory', metadata: meta, read_at: null, done_at: null, created_at: new Date('2026-11-05T15:00:00Z') });
    const feed = buildActivity({ held: [
      row('h1', 'Plain', { ringBudgetHeld: DAY }),
      row('h2', 'Needs you', { ringBudgetHeld: DAY, severity: 'needs-you' }),
      { ...row('h3', 'Done', { ringBudgetHeld: DAY, severity: 'needs-you' }), done_at: new Date('2026-11-05T16:00:00Z') },
    ] });
    const byTitle = Object.fromEntries(feed.items.map((i) => [i.title, i]));
    expect(feed.agents).toEqual(['Held alerts']);
    expect(byTitle.Plain).toMatchObject({ kind: 'digest', status: 'completed', notificationId: 'h1', subtitle: 'held past the daily limit \u00b7 FYI' });
    expect(byTitle['Needs you']).toMatchObject({ status: 'awaiting_review', subtitle: 'held past the daily limit \u00b7 needs you' });
    expect(byTitle.Done).toMatchObject({ status: 'completed', subtitle: 'held past the daily limit \u00b7 done' });
  });
});

describe('isHeld', () => {
  test('reads the held stamp from an object or string metadata; a suppressed or empty result is not held', () => {
    expect(budget.isHeld({ id: 'a', metadata: { ringBudgetHeld: DAY } })).toBe(true);
    expect(budget.isHeld({ id: 'a', metadata: JSON.stringify({ ringBudgetHeld: DAY }) })).toBe(true);
    expect(budget.isHeld({ id: 'a', metadata: { feed: 'activity' } })).toBe(false);
    expect(budget.isHeld({ id: null, suppressed: true, metadata: { ringBudgetHeld: DAY } })).toBe(false);
    expect(budget.isHeld(null)).toBe(false);
    expect(budget.isHeld(undefined)).toBe(false);
  });
});
