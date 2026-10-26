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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
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
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/pdf/legacy-service-report-pdf', () => ({
  renderLegacyServiceReportPdf: jest.fn((options, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.end(Buffer.from('%PDF-fresh-field-render'));
  }),
}));

const express = require('express');
const db = require('../models/db');
const { renderLegacyServiceReportPdf } = require('../services/pdf/legacy-service-report-pdf');
const reportsRouter = require('../routes/reports-public');

const TOKEN = '0123456789abcdef0123456789abcdef';

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

async function withServer(run) {
  const app = express();
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('legacy public report PDF regeneration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('ignores a legacy stored binary path and generates the current Field PDF from the record', async () => {
    const service = {
      id: 'service-legacy-1',
      customer_id: 'customer-synthetic-1',
      report_template_version: null,
      report_pdf_path: '/tmp/stale-pre-field-report.pdf',
      report_viewed_at: '2026-10-25T12:00:00Z',
      service_date: '2026-10-25',
      service_type: 'Residential Pest Control',
      first_name: 'Sample',
      last_name: 'Customer',
      address_line1: '123 Example Avenue',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
      weather_data: JSON.stringify({ temp: 82, humidity: 70 }),
      dry_time_data: JSON.stringify({ foundation: 'Until dry' }),
      irrigation_recommendation: JSON.stringify({ recommendation: 'Resume normal irrigation after drying.' }),
      structured_notes: { customerSummary: 'Reviewed customer-facing summary.' },
    };
    let serviceRead = 0;
    const products = [{ product_name: 'Example Product' }];
    db.mockImplementation((table) => {
      if (table === 'service_records') {
        serviceRead += 1;
        return chain({
          first: jest.fn().mockResolvedValue(serviceRead === 1
            ? { id: service.id, structured_notes: null }
            : service),
        });
      }
      if (table === 'service_products') {
        return chain({ where: jest.fn().mockResolvedValue(products) });
      }
      if (table === 'service_report_events') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${TOKEN}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/pdf');
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('%PDF-fresh-field-render');
    });

    expect(renderLegacyServiceReportPdf).toHaveBeenCalledTimes(1);
    expect(renderLegacyServiceReportPdf).toHaveBeenCalledWith(expect.objectContaining({
      service: expect.objectContaining({ report_pdf_path: '/tmp/stale-pre-field-report.pdf' }),
      products,
      weather: { temp: 82, humidity: 70 },
      dryTimes: { foundation: 'Until dry' },
      irrigation: { recommendation: 'Resume normal irrigation after drying.' },
    }), expect.anything());
  });
});
