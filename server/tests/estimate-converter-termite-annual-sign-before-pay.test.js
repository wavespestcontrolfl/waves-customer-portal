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
    jest.dontMock('../services/estimate-offer-version');
  });

  function makeDb(recurringServices, { annualTotal = 250, estimateUpdate, priorActivationStatus = null, priorDeferredInvoice = null } = {}) {
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
    priorActivationStatus = null,
    priorDeferredInvoice = null,
    hasDeliveredOffer = false,
  } = {}) {
    const db = makeDb(recurringServices, { annualTotal, estimateUpdate, priorActivationStatus, priorDeferredInvoice });
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
    // defer (estimate-offer-version.js's own annualPlanPublicReplayBlocked
    // reasons the same way). Mocked here rather than computing a real
    // fingerprint — this suite only needs to prove the converter CONSULTS
    // this persisted-evidence check, not re-verify its own cryptographic
    // fingerprinting (covered by estimate-offer-version's own tests).
    jest.doMock('../services/estimate-offer-version', () => ({
      annualPlanHasDeliveredOffer: jest.fn(() => hasDeliveredOffer),
    }));

    const EstimateConverter = require('../services/estimate-converter');
    return { EstimateConverter, invoiceService, renewals, warn, db, estimateUpdate };
  }

  const convertOpts = { billingTerm: 'prepay_annual', skipAutoSchedule: true };
  const termiteAnnualLine = [{ service: 'termite_bait', name: 'Termite Bait', frequency: 'annual', visitsPerYear: 1 }];

  test('annual-plan estimate + gate on: defers — createTermForAnnualPrepay and the invoice are never called, and the estimate is stamped awaiting_signature with a deferred-invoice snapshot', async () => {
    const { EstimateConverter, invoiceService, renewals, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.create).not.toHaveBeenCalled();
    expect(estimateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ annual_plan_activation_status: 'awaiting_signature' }),
    );
    const call = estimateUpdate.mock.calls[0][0];
    expect(typeof call.annual_plan_deferred_invoice).toBe('string');
    const snapshot = JSON.parse(call.annual_plan_deferred_invoice);
    // Codex P1-2: the snapshot is computed with the SAME resolvers the
    // ordinary (non-deferred) prepay_annual branch uses — never re-derived
    // later at activation. Structural checks here (not a hardcoded amount)
    // because the exact figure depends on WaveGuard/discount resolution
    // this test isn't pinning; the "gate off" sibling test below proves the
    // resolvers still run identically either way.
    expect(snapshot.amountCents).toBeGreaterThan(0);
    expect(snapshot.setupFeeCents).toBe(0); // no rodent bait setup on this estimate
    expect(Array.isArray(snapshot.lines)).toBe(true);
    expect(snapshot.lines.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.title).toMatch(/Annual Prepay/);
    expect(snapshot.resolvedBy).toBe('estimate-converter:prepay_annual');
  });

  test('codex P1-1: already activated (replay / retry / manual re-run) — skips the deferral entirely, never recreates the term/invoice, and never resets the status', async () => {
    const estimateUpdate = jest.fn().mockResolvedValue(1);
    const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
      gateOn: true,
      estimateUpdate,
      priorActivationStatus: 'activated',
    });

    // No throw anywhere in this path — the deferral branch no-ops in JS
    // (no DB write at all) and the rest of the accept completes normally.
    await EstimateConverter.convertEstimate('estimate-1', convertOpts);

    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.create).not.toHaveBeenCalled();
    const activationStampCalls = estimateUpdate.mock.calls.filter(
      (call) => call[0] && Object.hasOwn(call[0], 'annual_plan_activation_status'),
    );
    expect(activationStampCalls.length).toBe(0);
  });

  test('pre-push P1: re-run while still awaiting_signature keeps the ORIGINAL deferred snapshot — no re-snapshot at current pricing, no term, no invoice', async () => {
    const estimateUpdate = jest.fn().mockResolvedValue(1);
    const original = { amountCents: 48000, setupFeeCents: 90000, lines: [{ description: 'orig', quantity: 1, unit_price: 480 }], at: '2026-09-01T00:00:00.000Z' };
    const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, {
      gateOn: true,
      estimateUpdate,
      priorActivationStatus: 'awaiting_signature',
      priorDeferredInvoice: original,
    });

    await EstimateConverter.convertEstimate('estimate-1', convertOpts);

    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.create).not.toHaveBeenCalled();
    const snapshotWrites = estimateUpdate.mock.calls.filter(
      (call) => call[0] && Object.hasOwn(call[0], 'annual_plan_deferred_invoice'),
    );
    expect(snapshotWrites.length).toBe(0);
  });

  test('gate off: an otherwise-annual-plan estimate converts through the ordinary prepay path unchanged', async () => {
    const { EstimateConverter, invoiceService, renewals } = setup(termiteAnnualLine, { gateOn: false });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
    expect(invoiceService.create).toHaveBeenCalled();
  });

  test('codex P0: gate OFF but the offer was already DELIVERED to the customer — still defers (persisted evidence beats the live gate)', async () => {
    const { EstimateConverter, invoiceService, renewals, estimateUpdate } = setup(termiteAnnualLine, {
      gateOn: false,
      hasDeliveredOffer: true,
    });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    // Never reached the ordinary (non-deferred) branch at all.
    expect(renewals.createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(invoiceService.create).not.toHaveBeenCalled();
    expect(estimateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ annual_plan_activation_status: 'awaiting_signature' }),
    );
  });

  test('codex P0: gate off AND no delivered-offer stamp — the persisted-evidence check alone does not defer (only a real prior delivery does)', async () => {
    const { EstimateConverter, renewals } = setup(termiteAnnualLine, {
      gateOn: false,
      hasDeliveredOffer: false,
    });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('Annual prepay term was not created');

    expect(renewals.createTermForAnnualPrepay).toHaveBeenCalled();
  });

  test('codex P1: the annual plan setup fee (service termite_bait_installation, kind setup — NOT the rodent bait resolver) rides its own snapshot line', async () => {
    const annualPlanRows = [
      { plan: 'annual_protection', service: 'termite_bait', annual: 250 },
      {
        service: 'termite_bait_installation', name: 'Station Setup', price: 199, kind: 'setup',
      },
    ];
    const { EstimateConverter, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true, annualPlanRows });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    const snapshot = JSON.parse(estimateUpdate.mock.calls[0][0].annual_plan_deferred_invoice);
    expect(snapshot.setupFeeCents).toBe(19900);
    expect(snapshot.lines).toContainEqual(expect.objectContaining({ description: 'Station Setup', unit_price: 199 }));
    expect(snapshot.lines.length).toBe(2);
  });

  test('codex P1: no setup row on the estimate — setupFeeCents stays 0 and no setup line is added', async () => {
    const annualPlanRows = [{ plan: 'annual_protection', service: 'termite_bait', annual: 250 }];
    const { EstimateConverter, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true, annualPlanRows });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    const snapshot = JSON.parse(estimateUpdate.mock.calls[0][0].annual_plan_deferred_invoice);
    expect(snapshot.setupFeeCents).toBe(0);
    expect(snapshot.lines.length).toBe(1);
  });

  test('codex P1: taxRate freezes to an explicit 0 (never null) in the snapshot for a no-tax residential accept', async () => {
    const { EstimateConverter, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    const snapshot = JSON.parse(estimateUpdate.mock.calls[0][0].annual_plan_deferred_invoice);
    expect(snapshot.taxRate).toBe(0);
  });

  test('codex P1: the accepted termStartDate rides in the snapshot for activation to use as the term start', async () => {
    const { EstimateConverter, estimateUpdate } = setup(termiteAnnualLine, { gateOn: true });

    await expect(EstimateConverter.convertEstimate('estimate-1', convertOpts))
      .rejects.toThrow('stamp-forced-stop');

    const snapshot = JSON.parse(estimateUpdate.mock.calls[0][0].annual_plan_deferred_invoice);
    expect(Object.hasOwn(snapshot, 'termStartDate')).toBe(true);
  });

  test('fallback P1 (b): the guarded UPDATE affecting ZERO rows re-reads the row and reports its ACTUAL status, not a blind awaiting_signature', async () => {
    // A concurrent write (e.g. activation) landed between the read at the
    // top of convertEstimate and this UPDATE — the guard correctly refused
    // to overwrite it (0 rows affected). The converter must not then claim
    // 'awaiting_signature' for a write that never happened.
    const estimateUpdate = jest.fn().mockResolvedValue(0);
    const { EstimateConverter, db } = setup(termiteAnnualLine, { gateOn: true, estimateUpdate });
    // The re-read after a 0-row update goes through the SAME 'estimates'
    // table mock's .first() — already stubbed to resolve the fixture
    // estimate, whose annual_plan_activation_status is null by default in
    // this suite's makeDb. Point it at 'activated' to prove the converter
    // reports what it re-reads, not a hardcoded guess.
    const concurrentlyActivatedEstimate = {
      id: 'estimate-1', customer_id: 'customer-1', annual_plan_activation_status: 'activated',
    };
    // A single shared mock reused across every db('estimates') call — a
    // fresh jest.fn() built inside the mockImplementation factory below
    // would reset its call sequence on each invocation instead of
    // persisting "first call → original row, later calls → the re-read".
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
      .mockResolvedValue(concurrentlyActivatedEstimate); // every call after: the re-read
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
      if (table === 'activity_log') return { insert: jest.fn().mockResolvedValue([1]) };
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
