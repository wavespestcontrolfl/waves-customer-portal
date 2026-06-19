/**
 * Authored commercial proposals must be sendable.
 *
 * A commercial estimate is created quote-required, which the recursive
 * estimateDataHasQuoteRequirement send gate blocks. Once an operator authors
 * a multi-building proposal (their line items ARE the quote), saving it clears
 * those raw flags so delivery is unblocked — while estimate_data.proposal.enabled
 * keeps acceptance manual in the public view. This locks in that contract.
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

// NOTE: estimate-delivery-options is intentionally NOT mocked — we assert the
// real send gate against the real flag clearer.
const {
  clearQuoteRequirementFlags,
  resolveBlockingAutomationForProposal,
  estimateDataHasBlockingLeadAutomation,
} = require('../routes/admin-estimates')._internals;
const { estimateDataHasQuoteRequirement } = require('../services/estimate-delivery-options');

describe('clearQuoteRequirementFlags (authored proposal send gate)', () => {
  it('unblocks the send gate while preserving proposal.enabled', () => {
    const data = {
      quoteRequired: true,
      requiresManualReview: true,
      result: { recurring: { services: [{ name: 'Pest', requiresCustomQuote: true }] } },
      proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] },
    };
    expect(estimateDataHasQuoteRequirement(data)).toBe(true);

    clearQuoteRequirementFlags(data);

    expect(estimateDataHasQuoteRequirement(data)).toBe(false);
    expect(data.proposal.enabled).toBe(true);
    expect(data.quoteRequired).toBe(false);
    expect(data.result.recurring.services[0].requiresCustomQuote).toBe(false);
  });

  it('is a no-op on data with no quote flags', () => {
    const data = { proposal: { enabled: true, buildings: [] } };
    clearQuoteRequirementFlags(data);
    expect(data).toEqual({ proposal: { enabled: true, buildings: [] } });
  });
});

describe('resolveBlockingAutomationForProposal', () => {
  it('clears a blocking lead/draft automation status so the proposal can send', () => {
    const data = {
      automation: {
        draftEstimateAutomation: { status: 'manual_review_required', generated: true },
        leadEstimateAutomation: { status: 'blocked' },
      },
      proposal: { enabled: true, buildings: [{ name: 'A', lineItems: [] }] },
    };
    expect(estimateDataHasBlockingLeadAutomation(data)).toBe(true);

    resolveBlockingAutomationForProposal(data);

    expect(estimateDataHasBlockingLeadAutomation(data)).toBe(false);
    expect(data.automation.draftEstimateAutomation.status).toBe('manual_review_complete');
    expect(data.automation.leadEstimateAutomation.status).toBe('manual_review_complete');
  });

  it('leaves a non-blocking automation status untouched', () => {
    const data = { automation: { draftEstimateAutomation: { status: 'generated' } } };
    resolveBlockingAutomationForProposal(data);
    expect(data.automation.draftEstimateAutomation.status).toBe('generated');
  });
});
