// Schedule-integrity watchdog (2026-08-04). Born from a Tree & Shrub
// recurring series found live with no price on any row and its first visit
// stuck in on_site for two weeks — never completed, never billed — plus 89
// past-dated visits parked in on_site/en_route the same prod sweep. These
// tests pin the pure classifiers (stale in-progress, unpriced-series with
// parent-price inheritance, series-root collapsing), the runInner alert loop
// (forever-dedupe, one bell per series, per-run cap, loud insert failure),
// and the gate-off no-op. All fixture identities are synthetic.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 1 })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, fn) => fn()) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  annualPrepayCoversVisit: jest.fn(async () => false),
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
}));
jest.mock('../services/irrigation-weekly-email', () => ({
  findLawnEmailAudienceGaps: jest.fn(async () => []),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { annualPrepayCoversVisit } = require('../services/annual-prepay-renewals');
const { findLawnEmailAudienceGaps } = require('../services/irrigation-weekly-email');
const {
  runScheduleIntegrityWatchdog,
  runInner,
  rowHasPrice,
  isStaleInProgress,
  isUnpricedSeriesVisit,
  seriesRootId,
  MAX_ALERTS_PER_RUN,
} = require('../services/schedule-integrity-watchdog');

// 2026-08-04 noon ET.
const NOW = new Date('2026-08-04T16:00:00Z');
const TODAY_ET = '2026-08-04';

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
// it resolves the row list; .first() resolves per-dedupe-key presence.
function makeDbMock({ staleRows = [], upcomingRows = [], alertedKeys = new Set() } = {}) {
  db.mockImplementation((table) => {
    const rows = table === 'scheduled_services' ? staleRows
      : table === 'scheduled_services as ss' ? upcomingRows
        : null;
    const c = {};
    for (const m of ['whereIn', 'where', 'whereNull', 'whereNotIn', 'leftJoin', 'select', 'orderBy']) {
      c[m] = jest.fn(() => c);
    }
    c.whereRaw = jest.fn((sql, params) => { c._dedupeKey = params && params[0]; return c; });
    c.first = jest.fn(async () => (alertedKeys.has(c._dedupeKey) ? { id: 99 } : undefined));
    c.then = (res, rej) => Promise.resolve(rows || []).then(res, rej);
    return c;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.notifyAdmin.mockImplementation(async () => ({ id: 1 }));
});

describe('classifiers', () => {
  test('rowHasPrice: either price field counts; zero and null do not', () => {
    expect(rowHasPrice({ estimated_price: '99.45' })).toBe(true);
    expect(rowHasPrice({ primary_line_price: 117 })).toBe(true);
    expect(rowHasPrice({ estimated_price: '0.00', primary_line_price: null })).toBe(false);
    expect(rowHasPrice({})).toBe(false);
  });

  test('isStaleInProgress: past-dated on_site/en_route only', () => {
    expect(isStaleInProgress(staleVisit(), TODAY_ET)).toBe(true);
    expect(isStaleInProgress(staleVisit({ status: 'en_route' }), TODAY_ET)).toBe(true);
    // Today's visit is legitimately mid-service — never page during it.
    expect(isStaleInProgress(staleVisit({ service_date: TODAY_ET }), TODAY_ET)).toBe(false);
    expect(isStaleInProgress(staleVisit({ status: 'confirmed' }), TODAY_ET)).toBe(false);
    expect(isStaleInProgress(staleVisit({ service_date: null }), TODAY_ET)).toBe(false);
  });

  test('isUnpricedSeriesVisit: a price ANYWHERE in the series suppresses', () => {
    expect(isUnpricedSeriesVisit(unpricedChild())).toBe(true);
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
    expect(result).toMatchObject({ skipped: false, stale: 0, unpricedSeries: 0, alerted: 0 });
  });
});

describe('runInner alerting', () => {
  test('a stale visit rings once with its dedupe key and dispatch link', async () => {
    makeDbMock({ staleRows: [staleVisit()] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ stale: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [kind, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(kind).toBe('alert');
    expect(title).toContain('stuck on_site since 2026-07-21');
    expect(opts.link).toBe('/admin/dispatch');
    expect(opts.metadata.dedupeKey).toBe('stale-visit:sv-1');
    // 'alert' is silenced-by-default under GATE_ADMIN_BELL_POLICY — the
    // explicit site-level bell tag is what makes these pages actually ring.
    expect(opts.bell).toBe(true);
  });

  test('an already-alerted subject never rings twice', async () => {
    makeDbMock({ staleRows: [staleVisit()], alertedKeys: new Set(['stale-visit:sv-1']) });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ stale: 1, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an unpriced series rings ONE bell for many child visits', async () => {
    makeDbMock({
      upcomingRows: [
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
    makeDbMock({ upcomingRows: [unpricedChild({ parent_primary_line_price: '84.17' })] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 0, alerted: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an annual-prepay stamp suppresses ONLY when the term validator confirms coverage', async () => {
    const stamped = unpricedChild({ prepaid_amount: '559.20', prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' });
    // Validator confirms → no page.
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    makeDbMock({ upcomingRows: [stamped] });
    let result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 0, alerted: 0 });
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(expect.objectContaining({ id: 'ss-child-1' }), expect.anything());
    // Validator refutes (stale stamp, dead term) → fail-closed, page rings.
    annualPrepayCoversVisit.mockResolvedValueOnce(false);
    makeDbMock({ upcomingRows: [stamped] });
    result = await runInner({ now: NOW });
    expect(result).toMatchObject({ unpricedSeries: 1, alerted: 1 });
  });

  test('per-run cap stops at MAX_ALERTS_PER_RUN and leaves the rest for next tick', async () => {
    const staleRows = Array.from({ length: MAX_ALERTS_PER_RUN + 3 }, (_, i) => staleVisit({ id: `sv-${i}` }));
    makeDbMock({ staleRows });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN);
  });

  test('unpriced series ring BEFORE the stale backlog consumes the cap', async () => {
    // First-enable shape: a stale backlog bigger than the whole per-run cap
    // plus one same-day money-loss series. The series must still page today —
    // it can invoice at $0 while the backlog drains over days.
    const staleRows = Array.from({ length: MAX_ALERTS_PER_RUN + 5 }, (_, i) => staleVisit({ id: `sv-${i}` }));
    makeDbMock({ staleRows, upcomingRows: [unpricedChild()] });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    const keys = NotificationService.notifyAdmin.mock.calls.map(([, , , opts]) => opts.metadata.dedupeKey);
    expect(keys[0]).toBe('unpriced-series:ss-parent-1');
    expect(keys.filter((k) => k.startsWith('stale-visit:'))).toHaveLength(MAX_ALERTS_PER_RUN - 1);
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

  test('a failed lawn-gap check is REPORTED, never silently zero — and other classes still page', async () => {
    findLawnEmailAudienceGaps.mockRejectedValueOnce(new Error('db exploded'));
    makeDbMock({ staleRows: [staleVisit()] });
    const result = await runInner({ now: NOW });
    expect(result).toMatchObject({ lawnGapCheckFailed: true, lawnEmailGaps: 0, stale: 1, alerted: 1 });
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.dedupeKey).toBe('stale-visit:sv-1');
  });

  test('a swallowed notification insert fails the run loudly', async () => {
    makeDbMock({ staleRows: [staleVisit()] });
    NotificationService.notifyAdmin.mockImplementation(async () => null);
    await expect(runInner({ now: NOW })).rejects.toThrow('pager output lost');
  });
});
