// reconcileTermiteAnnualActivations (codex P1-B) — the minimal retry for a
// termite annual-plan activation that bells and leaves an estimate
// 'awaiting_signature'. Signing burns the contract's share token, so there
// is no "sign again" path; this sweep re-drives
// activateTermiteAnnualPlanForSignedContract for exactly that stuck case.
//
// A small in-memory fake knex stands in for `conn` here because this sweep
// exercises BOTH its own top-level scan queries (conn('estimates')...,
// conn('customer_contracts')...) AND, per matching row,
// activateTermiteAnnualPlanForSignedContract's own conn.transaction(...) —
// a plain per-table jest.fn() router (as used in termite-annual-
// activation.test.js) can't serve both shapes across multiple different
// contract/estimate ids in one sweep.
describe('reconcileTermiteAnnualActivations sweep', () => {
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

  const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';

  function baseSnapshot() {
    return {
      amountCents: 30000,
      setupFeeCents: 0,
      lines: [{ description: 'annual fee', quantity: 1, unit_price: 300 }],
      title: 'WaveGuard Bronze — Annual Prepay (12 months)',
      notes: 'test',
      taxRate: null,
      monthlyRate: 25,
      resolvedBy: 'estimate-converter:prepay_annual',
      at: '2026-09-25T00:00:00.000Z',
    };
  }

  // Minimal fake knex: tables are plain JS Maps of id -> row (mutated in
  // place by .update(), so re-reads and cross-row assertions see writes).
  // Supports exactly the query shapes this module's code issues: .where in
  // both (col, val) and ({col: val}) forms, .whereRaw's one ANY(?) usage,
  // .forUpdate/.select/.limit as no-ops, and .first()/.update()/awaiting
  // the builder itself (a thenable) for a bare SELECT.
  function makeFakeConn({ estimates, contracts, terms }) {
    function rowsFor(table) {
      if (table === 'estimates') return [...estimates.values()];
      if (table === 'customer_contracts') return [...contracts.values()];
      if (table === 'annual_prepay_terms') return [...terms.values()];
      throw new Error(`Unexpected table ${table}`);
    }

    function tableHandler(table) {
      const filters = {};
      let rawAnyBindings = null;
      const builder = {
        where(a, b) {
          if (b !== undefined) filters[a] = b;
          else if (a && typeof a === 'object') Object.assign(filters, a);
          return builder;
        },
        whereRaw(_sql, bindings) {
          rawAnyBindings = bindings?.[0] || null;
          return builder;
        },
        forUpdate() { return builder; },
        select() { return builder; },
        limit() { return builder; },
        first: async () => matched()[0] || null,
        update: async (patch) => {
          const rows = matched();
          rows.forEach((row) => Object.assign(row, patch));
          return rows.length;
        },
        then: (resolve, reject) => Promise.resolve(matched()).then(resolve, reject),
        catch: (reject) => Promise.resolve(matched()).catch(reject),
      };
      function matched() {
        let rows = rowsFor(table);
        rows = rows.filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
        if (rawAnyBindings && table === 'customer_contracts') {
          rows = rows.filter((row) => rawAnyBindings.includes(String(row.document_variables_snapshot?.estimate?.id)));
        }
        return rows;
      }
      return builder;
    }

    const conn = jest.fn(tableHandler);
    // Every activation call opens its own transaction; this fake has no
    // real transactional isolation, but the module never relies on
    // rollback semantics in these tests (per-row try/catch owns failure
    // containment) — trx === the same table-routed handle.
    conn.transaction = jest.fn(async (cb) => cb(conn));
    return conn;
  }

  function setup({ estimates, contracts, terms = new Map(), termCreateImpl, invoiceCreateImpl } = {}) {
    const conn = makeFakeConn({ estimates, contracts, terms });
    const createTermForAnnualPrepay = jest.fn(termCreateImpl || (async () => ({ id: `term-${Math.random().toString(36).slice(2)}` })));
    const invoiceCreate = jest.fn(invoiceCreateImpl || (async () => ({ id: `invoice-${Math.random().toString(36).slice(2)}`, total: 300 })));
    const sendViaSMSAndEmail = jest.fn().mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } });
    const notifyAdmin = jest.fn().mockResolvedValue(true);

    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/estimate-deposits', () => ({
      acquireEstimateDepositLedgerLock: jest.fn().mockResolvedValue(undefined),
      pendingDepositCredit: jest.fn().mockResolvedValue(null),
      consumeDepositCredit: jest.fn().mockResolvedValue(0),
    }));
    jest.doMock('../services/invoice', () => ({ create: invoiceCreate, sendViaSMSAndEmail }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay }));
    jest.doMock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice: jest.fn(() => true) }));

    const { reconcileTermiteAnnualActivations } = require('../services/termite-annual-activation');
    return {
      reconcileTermiteAnnualActivations, conn, createTermForAnnualPrepay, invoiceCreate, sendViaSMSAndEmail, notifyAdmin,
    };
  }

  test('signed-but-awaiting: activates the estimate and reports it in the counts', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const contracts = new Map([
      ['contract-1', {
        id: 'contract-1', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date('2026-09-25T00:00:00Z'), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-1' } },
      }],
    ]);
    const { reconcileTermiteAnnualActivations, conn } = setup({ estimates, contracts });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts).toEqual({
      scanned: 1, activated: 1, skipped: 0, failed: 0,
    });
    expect(estimates.get('est-1').annual_plan_activation_status).toBe('activated');
  });

  test('unsigned contract: the estimate is untouched (not in the signed-contract scan at all)', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const contracts = new Map([
      ['contract-1', {
        id: 'contract-1', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'sent', signed_at: null, annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-1' } },
      }],
    ]);
    const { reconcileTermiteAnnualActivations, conn } = setup({ estimates, contracts });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts).toEqual({
      scanned: 0, activated: 0, skipped: 0, failed: 0,
    });
    expect(estimates.get('est-1').annual_plan_activation_status).toBe('awaiting_signature');
  });

  test('already activated: not scanned in the first place (the estimate-side WHERE excludes it)', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'activated', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const contracts = new Map([
      ['contract-1', {
        id: 'contract-1', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-1' } },
      }],
    ]);
    const { reconcileTermiteAnnualActivations, conn, createTermForAnnualPrepay } = setup({ estimates, contracts });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts).toEqual({
      scanned: 0, activated: 0, skipped: 0, failed: 0,
    });
    expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
  });

  test('one failure does not stop the batch — the other rows still activate', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
      }],
      ['est-2', {
        id: 'est-2', customer_id: 'cust-2', annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const contracts = new Map([
      ['contract-1', {
        id: 'contract-1', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-1' } },
      }],
      ['contract-2', {
        id: 'contract-2', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date(), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-2' } },
      }],
    ]);
    let call = 0;
    const { reconcileTermiteAnnualActivations, conn } = setup({
      estimates,
      contracts,
      // First term-creation call (whichever row hits it first) throws;
      // activateTermiteAnnualPlanForSignedContract catches it internally
      // and reports skipped:'error' for that row — the reconcile loop
      // itself never sees a thrown error from a well-behaved activation,
      // so this proves the OTHER row still completes either way.
      termCreateImpl: async () => {
        call += 1;
        if (call === 1) throw new Error('term creation exploded');
        return { id: 'term-ok' };
      },
    });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts.scanned).toBe(2);
    expect(counts.activated).toBe(1);
    expect(counts.skipped).toBe(1); // the failed row reports skipped:'error', not a thrown batch failure
    expect(counts.failed).toBe(0);
    const statuses = [estimates.get('est-1').annual_plan_activation_status, estimates.get('est-2').annual_plan_activation_status].sort();
    expect(statuses).toEqual(['activated', 'awaiting_signature']);
  });

  test('no awaiting-signature estimates at all: a clean zero-count scan, no contract query needed', async () => {
    const { reconcileTermiteAnnualActivations, conn } = setup({ estimates: new Map(), contracts: new Map() });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts).toEqual({
      scanned: 0, activated: 0, skipped: 0, failed: 0,
    });
  });
});
