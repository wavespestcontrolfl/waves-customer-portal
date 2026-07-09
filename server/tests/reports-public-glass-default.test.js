/**
 * Glass default flag on the report /data payload. Glass is the unconditional
 * report theme now (the GATE_REPORT_GLASS release gate was retired):
 * - live mode → glassDefault: true rides the payload, so the React viewer
 *   renders the liquid-glass experience;
 * - pdf / static / sms_preview modes NEVER carry it — the Playwright print
 *   pipeline and cached artifacts stay untouched.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  jwt: { secret: 'test-jwt-secret' },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
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
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const db = require('../models/db');
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

describe('GET /reports/:token/data glass default flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Perimeter looked quiet today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
    });
  });

  test('live mode → payload carries glassDefault: true', async () => {
    mockDb();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.glassDefault).toBe(true);
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])(
    'mode=%s → never carries glassDefault (print pipeline untouched)',
    async (mode) => {
      mockDb();
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data?mode=${mode}`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect('glassDefault' in body).toBe(false);
      });
    },
  );
});
