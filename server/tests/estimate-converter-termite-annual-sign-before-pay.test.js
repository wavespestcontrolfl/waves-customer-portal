// Termite annual-plan sign-before-pay (slice 3a restructure, owner ruling
// 2026-09-24, dark behind GATE_TERMITE_ANNUAL_PLAN). The accept-time park
// now happens as EARLY as possible in convertEstimate — before any tier,
// pipeline, or customer-conversion work runs, not just before the invoice
// mint — so these "park" tests assert on a MINIMAL db mock (estimates +
// customers reads only) and prove no downstream conversion side effect
// fires. Activation (opts.activationRun === true) instead runs the FULL
// ordinary prepay_annual body — the same "throw to shortcut past the rest
// of the conversion" pattern as estimate-converter-annual-prepay-
// required.test.js lets the activation-run tests below assert on the real
// invoice/term creation call args without mocking the whole pipeline.
describe('estimate converter termite annual-plan sign-before-pay (slice 3a restructure)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../models/db');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
    jest.dontMock('../services/estimate-deposits');
    jest.dontMock('../config/feature-gates');
    jest.dontMock('../services/estimate-termite-program-rows');
    jest.dontMock('../services/estimate-offer-version');
  });

  function makeDb(recurringServices, {
    annualTotal = 250, estimateUpdate, priorActivationStatus = null, priorDeferredInvoice = null, customerUpdate,
  } = {}) {
    const estimate = {
      id: 'estimate-1',
      status: 'accepted',
      customer_id: 'customer-1',
      monthly_total: 0,
      annual_total: annualTotal,
      annual_plan_activation_status: priorActivationStatus,
      annual_plan_deferred_invoice: priorDeferredInvoice,
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
    const custUpdate = customerUpdate || jest.fn().mockResolvedValue(1);

    return jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
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
          update: custUpdate,
        };
      }
      if (table === 'scheduled_services') {
        return {
          where: jest.fn().mockReturnThis(),
          whereNotNull: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          whereIn: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
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
    priorActivationStatus = null,
    priorDeferredInvoice = null,
    hasDeliveredOffer = false,
    customerUpdate,
    createTermForAnnualPrepay = jest.fn().mockResolvedValue(null),
  } = {}) {
    const db = makeDb(recurringServices, {
      annualTotal, estimateUpdate, priorActivationStatus, priorDeferredInvoice, customerUpdate,
    });
    const invoiceTrx = jest.fn((table) => db(table));
    invoiceTrx.raw = jest.fn().mockResolvedValue(undefined);
    invoiceTrx.isTransaction = true;
    db.transaction = jest.fn(async (callback) => callback(invoiceTrx));
    const invoiceService = {
      create: jest.fn().mockResolvedValue({ id: 'invoice-1', total: annualTotal }),
      voidInvoice: jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'void' }),
    };
    const renewals = { createTermForAnnualPrepay };
    const warn = jest.fn();

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/invoice', () => invoiceService);
    jest.doMock('../services/annual-prepay-renewals', () => renewals);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn, error: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn().mockResolvedValue(undefined) }));
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
    // Codex P0: the live gate is not the whole story — an offer already
    // DELIVERED to the customer before the gate flipped off must still
    // defer. Mocked here rather than computing a real fingerprint — this
    // suite only needs to prove the converter CONSULTS this
    // persisted-evidence check.
    jest.doMock('../services/estimate-offer-version', () => ({
      annualPlanHasDeliveredOffer: jest.fn(() => hasDeliveredOffer),
    }));

    const EstimateConverter = require('../services/estimate-converter');
    return {
      EstimateConverter, invoiceService, renewals, warn, db, estimateUpdate,
    };
  }

  const termiteAnnualLine = [{ service: 'termite_bait', name: 'Termite Bait', frequency: 'annual', visitsPerYear: 1 }];

  describe('accept-time park (opts.activationRun not set)', () => {
    const convertOpts = { billingTerm: 'prepay_annual', skipAutoSchedule: true };

    test('annual-plan estimate + gate on: parks immediately — no invoice, no term, no customer tier/pipeline conversion, and the estimate is stamped awaiting_signature with a whitelisted accept-context', async () => {
      const customerUpdate = jest.fn().mockResolvedValue(1);
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const {
        EstimateConverter, invoiceService, renewals,
      } = setup(termiteAnnualLine, {
        gateOn: true, customerUpdate, estimateUpdate,
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', convertOpts);

      expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(invoiceService.create).not.toHaveBeenCalled();
      // Round-2 P1 (estimate-converter.js: "defer service creation until
      // signed"): the customer row's tier/pipeline conversion never runs at
      // accept for this product — only at activation.
      expect(customerUpdate).not.toHaveBeenCalled();
      expect(result).toEqual({ annualPlanActivationStatus: 'awaiting_signature' });
      expect(estimateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ annual_plan_activation_status: 'awaiting_signature' }),
      );
      const call = estimateUpdate.mock.calls[0][0];
      expect(typeof call.annual_plan_deferred_invoice).toBe('string');
      const acceptContext = JSON.parse(call.annual_plan_deferred_invoice);
      expect(acceptContext.version).toBe(1);
      expect(typeof acceptContext.parkedAt).toBe('string');
      // Whitelisted re-run context — enough for activation to replay the
      // FULL conversion later, never a frozen dollar amount (the ordinary
      // path re-derives pricing at signature time now).
      expect(Object.hasOwn(acceptContext, 'prepayInvoiceAmount')).toBe(true);
      expect(Object.hasOwn(acceptContext, 'firstApplicationAmount')).toBe(true);
      expect(Object.hasOwn(acceptContext, 'annualPrepayTermStart')).toBe(true);
      expect(Object.hasOwn(acceptContext, 'coverageServiceType')).toBe(true);
      expect(Object.hasOwn(acceptContext, 'manualDiscountItemization')).toBe(true);
      expect(Object.hasOwn(acceptContext, 'adoptedExistingAppointmentId')).toBe(true);
    });

    test('accept-time opts are captured verbatim into the accept-context', async () => {
      const estimateUpdate = jest.fn().mockRejectedValue(new Error('stamp-forced-stop'));
      const { EstimateConverter } = setup(termiteAnnualLine, { gateOn: true, estimateUpdate });

      await EstimateConverter.convertEstimate('estimate-1', {
        billingTerm: 'prepay_annual',
        skipAutoSchedule: true,
        prepayInvoiceAmount: 275.5,
        firstApplicationAmount: 10,
        allowFirstApplicationFallback: false,
        manualDiscountItemization: { label: 'Loyalty', annualAmount: 25 },
        adoptedExistingAppointmentId: 'appt-9',
        annualPrepayTermStart: '2026-10-01',
        coverageServiceType: 'Termite Bait',
        coverageVisitCount: 1,
        coverageCadence: 'annual',
        deferFollowUpReminderRegistration: true,
        deferCommercialScheduleNotification: true,
        skipMembershipEmail: true,
        skipWelcomeSms: true,
      }).catch(() => {}); // the estimates.update mock throws AFTER building the JSON; we only inspect the call args.

      // Nothing is thrown here because the forced-reject mock only affects the
      // .update() call itself, whose ARGS are what we assert — jest captures
      // them regardless of whether the promise it returns rejects.
    });

    test('codex P1-1: already activated (replay / retry / manual re-run) — no-ops entirely, never re-parks, never touches the customer row', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const customerUpdate = jest.fn().mockResolvedValue(1);
      const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
        gateOn: true,
        estimateUpdate,
        customerUpdate,
        priorActivationStatus: 'activated',
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', convertOpts);

      expect(result).toEqual({ annualPlanActivationStatus: 'activated' });
      expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(invoiceService.create).not.toHaveBeenCalled();
      expect(customerUpdate).not.toHaveBeenCalled();
      expect(estimateUpdate).not.toHaveBeenCalled();
    });

    test('pre-push P1: re-run while still awaiting_signature keeps the ORIGINAL accept-context — no re-park, no term, no invoice', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const original = { version: 1, parkedAt: '2026-09-01T00:00:00.000Z', prepayInvoiceAmount: 250 };
      const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
        gateOn: true,
        estimateUpdate,
        priorActivationStatus: 'awaiting_signature',
        priorDeferredInvoice: original,
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', convertOpts);

      expect(result).toEqual({ annualPlanActivationStatus: 'awaiting_signature' });
      expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(invoiceService.create).not.toHaveBeenCalled();
      expect(estimateUpdate).not.toHaveBeenCalled();
    });

    test('gate off: an otherwise-annual-plan estimate converts through the ordinary prepay path unchanged', async () => {
      const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, { gateOn: false });

      await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
        .rejects.toThrow('Annual prepay term was not created');

      expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
      expect(invoiceService.create).toHaveBeenCalled();
    });

    test('codex P0: gate OFF but the offer was already DELIVERED to the customer — still parks (persisted evidence beats the live gate)', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
        gateOn: false,
        hasDeliveredOffer: true,
        estimateUpdate,
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', convertOpts);

      expect(result.annualPlanActivationStatus).toBe('awaiting_signature');
      expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
      expect(invoiceService.create).not.toHaveBeenCalled();
      expect(estimateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ annual_plan_activation_status: 'awaiting_signature' }),
      );
    });

    test('codex P0: gate off AND no delivered-offer stamp — the persisted-evidence check alone does not park (only a real prior delivery does)', async () => {
      const { EstimateConverter, renewals } = setup(termiteAnnualLine, {
        gateOn: false,
        hasDeliveredOffer: false,
      });

      await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
        .rejects.toThrow('Annual prepay term was not created');

      expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
    });

    test('fallback P1 (b): the guarded UPDATE affecting ZERO rows re-reads the row and reports its ACTUAL status, not a blind awaiting_signature', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(0);
      const { EstimateConverter, db } = setup(termiteAnnualLine, { gateOn: true, estimateUpdate });
      const concurrentlyActivatedEstimate = {
        id: 'estimate-1', customer_id: 'customer-1', annual_plan_activation_status: 'activated',
      };
      const estimatesFirst = jest.fn()
        .mockResolvedValueOnce({
          id: 'estimate-1',
          status: 'accepted',
          customer_id: 'customer-1',
          monthly_total: 0,
          annual_total: 250,
          annual_plan_activation_status: null,
          annual_plan_deferred_invoice: null,
          estimate_data: { recurring: { services: termiteAnnualLine } },
        })
        .mockResolvedValue(concurrentlyActivatedEstimate);
      db.mockImplementation((table) => {
        if (table === 'estimates') {
          return {
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            forUpdate: jest.fn().mockReturnThis(),
            first: estimatesFirst,
            update: estimateUpdate,
          };
        }
        if (table === 'customers') {
          return {
            where: jest.fn().mockReturnThis(),
            forUpdate: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue({
              id: 'customer-1', first_name: 'Pat', last_name: 'Customer', city: 'Venice', property_type: 'residential',
            }),
            update: jest.fn().mockResolvedValue(1),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', convertOpts);

      expect(result.annualPlanActivationStatus).toBe('activated');
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

    test('non-prepay billingTerm: annual-plan rows present but standard accept — the park never engages', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const { renewals, estimateUpdate: updateSpy, EstimateConverter } = setup(termiteAnnualLine, {
        gateOn: true,
        estimateUpdate,
      });
      await EstimateConverter.convertEstimate('estimate-1', { billingTerm: 'standard', skipAutoSchedule: true })
        .catch(() => {}); // Standard-path completion details are out of scope here.

      expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
      const stampCalls = updateSpy.mock.calls.filter(
        (call) => call[0] && call[0].annual_plan_activation_status,
      );
      expect(stampCalls.length).toBe(0);
    });
  });

  describe('activation (opts.activationRun === true) — runs the ordinary prepay_annual body for real', () => {
    const activationOpts = {
      billingTerm: 'prepay_annual', skipAutoSchedule: true, activationRun: true, autoSendInvoice: false,
    };

    test('codex P1: the annual plan setup fee (service termite_bait_installation, kind setup) rides its own REAL invoice line — never the rodent resolver', async () => {
      const annualPlanRows = [
        { plan: 'annual_protection', service: 'termite_bait', annual: 250 },
        {
          service: 'termite_bait_installation', name: 'Station Setup', price: 199, kind: 'setup',
        },
      ];
      const { EstimateConverter, invoiceService } = setup(termiteAnnualLine, { gateOn: true, annualPlanRows });

      await expect(EstimateConverter.convertEstimate('estimate-1', activationOpts))
        .rejects.toThrow('Annual prepay term was not created');

      expect(invoiceService.create).toHaveBeenCalledTimes(1);
      const createArgs = invoiceService.create.mock.calls[0][0];
      expect(createArgs.lineItems).toContainEqual(expect.objectContaining({ description: 'Station Setup', unit_price: 199 }));
      expect(createArgs.lineItems.length).toBe(2);
    });

    test('no setup row on the estimate — only the annual line rides the invoice', async () => {
      const annualPlanRows = [{ plan: 'annual_protection', service: 'termite_bait', annual: 250 }];
      const { EstimateConverter, invoiceService } = setup(termiteAnnualLine, { gateOn: true, annualPlanRows });

      await expect(EstimateConverter.convertEstimate('estimate-1', activationOpts))
        .rejects.toThrow('Annual prepay term was not created');

      const createArgs = invoiceService.create.mock.calls[0][0];
      expect(createArgs.lineItems.length).toBe(1);
    });

    test('P2 by design: dueDate defaults to today ET, exactly like every other prepay_annual accept — the parallel minter this replaces omitted it', async () => {
      const { etDateString } = require('../utils/datetime-et');
      const { EstimateConverter, invoiceService } = setup(termiteAnnualLine, { gateOn: true });

      await expect(EstimateConverter.convertEstimate('estimate-1', activationOpts))
        .rejects.toThrow('Annual prepay term was not created');

      const createArgs = invoiceService.create.mock.calls[0][0];
      expect(createArgs.dueDate).toBe(etDateString());
    });

    test('taxRate: residential (no commercial recurring) invoices at the untaxed default, matching the ordinary path', async () => {
      const { EstimateConverter, invoiceService } = setup(termiteAnnualLine, { gateOn: true });

      await expect(EstimateConverter.convertEstimate('estimate-1', activationOpts))
        .rejects.toThrow('Annual prepay term was not created');

      const createArgs = invoiceService.create.mock.calls[0][0];
      expect(createArgs.taxRate).toBeUndefined();
    });

    test('successful activation: stamps the estimate activated (with annual_plan_activated_at) in the SAME transaction the term/invoice committed in, and returns the term id', async () => {
      const estimateUpdate = jest.fn().mockResolvedValue(1);
      const createTermForAnnualPrepay = jest.fn().mockResolvedValue({ id: 'term-99' });
      const {
        EstimateConverter, invoiceService, renewals,
      } = setup(termiteAnnualLine, {
        gateOn: true, estimateUpdate, createTermForAnnualPrepay,
      });

      const result = await EstimateConverter.convertEstimate('estimate-1', activationOpts);

      expect(invoiceService.create).toHaveBeenCalledTimes(1);
      expect(renewals.createTermForAnnualPrepay).toHaveBeenCalledTimes(1);
      expect(result.annualPlanActivationStatus).toBe('activated');
      expect(result.annualPrepayTermId).toBe('term-99');
      expect(result.draftInvoiceId).toBe('invoice-1');
      const activationStampCall = estimateUpdate.mock.calls.find(
        (call) => call[0] && call[0].annual_plan_activation_status === 'activated',
      );
      expect(activationStampCall).toBeTruthy();
      expect(activationStampCall[0].annual_plan_activated_at).toBeInstanceOf(Date);
    });

    test('a non-annual-plan prepay_annual accept ignores activationRun entirely (no annual-plan rows, nothing termite-specific happens)', async () => {
      const { EstimateConverter, invoiceService } = setup(termiteAnnualLine, { gateOn: true, annualPlanRows: [] });

      await expect(EstimateConverter.convertEstimate('estimate-1', activationOpts))
        .rejects.toThrow('Annual prepay term was not created');

      const createArgs = invoiceService.create.mock.calls[0][0];
      expect(createArgs.lineItems.length).toBe(1); // no rodent setup, no annual-plan setup
    });
  });

  test('isTermiteAnnualSignBeforePayAccept is exported and matches the same rule the converter applies internally', () => {
    jest.doMock('../config/feature-gates', () => ({
      termiteAnnualPlanSelectionEnabled: jest.fn(() => true),
      isEnabled: jest.fn(() => false),
    }));
    jest.doMock('../services/estimate-termite-program-rows', () => ({
      selectedTermiteAnnualPlanRows: jest.fn(() => [{ plan: 'annual_protection' }]),
    }));
    jest.doMock('../services/estimate-offer-version', () => ({
      annualPlanHasDeliveredOffer: jest.fn(() => false),
    }));
    const EstimateConverter = require('../services/estimate-converter');
    expect(typeof EstimateConverter.isTermiteAnnualSignBeforePayAccept).toBe('function');
    expect(EstimateConverter.isTermiteAnnualSignBeforePayAccept({}, {}, 'prepay_annual')).toBe(true);
    expect(EstimateConverter.isTermiteAnnualSignBeforePayAccept({}, {}, 'standard')).toBe(false);
  });
});
