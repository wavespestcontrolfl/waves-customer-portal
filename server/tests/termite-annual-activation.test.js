// termite-annual-activation.js — completes the deferred conversion for a
// just-signed termite annual agreement (slice 3a restructure, round 2 of
// #4819) by re-invoking estimate-converter's convertEstimate with
// activationRun:true, rather than re-implementing invoice/term creation
// itself. Mocked knex: activateTermiteAnnualPlanForSignedContract opens its
// own transaction via `conn.transaction`, so the mock `conn` here plays
// that role directly. estimate-converter.js is mocked wholesale (its own
// exhaustive prepay_annual behavior is covered by
// estimate-converter-termite-annual-sign-before-pay.test.js) — this suite
// only proves termite-annual-activation.js's OWN responsibilities: the
// lock + idempotency gate, replaying the accept-context as opts, the
// consent stamp, delivery, and the admin bells.
describe('termite annual plan activation on sign', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../services/logger');
    jest.dontMock('../services/notification-service');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/estimate-converter');
    jest.dontMock('../services/invoice-helpers');
  });

  const CONTRACT_ID = 'contract-1';
  const ESTIMATE_ID = 'estimate-1';
  const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';

  function makeContract(overrides = {}) {
    return {
      id: CONTRACT_ID,
      status: 'signed',
      document_template_key: ANNUAL_TEMPLATE_KEY,
      signed_at: new Date('2026-09-24T12:00:00Z'),
      annual_plan_version: null,
      document_variables_snapshot: { estimate: { id: ESTIMATE_ID } },
      ...overrides,
    };
  }

  function makeAcceptContext(overrides = {}) {
    return {
      version: 1,
      parkedAt: '2026-09-20T00:00:00.000Z',
      prepayInvoiceAmount: 300,
      firstApplicationAmount: null,
      allowFirstApplicationFallback: true,
      manualDiscountItemization: null,
      adoptedExistingAppointmentId: null,
      annualPrepayTermStart: null,
      coverageServiceType: null,
      coverageVisitCount: null,
      coverageCadence: null,
      deferFollowUpReminderRegistration: true,
      deferCommercialScheduleNotification: true,
      skipMembershipEmail: true,
      skipWelcomeSms: false,
      ...overrides,
    };
  }

  function makeEstimate(overrides = {}) {
    return {
      id: ESTIMATE_ID,
      customer_id: 'customer-1',
      annual_plan_activation_status: 'awaiting_signature',
      annual_plan_deferred_invoice: makeAcceptContext(),
      estimate_data: {},
      ...overrides,
    };
  }

  // Builds a fake trx callable, table-routed like a real knex instance, plus
  // spies for the update() calls the module makes on 'estimates' and
  // 'annual_prepay_terms' so assertions can inspect exactly what was
  // written without a real database.
  function makeTrx({ contract, estimate }) {
    const estimateUpdate = jest.fn().mockResolvedValue(1);
    const termUpdate = jest.fn().mockResolvedValue(1);
    const trx = jest.fn((table) => {
      if (table === 'customer_contracts') {
        return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(contract) };
      }
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(estimate),
          update: estimateUpdate,
        };
      }
      if (table === 'annual_prepay_terms') {
        return { where: jest.fn().mockReturnThis(), update: termUpdate };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    return { trx, estimateUpdate, termUpdate };
  }

  function setup({
    contract, estimate,
    convertEstimateImpl,
    canAutoSend = true, deliveryImpl,
  } = {}) {
    const { trx, estimateUpdate, termUpdate } = makeTrx({ contract, estimate });
    const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
    const notifyAdmin = jest.fn().mockResolvedValue(true);
    const sendViaSMSAndEmail = jest.fn(deliveryImpl || (async () => ({ ok: true, sms: { ok: true }, email: { ok: true } })));
    const canAutoSendDraftInvoice = jest.fn(() => canAutoSend);
    // Default: mirrors a successful ordinary prepay_annual conversion —
    // mints an invoice+term and reports 'activated'.
    const convertEstimate = jest.fn(convertEstimateImpl || (async () => ({
      annualPlanActivationStatus: 'activated', draftInvoiceId: 'invoice-1', annualPrepayTermId: 'term-1',
    })));

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
    jest.doMock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice, convertEstimate }));

    const { activateTermiteAnnualPlanForSignedContract, reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      activateTermiteAnnualPlanForSignedContract,
      reconcileTermiteAnnualActivations,
      conn,
      estimateUpdate,
      termUpdate,
      notifyAdmin,
      sendViaSMSAndEmail,
      canAutoSendDraftInvoice,
      convertEstimate,
    };
  }

  test('awaiting_signature: replays the accept-context into convertEstimate with activationRun:true, stamps consent, and delivers', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, termUpdate, convertEstimate, sendViaSMSAndEmail,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ activated: true, termId: 'term-1', invoiceId: 'invoice-1' });
    expect(convertEstimate).toHaveBeenCalledWith(ESTIMATE_ID, expect.objectContaining({
      activationRun: true,
      billingTerm: 'prepay_annual',
      skipAutoSchedule: true,
      autoSendInvoice: false,
      prepayInvoiceAmount: 300,
      deferFollowUpReminderRegistration: true,
      deferCommercialScheduleNotification: true,
      skipMembershipEmail: true,
    }));
    // convertEstimate ran on the SAME transaction handle this module opened.
    expect(typeof convertEstimate.mock.calls[0][1].database).toBe('function');
    expect(termUpdate).toHaveBeenCalledWith({
      annual_plan_version: 'v3',
      renewal_charge_consent_at: contract.signed_at,
    });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
  });

  test('the activation-attempt stamp is written BEFORE convertEstimate runs', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const callOrder = [];
    const { trx } = makeTrx({ contract, estimate });
    // Wrap the estimates table mock to record write order.
    const originalTrx = trx.getMockImplementation();
    trx.mockImplementation((table) => {
      const built = originalTrx(table);
      if (table === 'estimates' && built.update) {
        const realUpdate = built.update;
        built.update = jest.fn((patch) => {
          if (patch && Object.hasOwn(patch, 'annual_plan_activation_attempted_at')) callOrder.push('attempt-stamp');
          return realUpdate(patch);
        });
      }
      return built;
    });
    const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
    const convertEstimate = jest.fn(async () => {
      callOrder.push('convert');
      return { annualPlanActivationStatus: 'activated', draftInvoiceId: 'invoice-1', annualPrepayTermId: 'term-1' };
    });
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue(true) }));
    jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn().mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } }) }));
    jest.doMock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice: jest.fn(() => true), convertEstimate }));
    const { activateTermiteAnnualPlanForSignedContract } = require('../services/termite-annual-activation');

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(callOrder).toEqual(['attempt-stamp', 'convert']);
  });

  test('codex P1-A: delivers the invoice via the SAME wrapper + gate the ordinary prepay_annual accept uses, exactly once', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, sendViaSMSAndEmail, canAutoSendDraftInvoice,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.invoiceDelivery).toEqual({ ok: true, sms: { ok: true }, email: { ok: true } });
    expect(canAutoSendDraftInvoice).toHaveBeenCalledWith({ billingTerm: 'prepay_annual', annualPrepayTermId: 'term-1' });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
    expect(sendViaSMSAndEmail).toHaveBeenCalledWith('invoice-1', expect.objectContaining({
      payUrlParams: expect.objectContaining({ billingTerm: 'prepay_annual', saveRequired: '1' }),
    }));
  });

  test('a delivery failure does not undo activation, rings a bell, and reports invoiceDelivery.ok=false', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin,
    } = setup({
      contract, estimate, deliveryImpl: async () => { throw new Error('sms provider down'); },
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(result.invoiceDelivery).toMatchObject({ ok: false, error: 'sms provider down' });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ bell: true, dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:delivery_failed` }),
    );
  });

  test('codex P2 (quiet hours): a queued (sms.scheduled:true) delivery outcome is treated as success — no bell', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, deliveryImpl: async () => ({ ok: false, sms: { ok: false, scheduled: true }, email: { ok: true } }),
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(result.invoiceDelivery).toMatchObject({ sms: { scheduled: true } });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a delivery outcome that resolves ok:false WITHOUT throwing still bells and reports failure', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, deliveryImpl: async () => ({ ok: false, error: 'payer_billed', sms: { ok: false }, email: { ok: false } }),
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(result.invoiceDelivery).toMatchObject({ ok: false, error: 'payer_billed' });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:delivery_failed` }),
    );
  });

  test('the activation-failure bell carries a stable per-estimate dedupeKey', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, convertEstimateImpl: async () => { throw new Error('Annual prepay term was not created'); },
    });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:activation_error` }),
    );
  });

  test('idempotent on re-run — a second call (already activated) never re-drives convertEstimate or delivers again', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, sendViaSMSAndEmail, estimateUpdate, convertEstimate } = setup({ contract, estimate });

    const first = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });
    expect(first.activated).toBe(true);
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);

    // Simulate the persisted state after the first call: the mocked
    // estimate row itself doesn't mutate, so flip it here the way the real
    // DB would have after convertEstimate's own 'activated' write.
    estimate.annual_plan_activation_status = 'activated';

    const second = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });
    expect(second).toEqual({ skipped: 'activated' });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1); // still just once
    expect(convertEstimate).toHaveBeenCalledTimes(1); // never re-driven
    // Only the attempt-stamp write from the first run — no second write of
    // any kind for the already-activated re-run.
    expect(estimateUpdate).toHaveBeenCalledTimes(1);
  });

  test('an empty/missing accept-context degrades to convertEstimate defaults rather than failing', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_deferred_invoice: null });
    const { activateTermiteAnnualPlanForSignedContract, conn, convertEstimate } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(convertEstimate).toHaveBeenCalledWith(ESTIMATE_ID, expect.objectContaining({
      activationRun: true,
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: undefined,
    }));
  });

  test('a malformed accept-context (not an object) degrades to convertEstimate defaults rather than failing', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_deferred_invoice: '{not json' });
    const { activateTermiteAnnualPlanForSignedContract, conn } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
  });

  test('honors an explicit contract annual_plan_version over the v3 default', async () => {
    const contract = makeContract({ annual_plan_version: 'v4' });
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, termUpdate } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(termUpdate).toHaveBeenCalledWith(expect.objectContaining({ annual_plan_version: 'v4' }));
  });

  test('a signed contract with no resolvable source estimate id bells (deduped) instead of vanishing silently', async () => {
    const contract = makeContract({ document_variables_snapshot: { estimate: {} } }); // no id
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({ contract, estimate: makeEstimate() });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'no_source_estimate' });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('no linked estimate'),
      expect.any(String),
      expect.objectContaining({ bell: true, dedupeKey: `termite-annual-activation:contract-${CONTRACT_ID}:no_source_estimate` }),
    );
  });

  test('already activated: skips before ever calling convertEstimate', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_activation_status: 'activated' });
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, convertEstimate,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'activated' });
    expect(convertEstimate).not.toHaveBeenCalled();
    expect(estimateUpdate).not.toHaveBeenCalled();
    expect(termUpdate).not.toHaveBeenCalled();
  });

  test('not the annual template: skips without touching the estimate', async () => {
    const contract = makeContract({ document_template_key: 'service_agreement.termite_bait_program_purchase' });
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'not_annual_template' });
    expect(estimateUpdate).not.toHaveBeenCalled();
  });

  test('failure path (convertEstimate throws): rings the admin bell, reports the error, and never stamps consent', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, termUpdate, notifyAdmin,
    } = setup({
      contract, estimate, convertEstimateImpl: async () => { throw new Error('Annual prepay term was not created'); },
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(result.error).toMatch(/Annual prepay term was not created/);
    expect(termUpdate).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('needs manual follow-up'),
      expect.stringContaining(CONTRACT_ID),
      expect.objectContaining({ bell: true }),
    );
  });

  test('defense in depth: convertEstimate resolving WITHOUT reaching activated is treated as a failure, never a silent success', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, termUpdate, notifyAdmin } = setup({
      contract, estimate, convertEstimateImpl: async () => ({ annualPlanActivationStatus: 'awaiting_signature' }),
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(termUpdate).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalled();
  });

  test('never throws — a downstream error is caught and reported as a skip', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn } = setup({
      contract, estimate, convertEstimateImpl: async () => { throw new Error('unexpected'); },
    });

    await expect(activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn }))
      .resolves.toMatchObject({ skipped: 'error' });
  });
});
