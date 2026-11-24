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
jest.mock('../services/invoice-tier-line-check', () => ({ tierSavingsLeftOffInvoices: jest.fn() }));
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
const { tierSavingsLeftOffInvoices } = require('../services/invoice-tier-line-check');
const {
  runLeadToCashInvariantSweep, DETECTORS,
  _private: {
    runDetectors, composeReport, failingItems, itemHashes, hasNewItem,
    SEND_MARKER_KEY, RECORD_KEY, STANDING_KEY, RUN_STATE_KEY, REPEAT_AFTER_MS, STATE_FRESH_MS, SAMPLE_IDS, CLOSEOUT_VISIT_CAP,
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
  test('the moving-window checks are the closeout day, the 14-day welcome audit, the ghost lanes, churned upcoming visits and the 90-day invoice tier check', () => {
    expect(DETECTORS.filter((d) => d.moving).map((d) => d.key).sort())
      .toEqual(['churned_upcoming_visits', 'closeout_failed_facts', 'completion_lane_ghost_lanes', 'new_plan_without_welcome',
        'tier_saving_left_off_invoice']);
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
  // The run state row the sweep reads (undefined = no row): the result of a finished run, so its start mark equals
  // its time unless the test says otherwise. It also clears the 20 h send marker and the feed's call log.
  const setState = (state) => {
    mockTables.ops_email_send_state = mockChain({ first: null });
    mockTables.system_settings = mockChain({ first: state === undefined ? null : { value: JSON.stringify({ attempt: state.runAt, ...state }) } });
    mockTables.notifications = mockChain();
  };
  // The state yesterday's run wrote: the failing standing checks, how long ago the standing alert posted, the findings.
  const lastRun = (items, alertedAgoMs, seen = {}) => setState(items === undefined ? undefined : {
    runAt: new Date(NOW.getTime() - DAY).toISOString(),
    items, alertedAt: alertedAgoMs == null ? null : new Date(NOW.getTime() - alertedAgoMs).toISOString(),
    alertId: alertedAgoMs == null ? null : 'alert-1', seen,
  });
  // The result the run saved: its last write to the row. A saved result carries its own time as the start mark.
  const savedState = () => {
    const call = mockTables.system_settings.insert.mock.calls.at(-1);
    if (!call) return null;
    const { attempt, ...state } = JSON.parse(call[0].value);
    expect(attempt).toBe(state.runAt);
    return { key: call[0].key, ...state };
  };
  // Every write of the run to the row, in order: the start mark first.
  const stateWrites = () => mockTables.system_settings.insert.mock.calls.map(([row]) => JSON.parse(row.value));
  // The next run reads what this run saved.
  const carry = () => {
    const { key, ...state } = savedState();
    expect(key).toBe(RUN_STATE_KEY);
    setState(state);
  };
  const sweep = (detectors, now = NOW) => runLeadToCashInvariantSweep({ now, detectors });
  const after = (days) => new Date(NOW.getTime() + days * DAY);
  // One run a day from `from` to `to`, each reading what the run before saved. Returns each run's outcome.
  const daily = async (from, to, detectors) => {
    const outcomes = [];
    for (let day = from; day <= to; day += 1) {
      carry();
      const res = await sweep(typeof detectors === 'function' ? detectors(day) : detectors, after(day));
      outcomes.push(res.sent ? 'sent' : res.skipped || res.error);
    }
    return outcomes;
  };
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
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, runAt: NOW.toISOString(), items: ['a'], alertedAt: NOW.toISOString(), alertId: 'row-1', seen: {} });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the same failing check with a higher count posts nothing and keeps the time of the last alert', async () => {
      lastRun(['b'], DAY);
      expect(await sweep([ok('a'), fails('b', 9)])).toEqual({ skipped: 'no_new_item', results: { a: 0, b: 9 } });
      expect(posts()).toHaveLength(0);
      expect(resolve).not.toHaveBeenCalled(); // the list still stands: nothing is closed
      // A quiet run tries the seam's close of older standing alerts again (it can fail right after a new alert is
      // written, and the seam only logs that). It keeps the alert the state names and touches only the standing key.
      expect(mockTables.notifications.whereRaw).toHaveBeenCalledWith("metadata->>'opsKey' = ?", [STANDING_KEY]);
      expect(mockTables.notifications.where).toHaveBeenCalledWith('id', '<>', 'alert-1');
      expect(mockTables.notifications.whereRaw).toHaveBeenCalledWith('created_at <= (SELECT created_at FROM notifications WHERE id = ?)', ['alert-1']);
      expect(mockTables.notifications.update).toHaveBeenCalledTimes(1);
      expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, runAt: NOW.toISOString(), items: ['b'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), alertId: 'alert-1', seen: {} });
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

    test('only the last daily run counts: a state an older run wrote never hides a finding', async () => {
      // Yesterday's run did not save its state (a failed write, a missed run, a day on the email path). What is left
      // says `b` failed and was posted two days ago. It no longer says what the feed shows, so the alert posts.
      const written = (agoMs) => setState({ runAt: new Date(NOW.getTime() - agoMs).toISOString(), items: ['b'], alertedAt: new Date(NOW.getTime() - agoMs).toISOString(), alertId: 'alert-1', seen: {} });
      written(2 * DAY);
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      written(25 * 60 * 60 * 1000); // a clock change: 25 hours between two daily runs
      expect(await sweep([fails('b')])).toMatchObject({ skipped: 'no_new_item' });
      setState({ items: ['b'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), alertId: 'alert-1', seen: {} }); // no run time at all
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      expect(STATE_FRESH_MS).toBeGreaterThan(25 * 60 * 60 * 1000);
      expect(STATE_FRESH_MS).toBeLessThan(2 * DAY - 60 * 60 * 1000);
      // The moving-window findings follow the same rule.
      const seen = { new_plan_without_welcome: ['0123456789abcdef'] };
      setState({ runAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), items: [], alertedAt: null, seen });
      expect(await sweep([welcome(['c1'])])).toMatchObject({ sent: true });
    });

    test('a clean run closes the standing list by its own key and empties the run state', async () => {
      lastRun(['b'], DAY, { new_plan_without_welcome: ['0123456789abcdef'] });
      resolve.mockResolvedValue(1);
      expect(await sweep([ok('a'), ok('b')])).toEqual({ skipped: 'clean', results: { a: 0, b: 0 } });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ key: STANDING_KEY, source: null, resolvedBy: `${STANDING_KEY}:clean-run` });
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, runAt: NOW.toISOString(), items: [], alertedAt: null, alertId: null, seen: {} });
      expect(posts()).toHaveLength(0);
    });

    test('a run marks its start before it does anything: a result older than the latest start is not trusted', async () => {
      const yesterday = new Date(NOW.getTime() - DAY).toISOString();
      lastRun(['b'], DAY);
      expect(await sweep([fails('b')])).toMatchObject({ skipped: 'no_new_item' });
      // The first write is the start mark: the last result as it was, with this run's start time. The last write is
      // this run's result.
      expect(stateWrites()).toHaveLength(2);
      expect(stateWrites()[0]).toMatchObject({ attempt: NOW.toISOString(), runAt: yesterday, items: ['b'], alertId: 'alert-1' });
      expect(stateWrites()[1]).toMatchObject({ attempt: NOW.toISOString(), runAt: NOW.toISOString(), items: ['b'] });
      // A run started three hours ago. It posted or closed alerts, and its result was not saved: the row still holds
      // the result before it. That older result no longer matches the feed, so the same list must post.
      const unsaved = { runAt: yesterday, attempt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(), items: ['b'], alertedAt: yesterday, alertId: 'alert-1' };
      setState({ ...unsaved, seen: {} });
      expect(await sweep([fails('b')])).toMatchObject({ sent: true });
      // The same for a moving-window finding: it cleared on the unsaved run and is back, so it posts again.
      const seen = { new_plan_without_welcome: itemHashes({ key: 'new_plan_without_welcome', itemKeys: ['c1'], count: 1 }, NOW) };
      setState({ ...unsaved, items: [], seen });
      expect(await sweep([welcome(['c1'])])).toMatchObject({ sent: true });
      setState({ ...unsaved, items: [], attempt: yesterday, seen }); // the saved result of the last run: trusted
      expect(await sweep([welcome(['c1'])])).toMatchObject({ skipped: 'no_new_item' });
    });

    test('a start that cannot be marked: the run trusts nothing, posts, and closes nothing', async () => {
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue(1);
      // The alert posts (the unchanged list is not trusted). The run still reads as failed: a state write failed.
      expect(await sweep([fails('b')])).toEqual({ error: 'state_failed', results: { b: 1 } });
      expect(keysPosted()).toEqual([STANDING_KEY]);
      expect(savedState()).toMatchObject({ items: ['b'], alertedAt: NOW.toISOString() });
      // A clean run that cannot write the row at all leaves the standing alert open: with it closed, a later run
      // could trust the older result that still names `b`. The run reads as failed.
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockRejectedValue(new Error('deadlock detected'));
      expect(await sweep([ok('a'), ok('b')])).toEqual({ error: 'state_failed', results: { a: 0, b: 0 } });
      expect(resolve).not.toHaveBeenCalled();
      // The same with a moving-window failure beside the clean standing checks.
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockRejectedValue(new Error('deadlock detected'));
      expect(await sweep([ok('b'), welcome(['c1'])])).toEqual({ error: 'state_failed', results: { b: 0, new_plan_without_welcome: 1 } });
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a result that cannot be saved is tried twice, then the run reads as failed', async () => {
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('deadlock detected')).mockResolvedValue(1);
      expect(await sweep([fails('a'), fails('b')])).toMatchObject({ sent: true }); // saved on the second try
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockResolvedValueOnce(1).mockRejectedValue(new Error('deadlock detected'));
      // The alert is in the feed, the result is not saved: a failed run for job_health. The next run posts again.
      expect(await sweep([fails('a'), fails('b')])).toEqual({ error: 'state_failed', results: { a: 1, b: 1 } });
      expect(keysPosted()).toEqual([STANDING_KEY, STANDING_KEY]);
    });

    test('a clean run marks its start too, so a close with an unsaved result cannot leave the old result in force', async () => {
      lastRun(['b'], DAY);
      mockTables.system_settings.merge = jest.fn().mockResolvedValueOnce(1).mockRejectedValue(new Error('deadlock detected'));
      // The result is not saved (two tries): the run reads as failed, so job_health shows it.
      expect(await sweep([ok('a'), ok('b')])).toEqual({ error: 'state_failed', results: { a: 0, b: 0 } });
      expect(mockTables.system_settings.merge).toHaveBeenCalledTimes(3);
      expect(resolve).toHaveBeenCalledTimes(1); // the standing alert is closed
      // The row now holds yesterday's result with today's start mark. The next run does not trust it: `b` posts.
      const row = stateWrites()[0];
      expect(row).toMatchObject({ attempt: NOW.toISOString(), items: ['b'] });
      setState(row);
      expect(await sweep([fails('b')], after(1))).toMatchObject({ sent: true });
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
      expect(mockTables.notifications.where).toHaveBeenCalledWith('id', '<>', 'alert-1'); // the standing alert is kept
      expect(mockTables.notifications.whereRaw).not.toHaveBeenCalledWith("metadata->>'opsKey' = ?", [RECORD_KEY]);
      expect(savedState()).toMatchObject({ items: ['a'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), alertId: 'alert-1' });
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
      // No time limit: 40 daily runs with the same findings (in any order) post no second record.
      expect(new Set(await daily(1, 40, [welcome(['c2', 'c1'])]))).toEqual(new Set(['no_new_item']));
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

    test('every finding counts, and a record shows the new findings only', async () => {
      const many = (length, last) => [...Array.from({ length }, (_, i) => `c${String(i).padStart(4, '0')}`), last];
      lastRun([], DAY);
      await sweep([welcome(many(SAMPLE_IDS, 'zz-first'))]);
      // The first record: 26 findings, all new. Every one is listed, so none is marked as seen without being shown.
      expect(posts()[0].detail).toContain('FAIL new_plan_without_welcome — 26:');
      expect(posts()[0].detail).toContain(`c${String(SAMPLE_IDS - 1).padStart(4, '0')}, zz-first`);
      expect(posts()[0].detail).not.toContain('more');
      carry();
      // Same count, same first SAMPLE_IDS ids: only the finding past the display sample changed.
      expect(await sweep([welcome(many(SAMPLE_IDS, 'zz-second'))], after(1))).toMatchObject({ sent: true, violations: 26 });
      expect(posts()).toHaveLength(2);
      expect(posts()[1].metadata.subject).toMatch(/^FIX: lead-to-cash invariants — 1 violation across 1 check \(/);
      expect(posts()[1].detail).toContain('FAIL new_plan_without_welcome — 1:');
      expect(posts()[1].detail).toContain(`postedBefore=${SAMPLE_IDS}`);
      expect(posts()[1].detail).toContain('\n     zz-second\n');
      expect(posts()[1].detail).not.toContain('c0000');
      expect(posts()[1].detail).toContain('Record: new findings only.');
      // No cap on the findings the state keeps: a same-count swap at the far end of a long list is seen too.
      carry();
      await sweep([welcome(many(900, 'zz-first'))], after(2));
      carry();
      expect(await sweep([welcome(many(900, 'zz-second'))], after(3))).toMatchObject({ sent: true });
      expect(posts()[3].detail).toContain('\n     zz-second\n');
      expect(posts()[3].detail).toContain('postedBefore=900');
      expect(savedState().seen.new_plan_without_welcome).toHaveLength(901);
    });

    test('a record names what made it: a check with nothing new is not in it', async () => {
      lastRun([], DAY);
      await sweep([welcome(['c1', 'c2']), closeout([])]);
      carry();
      // The day after: a closeout failure. The two welcome findings stand unchanged.
      expect(await sweep([welcome(['c1', 'c2']), closeout(['v9 [license_current]'])], after(1))).toMatchObject({ sent: true, violations: 3 });
      const record = posts()[1];
      expect(record.metadata.subject).toMatch(/^FIX: lead-to-cash invariants — 1 violation across 1 check \(/);
      expect(record.detail).toContain('FAIL closeout_failed_facts — 1:');
      expect(record.detail).toContain('v9 [license_current]');
      expect(record.detail).not.toContain('FAIL new_plan_without_welcome');
      expect(record.detail).not.toContain('OK   new_plan_without_welcome'); // it still fails: it must not read as clean
      expect(record.detail).not.toContain('c1');
      expect(record.detail).toContain('Record: new findings only. Not in this record, no new finding (the earlier record stands): new_plan_without_welcome (2).');
      // A list that cannot name its new findings (the check returned a part of it) shows as it stands.
      carry();
      await sweep([welcome(['c1'], { out: { count: 40, truncated: true } })], after(2));
      expect(posts()[2].detail).toContain('FAIL new_plan_without_welcome — 40:');
      expect(posts()[2].detail).toContain('c1 … +39 more');
    });

    test('the closeout check reads a new day on each run: the same failure on two days is two records', async () => {
      lastRun([], DAY);
      expect(await sweep([closeout(['v1 [x]'])])).toMatchObject({ sent: true });
      carry();
      expect(await sweep([closeout(['v1 [x]'])])).toMatchObject({ skipped: 'no_new_item' }); // a rerun on the same day
      carry();
      expect(await sweep([closeout(['v1 [x]'])], after(1))).toMatchObject({ sent: true });
      // "Could not run" on two days is two records too: the day it missed never comes back. A check with a standing
      // window that cannot run is one item on the standing list (the next test).
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

    test('a closeout failure, then a rerun that cannot read closeouts, then a rerun that can: one record for the visits', async () => {
      const down = { ...det('closeout_failed_facts', async () => { throw new Error('x'); }), moving: true, freshEachRun: true };
      lastRun([], DAY);
      expect(await sweep([closeout(['v1 [x]', 'v2 [y]'])])).toMatchObject({ sent: true });
      carry();
      expect(await sweep([down])).toMatchObject({ sent: true }); // "could not run" is a record of its own
      expect(savedState().seen.closeout_failed_facts).toHaveLength(3); // the two visits stay known beside it
      carry();
      expect(await sweep([down])).toMatchObject({ skipped: 'no_new_item' }); // still down: the outage is posted once
      carry();
      expect(await sweep([closeout(['v1 [x]', 'v2 [y]'])])).toMatchObject({ skipped: 'no_new_item' });
      expect(savedState().seen.closeout_failed_facts).toHaveLength(2);
      expect(posts()).toHaveLength(2);
    });

    test('a check with a standing window that cannot run joins the standing list, and its known findings stay known', async () => {
      const down = { ...det('new_plan_without_welcome', async () => { throw new Error('x'); }), moving: true };
      lastRun([], DAY);
      await sweep([ok('a'), welcome(['c1'])]);
      expect(keysPosted()).toEqual([RECORD_KEY]);
      const known = savedState().seen.new_plan_without_welcome;
      resolve.mockClear(); // day 0 had a clean standing list, which closes the standing alert
      // Day 1: it cannot run. That is present state: one pinned standing alert, no record, the finding stays known.
      expect(await daily(1, 1, [ok('a'), down])).toEqual(['sent']);
      expect(keysPosted()).toEqual([RECORD_KEY, STANDING_KEY]);
      expect(posts()[1].detail).toContain('??   new_plan_without_welcome — could not run');
      expect(posts()[1].metadata).toMatchObject({ fallOff: true });
      expect(savedState()).toMatchObject({ items: ['new_plan_without_welcome:unavailable'], seen: { new_plan_without_welcome: known } });
      // Days 2 to 5: still down. Nothing posts again, and the list is not clean while the check cannot run.
      expect(new Set(await daily(2, 5, [ok('a'), down]))).toEqual(new Set(['no_new_item']));
      expect(resolve).not.toHaveBeenCalled();
      // Day 6: it runs again with the same finding. No second record, and the standing alert closes.
      expect(await daily(6, 6, [ok('a'), welcome(['c1'])])).toEqual(['no_new_item']);
      expect(resolve).toHaveBeenCalledWith({ key: STANDING_KEY, source: null, resolvedBy: `${STANDING_KEY}:clean-run` });
      expect(keysPosted()).toEqual([RECORD_KEY, STANDING_KEY]);
      // A finding that arrived while it was down is new.
      expect(await daily(7, 7, [ok('a'), welcome(['c1', 'c2'])])).toEqual(['sent']);
      expect(posts()[2].detail).toContain('FAIL new_plan_without_welcome — 1:');
      expect(posts()[2].detail).toContain('\n     c2\n');
    });

    test('a ghost lane is one record while it stands, whatever its visit count; cleared and back = a new record', async () => {
      const ghosts = (upcoming) => moving('completion_lane_ghost_lanes', upcoming ? [`old_pest (generic: archived_service_with_upcoming_visits:${upcoming})`] : [], {
        out: { itemKeys: upcoming ? ['old_pest'] : [] },
      });
      lastRun([], DAY);
      expect(await sweep([ghosts(3)])).toMatchObject({ sent: true });
      // 60 daily runs while its visits pass (3, then 2, then 1 upcoming): no second record.
      expect(new Set(await daily(1, 60, (day) => [ghosts(day < 20 ? 3 : day < 40 ? 2 : 1)]))).toEqual(new Set(['no_new_item']));
      expect(await daily(61, 61, [ghosts(0)])).toEqual(['clean']);
      expect(savedState().seen).toEqual({});
      expect(await daily(62, 62, [ghosts(4)])).toEqual(['sent']);
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
      // The count joins the findings only for such a list: a full list is its ids and nothing else.
      const full = { key: 'w', ok: false, unavailable: false, freshEachRun: false, listCapped: false, count: 2, itemKeys: ['c1', 'c2'] };
      expect(itemHashes(full, NOW)).toHaveLength(2);
      expect(itemHashes({ ...full, listCapped: true }, NOW)).toHaveLength(3);
      expect(hasNewItem(itemHashes({ ...full, count: 3 }, NOW), itemHashes(full, NOW))).toBe(false);
      expect(hasNewItem(itemHashes({ ...full, listCapped: true, count: 3 }, NOW), itemHashes({ ...full, listCapped: true }, NOW))).toBe(true);
      expect(hasNewItem(itemHashes(full, NOW), itemHashes(full, after(9)))).toBe(false); // a standing window: no date in the hash
      expect(hasNewItem(itemHashes({ ...full, freshEachRun: true }, NOW), itemHashes({ ...full, freshEachRun: true }, after(1)))).toBe(true);
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
      expect(savedState()).toEqual({ key: RUN_STATE_KEY, runAt: NOW.toISOString(), items: ['b'], alertedAt: new Date(NOW.getTime() - DAY).toISOString(), alertId: 'alert-1', seen: {} });
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
      // The same on the email path (the in-app feed off): a refused send is not a sent report.
      gateEnvValue.mockReturnValue(false);
      mockTables.ops_email_send_state = mockChain({ first: null });
      sendgrid.sendOne.mockResolvedValueOnce({ ok: false, error: 'refused' });
      expect(await sweep([fails('a')])).toEqual({ error: 'send_failed', results: { a: 1 } });
      expect(mockTables.ops_email_send_state.insert).not.toHaveBeenCalled();
    });

    test('the 20-hour send marker paces the whole-report email only: it never stops an in-app run', async () => {
      // An afternoon rerun posted an alert. The next 06:55 run must still post a new closeout failure: no later run
      // reads that day again. In the app the run state stops a second copy, so the marker is not read or written.
      lastRun(['a'], DAY);
      mockTables.ops_email_send_state = mockChain({ first: { last_sent_at: new Date().toISOString() } });
      expect(await sweep([fails('a'), closeout(['v1 [x]'])])).toMatchObject({ sent: true });
      expect(keysPosted()).toEqual([RECORD_KEY]);
      expect(db).not.toHaveBeenCalledWith('ops_email_send_state');
      // The email path keeps the marker.
      gateEnvValue.mockReturnValue(false);
      expect(await sweep([fails('a')])).toEqual({ skipped: 'recent_send', results: { a: 1 } });
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

  test('churned accounts: the date-bound upcoming-visit flag is its own moving-window check', async () => {
    // c1: plan state only. c2: plan state and an upcoming visit. c3: an upcoming visit only (it leaves the audit
    // when the visit date passes, with nothing fixed).
    auditChurnedAccountsLiveState.mockResolvedValue({
      churned: 9, withLiveState: 3, counts: { tier: 2, upcoming_visit: 2 },
      findings: [{ id: 'c1', flags: ['tier=Gold'] }, { id: 'c2', flags: ['tier=Bronze', 'upcoming_visit'] }, { id: 'c3', flags: ['upcoming_visit'] }],
    });
    expect(await byKey('churned_live_state').run({ now: NOW })).toEqual({ count: 2, ids: ['c1', 'c2'], detail: { tier: 2 } });
    expect(await byKey('churned_upcoming_visits').run({ now: NOW })).toEqual({ count: 2, ids: ['c2', 'c3'] });
    expect(auditChurnedAccountsLiveState).toHaveBeenCalledWith({ db });
    expect(byKey('churned_upcoming_visits').moving).toBe(true);
    expect(byKey('churned_live_state').moving).toBeUndefined();
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

  test('tier_saving_left_off_invoice reads the shared db from the Eastern day and keys a record by the estimate line', async () => {
    tierSavingsLeftOffInvoices.mockResolvedValue({ checked: 40, notJudged: 9, findings: [
      { visitId: 'v1', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'platinum' },
      { visitId: 'v2', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:0', tier: 'platinum' },
      { visitId: 'v3', estimateId: 'e2', serviceKey: 'rodent_bait', lineKey: 'recurring:0', tier: 'silver' },
      // A second line of estimate e1 with the same service key (a monthly and a seasonal mosquito line share one).
      { visitId: 'v4', estimateId: 'e1', serviceKey: 'pest_control', lineKey: 'recurring:1', tier: 'platinum' },
    ] });
    const out = await byKey('tier_saving_left_off_invoice').run({ now: NOW });
    expect(tierSavingsLeftOffInvoices).toHaveBeenCalledWith(db, { today: '2026-06-15' });
    // Two visits of one estimate line are one finding, counted once in its first record (pre-push audit), and a new
    // visit of that line entering the window posts nothing new. Two lines of one estimate stay two findings, even with
    // one service key (pre-push audit).
    expect(out).toEqual({
      count: 3,
      ids: ['v1 (pest_control, platinum, 2 visits)', 'v3 (rodent_bait, silver, 1 visit)', 'v4 (pest_control, platinum, 1 visit)'],
      itemKeys: ['e1:recurring:0', 'e2:recurring:0', 'e1:recurring:1'],
      detail: { checked: 40, notJudged: 9, visits: 4 },
    });
    const r = { key: 'tier_saving_left_off_invoice', itemKeys: out.itemKeys, count: out.count };
    expect(itemHashes(r, NOW)).toHaveLength(3);
    expect(byKey('tier_saving_left_off_invoice').moving).toBe(true);
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
