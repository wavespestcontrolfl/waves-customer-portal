process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// darkEstimateRoutePreGuard (mounted in server/index.js before the global /api/ limiter): every estimate route whose gate
// used to be read in the handler answers its OWN dark 404 (body and headers) from the guard, case-insensitively, and the
// guard is a no-op once the gate is on. The probe (dark-route-limiter-probe.test.js) proves no limiter counts these.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
const mockOn = new Set();
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((name) => mockOn.has(name)),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

const express = require('express');
const estimatePublic = require('../routes/estimate-public');

const TOKEN = 'a1'.repeat(24);
const PDF_HEADERS = 'no-cache, no-store, must-revalidate';
const GATED = [
  ['POST', 'referral-link', 'estimateSuccessReferral', 'Estimate not found', null],
  ['POST', 'measurement-review', 'estimateMeasurementReview', 'Estimate not found', null],
  ['POST', 'extension-request', 'estimateExtensionRequest', 'Estimate not found', null],
  ['POST', 'change-request', 'estimateSoftExit', 'Estimate not found', null],
  ['POST', 'promo-code', 'estimatePromoCode', 'Estimate not found', 'no-store'],
  ['POST', 'service-details/send', null, 'Estimate not found', PDF_HEADERS],
  ['GET', 'service-details/lawn_care/pdf', null, 'Estimate not found', PDF_HEADERS],
];

async function call(method, path) {
  const app = express();
  app.use('/api/estimates', estimatePublic.darkEstimateRoutePreGuard);
  app.use((req, res) => res.status(200).json({ reached: true }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
  } finally { server.close(); }
}

describe('darkEstimateRoutePreGuard', () => {
  beforeEach(() => { mockOn.clear(); delete process.env.GATE_SERVICE_DETAILS_PDF; });

  test.each(GATED)('%s /%s: dark answers the route\'s own 404, in any case; live passes through', async (method, sub, gate, body, cache) => {
    if (sub.startsWith('service-details')) process.env.GATE_SERVICE_DETAILS_PDF = 'false';
    const dark = await call(method, `/api/estimates/${TOKEN}/${sub}`);
    expect(dark).toMatchObject({ status: 404, body: { error: body } });
    if (cache) expect(dark.cache).toBe(cache);
    const shouting = await call(method, `/api/estimates/${TOKEN}/${sub.toUpperCase()}/`);
    expect(shouting.status).toBe(404);
    // a malformed token (or one that does not decode) reads exactly as router.param answers it live: no route headers
    expect(await call(method, `/api/estimates/short/${sub}`)).toMatchObject({ status: 404, body: { error: 'Estimate not found' }, cache: null });
    // a path that does not decode carries the generic pair (what rejectUndecodablePath gives it live), never the route's headers
    expect(await call(method, `/api/estimates/%E0%A4%A/${sub}`)).toMatchObject({ status: 404, body: { error: 'Estimate not found' }, cache: 'no-store' });
    if (gate) mockOn.add(gate); else delete process.env.GATE_SERVICE_DETAILS_PDF;
    expect((await call(method, `/api/estimates/${TOKEN}/${sub}`)).body).toEqual({ reached: true });
  });

  test('service-opt-out (PUT) and the warranty PDF follow their gates', async () => {
    expect((await call('PUT', `/api/estimates/${TOKEN}/service-opt-out`)).status).toBe(404);
    expect((await call('GET', `/api/estimates/${TOKEN}/warranty-comparison/pdf`))).toMatchObject({ status: 404, body: { error: 'Estimate not found' }, cache: PDF_HEADERS });
    process.env.GATE_ESTIMATE_SERVICE_OPT_OUT = 'true';
    process.env.GATE_TERMITE_COMPARISON_SHEET = 'true';
    try {
      expect((await call('PUT', `/api/estimates/${TOKEN}/service-opt-out`)).body).toEqual({ reached: true });
      expect((await call('GET', `/api/estimates/${TOKEN}/warranty-comparison/pdf`)).body).toEqual({ reached: true });
    } finally { delete process.env.GATE_ESTIMATE_SERVICE_OPT_OUT; delete process.env.GATE_TERMITE_COMPARISON_SHEET; }
  });

  test('change-request stays open while either of its two gates is on (the body kind is unknown here)', async () => {
    mockOn.add('websiteQuoteBooking');
    expect((await call('POST', `/api/estimates/${TOKEN}/change-request`)).body).toEqual({ reached: true });
  });

  test('production order: an undecodable map or agreement token gets that guard\'s headers and the generic 404', async () => {
    const { rejectUndecodablePath } = require('../middleware/reject-undecodable-path');
    const app = express();
    app.use('/api/estimates', estimatePublic.mapImagePreGuard);
    app.use('/api/estimates', estimatePublic.commercialAgreementPreGuard);
    app.use('/api/estimates', estimatePublic.darkEstimateRoutePreGuard);
    app.use('/api/estimates', rejectUndecodablePath);
    app.use((req, res) => res.status(200).json({ reached: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const map = await fetch(`${base}/api/Estimates/%E0%A4%A/map/satellite`);
      expect(map.status).toBe(404);
      expect(await map.json()).toEqual({ error: 'Estimate not found' });
      expect(map.headers.get('cache-control')).toBe('no-store');
      expect(map.headers.get('referrer-policy')).toBe('no-referrer');
      const agreement = await fetch(`${base}/api/estimates/%E0%A4%A/commercial-agreement`, { method: 'POST' });
      expect(agreement.status).toBe(404);
      expect(agreement.headers.get('cache-control')).toBe('no-store');
    } finally { server.close(); }
  });

  test.each([
    ['GET', `${TOKEN}/service-details/%E0%A4%A/pdf`, () => { process.env.GATE_SERVICE_DETAILS_PDF = 'false'; }, () => { delete process.env.GATE_SERVICE_DETAILS_PDF; }],
    ['POST', '%E0%A4%A/promo-code', () => {}, () => { mockOn.add('estimatePromoCode'); }],
  ])('an undecodable path answers identically dark and live: %s %s', async (method, path, goDark, goLive) => {
    // production order: the route's dark guard, then rejectUndecodablePath (live), both ahead of any limiter
    const { rejectUndecodablePath } = require('../middleware/reject-undecodable-path');
    const app = express();
    app.use('/api/estimates', estimatePublic.darkEstimateRoutePreGuard);
    app.use('/api/estimates', rejectUndecodablePath);
    app.use((req, res) => res.status(200).json({ reached: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const answer = async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/estimates/${path}`, { method });
      return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control'), referrer: res.headers.get('referrer-policy'), robots: res.headers.get('x-robots-tag') };
    };
    try {
      goDark();
      const dark = await answer();
      mockOn.clear(); delete process.env.GATE_SERVICE_DETAILS_PDF;
      goLive();
      const live = await answer();
      expect(dark).toEqual(live);
      expect(dark).toMatchObject({ status: 404, body: { error: 'Estimate not found' }, cache: 'no-store', referrer: 'no-referrer', robots: null });
    } finally { server.close(); }
  });

  test('other methods and paths are untouched', async () => {
    expect((await call('GET', `/api/estimates/${TOKEN}/promo-code`)).body).toEqual({ reached: true });
    expect((await call('GET', `/api/estimates/${TOKEN}/data`)).body).toEqual({ reached: true });
  });
});
