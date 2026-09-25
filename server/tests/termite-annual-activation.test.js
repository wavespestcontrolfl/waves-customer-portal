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
    jest.dontMock('../services/estimate-termite-program-rows');
    jest.dontMock('../services/estimate-deposits');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/annual-prepay-renewals');
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

  function makeEstimate(overrides = {}) {
    return {
      id: ESTIMATE_ID,
      customer_id: 'customer-1',
      annual_plan_activation_status: 'awaiting_signature',
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

  function setup({ contract, estimate, annualPlanRows = [{ service: 'termite_bait', plan: 'annual_protection', annual: 300 }], invoiceResult = { id: 'invoice-1', total: 300 }, term = { id: 'term-1' } } = {}) {
    const { trx, estimateUpdate, termUpdate } = makeTrx({ contract, estimate });
    const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
    const notifyAdmin = jest.fn().mockResolvedValue(true);
    const invoiceCreate = jest.fn().mockResolvedValue(invoiceResult);
    const createTermForAnnualPrepay = jest.fn().mockResolvedValue(term);

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/estimate-termite-program-rows', () => ({
      selectedTermiteAnnualPlanRows: jest.fn(() => annualPlanRows),
    }));
    jest.doMock('../services/estimate-deposits', () => ({
      pendingDepositCredit: jest.fn().mockResolvedValue(null),
      consumeDepositCredit: jest.fn().mockResolvedValue(0),
    }));
    jest.doMock('../services/invoice', () => ({ create: invoiceCreate }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay }));

    const { activateTermiteAnnualPlanForSignedContract } = require('../services/termite-annual-activation');
    return {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, notifyAdmin, invoiceCreate, createTermForAnnualPrepay,
    };
  }

  test('awaiting_signature: creates the invoice + term, stamps consent, and activates', async () => {
    const contract = makeContract();
    const estimate = makeEstimate();
    const {
      activateTermiteAnnualPlanForSignedContract, conn, estimateUpdate, termUpdate, invoiceCreate, createTermForAnnualPrepay,
    } = setup({ contract, estimate });

    const result = await activateTermiteAnnualPlanForSignedContract({ contractId: CONTRACT_ID, conn });

    expect(result).toEqual({ activated: true, termId: 'term-1', invoiceId: 'invoice-1' });
    expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      lineItems: [expect.objectContaining({ unit_price: 300 })],
    }));
    expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      sourceEstimateId: ESTIMATE_ID,
      prepayInvoiceId: 'invoice-1',
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
