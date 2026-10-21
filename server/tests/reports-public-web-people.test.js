/**
 * GATE_REPORT_WEB_PEOPLE (owner 2026-10-20) on the report /data payload: the webPeople key rides only the live simple web
 * view, the build is asked for the next visit only then, and the helper key never reaches the customer.
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
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  reportSimpleWebLive: jest.fn(() => false),
  reportGlassWebLive: jest.fn(() => false),
  reportWebPeopleLive: jest.fn(() => false),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn().mockImplementation(() => ({})), GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
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
  stripLiveOnlyScheduleFields: jest.requireActual('../services/service-report/report-data').stripLiveOnlyScheduleFields,
  stripLiveOnlyReportProductCopy: jest.requireActual('../services/service-report/report-data').stripLiveOnlyReportProductCopy,
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/service-report/report-web-people', () => ({ buildWebPeople: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { buildWebPeople } = require('../services/service-report/report-web-people');
const reportsRouter = require('../routes/reports-public');

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
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

function mockDb(overrides = {}) {
  const fullRecord = {
    id: 'service-1', customer_id: 'customer-1', report_template_version: 'service_report_v1', structured_notes: null,
    first_name: 'Pat', last_name: 'Tester', ...overrides,
  };
  const serviceRead = chain({
    first: jest.fn().mockResolvedValueOnce({ id: 'service-1', structured_notes: null }).mockResolvedValueOnce(fullRecord),
  });
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
}

const PEOPLE = { tech: { firstName: 'Alex', photoUrl: null, fdacsId: null, visitsAtHome: null } };
const VISITS = [{ serviceType: 'Lawn Care', scheduledDate: '2026-11-18', windowStart: null, rescheduleUrl: 'https://portal.example/r/abc' }];

async function getData(baseUrl, query = '') {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${query}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /reports/:token/data people cards (GATE_REPORT_WEB_PEOPLE)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebPeopleLive.mockReturnValue(false);
    buildReportV1Data.mockImplementation(async (_s, _t, _db, opts) => ({
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
      ...(opts.webPeopleNext ? { webPeopleNext: VISITS } : {}),
    }));
    buildWebPeople.mockResolvedValue(PEOPLE);
  });

  test('gate off: no webPeople key, no helper key, the build is not asked for visits', async () => {
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.simpleWebReport).toBe(true);
      expect('webPeople' in body).toBe(false);
      expect('webPeopleNext' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].webPeopleNext).toBe(false);
      expect(buildWebPeople).not.toHaveBeenCalled();
    });
  });

  test('gate on: webPeople is built from the build\'s next visits and the helper key is removed', async () => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.webPeople).toEqual(PEOPLE);
      expect('webPeopleNext' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].webPeopleNext).toBe(true);
      expect(buildWebPeople.mock.calls[0][0].nextVisits).toEqual(VISITS);
    });
  });

  test('gate on, nothing to show: no key', async () => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    buildWebPeople.mockResolvedValue(null);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webPeople' in body).toBe(false);
    });
  });

  test('gate on, builder throws: the report still loads without the key', async () => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    buildWebPeople.mockRejectedValue(new Error('boom'));
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect('webPeople' in body).toBe(false);
    });
  });

  test('gate on, simple web off: no key and no visit request', async () => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    gates.reportSimpleWebLive.mockReturnValue(false);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webPeople' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].webPeopleNext).toBe(false);
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])('gate on: mode=%s carries no webPeople key', async (mode) => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl, `?mode=${mode}`);
      expect('webPeople' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].webPeopleNext).toBe(false);
    });
  });

  test('gate on: a suppressed (internal-only) report carries no webPeople key', async () => {
    gates.reportWebPeopleLive.mockReturnValue(true);
    mockDb({ structured_notes: { typedReportDelivery: 'shadow' } });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webPeople' in body).toBe(false);
    });
  });
});
