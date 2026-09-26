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
    jest.dontMock('../services/termite-annual-signature-charge');
    jest.dontMock('../routes/admin-customers');
    jest.dontMock('../routes/estimate-public');
    jest.dontMock('../services/new-recurring-welcome-sms');
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

  // Builds a fake knex callable, table-routed like a real knex instance, plus
  // spies for the update() calls the module makes on 'estimates' and
  // 'annual_prepay_terms'. estimateUpdate only records writes whose WHERE
  // actually matches the row (the pre-transaction attempt stamp is
  // conditioned on awaiting_signature). The same handle serves as both the
  // outer conn and the transaction.
  function makeTrx({ contract, estimate }) {
    const estimateUpdate = jest.fn().mockResolvedValue(1);
    const termUpdate = jest.fn().mockResolvedValue(1);
    const trx = jest.fn((table) => {
      if (table === 'customer_contracts') {
        return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(contract) };
      }
      if (table === 'estimates') {
        const filters = {};
        const nullColumns = [];
        const builder = {
          where: jest.fn((f) => { Object.assign(filters, f); return builder; }),
          whereNull: jest.fn((col) => { nullColumns.push(col); return builder; }),
          forUpdate: jest.fn(() => builder),
          first: jest.fn().mockResolvedValue(estimate),
          update: jest.fn(async (patch) => {
            const matches = Object.entries(filters).every(([k, v]) => k === 'id' || estimate[k] === v)
              && nullColumns.every((col) => estimate[col] == null);
            if (!matches) return 0;
            return estimateUpdate(patch);
          }),
        };
        return builder;
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
    chargeImpl,
    overlapImpl,
    notifyAdminImpl,
  } = {}) {
    const { trx, estimateUpdate, termUpdate } = makeTrx({ contract, estimate });
    const conn = trx;
    conn.transaction = jest.fn(async (cb) => cb(trx));
    const notifyAdmin = jest.fn(notifyAdminImpl || (async () => ({ id: 'notification-1', deduped: false })));
    const sendViaSMSAndEmail = jest.fn(deliveryImpl || (async () => ({ ok: true, sms: { ok: true }, email: { ok: true } })));
    const canAutoSendDraftInvoice = jest.fn(() => canAutoSend);
    // Default: mirrors a successful ordinary prepay_annual conversion —
    // mints an invoice+term and reports 'activated'.
    const convertEstimate = jest.fn(convertEstimateImpl || (async () => ({
      annualPlanActivationStatus: 'activated', draftInvoiceId: 'invoice-1', annualPrepayTermId: 'term-1',
    })));
    // Default: no enrolled method — the pay link goes out as before.
    const chargeAnnualInvoiceAtSignature = jest.fn(chargeImpl || (async () => ({ status: 'skipped', reason: 'no_enrolled_method', deliverPayLink: true })));
    const lockAndAssertNoAnnualPrepayOverlap = jest.fn(overlapImpl || (async () => undefined));
    const registerAcceptedEstimateAppointmentReminder = jest.fn().mockResolvedValue(null);
    const sendNewRecurringWelcome = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
    jest.doMock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice, convertEstimate }));
    jest.doMock('../services/termite-annual-signature-charge', () => ({ chargeAnnualInvoiceAtSignature }));
    jest.doMock('../routes/admin-customers', () => ({ _private: { lockAndAssertNoAnnualPrepayOverlap } }));
    jest.doMock('../routes/estimate-public', () => ({ registerAcceptedEstimateAppointmentReminder }));
    jest.doMock('../services/new-recurring-welcome-sms', () => ({ sendNewRecurringWelcome }));

    const { activateTermiteAnnualPlanForSignedContract, reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      activateTermiteAnnualPlanForSignedContract,
      reconcileTermiteAnnualActivations,
      conn,
      trx,
      estimateUpdate,
      termUpdate,
      notifyAdmin,
      sendViaSMSAndEmail,
      canAutoSendDraftInvoice,
      convertEstimate,
      chargeAnnualInvoiceAtSignature,
      lockAndAssertNoAnnualPrepayOverlap,
      registerAcceptedEstimateAppointmentReminder,
      sendNewRecurringWelcome,
    };
  }

  const deliveryFailedBell = expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:delivery_failed` });

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
      // The plan marker rides term creation (codex #4819 r7 P1).
      annualPlanVersion: 'v3',
    }));
    // convertEstimate ran on the SAME transaction handle this module opened.
    expect(typeof convertEstimate.mock.calls[0][1].database).toBe('function');
    expect(termUpdate).toHaveBeenCalledWith({
      annual_plan_version: 'v3',
      renewal_charge_consent_at: contract.signed_at,
    });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
  });

  test('codex round-3 P2: the activation-attempt stamp is committed on its own, BEFORE the conversion transaction opens', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const callOrder = [];
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, convertEstimate,
    } = setup({ contract, estimate });
    estimateUpdate.mockImplementation(async (patch) => {
      if (Object.hasOwn(patch, 'annual_plan_activation_attempted_at')) callOrder.push('attempt-stamp');
      return 1;
    });
    const openTransaction = conn.transaction.getMockImplementation();
    conn.transaction.mockImplementation(async (cb) => { callOrder.push('transaction'); return openTransaction(cb); });
    convertEstimate.mockImplementation(async () => {
      callOrder.push('convert');
      throw new Error('conversion blew up');
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(callOrder).toEqual(['attempt-stamp', 'transaction', 'convert']);
  });

  test('codex round-3 P1: takes the shared per-customer annual-prepay lock + overlap recheck (excluding this estimate) before converting', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, trx, lockAndAssertNoAnnualPrepayOverlap, convertEstimate,
    } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(lockAndAssertNoAnnualPrepayOverlap).toHaveBeenCalledWith(
      trx, 'customer-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), false, expect.any(String), ESTIMATE_ID,
    );
    expect(lockAndAssertNoAnnualPrepayOverlap.mock.invocationCallOrder[0])
      .toBeLessThan(convertEstimate.mock.invocationCallOrder[0]);
  });

  test('codex round-3 P1: overlapping coverage fails CLOSED — no conversion, no invoice, bell, estimate stays awaiting', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, convertEstimate, notifyAdmin, chargeAnnualInvoiceAtSignature, sendViaSMSAndEmail,
    } = setup({
      contract,
      estimate,
      overlapImpl: async () => {
        const err = new Error('overlap');
        err.annualPrepayOverlap = { error: 'Customer already has an annual prepay term through 2027-01-01.' };
        throw err;
      },
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(result.error).toMatch(/overlapping annual coverage/);
    expect(convertEstimate).not.toHaveBeenCalled();
    expect(chargeAnnualInvoiceAtSignature).not.toHaveBeenCalled();
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.stringContaining('needs manual follow-up'), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:activation_error` }),
    );
  });

  test('codex round-3 P1: deferred converter side effects are dispatched after the activation commits', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const reminderRow = { id: 'ss-2', service_type: 'Termite Bait', scheduled_date: '2026-10-10' };
    const welcomeSms = { customer: { id: 'customer-1' }, entryPoint: 'estimate_converter_welcome' };
    const tierUpgradeNotification = {
      type: 'estimate', title: 'Tier review', body: 'b', options: {},
    };
    const {
      activateTermiteAnnualPlanForSignedContract, conn, registerAcceptedEstimateAppointmentReminder, sendNewRecurringWelcome, notifyAdmin,
    } = setup({
      contract,
      estimate,
      convertEstimateImpl: async () => ({
        annualPlanActivationStatus: 'activated',
        draftInvoiceId: 'invoice-1',
        annualPrepayTermId: 'term-1',
        deferredFollowUpReminderRows: [reminderRow],
        welcomeSms,
        tierUpgradeNotification,
      }),
    });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(registerAcceptedEstimateAppointmentReminder).toHaveBeenCalledWith({
      appointment: reminderRow, customerId: 'customer-1', serviceType: 'Termite Bait',
    });
    expect(sendNewRecurringWelcome).toHaveBeenCalledWith(welcomeSms);
    expect(notifyAdmin).toHaveBeenCalledWith('estimate', 'Tier review', 'b', {});
  });

  test('item 3: nothing is booked before signature — activation bells staff to schedule, naming the customer\'s accept-time pick', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({
      annual_plan_deferred_invoice: makeAcceptContext({ requestedFirstVisit: { date: '2026-10-14', windowStart: '09:00:00' } }),
    });
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('schedule the installation'),
      expect.stringContaining('2026-10-14 (09:00 window)'),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:schedule_first_visit` }),
    );
  });

  test('codex round-4 P1: the install handoff is stamped durable only once notifyAdmin records the bell', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(estimateUpdate).toHaveBeenCalledWith({ annual_plan_install_handoff_at: expect.any(Date) });
  });

  test('codex round-4 P1: a scheduling bell that does not durably land leaves the handoff unstamped for the sweep — activation still completes', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate } = setup({
      contract,
      estimate,
      // notifyAdmin returns null when its dedupe transaction fails; the
      // other bells fail too, which must not matter here.
      notifyAdminImpl: async () => null,
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ activated: true });
    expect(estimateUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ annual_plan_install_handoff_at: expect.anything() }));
  });

  test('owner ruling 2026-09-25: a successful signature charge sends NO pay link', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, sendViaSMSAndEmail, chargeAnnualInvoiceAtSignature,
    } = setup({ contract, estimate, chargeImpl: async () => ({ status: 'paid', reason: null, deliverPayLink: false }) });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn, trigger: 'signature' });

    expect(chargeAnnualInvoiceAtSignature).toHaveBeenCalledWith(expect.objectContaining({
      estimateId: ESTIMATE_ID, contractId: CONTRACT_ID, invoiceId: 'invoice-1', trigger: 'signature',
    }));
    expect(result.signatureCharge).toMatchObject({ status: 'paid' });
    expect(result.invoiceDelivery).toBeNull();
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('owner ruling 2026-09-25: an ambiguous signature charge sends NO pay link either', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, sendViaSMSAndEmail } = setup({
      contract, estimate, chargeImpl: async () => ({ status: 'ambiguous', reason: 'STRIPE_AMBIGUOUS_OUTCOME', deliverPayLink: false }),
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
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
    expect(notifyAdmin).not.toHaveBeenCalledWith('estimate', expect.any(String), expect.any(String), deliveryFailedBell);
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
    // Only the first run's two writes (the attempt stamp and the install
    // handoff stamp) — no write of any kind for the already-activated
    // re-run.
    expect(estimateUpdate).toHaveBeenCalledTimes(2);
    expect(estimateUpdate).toHaveBeenLastCalledWith({ annual_plan_install_handoff_at: expect.any(Date) });
  });

  test('an empty/missing accept-context replays no accept opts (the converter decides, failing closed on a missing frozen price)', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_deferred_invoice: null });
    const { activateTermiteAnnualPlanForSignedContract, conn, convertEstimate } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(convertEstimate).toHaveBeenCalledWith(ESTIMATE_ID, expect.objectContaining({
      activationRun: true,
      billingTerm: 'prepay_annual',
    }));
    // Absent accept opts are left out entirely (the converter's own
    // frozen-price check is what fails a snapshot-less activation closed).
    expect(convertEstimate.mock.calls[0][1]).not.toHaveProperty('prepayInvoiceAmount');
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

  test('slice 3b: signature_expired (offer closed, never signed) skips before ever calling convertEstimate — same posture as already-activated', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_activation_status: 'signature_expired' });
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, convertEstimate,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'signature_expired' });
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
