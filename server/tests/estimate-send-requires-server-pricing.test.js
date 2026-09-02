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
  estimateExpiresAt: jest.fn(),
  estimateViewUrl: jest.fn(),
}));
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
const { assertEstimateSendable } = require('../routes/admin-estimates')._internals;

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

  it('lets engine-priced and unstamped rows through', () => {
    expect(caughtBy(fallbackDraft({ pricing_authority: 'SERVER' }))).toBeNull();
    expect(caughtBy(fallbackDraft({ pricing_authority: null }))).toBeNull();
    expect(caughtBy(fallbackDraft({ pricing_authority: undefined }))).toBeNull();
  });

  it('never re-blocks a row that already went out (follow-ups keep flowing)', () => {
    expect(caughtBy(fallbackDraft({ status: 'sent', sent_at: '2026-09-01T12:00:00.000Z' }))).toBeNull();
  });

  it('exempts an authored proposal — its line items ARE the quote', () => {
    expect(caughtBy(fallbackDraft({
      estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] } },
    }))).toBeNull();
  });

  it('with the gate off the send proceeds and the would-block is logged for the shadow count', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(caughtBy(fallbackDraft())).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shadow.*est-client-fallback-1.*CLIENT_FALLBACK/));
  });

  it('with the gate off an engine-priced row logs nothing', () => {
    mockGateState.sendRequiresServerPricing = false;
    expect(caughtBy(fallbackDraft({ pricing_authority: 'SERVER' }))).toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/shadow/));
  });
});
