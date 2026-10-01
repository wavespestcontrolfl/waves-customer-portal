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
jest.mock('../services/appointment-card-request', () => ({
  loadSecureCardPageData: jest.fn(),
  completeSecureCardCapture: (...a) => mockComplete(...a),
  replaceSecureCardIntent: jest.fn(),
}));

const router = require('../routes/secure-card-public');
const { CONSENT_VERSION } = require('../services/payment-method-consent-text');

const TOKEN = 'a'.repeat(64);

function handler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:token/complete' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function postComplete(body) {
  const res = { statusCode: 200, payload: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  await handler()({ params: { token: TOKEN }, body, headers: { 'user-agent': 'jest' }, ip: '203.0.113.5' }, res, jest.fn());
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockComplete.mockResolvedValue({ ok: true });
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
