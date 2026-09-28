/**
 * Service-report Ask Waves: a staff QA question is answered but never
 * recorded as customer engagement (codex P2 on #5167). The report page sends
 * the portal JWT on /ask, as it does on the /data read, and the server checks
 * it with the same staffCanViewSuppressed rule. A customer's question (no
 * bearer, or one that is not a live staff token) still records
 * report_question_asked with { question_length, topic }.
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

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
const STAFF_JWT = jwt.sign({ technicianId: 'tech-1', type: 'access', tokenVersion: 4 }, 'test-jwt-secret');
const FOREIGN_JWT = jwt.sign({ technicianId: 'tech-1', type: 'access', tokenVersion: 4 }, 'some-other-secret');

function mockDb() {
  const structuredNotes = JSON.stringify({});
  // The param gate's lookup fires first, the /ask route's join query second.
  const serviceRead = chain({
    first: jest.fn()
      .mockResolvedValueOnce({ id: 'service-1', structured_notes: structuredNotes })
      .mockResolvedValueOnce({
        id: 'service-1',
        customer_id: 'customer-1',
        report_template_version: 'service_report_v1',
        structured_notes: structuredNotes,
        first_name: 'Pat',
        last_name: 'Tester',
      }),
  });
  const eventInsert = chain();
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_report_events') return eventInsert;
    if (table === 'technicians') return chain({
      first: jest.fn().mockResolvedValue({ id: 'tech-1', active: true, role: 'technician', auth_token_version: 4 }),
    });
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { eventInsert };
}

async function ask(baseUrl, headers = {}) {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ question: 'What was applied today?' }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /reports/:token/ask — staff QA questions are not customer engagement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReportV1Data.mockResolvedValue({ serviceLine: 'pest', applications: [] });
  });

  test("a customer's question is answered and recorded with its length and topic", async () => {
    const { eventInsert } = mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl);
      expect(status).toBe(200);
      expect(typeof body.answer).toBe('string');
      expect(eventInsert.insert).toHaveBeenCalledTimes(1);
      const row = eventInsert.insert.mock.calls[0][0];
      expect(row.event_name).toBe('report_question_asked');
      expect(JSON.parse(row.metadata)).toEqual({ question_length: 'What was applied today?'.length, topic: 'applied' });
    });
  });

  test('a staff question gets the same answer but writes no event row', async () => {
    const customer = mockDb();
    const customerAnswer = await withServer((baseUrl) => ask(baseUrl));
    expect(customer.eventInsert.insert).toHaveBeenCalledTimes(1);

    const staff = mockDb();
    await withServer(async (baseUrl) => {
      const { status, body } = await ask(baseUrl, { Authorization: `Bearer ${STAFF_JWT}` });
      expect(status).toBe(200);
      expect(body.answer).toBe(customerAnswer.body.answer);
      expect(staff.eventInsert.insert).not.toHaveBeenCalled();
    });
  });

  test('a bearer that is not a live staff token still records — the header alone suppresses nothing', async () => {
    const { eventInsert } = mockDb();
    await withServer(async (baseUrl) => {
      const { status } = await ask(baseUrl, { Authorization: `Bearer ${FOREIGN_JWT}` });
      expect(status).toBe(200);
      expect(eventInsert.insert).toHaveBeenCalledTimes(1);
    });
  });
});
