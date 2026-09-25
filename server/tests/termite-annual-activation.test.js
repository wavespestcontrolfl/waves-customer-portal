// termite-annual-activation.js — completes the deferred annual-prepay term
// + invoice for a just-signed termite annual agreement (slice 3a). Mocked
// knex: activateTermiteAnnualPlanForSignedContract opens its own
// transaction via `conn.transaction`, so the mock `conn` here plays that
// role directly.
describe('termite annual plan activation on sign', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('../services/logger');
    jest.dontMock('../services/notification-service');
    jest.dontMock('../services/estimate-deposits');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
    jest.dontMock('../services/estimate-converter');
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

  // Codex P1-2: activation bills exactly this snapshot — never re-derives
  // from the estimate's raw pricing data. Mirrors what
  // estimate-converter.js's prepay_annual branch actually writes.
  function makeSnapshot(overrides = {}) {
    return {
      amountCents: 30000,
      setupFeeCents: 0,
      lines: [{
        description: 'WaveGuard Bronze — 12 months prepaid', quantity: 1, unit_price: 300,
      }],
      title: 'WaveGuard Bronze — Annual Prepay (12 months)',
      notes: 'test snapshot',
      taxRate: null,
      monthlyRate: 25,
      resolvedBy: 'estimate-converter:prepay_annual',
      at: '2026-09-24T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeEstimate(overrides = {}) {
    return {
      id: ESTIMATE_ID,
      customer_id: 'customer-1',
      annual_plan_activation_status: 'awaiting_signature',
      annual_plan_deferred_invoice: makeSnapshot(),
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
    contract, estimate, invoiceResult = { id: 'invoice-1', total: 300 }, term = { id: 'term-1' },
    depositCredit = null, depositLockImpl, depositReadImpl,
    canAutoSend = true, deliveryImpl,
  } = {}) {
    const { trx, estimateUpdate, termUpdate } = makeTrx({ contract, estimate });
    const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
    const notifyAdmin = jest.fn().mockResolvedValue(true);
    const invoiceCreate = jest.fn().mockResolvedValue(invoiceResult);
    const createTermForAnnualPrepay = jest.fn().mockResolvedValue(term);
    const callOrder = [];
    const acquireEstimateDepositLedgerLock = jest.fn(depositLockImpl || (async () => { callOrder.push('lock'); }));
    const pendingDepositCredit = jest.fn(depositReadImpl || (async () => { callOrder.push('read'); return depositCredit; }));
    const consumeDepositCredit = jest.fn().mockResolvedValue(0);
    const sendViaSMSAndEmail = jest.fn(deliveryImpl || (async () => ({ ok: true, sms: { ok: true }, email: { ok: true } })));
    const canAutoSendDraftInvoice = jest.fn(() => canAutoSend);

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/estimate-deposits', () => ({
      acquireEstimateDepositLedgerLock, pendingDepositCredit, consumeDepositCredit,
    }));
    jest.doMock('../services/invoice', () => ({ create: invoiceCreate, sendViaSMSAndEmail }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay }));
    jest.doMock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice }));

    const { activateTermiteAnnualPlanForSignedContract, reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      activateTermiteAnnualPlanForSignedContract,
      reconcileTermiteAnnualActivations,
      conn,
      estimateUpdate,
      termUpdate,
      notifyAdmin,
      invoiceCreate,
      createTermForAnnualPrepay,
      acquireEstimateDepositLedgerLock,
      pendingDepositCredit,
      consumeDepositCredit,
      sendViaSMSAndEmail,
      canAutoSendDraftInvoice,
      callOrder,
    };
  }

  test('awaiting_signature: bills exactly the deferred snapshot, creates the term, stamps consent, and activates', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, invoiceCreate, createTermForAnnualPrepay,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ activated: true, termId: 'term-1', invoiceId: 'invoice-1' });
    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      title: 'WaveGuard Bronze — Annual Prepay (12 months)',
      lineItems: estimate.annual_plan_deferred_invoice.lines,
    }));
    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      sourceEstimateId: ESTIMATE_ID,
      prepayInvoiceId: 'invoice-1',
      prepayAmount: 300, // amountCents / 100 — the snapshot's own gross annual fee
      monthlyRate: 25, // taken from the snapshot, not recomputed
      coverageServiceType: 'Termite Bait',
      coverageVisitCount: 1,
      coverageCadence: 'annual',
    }));
    expect(termUpdate).toHaveBeenCalledWith({
      annual_plan_version: 'v3',
      renewal_charge_consent_at: contract.signed_at,
    });
    expect(estimateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      annual_plan_activation_status: 'activated',
    }));
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

  test('codex P1 (latest round, item 1): a delivery failure does not undo activation, rings a bell, and reports invoiceDelivery.ok=false', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, notifyAdmin,
    } = setup({
      contract, estimate, deliveryImpl: async () => { throw new Error('sms provider down'); },
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result.activated).toBe(true);
    expect(result.invoiceDelivery).toMatchObject({ ok: false, error: 'sms provider down' });
    expect(estimateUpdate).toHaveBeenCalledWith(expect.objectContaining({ annual_plan_activation_status: 'activated' }));
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ bell: true, dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:delivery_failed` }),
    );
  });

  test('codex P1 (latest round, item 1): a delivery outcome that resolves ok:false WITHOUT throwing still bells and reports failure', async () => {
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

  test('codex P1 (latest round, item 2): the activation-failure bell also carries a stable per-estimate dedupeKey', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, term: null, // forces "Annual prepay term was not created"
    });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ dedupeKey: `termite-annual-activation:${ESTIMATE_ID}:activation_error` }),
    );
  });

  test('codex P1-A: idempotent on re-run — a second call (already activated) never delivers again', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, sendViaSMSAndEmail, estimateUpdate } = setup({ contract, estimate });

    const first = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });
    expect(first.activated).toBe(true);
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);

    // Simulate the persisted state after the first call: the mocked
    // estimate row itself doesn't mutate, so flip it here the way the real
    // DB would have after the update above.
    estimate.annual_plan_activation_status = 'activated';

    const second = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });
    expect(second).toEqual({ skipped: 'activated' });
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1); // still just once
    expect(estimateUpdate).toHaveBeenCalledTimes(1); // no second write
  });

  test('codex P1: passes the snapshot termStartDate as termStart, so an already-scheduled visit stays inside coverage', async () => {
    const contract = makeContract();
    const snapshot = makeSnapshot({ termStartDate: '2026-08-15' });
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, createTermForAnnualPrepay } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({ termStart: '2026-08-15' }));
  });

  test('codex P1: no termStartDate in the snapshot passes termStart: null (falls back to today, same as the ordinary accept path would)', async () => {
    const contract = makeContract();
    const snapshot = makeSnapshot(); // no termStartDate
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, createTermForAnnualPrepay } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({ termStart: null }));
  });

  test('codex P1: taxRate is always passed to InvoiceService.create, defaulting to 0 (never omitted) when the snapshot has null', async () => {
    const contract = makeContract();
    const snapshot = makeSnapshot({ taxRate: null });
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, invoiceCreate } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({ taxRate: 0 }));
  });

  test('codex P1: an explicit non-zero snapshot taxRate is passed through verbatim', async () => {
    const contract = makeContract();
    const snapshot = makeSnapshot({ taxRate: 0.07 });
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, invoiceCreate } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({ taxRate: 0.07 }));
  });

  test('codex P1 (fallback round, item a): a signed contract with no resolvable source estimate id bells (deduped) instead of vanishing silently', async () => {
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

  test('codex P1 (item on ~96): delivery-failure bell copy says activation SUCCEEDED and names the invoice — never "activate by hand"', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, deliveryImpl: async () => { throw new Error('sms provider down'); },
    });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    const [, title, body] = notifyAdmin.mock.calls[0];
    expect(title).toMatch(/not delivered/i);
    expect(body).toMatch(/ACTIVATED/);
    expect(body).toMatch(/invoice #invoice-1/);
    // Never the generic activation-failure phrasing that would tell an
    // operator to (re-)activate something that already exists.
    expect(body).not.toMatch(/recheck after fixing, or activate it by hand/i);
    expect(body).not.toMatch(/awaiting signature/i);
  });

  test('codex P1 (item on ~96): the ordinary activation-failure bell copy is unchanged — still names "awaiting signature"', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, notifyAdmin } = setup({
      contract, estimate, term: null, // forces "Annual prepay term was not created"
    });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    const [, title, body] = notifyAdmin.mock.calls[0];
    expect(title).toMatch(/needs manual follow-up/i);
    expect(body).toMatch(/awaiting signature/i);
  });

  test('codex P1-2: setup fee + annual line both ride the one deferred invoice, billed verbatim', async () => {
    const contract = makeContract();
    const snapshot = makeSnapshot({
      amountCents: 30000,
      setupFeeCents: 15000,
      lines: [
        { description: 'WaveGuard Bronze — 12 months prepaid', quantity: 1, unit_price: 300 },
        { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 150 },
      ],
    });
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, invoiceCreate, createTermForAnnualPrepay } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      lineItems: [
        expect.objectContaining({ unit_price: 300 }),
        expect.objectContaining({ unit_price: 150, description: expect.stringContaining('Setup') }),
      ],
    }));
    // The coverage-slicing basis (prepayAmount) is the annual fee ALONE —
    // the setup line never dilutes per-visit coverage, matching the
    // converter's own accounting (setup money is not covered-visit money).
    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({ prepayAmount: 300 }));
  });

  test('codex P1-2: a discounted (WaveGuard net) amount in the snapshot is preserved verbatim, not re-derived', async () => {
    const contract = makeContract();
    // 5% prepay discount already baked into the snapshot at accept time —
    // activation must never recompute a different (undiscounted) figure.
    const snapshot = makeSnapshot({ amountCents: 62700, lines: [{ description: 'discounted line', quantity: 1, unit_price: 627 }] });
    const estimate = makeEstimate({ annual_plan_deferred_invoice: snapshot });
    const { activateTermiteAnnualPlanForSignedContract, conn, invoiceCreate, createTermForAnnualPrepay } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      lineItems: [expect.objectContaining({ unit_price: 627 })],
    }));
    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({ prepayAmount: 627 }));
  });

  test('codex P1-2: no deferred snapshot on an awaiting_signature estimate — bells and skips rather than guessing an amount', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_deferred_invoice: null });
    const {
      activateTermiteAnnualPlanForSignedContract, conn, invoiceCreate, createTermForAnnualPrepay, notifyAdmin, estimateUpdate,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'no_deferred_snapshot' });
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    expect(estimateUpdate).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ bell: true }),
    );
  });

  test('codex P1-2: a malformed snapshot (no lines) is treated the same as missing', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_deferred_invoice: { amountCents: 30000, lines: [] } });
    const { activateTermiteAnnualPlanForSignedContract, conn } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'no_deferred_snapshot' });
  });

  test('honors an explicit contract annual_plan_version over the v3 default', async () => {
    const contract = makeContract({ annual_plan_version: 'v4' });
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, termUpdate } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(termUpdate).toHaveBeenCalledWith(expect.objectContaining({ annual_plan_version: 'v4' }));
  });

  test('already activated: skips — no invoice, no term, no writes', async () => {
    const contract = makeContract();
    const estimate = makeEstimate({ annual_plan_activation_status: 'activated' });
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, invoiceCreate, createTermForAnnualPrepay,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ skipped: 'activated' });
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
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

  test('codex P1-3: acquires the deposit ledger lock BEFORE reading the pending credit', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn, callOrder, acquireEstimateDepositLedgerLock, pendingDepositCredit } = setup({ contract, estimate });

    await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(acquireEstimateDepositLedgerLock).toHaveBeenCalledWith(expect.anything(), ESTIMATE_ID);
    expect(pendingDepositCredit).toHaveBeenCalledWith(ESTIMATE_ID, expect.anything());
    expect(callOrder).toEqual(['lock', 'read']);
  });

  test('codex P1-3: a deposit-ledger read failure surfaces as skipped:error and leaves the estimate awaiting_signature (never silently swallowed)', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, invoiceCreate, notifyAdmin,
    } = setup({
      contract, estimate, depositReadImpl: async () => { throw new Error('ledger read failed'); },
    });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error', error: expect.stringContaining('ledger read failed') });
    expect(invoiceCreate).not.toHaveBeenCalled();
    expect(estimateUpdate).not.toHaveBeenCalled(); // never stamped 'activated'
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String), expect.objectContaining({ bell: true }),
    );
  });

  test('failure path (term creation fails): rings the admin bell, reports the error, and never stamps activated', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, notifyAdmin,
    } = setup({ contract, estimate, term: null });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toMatchObject({ skipped: 'error' });
    expect(result.error).toMatch(/Annual prepay term was not created/);
    expect(estimateUpdate).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate',
      expect.stringContaining('needs manual follow-up'),
      expect.stringContaining(CONTRACT_ID),
      expect.objectContaining({ bell: true }),
    );
  });

  test('never throws — a downstream error is caught and reported as a skip', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const { activateTermiteAnnualPlanForSignedContract, conn } = setup({
      contract, estimate, invoiceResult: null,
    });

    await expect(activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn }))
      .resolves.toMatchObject({ skipped: 'error' });
  });
});
