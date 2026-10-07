/**
 * GATE_LAWN_VISIT_SUMMARY_V2 (Codex r8): the PDF renderer's URL carries the Visit Summary signature the cache
 * key names (`vs`), the page forwards it to GET /reports/:token/data, and the route answers a generic 409
 * (no data) when the payload it is about to return carries another summary. The renderer then fails and
 * nothing is cached. No `vs` or a non-pdf mode: the route is unchanged. An explicit `vs` is checked even on a
 * gate-off pod (mixed-gate rollout).
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
const mockGate = { live: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  lawnVisitSummaryV2Live: () => mockGate.live,
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
jest.mock('../services/service-report/report-data', () => {
  const actual = jest.requireActual('../services/service-report/report-data');
  return {
    buildReportV1Data: jest.fn(),
    stripLiveOnlyScheduleFields: actual.stripLiveOnlyScheduleFields,
    stripLiveOnlyReportProductCopy: actual.stripLiveOnlyReportProductCopy,
    lawnVisitSummaryRenderedSignature: actual.lawnVisitSummaryRenderedSignature,
  };
});
jest.mock('../services/service-report/dynamic-context', () => ({ buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}) }));

const express = require('express');
const db = require('../models/db');
const { buildReportV1Data, lawnVisitSummaryRenderedSignature } = require('../services/service-report/report-data');
const reportsRouter = require('../routes/reports-public');

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
const TEXT = 'Today we applied a feeding, which fits the fall season. Results from treatments like these build gradually, and each visit adds to the last one.';
const SUMMARY_PAYLOAD = { summary: TEXT, summarySource: 'lawn_visit_summary', pestPressure: null, pdfUrl: `/api/reports/${VALID_TOKEN}` };
const RECAP_PAYLOAD = { summary: 'Thanks for having us out today.', summarySource: 'recap', pestPressure: null, pdfUrl: `/api/reports/${VALID_TOKEN}` };
const KEY = lawnVisitSummaryRenderedSignature(SUMMARY_PAYLOAD);

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(), leftJoin: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(), first: jest.fn(), insert: jest.fn().mockResolvedValue(1), update: jest.fn().mockResolvedValue(1),
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

function mockDb() {
  const fullRecord = { id: 'service-1', customer_id: 'customer-1', report_template_version: 'service_report_v1', structured_notes: null, first_name: 'Pat', last_name: 'Tester' };
  const serviceRead = chain({ first: jest.fn().mockResolvedValueOnce({ id: 'service-1', structured_notes: null }).mockResolvedValueOnce(fullRecord) });
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
}

const get = async (query, payload) => {
  jest.clearAllMocks();
  buildReportV1Data.mockResolvedValue({ ...payload });
  mockDb();
  return withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${query}`);
    return { status: res.status, body: await res.json() };
  });
};

describe('GET /reports/:token/data with the renderer\'s vs', () => {
  beforeEach(() => { mockGate.live = true; });

  test('matching vs -> 200 with the data', async () => {
    const { status, body } = await get(`?mode=pdf&vs=${encodeURIComponent(KEY)}`, SUMMARY_PAYLOAD);
    expect(status).toBe(200);
    expect(body.summary).toBe(TEXT);
    const none = await get('?mode=pdf&vs=none', RECAP_PAYLOAD);
    expect(none.status).toBe(200);
  });

  test('a mismatched vs -> generic 409, no data (the key names the summary, the payload is the recap, and the reverse)', async () => {
    for (const [query, payload] of [[`?mode=pdf&vs=${encodeURIComponent(KEY)}`, RECAP_PAYLOAD], ['?mode=pdf&vs=none', SUMMARY_PAYLOAD], ['?mode=pdf&vs=%3Avs%3Dffffffff', SUMMARY_PAYLOAD]]) {
      const { status, body } = await get(query, payload);
      expect(status).toBe(409);
      expect(body).toEqual({ error: 'Report changed' });
    }
  });

  test('no vs: unchanged (200 either way)', async () => {
    expect((await get('?mode=pdf', RECAP_PAYLOAD)).status).toBe(200);
    expect((await get('', SUMMARY_PAYLOAD)).status).toBe(200);
  });

  test('vs on a live or static request is ignored', async () => {
    expect((await get('?vs=none', SUMMARY_PAYLOAD)).status).toBe(200);
    expect((await get('?mode=static&vs=none', SUMMARY_PAYLOAD)).status).toBe(200);
  });

  test('mixed-gate rollout: a gate-OFF pod still validates an explicit vs (pre-push P1)', async () => {
    mockGate.live = false;
    // The gate-on worker keyed a frozen summary; this gate-off pod built the recap: refuse.
    expect((await get(`?mode=pdf&vs=${encodeURIComponent(KEY)}`, RECAP_PAYLOAD)).status).toBe(409);
    // The key named no summary and this pod built the recap: matches.
    expect((await get('?mode=pdf&vs=none', RECAP_PAYLOAD)).status).toBe(200);
  });

  test('a higher-precedence summary source (technician report) is never fenced', async () => {
    const { status } = await get(`?mode=pdf&vs=${encodeURIComponent(KEY)}`, { ...RECAP_PAYLOAD, summarySource: 'technician_report' });
    expect(status).toBe(200);
  });
});
