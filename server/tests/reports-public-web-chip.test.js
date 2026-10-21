/**
 * GATE_REPORT_WEB_LIVE_CHIP (owner 2026-10-20) on the report /data payload: adds liveChip to a live simple-web lawn
 * payload only (own file: the report limiter allows 20 requests a minute per client).
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
  reportGlassWebLive: jest.fn(() => false),
  reportWebProgramLive: jest.fn(() => false),
  reportWebLiveChipLive: jest.fn(() => false),
}));
jest.mock('../services/service-report/lawn-live-chip', () => ({
  resolveLiveChip: jest.fn(),
}));
jest.mock('../services/lawn-assessment-history', () => ({
  historyForAssessment: jest.fn(),
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
const { resolveLiveChip } = require('../services/service-report/lawn-live-chip');
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

let photoRows = [{ quality_score: 90 }, { quality_score: 85 }];
let assessmentRow = { id: 'assess-1', customer_id: 'customer-1' };

function mockDb(overrides = {}) {
  const fullRecord = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
    structured_notes: null,
    first_name: 'Pat',
    last_name: 'Tester',
    ...overrides,
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
    if (table === 'lawn_assessment_photos') return chain({ where: jest.fn().mockResolvedValue(photoRows) });
    if (table === 'lawn_assessments') return chain({ first: jest.fn().mockResolvedValue(assessmentRow) });
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

// GATE_REPORT_WEB_PROGRAM and GATE_REPORT_WEB_LIVE_CHIP (owner 2026-10-20): each adds its own key to a live simple-web
// lawn payload only. Synthetic data throughout.
function lawnPayload() {
  return {
    ...payload(),
    serviceLine: 'lawn',
    lawnAssessment: {
      assessmentId: 'assess-1',
      assessmentDate: '2026-10-20',
      scores: { turfDensity: 60, colorHealth: 80, weedSuppression: 40 },
      trend: [{ date: '2026-07-10' }, { date: '2026-10-20' }],
    },
  };
}

describe('GET /reports/:token/data live chip (GATE_REPORT_WEB_LIVE_CHIP)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportGlassWebLive.mockReturnValue(false);
    gates.reportWebProgramLive.mockReturnValue(false);
    gates.reportWebLiveChipLive.mockReturnValue(true);
    buildReportV1Data.mockImplementation(async (_s, _t, _k, opts) => {
      if (opts.liveChipOut) Object.assign(opts.liveChipOut, { completedAt: '2026-10-20T14:00:00Z', latitude: 27.1, longitude: -82.4, products: [], instruction: null });
      return lawnPayload();
    });
    resolveLiveChip.mockResolvedValue({ state: 'no_rain', text: 'No rain since your treatment.' });
  });

  test('gate on: the payload carries the sentence and a state, never coordinates', async () => {
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.liveChip).toEqual({ state: 'no_rain', text: 'No rain since your treatment.' });
      expect(JSON.stringify(body)).not.toMatch(/27\.1|-82\.4|latitude|longitude/);
      expect(resolveLiveChip.mock.calls[0][0]).toMatchObject({ completedAt: '2026-10-20T14:00:00Z' });
      expect('programPromise' in body).toBe(false);
    });
  });

  test('gate off: no chip read at all', async () => {
    gates.reportWebLiveChipLive.mockReturnValue(false);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('liveChip' in body).toBe(false);
      expect(resolveLiveChip).not.toHaveBeenCalled();
      expect(buildReportV1Data.mock.calls[0][3].liveChipOut).toBeUndefined();
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])('mode=%s: no chip read', async (mode) => {
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl, `?mode=${mode}`);
      expect('liveChip' in body).toBe(false);
      expect(resolveLiveChip).not.toHaveBeenCalled();
    });
  });

  test('an unknown read hides the chip (no key) and a failed read never breaks the report', async () => {
    resolveLiveChip.mockResolvedValue(null);
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect('liveChip' in body).toBe(false);
    });
    resolveLiveChip.mockRejectedValue(new Error('boom'));
    mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect('liveChip' in body).toBe(false);
    });
  });
});
