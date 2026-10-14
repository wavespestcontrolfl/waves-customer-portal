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
jest.mock('../services/estimate-group-navigation', () => ({
  refreshExpiredGroupNavigation: jest.fn().mockResolvedValue(null),
}));

const { handleEstimateView } = require('../routes/estimate-public');
const { refreshExpiredGroupNavigation } = require('../services/estimate-group-navigation');

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
// Phone candidates the accept's phone match (matchAcceptCustomerByPhone) sweeps; none by default.
let phoneCandidates = [];
const defaultDb = (table) => {
  if (table === 'customers') {
    const chain = {};
    ['where', 'whereNull', 'orderBy', 'orderByRaw', 'orWhereRaw'].forEach((m) => { chain[m] = () => chain; });
    chain.first = async () => null;
    chain.then = (resolve, reject) => Promise.resolve(phoneCandidates).then(resolve, reject);
    return chain;
  }
  return { where: () => ({ first: async () => currentRow }) };
};
mockDb.mockImplementation(defaultDb);

function makeReq(path) {
  return {
    params: { token: 'tok-ssr-gate' },
    path,
    originalUrl: path,
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
    headers: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; },
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

  test('a clarify re-price HOLD on a mid-send row is withheld on both mounts — the legacy renderer never prints the stale quote (codex r4 P1 on #3804)', async () => {
    const held = JSON.stringify({ estimatorEngine: { reprice_pending_at: '2026-09-03T12:00:00Z', reprice_attempt: 'att-1' } });
    const api = await runView({ status: 'sending', expires_at: null, use_v2_view: false, estimate_data: held }, API_MOUNT);
    expect(api.next).not.toHaveBeenCalled();
    expect(api.res.statusCode).toBe(404);
    expect(api.res.body).not.toContain(PII.customer_name);
    expect(api.res.body).not.toContain('742 Leak Lane');
    expect(api.res.body).not.toContain('384.62');
    const spa = await runView({ status: 'sending', expires_at: null, use_v2_view: false, estimate_data: held }, ESTIMATE_MOUNT);
    expect(spa.next).toHaveBeenCalledTimes(1);
    expect(spa.res.sent).toBe(false);
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

  // Missing-contact capture lives only in the React accept card (codex
  // #5102 r1 P0): an accept-active legacy (v1) row with a contact gap must
  // never get the server-HTML page that cannot ask for it.
  test('accept-active v1 row missing a last name is forced to the React view on the /estimate/ mount', async () => {
    const { res, next } = await runView(
      { status: 'sent', expires_at: FUTURE, use_v2_view: false, sent_at: PAST, customer_name: 'Pat' },
      ESTIMATE_MOUNT,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(false);
  });

  test('accept-active v1 row missing an email redirects the /api/estimates mount to the React URL', async () => {
    const { res, next } = await runView(
      { status: 'sent', expires_at: FUTURE, use_v2_view: false, sent_at: PAST, customer_email: null, token: 'tok-ssr-gate' },
      API_MOUNT,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(302);
    expect(res.redirectUrl).toBe('/estimate/tok-ssr-gate');
  });

  test('a failed contact-gap lookup fails CLOSED toward the React view', async () => {
    mockDb.mockImplementation((table) => (table === 'customers'
      ? { where: () => ({ first: async () => { throw new Error('lookup boom'); } }) }
      : { where: () => ({ first: async () => currentRow }) }));
    try {
      const { res, next } = await runView(
        { status: 'sent', expires_at: FUTURE, use_v2_view: false, sent_at: PAST, customer_id: 'cust-x' },
        ESTIMATE_MOUNT,
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.sent).toBe(false);
    } finally {
      mockDb.mockImplementation(defaultDb);
    }
  });

  // B18 park: the legacy page's booking flow would end in a permanently refused accept, so a parked estimate (its
  // phone belongs to another customer) goes to the React page, which renders the existing review state.
  describe('a parked estimate (its lone phone candidate is contradicted) is never served the legacy booking page', () => {
    const BOB = { id: 'cust-bob', phone: '(941) 555-7777', email: 'bob@example.com', address_line1: '9 Other St' };
    const PARKED_ROW = { status: 'sent', expires_at: FUTURE, use_v2_view: false, sent_at: PAST, customer_id: null, customer_email: 'pat@example.com', token: 'tok-ssr-gate' };
    afterEach(() => { phoneCandidates = []; });

    test('explicit-v1 row on the /estimate/ mount falls through to the React view', async () => {
      phoneCandidates = [BOB];
      const { res, next } = await runView(PARKED_ROW, ESTIMATE_MOUNT);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.sent).toBe(false);
    });

    test('the /api/estimates mount redirects to the React URL instead of rendering the legacy page', async () => {
      phoneCandidates = [BOB];
      const { res, next } = await runView(PARKED_ROW, API_MOUNT);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(302);
      expect(res.redirectUrl).toBe('/estimate/tok-ssr-gate');
      expect(res.sent).toBe(false);
    });

    test('a failed park lookup fails toward the React view (the React page re-decides on its own /data)', async () => {
      mockDb.mockImplementation((table) => (table === 'customers'
        ? { where: () => { throw new Error('lookup boom'); } }
        : { where: () => ({ first: async () => currentRow }) }));
      try {
        const failed = await runView(PARKED_ROW, ESTIMATE_MOUNT);
        expect(failed.next).toHaveBeenCalledTimes(1);
      } finally { mockDb.mockImplementation(defaultDb); }
    });
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
  test.each(['sent', 'viewed', 'expired'])('an expired %s legacy group anchor opens React navigation on both mounts', async (status) => {
    const row = { status, token: 'groupanchorvalidtoken', expires_at: PAST, use_v2_view: false,
      sent_at: PAST, estimate_group_id: 'group-bid', estimate_data: { groupLinkViewableThrough: FUTURE } };
    const spa = await runView(row, ESTIMATE_MOUNT);
    expect(spa.next).toHaveBeenCalledTimes(1);
    expect(spa.res.sent).toBe(false);
    const api = await runView(row, API_MOUNT);
    expect(api.res.statusCode).toBe(302);
    expect(api.res.redirectUrl).toBe('/estimate/groupanchorvalidtoken');
    expect(api.res.sent).toBe(false);
    expect(api.res.headers).toMatchObject({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
  });
  test('an expired legacy anchor redirects after a newly recovered group window', async () => {
    refreshExpiredGroupNavigation.mockImplementationOnce(async (_database, stale) => ({
      ...stale, estimate_data: { groupLinkViewableThrough: FUTURE },
    }));
    const row = { status: 'expired', token: 'groupanchorvalidtoken', expires_at: PAST,
      sent_at: PAST, estimate_group_id: 'group-bid', estimate_data: {} };
    const { res } = await runView(row, API_MOUNT);
    expect(refreshExpiredGroupNavigation).toHaveBeenCalledWith(mockDb, expect.objectContaining({ token: row.token }));
    expect(res.statusCode).toBe(302);
    expect(res.redirectUrl).toBe('/estimate/groupanchorvalidtoken');
    expect(res.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
  });
  test('a rejected recovery cannot redirect a stale group anchor', async () => {
    refreshExpiredGroupNavigation.mockResolvedValueOnce(null);
    const row = { status: 'expired', token: 'groupanchorvalidtoken', expires_at: PAST,
      sent_at: PAST, estimate_group_id: 'group-bid', estimate_data: {} };
    const { res } = await runView(row, API_MOUNT);
    expect(res.statusCode).toBe(404);
    expect(res.redirectUrl).toBeUndefined();
    expect(res.body).not.toContain(PII.customer_name);
  });
  test('an archived group anchor cannot use its navigation window to escape the legacy withholding gate', async () => {
    const { res } = await runView({ status: 'expired', archived_at: PAST, expires_at: PAST,
      estimate_group_id: 'group-bid', estimate_data: { groupLinkViewableThrough: FUTURE } }, API_MOUNT);
    expect(res.statusCode).toBe(404);
    expect(res.redirectUrl).toBeUndefined();
  });

});
