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
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  isActivePlanCustomer: jest.fn(async () => false),
}));

const publicRouter = require('../routes/estimate-public');
const { handleEstimateView, handleEstimateAsk, applyServiceMixChange } = publicRouter;
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
  test.each([API_MOUNT, ESTIMATE_MOUNT, 'ask', 'select-tier', 'preferences', 'service-opt-out', 'warranty-comparison/pdf'])('rechecks the annual witness after membership repricing on %s', async (mount) => {
    const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
    const persistence = require('../services/admin-estimate-persistence');
    const result = { lineItems: [{ service: 'termite_bait', plan: 'annual_protection' }] };
    const row = { ...PII, id: 'annual-member', token: 'tok-ssr-gate', customer_id: 'lapsed-member', status: 'sent',
      expires_at: FUTURE, use_v2_view: false, monthly_total: 30,
      estimate_data: { result, membershipSnapshot: { isExistingCustomer: true } } };
    row.estimate_data.deliveryState = { firstDeliveredAt: new Date().toISOString(),
      annualPlanOfferFingerprint: annualPlanOfferFingerprint(row) };
    const reprice = jest.spyOn(persistence, 'serverRecomputeFromEstimateData').mockResolvedValue({
      recomputed: true, serverResult: result, serverTotals: { monthlyTotal: 40, annualTotal: 480, onetimeTotal: 0 },
    });
    const comparison = require('../services/termite-warranty-comparison');
    const comparisonGate = jest.spyOn(comparison, 'termiteComparisonGateOn').mockReturnValue(true);
    const comparisonBuild = jest.spyOn(comparison, 'buildTermiteComparisonData');
    const priorGate = process.env.GATE_TERMITE_ANNUAL_PLAN;
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    try {
      let res, next;
      if (mount === 'ask') {
        currentRow = row;
        const req = makeReq('/tok-ssr-gate/ask');
        req.body = { question: 'What does this cover?', askToken: require('jsonwebtoken').sign({
          kind: 'estimate_ask', estimateId: row.id,
          tokenHash: require('crypto').createHash('sha256').update(row.token).digest('hex'),
        }, process.env.ESTIMATE_ASK_TOKEN_SECRET || process.env.JWT_SECRET, { expiresIn: '2h' }) };
        res = makeRes(); res.json = res.send;
        await handleEstimateAsk(req, res, (error) => { throw error; });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: 'estimate_expired' });
      } else if (mount === 'service-opt-out') {
        const outcome = await applyServiceMixChange({ estimate: row, body: { serviceKey: 'pest', included: false, dryRun: true } });
        expect(outcome).toEqual({ status: 404, body: { error: 'Estimate not found' } });
      } else if (['select-tier', 'preferences', 'warranty-comparison/pdf'].includes(mount)) {
        currentRow = row;
        const route = publicRouter.stack.find((layer) => layer.route?.path === `/:token/${mount}`).route;
        const handler = route.stack[route.stack.length - 1].handle;
        const req = makeReq(`/tok-ssr-gate/${mount}`);
        req.body = { selectedTier: 'Bronze', interiorSpray: false };
        res = makeRes(); res.json = res.send;
        await handler(req, res, (error) => { throw error; });
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: 'Estimate not found' });
        expect(comparisonBuild).not.toHaveBeenCalled();
      } else ({ res, next } = await runView(row, mount));
      expect(reprice).toHaveBeenCalled();
      if (mount === API_MOUNT) {
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain(PII.customer_email);
      } else if (mount === ESTIMATE_MOUNT) {
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.sent).toBe(false);
      }
    } finally {
      reprice.mockRestore();
      comparisonGate.mockRestore();
      comparisonBuild.mockRestore();
      if (priorGate === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = priorGate;
    }
  });

  test('ordinary PDF fallback rechecks after live billing reconciliation before rendering', async () => {
    const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
    const row = { ...PII, id: 'annual-pdf', status: 'sent', expires_at: FUTURE, monthly_total: 30,
      estimate_data: { result: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection' }] } } };
    row.estimate_data.deliveryState = { firstDeliveredAt: new Date().toISOString(),
      annualPlanOfferFingerprint: annualPlanOfferFingerprint(row) };
    const billing = jest.spyOn(require('../services/estimate-proposal-billing'), 'resolveProposalBillingContext')
      .mockImplementation(async (estimate) => { estimate.monthly_total = 40; return {}; });
    const render = jest.spyOn(require('../services/pdf/estimate-pdf'), 'generateEstimateProposalPDF').mockImplementation(() => {});
    const priorAnnual = process.env.GATE_TERMITE_ANNUAL_PLAN;
    const priorPdf = process.env.GATE_ESTIMATE_DOC_PDF;
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'false';
    process.env.GATE_ESTIMATE_DOC_PDF = 'false';
    try {
      currentRow = row;
      const route = publicRouter.stack.find((layer) => layer.route?.path === '/:token/pdf').route;
      const res = makeRes(); res.json = res.send;
      await route.stack[route.stack.length - 1].handle(makeReq('/tok-ssr-gate/pdf'), res, (error) => { throw error; });
      expect(billing).toHaveBeenCalledWith(row);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Estimate not found' });
      expect(render).not.toHaveBeenCalled();
    } finally {
      billing.mockRestore(); render.mockRestore();
      if (priorAnnual === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = priorAnnual;
      if (priorPdf === undefined) delete process.env.GATE_ESTIMATE_DOC_PDF;
      else process.env.GATE_ESTIMATE_DOC_PDF = priorPdf;
    }
  });

  test('a revised annual offer without a matching handoff never renders through the legacy token', async () => {
    const priorAnnual = process.env.GATE_TERMITE_ANNUAL_PLAN;
    const priorCancel = process.env.GATE_CANCEL_FLOW_V2;
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    delete process.env.GATE_CANCEL_FLOW_V2;
    try {
      const { res } = await runView({ status: 'sent', expires_at: FUTURE, use_v2_view: false,
        estimate_data: { result: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection' }] } },
      }, API_MOUNT);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(PII.customer_email);
    } finally {
      if (priorAnnual === undefined) delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      else process.env.GATE_TERMITE_ANNUAL_PLAN = priorAnnual;
      if (priorCancel === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
      else process.env.GATE_CANCEL_FLOW_V2 = priorCancel;
    }
  });
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
