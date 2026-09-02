/**
 * Send requires engine-authoritative pricing (validation audit SEC-002,
 * 2026-09-02).
 *
 * An admin save whose server recompute failed or had no replayable inputs
 * persists the BROWSER preview as a NON-authoritative price
 * (estimates.pricing_authority = CLIENT_FALLBACK — fail-open by design so a
 * broken engine never blocks the save). Nothing re-verified that price
 * before delivery. The FIRST send of such a row is refused while
 * GATE_SEND_REQUIRES_SERVER_PRICING is on and logged as a would-block while
 * it is off; a delivered row keeps its follow-ups and an authored proposal
 * (the manual quote) is exempt, exactly like the neighbouring gates.
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
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
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
  reviseAdminEstimate: jest.fn(),
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(() => 'https://example.test/estimate/tok'),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ clearEstimateRepricePending: jest.fn(async () => ({})) }));
jest.mock('../routes/estimate-public', () => ({ acceptanceServiceLists: jest.fn(), bookingServiceFor: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false) }));

// Gate values are fixed at module load; this passthrough flips the one gate
// under test per case.
const mockGateState = { sendRequiresServerPricing: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate === 'sendRequiresServerPricing'
      ? mockGateState.sendRequiresServerPricing
      : actual.isEnabled(gate)),
  };
});

const logger = require('../services/logger');
const adminEstimatesRouter = require('../routes/admin-estimates');
const {
  assertEstimateSendable,
  sendRequiresServerPricingFor,
  SERVER_PRICING_AUTHORITY_SQL,
  assertAutoSendPricingAuthority,
  notifyPricingFallbackAfterCommit,
  shadowLogFallbackDelivery,
} = adminEstimatesRouter._internals;
const { createOrReuseAdminEstimate, reviseAdminEstimate } = require('../services/admin-estimate-persistence');
const { notifyAdmin } = require('../services/notification-service');

function routeHandler(router, path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const fallbackDraft = (extra = {}) => ({
  id: 'est-client-fallback-1',
  status: 'draft',
  token: 'tok-client-fallback-test',
  monthly_total: 87,
  sent_at: null,
  pricing_authority: 'CLIENT_FALLBACK',
  estimate_data: {
    result: { recurring: { services: [{ name: 'Pest Control', service: 'pest_control', mo: 87 }] } },
  },
  ...extra,
});

function caughtBy(row, opts) {
  try {
    assertEstimateSendable(row, opts);
    return null;
  } catch (err) {
    return err;
  }
}

describe('assertEstimateSendable — engine-authoritative pricing gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGateState.sendRequiresServerPricing = true;
  });

  it('refuses the FIRST send of a CLIENT_FALLBACK row with 409 + code while the gate is on', () => {
    const err = caughtBy(fallbackDraft());
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CLIENT_FALLBACK_PRICING');
    expect(err.message).toMatch(/save again/i);
  });

  it('matches the stamp case-insensitively', () => {
    expect(caughtBy(fallbackDraft({ pricing_authority: 'client_fallback' }))?.code).toBe('CLIENT_FALLBACK_PRICING');
  });

  it('lets only the explicit SERVER stamp through; unstamped or unknown stamps are refused with their own code', () => {
    expect(caughtBy(fallbackDraft({ pricing_authority: 'SERVER' }))).toBeNull();
    expect(caughtBy(fallbackDraft({ pricing_authority: 'server' }))).toBeNull();
    for (const authority of [null, undefined, '', 'SOMETHING_NEW']) {
      const err = caughtBy(fallbackDraft({ pricing_authority: authority }));
      expect(err?.statusCode).toBe(409);
      expect(err?.code).toBe('PRICING_AUTHORITY_NOT_SERVER');
      expect(err?.message).toMatch(/no engine verification stamp/i);
    }
  });

  it('blocks a delivered row too — a revision of a live link can fall back, and its resend must not deliver it', () => {
    expect(caughtBy(fallbackDraft({ status: 'sent', sent_at: '2026-09-01T12:00:00.000Z' }))?.code).toBe('CLIENT_FALLBACK_PRICING');
  });

  it('exempts an authored proposal — its line items ARE the quote', () => {
    expect(caughtBy(fallbackDraft({
      estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] } },
    }))).toBeNull();
  });

  it('with the gate off the send proceeds and the pre-read assert itself logs nothing (the funnel counts)', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(caughtBy(fallbackDraft())).toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/shadow/));
  });
});

describe('shadowLogFallbackDelivery — one would-block per delivery attempt, gate off only', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('logs exactly once for a CLIENT_FALLBACK delivery while the gate is off', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft())).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shadow.*est-client-fallback-1.*CLIENT_FALLBACK/));
  });

  it('counts unstamped legacy rows too — everything the gate will refuse', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft({ pricing_authority: null }))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shadow.*est-client-fallback-1.*authority NULL/));
  });

  it('stays silent for engine-priced rows, authored proposals, and while the gate is on (the assert refuses instead)', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(shadowLogFallbackDelivery(fallbackDraft({ pricing_authority: 'SERVER' }))).toBe(false);
    expect(shadowLogFallbackDelivery(fallbackDraft({ estimate_data: { proposal: { enabled: true, buildings: [] } } }))).toBe(false);
    mockGateState.sendRequiresServerPricing = true;
    expect(shadowLogFallbackDelivery(fallbackDraft())).toBe(false);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/shadow/));
  });
});

describe('sendRequiresServerPricingFor — the predicate the send CLAIMS re-assert', () => {
  // The claims add SEND_CLAIM_PRICING_AUTHORITY_SQL to their WHERE exactly
  // when this returns true, so a revision that stamps CLIENT_FALLBACK between
  // the pre-read check and the claim loses the race (pre-push codex P0).
  beforeEach(() => { mockGateState.sendRequiresServerPricing = true; });

  it('applies to a first send of an ordinary estimate while the gate is on', () => {
    expect(sendRequiresServerPricingFor(fallbackDraft())).toBe(true);
    expect(sendRequiresServerPricingFor(fallbackDraft({ pricing_authority: 'SERVER' }))).toBe(true);
  });

  it('never applies with the gate off or to an authored proposal; delivered rows are NOT exempt', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(sendRequiresServerPricingFor(fallbackDraft())).toBe(false);
    mockGateState.sendRequiresServerPricing = true;
    expect(sendRequiresServerPricingFor(fallbackDraft({ sent_at: '2026-09-01T12:00:00.000Z' }))).toBe(true);
    expect(sendRequiresServerPricingFor(fallbackDraft({
      estimate_data: { proposal: { enabled: true, buildings: [] } },
    }))).toBe(false);
    expect(sendRequiresServerPricingFor(fallbackDraft({
      estimate_data: JSON.stringify({ proposal: { enabled: true, buildings: [] } }),
    }))).toBe(false);
  });

  it('the claim predicate every gated send re-asserts requires the explicit SERVER stamp', () => {
    expect(SERVER_PRICING_AUTHORITY_SQL).toBe("UPPER(pricing_authority) = 'SERVER'");
  });
});

describe('post-commit pricing-fallback bell (SEC-002 / pre-push codex P1)', () => {
  const req = (body = {}, params = {}) => ({ body, params, technicianId: 'tech-1', technician: { id: 'tech-1' }, techRole: 'admin' });
  beforeEach(() => { jest.clearAllMocks(); });

  it('rings once per estimate after a committed create whose recompute failed, keyed for dedupe', async () => {
    createOrReuseAdminEstimate.mockResolvedValue({
      estimate: { id: 'est-cf-9', token: 'tok-cf-9', customer_id: 'cust-cf-9', customer_name: 'Pat Tester', pricing_authority: 'CLIENT_FALLBACK' },
      reused: false, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR',
    });
    const res = makeRes();
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('Estimate saved without engine pricing'),
      expect.stringContaining('client fallback'),
      expect.objectContaining({ bell: true, dedupeKey: 'estimate-pricing-fallback:est-cf-9', dedupeWindowMs: 6 * 60 * 60 * 1000, metadata: expect.objectContaining({ estimateId: 'est-cf-9', customerId: 'cust-cf-9', reason: 'ENGINE_ERROR' }) }),
    );
  });

  it('stays silent for a server-priced create and for a NO_INPUTS fallback', async () => {
    createOrReuseAdminEstimate.mockResolvedValue({ estimate: { id: 'est-ok', token: 't' }, reused: false, memberLinkageWarning: null, pricingFallbackReason: null });
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), makeRes(), jest.fn());
    createOrReuseAdminEstimate.mockResolvedValue({ estimate: { id: 'est-legacy', token: 't' }, reused: false, memberLinkageWarning: null, pricingFallbackReason: 'NO_INPUTS' });
    await routeHandler(adminEstimatesRouter, '/', 'post')(req({}), makeRes(), jest.fn());
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('a dryRun revise preflight never rings; the committed revise does', async () => {
    const revised = { id: 'est-cf-7', token: 'tok-cf-7', status: 'draft', customer_name: 'Pat Tester' };
    reviseAdminEstimate.mockResolvedValue({ estimate: revised, dryRun: true, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR' });
    await routeHandler(adminEstimatesRouter, '/:id', 'put')(req({ dryRun: true }, { id: 'est-cf-7' }), makeRes(), jest.fn());
    expect(notifyAdmin).not.toHaveBeenCalled();
    reviseAdminEstimate.mockResolvedValue({ estimate: revised, memberLinkageWarning: null, pricingFallbackReason: 'ENGINE_ERROR' });
    await routeHandler(adminEstimatesRouter, '/:id', 'put')(req({}, { id: 'est-cf-7' }), makeRes(), jest.fn());
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe('estimate-pricing-fallback:est-cf-7');
  });

  it('the helper ignores rows without an id and reasons other than ENGINE_ERROR', () => {
    notifyPricingFallbackAfterCommit({ id: null }, 'ENGINE_ERROR');
    notifyPricingFallbackAfterCommit({ id: 'x' }, 'NO_INPUTS');
    notifyPricingFallbackAfterCommit({ id: 'x' }, null);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('assertAutoSendPricingAuthority — automation publishes only an engine-verified price, gate or no gate', () => {
  it('refuses a CLIENT_FALLBACK row even with the gate off (422 + code)', () => {
    mockGateState.sendRequiresServerPricing = false;
    let caught = null;
    try { assertAutoSendPricingAuthority(fallbackDraft()); } catch (e) { caught = e; }
    expect(caught?.statusCode).toBe(422);
    expect(caught?.code).toBe('PRICING_AUTHORITY_NOT_SERVER');
    expect(caught?.message).toMatch(/never auto-sent/i);
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'client_fallback' })).toThrow();
  });

  it('fails closed on null, unknown and locked stamps; only the explicit SERVER stamp passes', () => {
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'SERVER' })).not.toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'server' })).not.toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'LOCKED' })).toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: 'SOMETHING_NEW' })).toThrow();
    expect(() => assertAutoSendPricingAuthority({ pricing_authority: null })).toThrow();
    expect(() => assertAutoSendPricingAuthority({})).toThrow();
    expect(SERVER_PRICING_AUTHORITY_SQL).toBe("UPPER(pricing_authority) = 'SERVER'");
  });
});
