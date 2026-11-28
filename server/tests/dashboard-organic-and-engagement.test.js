/**
 * Unit & route tests for PR #2A:
 * - server/services/dashboard-organic-traffic.js (GSC + GA4 30d equal windows, fail-soft)
 * - GET /api/admin/dashboard/organic-traffic & /report-engagement
 */
const mockOrganic = jest.fn();
const mockDashboardTool = jest.fn();

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../utils/route-cache', () => ({
  cacheRoute: () => (_req, _res, next) => next(),
}));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({
  executeDashboardTool: (...args) => mockDashboardTool(...args),
  INTERNAL_TEST_CUSTOMERS: [],
}));

const {
  computeOrganicTraffic,
  equalWindowBounds,
  pctDelta,
  summarizeGscRows,
  summarizeGa4Rows,
} = require('../services/dashboard-organic-traffic');

describe('dashboard-organic-traffic pure helpers & fail-soft aggregation', () => {
  test('equalWindowBounds builds two non-overlapping equal-length windows anchored to latestDate', () => {
    expect(equalWindowBounds('2026-11-24', 30)).toEqual({
      curFrom: '2026-10-26',
      curTo: '2026-11-24',
      prevFrom: '2026-09-26',
      prevTo: '2026-10-25',
    });
  });

  test('pctDelta returns null when prior is zero or missing', () => {
    expect(pctDelta(120, 100)).toBe(20);
    expect(pctDelta(75, 100)).toBe(-25);
    expect(pctDelta(50, 0)).toBeNull();
    expect(pctDelta(null, 100)).toBeNull();
  });

  test('summarizeGscRows computes impression-weighted average position across domains', () => {
    const out = summarizeGscRows([
      { clicks: 40, impressions: 1000, avg_position: 5, nonbrand_clicks: 30, domain: 'wavespestcontrol.com' },
      { clicks: 10, impressions: 100, avg_position: 27, nonbrand_clicks: 10, domain: 'bradentonflpestcontrol.com' },
    ]);
    expect(out).toEqual({
      clicks: 50,
      impressions: 1100,
      nonbrandClicks: 40,
      ctr: 4.5,
      avgPosition: 7,
      domainsCount: 2,
    });
  });

  test('summarizeGa4Rows totals sessions, users, pageviews, conversions', () => {
    expect(summarizeGa4Rows([
      { sessions: 100, users: 80, new_users: 60, pageviews: 210, conversions: 4 },
      { sessions: 50, users: 40, new_users: 25, pageviews: 90, conversions: 2 },
    ])).toEqual({ sessions: 150, users: 120, newUsers: 85, pageviews: 300, conversions: 6 });
  });

  test('computeOrganicTraffic degrades one failed source independently while returning the other', async () => {
    const fakeConn = (table) => {
      if (table === 'gsc_performance_daily') {
        const qb = {
          where() { return qb; },
          whereBetween() { return qb; },
          max() { return qb; },
          first() { return Promise.reject(new Error('gsc offline')); },
        };
        return qb;
      }
      let mode = 'list';
      let range = null;
      const qb = {
        where() { return qb; },
        whereBetween(_col, r) { range = r; return qb; },
        max() { mode = 'max'; return qb; },
        select() { return qb; },
        first() { return Promise.resolve(mode === 'max' ? { latest: '2026-11-26' } : null); },
        then(resolve, reject) {
          const rows = range && range[1] === '2026-11-26'
            ? [{ sessions: 200, users: 150, new_users: 100, pageviews: 420, conversions: 10 }]
            : [{ sessions: 100, users: 80, new_users: 60, pageviews: 200, conversions: 5 }];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return qb;
    };

    const result = await computeOrganicTraffic(fakeConn);
    expect(result.gsc).toEqual({ error: 'unavailable' });
    expect(result.ga4).toMatchObject({
      sessions: 200,
      users: 150,
      conversions: 10,
      sessionsDeltaPct: 100,
      latestDate: '2026-11-26',
    });
  });
});

describe('admin-dashboard /organic-traffic and /report-engagement routes', () => {
  let router;
  beforeAll(() => {
    jest.doMock('../services/dashboard-organic-traffic', () => ({
      computeOrganicTraffic: (...args) => mockOrganic(...args),
    }));
    router = require('../routes/admin-dashboard');
  });

  async function invokeGet(path, query = {}) {
    const layer = router.stack.find((e) => e.route?.path === path && e.route?.methods?.get);
    if (!layer) throw new Error(`GET ${path} not found`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { query, technicianId: 'admin-1' };
    const result = { status: 200, body: null };
    const res = {
      status(c) { result.status = c; return res; },
      json(p) { result.body = p; return res; },
    };
    await handler(req, res, (err) => { if (err) throw err; });
    return result;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /organic-traffic delegates to computeOrganicTraffic', async () => {
    mockOrganic.mockResolvedValueOnce({ days: 30, gsc: { clicks: 120 }, ga4: { sessions: 340 } });
    const res = await invokeGet('/organic-traffic');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ days: 30, gsc: { clicks: 120 }, ga4: { sessions: 340 } });
  });

  test('GET /report-engagement validates optional date_from/date_to and forwards to get_report_engagement', async () => {
    const bad = await invokeGet('/report-engagement', { date_from: 'not-a-date' });
    expect(bad.status).toBe(400);
    expect(mockDashboardTool).not.toHaveBeenCalled();

    mockDashboardTool.mockResolvedValueOnce({
      total: { sent: 100, opened: 62, open_rate_pct: 62 },
      reserviceWithin14Days: { pest: { visits: 80, reserviced: 1, rate_pct: 1.3 }, lawn: { visits: 20, reserviced: 0, rate_pct: 0 } },
    });
    const ok = await invokeGet('/report-engagement', { date_from: '2026-11-01', date_to: '2026-11-26' });
    expect(ok.status).toBe(200);
    expect(mockDashboardTool).toHaveBeenCalledWith('get_report_engagement', { date_from: '2026-11-01', date_to: '2026-11-26' });
    expect(ok.body.total.open_rate_pct).toBe(62);
  });
});
