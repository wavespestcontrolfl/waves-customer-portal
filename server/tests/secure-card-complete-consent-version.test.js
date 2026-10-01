/**
 * /secure/:token (appointment card request + the standalone Auto Pay setup
 * link) — rendered consent-version attestation on POST /complete (codex
 * #5434 r1 P1). The page bundles its own copy of the saved-payment-method
 * consent text, so the completing tab attests the CONSENT_VERSION it
 * rendered beside the capture checkbox; a stale or absent attestation is
 * refused with 409 CONSENT_VERSION_STALE before the capture service runs
 * (no save, consent row or enrollment), and the page prompts a refresh.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn(), logViewFailure: jest.fn() }));
const mockComplete = jest.fn();
const mockLoad = jest.fn();
const mockReplace = jest.fn();
jest.mock('../services/appointment-card-request', () => ({
  loadSecureCardPageData: (...a) => mockLoad(...a),
  completeSecureCardCapture: (...a) => mockComplete(...a),
  replaceSecureCardIntent: (...a) => mockReplace(...a),
}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test' }));

const router = require('../routes/secure-card-public');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');

const TOKEN = 'a'.repeat(64);

function handler(method = 'post', path = '/:token/complete') {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function drive(method, path, { body = {}, query = {} } = {}) {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  await handler(method, path)({ params: { token: TOKEN }, body, query, headers: { 'user-agent': 'jest' }, ip: '203.0.113.5', get: () => 'jest' }, res, jest.fn());
  return res;
}
const postComplete = (body) => drive('post', '/:token/complete', { body });

beforeEach(() => {
  jest.clearAllMocks();
  mockComplete.mockResolvedValue({ ok: true });
  mockLoad.mockResolvedValue({ state: 'ready', clientSecret: 'cs_1', setupIntentId: 'seti_1' });
  mockReplace.mockResolvedValue({ ok: true, retired: true, intent: { clientSecret: 'cs_2', setupIntentId: 'seti_2', paymentMethodTypes: ['card'] } });
});

// The page GET and "use a different payment method" MINT the intent the page
// will confirm, so both carry the attestation and the attested value is what
// the mint stamps (codex #5434 r1 P1, pre-push hook r5): an old tab that
// refetches its payload or replaces its intent after a copy change is
// refused before any mint — no intent is ever stamped with a version the
// requesting tab did not render.
describe('GET /:token and POST /:token/replace-intent mint only under the attested version', () => {
  test('the GET passes the attested version down to the loader (the mint stamps it)', async () => {
    const res = await drive('get', '/:token', { query: { consentTextVersion: CONSENT_VERSION } });
    expect(res.statusCode).toBe(200);
    expect(mockLoad).toHaveBeenCalledWith(TOKEN, { consentTextVersion: CONSENT_VERSION });
    expect(res.payload).toEqual(expect.objectContaining({ state: 'ready', publishableKey: 'pk_test' }));
  });

  test.each([
    ['a stale version', { consentTextVersion: 'v11_2026-08-25' }],
    ['no version (an older bundle refetching after a copy change)', {}],
  ])('an old tab GET attesting %s → 409 CONSENT_VERSION_STALE and NO mint', async (_name, query) => {
    const res = await drive('get', '/:token', { query });
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('CONSENT_VERSION_STALE');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  test('replace-intent passes the attested version down (the replacement mint stamps it)', async () => {
    const res = await drive('post', '/:token/replace-intent', { body: { setupIntentId: 'seti_1', consentTextVersion: CONSENT_VERSION } });
    expect(res.statusCode).toBe(200);
    expect(mockReplace).toHaveBeenCalledWith({ token: TOKEN, setupIntentId: 'seti_1', consentTextVersion: CONSENT_VERSION });
  });

  test.each([
    ['a stale version', { setupIntentId: 'seti_1', consentTextVersion: 'v11_2026-08-25' }],
    ['no version', { setupIntentId: 'seti_1' }],
  ])('an old tab replace-intent attesting %s → 409 and NO replacement mint', async (_name, body) => {
    const res = await drive('post', '/:token/replace-intent', { body });
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('CONSENT_VERSION_STALE');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

test('the current version completes the capture (attestation passes, service runs)', async () => {
  const res = await postComplete({ setupIntentId: 'seti_1', stickyDisclosureVersion: 'sticky_v1', consentTextVersion: CONSENT_VERSION });
  expect(res.statusCode).toBe(200);
  expect(res.payload).toEqual({ success: true, alreadyCompleted: false });
  expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, setupIntentId: 'seti_1', disclosureVersion: 'sticky_v1' }));
});

test.each([
  ['a stale version', 'v11_2026-08-25'],
  ['no version (a bundle that predates the attestation)', undefined],
])('%s → 409 CONSENT_VERSION_STALE and the capture service never runs', async (_name, consentTextVersion) => {
  const res = await postComplete({ setupIntentId: 'seti_1', consentTextVersion });
  expect(res.statusCode).toBe(409);
  expect(res.payload.code).toBe('CONSENT_VERSION_STALE');
  expect(res.payload.error).toMatch(/refresh the page/i);
  expect(mockComplete).not.toHaveBeenCalled();
});
