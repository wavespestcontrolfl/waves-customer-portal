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
    'whereExists', 'whereNotExists', 'leftJoin', 'join', 'orderBy', 'orderByRaw', 'limit', 'modify', 'forUpdate', 'insert', 'onConflict', 'update']) {
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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn(async () => ({})) }));

// Detector dependencies — mocked so each adapter's SHAPE is tested, not the
// predicates (which own their own suites).
jest.mock('../scripts/audit-churned-accounts-live-state', () => ({ auditChurnedAccountsLiveState: jest.fn() }));
jest.mock('../scripts/align-waveguard-portal-records', () => ({ scanAlignment: jest.fn() }));
jest.mock('../services/recurring-schedule-audit', () => ({ auditRecurringScheduleAnomalies: jest.fn() }));
jest.mock('../services/stale-visit-sweep', () => ({ _private: { findStaleVisits: jest.fn(), countsByStatus: jest.fn(() => ({ pending: 1 })) } }));
jest.mock('../services/estimate-conversion-guard', () => ({ convertedOpenEstimatesQuery: jest.fn() }));
jest.mock('../config/completion-lane-registry', () => ({ ALL_LISTS: { A: ['known_key', 'gone_key'] }, classifyCatalogRow: jest.fn() }));
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const { isEnabled } = require('../config/feature-gates');
const { auditChurnedAccountsLiveState } = require('../scripts/audit-churned-accounts-live-state');
const { scanAlignment } = require('../scripts/align-waveguard-portal-records');
const { auditRecurringScheduleAnomalies } = require('../services/recurring-schedule-audit');
const staleSweep = require('../services/stale-visit-sweep');
const { convertedOpenEstimatesQuery } = require('../services/estimate-conversion-guard');
const { classifyCatalogRow } = require('../config/completion-lane-registry');
const { getCloseoutStatus } = require('../services/closeout-status');
const {
  runLeadToCashInvariantSweep, DETECTORS, _private: { runDetectors, composeReport, SEND_MARKER_KEY, SAMPLE_IDS, CLOSEOUT_VISIT_CAP },
} = require('../services/lead-to-cash-invariants');

const NOW = new Date('2026-06-15T10:55:00Z'); // 06:55 ET, any fixed instant (no near-today literal semantics)
const det = (key, run) => ({ key, label: `L ${key}`, href: '/admin/x', provenance: 'test', run });
const ok = (key) => det(key, async () => ({ count: 0, ids: [] }));

beforeEach(() => {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
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
    expect(results[0].error).toContain('pg down');
    expect(results[1].sample).toHaveLength(SAMPLE_IDS);
    expect(results[1].truncated).toBe(true);
    expect(results[1].count).toBe(SAMPLE_IDS + 5);
    expect(results[2].sample).toEqual([]);
  });
});

describe('composeReport', () => {
  test('FIX subject counts violations and unrunnable checks; body lists OK/FAIL/?? with ids only', async () => {
    const results = await runDetectors({
      now: NOW,
      detectors: [
        det('a', async () => ({ count: 2, ids: ['x1', 'x<2>'], detail: { tier: 2 } })),
        det('b', async () => ({ count: 1, ids: ['y1'] })),
        det('c', async () => { throw new Error('nope'); }),
        ok('d'),
      ],
    });
    const r = composeReport(results, { now: NOW });
    expect(r.subject).toMatch(/^FIX: lead-to-cash invariants — 3 violations across 2 checks; 1 check could not run \(\d{4}-\d{2}-\d{2}\)$/);
    expect(r.text).toContain('FAIL a — 2: L a');
    expect(r.text).toContain('tier=2');
    expect(r.text).toContain('x1, x<2>');
    expect(r.text).toContain('??   c — could not run: nope');
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
});
