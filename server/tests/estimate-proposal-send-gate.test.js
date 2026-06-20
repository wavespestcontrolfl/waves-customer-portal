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
  clearStaleProposalDelivery,
  estimateDataHasBlockingLeadAutomation,
  assertEstimateSendable,
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

describe('clearStaleProposalDelivery (re-authored proposal)', () => {
  it('drops the prior send\'s emailed-PDF state so re-priced proposals do not over-claim', () => {
    // A prior send stamped proposalDelivery.pdfEmailed=true for the OLD PDF;
    // saving a new proposal must clear it so the public link does not keep
    // saying the edited proposal was emailed until the next send re-stamps it.
    const data = {
      proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] },
      proposalDelivery: { pdfEmailed: true, channels: ['email'], stampedAt: '2026-06-19T00:00:00.000Z' },
    };
    clearStaleProposalDelivery(data);
    expect(data.proposalDelivery).toBeUndefined();
    expect(data.proposal.enabled).toBe(true);
  });

  it('is a no-op when no prior delivery state exists', () => {
    const data = { proposal: { enabled: true, buildings: [] } };
    clearStaleProposalDelivery(data);
    expect(data).toEqual({ proposal: { enabled: true, buildings: [] } });
  });
});

describe('assertEstimateSendable proposal exemption', () => {
  // The send snapshot re-derives quoteRequired:true from proposal.enabled, so
  // the gate must exempt authored proposals rather than rely on scrubbed flags
  // — otherwise resends/follow-ups of a sent proposal would re-block.
  const sentProposalRow = (extraData = {}) => ({
    status: 'sent',
    monthly_total: 583,
    estimate_data: {
      proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [] }] },
      // mimic what a send snapshot leaves behind
      sendSnapshot: { pricingBundle: { quoteRequired: true } },
      ...extraData,
    },
  });

  it('allows resending a sent proposal even when the snapshot is quote-required', () => {
    expect(() => assertEstimateSendable(sentProposalRow())).not.toThrow();
  });

  it('still blocks a quote-required estimate that is NOT an authored proposal', () => {
    expect(() => assertEstimateSendable({
      status: 'sent',
      monthly_total: 100,
      estimate_data: { result: { recurring: { services: [{ quoteRequired: true }] } } },
    })).toThrow(/quote-required|manual review/i);
  });

  it('exempts authored proposals from the blocking lead-automation gate', () => {
    expect(() => assertEstimateSendable(sentProposalRow({
      automation: { draftEstimateAutomation: { status: 'manual_review_required' } },
    }))).not.toThrow();
  });
});
