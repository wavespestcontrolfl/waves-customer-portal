/**
 * Ads report windows (10-29 Ads screen audit, finding #8).
 *
 *  - GET /campaigns last7d / last30d cover 7 / 30 COMPLETE ET days. The Google
 *    sync runs once at 6 AM, so today's row is partial; `date >= today-7` alone
 *    covered 8 dates.
 *  - GET /service-lines?period=7d covers today and the 6 days before it.
 *  - The Google / Meta sync ranges and the call-view query use ET dates, not
 *    UTC (a UTC date is already tomorrow after 8 PM ET).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});

// db stub: each table is an in-memory row list; where(col, op, val) filters it.
const mockTables = {};
const mockCompare = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '!=': (a, b) => a !== b,
  '=': (a, b) => a === b,
};
const mockDb = jest.fn((table) => {
  let rows = (mockTables[table] || []).slice();
  const builder = {
    where: jest.fn((col, op, val) => {
      if (typeof col === 'string' && val !== undefined) rows = rows.filter((r) => mockCompare[op](r[col], val));
      return builder;
    }),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    distinct: jest.fn(() => builder),
    first: jest.fn(() => Promise.resolve(rows[0] || null)),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
});
jest.mock('../models/db', () => mockDb);

const express = require('express');
const { etDateString, addETDays } = require('../utils/datetime-et');
const adsRouter = require('../routes/admin-ads');
const GoogleAds = require('../services/ads/google-ads');
const CampaignAdvisor = require('../services/ads/campaign-advisor');
const BudgetManager = require('../services/ads/budget-manager');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function get(path) {
  const res = await fetch(`${baseUrl}/api/admin/ads${path}`);
  return { status: res.status, body: await res.json() };
}

// One row per ET date from `fromDaysAgo` days ago through today.
function daysBack(fromDaysAgo, make) {
  const now = new Date();
  return Array.from({ length: fromDaysAgo + 1 }, (_, i) => make(etDateString(addETDays(now, -(fromDaysAgo - i)))));
}

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
});

describe('GET /campaigns report windows', () => {
  test('last7d sums 7 complete days and last30d 30: today and older days stay out', async () => {
    mockTables.ad_campaigns = [{ id: 'c1', status: 'active', campaign_name: 'Search' }];
    // $1 on each of the 32 dates from 31 days ago through today.
    mockTables.ad_performance_daily = daysBack(31, (date) => ({
      campaign_id: 'c1', date, cost: '1.00', conversion_value: '0', conversions: '0', clicks: 1, impressions: 10,
    }));

    const { status, body } = await get('/campaigns');

    expect(status).toBe(200);
    expect(body.campaigns[0].last7d.spend).toBe(7);
    expect(body.campaigns[0].last7d.clicks).toBe(7);
    expect(body.campaigns[0].last30d.spend).toBe(30);
  });
});

describe('advisor inputs report windows', () => {
  test('last7days and last30days hold complete ET days only', async () => {
    mockTables.ad_performance_daily = daysBack(31, (date) => ({ campaign_id: 'c1', date, cost: '1.00' }));
    const today = etDateString(new Date());
    const spies = [
      jest.spyOn(CampaignAdvisor, 'getWeekCapacity').mockResolvedValue([]),
      jest.spyOn(CampaignAdvisor, 'loadNegativeKeywords').mockResolvedValue([]),
      jest.spyOn(BudgetManager, 'getTechCountForArea').mockResolvedValue(1),
    ];
    try {
      const inputs = await CampaignAdvisor.loadAdvisorInputs(new Date());
      expect(inputs.last7days).toHaveLength(7);
      expect(inputs.last30days).toHaveLength(30);
      expect(inputs.last7days.some((r) => r.date === today)).toBe(false);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('GET /service-lines report window', () => {
  test('7d counts today and the 6 days before it', async () => {
    // One lead on each of the 9 dates from 8 days ago through today.
    mockTables.ad_service_attribution = daysBack(8, (lead_date) => ({
      lead_date, service_bucket: 'recurring', service_line: 'pest', funnel_stage: 'lead',
    }));

    const { status, body } = await get('/service-lines?period=7d');

    expect(status).toBe(200);
    expect(body.totalLeads).toBe(7);
  });
});

describe('Google Ads date ranges use ET dates', () => {
  test('gaqlDateRange at 9 PM ET ends on the ET date, not the UTC one', () => {
    // 2026-10-30T01:00Z = Oct 29, 9:00 PM EDT.
    const { since, until } = GoogleAds._private.gaqlDateRange(7, new Date('2026-10-30T01:00:00Z'));
    expect(until).toBe('2026-10-29');
    expect(since).toBe('2026-10-22');
  });

  test('gaqlDateRange across the fall-back change (Nov 1, 10 PM EST)', () => {
    const { since, until } = GoogleAds._private.gaqlDateRange(7, new Date('2026-11-02T03:00:00Z'));
    expect(until).toBe('2026-11-01');
    expect(since).toBe('2026-10-25');
  });

  test('the call-view query starts on an ET date', () => {
    jest.useFakeTimers({
      now: new Date('2026-10-30T01:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    try {
      expect(GoogleAds._private.buildCallViewQuery(30, 10)).toContain(">= '2026-09-29'");
    } finally {
      jest.useRealTimers();
    }
  });
});
