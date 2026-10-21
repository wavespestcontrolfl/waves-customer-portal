/**
 * GATE_REPORT_WEB_PROGRAM (owner 2026-10-20) on the report /data payload: adds programPromise to a live simple-web lawn
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
const { historyForAssessment } = require('../services/lawn-assessment-history');
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

describe('GET /reports/:token/data program line (GATE_REPORT_WEB_PROGRAM)', () => {
  const planKey = { service_data: { completedServiceKey: 'lawn_care_recurring' } };
  beforeEach(() => {
    jest.clearAllMocks();
    photoRows = [{ quality_score: 90 }, { quality_score: 85 }];
    assessmentRow = { id: 'assess-1', customer_id: 'customer-1' };
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportGlassWebLive.mockReturnValue(false);
    gates.reportWebProgramLive.mockReturnValue(true);
    gates.reportWebLiveChipLive.mockReturnValue(false);
    buildReportV1Data.mockImplementation(async () => lawnPayload());
    // property-scoped history: first visit 2026-07-10, this visit 2026-10-20
    historyForAssessment.mockResolvedValue({
      scope: { propertyId: 'prop-1' },
      rows: [{ visit_date: '2026-07-10' }, { visit_date: '2026-10-20' }],
      current: { visit_date: '2026-10-20' },
    });
  });

  test('gate on, recurring lawn plan visit: programPromise carries the fixed sentences', async () => {
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.programPromise.monthLine).toBe('Month 4 of 12 in your lawn program.');
      expect(body.programPromise.items.map((i) => i.sentence)).toEqual([
        'Coverage is on track at this point in the program.',
        'Color is ahead of where the program aims to be at this point.',
        'Weeds are behind where the program aims to be at this point.',
      ]);
      expect('liveChip' in body).toBe(false);
    });
  });

  test('gate off: no key', async () => {
    gates.reportWebProgramLive.mockReturnValue(false);
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('programPromise' in body).toBe(false);
    });
  });

  test('a one-time lawn job, a callback and a legacy record with no frozen key get no line', async () => {
    for (const extra of [
      { service_data: { completedServiceKey: 'lawn_care_one_time' } },
      { service_data: { completedServiceKey: 'lawn_care_recurring' }, is_callback: true },
      { service_data: {} },
    ]) {
      mockDb(extra);
      await withServer(async (baseUrl) => {
        const { body } = await getData(baseUrl);
        expect('programPromise' in body).toBe(false);
      });
    }
  });

  test('a moved customer: the month counts from the new home\'s first visit, not the customer-wide trend', async () => {
    // the payload trend (customer-wide, GATE_LAWN_PROPERTY_HISTORY off) says July; the property history restarted at the move
    historyForAssessment.mockResolvedValue({
      scope: { propertyId: 'prop-2' },
      rows: [{ visit_date: '2026-10-05' }, { visit_date: '2026-10-20' }],
      current: { visit_date: '2026-10-20' },
    });
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.programPromise.monthLine).toBe('Month 1 of 12 in your lawn program.');
      expect(historyForAssessment.mock.calls[0][0]).toMatchObject({ id: 'assess-1' });
    });
  });

  test('low or insufficient photo confidence withholds the whole card (the progress engine\'s unclear rule)', async () => {
    for (const photos of [[{ quality_score: 90 }], [], [{ quality_score: 10 }, { quality_score: 5 }]]) {
      photoRows = photos;
      mockDb(planKey);
      await withServer(async (baseUrl) => {
        const { status, body } = await getData(baseUrl);
        expect(status).toBe(200);
        expect('programPromise' in body).toBe(false);
      });
    }
  });

  test('a category the two vision models disagreed on is left out; the others stay', async () => {
    assessmentRow = { id: 'assess-1', customer_id: 'customer-1', divergence_flags: JSON.stringify([{ metric: 'weed_suppression' }]) };
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.programPromise.items.map((i) => i.key)).toEqual(['coverage', 'color']);
    });
  });

  test('no verified property history (no property, no current row, empty rows, a failed read): no line', async () => {
    for (const bad of [
      { scope: { propertyId: null }, rows: [{ visit_date: '2026-07-10' }], current: { visit_date: '2026-10-20' } },
      { scope: { propertyId: 'prop-1' }, rows: [{ visit_date: '2026-07-10' }], current: null },
      { scope: { propertyId: 'prop-1' }, rows: [], current: { visit_date: '2026-10-20' } },
    ]) {
      historyForAssessment.mockResolvedValue(bad);
      mockDb(planKey);
      await withServer(async (baseUrl) => {
        const { status, body } = await getData(baseUrl);
        expect(status).toBe(200);
        expect('programPromise' in body).toBe(false);
      });
    }
    historyForAssessment.mockRejectedValue(new Error('boom'));
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect('programPromise' in body).toBe(false);
    });
  });

  test('gate on, simple web off or a print mode: no key', async () => {
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl, '?mode=pdf');
      expect('programPromise' in body).toBe(false);
    });
    gates.reportSimpleWebLive.mockReturnValue(false);
    mockDb(planKey);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('programPromise' in body).toBe(false);
    });
  });
});
