// AUDIT REPRO r1-estimates-1 — admin "Mark Won" (verbal yes) / "Annual Prepay"
// queues the new-recurring welcome SMS + email twin even though the admin
// confirm dialog (client/src/pages/admin/EstimatesPageV2.jsx:1795, :1826)
// promises "The customer is NOT texted" / "NOT texted, NOT emailed".
//
// These tests assert the EXPECTED behaviour (no welcome enqueue from a
// manual stamp). They FAIL on current code if the bug is real.
//
// Setup copied from server/tests/estimate-manual-acceptance.test.js.
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
  resolveAnnualPrepayInvoiceTotal: jest.fn(() => ({ amount: 627, discount: 33, rate: 0.05 })),
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
// Post-commit helpers the service lazy-requires; stubbed so the unit test
// never touches the DB.
jest.mock('../routes/estimate-public', () => ({
  ...jest.requireActual('../routes/estimate-public'),
  transferGroupFollowupOwnership: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/estimate-property-linkage', () => ({ linkAcceptedEstimateProperty: jest.fn().mockResolvedValue() }));
jest.mock('../services/termite-program-agreement', () => ({ maybeCreateTermiteProgramAgreement: jest.fn().mockResolvedValue() }));
// The welcome queue — the thing the dialog says will NOT happen.
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn().mockResolvedValue({ queued: true }),
}));

const { sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');
const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');

function makeDb(estimate) {
  const updates = [];
  const inserts = [];
  const database = jest.fn((table) => {
    const builder = {
      clause: null,
      where(clause) { if (typeof clause === 'function') return this; this.clause = clause; return this; },
      whereIn() { return this; },
      whereNull(column) { this.nullColumns = [...(this.nullColumns || []), column]; return this; },
      whereRaw() { return this; },
      forUpdate() { return this; },
      first: async () => (table === 'estimates' ? estimate : null),
      update(patch) {
        updates.push({ table, patch });
        const guardBlocked = table === 'estimates'
          && (this.nullColumns || []).some((column) => estimate[column] != null);
        const applied = { ...patch };
        if (applied.estimate_data && applied.estimate_data.__raw) {
          let prior = {};
          try { prior = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data || '{}') : (estimate.estimate_data || {}); } catch { prior = {}; }
          applied.estimate_data = JSON.stringify({ ...prior, pricingAuthorityAtLock: String(estimate.pricing_authority || 'NULL').toUpperCase() });
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

// What the real converter returns for a genuinely-new residential recurring
// customer under skipAutoSchedule (estimate-converter.js:7670): welcomeSms
// is built whenever opts.skipWelcomeSms !== true, with a null
// scheduledServiceId because nothing was booked.
const welcomeSmsPayload = {
  customer: { id: 'customer-1', first_name: 'Pat', last_name: 'Doe', phone: '+19415550100' },
  scheduledServiceId: null,
  recurringPattern: 'quarterly',
  entryPoint: 'estimate_converter_welcome',
};

function residentialRecurringEstimate(id) {
  return {
    id,
    status: 'viewed',
    customer_id: 'customer-1',
    sent_at: '2026-09-10T12:00:00.000Z',
    monthly_total: '55.00',
    annual_total: '660.00',
    onetime_total: '0.00',
    estimate_data: JSON.stringify({
      recurring: { services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly' }] },
    }),
  };
}

describe('AUDIT r1-estimates-1: manual accept must not queue customer welcome comms', () => {
  beforeEach(() => sendNewRecurringWelcome.mockClear());

  test('"Mark Won" (verbal_yes, standard term): dialog says NOT texted -> no welcome SMS/email enqueue', async () => {
    const estimate = residentialRecurringEstimate('estimate-verbal');
    const { database } = makeDb(estimate);
    const estimateConverter = {
      // Mirrors the real converter's contract (estimate-converter.js:7670):
      // welcomeSms is built only when opts.skipWelcomeSms !== true.
      convertEstimate: jest.fn(async (_id, opts) => ({
        customerId: 'customer-1',
        welcomeSms: opts?.skipWelcomeSms === true ? null : welcomeSmsPayload,
      })),
    };

    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-1',
      source: 'verbal_yes',
      billingTerm: 'standard',
      database,
      leadLinkService: { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() },
      estimateConverter,
    });

    // Expected: nothing is queued for the customer (dialog: "NOT texted").
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
    // Expected: the manual stamp opts out of the welcome at the converter.
    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(
      estimate.id,
      expect.objectContaining({ skipWelcomeSms: true }),
    );
  });

  test('"Annual Prepay" (verbal_annual_prepay): dialog says NOT texted, NOT emailed -> no welcome enqueue', async () => {
    const estimate = residentialRecurringEstimate('estimate-prepay');
    const { database } = makeDb(estimate);
    const estimateConverter = {
      convertEstimate: jest.fn(async (_id, opts) => ({
        customerId: 'customer-1',
        draftInvoiceId: 'inv-prepay',
        welcomeSms: opts?.skipWelcomeSms === true ? null : welcomeSmsPayload,
      })),
    };

    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: 'admin-1',
      source: 'verbal_annual_prepay',
      billingTerm: 'prepay_annual',
      database,
      leadLinkService: { markLinkedLeadEstimateAccepted: jest.fn().mockResolvedValue() },
      estimateConverter,
    });

    // Expected: nothing is queued (dialog: "NOT texted, NOT emailed").
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
    expect(estimateConverter.convertEstimate).toHaveBeenCalledWith(
      estimate.id,
      expect.objectContaining({ skipWelcomeSms: true }),
    );
  });
});
