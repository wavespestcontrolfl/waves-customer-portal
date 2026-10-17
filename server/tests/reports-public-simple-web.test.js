/**
 * GATE_REPORT_SIMPLE_WEB (owner 2026-10-17) on the report /data payload:
 * - gate off → the live payload is unchanged (built in mode 'live', glass on,
 *   no simpleWebReport key);
 * - gate on, live view → built in mode 'pdf' (the PDF's compliance strips
 *   apply), carries simpleWebReport: true and no glassDefault;
 * - gate on, pdf render → unchanged (no key).
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  // The /data loader selects db.raw(...) stamped-address expressions —
  // mirror knex's raw so building the select can't throw.
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
  // #2866 routed print modes through the shared schedule-field strip; keep
  // the REAL implementation (pdf-cache-config precedent) so this suite keeps
  // exercising the route's actual print path instead of stubbing it out.
  stripLiveOnlyScheduleFields: jest.requireActual('../services/service-report/report-data').stripLiveOnlyScheduleFields,
  // Same precedent for report_copy's own live-only strip (codex P1
  // 2026-09-28, GATE_REPORT_PRODUCT_COPY) — the route's mode !== 'live'
  // block calls this unconditionally too.
  stripLiveOnlyReportProductCopy: jest.requireActual('../services/service-report/report-data').stripLiveOnlyReportProductCopy,
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const { buildReportV1Data } = require('../services/service-report/report-data');
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

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

function mockDb() {
  const fullRecord = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
    structured_notes: null,
    first_name: 'Pat',
    last_name: 'Tester',
  };
  // The param gate's lookup fires first, the /data route's join query second.
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: null })
      .mockResolvedValueOnce(fullRecord),
  });
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_products') return chain({
      where: jest.fn().mockResolvedValue([]),
    });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { serviceRead };
}

const TIMED = 'Keep people and pets off treated areas for 30 minutes.';

function payload() {
  return {
    typedReport: { headline: 'Perimeter looked quiet today.' },
    pestPressure: null,
    pdfUrl: `/api/reports/${VALID_TOKEN}`,
    applications: [{ product: { name: 'Product A', precaution_summary: TIMED } }],
  };
}

async function getData(baseUrl, query = '') {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${query}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /reports/:token/data simple web report (GATE_REPORT_SIMPLE_WEB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockImplementation(async () => payload());
  });

  test('gate off: live payload is unchanged', async () => {
    gates.reportSimpleWebLive.mockReturnValue(false);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect('simpleWebReport' in body).toBe(false);
      expect(body.glassDefault).toBe(true);
      expect(body.applications[0].product.precaution_summary).toBe(TIMED);
      expect(buildReportV1Data.mock.calls[0][3].mode).toBe('live');
    });
  });

  test('gate on: live view is built like the PDF and flagged', async () => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect(body.simpleWebReport).toBe(true);
      expect('glassDefault' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].mode).toBe('pdf');
      // the PDF's compliance strip ran: no fixed re-entry figure survives
      expect(body.applications[0].product.precaution_summary).not.toMatch(/30 minutes/);
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])('gate on: mode=%s carries no simpleWebReport key', async (mode) => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl, `?mode=${mode}`);
      expect(status).toBe(200);
      expect('simpleWebReport' in body).toBe(false);
      expect(buildReportV1Data.mock.calls[0][3].mode).toBe(mode);
    });
  });
});
