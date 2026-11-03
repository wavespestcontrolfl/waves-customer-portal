/**
 * Book at the Table (GATE_IN_PERSON_CARD, owner 2026-11-02) — the public routes of the
 * estimate-terms step on /api/public/secure-card:
 *   - GET adds `terms` / `consumerNotice` only when the service returns them;
 *   - POST /:token/accept-terms hands the token's request row to the service and maps its
 *     answer (success, reloadable 409, the uniform 404);
 *   - /select-plan and /complete answer 409 terms_required while the terms are outstanding;
 *   - the dark gate is answered in server/index.js before the limiter and body parsers.
 */
const fs = require('fs');
const path = require('path');

const mockDb = jest.fn();
jest.mock('../models/db', () => (...a) => mockDb(...a));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn(), logViewFailure: jest.fn() }));
const mockLoad = jest.fn();
const mockComplete = jest.fn();
jest.mock('../services/appointment-card-request', () => ({
  loadSecureCardPageData: (...a) => mockLoad(...a),
  completeSecureCardCapture: (...a) => mockComplete(...a),
  replaceSecureCardIntent: jest.fn(),
}));
const mockSelect = jest.fn();
jest.mock('../services/secure-appointment-plans', () => ({ selectSecurePlan: (...a) => mockSelect(...a) }));
const mockBuild = jest.fn();
const mockRecord = jest.fn();
jest.mock('../services/in-person-handoff', () => ({
  TERMS_REQUIRED_MESSAGE: 'Please accept the estimate terms first.',
  buildTermsPayload: (...a) => mockBuild(...a),
  recordCardPageTerms: (...a) => mockRecord(...a),
}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test' }));

const router = require('../routes/secure-card-public');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');

const TOKEN = 'a'.repeat(22);
const REQUEST_ROW = { id: 'req-1', kind: 'visit', status: 'pending', in_person_terms_required: true };

function handler(method, route) {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function drive(method, route, { token = TOKEN, body = {}, query = {} } = {}) {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  await handler(method, route)({ params: { token }, body, query, headers: { 'user-agent': 'jest-agent' }, ip: '203.0.113.5' }, res, jest.fn());
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue({ state: 'ready', clientSecret: 'cs_1' });
  mockBuild.mockResolvedValue(null);
  mockDb.mockImplementation(() => ({ where: () => ({ first: async () => ({ ...REQUEST_ROW }) }) }));
});

describe('GET /:token', () => {
  const get = () => drive('get', '/:token', { query: { consentTextVersion: CONSENT_VERSION } });

  test('adds terms and consumerNotice from the service, on any device (no handoff param needed)', async () => {
    const terms = { estimateRef: 'EST-1', version: 'v2026-10', scope: 'plan', lines: ['a'] };
    mockBuild.mockResolvedValue({ terms, consumerNotice: { text: 'note' } });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ state: 'ready', terms, consumerNotice: { text: 'note' } });
    expect(mockBuild).toHaveBeenCalledWith({ token: TOKEN, data: expect.objectContaining({ state: 'ready' }) });
  });

  test('an unmarked request, a dark gate or nothing to show leaves the payload exactly as it was', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.payload).sort()).toEqual(['clientSecret', 'publishableKey', 'state']);
  });
});

describe('POST /:token/accept-terms', () => {
  const body = { terms_version: ' v2026-10 ', terms_scope: ' plan ', consumer_notice_shown: true };

  test('passes the token\'s request row, the attested version and scope, and the request ip and agent', async () => {
    mockRecord.mockResolvedValue({ ok: true, recorded: true });
    const res = await drive('post', '/:token/accept-terms', { body });
    expect(res).toMatchObject({ statusCode: 200, payload: { success: true, recorded: true } });
    expect(mockRecord).toHaveBeenCalledWith({
      request: REQUEST_ROW, termsVersion: 'v2026-10', termsScope: 'plan', consumerNoticeShown: true, ip: '203.0.113.5', userAgent: 'jest-agent',
    });
  });

  test('anything but true is "notice not shown"; non-strings are empty', async () => {
    mockRecord.mockResolvedValue({ ok: true, recorded: false });
    await drive('post', '/:token/accept-terms', { body: { terms_version: 5, terms_scope: null, consumer_notice_shown: 'yes' } });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ termsVersion: '', termsScope: '', consumerNoticeShown: false }));
  });

  test('a reloadable refusal keeps its status, text and code', async () => {
    mockRecord.mockResolvedValue({ ok: false, status: 409, code: 'terms_changed', error: 'The terms changed. Reload this page to see them.' });
    expect(await drive('post', '/:token/accept-terms', { body })).toMatchObject({
      statusCode: 409, payload: { error: 'The terms changed. Reload this page to see them.', code: 'terms_changed' },
    });
  });

  test('an unknown token is the uniform 404 and a malformed one never reaches the service', async () => {
    mockRecord.mockResolvedValue({ ok: false, status: 404, code: 'not_found', error: 'Not found' });
    mockDb.mockImplementation(() => ({ where: () => ({ first: async () => undefined }) }));
    expect((await drive('post', '/:token/accept-terms', { body })).statusCode).toBe(404);
    mockRecord.mockClear();
    expect((await drive('post', '/:token/accept-terms', { token: 'short', body })).statusCode).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a service error is a 500 without detail', async () => {
    mockRecord.mockRejectedValue(new Error('db down'));
    expect(await drive('post', '/:token/accept-terms', { body })).toMatchObject({ statusCode: 500, payload: { error: 'Something went wrong' } });
  });
});

describe('enforcement answers', () => {
  test('/select-plan terms_required is a 409 with the reload-free text', async () => {
    mockSelect.mockRejectedValue(Object.assign(new Error('terms'), { code: 'terms_required' }));
    expect(await drive('post', '/:token/select-plan', { body: { plan: 'prepay_annual' } })).toMatchObject({
      statusCode: 409, payload: { error: 'Please accept the estimate terms first.', code: 'terms_required' },
    });
  });

  test('/complete terms_required is a 409 and saves nothing', async () => {
    mockComplete.mockResolvedValue({ ok: false, code: 'terms_required' });
    expect(await drive('post', '/:token/complete', { body: { setupIntentId: 'seti_1', consentTextVersion: CONSENT_VERSION } })).toMatchObject({
      statusCode: 409, payload: { error: 'Please accept the estimate terms first.', code: 'terms_required' },
    });
  });
});

describe('dark gate (server/index.js)', () => {
  test('accept-terms is answered 404 while the gate is dark, ahead of the global limiter and the body parsers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const guard = source.indexOf("/accept-terms\\/?$/.test(req.path)");
    expect(guard).toBeGreaterThan(-1);
    expect(source.slice(guard, guard + 200)).toContain("inPersonCardLive()");
    expect(guard).toBeLessThan(source.indexOf("app.use('/api/', limiter);"));
    expect(guard).toBeLessThan(source.indexOf("app.use(express.json({ limit: '1mb'"));
    // The privacy headers are set by the mount just above it.
    expect(source.lastIndexOf("res.set('Cache-Control', 'private, no-store');", guard)).toBeGreaterThan(-1);
  });
});
