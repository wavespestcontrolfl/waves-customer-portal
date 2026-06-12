/**
 * Suppressed-report /data payload (Codex P2 follow-up to #1631): staff
 * viewing an internal_only shadow report get pdfUrl:null + internalOnly:true
 * (the viewer swaps the download/share bar for an internal-review notice —
 * no PDF exists for these records and a plain <a> can't carry the staff JWT).
 * Non-staff still 404 at the param gate; auto_send reports keep their pdfUrl.
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
const jwt = require('jsonwebtoken');
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
const STAFF_JWT = jwt.sign({ technicianId: 'tech-1' }, 'test-jwt-secret');

function mockDb({ deliveryMode }) {
  const structuredNotes = JSON.stringify({ typedReportDelivery: deliveryMode });
  const fullRecord = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
    structured_notes: structuredNotes,
    first_name: 'Pat',
    last_name: 'Tester',
  };
  // The param gate's lookup fires first, the /data route's join query second.
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: structuredNotes })
      .mockResolvedValueOnce(fullRecord),
  });
  const activityLog = chain();
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'technicians') return chain({
      first: jest.fn().mockResolvedValue({ id: 'tech-1', active: true }),
    });
    if (table === 'service_products') return chain({
      where: jest.fn().mockResolvedValue([]),
    });
    if (table === 'activity_log') return activityLog;
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { serviceRead, activityLog };
}

describe('GET /reports/:token/data for suppressed typed reports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Rodent activity was high today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
    });
  });

  test('staff viewer gets internalOnly flag and no pdfUrl', async () => {
    mockDb({ deliveryMode: 'internal_only' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`, {
        headers: { Authorization: `Bearer ${STAFF_JWT}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.internalOnly).toBe(true);
      expect(body.pdfUrl).toBeNull();
    });
  });

  test('non-staff request still 404s at the param gate', async () => {
    mockDb({ deliveryMode: 'internal_only' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      expect(res.status).toBe(404);
    });
  });

  test('auto_send reports keep their pdfUrl and carry no flag', async () => {
    mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.pdfUrl).toBe(`/api/reports/${VALID_TOKEN}`);
      expect(body.internalOnly).toBeUndefined();
    });
  });
});

describe('GET /reports/:token/data view tracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Rodent activity was high today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
    });
  });

  test('staff reads of a customer-visible report never count as customer views (Codex P2)', async () => {
    // A staff JWT on an auto_send report (e.g. reviewing an internal_only
    // companion section on an otherwise customer-visible report) must not
    // stamp report_viewed_at or log a report_viewed activity.
    const { serviceRead, activityLog } = mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`, {
        headers: { Authorization: `Bearer ${STAFF_JWT}` },
      });
      expect(res.status).toBe(200);
      expect(serviceRead.update).not.toHaveBeenCalled();
      expect(activityLog.insert).not.toHaveBeenCalled();
    });
  });

  test('customer reads still stamp report_viewed_at and log the activity', async () => {
    const { serviceRead, activityLog } = mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      expect(res.status).toBe(200);
      expect(serviceRead.update).toHaveBeenCalledWith(
        expect.objectContaining({ report_viewed_at: expect.anything() }),
      );
      expect(activityLog.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'report_viewed' }),
      );
    });
  });
});
