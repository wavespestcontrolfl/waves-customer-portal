/**
 * Lead-to-cash invariants sweep — registry runner, report composer, send
 * gating (fail-closed recipient, 20h marker), and the adapter contract of
 * every registered detector. No DB: `../models/db` is a chainable mock.
 */
const path = require('path');
const fs = require('fs');

const mockTables = {};
function mockChain(cfg = {}) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'andWhere', 'whereRaw', 'orWhereRaw',
    'whereExists', 'whereNotExists', 'leftJoin', 'join', 'orderBy', 'orderByRaw', 'limit', 'modify', 'forUpdate', 'insert', 'onConflict', 'update', 'count']) {
    b[m] = jest.fn(() => b);
  }
  b.select = jest.fn(async () => cfg.select ?? []);
  b.first = jest.fn(async () => cfg.first ?? null);
  b.merge = jest.fn(async () => (cfg.merge ?? 1));
  b.columnInfo = jest.fn(async () => cfg.columnInfo ?? {});
  b.then = (res, rej) => Promise.resolve(cfg.select ?? []).then(res, rej);
  return b;
}
jest.mock('../models/db', () => {
  const mock = jest.fn((table) => mockTables[String(table).split(' ')[0]] || (mockTables.__default = mockTables.__default || mockChain()));
  mock.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.schema = { hasTable: jest.fn(async () => false) };
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn(async () => ({})) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

// Detector dependencies — mocked so each adapter's SHAPE is tested, not the
// predicates (which own their own suites).
jest.mock('../scripts/audit-churned-accounts-live-state', () => ({ auditChurnedAccountsLiveState: jest.fn() }));
jest.mock('../scripts/align-waveguard-portal-records', () => ({ scanAlignment: jest.fn() }));
jest.mock('../services/recurring-schedule-audit', () => ({ auditRecurringScheduleAnomalies: jest.fn() }));
jest.mock('../services/stale-visit-sweep', () => ({ _private: { findStaleVisits: jest.fn(), countsByStatus: jest.fn(() => ({ pending: 1 })) } }));
jest.mock('../services/estimate-conversion-guard', () => ({ convertedOpenEstimatesQuery: jest.fn() }));
jest.mock('../config/completion-lane-registry', () => ({
  ALL_LISTS: { A: ['known_key', 'gone_key', 'absent_by_design_key'] },
  ABSENT_FROM_PROD_BY_DESIGN_KEYS: ['absent_by_design_key'],
  classifyCatalogRow: jest.fn(),
}));
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));
jest.mock('../services/new-recurring-welcome-sms', () => ({ findFirstPlansWithoutWelcome: jest.fn(), WELCOME_AUDIT_WINDOW_DAYS: 14, WELCOME_AUDIT_GRACE_HOURS: 3 }));
jest.mock('../services/customer-properties', () => ({
  customersWithStreetLineHoldingLocality: jest.fn(), customersWithUnpinnedSavedAddress: jest.fn(), customersWithIncompleteAddress: jest.fn(),
}));
jest.mock('../services/completion-record-invariants', () => {
  const keys = ['completed_visit_without_record', 'duplicate_completed_records_per_visit',
    'completed_record_without_report_token', 'completed_visit_without_completed_at',
    'completed_record_without_comms_marker', 'aged_incomplete_visit_records'];
  return {
    PREDICATE_KEYS: keys,
    PREDICATES: Object.fromEntries(keys.map((k) => [k, { label: `P ${k}`, href: '/admin/dispatch', sql: 'SELECT 1' }])),
    runPredicate: jest.fn(),
  };
});

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const { isEnabled, gateEnvValue } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const opsDigest = require('../services/ops-digest');
const { auditChurnedAccountsLiveState } = require('../scripts/audit-churned-accounts-live-state');
const { scanAlignment } = require('../scripts/align-waveguard-portal-records');
const { auditRecurringScheduleAnomalies } = require('../services/recurring-schedule-audit');
const staleSweep = require('../services/stale-visit-sweep');
const { convertedOpenEstimatesQuery } = require('../services/estimate-conversion-guard');
const { classifyCatalogRow } = require('../config/completion-lane-registry');
const { getCloseoutStatus } = require('../services/closeout-status');
const { customersWithStreetLineHoldingLocality, customersWithUnpinnedSavedAddress, customersWithIncompleteAddress } = require('../services/customer-properties');
const { runPredicate } = require('../services/completion-record-invariants');
const {
  runLeadToCashInvariantSweep, DETECTORS,
  _private: {
    runDetectors, composeReport, failingItems, itemHashes, hasNewItem,
    SEND_MARKER_KEY, RECORD_KEY, STANDING_KEY, RUN_STATE_KEY, REPEAT_AFTER_MS, ITEM_KEYS_CAP, SAMPLE_IDS, CLOSEOUT_VISIT_CAP,
  },
} = require('../services/lead-to-cash-invariants');

const NOW = new Date('2026-06-15T10:55:00Z'); // 06:55 ET, any fixed instant (no near-today literal semantics)
const det = (key, run) => ({ key, label: `L ${key}`, href: '/admin/x', provenance: 'test', run });
const ok = (key) => det(key, async () => ({ count: 0, ids: [] }));

beforeEach(() => {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  gateEnvValue.mockReturnValue(false);
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.LEAD_TO_CASH_SWEEP_EMAIL;
});

describe('registry contract', () => {
  test('every detector has a unique key, label, href, provenance and an async run', () => {
    const keys = DETECTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['churned_live_state', 'waveguard_alignment_drift', 'converted_open_estimates', 'closeout_failed_facts']));
    for (const d of DETECTORS) {
      expect(typeof d.label).toBe('string');
      expect(d.href.startsWith('/admin/')).toBe(true);
      expect(typeof d.provenance).toBe('string');
      expect(typeof d.run).toBe('function');
    }
    expect(Object.isFrozen(DETECTORS)).toBe(true);
  });

  // A check whose query is bound to a look-back or look-ahead date can lose a finding with nothing fixed, so its failures
  // post as records, never in the standing list a clean run closes. A new detector with such a date filter joins this list.
  test('the moving-window checks are the closeout day, the 14-day welcome audit and the ghost lanes', () => {
    expect(DETECTORS.filter((d) => d.moving).map((d) => d.key).sort())
      .toEqual(['closeout_failed_facts', 'completion_lane_ghost_lanes', 'new_plan_without_welcome']);
    // Only the closeout check reads a different window on each run (yesterday).
    expect(DETECTORS.filter((d) => d.freshEachRun).map((d) => d.key)).toEqual(['closeout_failed_facts']);
    for (const d of DETECTORS) if (d.freshEachRun) expect(d.moving).toBe(true);
  });

  test('scheduler registers the sweep at 6:55 ET with a lazy require and job_health rethrow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const i = src.indexOf("cron.schedule('55 6 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('lead-to-cash-invariants'");
    expect(block).toContain("require('./lead-to-cash-invariants')");
    expect(block).toContain("skipped === 'recipient'");
    expect(block).toContain("timezone: 'America/New_York'");
    // #3208 rule: the minute must not be shared with another daily job.
    expect(src.match(/cron\.schedule\('55 6 \* \* \*'/g)).toHaveLength(1);
  });
});

describe('runDetectors', () => {
  test('isolates a throwing detector as unavailable, caps samples, keeps the rest running', async () => {
    const many = Array.from({ length: SAMPLE_IDS + 5 }, (_, i) => `id-${i}`);
    const results = await runDetectors({
      now: NOW,
      detectors: [
        det('boom', async () => { throw new Error('pg down with phone 941-555-0100'); }),
        det('big', async () => ({ count: many.length, ids: many, detail: { a: 1 } })),
        ok('fine'),
      ],
    });
    expect(results.map((r) => [r.key, r.ok, r.unavailable])).toEqual([['boom', false, true], ['big', false, false], ['fine', true, false]]);
    expect(results[0].error).toBe('Error'); // allowlisted token only — the phone number never reaches the report
    expect(JSON.stringify(results)).not.toContain('941');
    const logger = require('../services/logger');
    expect(logger.error.mock.calls[0][0]).toContain('[redacted-number]');
    expect(results[1].sample).toHaveLength(SAMPLE_IDS);
    expect(results[1].truncated).toBe(true);
    expect(results[1].count).toBe(SAMPLE_IDS + 5);
    expect(results[2].sample).toEqual([]);
  });
});

describe('runDetectors honors a detector-reported truncation', () => {
  test('a SQL-capped sample with a larger count is marked truncated so composeReport prints the +N suffix', async () => {
    const d = det('capped', async () => ({ count: 100, ids: ['a', 'b'], truncated: true }));
    const [r] = await runDetectors({ now: NOW, detectors: [d] });
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(100);
    const report = composeReport([r], { now: NOW });
    expect(report.text).toContain('a, b … +98 more');
  });
});

describe('composeReport', () => {
  test('FIX subject counts violations and unrunnable checks; body lists OK/FAIL/?? with ids only', async () => {
    const results = await runDetectors({
      now: NOW,
      detectors: [
        det('a', async () => ({ count: 2, ids: ['x1', 'x<2>'], detail: { tier: 2 } })),
        det('b', async () => ({ count: 1, ids: ['y1'] })),
        det('c', async () => { const e = new Error('nope'); e.code = 'ECONNRESET'; throw e; }),
        ok('d'),
      ],
    });
    const r = composeReport(results, { now: NOW });
    expect(r.subject).toMatch(/^FIX: lead-to-cash invariants — 3 violations across 2 checks; 1 check could not run \(\d{4}-\d{2}-\d{2}\)$/);
    expect(r.text).toContain('FAIL a — 2: L a');
    expect(r.text).toContain('tier=2');
    expect(r.text).toContain('x1, x<2>');
    expect(r.text).toContain('??   c — could not run (ECONNRESET); see server log');
    expect(r.text).not.toContain('nope');
    expect(r.text).toContain('OK   d');
    expect(r.text).toContain('nothing was changed');
    expect(r.html).toContain('x&lt;2&gt;');
    expect(r.text).not.toMatch(/@|\d{3}-\d{4}/); // ids and counts only
    expect(r.total).toBe(3);
    expect(r.unavailable).toBe(1);
  });

  test('singular grammar', async () => {
    const results = await runDetectors({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['x'] }))] });
    expect(composeReport(results, { now: NOW }).subject).toMatch(/^FIX: lead-to-cash invariants — 1 violation across 1 check \(/);
  });
});

describe('runLeadToCashInvariantSweep', () => {
  test('gate off → no detector runs, no db, no mail', async () => {
    isEnabled.mockReturnValue(false);
    const run = jest.fn();
    expect(await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', run)] })).toEqual({ skipped: 'gated' });
    expect(run).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('clean sweep sends nothing and stamps nothing', async () => {
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [ok('a'), ok('b')] });
    expect(res).toEqual({ skipped: 'clean', results: { a: 0, b: 0 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalledWith('ops_email_send_state');
  });

  test('a clean next window cannot resolve a prior closeout license failure alert', async () => {
    gateEnvValue.mockReturnValue(true);
    const alert = { id: 'prior-closeout-alert', read_at: null, metadata: null };
    NotificationService.notifyAdmin.mockImplementation(async (_category, _title, _body, options) => {
      alert.metadata = options.metadata;
      return alert;
    });
    // A retire, as the database applies it: only the rows of the key it names.
    const resolve = jest.spyOn(opsDigest, 'resolveOpsDigest').mockImplementation(async ({ key }) => {
      if (alert.metadata?.opsKey !== key) return 0;
      alert.read_at = 'resolved';
      alert.metadata.resolved = true;
      return 1;
    });
    try {
      const closeout = DETECTORS.find((d) => d.key === 'closeout_failed_facts');
      mockTables.scheduled_services = mockChain({ select: [{ id: 'old-visit' }] });
      getCloseoutStatus.mockResolvedValue({ found: true, summary: { failed: ['license_current'], contradictions: [] } });
      expect(await runLeadToCashInvariantSweep({ now: NOW, detectors: [closeout] })).toMatchObject({ sent: true, violations: 1 });
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(alert.metadata).toMatchObject({ opsKey: 'lead-to-cash-invariants' });
      expect(alert.metadata).not.toHaveProperty('fallOff');

      mockTables.scheduled_services = mockChain({ select: [] });
      const nextWindow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
      expect(await runLeadToCashInvariantSweep({ now: nextWindow, detectors: [closeout] })).toEqual({
        skipped: 'clean', results: { closeout_failed_facts: 0 },
      });
      expect(getCloseoutStatus).toHaveBeenCalledTimes(1); // The older visit was not rechecked.
      // The clean run closes the standing list only. The closeout failure is a record under its own key.
      expect(resolve).toHaveBeenCalled();
      for (const [args] of resolve.mock.calls) expect(args).toEqual({ key: STANDING_KEY, source: null, resolvedBy: `${STANDING_KEY}:clean-run` });
      expect(alert.metadata.opsKey).toBe(RECORD_KEY);
      expect(alert.read_at).toBeNull();
      expect(alert.metadata).not.toHaveProperty('resolved');
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });

  test('violation → one FIX email to the internal inbox, then the send marker is stamped', async () => {
    mockTables.ops_email_send_state = mockChain({ first: null });
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [ok('a'), det('b', async () => ({ count: 1, ids: ['v1'] }))] });
    expect(res).toMatchObject({ sent: true, violations: 1, unavailable: 0, results: { a: 0, b: 1 } });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const mail = sendgrid.sendOne.mock.calls[0][0];
    expect(mail.to).toBe('contact@wavespestcontrol.com');
    expect(mail.subject).toMatch(/^FIX: lead-to-cash invariants — 1 violation across 1 check/);
    expect(mail.categories).toEqual(['ops', 'lead-to-cash-invariants']);
    expect(mail.text).toContain('v1');
    expect(mockTables.ops_email_send_state.insert).toHaveBeenCalledWith(expect.objectContaining({ email_key: SEND_MARKER_KEY }));
    expect(mockTables.ops_email_send_state.onConflict).toHaveBeenCalledWith('email_key');
  });

  test('an unrunnable check alone is an exception (fail closed) and emails', async () => {
    mockTables.ops_email_send_state = mockChain({ first: null });
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => { throw new Error('x'); })] });
    expect(res).toMatchObject({ sent: true, violations: 0, unavailable: 1, results: { a: 'unavailable' } });
    expect(sendgrid.sendOne.mock.calls[0][0].subject).toMatch(/1 check could not run/);
  });

  test('recent send marker → skipped recent_send, no mail, marker untouched', async () => {
    mockTables.ops_email_send_state = mockChain({ first: { last_sent_at: new Date(Date.now() - 60 * 60 * 1000) } });
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['v'] }))] });
    expect(res).toEqual({ skipped: 'recent_send', results: { a: 1 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
  });

  test('stale marker (>20h) does not block the send', async () => {
    mockTables.ops_email_send_state = mockChain({ first: { last_sent_at: new Date(Date.now() - 21 * 60 * 60 * 1000) } });
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['v'] }))] });
    expect(res.sent).toBe(true);
  });

  test('non-internal recipient env → skipped recipient, nothing leaves', async () => {
    process.env.LEAD_TO_CASH_SWEEP_EMAIL = 'someone@example.com';
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['v'] }))] });
    expect(res).toEqual({ skipped: 'recipient', results: { a: 1 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('sendgrid unconfigured → skipped unconfigured', async () => {
    sendgrid.isConfigured.mockReturnValue(false);
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['v'] }))] });
    expect(res).toEqual({ skipped: 'unconfigured', results: { a: 1 } });
  });

  test('send failure → error send_failed and NO marker stamp (next tick retries)', async () => {
    mockTables.ops_email_send_state = mockChain({ first: null });
    sendgrid.sendOne.mockRejectedValueOnce(new Error('sg 500'));
    const res = await runLeadToCashInvariantSweep({ now: NOW, detectors: [det('a', async () => ({ count: 1, ids: ['v'] }))] });
    expect(res).toEqual({ error: 'send_failed', results: { a: 1 } });
    expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
  });
});

// Owner 2026-11-20 "go" (data-check audit step 4). The sweep posted one alert every morning; most checks read standing
// state, so the same list came back daily (45 alerts in 45 days, each closed by hand). In the app it now keeps a
// STANDING LIST (one open alert, replaced on a new failing check or weekly, closed by a clean run) and RECORDS (one
// immutable row when a moving-window check has a finding the last run did not have). The email path is unchanged and
// is covered above.
describe('two alerts, not one a day (in the app)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const fails = (key, count = 1) => det(key, async () => ({ count, ids: Array.from({ length: count }, (_, i) => `${key}-${i}`) }));
  // A moving-window check that returns `out` (default: one finding for each id).
  const moving = (key, ids, { freshEachRun = false, out = {} } = {}) => ({ ...det(key, async () => ({ count: ids.length, ids, ...out })), moving: true, freshEachRun });
  const closeout = (ids) => moving('closeout_failed_facts', ids, { freshEachRun: true });
  const welcome = (ids, extra) => moving('new_plan_without_welcome', ids, extra);
  const posts = () => NotificationService.notifyAdmin.mock.calls.map(([, title, , options]) => ({ title, ...options }));
  const keysPosted = () => posts().map((post) => post.metadata.opsKey);
  // The run state the sweep reads (undefined = no row). It also clears the 20 h send marker.
  const setState = (state) => {
    mockTables.ops_email_send_state = mockChain({ first: null });
    mockTables.system_settings = mockChain({ first: state === undefined ? null : { value: JSON.stringify(state) } });
  };
  const lastRun = (items, alertedAgoMs, seen = {}) => setState(items === undefined ? undefined : {
    items, alertedAt: alertedAgoMs == null ? null : new Date(NOW.getTime() - alertedAgoMs).toISOString(), seen,
  });
  const savedState = () => {
    const call = mockTables.system_settings.insert.mock.calls.at(-1);
    return call ? { key: call[0].key, ...JSON.parse(call[0].value) } : null;
  };
  // The next run reads what this run saved.
  const carry = () => {
    const { key, ...state } = savedState();
    expect(key).toBe(RUN_STATE_KEY);
    setState(state);
  };
  const sweep = (detectors, now = NOW) => runLeadToCashInvariantSweep({ now, detectors });
  const after = (days) => new Date(NOW.getTime() + days * DAY);
  const row = async (_category, _title, _body, options) => ({ id: `row-${NotificationService.notifyAdmin.mock.calls.length}`, metadata: options.metadata });
  let resolve;

  beforeEach(() => {
    gateEnvValue.mockReturnValue(true);
    NotificationService.notifyAdmin.mockImplementation(row);
    NotificationService._private = { openToCloser: (q) => q, doneColumns: () => ({}) };
    mockTables.notifications = mockChain();
    resolve = jest.spyOn(opsDigest, 'resolveOpsDigest').mockResolvedValue(0);
  });
  afterEach(() => {
    resolve.mockRestore();
    delete NotificationService._private;
    NotificationService.notifyAdmin.mockReset();
    sendgrid.sendOne.mockReset();
    sendgrid.sendOne.mockImplementation(async () => ({}));
  });

  describe('the standing list', () => {
    test('the first failing run posts one standing alert: its own key, pinned, and it replaces the older one', async () => {
      lastRun(undefined);
      const res = await sweep([fails('a', 3), ok('b')]);
      expect(res).toEqual({ sent: true, violations: 3, unavailable: 0, results: { a: 3, b: 0 } });
      expect(posts()).toHaveLength(1);
      const [post] = posts();
      expect(post.metadata).toMatchObject({ opsKey: STANDING_KEY, fallOff: true, kind: 'FIX', audience: 'engineering' });
      expect(post.metadata.subject).toMatch(/^FIX: lead-to-cash standing list — 3 violations across 1 check \(/);
      expect(post.detail).toContain('Standing list: one open alert.');
      expect(post).not.toHaveProperty('dedupeKey'); // a new row each time, so the nightly tab sees a new alert
      // supersedePrior: every older open row of the STANDING key closes; the record key is never named.
      expect(mockTables.notifications.whereRaw).toHaveBeenCalledWith("metadata->>'opsKey' = ?", [STANDING_KEY]);
      expect(mockTables.notifications.whereRaw).not.toHaveBeenCalledWith("metadata->>'opsKey' = ?", [RECORD_KEY]);
      expect(mockTables.notifications.update).toHaveBeenCalledTimes(1);
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, items: ['a'], alertedAt: NOW.toISOString(), seen: {} });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the same failing check with a higher count posts nothing and keeps the time of the last alert', async () => {
      lastRun(['b'], DAY);
      expect(await sweep([ok('a'), fails('b', 9)])).toEqual({ skipped: 'no_new_item', results: { a: 0, b: 9 } });
      expect(posts()).toHaveLength(0);
      expect(resolve).not.toHaveBeenCalled(); // the list still stands: nothing is closed
      expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, items: ['b'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), seen: {} });
    });

    test('a check that was not failing on the last run posts a new alert', async () => {
      lastRun(['b'], DAY);
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ sent: true, violations: 2 });
      expect(keysPosted()).toEqual([STANDING_KEY]);
      expect(savedState()).toMatchObject({ items: ['a', 'b'], alertedAt: NOW.toISOString() });
    });

    test('a check that cleared and came back is new: the last RUN is the comparison, not the last alert', async () => {
      lastRun(['a', 'b'], 2 * DAY);
      expect(await sweep([fails('a'), ok('b')])).toMatchObject({ skipped: 'no_new_item' });
      expect(savedState().items).toEqual(['a']); // b cleared: it is no longer on the list
      carry();
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ sent: true });
    });

    test('a check that cannot run where it failed before is a new item', async () => {
      lastRun(['b'], DAY);
      expect(await sweep([det('b', async () => { throw new Error('x'); })])).toMatchObject({ sent: true, unavailable: 1 });
      expect(failingItems([{ key: 'b', ok: false, unavailable: true }, { key: 'a', ok: false }, { key: 'c', ok: true }])).toEqual(['a', 'b:unavailable']);
    });

    test('an unchanged list posts again on the 7th daily run after the last alert, not on the 6th', async () => {
      // The 6th run is 6 days after the alert; the 7th is 7 days, give or take the cron's seconds of jitter.
      expect(REPEAT_AFTER_MS).toBeGreaterThan(6 * DAY + 60 * 60 * 1000);
      expect(REPEAT_AFTER_MS).toBeLessThan(7 * DAY - 60 * 60 * 1000);
      lastRun(['b'], 6 * DAY + 30 * 1000);
      expect(await sweep([fails('b')])).toMatchObject({ skipped: 'no_new_item' });
      lastRun(['b'], 7 * DAY - 30 * 1000);
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
    });

    test('a run state that is missing, unreadable or has no alert time never hides a finding', async () => {
      lastRun(undefined);
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      setState(undefined);
      mockTables.system_settings = mockChain({ first: { value: '{not json' } });
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      mockTables.system_settings = mockChain();
      mockTables.system_settings.first = jest.fn(async () => { throw new Error('relation does not exist'); });
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      lastRun(['b'], null);
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      expect(posts()).toHaveLength(4);
    });

    test('a clean run closes the standing list by its own key and empties the run state', async () => {
      lastRun(['b'], DAY, { new_plan_without_welcome: ['0123456789abcdef'] });
      resolve.mockResolvedValue(1);
      expect(await sweep([ok('a'), ok('b')])).toEqual({ skipped: 'clean', results: { a: 0, b: 0 } });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ key: STANDING_KEY, source: null, resolvedBy: `${STANDING_KEY}:clean-run` });
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, items: [], alertedAt: null, seen: {} });
      expect(posts()).toHaveLength(0);
    });

    test('the feed write fails and the fallback email goes out: the state stays, so the next run writes the alert', async () => {
      lastRun(['a'], DAY);
      NotificationService.notifyAdmin.mockResolvedValueOnce(null); // no row: the seam sends the email
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ sent: true });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      // The feed holds no alert for `b`, so `b` is not on the list and the alert time did not move.
      expect(savedState()).toMatchObject({ items: ['a'], alertedAt: new Date(NOW.getTime() - DAY).toISOString() });
      carry();
      expect(await sweep([fails('a'), fails('b')], after(1))).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([STANDING_KEY, STANDING_KEY]);
      expect(savedState()).toMatchObject({ items: ['a', 'b'], alertedAt: after(1).toISOString() });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('records (moving-window checks)', () => {
    test('a moving-window failure posts as a record: the old key, one immutable row', async () => {
      lastRun([], DAY);
      expect(await sweep([ok('a'), closeout(['visit-1 [license_current]'])])).toMatchObject({ sent: true, violations: 1 });
      expect(posts()).toHaveLength(1);
      const [post] = posts();
      expect(post.metadata).toMatchObject({ opsKey: RECORD_KEY, kind: 'FIX' });
      expect(post.metadata.subject).toMatch(/^FIX: lead-to-cash invariants — 1 violation across 1 check \(/);
      // Nothing can resolve a record, so it is not pinned, not deduped or refreshed, and it replaces nothing.
      expect(post.metadata).not.toHaveProperty('fallOff');
      expect(post).not.toHaveProperty('dedupeKey');
      expect(post).not.toHaveProperty('refreshOnDedupe');
      expect(mockTables.notifications.update).not.toHaveBeenCalled();
      // The record lists the moving-window checks only; the standing checks have their own alert.
      expect(post.detail).toContain('FAIL closeout_failed_facts — 1');
      expect(post.detail).not.toContain('OK   a');
      // The run state keeps the finding as a hash: no record id.
      expect(savedState().seen).toEqual({ closeout_failed_facts: [expect.stringMatching(/^[0-9a-f]{16}$/)] });
      expect(JSON.stringify(savedState())).not.toContain('visit-1');
    });

    test('a closeout failure never joins or disturbs the standing list (the pinned alert stays)', async () => {
      // Day 2 of a standing failure, with a closeout failure beside it: one record, no new standing alert, no close.
      lastRun(['a'], DAY);
      expect(await sweep([fails('a', 5), closeout(['v1 [x]'])])).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([RECORD_KEY]);
      expect(posts()[0].detail).not.toContain('FAIL a');
      expect(resolve).not.toHaveBeenCalled();
      expect(mockTables.notifications.update).not.toHaveBeenCalled(); // nothing superseded
      expect(savedState()).toMatchObject({ items: ['a'], alertedAt: new Date(NOW.getTime() - DAY).toISOString() });
      // The day after, with the closeout check clean: the standing alert still stands and nothing posts.
      carry();
      expect(await sweep([fails('a', 5), closeout([])], after(1))).toMatchObject({ skipped: 'no_new_item' });
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a new standing check and a moving-window failure on the same run post one alert each', async () => {
      lastRun(['a'], DAY);
      expect(await sweep([fails('a'), fails('b'), welcome(['c1'])])).toMatchObject({ sent: true, violations: 3 });
      expect(keysPosted()).toEqual([STANDING_KEY, RECORD_KEY]);
      expect(posts()[0].detail).not.toContain('new_plan_without_welcome');
    });

    test('with every standing check clean, a moving-window failure still lets the standing list close', async () => {
      lastRun(['a'], DAY);
      expect(await sweep([ok('a'), welcome(['c1'])])).toMatchObject({ sent: true });
      expect(resolve).toHaveBeenCalledWith({ key: STANDING_KEY, source: null, resolvedBy: `${STANDING_KEY}:clean-run` });
      expect(resolve).not.toHaveBeenCalledWith(expect.objectContaining({ key: RECORD_KEY }));
      expect(savedState()).toMatchObject({ items: [] });
    });

    test('a finding that stays in its window is one record, however long it stays', async () => {
      lastRun([], DAY);
      expect(await sweep([welcome(['c1', 'c2'])])).toMatchObject({ sent: true });
      for (const day of [1, 2, 13, 40]) { // no time limit: an unchanged finding never posts a second record
        carry();
        expect(await sweep([welcome(['c2', 'c1'])], after(day))).toMatchObject({ skipped: 'no_new_item' });
      }
      expect(posts()).toHaveLength(1);
    });

    test('a new finding posts a record; one that leaves does not; one that comes back does', async () => {
      lastRun([], DAY);
      await sweep([welcome(['c1'])]);
      carry();
      expect(await sweep([welcome(['c1', 'c2'])], after(1))).toMatchObject({ sent: true }); // c2 is new
      carry();
      expect(await sweep([welcome(['c2'])], after(2))).toMatchObject({ skipped: 'no_new_item' }); // c1 left
      expect(savedState().seen.new_plan_without_welcome).toHaveLength(1);
      carry();
      expect(await sweep([welcome(['c1', 'c2'])], after(3))).toMatchObject({ sent: true }); // c1 is back
      expect(posts()).toHaveLength(3);
    });

    test('every finding counts, not only the ones in the display sample', async () => {
      const many = (last) => [...Array.from({ length: SAMPLE_IDS }, (_, i) => `c${String(i).padStart(2, '0')}`), last];
      lastRun([], DAY);
      await sweep([welcome(many('zz-first'))]);
      carry();
      // Same count, same first SAMPLE_IDS ids: only the finding past the sample changed.
      expect(await sweep([welcome(many('zz-second'))], after(1))).toMatchObject({ sent: true });
      expect(posts()).toHaveLength(2);
    });

    test('the closeout check reads a new day on each run: the same failure on two days is two records', async () => {
      lastRun([], DAY);
      expect(await sweep([closeout(['v1 [x]'])])).toMatchObject({ sent: true });
      carry();
      expect(await sweep([closeout(['v1 [x]'])])).toMatchObject({ skipped: 'no_new_item' }); // a rerun on the same day
      carry();
      expect(await sweep([closeout(['v1 [x]'])], after(1))).toMatchObject({ sent: true });
      // "Could not run" on two days is two records too; on a check with a standing window it is one.
      const down = (key, extra) => ({ ...det(key, async () => { throw new Error('x'); }), moving: true, ...extra });
      carry();
      expect(await sweep([down('closeout_failed_facts', { freshEachRun: true })], after(2))).toMatchObject({ sent: true });
      carry();
      expect(await sweep([down('closeout_failed_facts', { freshEachRun: true })], after(3))).toMatchObject({ sent: true });
      carry();
      expect(await sweep([down('new_plan_without_welcome')], after(4))).toMatchObject({ sent: true });
      carry();
      expect(await sweep([down('new_plan_without_welcome')], after(5))).toMatchObject({ skipped: 'no_new_item' });
      expect(posts()).toHaveLength(5);
    });

    test('a ghost lane is one record while it stands, whatever its visit count; cleared and back = a new record', async () => {
      const ghosts = (upcoming) => moving('completion_lane_ghost_lanes', upcoming ? [`old_pest (generic: archived_service_with_upcoming_visits:${upcoming})`] : [], {
        out: { itemKeys: upcoming ? ['old_pest'] : [] },
      });
      lastRun([], DAY);
      expect(await sweep([ghosts(3)])).toMatchObject({ sent: true });
      carry();
      expect(await sweep([ghosts(2)], after(30))).toMatchObject({ skipped: 'no_new_item' }); // a visit passed
      carry();
      expect(await sweep([ghosts(1)], after(90))).toMatchObject({ skipped: 'no_new_item' }); // months later
      carry();
      expect(await sweep([ghosts(0)], after(91))).toMatchObject({ skipped: 'clean' });
      expect(savedState().seen).toEqual({});
      carry();
      expect(await sweep([ghosts(4)], after(92))).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([RECORD_KEY, RECORD_KEY]);
    });

    test('a list that does not name every finding: the count shows a new one', async () => {
      const capped = (count) => welcome(['c1'], { out: { count, truncated: true } });
      lastRun([], DAY);
      await sweep([capped(30)]);
      carry();
      expect(await sweep([capped(30)], after(1))).toMatchObject({ skipped: 'no_new_item' });
      carry();
      expect(await sweep([capped(31)], after(2))).toMatchObject({ sent: true });
      // A failing check that names no finding at all still posts.
      carry();
      expect(await sweep([capped(31), moving('other_window', [], { out: { count: 2 } })], after(3))).toMatchObject({ sent: true });
      expect(posts()).toHaveLength(3);
      // The run state keeps at most ITEM_KEYS_CAP findings for one check, plus the count.
      const big = { key: 'w', ok: false, unavailable: false, freshEachRun: false, listCapped: false, count: ITEM_KEYS_CAP + 5, itemKeys: Array.from({ length: ITEM_KEYS_CAP + 5 }, (_, i) => `id-${i}`) };
      expect(itemHashes(big, NOW)).toHaveLength(ITEM_KEYS_CAP + 1);
      expect(hasNewItem(itemHashes({ ...big, count: big.count + 1 }, NOW), itemHashes(big, NOW))).toBe(true);
      expect(hasNewItem(itemHashes(big, NOW), itemHashes(big, after(9)))).toBe(false);
    });
  });

  describe('a failed send', () => {
    const sendFails = () => {
      NotificationService.notifyAdmin.mockResolvedValueOnce(null); // no row: the seam falls back to the email
      sendgrid.sendOne.mockRejectedValueOnce(new Error('sg 500'));
    };

    test('nothing reached anyone: the run fails and the state keeps every item new for the next run', async () => {
      lastRun(['b'], DAY);
      sendFails();
      expect(await sweep([fails('a'), fails('b')])).toEqual({ error: 'send_failed', results: { a: 1, b: 1 } });
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, items: ['b'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), seen: {} });
      expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
      carry();
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ sent: true });
    });

    test('a fallback email the mailer refuses is a failed send too', async () => {
      lastRun(['b'], DAY);
      NotificationService.notifyAdmin.mockResolvedValueOnce(null);
      sendgrid.sendOne.mockResolvedValueOnce({ ok: false, error: 'refused' });
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ error: 'send_failed' });
      expect(savedState()).toMatchObject({ items: ['b'] });
    });

    test('the standing alert fails: the record of the same run still posts, and a rerun posts only what is missing', async () => {
      lastRun(['a'], DAY);
      sendFails(); // the standing alert is tried first
      expect(await sweep([fails('a'), fails('b'), closeout(['v1 [x]'])])).toEqual({ error: 'send_failed', results: { a: 1, b: 1, closeout_failed_facts: 1 } });
      expect(keysPosted()).toEqual([STANDING_KEY, RECORD_KEY]); // both were tried
      // The record is in the feed; the standing alert is not, so `b` stays new and the 20 h marker stays unset.
      expect(savedState()).toMatchObject({ items: ['a'], seen: { closeout_failed_facts: [expect.any(String)] } });
      expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
      carry();
      expect(await sweep([fails('a'), fails('b'), closeout(['v1 [x]'])])).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([STANDING_KEY, RECORD_KEY, STANDING_KEY]);
    });

    test('the record fails: the standing alert still posts, and the finding stays new for the next run', async () => {
      lastRun(['a'], DAY);
      NotificationService.notifyAdmin.mockImplementationOnce(row); // the standing alert
      sendFails(); // the record
      expect(await sweep([fails('a'), fails('b'), welcome(['c1'])])).toMatchObject({ error: 'send_failed' });
      expect(savedState()).toMatchObject({ items: ['a', 'b'], alertedAt: NOW.toISOString(), seen: { new_plan_without_welcome: [] } });
      carry();
      expect(await sweep([fails('a'), fails('b'), welcome(['c1'])], after(1))).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([STANDING_KEY, RECORD_KEY, RECORD_KEY]);
    });

    test('the feed write fails for a record and the fallback email goes out: the next run writes the record', async () => {
      lastRun([], DAY);
      NotificationService.notifyAdmin.mockResolvedValueOnce(null);
      expect(await sweep([welcome(['c1'])])).toMatchObject({ sent: true });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(savedState().seen).toEqual({ new_plan_without_welcome: [] });
      carry();
      expect(await sweep([welcome(['c1'])], after(1))).toMatchObject({ sent: true });
      expect(savedState().seen.new_plan_without_welcome).toHaveLength(1);
    });
  });
});

describe('detector adapters', () => {
  const byKey = (k) => DETECTORS.find((d) => d.key === k);

  test('churned_live_state passes the shared db and maps ids/counts', async () => {
    auditChurnedAccountsLiveState.mockResolvedValue({ churned: 9, withLiveState: 2, counts: { tier: 2 }, findings: [{ id: 'c1', flags: ['tier=Gold'] }, { id: 'c2', flags: ['tier=Bronze'] }] });
    const out = await byKey('churned_live_state').run({ now: NOW });
    expect(auditChurnedAccountsLiveState).toHaveBeenCalledWith({ db });
    expect(out).toEqual({ count: 2, ids: ['c1', 'c2'], detail: { tier: 2 } });
  });

  test('waveguard_alignment_drift invokes the scan with NO onRepair and no enrollment pass', async () => {
    scanAlignment.mockResolvedValue({ checkedCustomers: 40, repairs: [{ customerId: 'm1' }], noPlanEnrollments: 0, noServiceEvidence: ['m2'], tierMismatches: [{}] });
    const out = await byKey('waveguard_alignment_drift').run({ now: NOW });
    expect(scanAlignment).toHaveBeenCalledTimes(1);
    const opts = scanAlignment.mock.calls[0][0];
    expect(opts.onRepair).toBeUndefined();
    expect(opts.enrollNoPlan).toBeFalsy();
    expect(out).toEqual({ count: 1, ids: ['m1'], detail: { checked: 40, tierMismatches: 1, noServiceEvidence: 1 } });
  });

  test('recurring_schedule_anomalies groups by check type and lists appointment ids (no names)', async () => {
    auditRecurringScheduleAnomalies.mockResolvedValue({ anomalyCount: 2, anomalies: [
      { checkType: 'cadence', appointmentId: 'a1', customerName: 'SHOULD NOT LEAK' }, { checkType: 'cadence', appointmentId: 'a2' },
    ] });
    const out = await byKey('recurring_schedule_anomalies').run({ now: NOW });
    expect(auditRecurringScheduleAnomalies).toHaveBeenCalledWith({}, db);
    expect(out).toEqual({ count: 2, ids: ['a1', 'a2'], detail: { cadence: 2 } });
    expect(JSON.stringify(out)).not.toContain('SHOULD NOT LEAK');
  });

  test('stale_open_visits reuses the sweep finder and status counts', async () => {
    staleSweep._private.findStaleVisits.mockResolvedValue([{ id: 's1', status: 'pending' }]);
    const out = await byKey('stale_open_visits').run({ now: NOW });
    expect(staleSweep._private.findStaleVisits).toHaveBeenCalledWith(NOW);
    expect(out).toEqual({ count: 1, ids: ['s1'], detail: { pending: 1 } });
  });

  test.each([
    ['street_line_holds_locality', customersWithStreetLineHoldingLocality],
    ['saved_address_without_pin', customersWithUnpinnedSavedAddress],
    ['address_missing_city_or_zip', customersWithIncompleteAddress],
  ])('%s reports its finder\'s customer ids on the shared db', async (key, finder) => {
    finder.mockResolvedValue(['c1', 'c2']);
    const out = await byKey(key).run({ now: NOW });
    expect(finder).toHaveBeenCalledWith(db);
    expect(out).toEqual({ count: 2, ids: ['c1', 'c2'] });
  });

  test('converted_open_estimates selects ids from the guard\'s own query builder', async () => {
    const q = mockChain({ select: [{ id: 'e1' }] });
    convertedOpenEstimatesQuery.mockReturnValue(q);
    const out = await byKey('converted_open_estimates').run({ now: NOW });
    expect(q.select).toHaveBeenCalledWith('estimates.id');
    expect(q.update).not.toHaveBeenCalled();
    expect(out).toEqual({ count: 1, ids: ['e1'] });
  });

  test('completion_lane_coverage counts flagged active rows plus registry-only keys', async () => {
    mockTables.services = mockChain({ select: [{ service_key: 'known_key' }, { service_key: 'bad_key' }] });
    // second call (registry lookup) resolves the same table mock — known_key present, gone_key absent
    classifyCatalogRow.mockImplementation((row) => row.service_key === 'bad_key' ? { lane: 'generic', flags: ['no_profile'] } : { lane: 'ok', flags: [] });
    const out = await byKey('completion_lane_coverage').run({ now: NOW });
    expect(out.count).toBe(2);
    expect(out.ids).toEqual(['bad_key (generic: no_profile)', 'registry-only:gone_key']);
    expect(out.detail).toEqual({ activeServices: 2 });
    // The catalog check reads present state only: the date-bound ghost-lane query is its own check.
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('completion_lane_ghost_lanes: the query is date-bound to today (ET) and mirrors the canonical audit', async () => {
    db.raw.mockResolvedValueOnce({ rows: [] });
    expect(await byKey('completion_lane_ghost_lanes').run({ now: NOW })).toEqual({ count: 0, ids: [], itemKeys: [] });
    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toContain("ss.status NOT IN ('completed', 'cancelled', 'skipped')");
    expect(sql).toContain("regexp_replace(ss.service_type, '\\s+service$', '', 'i')");
    expect(sql).toContain('(s.is_active = false OR s.is_archived = true)');
    expect(bindings).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
  });

  test('completion_lane_ghost_lanes: inactive/archived services still routing upcoming visits are defects (ghost lanes)', async () => {
    classifyCatalogRow.mockImplementation((row) => row.service_key === 'old_pest' ? { lane: 'generic', flags: ['no_profile'] } : { lane: 'ok', flags: [] });
    db.raw.mockResolvedValueOnce({ rows: [
      { service_key: 'old_pest', is_archived: true, upcoming: '3' },
      { service_key: 'paused_lawn', is_archived: false, upcoming: 1 },
    ] });
    const out = await byKey('completion_lane_ghost_lanes').run({ now: NOW });
    expect(out.count).toBe(2);
    expect(out.ids).toEqual([
      'old_pest (generic: archived_service_with_upcoming_visits:3,no_profile)',
      'paused_lawn (ok: inactive_service_with_upcoming_visits:1)',
    ]);
    // The id text holds the visit count, which falls as visits pass. The finding is the service.
    expect(out.itemKeys).toEqual(['old_pest', 'paused_lawn']);
  });

  test('completion_lane_coverage: a key absent from prod by design is not registry-only, but an active row or ghost lane for it is still a defect', async () => {
    mockTables.services = mockChain({ select: [{ service_key: 'known_key' }, { service_key: 'absent_by_design_key' }] });
    classifyCatalogRow.mockImplementation((row) => row.service_key === 'absent_by_design_key' ? { lane: 'generic', flags: ['no_profile'] } : { lane: 'ok', flags: [] });
    db.raw.mockResolvedValueOnce({ rows: [{ service_key: 'absent_by_design_key', is_archived: true, upcoming: '2' }] });
    const out = await byKey('completion_lane_coverage').run({ now: NOW });
    expect(out.ids).toEqual(['absent_by_design_key (generic: no_profile)', 'registry-only:gone_key']);
    expect(out.ids).not.toContain('registry-only:absent_by_design_key');
    expect(out.count).toBe(2);
    const ghosts = await byKey('completion_lane_ghost_lanes').run({ now: NOW });
    expect(ghosts.ids).toEqual(['absent_by_design_key (generic: archived_service_with_upcoming_visits:2,no_profile)']);
  });

  test('closeout_failed_facts flags failed facts/contradictions and treats unevaluable visits as findings', async () => {
    mockTables.scheduled_services = mockChain({ select: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }, { id: 'v4' }] });
    getCloseoutStatus
      .mockResolvedValueOnce({ found: true, unavailable: [], summary: { failed: [], contradictions: [] } })
      .mockResolvedValueOnce({ found: true, unavailable: [], summary: { failed: ['invoice'], contradictions: ['invoice_on_non_performed_visit'] } })
      .mockResolvedValueOnce({ found: true, unavailable: [{ lookup: 'service_records' }], summary: { failed: [], contradictions: [] } })
      .mockResolvedValueOnce({ found: false, lookupFailed: true });
    const out = await byKey('closeout_failed_facts').run({ now: NOW });
    expect(getCloseoutStatus).toHaveBeenCalledWith('v1', { knex: db, now: NOW });
    expect(mockTables.scheduled_services.where).toHaveBeenCalledWith({ status: 'completed', scheduled_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(mockTables.scheduled_services.limit).toHaveBeenCalledWith(CLOSEOUT_VISIT_CAP + 1);
    expect(out.count).toBe(3);
    expect(out.ids).toEqual(['v2 [invoice,invoice_on_non_performed_visit]', 'v3 [unevaluable:service_records]', 'v4 [unevaluable:not_found]']);
    expect(out.detail).toMatchObject({ checked: 4, unevaluable: 2, truncated: false });
  });

  test('closeout_failed_facts: visits beyond the cap make the day a finding, never a silent pass', async () => {
    const rows = Array.from({ length: CLOSEOUT_VISIT_CAP + 1 }, (_, i) => ({ id: `v${i}` }));
    mockTables.scheduled_services = mockChain({ select: rows, first: { n: String(CLOSEOUT_VISIT_CAP + 7) } });
    getCloseoutStatus.mockResolvedValue({ found: true, unavailable: [], summary: { failed: [], contradictions: [] } });
    const out = await byKey('closeout_failed_facts').run({ now: NOW });
    expect(getCloseoutStatus).toHaveBeenCalledTimes(CLOSEOUT_VISIT_CAP);
    expect(out.count).toBe(1);
    expect(out.ids).toEqual([`[truncated: 7 completed visit(s) beyond the ${CLOSEOUT_VISIT_CAP}-visit cap were not evaluated]`]);
    expect(out.detail).toMatchObject({ checked: CLOSEOUT_VISIT_CAP, truncated: true });
  });

  test('new_plan_without_welcome delegates to the welcome service audit and lists customer ids only', async () => {
    const welcome = require('../services/new-recurring-welcome-sms');
    welcome.findFirstPlansWithoutWelcome.mockResolvedValueOnce(['cust-1', 'cust-2']);
    const out = await byKey('new_plan_without_welcome').run({ now: NOW });
    expect(welcome.findFirstPlansWithoutWelcome).toHaveBeenCalledWith(NOW);
    expect(out).toEqual({ count: 2, ids: ['cust-1', 'cust-2'], detail: { windowDays: 14, graceHours: 3 } });
  });

  test('completion-record predicates are registered one adapter each and delegate by key', async () => {
    const keys = ['completed_visit_without_record', 'duplicate_completed_records_per_visit',
      'completed_record_without_report_token', 'completed_visit_without_completed_at',
      'completed_record_without_comms_marker', 'aged_incomplete_visit_records'];
    for (const key of keys) {
      runPredicate.mockResolvedValueOnce({ count: 2, ids: ['a', 'b'], truncated: false, detail: { sampleCap: 25 } });
      const d = byKey(key);
      expect(d.label).toBe(`P ${key}`);
      expect(d.href).toBe('/admin/dispatch');
      const out = await d.run({ now: NOW });
      expect(runPredicate).toHaveBeenLastCalledWith(key);
      expect(out).toEqual({ count: 2, ids: ['a', 'b'], truncated: false, detail: { sampleCap: 25 } });
    }
  });
});
