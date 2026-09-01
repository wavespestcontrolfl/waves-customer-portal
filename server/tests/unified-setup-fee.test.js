/**
 * Unified accept-time setup fee — PR 1 decision core (owner ruling
 * 2026-09-01, dark behind GATE_UNIFIED_SETUP_FEE).
 *
 * Pins: the existing-customer predicate (status-based, family-agnostic,
 * tier-agnostic); the decide-once verdict; the gate-on quote basis (any
 * recurring mix qualifies) vs the gate-off legacy kinds; the waiver step
 * (existing customer / account-wide queued claim); the engine's threaded
 * rodent-setup-line suppression (residential only, replay-safe); and the
 * converter honoring a frozen unified quote both ways.
 */

let mockGateOn = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'unifiedSetupFee' ? mockGateOn : false)),
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
  gates: {},
}));

const {
  unifiedSetupFeeAmount,
  hasActiveRecurringService,
  decideUnifiedSetupFee,
} = require('../services/unified-setup-fee');
const { WAVEGUARD } = require('../services/pricing-engine/constants');

// Minimal knex-ish chain: .where/.orWhere* record nothing; .first resolves
// the injected rows' first element.
function fakeDb(rows) {
  return () => {
    const chain = {};
    chain.where = () => chain;
    chain.orWhereIn = () => chain;
    chain.whereNull = () => chain;
    chain.orWhereNotNull = () => chain;
    chain.orWhere = () => chain;
    chain.first = async () => rows[0] || null;
    return chain;
  };
}

beforeEach(() => { mockGateOn = false; });

describe('hasActiveRecurringService — the "existing customer" predicate', () => {
  test('a live recurring row → existing; none → new', async () => {
    expect(await hasActiveRecurringService(fakeDb([{ id: 'v1' }]), 'c1')).toBe(true);
    expect(await hasActiveRecurringService(fakeDb([]), 'c1')).toBe(false);
    expect(await hasActiveRecurringService(fakeDb([{ id: 'v1' }]), null)).toBe(false);
  });

  test('the SQL shape is status-based, family-agnostic, and excludes callbacks (source contract)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/unified-setup-fee'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n'); // code only — comments may NAME the excluded helpers
    // Recurring evidence: anchor flag OR child linkage — no family filter,
    // no tier read, no service_type mention.
    expect(src).toMatch(/is_recurring', true\)\.orWhereNotNull\('recurring_parent_id'\)/);
    expect(src).not.toMatch(/waveguard_tier|service_type|loadExistingQualifyingServiceKeys/);
    // Status-based liveness incl. NULL-open legacy rows; date never enters.
    expect(src).toMatch(/whereNull\('status'\)\.orWhereIn\('status', LIVE_STATUSES\)/);
    expect(src).not.toMatch(/scheduled_date/);
    expect(src).toMatch(/whereNull\('is_callback'\)/);
  });
});

describe('decideUnifiedSetupFee — decide once, frozen', () => {
  test('new customer owes the configured amount; existing customer is waived', async () => {
    mockGateOn = true;
    expect(await decideUnifiedSetupFee(fakeDb([]), { customerId: 'c1' }))
      .toEqual({ amount: unifiedSetupFeeAmount(), kind: 'unified' });
    expect(await decideUnifiedSetupFee(fakeDb([{ id: 'v1' }]), { customerId: 'c1' }))
      .toEqual({ amount: 0, kind: 'unified', waived: 'existing_customer' });
    // No customer yet (fresh lead) → owes: one-time-only history and brand
    // new accounts are NEW per the ruling.
    expect(await decideUnifiedSetupFee(fakeDb([]), {}))
      .toEqual({ amount: unifiedSetupFeeAmount(), kind: 'unified' });
  });

  test('a zero/disabled configured fee waives everyone (rodent_setup_fee convention)', async () => {
    const prior = WAVEGUARD.unifiedSetupFee;
    try {
      WAVEGUARD.unifiedSetupFee = 0;
      expect(await decideUnifiedSetupFee(fakeDb([]), { customerId: 'c1' }))
        .toEqual({ amount: 0, kind: 'unified', waived: 'fee_disabled' });
    } finally {
      WAVEGUARD.unifiedSetupFee = prior;
    }
  });
});

describe('quote basis + waiver step (public-quote)', () => {
  const { setupFeeQuoteBasisForEstimate, resolveSetupFeeQuoteDecision } = require('../routes/public-quote')._internals;
  const soloPest = { lineItems: [{ service: 'pest_control', monthly: 45 }] };
  const lawnPlusPest = { lineItems: [{ service: 'pest_control', monthly: 45 }, { service: 'lawn_care', monthly: 80 }] };
  const oneTimeOnly = { lineItems: [{ service: 'wdo_inspection', price: 150 }] };

  test('gate OFF: legacy kinds unchanged (solo pest → membership fee; bundle → nothing)', () => {
    mockGateOn = false;
    expect(setupFeeQuoteBasisForEstimate(soloPest).kind).toBe('waveguard_membership');
    expect(setupFeeQuoteBasisForEstimate(lawnPlusPest).qualifies).toBe(false);
  });

  test('gate ON: ANY recurring mix qualifies as kind unified; one-time-only and commercial never do', () => {
    mockGateOn = true;
    for (const est of [soloPest, lawnPlusPest]) {
      expect(setupFeeQuoteBasisForEstimate(est))
        .toEqual({ qualifies: true, kind: 'unified', amount: unifiedSetupFeeAmount() });
    }
    expect(setupFeeQuoteBasisForEstimate(oneTimeOnly).qualifies).toBe(false);
    expect(setupFeeQuoteBasisForEstimate(lawnPlusPest, { commercialDetected: true }).qualifies).toBe(false);
    expect(setupFeeQuoteBasisForEstimate(lawnPlusPest, { quoteRequired: true }).qualifies).toBe(false);
  });

  test('waiver step: existing customer waives the unified kind; an account-wide queued claim waives it too', () => {
    const basis = { qualifies: true, kind: 'unified', amount: 99 };
    expect(resolveSetupFeeQuoteDecision(basis, { existingCustomer: true }))
      .toEqual({ amount: 0, waived: 'existing_customer', kind: 'unified' });
    expect(resolveSetupFeeQuoteDecision(basis, { feeAlreadyQueued: true }))
      .toEqual({ amount: 0, waived: 'fee_already_queued', kind: 'unified' });
    expect(resolveSetupFeeQuoteDecision(basis, {}))
      .toEqual({ amount: 99, kind: 'unified' });
    // existingCustomer never waives the LEGACY kinds (their own rules stand).
    const legacy = { qualifies: true, kind: 'waveguard_membership', amount: 99 };
    expect(resolveSetupFeeQuoteDecision(legacy, { existingCustomer: true }))
      .toEqual({ amount: 99, kind: 'waveguard_membership' });
  });
});

describe('engine: threaded rodent-setup-line suppression (replay-safe by construction)', () => {
  const { generateEstimate } = require('../services/pricing-engine');
  const baseInput = { homeSqFt: 2000, lotSqFt: 8000, stories: 1, services: { rodentBait: true } };
  const setupLines = (est) => (est.lineItems || []).filter((i) => i.service === 'rodent_bait_setup');

  test('unthreaded input (saved-estimate replays, ungated callers) keeps the line; threaded suppression removes it', () => {
    expect(setupLines(generateEstimate({ ...baseInput })).length).toBe(1);
    expect(setupLines(generateEstimate({ ...baseInput, suppressRodentBaitSetupLine: true })).length).toBe(0);
  });

  test('commercial keeps its setup line regardless — outside the unified residential rule', () => {
    const commercial = generateEstimate({
      ...baseInput,
      isCommercial: true,
      propertyType: 'commercial',
      suppressRodentBaitSetupLine: true,
    });
    expect(setupLines(commercial).length).toBe(1);
  });
});

describe('converter: a frozen unified quote is authoritative both ways', () => {
  const { shouldIncludeWaveGuardSetupFeeForRecurring } = require('../services/estimate-converter');
  const bundle = [{ service: 'pest_control' }, { service: 'lawn_care' }];

  test('positive frozen unified bills on ANY mix; zero frozen unified never bills; operator waiver outranks', () => {
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: bundle,
      estimateData: { setupFeeQuote: { kind: 'unified', amount: 99 } },
    })).toBe(true);
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: bundle,
      estimateData: { setupFeeQuote: { kind: 'unified', amount: 0, waived: 'existing_customer' } },
    })).toBe(false);
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: bundle,
      estimateData: {
        setupFeeQuote: { kind: 'unified', amount: 99 },
        operatorPriceAdjustment: { waiveSetupFee: true },
      },
    })).toBe(false);
    // A tier-snapshot "existing customer" does NOT override the frozen
    // unified decision (decide-once — the quote already settled it).
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({
      recurringServices: bundle,
      estimateData: {
        setupFeeQuote: { kind: 'unified', amount: 99 },
        membershipSnapshot: { isExistingCustomer: true },
      },
    })).toBe(true);
    // No frozen quote → legacy rules unchanged (bundle carries nothing).
    expect(shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: bundle, estimateData: {} })).toBe(false);
  });
});

describe('decide-once enforcement on the billing/handoff paths (pre-push audit P0s)', () => {
  const fs = require('fs');
  const path = require('path');

  test('prepay accepts CHARGE a frozen positive unified fee — its line rides the prepay invoice, and the "setup fee waived" copy never fires beside it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-converter.js'), 'utf8');
    // The fee line rides the SAME InvoiceService.create lineItems array as
    // the rodent setup line, gated on the frozen unified quote + the
    // operator waiver.
    expect(src).toMatch(/prepayUnifiedSetupAmount = prepayUnifiedQuote\?\.kind === 'unified'[\s\S]{0,200}estimateOperatorSetupFeeWaived\(estimateData\)/);
    expect(src).toMatch(/prepayUnifiedSetupAmount > 0 \? \[\{\s*description: 'Setup Fee — one-time \(billed with prepay\)'/);
    // Copy: a riding fee suppresses the waiver claim in description AND notes.
    expect(src).toMatch(/prepayUnifiedSetupAmount > 0\s*\n\s*\/\/ The unified fee rides this invoice — never claim a waiver\./);
    expect(src).toMatch(/one-time setup fee billed with the prepay\./);
  });

  test('self-booking never re-waives a positive unified decision via the legacy member check (decide-once)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
    expect(src).toMatch(/if \(activeMember && !rodentSetupQuote && !unifiedSetupQuote\) \{/);
    // The zero-decision branch bails before any lapse re-derivation too.
    expect(src).toMatch(/setupFeeQuote\?\.kind === 'unified'\) return;/);
  });
});
