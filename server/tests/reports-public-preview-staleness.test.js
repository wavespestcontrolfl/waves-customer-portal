/**
 * GET /api/reports/:token/preview.jpg — stored-identity staleness check
 * (owner pre-push P1, 2026-09-28). A cached SMS preview must never be
 * served once GATE_REPORT_PHOTO_CONTENT or the visit's photo set has moved
 * on from what it was built under — the route has no rebuild path of its
 * own, so a stale hit answers the SAME preview_not_found 404 a missing
 * asset already gets.
 */
const { PassThrough } = require('stream');

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
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn(mockS3Send) })),
  GetObjectCommand: jest.fn((input) => input),
}));
jest.mock('../services/service-report/preview-image', () => ({
  RENDER_VERSION: 'sms_preview_v2',
}));
jest.mock('../config/feature-gates', () => ({
  reportPhotoContentLive: jest.fn(),
}));
jest.mock('../services/service-report/photo-set-signature', () => ({
  reportPhotoSetPdfSignature: jest.fn(),
}));

// Referenced by the S3Client mock factory above — must be declared before
// jest hoists that jest.mock call, so it's a function declaration (hoisted)
// rather than a const.
function mockS3Send() {
  const body = new PassThrough();
  body.end('fake-jpeg-bytes');
  return Promise.resolve({ Body: body });
}

const express = require('express');
const db = require('../models/db');
const { reportPhotoContentLive } = require('../config/feature-gates');
const { reportPhotoSetPdfSignature } = require('../services/service-report/photo-set-signature');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
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
const SERVICE = { id: 'service-1', report_template_version: 'service_report_v1' };

function mockDb({ asset }) {
  db.mockImplementation((table) => {
    if (table === 'service_records') {
      return chain({ first: jest.fn().mockResolvedValue(SERVICE) });
    }
    if (table === 'service_report_notification_assets') {
      return chain({ first: jest.fn().mockResolvedValue(asset) });
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
}

describe('GET /reports/:token/preview.jpg staleness', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stored render_version + photo_content_signature match the current state → served', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: '',
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
    });
  });

  test('gate flipped since the stored preview was built → mismatch → 404 preview_not_found, not the stale image', async () => {
    // Stored under gate OFF; now the gate is ON.
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-aaaa1111');
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: '',
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'preview_not_found' });
    });
  });

  test('the eligible photo set changed since the stored preview was built (gate on both times) → mismatch → 404', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    // A photo was added/removed/reordered since the stored build.
    reportPhotoSetPdfSignature.mockResolvedValue('-ph2-newdigest0');
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: '-pgon-ph1-olddigest',
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'preview_not_found' });
    });
  });

  test('gate on both times, same photo set → identity matches → served', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-samedigest0');
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: '-pgon-ph1-samedigest0',
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
    });
  });

  test('a legacy row from before this column existed (photo_content_signature null) is treated as stale once the gate is on', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-aaaa1111');
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: null,
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
    });
  });

  test('a legacy row (null signature) still serves while the gate stays off — no unnecessary invalidation', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v2',
        photo_content_signature: null,
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
      expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
    });
  });

  test('an older render_version (pre-photo-content-feature row) is stale regardless of the gate', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb({
      asset: {
        storage_key: 'reports/service-1/sms-preview-abc.jpg',
        content_type: 'image/jpeg',
        byte_size: 15,
        render_version: 'sms_preview_v1',
        photo_content_signature: null,
      },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
    });
  });

  test('no stored asset at all → 404 preview_not_found without reading the photo-set signature (unchanged, cheap)', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    mockDb({ asset: null });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
      expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
    });
  });
});
