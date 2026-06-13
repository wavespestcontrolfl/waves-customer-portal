const ORIGINAL_ENV = { ...process.env };

function metric(value) {
  return { value: String(value) };
}

function dimension(value) {
  return { value: String(value) };
}

function makeRow(dimensions, metrics) {
  return {
    dimensionValues: dimensions.map(dimension),
    metricValues: metrics.map(metric),
  };
}

describe('GA4 daily sync', () => {
  let dailyWrites;
  let sourceWrites;
  let runReport;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers().setSystemTime(new Date('2026-06-13T12:00:00.000Z'));

    process.env = {
      ...ORIGINAL_ENV,
      GA4_PROPERTY_ID: '123456789',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'svc@example.com', private_key: 'key' }),
    };

    dailyWrites = [];
    sourceWrites = [];

    const makeTable = (table) => ({
      insert: jest.fn((payload) => ({
        onConflict: jest.fn((conflict) => ({
          merge: jest.fn(async () => {
            if (table === 'ga4_daily_metrics') dailyWrites.push({ payload, conflict });
            if (table === 'ga4_traffic_sources') sourceWrites.push({ payload, conflict });
          }),
        })),
      })),
    });

    jest.doMock('../models/db', () => jest.fn((table) => makeTable(table)));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    runReport = jest.fn(async ({ requestBody }) => {
      const dims = (requestBody.dimensions || []).map((d) => d.name).join(',');
      const metrics = (requestBody.metrics || []).map((m) => m.name).join(',');

      if (dims === 'date' && metrics === 'sessions,totalUsers,newUsers,screenPageViews,bounceRate,averageSessionDuration') {
        return { data: { rows: [
          makeRow(['20260610'], [10, 8, 6, 20, 0.25, 35.5]),
          makeRow(['20260611'], [5, 4, 3, 8, 0.6, 12]),
        ] } };
      }

      if (dims === 'date' && metrics === 'keyEvents') {
        return { data: { rows: [
          makeRow(['20260610'], [2]),
          makeRow(['20260611'], [0]),
        ] } };
      }

      if (dims === 'date,deviceCategory') {
        return { data: { rows: [
          makeRow(['20260610', 'mobile'], [6]),
          makeRow(['20260610', 'desktop'], [4]),
          makeRow(['20260611', 'desktop'], [5]),
        ] } };
      }

      if (dims === 'date,landingPage') {
        return { data: { rows: [
          makeRow(['20260610', '/pest-control-bradenton-fl'], [7]),
          makeRow(['20260610', '/'], [3]),
          makeRow(['20260611', '/'], [5]),
        ] } };
      }

      if (dims === 'date,sessionSource,sessionMedium' && metrics === 'sessions,totalUsers,keyEvents') {
        return { data: { rows: [
          makeRow(['20260610', 'google', 'organic'], [7, 5, 2]),
          makeRow(['20260610', '(direct)', '(none)'], [3, 3, 0]),
          makeRow(['20260611', '(direct)', '(none)'], [5, 4, 0]),
        ] } };
      }

      throw new Error(`Unexpected GA4 report dims=${dims} metrics=${metrics}`);
    });

    jest.doMock('googleapis', () => ({
      google: {
        auth: { GoogleAuth: jest.fn() },
        analyticsdata: jest.fn(() => ({ properties: { runReport } })),
      },
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  test('syncDailyData writes per-day conversions, sources, devices, and landing pages', async () => {
    const GA4 = require('../services/analytics/google-analytics');

    const result = await GA4.syncDailyData(3);

    expect(result).toEqual({
      synced: true,
      period: { start: '2026-06-10', end: '2026-06-12' },
      rows: 2,
      sourceRows: 3,
    });

    expect(dailyWrites.map((w) => w.payload)).toEqual([
      expect.objectContaining({
        date: '2026-06-10',
        sessions: 10,
        users: 8,
        new_users: 6,
        pageviews: 20,
        bounce_rate: 25,
        avg_session_duration: 35.5,
        conversions: 2,
        top_source: 'google',
        top_medium: 'organic',
        top_landing_page: '/pest-control-bradenton-fl',
        mobile_pct: 60,
        desktop_pct: 40,
      }),
      expect.objectContaining({
        date: '2026-06-11',
        conversions: 0,
        top_source: '(direct)',
        top_medium: '(none)',
        top_landing_page: '/',
        mobile_pct: 0,
        desktop_pct: 100,
      }),
    ]);

    expect(sourceWrites.map((w) => w.payload)).toEqual([
      expect.objectContaining({ date: '2026-06-10', source: 'google', medium: 'organic', sessions: 7, users: 5, conversions: 2 }),
      expect.objectContaining({ date: '2026-06-10', source: '(direct)', medium: '(none)', sessions: 3, users: 3, conversions: 0 }),
      expect.objectContaining({ date: '2026-06-11', source: '(direct)', medium: '(none)', sessions: 5, users: 4, conversions: 0 }),
    ]);
    expect(sourceWrites[0].conflict).toEqual(['date', 'source', 'medium']);
    expect(runReport).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ metrics: [{ name: 'keyEvents' }] }),
    }));
    expect(runReport).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'keyEvents' },
        ],
      }),
    }));
  });

  test('syncDailyData falls back to legacy conversions metric when keyEvents is rejected', async () => {
    runReport.mockImplementation(async ({ requestBody }) => {
      const dims = (requestBody.dimensions || []).map((d) => d.name).join(',');
      const metrics = (requestBody.metrics || []).map((m) => m.name).join(',');

      if (metrics.includes('keyEvents')) {
        throw new Error('Metric keyEvents is not a valid metric');
      }

      if (dims === 'date' && metrics === 'sessions,totalUsers,newUsers,screenPageViews,bounceRate,averageSessionDuration') {
        return { data: { rows: [
          makeRow(['20260610'], [10, 8, 6, 20, 0.25, 35.5]),
        ] } };
      }

      if (dims === 'date' && metrics === 'conversions') {
        return { data: { rows: [
          makeRow(['20260610'], [2]),
        ] } };
      }

      if (dims === 'date,deviceCategory') {
        return { data: { rows: [
          makeRow(['20260610', 'mobile'], [6]),
          makeRow(['20260610', 'desktop'], [4]),
        ] } };
      }

      if (dims === 'date,landingPage') {
        return { data: { rows: [
          makeRow(['20260610', '/pest-control-bradenton-fl'], [7]),
        ] } };
      }

      if (dims === 'date,sessionSource,sessionMedium' && metrics === 'sessions,totalUsers,conversions') {
        return { data: { rows: [
          makeRow(['20260610', 'google', 'organic'], [7, 5, 2]),
        ] } };
      }

      throw new Error(`Unexpected GA4 report dims=${dims} metrics=${metrics}`);
    });

    const GA4 = require('../services/analytics/google-analytics');

    const result = await GA4.syncDailyData(3);

    expect(result).toEqual({
      synced: true,
      period: { start: '2026-06-10', end: '2026-06-12' },
      rows: 1,
      sourceRows: 1,
    });
    expect(dailyWrites[0].payload).toEqual(expect.objectContaining({ date: '2026-06-10', conversions: 2 }));
    expect(sourceWrites[0].payload).toEqual(expect.objectContaining({ date: '2026-06-10', conversions: 2 }));
    expect(runReport).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ metrics: [{ name: 'keyEvents' }] }),
    }));
    expect(runReport).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ metrics: [{ name: 'conversions' }] }),
    }));
  });
});
