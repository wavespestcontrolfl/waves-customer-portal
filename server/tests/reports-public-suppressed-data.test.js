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
  // The /data loader selects db.raw(...) stamped-address expressions —
  // mirror knex's raw so building the select can't throw.
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
  // The pdf / static modes strip live-only fields in place.
  stripLiveOnlyScheduleFields: jest.fn(),
  stripLiveOnlyReportProductCopy: jest.fn(),
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
const STAFF_JWT = jwt.sign({
  technicianId: 'tech-1',
  type: 'access',
  tokenVersion: 4,
}, 'test-jwt-secret');

function mockDb({ deliveryMode, notes = {} }) {
  const structuredNotes = JSON.stringify({ typedReportDelivery: deliveryMode, ...notes });
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
      first: jest.fn().mockResolvedValue({
        id: 'tech-1',
        active: true,
        role: 'technician',
        auth_token_version: 4,
      }),
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
    // stamp report_viewed_at or log a report_viewed activity. The payload
    // carries staffViewer: true so the client also suppresses its
    // unauthenticated /events posts (service_report_viewed and every
    // interaction event after it) — the events endpoint has no JWT to check.
    const { serviceRead, activityLog } = mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`, {
        headers: { Authorization: `Bearer ${STAFF_JWT}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.staffViewer).toBe(true);
      expect(serviceRead.update).not.toHaveBeenCalled();
      expect(activityLog.insert).not.toHaveBeenCalled();
    });
  });

  test('customer reads still stamp report_viewed_at and log the activity', async () => {
    const { serviceRead, activityLog } = mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // Customer payloads stay byte-identical — no staffViewer field at all.
      expect('staffViewer' in body).toBe(false);
      expect(serviceRead.update).toHaveBeenCalledWith(
        expect.objectContaining({ report_viewed_at: expect.anything() }),
      );
      expect(activityLog.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'report_viewed' }),
      );
    });
  });

  test('staff read of a suppressed report also carries the staffViewer flag', async () => {
    mockDb({ deliveryMode: 'internal_only' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`, {
        headers: { Authorization: `Bearer ${STAFF_JWT}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.internalOnly).toBe(true);
      expect(body.staffViewer).toBe(true);
    });
  });
});

// The PDF payload names the writer-rules state it was built in: the report
// page shows it on its root, and the PDF renderer prints only once it matches
// the state the PDF key was computed under (pdf.js reportPdfReadySelector).
describe('GET /reports/:token/data: the writer-rules state of a PDF payload', () => {
  const gate = process.env.GATE_REPORT_WRITER_RULES;
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({
      typedReport: { headline: 'Rodent activity was high today.' },
      pestPressure: null,
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
    });
  });
  afterAll(() => {
    if (gate === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
    else process.env.GATE_REPORT_WRITER_RULES = gate;
  });

  test('a PDF payload names the state it was built in; a live payload names none', async () => {
    for (const [value, state] of [['true', 'on'], ['false', 'off']]) {
      process.env.GATE_REPORT_WRITER_RULES = value;
      mockDb({ deliveryMode: 'auto_send' });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data?mode=pdf`);
        expect(res.status).toBe(200);
        expect((await res.json()).writerRules).toBe(state);
      });
    }
    mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      expect(res.status).toBe(200);
      expect((await res.json()).writerRules).toBeUndefined();
    });
  });

  // The note state, the same way (technician-report-copy reportNoteRenderState).
  test("a PDF payload of a record that carries the technician's own note names its note state; any other payload names none", async () => {
    const notes = { reportNote: { v: 1, text: 'I treated the perimeter.', source: 'cleaned' } };
    const payload = { typedReport: null, pestPressure: null, pdfUrl: `/api/reports/${VALID_TOKEN}` };
    const signed = 'I treated the perimeter. — Jordan';
    const digest = require('crypto').createHash('sha256').update(signed).digest('hex').slice(0, 8);
    for (const [built, state] of [[{ summaryIsOwnNote: true, summary: signed }, `shown:${digest}`], [{}, 'withheld']]) {
      buildReportV1Data.mockResolvedValue({ ...payload, ...built });
      mockDb({ deliveryMode: 'auto_send', notes });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data?mode=pdf`);
        expect(res.status).toBe(200);
        expect((await res.json()).reportNote).toBe(state);
      });
    }
    buildReportV1Data.mockResolvedValue({ ...payload, summaryIsOwnNote: true });
    mockDb({ deliveryMode: 'auto_send', notes });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      expect(res.status).toBe(200);
      expect((await res.json()).reportNote).toBeUndefined();
    });
    buildReportV1Data.mockResolvedValue(payload);
    mockDb({ deliveryMode: 'auto_send' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data?mode=pdf`);
      expect(res.status).toBe(200);
      expect((await res.json()).reportNote).toBeUndefined();
    });
  });
});
