// Audit repro r2-estimate-conversion-money-1 (P0/money):
// Admin "Annual Prepay" accept of an ADD-ON estimate for an EXISTING monthly
// member is not refused. The public accept route refuses exactly this shape
// (estimate-public.js: "annual prepay is not available for existing customers")
// because the converter preserves billing_mode 'monthly_membership' while
// minting an annual_prepay_terms row; the pending term suppresses the monthly
// dues cron (billing-cron GUARD 5), and on payment the term stamp rewrites
// billing_mode to 'annual_prepay' (GUARD 3b) so the customer's OTHER live plan
// stops billing for the year while its visits complete unbilled.
//
// These tests assert the CORRECT behaviour (refuse / ineligible), so they FAIL
// on current code if the bug is real. Mocks copied from
// tests/estimate-manual-acceptance.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-converter', () => ({
  convertEstimate: jest.fn(),
  frozenRodentBaitSetupAmount: jest.fn(() => 0),
  recurringMixHasMembershipFeeService: (services = []) => {
    const keys = Array.from(new Set((Array.isArray(services) ? services : [])
      .map((s) => s && s.service).filter(Boolean)));
    return keys.length === 1 && ['pest_control', 'mosquito'].includes(keys[0]);
  },
  estimateOperatorSetupFeeWaived: () => false,
  estimateManualDiscountFloorBreachAcknowledged: () => false,
  resolveAnnualPrepayInvoiceTotal: jest.fn(() => ({ amount: 684, discount: 36, rate: 0.05 })),
  recurringServiceKey: jest.fn((svc) => svc?.service || null),
  resolveCommercialPrepayBaseRate: jest.fn(async () => 0.07),
  resolveCommercialPrepayTaxRate: jest.fn(() => 0.07),
  annualPrepayRecurringUnitCount: jest.fn((data) => (
    (data?.recurring?.services || data?.engineResult?.lineItems || []).length
  )),
  estimateHasCommercialOneTime: jest.fn(() => false),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateAccepted: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  ...jest.requireActual('../services/estimate-deposits'),
  pendingDepositCredit: jest.fn(async () => null),
}));
jest.mock('../routes/admin-customers', () => ({
  _private: { lockAndAssertNoAnnualPrepayOverlap: jest.fn().mockResolvedValue() },
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/proposal-win', () => ({
  ensureCustomerForProposalWin: jest.fn(),
  promoteLinkedCustomerForProposalWin: jest.fn(),
  flagProposalCustomerCommercialIfTaxable: jest.fn(),
  createProposalAcceptanceInvoice: jest.fn(),
}));

const {
  prepayBookingEligibility,
  markEstimateManuallyAccepted,
} = require('../services/estimate-manual-acceptance');

// Existing monthly member (active pest plan billed as monthly dues).
const existingMember = {
  id: 'customer-monthly',
  pipeline_stage: 'active_customer',
  billing_mode: 'monthly_membership',
  monthly_rate: 120,
  autopay_enabled: true,
  waveguard_tier: 'Silver',
};

// Add-on lawn estimate linked to that customer; the snapshot says existing.
function makeEstimate() {
  return {
    id: 'estimate-addon-lawn',
    status: 'sent',
    customer_id: existingMember.id,
    sent_at: '2026-09-01T12:00:00.000Z',
    accepted_at: null,
    declined_at: null,
    decline_reason: null,
    price_locked_at: null,
    archived_at: null,
    expires_at: null,
    monthly_total: '60.00',
    annual_total: '720.00',
    onetime_total: null,
    estimate_data: {
      recurring: {
        services: [{ service: 'lawn_care', name: 'Lawn Care', mo: 60, annual: 720, frequency: 'bimonthly', visitsPerYear: 6 }],
        grandTotal: 60,
        annualTotal: 720,
      },
      membershipSnapshot: { isExistingCustomer: true, existingServiceKeys: ['pest_control'], tierLabel: 'Silver' },
    },
  };
}

function makeDb(estimate) {
  const updates = [];
  const inserts = [];
  const database = jest.fn((table) => {
    const builder = {
      clause: null,
      where(clause) { if (typeof clause !== 'function') this.clause = clause; return this; },
      whereIn() { return this; },
      whereNull(column) { this.nullColumns = [...(this.nullColumns || []), column]; return this; },
      whereNotNull() { return this; },
      whereRaw() { return this; },
      orderBy() { return this; },
      forUpdate() { return this; },
      first: async () => {
        if (table === 'estimates') return estimate;
        if (table === 'customers') return existingMember;
        return null;
      },
      update(patch) {
        updates.push({ table, clause: this.clause, patch });
        const guardBlocked = table === 'estimates'
          && (this.nullColumns || []).some((column) => estimate[column] != null);
        const applied = { ...patch };
        if (applied.estimate_data && applied.estimate_data.__raw) {
          applied.estimate_data = JSON.stringify({ ...estimate.estimate_data, pricingAuthorityAtLock: 'NULL' });
        }
        const updated = { ...estimate, ...applied };
        return { returning: async () => (guardBlocked ? [] : [updated]) };
      },
      insert: async (row) => { inserts.push({ table, row }); return [row]; },
    };
    return builder;
  });
  database.fn = { now: () => 'NOW' };
  database.raw = jest.fn((sql) => ({ rows: [], __raw: String(sql) }));
  database.transaction = jest.fn(async (callback) => callback(database));
  return { database, updates, inserts };
}

// A customer row that does NOT preserve monthly membership on its own (so
// the live-customer half of the guard cannot be what catches the accept) —
// isolates the FROZEN-SNAPSHOT half of the guard for the race test below.
const nonPreservingCustomer = {
  id: 'customer-monthly',
  pipeline_stage: 'active_customer',
  billing_mode: 'annual_prepay',
  monthly_rate: 120,
};

// Simulates the two-read race the codex P1 flagged: markEstimateManuallyAccepted
// reads the estimate row TWICE before the prepay guard — once unlocked (to
// resolve customer_id / status / the comms lock) and once FOR UPDATE
// (freshLinkRow, for the call-linkage checks). Only the locked read is
// authoritative from that point on. `staleData` is what the unlocked reads
// return; `freshData` is what a concurrent write landed by the time the row
// is locked — exactly the shape the FOR UPDATE query in the source
// (`.forUpdate().first('estimate_data', 'archived_at')` on 'estimates') is
// used to distinguish, since it is the ONLY forUpdate() call on 'estimates'
// in this function.
function makeRacingDb(baseEstimate, staleData, freshData) {
  const database = jest.fn((table) => {
    let forUpdateCalled = false;
    const builder = {
      clause: null,
      where(clause) { if (typeof clause !== 'function') this.clause = clause; return this; },
      whereIn() { return this; },
      whereNull(column) { this.nullColumns = [...(this.nullColumns || []), column]; return this; },
      whereNotNull() { return this; },
      whereRaw() { return this; },
      orderBy() { return this; },
      forUpdate() { forUpdateCalled = true; return this; },
      first: async () => {
        if (table === 'estimates') {
          return { ...baseEstimate, estimate_data: forUpdateCalled ? freshData : staleData };
        }
        if (table === 'customers') return nonPreservingCustomer;
        return null;
      },
      update(patch) {
        const applied = { ...patch };
        const updated = { ...baseEstimate, estimate_data: freshData, ...applied };
        return { returning: async () => [updated] };
      },
      insert: async (row) => [row],
    };
    return builder;
  });
  database.fn = { now: () => 'NOW' };
  database.raw = jest.fn((sql) => ({ rows: [], __raw: String(sql) }));
  database.transaction = jest.fn(async (callback) => callback(database));
  return database;
}

describe('r2-estimate-conversion-money-1: annual prepay of an add-on for an existing monthly member', () => {
  test('prepayBookingEligibility reports the shape INELIGIBLE (public accept refuses it)', async () => {
    const result = await prepayBookingEligibility(makeEstimate());
    expect(result.eligible).toBe(false);
  });

  test('prepayBookingEligibility falls back to the LIVE customer row when the estimate has no (or a stale) membershipSnapshot (codex P2)', async () => {
    // An older estimate, or one built before computeMembershipContext ran /
    // before the customer became a member: no membershipSnapshot at all.
    // Without the live-row fallback this preflight would say eligible even
    // though the accept guard (which reads the live customer row) rejects,
    // letting the schedule-modal one-step flow book the appointment first.
    const noSnapshotEstimate = makeEstimate();
    delete noSnapshotEstimate.estimate_data.membershipSnapshot;
    const customerLookupDb = jest.fn((table) => ({
      where: () => ({ first: async () => (table === 'customers' ? existingMember : null) }),
    }));
    const result = await prepayBookingEligibility(noSnapshotEstimate, customerLookupDb);
    expect(result).toMatchObject({ eligible: false, reason: 'existing_customer' });
    expect(customerLookupDb).toHaveBeenCalledWith('customers');
  });

  test('prepayBookingEligibility stays eligible when the live row also does not preserve membership, and a lookup failure fails OPEN to the ordinary checks (not a hard error)', async () => {
    const noSnapshotEstimate = makeEstimate();
    delete noSnapshotEstimate.estimate_data.membershipSnapshot;
    const freshCustomerDb = jest.fn(() => ({
      where: () => ({ first: async () => ({ id: 'cust-brand-new', pipeline_stage: 'new_lead', monthly_rate: 0, billing_mode: null }) }),
    }));
    // Not an existing member on the live row either — normal eligibility
    // checks proceed (this estimate lacks recurring rows in the shape those
    // checks expect, so it lands on a different ineligible reason, not
    // 'existing_customer').
    const result = await prepayBookingEligibility(noSnapshotEstimate, freshCustomerDb);
    expect(result.reason).not.toBe('existing_customer');

    const throwingDb = jest.fn(() => { throw new Error('connection reset'); });
    await expect(prepayBookingEligibility(noSnapshotEstimate, throwingDb)).resolves.toMatchObject({});
  });

  test('markEstimateManuallyAccepted(prepay_annual) is refused with 400 and never converts', async () => {
    const estimate = makeEstimate();
    const { database } = makeDb(estimate);
    const estimateConverter = {
      convertEstimate: jest.fn().mockResolvedValue({
        customerId: existingMember.id,
        billingTerm: 'prepay_annual',
        draftInvoiceId: 'invoice-addon-prepay',
      }),
    };
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };

    await expect(markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-1',
      source: 'verbal_annual_prepay',
      billingTerm: 'prepay_annual',
      database,
      leadLinkService,
      estimateConverter,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('a membershipSnapshot that flips to isExistingCustomer between the unlocked read and the FOR UPDATE re-read is still caught (codex P1)', async () => {
    const base = makeEstimate();
    // The UNLOCKED reads (initial select + the comms-lock loop's re-read)
    // see NO membership story yet — the snapshot had not been computed when
    // this transaction started.
    const staleData = { ...base.estimate_data, membershipSnapshot: undefined };
    delete staleData.membershipSnapshot;
    // A concurrent save lands between those unlocked reads and the FOR
    // UPDATE re-read, freezing the snapshot the way computeMembershipContext
    // would for this exact add-on.
    const freshData = { ...base.estimate_data, membershipSnapshot: { isExistingCustomer: true, existingServiceKeys: ['pest_control'], tierLabel: 'Silver' } };
    const database = makeRacingDb(base, staleData, freshData);
    const estimateConverter = {
      convertEstimate: jest.fn().mockResolvedValue({
        customerId: existingMember.id,
        billingTerm: 'prepay_annual',
        draftInvoiceId: 'invoice-addon-prepay',
      }),
    };
    const leadLinkService = { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() };

    await expect(markEstimateManuallyAccepted({
      estimateId: base.id,
      adminUserId: 'admin-1',
      source: 'verbal_annual_prepay',
      billingTerm: 'prepay_annual',
      database,
      leadLinkService,
      estimateConverter,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(estimateConverter.convertEstimate).not.toHaveBeenCalled();
  });
});
