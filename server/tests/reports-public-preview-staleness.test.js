/**
 * GET /api/reports/:token/preview.jpg — stored-identity SELECT semantics
 * (owner pre-push P1s, 2026-09-28). Several preview rows can exist for one
 * record (rebuilds over time — a gate flip, a photo change, a render-version
 * bump). The route no longer takes the newest row and 404s it on any
 * mismatch; it builds the CURRENT identity (render version, plus the
 * `-pgon<signature>` photo-set signature only when GATE_REPORT_PHOTO_CONTENT
 * is on) and selects the NEWEST row whose identity matches it, in one query:
 * `.where({ ..., render_version })` + `.andWhere(db.raw('COALESCE(photo_
 * content_signature, ?) = ?', ['', signature]))` + `.orderBy('created_at',
 * 'desc')`. An older row built under the SAME current identity is a valid
 * image to serve even while a newer, now-irrelevant row sits on top of it.
 * No row matching the current identity falls through to the SAME
 * preview_not_found 404 a missing asset already gets — this route has no
 * rebuild path of its own.
 *
 * These tests assert the QUERY identity (the where/andWhere/orderBy calls
 * the route builds) rather than post-filtering a row the mock hands back,
 * since the filtering now happens inside the query itself.
 */
const { PassThrough } = require('stream');

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  // Real knex db.raw carries its bindings alongside the SQL string; the mock
  // must too, so tests can inspect exactly what the query binds.
  mock.raw = (sql, bindings) => ({ sql, bindings, toString: () => sql });
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
    andWhere: jest.fn().mockReturnThis(),
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

// Builds the db mock for one request and returns the
// service_report_notification_assets chain so tests can inspect exactly
// what where/andWhere/orderBy were called with.
function mockDb({ asset }) {
  const assetChain = chain({ first: jest.fn().mockResolvedValue(asset ?? null) });
  db.mockImplementation((table) => {
    if (table === 'service_records') {
      return chain({ first: jest.fn().mockResolvedValue(SERVICE) });
    }
    if (table === 'service_report_notification_assets') {
      return assetChain;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  return assetChain;
}

const MATCHING_ASSET = {
  storage_key: 'reports/service-1/sms-preview-abc.jpg',
  content_type: 'image/jpeg',
  byte_size: 15,
  render_version: 'sms_preview_v2',
  photo_content_signature: '',
};

describe('GET /reports/:token/preview.jpg staleness', () => {
  beforeEach(() => jest.clearAllMocks());

  test('gate off, query returns a matching row → served, identity bound to render_version + empty signature', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    const assetChain = mockDb({ asset: MATCHING_ASSET });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
    expect(assetChain.where).toHaveBeenCalledWith({
      service_record_id: 'service-1',
      asset_type: 'sms_preview_image',
      render_version: 'sms_preview_v2',
    });
    const rawArg = assetChain.andWhere.mock.calls[0][0];
    expect(rawArg.sql).toContain('COALESCE(photo_content_signature');
    expect(rawArg.bindings).toEqual(['', '']);
    expect(assetChain.orderBy).toHaveBeenCalledWith('created_at', 'desc');
  });

  test('gate on, query returns a matching row → served, identity bound to render_version + -pgon<signature>', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-aaaa1111');
    const assetChain = mockDb({
      asset: { ...MATCHING_ASSET, photo_content_signature: '-pgon-ph1-aaaa1111' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
    });

    expect(reportPhotoSetPdfSignature).toHaveBeenCalledTimes(1);
    const rawArg = assetChain.andWhere.mock.calls[0][0];
    expect(rawArg.bindings).toEqual(['', '-pgon-ph1-aaaa1111']);
  });

  test('query returns no matching row (gate off) → 404 preview_not_found', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'preview_not_found' });
    });
  });

  test('query returns no matching row (gate on) → 404 preview_not_found', async () => {
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-aaaa1111');
    mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'preview_not_found' });
    });
  });

  test('COALESCE bindings express legacy NULL-signature semantics: a NULL row can only match when the gate is off', async () => {
    // There's no post-filter left to unit-test directly — a legacy row
    // (photo_content_signature NULL) is coalesced to '' by the query itself,
    // and that only equals the current signature (the raw's second binding)
    // when the gate is off today, since gate-on always binds a non-empty
    // '-pgon...' string. So the correct assertion here is on the bindings
    // the route hands the query, not on a row the mock returns unfiltered.
    reportPhotoContentLive.mockReturnValue(false);
    const assetChain = mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
    });

    const rawArg = assetChain.andWhere.mock.calls[0][0];
    // '' COALESCE default, matched against '' (gate off) — the binding pair
    // a legacy NULL row needs to satisfy.
    expect(rawArg.bindings).toEqual(['', '']);
  });

  test('render_version is part of the where clause, alongside service_record_id and asset_type', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    const assetChain = mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
    });

    expect(assetChain.where.mock.calls[0][0]).toMatchObject({
      render_version: 'sms_preview_v2',
    });
  });

  test('gate off → the photo-set signature is never read', async () => {
    reportPhotoContentLive.mockReturnValue(false);
    mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
    });

    expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
  });

  test('gate on → the photo-set signature is read exactly once, even when no row matches the query', async () => {
    // Unlike the old logic (asset loaded first, signature only read to
    // compare against an already-fetched row), the signature must now be
    // read to build the query in the first place — it's needed whether or
    // not any row ends up matching.
    reportPhotoContentLive.mockReturnValue(true);
    reportPhotoSetPdfSignature.mockResolvedValue('-ph1-aaaa1111');
    mockDb({ asset: null });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(404);
    });

    expect(reportPhotoSetPdfSignature).toHaveBeenCalledTimes(1);
  });

  test('an older matching row is served: newest-first ordering + identity filter is what selects it, not always-newest-then-check', async () => {
    // Documents the fix itself: the query orders by created_at desc and
    // takes the first row that satisfies the identity filter. A newer,
    // non-matching row (e.g. built under a different gate state) is simply
    // excluded by the where/andWhere — it never reaches this row, and this
    // older-but-current-identity row is served rather than 404ing.
    reportPhotoContentLive.mockReturnValue(false);
    const assetChain = mockDb({
      asset: { ...MATCHING_ASSET, created_at: '2026-09-01T00:00:00Z' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/preview.jpg`);
      expect(res.status).toBe(200);
    });

    expect(assetChain.orderBy).toHaveBeenCalledWith('created_at', 'desc');
  });
});
