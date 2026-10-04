// Route wiring for the unverified lead hold: with Turnstile enforcing, a form
// that posts NO token is held and answered 200; every other enforced failure,
// a hold that declines, and the kill switch all keep the 403.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGates = { leadTurnstile: true, leadUnverifiedHold: true };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: (name) => !!mockGates[name],
}));
const mockVerify = jest.fn();
jest.mock('../utils/turnstile', () => ({ verifyTurnstileToken: (...args) => mockVerify(...args) }));
const mockHold = jest.fn();
jest.mock('../services/lead-unverified-hold', () => ({ holdUnverifiedLead: (...args) => mockHold(...args) }));

const router = require('../routes/lead-webhook');

const postHandler = () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const post = async (body) => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  await postHandler()({ body, headers: {}, ip: '203.0.113.9' }, res);
  return res;
};
const BODY = { first_name: 'Dana', last_name: 'Sample', phone: '9415550142', source: 'astro-quote' };

beforeEach(() => {
  mockGates.leadTurnstile = true;
  mockGates.leadUnverifiedHold = true;
  mockVerify.mockReset();
  mockHold.mockReset();
});

describe('POST /api/leads — unverified hold', () => {
  test('missing token → held, 200, and the fan-out never starts', async () => {
    mockVerify.mockResolvedValue({ ok: false, enforced: true, reason: 'missing_token' });
    mockHold.mockResolvedValue({ held: true, leadId: 'lead-1', deduped: false });
    const res = await post(BODY);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockHold).toHaveBeenCalledTimes(1);
    expect(mockHold.mock.calls[0][0]).toMatchObject({ reason: 'missing_token', leadSourceId: null });
    expect(mockHold.mock.calls[0][0].intake.rawPhone).toBe('9415550142');
  });

  test.each(['rejected', 'malformed_token', 'no_widget_match'])('%s → 403, never held', async (reason) => {
    mockVerify.mockResolvedValue({ ok: false, enforced: true, reason });
    const res = await post(BODY);
    expect(res.statusCode).toBe(403);
    expect(mockHold).not.toHaveBeenCalled();
  });

  test('a hold that declines or throws keeps the 403', async () => {
    mockVerify.mockResolvedValue({ ok: false, enforced: true, reason: 'missing_token' });
    mockHold.mockResolvedValueOnce({ held: false, reason: 'not_reachable' });
    expect((await post(BODY)).statusCode).toBe(403);
    mockHold.mockRejectedValueOnce(new Error('db down'));
    expect((await post(BODY)).statusCode).toBe(403);
  });

  test('kill switch off → 403, never held', async () => {
    mockGates.leadUnverifiedHold = false;
    mockVerify.mockResolvedValue({ ok: false, enforced: true, reason: 'missing_token' });
    const res = await post(BODY);
    expect(res.statusCode).toBe(403);
    expect(mockHold).not.toHaveBeenCalled();
  });
});
