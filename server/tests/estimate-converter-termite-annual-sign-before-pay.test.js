// Termite annual-plan sign-before-pay deferral (slice 3a, owner ruling
// 2026-09-24, dark behind GATE_TERMITE_ANNUAL_PLAN). Follows the exact
// "throw to shortcut past the rest of the conversion" pattern used by
// estimate-converter-annual-prepay-required.test.js: forcing the estimates
// update mock to reject lets the assertions inspect exactly what happened
// up to (and including) the deferral decision without having to mock the
// whole remaining accept pipeline (welcome SMS, tier notifications, etc.).
describe('estimate converter termite annual-plan sign-before-pay deferral', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../models/db');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
    jest.dontMock('../services/estimate-deposits');
    jest.dontMock('../config/feature-gates');
    jest.dontMock('../services/estimate-termite-program-rows');
  });

  function makeDb(recurringServices, { annualTotal = 250, estimateUpdate } = {}) {
    const estimate = {
      id: 'estimate-1',
      status: 'accepted',
      customer_id: 'customer-1',
      monthly_total: 0,
      annual_total: annualTotal,
      estimate_data: {
        recurring: { services: recurringServices },
      },
    };
    const customer = {
      id: 'customer-1',
      first_name: 'Pat',
      last_name: 'Customer',
      city: 'Venice',
      property_type: 'residential',
    };

    return jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(estimate),
          update: estimateUpdate,
        };
      }
      if (table === 'customers') {
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(customer),
          update: jest.fn().mockResolvedValue(1),
        };
      }
      if (table === 'scheduled_services') {
        return {
          where: jest.fn().mockReturnThis(),
          whereNotNull: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          count: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ count: 0 }),
        };
      }
      if (table === 'activity_log') {
        return { insert: jest.fn().mockResolvedValue([1]) };
      }
      throw new Error(`Unexpected table ${table}`);
    });
  }

  function setup(recurringServices, {
    annualPlanRows = [{ plan: 'annual_protection', service: 'termite_bait', annual: 250 }],
    gateOn = true,
    annualTotal = 250,
    estimateUpdate = jest.fn().mockRejectedValue(new Error('stamp-forced-stop')),
  } = {}) {
    const db = makeDb(recurringServices, { annualTotal, estimateUpdate });
    const invoiceTrx = jest.fn((table) => db(table));
    invoiceTrx.raw = jest.fn().mockResolvedValue(undefined);
    invoiceTrx.isTransaction = true;
    db.transaction = jest.fn(async (callback) => callback(invoiceTrx));
    const invoiceService = {
      create: jest.fn().mockResolvedValue({ id: 'invoice-1' }),
      voidInvoice: jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'void' }),
    };
    const renewals = { createTermForAnnualPrepay: jest.fn().mockResolvedValue(null) };
    const warn = jest.fn();

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/invoice', () => invoiceService);
    jest.doMock('../services/annual-prepay-renewals', () => renewals);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn, error: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
    jest.doMock('../services/estimate-deposits', () => ({
      acquireEstimateDepositLedgerLock: jest.fn().mockResolvedValue(undefined),
      pendingDepositCredit: jest.fn().mockResolvedValue(null),
      consumeDepositCredit: jest.fn().mockResolvedValue(0),
    }));
    jest.doMock('../config/feature-gates', () => ({
      termiteAnnualPlanSelectionEnabled: jest.fn(() => gateOn),
      isEnabled: jest.fn(() => false),
    }));
    jest.doMock('../services/estimate-termite-program-rows', () => ({
      selectedTermiteAnnualPlanRows: jest.fn(() => annualPlanRows),
    }));

    const EstimateConverter = require('../services/estimate-converter');
    return { EstimateConverter, invoiceService, renewals, warn, db, estimateUpdate };
  }

  const convertOpts = { billingTerm: 'prepay_annual', skipAutoSchedule: true };
  const termiteAnnualLine = [{ service: 'termite_bait', name: 'Termite Bait', frequency: 'annual', visitsPerYear: 1 }];

  test('annual-plan estimate + gate on: defers — createTermForAnnualPrepay and the invoice are never called, and the estimate is stamped awaiting_signature', async () => {
    const { EstimateConverter, invoiceService, renewals, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.create).not.toHaveBeenCalled();
    expect(estimateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ annual_plan_activation_status: 'awaiting_signature' }),
    );
  });

  test('gate off: an otherwise-annual-plan estimate converts through the ordinary prepay path unchanged', async () => {
    const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, { gateOn: false });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
    expect(invoiceService.create).toHaveBeenCalled();
  });

  test('quarterly termite (not the annual plan): gate on but no annual-plan rows — ordinary prepay path unchanged', async () => {
    const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
      gateOn: true,
      annualPlanRows: [],
    });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
    expect(invoiceService.create).toHaveBeenCalled();
  });

  test('non-prepay billingTerm: annual-plan rows present but standard accept — deferral never engages', async () => {
    const estimateUpdate = jest.fn().mockResolvedValue(1);
    const { EstimateConverter, renewals, estimateUpdate: updateSpy } = setup(termiteAnnualLine, {
      gateOn: true,
      estimateUpdate,
    });
    // Standard billing term never reaches the prepay_annual branch at all,
    // so the deferral stamp must never be written from THIS code path.
    await EstimateConverter.convertEstimate('estimate-1', { billingTerm: 'standard', skipAutoSchedule: true })
      .catch(() => {}); // Standard-path completion details are out of scope here.

    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    const stampCalls = updateSpy.mock.calls.filter(
      (call) => call[0] && call[0].annual_plan_activation_status,
    );
    expect(stampCalls.length).toBe(0);
  });
});
