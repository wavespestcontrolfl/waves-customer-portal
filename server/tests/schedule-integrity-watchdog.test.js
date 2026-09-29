// Schedule-integrity watchdog (2026-08-04). Born from a Tree & Shrub
// recurring series found live with no price on any row and its first visit
// stuck in on_site for two weeks — never completed, never billed — plus 89
// past-dated visits parked in on_site/en_route the same prod sweep. The
// stale in-progress class (isStaleInProgress, STALE_STATUSES, the
// stale-visit: dedupe key) was removed 2026-09-28, superseded by the 7 PM ET
// tech text about today's open visits. These tests pin the pure classifiers
// (unpriced-series with parent-price inheritance, series-root collapsing),
// the runInner alert loop (forever-dedupe, one bell per series, per-run cap,
// loud insert failure), the gate-off no-op, and a regression proving the
// removed class never pages. All fixture identities are synthetic.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The episode helpers are mocked at the service boundary (their SQL is proven
// against Postgres in alert-episodes-db.test.js). The reopen wrapper delegates
// to the notifyAdmin mock so a test that stubs notifyAdmin sees the same
// opts, and reports `rang` the way the real one does.
jest.mock('../services/notification-service', () => {
  const service = {
    notifyAdmin: jest.fn(async () => ({ id: 1 })),
    openAdminAlertKeys: jest.fn(async () => []),
    closeAdminAlertKeys: jest.fn(async (_conn, keys) => keys.length),
  };
  service.raiseAdminAlertWithReopen = jest.fn(async (...args) => {
    const result = await service.notifyAdmin(...args);
    if (!result) return result;
    return { ...result, rang: !result.deduped || (result.refreshed === true && result.rung !== false) };
  });
  return service;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), alertEpisodesLive: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, fn) => fn()) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  annualPrepayCoversVisit: jest.fn(async () => false),
  coveredTermsAsOf: jest.fn(() => require('../models/db')('annual_prepay_terms')),
  serviceMatchesCoverage: jest.fn((row, type) => row.service_type === type),
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
}));
jest.mock('../services/invoice', () => ({ anyInvoiceLinkedToVisit: jest.fn() }));
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []),
  findUnstampedRecurringLawnMembers: jest.fn(async () => []),
}));

jest.mock('../services/recurring-schedule-audit', () => ({
  findAcceptedRecurringScheduleGaps: jest.fn(async () => []),
}));

const { findAcceptedRecurringScheduleGaps } = require('../services/recurring-schedule-audit');
const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled, alertEpisodesLive } = require('../config/feature-gates');
const { annualPrepayCoversVisit } = require('../services/annual-prepay-renewals');
const { anyInvoiceLinkedToVisit } = require('../services/invoice');
const { findLawnEmailAudienceGaps, findUnstampedRecurringLawnMembers } = require('../services/irrigation-weekly-email');
const {
  runScheduleIntegrityWatchdog,
  runInner,
  rowHasPrice,
  isUnpricedSeriesVisit,
  seriesRootId,
  MAX_ALERTS_PER_RUN,
  manualSeriesStampIssue,
} = require('../services/schedule-integrity-watchdog');

// 2026-08-04 noon ET.
const NOW = new Date('2026-08-04T16:00:00Z');

// Shaped like a visit the removed stale in-progress class used to page —
// kept only for the regression proving it no longer produces a bell.
function staleVisit(over = {}) {
  return {
    id: 'sv-1', customer_id: 'cust-1', status: 'on_site',
    service_type: 'Bi-Monthly Tree & Shrub Care Service', service_date: '2026-07-21',
    ...over,
  };
}

function unpricedChild(over = {}) {
  return {
    id: 'ss-child-1', customer_id: 'cust-1', status: 'pending',
    service_type: 'Bi-Monthly Tree & Shrub Care Service', service_date: '2026-08-10',
    estimated_price: null, primary_line_price: null, prepaid_amount: null,
    is_recurring: true, recurring_parent_id: 'ss-parent-1',
    parent_estimated_price: null, parent_primary_line_price: null, parent_prepaid_amount: null,
    ...over,
  };
}

// Thenable knex-chain stub: every builder method returns the chain; awaiting
// it resolves the row list. Dedupe no longer reads the DB (ring() now hands
// dedupeKey to notifyAdmin's own advisory-locked dedupe) — `alertedKeys`
// instead configures the notifyAdmin mock below to answer `deduped: true`
// for those keys, the same contract the real service relies on.
// completedRows: what the unpriced close pass's completed-visit check reads
// (the same 'scheduled_services as ss' table, told apart by its
// where('ss.status', 'completed')); bellRows: the standing bells' created_at /
// rungAt it reads from 'notifications'.
function makeDbMock({ staleRows = [], coverageRows = [], coveredTerms = [], completedRows = [], bellRows = [], alertedKeys = new Set() } = {}) {
  db.mockImplementation((table) => {
    let completedCheck = false;
    const c = {};
    for (const m of ['whereIn', 'whereNull', 'whereNotIn', 'leftJoin', 'select', 'orderBy', 'orderByRaw', 'whereRaw', 'first']) {
      c[m] = jest.fn(() => c);
    }
    c.where = jest.fn((...args) => { if (args[0] === 'ss.status' && args[1] === 'completed') completedCheck = true; return c; });
    c.then = (res, rej) => {
      const rows = table === 'scheduled_services' ? staleRows
        : table === 'scheduled_services as ss' ? (completedCheck ? completedRows : coverageRows)
          : table === 'annual_prepay_terms' ? coveredTerms
            : table === 'notifications' ? bellRows : null;
      return Promise.resolve(rows || []).then(res, rej);
    };
    return c;
  });
  NotificationService.notifyAdmin.mockImplementation(async (_category, _title, _body, opts) => (
    opts?.dedupeKey && alertedKeys.has(opts.dedupeKey) ? { id: 99, deduped: true } : { id: 1 }
  ));
}

const delegatingRaise = async (...args) => {
  const result = await NotificationService.notifyAdmin(...args);
  if (!result) return result;
  return { ...result, rang: !result.deduped || (result.refreshed === true && result.rung !== false) };
};

beforeEach(() => {
  jest.clearAllMocks();
  alertEpisodesLive.mockReturnValue(true);
  NotificationService.notifyAdmin.mockImplementation(async () => ({ id: 1 }));
  NotificationService.raiseAdminAlertWithReopen.mockImplementation(delegatingRaise);
  NotificationService.openAdminAlertKeys.mockImplementation(async () => []);
  NotificationService.closeAdminAlertKeys.mockImplementation(async (_conn, keys) => keys.length);
  invoicesByVisit({});
});

// anyInvoiceLinkedToVisit(db, visitId) is a builder: the check adds
// whereNotIn(status, dead statuses) and first(). `byVisit` maps a visit id to
// its invoice rows; the stub applies the status filter the way SQL would.
function invoicesByVisit(byVisit) {
  anyInvoiceLinkedToVisit.mockImplementation((_conn, visitId) => ({
    whereNotIn: (_col, dead) => ({
      first: async () => (byVisit[visitId] || []).find((inv) => !dead.includes(inv.status)),
    }),
  }));
}

describe('classifiers', () => {
  test('rowHasPrice: either price field counts; zero and null do not', () => {
    expect(rowHasPrice({ estimated_price: '99.45' })).toBe(true);
    expect(rowHasPrice({ primary_line_price: 117 })).toBe(true);
    expect(rowHasPrice({ estimated_price: '0.00', primary_line_price: null })).toBe(false);
    expect(rowHasPrice({})).toBe(false);
  });

  test('isUnpricedSeriesVisit: a price ANYWHERE in the series suppresses', () => {
    expect(isUnpricedSeriesVisit(unpricedChild())).toBe(true);
    expect(isUnpricedSeriesVisit(unpricedChild({ status: null }))).toBe(false);
    // Child carries its own price (pest model).
    expect(isUnpricedSeriesVisit(unpricedChild({ estimated_price: '99.45' }))).toBe(false);
    // Parent priced, child inherits at invoice time (lawn model) — fine.
    expect(isUnpricedSeriesVisit(unpricedChild({ parent_primary_line_price: '72.00' }))).toBe(false);
    // Unpriced parent row itself (no parent above it).
    expect(isUnpricedSeriesVisit(unpricedChild({
      recurring_parent_id: null, parent_estimated_price: null, parent_primary_line_price: null,
    }))).toBe(true);
  });

  test('an out-of-band prepaid stamp (cash/check) suppresses; a parent stamp NEVER covers a child', () => {
    // Mirrors the completion-billing gate: only the row's own out-of-band
    // stamp settles its books. Completion does not inherit prepaid_amount,
    // so a child under a parent-only stamp is a real $0-completion risk.
    expect(isUnpricedSeriesVisit(unpricedChild({ prepaid_amount: '107.00', prepaid_method: 'check' }))).toBe(false);
    expect(isUnpricedSeriesVisit(unpricedChild({ parent_prepaid_amount: '559.20' }))).toBe(true);
    expect(isUnpricedSeriesVisit(unpricedChild({ is_recurring: false, prepaid_amount: '107.00', prepaid_method: 'check' }))).toBe(false);
  });

  test('an annual-prepay stamp is NOT trusted by the pure check — it must pass term validation', () => {
    // Stale annual stamps (refund/void cleanup misses) must not suppress on
    // amount alone; the async annualPrepayCoversVisit gate decides in
    // runInner.
    expect(isUnpricedSeriesVisit(unpricedChild({ prepaid_amount: '559.20', prepaid_method: 'annual_prepay_invoice' }))).toBe(true);
  });

  test('a booster child (is_recurring=false) bills alone — parent price never suppresses it', () => {
    // Booster/add-on rows complete as one-off billable visits and do NOT
    // inherit the parent amount, so an unpriced booster pages even under a
    // fully priced series.
    expect(isUnpricedSeriesVisit(unpricedChild({
      is_recurring: false, parent_primary_line_price: '72.00',
    }))).toBe(true);
    // A priced booster is fine.
    expect(isUnpricedSeriesVisit(unpricedChild({
      is_recurring: false, estimated_price: '49.00', parent_primary_line_price: '72.00',
    }))).toBe(false);
  });

  test('a visit priced by a LIVE combined first-application invoice is not unpriced; a dead invoice does not cover it', () => {
    // A new customer's same-trip second service rides the anchor's combined
    // invoice (first_application_invoice_id) and is deliberately unpriced.
    for (const status of ['draft', 'sent', 'viewed', 'paid', 'processing']) {
      expect(isUnpricedSeriesVisit(unpricedChild({
        first_application_invoice_id: 'inv-1', first_application_invoice_status: status,
      }))).toBe(false);
    }
    for (const status of ['void', 'refunded', 'canceled', 'cancelled']) {
      expect(isUnpricedSeriesVisit(unpricedChild({
        first_application_invoice_id: 'inv-1', first_application_invoice_status: status,
      }))).toBe(true);
    }
    // A stamp whose invoice row is gone (status null from the LEFT JOIN) covers nothing.
    expect(isUnpricedSeriesVisit(unpricedChild({ first_application_invoice_id: 'inv-1', first_application_invoice_status: null }))).toBe(true);
  });

  test('seriesRootId collapses recurring children onto the parent; boosters stand alone', () => {
    expect(seriesRootId(unpricedChild())).toBe('ss-parent-1');
    expect(seriesRootId(unpricedChild({ recurring_parent_id: null }))).toBe('ss-child-1');
    expect(seriesRootId(unpricedChild({ is_recurring: false }))).toBe('ss-child-1');
  });
});

describe('runScheduleIntegrityWatchdog gate', () => {
  test('gated off → no-op, no queries, no bells', async () => {
    isEnabled.mockReturnValue(false);
    const result = await runScheduleIntegrityWatchdog({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('gated on → runs the sweep under the cron lock', async () => {
    isEnabled.mockReturnValue(true);
    makeDbMock();
    const result = await runScheduleIntegrityWatchdog({ now: NOW });
    expect(result).toMatchObject({ skipped: false, unpricedSeries: 0, alerted: 0 });
  });
});

describe('runInner alerting', () => {
  test('a past-dated on_site/en_route visit rings no bell (removed class); an unpriced series still pages', async () => {
    // The stale in-progress class was removed 2026-09-28 — the 7 PM ET tech
    // text about today's open visits supersedes it. This shape used to page
    // as `stale-visit:sv-1` / "Visit stuck on_site since … — never
    // completed"; makeDbMock still wires it through the 'scheduled_services'
    // table key for realism, but runInner no longer queries that table at
    // all, so it produces nothing.
    makeDbMock({ staleRows: [staleVisit()], coverageRows: [unpricedChild()] });
    const result = await runInner({ now: NOW });
    expect(result.stale).toBeUndefined();
    expect(result).toMatchObject({ unpricedSeries: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).not.toContain('never completed');
    expect(opts.metadata.dedupeKey).not.toMatch(/^stale-visit:/);
    expect(opts.metadata.dedupeKey).toBe('unpriced-series:ss-parent-1');
  });

  test('a covered same-trip sibling rings no unpriced-series bell; once its combined invoice is void it does', async () => {
    const covered = unpricedChild({
      id: 'ss-second-service', recurring_parent_id: null, first_application_invoice_id: 'inv-1', first_application_invoice_status: 'sent',
    });
    makeDbMock({ coverageRows: [covered] });
    expect(await runInner({ now: NOW })).toMatchObject({ unpricedSeries: 0, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

    makeDbMock({ coverageRows: [{ ...covered, first_application_invoice_status: 'void' }] });
    expect(await runInner({ now: NOW })).toMatchObject({ unpricedSeries: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.dedupeKey).toBe('unpriced-series:ss-second-service');
  });

  test('an unpriced series rings ONE bell for many child visits', async () => {
    makeDbMock({
      coverageRows: [
        unpricedChild({ id: 'ss-child-1', service_date: '2026-08-10' }),
        unpricedChild({ id: 'ss-child-2', service_date: '2026-08-12' }),
      ],
    });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 1, alerted: 1 });
    const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toContain('has no price');
    expect(body).toContain('2026-08-10');
    expect(opts.metadata.dedupeKey).toBe('unpriced-series:ss-parent-1');
  });

  test('a priced series never pages, even when children carry NULL', async () => {
    makeDbMock({ coverageRows: [unpricedChild({ parent_primary_line_price: '84.17' })] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 0, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an annual-prepay stamp suppresses ONLY when the term validator confirms coverage', async () => {
    const stamped = unpricedChild({ prepaid_amount: '559.20', prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' });
    // Validator confirms → no page.
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    makeDbMock({ coverageRows: [stamped] });
    let result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 0, alerted: 0 });
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: 'ss-child-1' }), expect.anything());
    // Validator refutes (stale stamp, dead term) → fail-closed, page rings.
    annualPrepayCoversVisit.mockResolvedValueOnce(false);
    makeDbMock({ coverageRows: [stamped] });
    result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 1, prepayCoverageGaps: 1, alerted: 2 });
  });

  test('per-run cap stops at MAX_ALERTS_PER_RUN and leaves the rest for next tick', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 3 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    makeDbMock();
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN);
  });

  test('unpriced series ring BEFORE a bulk backlog in another class consumes the cap', async () => {
    // First-enable shape: a backlog bigger than the whole per-run cap plus
    // one same-day money-loss series. The series must still page today — it
    // can invoice at $0 while the backlog drains over days.
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 5 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    makeDbMock({ coverageRows: [unpricedChild()] });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    const keys = NotificationService.notifyAdmin.mock.calls.map(([, , , opts]) => opts.metadata.dedupeKey);
    expect(keys[0]).toBe('unpriced-series:ss-parent-1');
    expect(keys.filter((k) => k.startsWith('lawn-email-gap:'))).toHaveLength(MAX_ALERTS_PER_RUN - 1);
  });

  test('a fixable lawn-email audience gap rings with its dedupe key', async () => {
    // The module contract returns ONLY pageable gaps (opt-outs and churned
    // customers are suppressed inside findLawnEmailAudienceGaps).
    findLawnEmailAudienceGaps.mockResolvedValueOnce([
      { customerId: 'cust-9', name: 'Pat Sample', fixable: ['no_coordinates'] },
    ]);
    makeDbMock();
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ lawnEmailGaps: 1, lawnGapCheckFailed: false, alerted: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toContain('missing from the Monday watering email');
    expect(opts.metadata.dedupeKey).toBe('lawn-email-gap:cust-9:no_coordinates');
    // The fix lives on the customer record — dispatch may not even have a
    // row for a trailing-evidence gap. Query-param form: the SPA has no
    // /admin/customers/<id> route; Customer 360 opens from ?customerId.
    expect(opts.link).toBe('/admin/customers?customerId=cust-9');
  });

  test('an unstamped recurring member rings with the stamp-the-series copy', async () => {
    // Membership-evidence leg (owner ruling 2026-08-10): the customer was
    // enrolled as a member but no visit carries a recurring marker, so the
    // shared evidence predicate — and therefore the leg above — cannot see
    // them. The fix is booking/stamping the series, not editing a field.
    findUnstampedRecurringLawnMembers.mockResolvedValueOnce([
      { customerId: 'cust-7', name: 'Stu Sample', kind: 'unstamped_member', fixable: ['no_recurring_marked_lawn_visit'] },
    ]);
    makeDbMock();
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ lawnEmailGaps: 1, lawnGapCheckFailed: false, alerted: 1 });
    const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toContain("aren't stamped as a recurring series");
    expect(body).toContain('recurring series');
    expect(opts.metadata.dedupeKey).toBe('lawn-email-gap:cust-7:no_recurring_marked_lawn_visit');
    expect(opts.link).toBe('/admin/customers?customerId=cust-7');
  });

  test('an unstamped member with a bad email lists BOTH fixes on one card (codex r1 P2)', async () => {
    findUnstampedRecurringLawnMembers.mockResolvedValueOnce([
      { customerId: 'cust-8', name: 'Stu Sample', kind: 'unstamped_member', fixable: ['no_recurring_marked_lawn_visit', 'no_email'] },
    ]);
    makeDbMock();
    await runInner({ now: NOW });
    const [, , body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('also fix: no_email');
    expect(opts.metadata.dedupeKey).toBe('lawn-email-gap:cust-8:no_email+no_recurring_marked_lawn_visit');
  });

  test('the unstamped-member dedupe key is scoped to the offending booking, so a regression re-pages (codex r3 P2)', async () => {
    findUnstampedRecurringLawnMembers.mockResolvedValueOnce([
      { customerId: 'cust-8', name: 'Stu Sample', kind: 'unstamped_member', fixable: ['no_recurring_marked_lawn_visit'], triggerVisitId: 'visit-42' },
    ]);
    makeDbMock();
    await runInner({ now: NOW });
    const [, , , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(opts.metadata.dedupeKey).toBe('lawn-email-gap:cust-8:no_recurring_marked_lawn_visit:visit-42');
  });

  test('a failed lawn-gap check is REPORTED, never silently zero — and other classes still page', async () => {
    findLawnEmailAudienceGaps.mockRejectedValueOnce(new Error('db exploded'));
    makeDbMock({ coverageRows: [unpricedChild()] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ lawnGapCheckFailed: true, lawnEmailGaps: 0, unpricedSeries: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.dedupeKey).toBe('unpriced-series:ss-parent-1');
  });

  test('a swallowed notification insert fails the run loudly', async () => {
    makeDbMock({ coverageRows: [unpricedChild()] });
    NotificationService.notifyAdmin.mockImplementation(async () => null);
    await expect(runInner({ now: NOW })).rejects.toThrow('pager output lost');
  });
});

describe('prepay coverage detection', () => {
  test('lawn alerts precede coverage and acceptance backlogs under one cap', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce([{ customerId: 'lawn-1', fixable: ['no_coordinates'] }]);
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 5 }, (_, i) => ({
      estimateId: `e-${i}`, customerId: `c-${i}`, serviceFamily: 'pest_control', pattern: 'monthly',
      expectedVisits: 12, recordedVisits: 0, issues: ['missing_schedule'], evidenceKey: 'missing', appointmentIds: [],
    })));
    makeDbMock({ coverageRows: Array.from({ length: MAX_ALERTS_PER_RUN + 5 }, (_, i) => unpricedChild({
      id: `prepay-${i}`, estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100,
    })) });
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: MAX_ALERTS_PER_RUN });
    const keys = NotificationService.notifyAdmin.mock.calls.map((call) => call[3].metadata.dedupeKey);
    expect(keys[0]).toBe('lawn-email-gap:lawn-1:no_coordinates');
    expect(keys.filter((key) => key.startsWith('prepay-coverage:'))).toHaveLength(MAX_ALERTS_PER_RUN - 1);
    expect(keys.filter((key) => key.startsWith('accepted-schedule:'))).toHaveLength(0);
  });

  test('a priced annual stamp still requires valid coverage', async () => {
    makeDbMock({ coverageRows: [unpricedChild({ estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100 })] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 0, prepayCoverageGaps: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.issue).toBe('annual_coverage_unverified');
  });

  test('unchanged prepay evidence dedupes but a later funding regression rings again', async () => {
    const row = unpricedChild({ estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100,
      annual_prepay_term_id: 'term-1', prepay_payment_evidence: [['payment-1', 'refunded', 'full', '2040-01-01T12:00:00Z']] });
    makeDbMock({ coverageRows: [row] });
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 1 });
    const key = NotificationService.notifyAdmin.mock.calls[0][3].metadata.dedupeKey;
    const alertedKeys = new Set([key]);
    makeDbMock({ coverageRows: [row], alertedKeys });
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 0 });
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 0, prepayCoverageGaps: 0 });
    makeDbMock({ coverageRows: [{ ...row, prepay_payment_evidence: [['payment-1', 'refunded', 'full', '2040-01-03T12:00:00Z']] }], alertedKeys });
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 1, prepayCoverageGaps: 1 });
    expect(NotificationService.notifyAdmin.mock.calls.at(-1)[3].metadata.dedupeKey).not.toBe(key);
  });

  test('manual allocations must retain their original payment timestamp and method', () => {
    const row = unpricedChild({ manual_series_payment_evidence: [['2040-01-05T16:00:00Z', 'check', [['parent', '101'], ['sibling', '102']]]] });
    expect(manualSeriesStampIssue(row)).toBe('manual_series_stamp_missing');
    const paid = { ...row, prepaid_amount: 100, prepaid_method: 'check', prepaid_at: new Date('2040-01-05T11:00:00-05:00') };
    expect(manualSeriesStampIssue(paid)).toBeNull();
    expect(manualSeriesStampIssue({ ...paid, prepaid_method: 'annual_prepay_invoice' })).toBe('manual_series_stamp_conflict');
    expect(manualSeriesStampIssue({ ...paid, prepaid_at: new Date('2040-01-06T16:00:00Z') })).toBe('manual_series_stamp_conflict');
    expect(manualSeriesStampIssue({ ...paid, prepaid_at: null })).toBe('manual_series_stamp_conflict');
    expect(manualSeriesStampIssue({ ...paid, manual_series_payment_evidence: [
      ...row.manual_series_payment_evidence, ['2040-01-06T16:00:00Z', 'check', [['other-1', '103'], ['other-2', '104']]],
    ] })).toBe('manual_series_stamp_conflict');
    // A payment whose stamped members have all closed their books (no live
    // member) was amended, not silently replaced — one live member still
    // holding it reopens the conflict, and it still proves coverage for a
    // row with no stamp at all (Codex #4030 r7 P2).
    const closedBooks = ['2040-01-04T16:00:00Z', 'check', [['done-1', '105'], ['done-2', '106']], 0];
    expect(manualSeriesStampIssue({ ...paid, manual_series_payment_evidence: [...row.manual_series_payment_evidence, closedBooks] })).toBeNull();
    expect(manualSeriesStampIssue({ ...paid, manual_series_payment_evidence: [...row.manual_series_payment_evidence, [...closedBooks.slice(0, 3), 1]] }))
      .toBe('manual_series_stamp_conflict');
    expect(manualSeriesStampIssue({ ...row, manual_series_payment_evidence: [closedBooks] })).toBe('manual_series_stamp_missing');
    expect(manualSeriesStampIssue({ ...row, recurring_parent_id: null })).toBe('manual_series_stamp_missing');
    expect(manualSeriesStampIssue({ ...row, manual_series_payment_evidence: [] })).toBeNull();
    expect(manualSeriesStampIssue({ ...row, manual_series_payment_evidence: null })).toBeNull();
  });

  test('a priced unstamped visit with live linked service coverage gets a review alert', async () => {
    const row = unpricedChild({ estimated_price: 100, annual_prepay_term_id: 'term-1' });
    makeDbMock({ coverageRows: [row], coveredTerms: [{ id: 'term-1', customer_id: row.customer_id, coverage_service_type: row.service_type }] });
    expect(await runInner({ now: NOW })).toMatchObject({ unpricedSeries: 0, prepayCoverageGaps: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.issue).toBe('annual_coverage_unverified');
    // A positive manual override does not resolve the linked annual allocation.
    // The partial stamp in particular would not suppress completion billing.
    for (const amount of [10, 100]) {
      makeDbMock({ coverageRows: [{ ...row, prepaid_method: 'cash', prepaid_amount: amount }],
        coveredTerms: [{ id: 'term-1', customer_id: row.customer_id, coverage_service_type: row.service_type }] });
      expect(await runInner({ now: NOW })).toMatchObject({ prepayCoverageGaps: 1 });
    }
    makeDbMock({ coverageRows: [row], coveredTerms: [] });
    expect(await runInner({ now: NOW })).toMatchObject({ prepayCoverageGaps: 0 });
    makeDbMock({ coverageRows: [row], coveredTerms: [{ id: 'term-1', customer_id: 'other-customer' }] });
    expect(await runInner({ now: NOW })).toMatchObject({ prepayCoverageGaps: 0 });
    makeDbMock({ coverageRows: [row], coveredTerms: [{ id: 'term-1', customer_id: row.customer_id, coverage_service_type: 'Different Service' }] });
    expect(await runInner({ now: NOW })).toMatchObject({ prepayCoverageGaps: 0 });
  });
});

describe('accepted-plan schedule detection', () => {
  test('morning lawn-email alerts retain priority over a large acceptance backlog', async () => {
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 5 }, (_, i) => ({
      estimateId: `e-${i}`, customerId: `c-${i}`, serviceFamily: 'pest_control', pattern: 'monthly',
      expectedVisits: 12, recordedVisits: 0, issues: ['missing_schedule'], evidenceKey: 'missing', appointmentIds: [],
    })));
    findLawnEmailAudienceGaps.mockResolvedValueOnce([{ customerId: 'lawn-1', fixable: ['no_coordinates'] }]);
    makeDbMock();
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: MAX_ALERTS_PER_RUN });
    const keys = NotificationService.notifyAdmin.mock.calls.map((call) => call[3].metadata.dedupeKey);
    expect(keys[0]).toBe('lawn-email-gap:lawn-1:no_coordinates');
    expect(keys.filter((key) => key.startsWith('accepted-schedule:'))).toHaveLength(MAX_ALERTS_PER_RUN - 1);
  });

  test('acceptance findings use the existing admin bell, a STABLE per-estimate+family dedupe key, and evidenceKey as dedupeVersion', async () => {
    // The key used to embed evidenceKey directly and churned daily (it
    // hashes every family row's row_revision/scheduled_date) — one customer
    // rang 9 times in 9 days for the same standing gap. Now the key is
    // stable per estimate+family; evidenceKey rides as dedupeVersion so
    // notifyAdmin re-surfaces the ONE standing row unread on a real
    // evidence change instead of minting a second row.
    const gap = { estimateId: 'e-1', customerId: 'c-1', serviceFamily: 'pest_control', pattern: 'monthly',
      expectedVisits: 12, recordedVisits: 1, issues: ['missing_recurrence'], evidenceKey: 'evidence-1', appointmentIds: ['s-1'] };
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap]);
    makeDbMock();
    expect(await runInner({ now: NOW })).toMatchObject({ acceptedScheduleGaps: 1, acceptedScheduleCheckFailed: false, alerted: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).toMatchObject({
      bell: true,
      link: '/admin/customers?customerId=c-1',
      dedupeKey: 'accepted-schedule:e-1:pest_control',
      refreshOnDedupe: true,
      dedupeVersion: 'evidence-1',
      metadata: { dedupeKey: 'accepted-schedule:e-1:pest_control' },
    });

    // Same estimate+family, same evidence → dedupes onto the standing row.
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap]);
    makeDbMock({ alertedKeys: new Set(['accepted-schedule:e-1:pest_control']) });
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 0 });

    // Evidence churns (routine field change) — the KEY is unaffected; only
    // dedupeVersion changes, which notifyAdmin (tested in its own suite)
    // uses to decide whether to refresh the standing row. This suite only
    // has to prove the correct key/version reach notifyAdmin, never a
    // SECOND key.
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([{ ...gap, evidenceKey: 'evidence-2' }]);
    makeDbMock({ alertedKeys: new Set(['accepted-schedule:e-1:pest_control']) });
    await runInner({ now: NOW });
    const lastCall = NotificationService.notifyAdmin.mock.calls.at(-1);
    expect(lastCall[3].dedupeKey).toBe('accepted-schedule:e-1:pest_control');
    expect(lastCall[3].dedupeVersion).toBe('evidence-2');
  });

  test('an unavailable acceptance check is reported while existing checks keep running', async () => {
    findAcceptedRecurringScheduleGaps.mockRejectedValueOnce(new Error('read failed'));
    makeDbMock({ coverageRows: [unpricedChild()] });
    expect(await runInner({ now: NOW })).toMatchObject({ acceptedScheduleCheckFailed: true, alerted: 1 });
  });
});


describe('alert episodes (ALERT_EPISODES)', () => {
  const gap = (over = {}) => ({ estimateId: 'e-1', customerId: 'c-1', serviceFamily: 'pest_control', pattern: 'monthly',
    expectedVisits: 12, recordedVisits: 1, issues: ['missing_recurrence'], evidenceKey: 'evidence-1', appointmentIds: ['s-1'], ...over });
  const openKeysByPrefix = (byPrefix) => NotificationService.openAdminAlertKeys.mockImplementation(async (_conn, prefix) => byPrefix[prefix] || []);
  const closedBy = () => Object.fromEntries(NotificationService.closeAdminAlertKeys.mock.calls.map(([, keys, reason]) => [reason, keys]));

  test('every live finding goes through the reopen wrapper with the caller\'s own options; notifyAdmin is never called directly', async () => {
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap()]);
    makeDbMock({ coverageRows: [unpricedChild()] });
    await runInner({ now: NOW });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2); // via the delegating wrapper mock
    expect(NotificationService.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
    const [category, , , unpricedOpts] = NotificationService.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('alert');
    // No version and no refresh for an ordinary class: a standing row must dedupe silently.
    expect(unpricedOpts).toEqual({
      link: '/admin/dispatch', bell: true, dedupeKey: 'unpriced-series:ss-parent-1',
      metadata: expect.objectContaining({ dedupeKey: 'unpriced-series:ss-parent-1' }),
    });
    // Accepted-schedule keeps its evidence version at generation 0.
    expect(NotificationService.raiseAdminAlertWithReopen.mock.calls[1][3]).toMatchObject({
      dedupeKey: 'accepted-schedule:e-1:pest_control', dedupeVersion: 'evidence-1', refreshOnDedupe: true,
    });
  });

  test('the cap counts real rings only: silent dedupes onto standing rows never use it up', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 6 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    // The first 12 are standing (silent); the last 4 are new.
    const standing = new Set(Array.from({ length: 12 }, (_, i) => `lawn-email-gap:cust-${i}:no_coordinates`));
    makeDbMock({ alertedKeys: standing });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(4);
    expect(NotificationService.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN + 6);

    // A backlog of new rings still stops at the cap.
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 6 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    makeDbMock({ alertedKeys: new Set(['lawn-email-gap:cust-0:no_coordinates']) });
    NotificationService.raiseAdminAlertWithReopen.mockClear();
    expect((await runInner({ now: NOW })).alerted).toBe(MAX_ALERTS_PER_RUN);
    expect(NotificationService.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN + 1);
  });

  test('a re-rung (reopened) row counts against the cap like a new one', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: 3 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    makeDbMock();
    NotificationService.raiseAdminAlertWithReopen.mockImplementation(async (_c, _t, _b, opts) => (
      opts.dedupeKey.endsWith('cust-0:no_coordinates')
        ? { id: 5, deduped: true, refreshed: true, rung: true, rang: true }
        : { id: 5, deduped: true, rang: false }
    ));
    expect((await runInner({ now: NOW })).alerted).toBe(1);
  });

  test('the close pass closes absent keys of each class, judged against the complete live set', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce([{ customerId: 'cust-live', fixable: ['no_coordinates'] }]);
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap()]);
    makeDbMock({ coverageRows: [unpricedChild()] });
    openKeysByPrefix({
      'unpriced-series:': ['unpriced-series:ss-parent-1', 'unpriced-series:ss-gone'],
      'lawn-email-gap:': ['lawn-email-gap:cust-live:no_coordinates', 'lawn-email-gap:cust-fixed:no_email'],
      'accepted-schedule:': ['accepted-schedule:e-1:pest_control', 'accepted-schedule:e-9:pest_control'],
    });
    const result = await runInner({ now: NOW });
    expect(closedBy()).toEqual({
      'no longer unpriced in the look-ahead window': ['unpriced-series:ss-gone'],
      'gap resolved': ['lawn-email-gap:cust-fixed:no_email', 'accepted-schedule:e-9:pest_control'],
    });
    expect(result).toMatchObject({ closed: 3, closePassFailed: false });
    expect(NotificationService.closeAdminAlertKeys.mock.calls[0][0]).toBe(db);
  });

  test('the close pass runs even when the cap stopped the ring loop, and never closes a live key that was capped out', async () => {
    findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN + 3 }, (_, i) => (
      { customerId: `cust-${i}`, fixable: ['no_coordinates'] }
    )));
    makeDbMock();
    openKeysByPrefix({ 'lawn-email-gap:': [`lawn-email-gap:cust-${MAX_ALERTS_PER_RUN + 2}:no_coordinates`, 'lawn-email-gap:cust-old:no_email'] });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    expect(closedBy()).toEqual({ 'gap resolved': ['lawn-email-gap:cust-old:no_email'] });
  });

  test('a class whose check failed is never closed (its live set is unknown)', async () => {
    findLawnEmailAudienceGaps.mockRejectedValueOnce(new Error('lawn read failed'));
    findAcceptedRecurringScheduleGaps.mockRejectedValueOnce(new Error('accepted read failed'));
    makeDbMock();
    openKeysByPrefix({
      'lawn-email-gap:': ['lawn-email-gap:cust-1:no_email'],
      'accepted-schedule:': ['accepted-schedule:e-1:pest_control'],
      'unpriced-series:': ['unpriced-series:ss-gone'],
    });
    await runInner({ now: NOW });
    expect(closedBy()).toEqual({ 'no longer unpriced in the look-ahead window': ['unpriced-series:ss-gone'] });
  });

  test('an unpriced series with an OVERDUE unpriced visit stays open even though it no longer pages', async () => {
    makeDbMock({ coverageRows: [unpricedChild({ service_date: '2026-07-30' })] });
    openKeysByPrefix({ 'unpriced-series:': ['unpriced-series:ss-parent-1'] });
    const result = await runInner({ now: NOW });
    expect(result.unpricedSeries).toBe(0);
    expect(NotificationService.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  describe('prepay coverage closes', () => {
    const key = (visit, tail = 'annual_coverage_unverified:abc') => `prepay-coverage:${visit}:${tail}`;
    const V = (n) => `0000000${n}-0000-4000-8000-000000000000`;
    test('a completed or rescheduled visit stays open; a cancelled, skipped, no-show or gone visit closes as did-not-run; a live visit closes as resolved', async () => {
      makeDbMock({
        staleRows: [
          { id: V(1), status: 'completed' }, { id: V(2), status: 'rescheduled' },
          { id: V(3), status: 'cancelled' }, { id: V(4), status: 'canceled' }, { id: V(5), status: 'skipped' },
          { id: V(6), status: 'no_show' }, { id: V(7), status: 'scheduled' }, { id: V(8), status: null },
        ],
      });
      openKeysByPrefix({ 'prepay-coverage:': [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(V(n))) });
      await runInner({ now: NOW });
      expect(closedBy()).toEqual({
        'visit did not run': [key(V(3)), key(V(4)), key(V(5)), key(V(6)), key(V(9))],
        'gap resolved': [key(V(7)), key(V(8))],
      });
    });

    test('a live visit moved past the look-ahead window closes as moved, not resolved (it re-rings once back in the window)', async () => {
      makeDbMock({ staleRows: [{ id: V(1), status: 'scheduled', service_date: '2099-01-01' }] });
      openKeysByPrefix({ 'prepay-coverage:': [key(V(1))] });
      await runInner({ now: NOW });
      expect(closedBy()).toEqual({ 'moved past the look-ahead window': [key(V(1))] });
    });

    test('a key superseded by a new evidence key for the same visit closes as superseded; the new key stays', async () => {
      const row = unpricedChild({ id: V(7), estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100,
        annual_prepay_term_id: 'term-1', prepay_payment_evidence: [['payment-1', 'refunded', 'full', '2040-01-01T12:00:00Z']] });
      makeDbMock({ coverageRows: [row], staleRows: [{ id: V(7), status: 'scheduled' }] });
      await runInner({ now: NOW });
      const liveKey = NotificationService.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey;
      expect(liveKey).toMatch(new RegExp(`^prepay-coverage:${V(7)}:annual_coverage_unverified:`));
      const oldKey = key(V(7), 'annual_coverage_unverified:oldhash');
      openKeysByPrefix({ 'prepay-coverage:': [liveKey, oldKey] });
      NotificationService.raiseAdminAlertWithReopen.mockClear();
      await runInner({ now: NOW });
      expect(closedBy()).toEqual({ superseded: [oldKey] });
    });

    test('a replacement the per-run cap held back keeps the old warning open; the run that delivers it closes the old one', async () => {
      const row = unpricedChild({ id: V(7), estimated_price: 100, prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100,
        annual_prepay_term_id: 'term-1', prepay_payment_evidence: [['payment-1', 'refunded', 'full', '2040-01-01T12:00:00Z']] });
      makeDbMock({ coverageRows: [row], staleRows: [{ id: V(7), status: 'scheduled' }] });
      await runInner({ now: NOW });
      const liveKey = NotificationService.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey;
      const oldKey = key(V(7), 'annual_coverage_unverified:oldhash');
      // Lawn gaps ring before prepay: MAX new lawn bells fill the cap, so the
      // prepay replacement is not delivered this run.
      findLawnEmailAudienceGaps.mockResolvedValueOnce(Array.from({ length: MAX_ALERTS_PER_RUN }, (_, i) => (
        { customerId: `cust-cap-${i}`, fixable: ['no_coordinates'] }
      )));
      openKeysByPrefix({ 'prepay-coverage:': [oldKey] });
      NotificationService.raiseAdminAlertWithReopen.mockClear();
      NotificationService.closeAdminAlertKeys.mockClear();
      const capped = await runInner({ now: NOW });
      expect(capped.alerted).toBe(MAX_ALERTS_PER_RUN);
      expect(NotificationService.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeKey)).not.toContain(liveKey);
      expect(closedBy()).toEqual({});
      // Next run: the replacement is delivered, and only then is the old one superseded.
      NotificationService.closeAdminAlertKeys.mockClear();
      await runInner({ now: NOW });
      expect(closedBy()).toEqual({ superseded: [oldKey] });
    });

    test('a key whose visit id is not a uuid is treated as a visit that is gone, never sent to the database', async () => {
      makeDbMock();
      openKeysByPrefix({ 'prepay-coverage:': [key('not-a-uuid')] });
      await runInner({ now: NOW });
      expect(closedBy()).toEqual({ 'visit did not run': [key('not-a-uuid')] });
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
    });
  });

  test('a failing close pass is reported, not thrown, and the rings stand', async () => {
    makeDbMock({ coverageRows: [unpricedChild()] });
    NotificationService.openAdminAlertKeys.mockRejectedValueOnce(new Error('db hiccup'));
    expect(await runInner({ now: NOW })).toMatchObject({ alerted: 1, closed: 0, closePassFailed: true });
  });

  test('kill switch off: exactly the pre-episode calls, no close queries, no reopen wrapper', async () => {
    alertEpisodesLive.mockReturnValue(false);
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap()]);
    makeDbMock({ coverageRows: [unpricedChild()] });
    openKeysByPrefix({ 'unpriced-series:': ['unpriced-series:ss-gone'] });
    const result = await runInner({ now: NOW });
    expect(NotificationService.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(NotificationService.openAdminAlertKeys).not.toHaveBeenCalled();
    expect(NotificationService.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
    expect(NotificationService.notifyAdmin.mock.calls[0][3]).toEqual({
      link: '/admin/dispatch', bell: true, dedupeKey: 'unpriced-series:ss-parent-1',
      metadata: expect.objectContaining({ dedupeKey: 'unpriced-series:ss-parent-1' }),
    });
    expect(result).toMatchObject({ alerted: 2 });
    expect(result.closed).toBeUndefined();
    // A refresh that rang still does not count toward the cap when killed (today's behavior).
    findAcceptedRecurringScheduleGaps.mockResolvedValueOnce([gap()]);
    makeDbMock();
    NotificationService.notifyAdmin.mockImplementation(async () => ({ id: 1, deduped: true, refreshed: true, rung: true }));
    expect((await runInner({ now: NOW })).alerted).toBe(0);
  });
});

describe('alertEpisodesLive (the real reader)', () => {
  const { alertEpisodesLive: real } = jest.requireActual('../config/feature-gates');
  const saved = process.env.ALERT_EPISODES;
  afterAll(() => { if (saved === undefined) delete process.env.ALERT_EPISODES; else process.env.ALERT_EPISODES = saved; });
  test.each([[undefined, true], ['', true], ['on', true], ['true', true], ['off', false], ['OFF', false], [' False ', false], ['0', false], ['false', false]])(
    'ALERT_EPISODES=%j -> live=%s', (value, live) => {
      if (value === undefined) delete process.env.ALERT_EPISODES; else process.env.ALERT_EPISODES = value;
      expect(real()).toBe(live);
    });
});


describe('unpriced series: a completed, still-unpriced, uninvoiced visit holds its bell open', () => {
  const ROOT = '0000000a-0000-4000-8000-000000000000';
  const CHILD = '0000000b-0000-4000-8000-000000000000';
  const SIBLING_ROOT = '0000000c-0000-4000-8000-000000000000';
  const KEY = `unpriced-series:${ROOT}`;
  const BELL = { dedupe_key: KEY, created_at: '2026-08-01T12:00:00Z', rung_at: null };
  const completed = (over = {}) => unpricedChild({
    id: CHILD, status: 'completed', recurring_parent_id: ROOT, service_date: '2026-08-03',
    completed_time: '2026-08-03T15:00:00Z', ...over,
  });
  const openKeys = (...keys) => NotificationService.openAdminAlertKeys.mockImplementation(async (_conn, prefix) => keys.filter((k) => k.startsWith(prefix)));
  const closedKeys = () => NotificationService.closeAdminAlertKeys.mock.calls.flatMap(([, keys]) => keys);
  const run = async (rows, extra = {}) => {
    makeDbMock({ completedRows: rows, bellRows: [BELL], ...extra });
    openKeys(KEY);
    return runInner({ now: NOW });
  };

  test('completed unpriced + uninvoiced: the bell stays open, and a closed-by-absence sibling key still closes', async () => {
    openKeys(KEY, `unpriced-series:${SIBLING_ROOT}`);
    makeDbMock({ completedRows: [completed()], bellRows: [BELL, { ...BELL, dedupe_key: `unpriced-series:${SIBLING_ROOT}` }] });
    const result = await runInner({ now: NOW });
    expect(closedKeys()).toEqual([`unpriced-series:${SIBLING_ROOT}`]);
    expect(result.closed).toBe(1);
    // The check reads the shared coverage select restricted to completed visits in the alerted roots.
    const scan = db.mock.results.map((r) => r.value).find((c) => c.where.mock.calls.some(([a, b]) => a === 'ss.status' && b === 'completed'));
    expect(scan.leftJoin).toHaveBeenCalledWith('invoices as first_application_invoice', 'first_application_invoice.id', 'ss.first_application_invoice_id');
    expect(scan.whereIn).not.toHaveBeenCalledWith('ss.id', expect.anything()); // root membership lives in the where(fn) group
  });

  test('a completed visit invoiced in any live status is closed; a void/cancelled invoice does not count', async () => {
    invoicesByVisit({ [CHILD]: [{ id: 'inv-1', status: 'draft' }] });
    await run([completed()]);
    expect(closedKeys()).toEqual([KEY]);

    NotificationService.closeAdminAlertKeys.mockClear();
    invoicesByVisit({ [CHILD]: [{ id: 'inv-1', status: 'void' }, { id: 'inv-2', status: 'cancelled' }, { id: 'inv-3', status: 'canceled' }] });
    await run([completed()]);
    expect(closedKeys()).toEqual([]);
  });

  test('the check asks the invoice module for the visit\'s linked invoices (direct or via service record)', async () => {
    await run([completed()]);
    expect(anyInvoiceLinkedToVisit).toHaveBeenCalledWith(db, CHILD);
  });

  test('completed but priced (own row or parent) is closed', async () => {
    await run([completed({ estimated_price: '99.45' })]);
    expect(closedKeys()).toEqual([KEY]);
    NotificationService.closeAdminAlertKeys.mockClear();
    await run([completed({ parent_primary_line_price: '72.00' })]);
    expect(closedKeys()).toEqual([KEY]);
  });

  test('covered by a live combined first-application invoice is closed', async () => {
    await run([completed({ recurring_parent_id: null, id: ROOT, first_application_invoice_id: 'inv-1', first_application_invoice_status: 'sent' })]);
    expect(closedKeys()).toEqual([KEY]);
  });

  test('completed before the episode started is closed; at or after the bell\'s last ring holds', async () => {
    await run([completed({ completed_time: '2026-07-30T15:00:00Z' })]);
    expect(closedKeys()).toEqual([KEY]);

    // Exactly at the start holds (>=).
    NotificationService.closeAdminAlertKeys.mockClear();
    await run([completed({ completed_time: BELL.created_at })]);
    expect(closedKeys()).toEqual([]);

    // A reopen re-rang the bell later (rungAt): the episode starts there, so an older completion no longer holds.
    makeDbMock({ completedRows: [completed({ completed_time: '2026-08-03T15:00:00Z' })],
      bellRows: [{ ...BELL, rung_at: '2026-08-04T10:00:00Z' }] });
    openKeys(KEY);
    await runInner({ now: NOW });
    expect(closedKeys()).toEqual([KEY]);
  });

  test('annual-prepay covered (validator confirms) is closed; an unconfirmed stamp holds', async () => {
    const stamped = completed({ prepaid_amount: '559.20', prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' });
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    await run([stamped]);
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: CHILD }), db);
    expect(closedKeys()).toEqual([KEY]);

    NotificationService.closeAdminAlertKeys.mockClear();
    annualPrepayCoversVisit.mockResolvedValue(false);
    await run([stamped]);
    annualPrepayCoversVisit.mockResolvedValue(false);
    expect(closedKeys()).toEqual([]);
  });

  test('only the alerted series holds: a completed unpriced visit of another root, or a booster child, does not', async () => {
    // Booster child (is_recurring=false under the root) is its own subject.
    await run([completed({ is_recurring: false })]);
    expect(closedKeys()).toEqual([KEY]);
    NotificationService.closeAdminAlertKeys.mockClear();
    await run([completed({ recurring_parent_id: SIBLING_ROOT })]);
    expect(closedKeys()).toEqual([KEY]);
  });

  test('a run with nothing absent, or only overdue-held roots, never reads completed visits', async () => {
    makeDbMock({ coverageRows: [unpricedChild({ id: ROOT, recurring_parent_id: null, service_date: '2026-07-30' })] });
    openKeys(KEY);
    await runInner({ now: NOW });
    expect(anyInvoiceLinkedToVisit).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalledWith('notifications');
  });
});

describe('raiseAdminAlertWithReopen row lock', () => {
  test('the standing-row read takes a row lock (forUpdate) inside the transaction after the advisory lock, and notifyAdmin runs on that transaction', async () => {
    const real = jest.requireActual('../services/notification-service');
    const order = [];
    const chain = { where: jest.fn(() => chain), whereRaw: jest.fn(() => chain), orderBy: jest.fn(() => chain) };
    chain.forUpdate = jest.fn(() => { order.push('forUpdate'); return chain; });
    chain.first = jest.fn(async () => { order.push('first'); return { metadata: { autoCleared: true, recurrenceGeneration: 1 } }; });
    const trx = jest.fn(() => chain);
    trx.raw = jest.fn(async () => { order.push('advisory'); });
    db.transaction = jest.fn(async (fn) => fn(trx));
    const notifyAdmin = jest.fn(async () => ({ id: 1, deduped: true, refreshed: true, rung: true }));
    const result = await real.raiseAdminAlertWithReopen.call({ notifyAdmin }, 'alert', 't', 'b', { dedupeKey: 'k', dedupeVersion: 'v', metadata: { dedupeKey: 'k' } });
    expect(order).toEqual(['advisory', 'forUpdate', 'first']);
    expect(chain.forUpdate).toHaveBeenCalledTimes(1);
    // The newest row for the key decides (a rolling-window key can hold several).
    expect(chain.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    expect(notifyAdmin.mock.calls[0][3]).toMatchObject({ trx, dedupeVersion: 'v::g2', refreshOnDedupe: true, metadata: { autoCleared: false, recurrenceGeneration: 2 } });
    expect(result.rang).toBe(true);
    delete db.transaction;
  });
});
