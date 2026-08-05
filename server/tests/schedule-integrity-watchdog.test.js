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

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
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
    estimated_price: null, primary_line_price: null,
    recurring_parent_id: 'ss-parent-1',
    parent_estimated_price: null, parent_primary_line_price: null,
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
    for (const m of ['whereIn', 'where', 'whereNotIn', 'leftJoin', 'select', 'orderBy']) {
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

  test('seriesRootId collapses children onto the parent', () => {
    expect(seriesRootId(unpricedChild())).toBe('ss-parent-1');
    expect(seriesRootId(unpricedChild({ recurring_parent_id: null }))).toBe('ss-child-1');
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

  test('per-run cap stops at MAX_ALERTS_PER_RUN and leaves the rest for next tick', async () => {
    const staleRows = Array.from({ length: MAX_ALERTS_PER_RUN + 3 }, (_, i) => staleVisit({ id: `sv-${i}` }));
    makeDbMock({ staleRows });
    const result = await runInner({ now: NOW });
    expect(result.alerted).toBe(MAX_ALERTS_PER_RUN);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(MAX_ALERTS_PER_RUN);
  });

  test('a swallowed notification insert fails the run loudly', async () => {
    makeDbMock({ staleRows: [staleVisit()] });
    NotificationService.notifyAdmin.mockImplementation(async () => null);
    await expect(runInner({ now: NOW })).rejects.toThrow('pager output lost');
  });
});
