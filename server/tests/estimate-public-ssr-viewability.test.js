/**
 * SSR half of the centralized viewability gate (handleEstimateView).
 *
 * GET /:token/data owns the gate for the React path (isEstimateCustomerViewable
 * + the staff-JWT draft preview); the legacy server-HTML renderer prints
 * contact details and pricing with NO staff auth, so the same withheld classes
 * — draft/scheduled (unpublished), archived, send_failed — must never reach
 * it. On the /estimate/ mount they fall through to the React shell (next());
 * on the /api/estimates mount there is no SPA fallthrough, so they get the
 * generic not-found shell with no PII. Expired PUBLISHED rows deliberately
 * keep the personalized SSR expired page.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);

const { handleEstimateView } = require('../routes/estimate-public');

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

// PII planted on every fixture — asserted absent from any gated response.
const PII = {
  customer_name: 'Pat Gateleak',
  customer_email: 'pat.gateleak@example.com',
  customer_phone: '9415557777',
  address: '742 Leak Lane, Venice, FL 34285',
};

let currentRow;
mockDb.mockImplementation(() => ({
  where: () => ({ first: async () => currentRow }),
}));

function makeReq(path) {
  return {
    params: { token: 'tok-ssr-gate' },
    path,
    query: {},
    headers: {},
    get: () => '',
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    sent: false,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = body; this.sent = true; return this; },
  };
}

async function runView(row, path) {
  currentRow = { monthly_total: 384.62, ...PII, ...row };
  const req = makeReq(path);
  const res = makeRes();
  const next = jest.fn();
  const errNext = (err) => { if (err) throw err; return next(); };
  await handleEstimateView(req, res, errNext);
  return { res, next };
}

const ESTIMATE_MOUNT = '/estimate/tok-ssr-gate'; // app.get('/estimate/:token') — SPA fallthrough exists
const API_MOUNT = '/tok-ssr-gate'; // app.use('/api/estimates') — no SPA fallthrough

describe('handleEstimateView — SSR viewability gate', () => {
  test.each([
    ['draft', { status: 'draft', expires_at: null }],
    ['scheduled', { status: 'scheduled', expires_at: FUTURE }],
    ['archived', { status: 'sent', expires_at: FUTURE, archived_at: PAST }],
    ['send_failed', { status: 'send_failed', expires_at: FUTURE }],
  ])('%s row on the /estimate/ mount falls through to the React shell', async (_label, row) => {
    const { res, next } = await runView(row, ESTIMATE_MOUNT);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(false);
  });

  test.each([
    ['draft', { status: 'draft', expires_at: null }],
    ['scheduled', { status: 'scheduled', expires_at: FUTURE }],
    ['archived', { status: 'sent', expires_at: FUTURE, archived_at: PAST }],
    ['send_failed', { status: 'send_failed', expires_at: FUTURE }],
  ])('%s row on the /api/estimates mount gets the generic not-found shell — no PII', async (_label, row) => {
    const { res, next } = await runView(row, API_MOUNT);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Estimate not found');
    expect(res.body).not.toContain(PII.customer_name);
    expect(res.body).not.toContain(PII.customer_email);
    expect(res.body).not.toContain(PII.customer_phone);
    expect(res.body).not.toContain('742 Leak Lane');
    expect(res.body).not.toContain('384.62');
  });

  test('archived wins even for an accepted row — office-retired parity with /data', async () => {
    const { res, next } = await runView(
      { status: 'accepted', expires_at: PAST, archived_at: PAST },
      API_MOUNT,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(PII.customer_name);
  });

  test('expired PUBLISHED row keeps the personalized SSR expired page (deliberate carve-out)', async () => {
    const { res, next } = await runView(
      { status: 'sent', expires_at: PAST, use_v2_view: false, sent_at: PAST },
      ESTIMATE_MOUNT,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.sent).toBe(true);
    expect(res.body).toContain('This estimate has expired');
  });

  test('active published v2 row still falls through to the React view (unchanged)', async () => {
    const { res, next } = await runView(
      { status: 'sent', expires_at: FUTURE, use_v2_view: true, sent_at: PAST },
      ESTIMATE_MOUNT,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(false);
  });

  test('unknown token still gets the generic not-found shell', async () => {
    currentRow = undefined;
    const req = makeReq(API_MOUNT);
    const res = makeRes();
    const next = jest.fn();
    await handleEstimateView(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Estimate not found');
  });
});
