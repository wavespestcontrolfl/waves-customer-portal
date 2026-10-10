/**
 * GET /reports/:token/map.svg and GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES
 * (codex #6089 r2): when the report builder hides a lawn visit's default-zone
 * coverage (lawnCoverageHidden), the standalone map endpoint 404s like the
 * callback / pest trace-or-nothing cases; otherwise it serves the SVG.
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

function mockDb() {
  const record = { id: 'service-1', customer_id: 'customer-1', report_template_version: 'service_report_v1', structured_notes: '{}' };
  const serviceRead = chain({ first: jest.fn().mockResolvedValue(record) });
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    return chain({ first: jest.fn().mockResolvedValue(null) });
  });
}

describe('GET /reports/:token/map.svg with hidden lawn coverage', () => {
  beforeEach(() => { jest.clearAllMocks(); mockDb(); });

  test('lawnCoverageHidden: 404, no map served', async () => {
    buildReportV1Data.mockResolvedValue({ lawnCoverageHidden: true, mapSvg: '<svg>A-D</svg>' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/map.svg`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<svg');
    });
  });

  test('coverage not hidden: the map is served as before', async () => {
    buildReportV1Data.mockResolvedValue({ mapSvg: '<svg>A-D</svg>' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/map.svg`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<svg>A-D</svg>');
    });
  });
});
