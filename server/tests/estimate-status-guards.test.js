/**
 * Guards on estimate status writes:
 *
 * 1. PATCH /api/admin/estimates/:id — status must be a real enum value and
 *    the transition must be one the generic PATCH is allowed to make.
 *    Terminal statuses (accepted/declined/expired) are owned by deliberate
 *    paths (mark-accepted, public accept/decline, extend); flipping
 *    accepted→sent here would re-arm the public accept link and re-run the
 *    converter. The UPDATE is also optimistically guarded on the status the
 *    handler validated against.
 *
 * 2. PUT /api/estimates/:token/select-tier and /:token/preferences — the
 *    accept-active check runs on a pre-read, so the UPDATE itself must
 *    refuse rows a concurrent accept has locked (status flip +
 *    price_locked_at), or the recompute would clobber the frozen price that
 *    EstimateConverter re-reads after the accept commits.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn();
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(() => null),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(),
  buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(),
  saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({
  createOrReuseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(),
  bookingServiceFor: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));

const db = require('../models/db');
const adminEstimatesRouter = require('../routes/admin-estimates');
const { resolveEstimateStatusPatch } = adminEstimatesRouter._internals;

function routeHandler(router, path, method) {
  const layer = router.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeBuilder({ first = null, updateCount = 1 } = {}) {
  const builder = {};
  for (const m of ['where', 'whereNotIn', 'whereNull', 'whereIn', 'andWhere', 'orderBy', 'limit']) {
    builder[m] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => first);
  builder.update = jest.fn(async () => updateCount);
  builder.insert = jest.fn(async () => [1]);
  return builder;
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('resolveEstimateStatusPatch transition matrix', () => {
  test('rejects garbage status values with a 400 verdict', () => {
    for (const bad of ['won', 'ACCEPTED', '', 42, null, undefined, {}]) {
      const verdict = resolveEstimateStatusPatch('sent', bad);
      expect(verdict.ok).toBe(false);
      expect(verdict.httpStatus).toBe(400);
    }
  });

  test('blocks every transition out of accepted (409)', () => {
    for (const target of ['draft', 'scheduled', 'sending', 'send_failed', 'sent', 'viewed', 'declined', 'expired']) {
      const verdict = resolveEstimateStatusPatch('accepted', target);
      expect(verdict.ok).toBe(false);
      expect(verdict.httpStatus).toBe(409);
    }
  });

  test('blocks transitions out of declined and expired (deliberate paths own them)', () => {
    expect(resolveEstimateStatusPatch('declined', 'sent').httpStatus).toBe(409);
    expect(resolveEstimateStatusPatch('expired', 'sent').httpStatus).toBe(409);
    expect(resolveEstimateStatusPatch('expired', 'viewed').httpStatus).toBe(409);
  });

  test('blocks setting accepted through the generic PATCH (mark-accepted owns it)', () => {
    for (const from of ['draft', 'sent', 'viewed', 'scheduled', 'send_failed']) {
      const verdict = resolveEstimateStatusPatch(from, 'accepted');
      expect(verdict.ok).toBe(false);
      expect(verdict.httpStatus).toBe(409);
    }
  });

  test('blocks send-lifecycle statuses owned by the scheduler (sent/scheduled/sending)', () => {
    expect(resolveEstimateStatusPatch('draft', 'sent').httpStatus).toBe(409);
    expect(resolveEstimateStatusPatch('draft', 'scheduled').httpStatus).toBe(409);
    expect(resolveEstimateStatusPatch('sent', 'sending').httpStatus).toBe(409);
    expect(resolveEstimateStatusPatch('sending', 'declined').httpStatus).toBe(409);
  });

  test('allows declining from active statuses (the only UI flow on this PATCH)', () => {
    for (const from of ['draft', 'scheduled', 'send_failed', 'sent', 'viewed']) {
      expect(resolveEstimateStatusPatch(from, 'declined')).toEqual({ ok: true, noop: false });
    }
  });

  test('same-status writes are a no-op (no declined_at re-stamp)', () => {
    expect(resolveEstimateStatusPatch('declined', 'declined')).toEqual({ ok: true, noop: true });
    expect(resolveEstimateStatusPatch('sent', 'sent')).toEqual({ ok: true, noop: true });
  });
});

describe('PATCH /api/admin/estimates/:id status guard', () => {
  const patchHandler = routeHandler(adminEstimatesRouter, '/:id', 'patch');

  beforeEach(() => {
    db.mockReset();
  });

  test('409s on accepted→declined without touching the row', async () => {
    const readBuilder = makeBuilder({ first: { id: 'e1', status: 'accepted' } });
    db.mockImplementation(() => readBuilder);

    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { status: 'declined' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(readBuilder.update).not.toHaveBeenCalled();
  });

  test('400s on a status outside the enum', async () => {
    const readBuilder = makeBuilder({ first: { id: 'e1', status: 'sent' } });
    db.mockImplementation(() => readBuilder);

    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { status: 'banana' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(readBuilder.update).not.toHaveBeenCalled();
  });

  test('sent→declined updates with an optimistic status guard and stamps declined_at', async () => {
    const readBuilder = makeBuilder({ first: { id: 'e1', status: 'sent' } });
    const writeBuilder = makeBuilder({ updateCount: 1 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { status: 'declined', declineReason: 'price' } }, res, jest.fn());

    expect(writeBuilder.where).toHaveBeenCalledWith({ status: 'sent' });
    expect(writeBuilder.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'declined',
      decline_reason: 'price',
      declined_at: expect.anything(),
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test('409s when a concurrent accept wins the race (0 rows updated)', async () => {
    const readBuilder = makeBuilder({ first: { id: 'e1', status: 'viewed' } });
    const writeBuilder = makeBuilder({ updateCount: 0 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { status: 'declined' } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('re-declining an already-declined estimate updates the reason without re-stamping declined_at', async () => {
    const readBuilder = makeBuilder({ first: { id: 'e1', status: 'declined' } });
    const writeBuilder = makeBuilder({ updateCount: 1 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await patchHandler({ params: { id: 'e1' }, body: { status: 'declined', declineReason: 'timing' } }, res, jest.fn());

    expect(writeBuilder.update).toHaveBeenCalledWith({ decline_reason: 'timing' });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});

describe('public select-tier / preferences post-lock TOCTOU guard', () => {
  // The top-level jest.mock of estimate-public exists so admin-estimates can
  // load; for these tests we need the real router (db stays mocked).
  const estimatePublicRouter = jest.requireActual('../routes/estimate-public');

  beforeEach(() => {
    db.mockReset();
  });

  const activeEstimate = {
    id: 'e1',
    token: 'tok1',
    status: 'sent',
    customer_name: 'Test Customer',
    waveguard_tier: 'Bronze',
    monthly_total: 100,
    annual_total: 1200,
    onetime_total: 0,
    // /preferences only applies to RESIDENTIAL pest estimates — without a
    // pest_control recurring line it 400s before ever reaching the guarded
    // UPDATE, so the fixture carries one.
    estimate_data: JSON.stringify({
      baseMonthly: 100,
      result: {
        recurring: {
          services: [{ service: 'pest_control', name: 'Pest Control', mo: 100, frequency: 'quarterly' }],
        },
      },
    }),
    expires_at: null,
    archived_at: null,
  };

  // Mirrors the accept transaction's full status guard — the UPDATE refuses
  // every non-active status, not just the terminal three.
  const GUARDED_STATUSES = ['accepted', 'declined', 'expired', 'send_failed', 'draft', 'scheduled'];

  test('select-tier returns 409 when the conditional update hits a locked row', async () => {
    const handler = routeHandler(estimatePublicRouter, '/:token/select-tier', 'put');
    const readBuilder = makeBuilder({ first: { ...activeEstimate } });
    const writeBuilder = makeBuilder({ updateCount: 0 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await handler({ params: { token: 'tok1' }, body: { selectedTier: 'Gold' } }, res, jest.fn());

    expect(writeBuilder.whereNotIn).toHaveBeenCalledWith('status', GUARDED_STATUSES);
    expect(writeBuilder.whereNull).toHaveBeenCalledWith('price_locked_at');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Estimate is no longer active' });
  });

  test('select-tier succeeds when the row is still unlocked', async () => {
    const handler = routeHandler(estimatePublicRouter, '/:token/select-tier', 'put');
    const readBuilder = makeBuilder({ first: { ...activeEstimate } });
    const writeBuilder = makeBuilder({ updateCount: 1 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await handler({ params: { token: 'tok1' }, body: { selectedTier: 'Gold' } }, res, jest.fn());

    expect(writeBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ waveguard_tier: 'Gold' }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, tier: 'Gold' }));
  });

  test('preferences returns 409 when the conditional update hits a locked row', async () => {
    const handler = routeHandler(estimatePublicRouter, '/:token/preferences', 'put');
    const readBuilder = makeBuilder({ first: { ...activeEstimate } });
    const writeBuilder = makeBuilder({ updateCount: 0 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await handler({ params: { token: 'tok1' }, body: { interior_spray: false } }, res, jest.fn());

    expect(writeBuilder.whereNotIn).toHaveBeenCalledWith('status', GUARDED_STATUSES);
    expect(writeBuilder.whereNull).toHaveBeenCalledWith('price_locked_at');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Estimate is no longer active' });
  });

  test('preferences succeeds when the row is still unlocked', async () => {
    const handler = routeHandler(estimatePublicRouter, '/:token/preferences', 'put');
    const readBuilder = makeBuilder({ first: { ...activeEstimate } });
    const writeBuilder = makeBuilder({ updateCount: 1 });
    db.mockImplementationOnce(() => readBuilder).mockImplementationOnce(() => writeBuilder);

    const res = makeRes();
    await handler({ params: { token: 'tok1' }, body: { interior_spray: false } }, res, jest.fn());

    expect(writeBuilder.update).toHaveBeenCalledWith(expect.objectContaining({
      monthly_total: expect.any(Number),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
