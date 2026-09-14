/**
 * The annual protection plan's KILL SWITCH at delivery (codex #4424 P1).
 *
 * GATE_TERMITE_ANNUAL_PLAN governs FRESH plan selections; an already-issued
 * plan keeps replaying its stamped constants after the switch is unset, so a
 * live contract is never repriced to the quarterly program. That stamp is
 * written at PRICING time, though — an unsent draft priced while the gate was
 * on carries it too. Unsetting the gate must therefore stop that draft from
 * being DELIVERED (a delivered estimate is viewable and acceptable; a draft is
 * neither — UNPUBLISHED_ESTIMATE_STATUSES keeps draft/scheduled rows off every
 * public money path). The real-provider-handoff witness must be bound to the
 * annual offer delivered; sent_at can also describe a suppressed SMS.
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

const adminEstimatesRouter = require('../routes/admin-estimates');

const { selectedTermiteAnnualPlanRows } = require('../services/estimate-termite-program-rows');
const { assertEstimateSendable, annualPlanOfferFingerprint, publishedSiblingDeliveryPatch } = adminEstimatesRouter._internals;

const PLAN_LINE = { service: 'termite_bait', plan: 'annual_protection', stations: 15 };
const QUARTERLY_LINE = { service: 'termite_bait', plan: 'quarterly', stations: 15 };

const row = (estimate_data, extra = {}) => ({
  id: 'est-termite-plan-1',
  status: 'draft',
  token: 'tok-termite-plan',
  monthly_total: 0,
  onetime_total: 450,
  sent_at: null,
  pricing_authority: 'SERVER',
  estimate_data,
  ...extra,
});
const planDraft = (extra = {}) => row({ result: { lineItems: [PLAN_LINE] } }, extra);

function caught(estimate) {
  try {
    assertEstimateSendable(estimate);
    return null;
  } catch (err) {
    return err;
  }
}

describe('selectedTermiteAnnualPlanRows — every shape a stored plan can take', () => {
  test('finds the raw engine line, the mapped envelope and the one-time setup item', () => {
    expect(selectedTermiteAnnualPlanRows({ result: { lineItems: [PLAN_LINE] } })).toHaveLength(1);
    expect(selectedTermiteAnnualPlanRows({ engineResult: { lineItems: [PLAN_LINE] } })).toHaveLength(1);
    expect(selectedTermiteAnnualPlanRows({ result: { results: { tmBait: { plan: 'annual_protection' } } } })).toHaveLength(1);
    expect(selectedTermiteAnnualPlanRows({
      result: { oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup', price: 450 }] } },
    })).toHaveLength(1);
  });

  test('ignores the quarterly program, a plain install item and junk payloads', () => {
    expect(selectedTermiteAnnualPlanRows({ result: { lineItems: [QUARTERLY_LINE] } })).toHaveLength(0);
    expect(selectedTermiteAnnualPlanRows({ result: { results: { tmBait: { plan: 'quarterly' } } } })).toHaveLength(0);
    expect(selectedTermiteAnnualPlanRows({
      result: { oneTime: { items: [{ service: 'termite_bait_installation', price: 653 }] } },
    })).toHaveLength(0);
    expect(selectedTermiteAnnualPlanRows(null)).toHaveLength(0);
    expect(selectedTermiteAnnualPlanRows({ result: { lineItems: 'nope' } })).toHaveLength(0);
  });

  test('a revised mapped quarterly result outranks a stale raw annual draft', () => {
    const revised = {
      result: { results: { tmBait: { plan: 'quarterly' } } },
      engineResult: { lineItems: [PLAN_LINE] },
    };
    expect(selectedTermiteAnnualPlanRows(revised)).toHaveLength(0);
    expect(selectedTermiteAnnualPlanRows({
      result: { results: { tmBait: { plan: 'annual_protection' } } },
      engineResult: { lineItems: [QUARTERLY_LINE] },
    })).toHaveLength(1);
  });
});

describe('assertEstimateSendable — GATE_TERMITE_ANNUAL_PLAN at delivery', () => {
  const priorCancellationGate = process.env.GATE_CANCEL_FLOW_V2;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGateState.sendRequiresServerPricing = false;
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
  });
  afterAll(() => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    if (priorCancellationGate === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
    else process.env.GATE_CANCEL_FLOW_V2 = priorCancellationGate;
  });

  test('gate OFF: a never-delivered plan draft is refused with its own code', () => {
    const err = caught(planDraft());
    expect(err).toBeTruthy();
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
    expect(err.message).toMatch(/quarterly program/i);
  });

  test('gate OFF: a RESEND of an already-delivered plan still goes out — the switch stops new contracts, it does not retract issued ones', () => {
    const delivered = planDraft({
      status: 'sent',
      sent_at: new Date('2026-09-12T00:00:00Z'),
    });
    delivered.estimate_data.deliveryState = {
      firstDeliveredAt: '2026-09-12T00:00:00.000Z',
      annualPlanOfferFingerprint: annualPlanOfferFingerprint(delivered),
    };
    expect(caught(delivered)).toBeNull();
    // The first public view writes a display-only total into estimate_data.
    delivered.estimate_data.viewedMonthlyTotal = 299;
    delete process.env.GATE_CANCEL_FLOW_V2;
    expect(caught(delivered)).toBeNull();
  });

  test('an annual group sibling gets its own handoff witness and can resend through the group link', () => {
    const sibling = planDraft({ id: 'sibling', estimate_group_id: 'group-1' });
    const deliveredAt = '2026-09-12T00:00:00.000Z';
    const patch = publishedSiblingDeliveryPatch(sibling, {
      firstDeliveredAt: '2026-09-11T00:00:00.000Z',
      annualPlanOfferFingerprint: 'anchor-offer',
    }, deliveredAt);
    expect(patch.deliveryState.firstDeliveredAt).toBe(deliveredAt);
    expect(patch.deliveryState.annualPlanOfferFingerprint).not.toBe('anchor-offer');
    const published = { ...sibling, status: 'sent',
      estimate_data: { ...sibling.estimate_data, ...patch, groupPublishedByEstimateId: 'anchor' } };
    expect(caught(published)).toBeNull();
    published.notes = 'Revised terms';
    expect(caught(published)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('delivery claim and cleanup metadata do not change an admin annual offer fingerprint', () => {
    const original = planDraft();
    const fingerprint = annualPlanOfferFingerprint(original);
    for (const estimatorEngine of [
      { delivering_at: '2026-09-12T00:00:00.000Z', delivering_token: 'claim-1' },
      {},
    ]) {
      const row = { ...original, estimate_data: { ...original.estimate_data, estimatorEngine } };
      expect(annualPlanOfferFingerprint(row)).toBe(fingerprint);
    }
    const delivered = { ...original, status: 'sent', estimate_data: {
      ...original.estimate_data, estimatorEngine: {},
      deliveryState: { firstDeliveredAt: '2026-09-12T00:00:00.000Z', annualPlanOfferFingerprint: fingerprint },
    } };
    expect(caught(delivered)).toBeNull();
  });

  test('gate OFF: an earlier quarterly handoff does not authorize a revised annual quote', () => {
    const revised = planDraft({
      status: 'sent', sent_at: new Date('2026-09-12T00:00:00Z'),
      estimate_data: {
        result: { lineItems: [PLAN_LINE] },
        deliveryState: { firstDeliveredAt: '2026-09-12T00:00:00.000Z' },
      },
    });
    expect(caught(revised)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate OFF: revising the delivered annual price or recipient is a new offer', () => {
    const delivered = planDraft({ status: 'sent', customer_id: 'customer-1' });
    const fingerprint = annualPlanOfferFingerprint(delivered);
    delivered.estimate_data.deliveryState = {
      firstDeliveredAt: '2026-09-12T00:00:00.000Z', annualPlanOfferFingerprint: fingerprint,
    };
    delivered.estimate_data.result.lineItems[0] = { ...PLAN_LINE, annual: 399 };
    expect(caught(delivered)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
    delivered.estimate_data.result.lineItems[0] = PLAN_LINE;
    delivered.customer_id = 'customer-2';
    expect(caught(delivered)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate OFF: changed contact, notes, option or billing mode cannot reuse the prior handoff', () => {
    const original = planDraft({ status: 'sent' });
    const fingerprint = annualPlanOfferFingerprint(original);
    for (const [field, value] of [
      ['customer_phone', '9415550101'], ['customer_email', 'other@example.test'],
      ['customer_name', 'Other Customer'], ['notes', 'Different coverage terms'],
      ['show_one_time_option', true], ['bill_by_invoice', true],
    ]) {
      const changed = { ...original, [field]: value,
        estimate_data: { ...original.estimate_data,
          deliveryState: { firstDeliveredAt: '2026-09-12T00:00:00.000Z', annualPlanOfferFingerprint: fingerprint } } };
      expect(caught(changed)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
    }
  });

  test('gate OFF: a suppressed-only SMS sent_at is not publication and cannot bypass the kill switch', () => {
    const err = caught(planDraft({ status: 'sent', sent_at: new Date('2026-09-12T00:00:00Z') }));
    expect(err?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate ON: the same draft sends', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    expect(caught(planDraft())).toBeNull();
  });

  test('annual gate ON with cancellation gate OFF refuses a fresh annual draft', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    delete process.env.GATE_CANCEL_FLOW_V2;
    expect(caught(planDraft())?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate OFF: a quarterly termite draft is untouched by this gate', () => {
    expect(caught(row({ result: { lineItems: [QUARTERLY_LINE] } }))).toBeNull();
  });

  test('gate OFF: a quarterly revision sends despite its retained stale annual engine result; a mapped annual revision is still refused', () => {
    const revisedQuarterly = row({
      result: { results: { tmBait: { plan: 'quarterly' } } },
      engineResult: { lineItems: [PLAN_LINE] },
    });
    expect(caught(revisedQuarterly)).toBeNull();

    const revisedAnnual = row({
      result: { results: { tmBait: { plan: 'annual_protection' } } },
      engineResult: { lineItems: [QUARTERLY_LINE] },
    });
    expect(caught(revisedAnnual)?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate OFF: a client-fallback payload carrying only the MAPPED plan shape is refused too', () => {
    const err = caught(row({ result: { results: { tmBait: { plan: 'annual_protection' } } } }));
    expect(err?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });

  test('gate OFF: a stringified estimate_data column is parsed before the sweep', () => {
    const err = caught(row(JSON.stringify({ result: { lineItems: [PLAN_LINE] } })));
    expect(err?.code).toBe('TERMITE_ANNUAL_PLAN_DISABLED');
  });
});
