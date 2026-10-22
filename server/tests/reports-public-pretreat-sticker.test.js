process.env.GATE_PRETREAT_STICKER_REPORT = 'true';

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
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
jest.mock('../services/report-followup-appointment', () => ({
  findReportFollowupAppointment: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    orderBy: jest.fn().mockReturnThis(),
    ...overrides,
  };
}

function appServer() {
  const app = express();
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

// GATE_PRETREAT_STICKER_REPORT on: the certificate payload carries the
// notice flag, and a final-exterior value with a banned claim or an access
// code (a row saved before the write guard) is blanked at egress.
describe('pre-treat sticker report payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
  });

  function mockCertificate(findings) {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-cert',
        customer_id: 'customer-1',
        report_token: '0123456789abcdef0123456789abcdef',
        report_viewed_at: '2026-05-02T14:00:00.000Z',
        status: 'sent',
        project_type: 'pre_treatment_termite_certificate',
        first_name: 'Test',
        last_name: 'Customer',
        findings: JSON.stringify(findings),
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p') return projectRead;
      if (table === 'project_photos') return chain({ orderBy: jest.fn().mockResolvedValue([]) });
      if (table === 'service_records') return chain();
      if (table === 'scheduled_services') return chain();
      if (table === 'technicians') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });
    findReportFollowupAppointment.mockResolvedValue(null);
  }

  test('flags the certificate and keeps plain final exterior values', async () => {
    mockCertificate({
      treatment_date: '2026-06-10',
      final_exterior_product: 'Termidor SC',
      final_exterior_active_ingredient: 'Fipronil',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.pretreatStickerReport).toBe(true);
      expect(body.findings.final_exterior_product).toBe('Termidor SC');
      expect(body.findings.final_exterior_active_ingredient).toBe('Fipronil');
    });
  });

  test('blanks a final exterior value carrying a banned claim or an access code', async () => {
    mockCertificate({
      treatment_date: '2026-06-10',
      final_exterior_product: 'pet-safe Termidor',
      final_exterior_applicator_name: 'gate code 1234',
      final_exterior_active_ingredient: 'Fipronil',
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.findings.final_exterior_product).toBe('');
      expect(body.findings.final_exterior_applicator_name).toBe('');
      expect(body.findings.final_exterior_active_ingredient).toBe('Fipronil');
      expect(JSON.stringify(body)).not.toContain('pet-safe');
    });
  });
});
