/**
 * GATE_REPORT_PHOTO_CONTENT readout on the report /data payload (owner spec
 * 2026-09-27). `reportPhotoContentEnabled` is a gate readout only — it must
 * never carry captions, URLs, or any photo content itself, and the existing
 * `photos` array (already public, already ungated) must be unaffected by
 * the gate either way. Mirrors reports-public-glass-default.test.js.
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
  reportPhotoContentLive: jest.fn(() => false),
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
  stripLiveOnlyScheduleFields: jest.requireActual('../services/service-report/report-data').stripLiveOnlyScheduleFields,
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const db = require('../models/db');
const { reportPhotoContentLive } = require('../config/feature-gates');
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
const PHOTOS = [{ id: 'photo-1', url: 'https://cdn.example/photo-1.jpg', caption: 'Ants at the baseboard.' }];

function mockDb() {
  const fullRecord = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
    structured_notes: null,
    first_name: 'Pat',
    last_name: 'Tester',
  };
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: null })
      .mockResolvedValueOnce(fullRecord),
  });
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { serviceRead };
}

describe('GET /reports/:token/data reportPhotoContentEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Perimeter looked quiet today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
      photos: PHOTOS,
    });
  });

  test.each(['live', 'pdf', 'static', 'sms_preview'])(
    'mode=%s → reflects the gate true',
    async (mode) => {
      reportPhotoContentLive.mockReturnValue(true);
      mockDb();
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${mode === 'live' ? '' : `?mode=${mode}`}`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.reportPhotoContentEnabled).toBe(true);
      });
    },
  );

  test.each(['live', 'pdf', 'static', 'sms_preview'])(
    'mode=%s → reflects the gate off',
    async (mode) => {
      reportPhotoContentLive.mockReturnValue(false);
      mockDb();
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${mode === 'live' ? '' : `?mode=${mode}`}`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.reportPhotoContentEnabled).toBe(false);
      });
    },
  );

  test('the flag never carries photo content itself, and the existing photos array is unaffected by the gate either way', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(typeof body.reportPhotoContentEnabled).toBe('boolean');
      // Pre-existing, ungated behavior: the gallery is served either way.
      expect(body.photos).toEqual(PHOTOS);
    });
  });
});
