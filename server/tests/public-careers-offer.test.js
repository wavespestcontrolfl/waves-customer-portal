/**
 * Public job-offer routes (routes/public-careers-offer.js, /api/public/careers/offer/:token, GATE_JOB_OFFERS):
 * the dark 404 before the limiter, no-store headers on every answer (the dark 404 included), the token format gate
 * before any service call, the answer mapping (unknown = generic 404, bad input = 400, a closed state = 409 with the
 * state, else the body) and the request details the service needs (IP, user agent, body fields). The service is mocked.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockService = {
  publicView: jest.fn(async () => ({ state: 'open', firstName: 'Jordan' })),
  setTextConsent: jest.fn(async () => ({ body: { textConsent: true } })),
  acceptOffer: jest.fn(async () => ({ body: { state: 'signed', signedAt: '2026-11-20T15:00:00.000Z' } })),
  requestDate: jest.fn(async () => ({ body: { state: 'date_requested' } })),
  declineOffer: jest.fn(async () => ({ body: { state: 'declined' } })),
};
jest.mock('../services/job-offers', () => ({
  TOKEN_RE: /^[0-9a-f]{64}$/,
  publicView: (...a) => mockService.publicView(...a),
  setTextConsent: (...a) => mockService.setTextConsent(...a),
  acceptOffer: (...a) => mockService.acceptOffer(...a),
  requestDate: (...a) => mockService.requestDate(...a),
  declineOffer: (...a) => mockService.declineOffer(...a),
}));

const express = require('express');
const router = require('../routes/public-careers-offer');
const { notFound } = require('../middleware/errors');

const TOKEN = 'ab'.repeat(32);
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/public/careers/offer', router);
  app.use(notFound); // as server/index.js ends: a path no router takes is the app's JSON 404
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); mockIsEnabled.mockReturnValue(true); });

async function call(path, method = 'GET', body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/public/careers/offer${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe('dark gate and headers', () => {
  test('gate off: every route is the generic 404, with no-store, and the service is never reached', async () => {
    mockIsEnabled.mockImplementation((gate) => gate !== 'jobOffers');
    for (const [method, path] of [['GET', `/${TOKEN}`], ['POST', `/${TOKEN}/v2/accept`], ['POST', `/${TOKEN}/v2/decline`], ['POST', `/${TOKEN}/v2/date-request`], ['POST', `/${TOKEN}/v2/text-consent`]]) {
      const res = await call(path, method, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  test('gate on: privacy headers ride on every answer', async () => {
    const res = await call(`/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('the token format gate', () => {
  test.each(['short', 'AB'.repeat(32), 'zz'.repeat(32), `${'ab'.repeat(31)}a`])('%s is a generic 404 before any service call', async (token) => {
    expect(await call(`/${token}`)).toMatchObject({ status: 404, body: { error: 'Not found' } });
    expect(await call(`/${token}/v2/accept`, 'POST', { signedName: 'Jordan Rivera' })).toMatchObject({ status: 404 });
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /:token', () => {
  test('serves the service payload; an unknown token is the generic 404', async () => {
    expect(await call(`/${TOKEN}`)).toMatchObject({ status: 200, body: { state: 'open', firstName: 'Jordan' } });
    expect(mockService.publicView).toHaveBeenCalledWith(TOKEN);
    mockService.publicView.mockResolvedValueOnce(null);
    expect(await call(`/${TOKEN}`)).toMatchObject({ status: 404, body: { error: 'Not found' } });
  });

  test('a failure is a 500 that says nothing about the offer', async () => {
    mockService.publicView.mockRejectedValueOnce(new Error('select token from job_offers'));
    expect(await call(`/${TOKEN}`)).toMatchObject({ status: 500, body: { error: 'Something went wrong.' } });
  });
});

describe('the actions', () => {
  test('accept passes the typed name, the version on screen, the IP and the user agent', async () => {
    const res = await call(`/${TOKEN}/v2/accept`, 'POST', { signedName: 'Jordan Rivera', version: '2026-12-01T14:00:00.000Z' }, { 'user-agent': 'TestAgent/1.0' });
    expect(res).toMatchObject({ status: 200, body: { state: 'signed' } });
    expect(mockService.acceptOffer).toHaveBeenCalledWith(TOKEN, {
      signedName: 'Jordan Rivera', version: '2026-12-01T14:00:00.000Z', userAgent: 'TestAgent/1.0', ip: expect.any(String),
    });
  });

  test('date-request, decline and text-consent pass their body fields', async () => {
    const version = '2026-12-01T14:00:00.000Z';
    await call(`/${TOKEN}/v2/date-request`, 'POST', { requestedStartDate: '2027-01-11', note: 'Notice runs out', version });
    expect(mockService.requestDate).toHaveBeenCalledWith(TOKEN, { requestedStartDate: '2027-01-11', note: 'Notice runs out', version });
    await call(`/${TOKEN}/v2/decline`, 'POST', { reason: 'Took another job', version });
    expect(mockService.declineOffer).toHaveBeenCalledWith(TOKEN, { reason: 'Took another job', version });
    await call(`/${TOKEN}/v2/text-consent`, 'POST', { consent: true, version: '2026-12-01T14:00:00.000Z' });
    expect(mockService.setTextConsent).toHaveBeenCalledWith(TOKEN, true, '2026-12-01T14:00:00.000Z');
  });

  // A page that read a version posts only to /v2. The paths from before the version (#8012) have no handler here, so a
  // body sent there is never answered by a handler that ignores its version; on a server from before the version, the
  // /v2 paths are the ones with no handler. Either way the post answers 404 and nothing is written.
  test.each(['accept', 'decline', 'date-request', 'text-consent'])('POST /:token/%s from before the version is a 404 that reaches no service', async (name) => {
    const res = await call(`/${TOKEN}/${name}`, 'POST', { signedName: 'Jordan Rivera', consent: true, reason: 'x', version: '2026-12-01T14:00:00.000Z' });
    expect(res.status).toBe(404);
    for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
  });

  test('a missing body reaches the service as nothing, never a crash', async () => {
    await call(`/${TOKEN}/v2/accept`, 'POST');
    expect(mockService.acceptOffer).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ signedName: undefined }));
  });
});

describe('answer mapping', () => {
  test('unknown = 404, invalid input = 400, a closed state = 409 carrying the state, an error = 500', async () => {
    mockService.acceptOffer.mockResolvedValueOnce({ notFound: true });
    expect(await call(`/${TOKEN}/v2/accept`, 'POST', {})).toMatchObject({ status: 404, body: { error: 'Not found' } });
    mockService.acceptOffer.mockResolvedValueOnce({ invalid: 'Type your full name to sign.' });
    expect(await call(`/${TOKEN}/v2/accept`, 'POST', {})).toMatchObject({ status: 400, body: { error: 'Type your full name to sign.' } });
    mockService.acceptOffer.mockResolvedValueOnce({ refused: true, body: { state: 'signed' } });
    expect(await call(`/${TOKEN}/v2/accept`, 'POST', {})).toMatchObject({ status: 409, body: { state: 'signed' } });
    mockService.acceptOffer.mockResolvedValueOnce({ refused: true, body: { state: 'expired', message: 'm', contactPhone: '(941) 297-5749' } });
    expect(await call(`/${TOKEN}/v2/accept`, 'POST', {})).toMatchObject({ status: 409, body: { state: 'expired', contactPhone: '(941) 297-5749' } });
    mockService.declineOffer.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40001' }));
    expect(await call(`/${TOKEN}/v2/decline`, 'POST', {})).toMatchObject({ status: 500 });
  });
});

describe('the production middleware order (server/index.js)', () => {
  // The gate and the privacy headers must sit ABOVE the global cors() and the global /api limiter, or a dark OPTIONS
  // preflight answers 204 without no-store and a limited IP could see a 429. Read from the source, in order.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => {
    const i = source.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test('noStore and the jobOffers dark gate are mounted above cors() and the global limiter, and the router after them', () => {
    const noStore = at("app.use('/api/public/careers/offer', require('./middleware/no-store').noStore);");
    const gate = at("isEnabled('jobOffers')");
    const cors = at('app.use(cors({');
    const limiter = at("app.use('/api/', limiter)");
    const router = at("app.use('/api/public/careers/offer', require('./routes/public-careers-offer'));");
    expect(noStore).toBeLessThan(gate);
    expect(gate).toBeLessThan(cors);
    expect(cors).toBeLessThan(limiter);
    expect(limiter).toBeLessThan(router);
  });

  test('the outer careers gate lets only /offer and /offer/* through, so a sent offer survives closed intake', () => {
    expect(source).toContain("if (/^\\/offer(\\/|$)/.test(req.path)) return next();");
  });
});
