/**
 * Glass release flag on the report /data payload (GATE_REPORT_GLASS —
 * mirrors the estimate GATE_ESTIMATE_GLASS pattern from PR #2372):
 * - gate ON + live mode → glassDefault: true rides the payload, so the React
 *   viewer renders the liquid-glass experience without ?glass=1;
 * - gate OFF → the field is ABSENT (not false) so pre-release responses stay
 *   byte-identical;
 * - pdf / static / sms_preview modes NEVER carry it even with the gate on —
 *   the Playwright print pipeline and cached artifacts stay untouched.
 * Kill switch: unset GATE_REPORT_GLASS.
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
const featureGates = require('../config/feature-gates');
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

function setGate(on) {
  featureGates.isEnabled.mockImplementation((gate) => gate === 'reportGlassTheme' && on);
}

describe('GET /reports/:token/data glass release flag (GATE_REPORT_GLASS)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Perimeter looked quiet today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
    });
  });

  test('gate ON + live mode → payload carries glassDefault: true', async () => {
    setGate(true);
    mockDb();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.glassDefault).toBe(true);
    });
  });

  test('gate OFF + live mode → field is absent (pre-release payloads stay byte-identical)', async () => {
    setGate(false);
    mockDb();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect('glassDefault' in body).toBe(false);
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])(
    'gate ON + mode=%s → never carries glassDefault (print pipeline untouched)',
    async (mode) => {
      setGate(true);
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
