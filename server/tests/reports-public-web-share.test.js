/**
 * GATE_REPORT_WEB_SHARE (owner 2026-10-20, idea 8): the shareable lawn card.
 * - /data adds `webShare` only for a live simple-web view while the gate is on;
 * - GET /:token/share-photo is a generic 404 unless the gate (and the simple
 *   web gate) are on, and never serves a callback or suppressed report;
 * - the referral tap and its event work for the card without GATE_REPORT_CROSS_SELL.
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
  reportWebShareLive: jest.fn(() => false),
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
jest.mock('../services/service-report/web-share', () => ({
  ...jest.requireActual('../services/service-report/web-share'),
  attachWebShare: jest.fn(),
  findShareFrontPhoto: jest.fn(),
  readSharePhoto: jest.fn(),
}));
jest.mock('../services/referral-share', () => ({
  REFERRAL_CARD_COPY: { headline: 'h', cta: 'c' },
  buildReferralShareForCustomer: jest.fn(),
}));
jest.mock('../services/referral-engine', () => ({ getLiveSettings: jest.fn() }));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const { buildReportV1Data } = require('../services/service-report/report-data');
const webShare = require('../services/service-report/web-share');
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
    return chain();
  });
  return { serviceRead };
}



function paramGateRecord(overrides = {}) {
  return { id: 'service-1', structured_notes: null, ...overrides };
}

function mockDbFor(rows) {
  // Each service_records read gets the next row (param gate first, then the route).
  const reads = chain({ first: jest.fn() });
  rows.forEach((row) => reads.first.mockResolvedValueOnce(row));
  db.mockImplementation((table) => {
    if (table === 'service_records') return reads;
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
  return reads;
}

const fullRecord = (overrides = {}) => ({
  id: 'service-1',
  customer_id: 'customer-1',
  report_template_version: 'service_report_v1',
  structured_notes: null,
  first_name: 'Pat',
  last_name: 'Tester',
  ...overrides,
});

async function getData(baseUrl, query = '') {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${query}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /reports/:token/data web share (GATE_REPORT_WEB_SHARE)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(true);
    buildReportV1Data.mockImplementation(async () => ({ serviceLine: 'lawn', pdfUrl: `/api/reports/${VALID_TOKEN}`, applications: [] }));
    webShare.attachWebShare.mockImplementation(async (data) => { data.webShare = { score: 88 }; });
  });

  test('a live simple-web view asks for the offer and carries what comes back', async () => {
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.webShare).toEqual({ score: 88 });
    });
    expect(webShare.attachWebShare).toHaveBeenCalledTimes(1);
  });

  test('no offer attached (gate off, score under 85, no photo): no key', async () => {
    webShare.attachWebShare.mockImplementation(async () => {});
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webShare' in body).toBe(false);
    });
  });

  test('simple web off: the offer is never asked for', async () => {
    gates.reportSimpleWebLive.mockReturnValue(false);
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webShare' in body).toBe(false);
    });
    expect(webShare.attachWebShare).not.toHaveBeenCalled();
  });

  test.each(['pdf', 'static', 'sms_preview'])('mode=%s never asks for the offer', async (mode) => {
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl, `?mode=${mode}`);
      expect('webShare' in body).toBe(false);
    });
    expect(webShare.attachWebShare).not.toHaveBeenCalled();
  });

  test('a suppressed (internal-only) report never asks for the offer', async () => {
    mockDbFor([paramGateRecord(), fullRecord({ structured_notes: { typedReportDelivery: 'shadow' } })]);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webShare' in body).toBe(false);
    });
    expect(webShare.attachWebShare).not.toHaveBeenCalled();
  });
});

describe('GET /reports/:token/share-photo', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebShareLive.mockReturnValue(true);
    webShare.findShareFrontPhoto.mockResolvedValue({ s3_key: 'lawn/front.jpg', zone: 'front' });
    webShare.readSharePhoto.mockResolvedValue(JPEG);
  });
  const get = (baseUrl) => fetch(`${baseUrl}/reports/${VALID_TOKEN}/share-photo`);

  test('serves the photo as a private same-origin JPEG', async () => {
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(Buffer.from(await res.arrayBuffer()).equals(JPEG)).toBe(true);
    });
  });

  test.each([
    ['share gate off', () => gates.reportWebShareLive.mockReturnValue(false)],
    ['simple web off', () => gates.reportSimpleWebLive.mockReturnValue(false)],
  ])('%s: generic 404, no photo read', async (_name, setup) => {
    setup();
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl)).status).toBe(404);
    });
    expect(webShare.readSharePhoto).not.toHaveBeenCalled();
  });

  test('callback report: 404', async () => {
    mockDbFor([paramGateRecord(), fullRecord({ is_callback: true })]);
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl)).status).toBe(404);
    });
  });

  test('no front photo: 404', async () => {
    webShare.findShareFrontPhoto.mockResolvedValue(null);
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl)).status).toBe(404);
    });
  });

  test('suppressed report: 404 for a non-staff caller', async () => {
    mockDbFor([paramGateRecord({ structured_notes: { typedReportDelivery: 'shadow' } })]);
    await withServer(async (baseUrl) => {
      expect((await get(baseUrl)).status).toBe(404);
    });
    expect(webShare.readSharePhoto).not.toHaveBeenCalled();
  });

  test('a bad token is a 404', async () => {
    await withServer(async (baseUrl) => {
      expect((await fetch(`${baseUrl}/reports/not-a-token/share-photo`)).status).toBe(404);
    });
  });

  test('suppressed, callback, no photo, dark and malformed tokens all answer the same body', async () => {
    const bodies = [];
    const read = async (setup, path) => {
      jest.clearAllMocks();
      gates.reportWebShareLive.mockReturnValue(true);
      gates.reportSimpleWebLive.mockReturnValue(true);
      webShare.findShareFrontPhoto.mockResolvedValue({ key: 'k' });
      setup();
      await withServer(async (baseUrl) => {
        const res = path ? await fetch(`${baseUrl}${path}`) : await get(baseUrl);
        expect(res.status).toBe(404);
        bodies.push(await res.text());
      });
    };
    await read(() => mockDbFor([paramGateRecord({ structured_notes: { typedReportDelivery: 'shadow' } })]));
    await read(() => mockDbFor([paramGateRecord(), fullRecord({ is_callback: true })]));
    await read(() => { webShare.findShareFrontPhoto.mockResolvedValue(null); mockDbFor([paramGateRecord(), fullRecord()]); });
    await read(() => { gates.reportWebShareLive.mockReturnValue(false); mockDbFor([paramGateRecord(), fullRecord()]); });
    await read(() => {}, '/reports/not-a-token/share-photo');
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: 'Report not found' });
  });
});

describe('dark share-photo answers before every limiter (real limiters)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebShareLive.mockReturnValue(false);
    db.mockImplementation(() => { throw new Error('a dark probe must not read the database'); });
  });

  test('30 dark requests, with and without a trailing slash, are all 404 with privacy headers and no row read', async () => {
    await withServer(async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/share-photo${i % 2 ? '/' : ''}`);
        statuses.push(res.status);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
        await res.arrayBuffer();
      }
      expect(statuses.every((st) => st === 404)).toBe(true);
    });
    expect(db).not.toHaveBeenCalled();
    expect(webShare.readSharePhoto).not.toHaveBeenCalled();
  });

  test.each(['GET', 'HEAD'])('30 dark %s requests with a malformed token are all 404 with privacy headers and no row read', async (method) => {
    await withServer(async (baseUrl) => {
      const paths = ['not-a-token', 'short', `${VALID_TOKEN}zz`, '%00', 'A'.repeat(64)];
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${baseUrl}/reports/${paths[i % paths.length]}/share-photo${i % 2 ? '/' : ''}`, { method });
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
        await res.arrayBuffer();
      }
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('30 dark HEAD requests with a valid token are all 404 with privacy headers and no row read', async () => {
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/share-photo${i % 2 ? '/' : ''}`, { method: 'HEAD' });
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      }
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('live gate: 30 malformed-token GET and HEAD requests are 404 with headers, read no row and spend no limiter budget', async () => {
    gates.reportWebShareLive.mockReturnValue(true);
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 30; i += 1) {
        const res = await fetch(`${baseUrl}/reports/not-a-token${i}/share-photo`, { method: i % 2 ? 'HEAD' : 'GET' });
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
        await res.arrayBuffer();
      }
      expect(db).not.toHaveBeenCalled();
      // The same address still has its full budget: a valid-token read is served, not 429.
      db.mockReset();
      mockDbFor([paramGateRecord(), fullRecord()]);
      webShare.findShareFrontPhoto.mockResolvedValue({ s3_key: 'lawn/front.jpg', zone: 'front' });
      webShare.readSharePhoto.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const ok = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/share-photo`);
      expect(ok.status).toBe(200);
    });
  });

  test('dark probes do not spend the report limiter budget of the same address', async () => {
    mockDbFor([paramGateRecord(), fullRecord()]);
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 25; i += 1) await (await fetch(`${baseUrl}/reports/${VALID_TOKEN}/share-photo`)).arrayBuffer();
      db.mockReset();
      mockDbFor([paramGateRecord(), fullRecord()]);
      buildReportV1Data.mockImplementation(async () => ({ serviceLine: 'lawn', pdfUrl: `/api/reports/${VALID_TOKEN}`, applications: [] }));
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data`);
      expect(res.status).toBe(200);
    });
  });

  test('the app-level guard answers 404 ahead of a one-request limiter, and passes other paths and a live gate', async () => {
    const rateLimit = require('express-rate-limit');
    const app = express();
    app.use('/reports', reportsRouter.reportsAskPrivacyHeaders);
    app.use('/reports', reportsRouter.reportSharePhotoPreGuard);
    app.use(rateLimit({ windowMs: 60000, max: 1, standardHeaders: false, legacyHeaders: false }));
    app.use((req, res) => res.status(200).json({ reached: true }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/reports/${VALID_TOKEN}/share-photo${i % 2 ? '/' : ''}`);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      // Live gate: the guard steps aside and the next layer (here the limiter) answers.
      gates.reportWebShareLive.mockReturnValue(true);
      expect((await fetch(`${base}/reports/${VALID_TOKEN}/share-photo`)).status).toBe(200);
      // A different path is never touched by the guard, gate dark or not.
      gates.reportWebShareLive.mockReturnValue(false);
      expect((await fetch(`${base}/reports/${VALID_TOKEN}/data`)).status).toBe(429);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the lawn card tap without GATE_REPORT_CROSS_SELL', () => {
  const referralShare = require('../services/referral-share');
  const referralEngine = require('../services/referral-engine');
  beforeEach(() => {
    jest.clearAllMocks();
    gates.isEnabled.mockReturnValue(false);
    gates.reportSimpleWebLive.mockReturnValue(true);
    gates.reportWebShareLive.mockReturnValue(true);
    referralShare.buildReferralShareForCustomer.mockResolvedValue({ code: 'ABC123', link: 'https://example.test/r/ABC123' });
    referralEngine.getLiveSettings.mockResolvedValue({ program_active: true });
  });
  const post = (baseUrl, path, body) => fetch(`${baseUrl}/reports/${VALID_TOKEN}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });

  test('referral-link answers while the share gates are on', async () => {
    mockDbFor([fullRecord()]);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/referral-link');
      expect(res.status).toBe(200);
      expect((await res.json()).code).toBe('ABC123');
    });
  });

  test('referral-link stays a 404 with both the cross-sell and share gates off', async () => {
    gates.reportWebShareLive.mockReturnValue(false);
    mockDbFor([fullRecord()]);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, '/referral-link')).status).toBe(404);
    });
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });

  test('referral_cta_clicked is accepted from the lawn card', async () => {
    mockDbFor([fullRecord()]);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/events', { eventName: 'referral_cta_clicked', metadata: { source: 'lawn_card' } });
      expect(res.status).toBe(200);
    });
  });

  test('referral_cta_clicked is refused with the cross-sell and share gates off', async () => {
    gates.reportWebShareLive.mockReturnValue(false);
    mockDbFor([fullRecord()]);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/events', { eventName: 'referral_cta_clicked', metadata: { source: 'lawn_card' } });
      expect(res.status).toBe(400);
    });
  });
});
