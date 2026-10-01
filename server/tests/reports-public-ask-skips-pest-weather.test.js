/**
 * codex P2 #5137 deferred finding a: "Skip expectation weather for report
 * Q&A". POST /api/reports/:token/ask calls buildServiceReportV1ResponseData
 * purely for report CONTEXT — answerServiceReportQuestion never reads
 * data.pestReportV2.expectations — so it must never pay for either external
 * weather lookup the expectations block needs: the pest week-weather
 * resolution (report-data.js's opt-in `pestWeekWeather`) or the live
 * heavy-rain NWS forecast fetched directly in reports-public.js. Both are
 * now gated on the SAME opt-in, pestExpectationsWeather, which only the
 * /data live render and the direct PDF route set.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  jwt: { secret: 'test-jwt-secret' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: jest.fn(),
}));
// premiumExperience truthy so the pest V2 dashboard block (which reads
// expectationsGateOn / forecastHeavyRain) actually runs for this test —
// otherwise the whole block short-circuits before it ever gets a chance to
// (incorrectly) fetch the forecast, and the test would prove nothing.
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({ premiumExperience: true }),
}));
jest.mock('../services/service-report/pest-report-v2', () => ({
  buildPestReportV2: jest.fn(() => null),
  buildCustomerConcernCard: jest.fn(),
  isCockroachTypedReportType: jest.fn(() => false),
  pestReportExpectationsGateOn: jest.fn(() => true),
  pestReportV2PdfSignature: jest.fn(() => '-pex1'),
}));
jest.mock('../services/pest-forecast/forecast', () => ({
  getForecast: jest.fn().mockResolvedValue(null),
}));
const mockGetDailyRainOutlookBounded = jest.fn().mockResolvedValue({
  0: { shortForecast: 'Heavy Rain' },
});
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: mockGetDailyRainOutlookBounded,
}));

const express = require('express');
const db = require('../models/db');
const { buildReportV1Data } = require('../services/service-report/report-data');
const reportsRouter = require('../routes/reports-public');
const { etDateString } = require('../utils/datetime-et');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
// Today in the portal's Eastern calendar (codex r1 on #5265): a UTC-derived
// date is tomorrow in ET between UTC midnight and ET midnight, so the
// same-day branch must be built with the repo's ET date utility.
const SERVICE_DATE = etDateString();

function mockDb() {
  const structuredNotes = JSON.stringify({});
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: structuredNotes })
      .mockResolvedValueOnce({
        id: 'service-1',
        customer_id: 'customer-1',
        report_template_version: 'service_report_v1',
        structured_notes: structuredNotes,
        service_date: SERVICE_DATE,
        zip: '34205',
        first_name: 'Pat',
        last_name: 'Tester',
      }),
  });
  const eventInsert = chain();
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_report_events') return eventInsert;
    if (table === 'technicians') return chain({
      first: jest.fn().mockResolvedValue({ id: 'tech-1', active: true, role: 'technician', auth_token_version: 4 }),
    });
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
}

async function ask(baseUrl) {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What was applied today?' }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /reports/:token/ask never resolves pest expectations weather', () => {
  const ORIGINAL_PEST_V2 = process.env.PEST_REPORT_V2;
  const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PEST_REPORT_V2 = 'true';
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    buildReportV1Data.mockResolvedValue({
      serviceLine: 'pest',
      applications: [],
      report_template_version: 'service_report_v1',
    });
  });

  afterAll(() => {
    process.env.PEST_REPORT_V2 = ORIGINAL_PEST_V2;
    process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
  });

  test('buildReportV1Data is called with pestWeekWeather: false (never true) for /ask', async () => {
    mockDb();
    await withServer(async (baseUrl) => {
      const { status } = await ask(baseUrl);
      expect(status).toBe(200);
    });
    expect(buildReportV1Data).toHaveBeenCalledTimes(1);
    const opts = buildReportV1Data.mock.calls[0][3];
    expect(opts.pestWeekWeather).toBe(false);
  });

  test('the live heavy-rain NWS forecast is never fetched for /ask, even with the gate on, PEST_REPORT_V2 on, and a same-day service date', async () => {
    mockDb();
    await withServer(async (baseUrl) => {
      const { status } = await ask(baseUrl);
      expect(status).toBe(200);
    });
    expect(mockGetDailyRainOutlookBounded).not.toHaveBeenCalled();
  });

  // Positive control (codex r1 on #5265): with every other condition held
  // identical, the opt-in alone decides whether the forecast is fetched, so
  // the /ask assertion above cannot pass because some other guard (recency,
  // gate, premiumExperience) happened to short-circuit first.
  test('the opt-in alone decides the forecast fetch for the same same-day service', async () => {
    mockDb();
    const service = {
      id: 'service-1',
      customer_id: 'customer-1',
      report_template_version: 'service_report_v1',
      structured_notes: JSON.stringify({}),
      service_date: SERVICE_DATE,
      zip: '34205',
    };
    const { buildServiceReportV1ResponseData } = reportsRouter;

    await buildServiceReportV1ResponseData(service, VALID_TOKEN, { mode: 'live', pestExpectationsWeather: true });
    expect(mockGetDailyRainOutlookBounded).toHaveBeenCalledTimes(1);
    expect(buildReportV1Data.mock.calls[0][3].pestWeekWeather).toBe(true);

    mockGetDailyRainOutlookBounded.mockClear();
    buildReportV1Data.mockClear();
    await buildServiceReportV1ResponseData(service, VALID_TOKEN, { mode: 'live' });
    expect(mockGetDailyRainOutlookBounded).not.toHaveBeenCalled();
    expect(buildReportV1Data.mock.calls[0][3].pestWeekWeather).toBe(false);
  });
});
