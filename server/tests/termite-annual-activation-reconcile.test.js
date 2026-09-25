// reconcileTermiteAnnualActivations (codex P1-B, plus a follow-up round of
// 3 more P1s) — the minimal retry for a termite annual-plan activation that
// bells and leaves an estimate 'awaiting_signature', PLUS a retry for an
// activated estimate whose invoice never got delivered. Signing burns the
// contract's share token, so there is no "sign again" path; this sweep
// re-drives activateTermiteAnnualPlanForSignedContract / the delivery step
// for exactly those two stuck cases.
//
// A small in-memory fake knex stands in for `conn` here because this sweep
// issues two JOINed, ordered scans (customer_contracts -> estimates, and
// estimates -> annual_prepay_terms -> invoices) and, per matched row, calls
// into functions that open their own conn.transaction(...) — a plain
// per-table jest.fn() router can't serve both shapes. The fake hardcodes
// the actual join KEYS this module's two queries use (never parses the raw
// SQL condition text) — it is a deliberately narrow double for these two
// fixed queries, not a generic knex emulator.
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

  // ---- fake knex -----------------------------------------------------
  // Tables are plain JS Maps of id -> row (mutated in place by .update(),
  // so re-reads and cross-row assertions see writes made mid-sweep).
  function makeFakeConn({
    estimates, contracts, terms = new Map(), invoices = new Map(),
  }) {
    function baseTableName(table) {
      return String(table).split(' as ')[0];
    }
    function rowsFor(table) {
      const name = baseTableName(table);
      if (name === 'estimates') return [...estimates.values()];
      if (name === 'customer_contracts') return [...contracts.values()];
      if (name === 'annual_prepay_terms') return [...terms.values()];
      if (name === 'invoices') return [...invoices.values()];
      throw new Error(`Unexpected table ${table}`);
    }

    // Single-table builder: everything activateTermiteAnnualPlanForSignedContract
    // itself issues via `trx(...)` (no alias, no join) — unchanged from the
    // prior round's fake.
    function plainTableHandler(table) {
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
        if (rawAnyBindings && baseTableName(table) === 'customer_contracts') {
          rows = rows.filter((row) => rawAnyBindings.includes(String(row.document_variables_snapshot?.estimate?.id)));
        }
        return rows;
      }
      return builder;
    }

    // Join builder #1: reconcileTermiteAnnualActivations' activation-retry
    // scan — conn('customer_contracts as cc').join('estimates as e', ...).
    // Hardcodes the ACTUAL join key the production code relies on:
    // e.id === cc.document_variables_snapshot.estimate.id (INNER JOIN — a
    // contract with no resolvable estimate is dropped, matching real SQL).
    function contractsJoinEstimatesBuilder() {
      const filters = {}; // qualified key ('cc.x' / 'e.x') -> value
      let order = null;
      let lim = null;
      const builder = {
        join() { return builder; }, // semantics are hardcoded below
        where(a, b) {
          if (b !== undefined) filters[a] = b;
          else if (a && typeof a === 'object') Object.assign(filters, a);
          return builder;
        },
        orderBy(col, dir = 'asc') { order = { col, dir }; return builder; },
        select() { return builder; },
        limit(n) { lim = n; return builder; },
        then: (resolve, reject) => Promise.resolve(rows()).then(resolve, reject),
        catch: (reject) => Promise.resolve(rows()).catch(reject),
      };
      function fieldFor(prefix, key) { return key.startsWith(prefix) ? key.slice(prefix.length) : null; }
      function rows() {
        let joined = [...contracts.values()]
          .map((cc) => {
            const estId = cc.document_variables_snapshot?.estimate?.id;
            const e = estId ? estimates.get(String(estId)) : null;
            return { cc, e };
          })
          .filter(({ e }) => !!e);
        joined = joined.filter(({ cc, e }) => Object.entries(filters).every(([k, v]) => {
          const ccField = fieldFor('cc.', k);
          if (ccField !== null) return cc[ccField] === v;
          const eField = fieldFor('e.', k);
          if (eField !== null) return e[eField] === v;
          return true;
        }));
        if (order) {
          const field = fieldFor('cc.', order.col) || order.col;
          joined.sort((a, b) => {
            const av = a.cc[field];
            const bv = b.cc[field];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return order.dir === 'desc' ? -cmp : cmp;
          });
        }
        let result = joined.map(({ cc }) => ({ contract_id: cc.id }));
        if (lim != null) result = result.slice(0, lim);
        return result;
      }
      return builder;
    }

    // Join builder #2: reconcileTermiteAnnualActivations' delivery-retry
    // scan — conn('estimates as e').join('annual_prepay_terms as apt', ...)
    // .join('invoices as inv', ...). Hardcodes the ACTUAL join keys:
    // apt.source_estimate_id === e.id, inv.id === apt.prepay_invoice_id.
    function estimatesJoinTermsJoinInvoicesBuilder() {
      const filters = {};
      let nullChecks = [];
      let lim = null;
      const builder = {
        join() { return builder; },
        where(a, b) {
          if (b !== undefined) filters[a] = b;
          else if (a && typeof a === 'object') Object.assign(filters, a);
          return builder;
        },
        whereNull(col) { nullChecks.push(col); return builder; },
        select() { return builder; },
        limit(n) { lim = n; return builder; },
        then: (resolve, reject) => Promise.resolve(rows()).then(resolve, reject),
        catch: (reject) => Promise.resolve(rows()).catch(reject),
      };
      function fieldFor(prefix, key) { return key.startsWith(prefix) ? key.slice(prefix.length) : null; }
      function rows() {
        let joined = [...estimates.values()].flatMap((e) => {
          const matchingTerms = [...terms.values()].filter((t) => t.source_estimate_id === e.id);
          return matchingTerms.map((apt) => ({ e, apt, inv: apt.prepay_invoice_id ? invoices.get(apt.prepay_invoice_id) : null }));
        }).filter(({ inv }) => !!inv);
        joined = joined.filter(({ e, apt, inv }) => Object.entries(filters).every(([k, v]) => {
          const eField = fieldFor('e.', k);
          if (eField !== null) return e[eField] === v;
          const aptField = fieldFor('apt.', k);
          if (aptField !== null) return apt[aptField] === v;
          const invField = fieldFor('inv.', k);
          if (invField !== null) return inv[invField] === v;
          return true;
        }));
        joined = joined.filter(({ inv }) => nullChecks.every((col) => {
          const invField = fieldFor('inv.', col) || col;
          return inv[invField] == null;
        }));
        let result = joined.map(({ e, apt, inv }) => ({ estimate_id: e.id, term_id: apt.id, invoice_id: inv.id }));
        if (lim != null) result = result.slice(0, lim);
        return result;
      }
      return builder;
    }

    const conn = jest.fn((table) => {
      if (table === 'customer_contracts as cc') return contractsJoinEstimatesBuilder();
      if (table === 'estimates as e') return estimatesJoinTermsJoinInvoicesBuilder();
      return plainTableHandler(table);
    });
    conn.raw = jest.fn((sql) => ({ __rawSql: sql }));
    // Every activation call opens its own transaction; this fake has no
    // real transactional isolation, but the module never relies on
    // rollback semantics in these tests (per-row try/catch owns failure
    // containment) — trx === the same table-routed handle.
    conn.transaction = jest.fn(async (cb) => cb(conn));
    return conn;
  }

  function setup({
    estimates, contracts, terms = new Map(), invoices = new Map(), termCreateImpl, invoiceCreateImpl, deliveryImpl, notifyAdminImpl,
  } = {}) {
    const conn = makeFakeConn({
      estimates, contracts, terms, invoices,
    });
    const createTermForAnnualPrepay = jest.fn(termCreateImpl || (async ({ prepayInvoiceId, sourceEstimateId }) => {
      const id = `term-${Math.random().toString(36).slice(2)}`;
      terms.set(id, { id, source_estimate_id: sourceEstimateId, prepay_invoice_id: prepayInvoiceId });
      return { id };
    }));
    const invoiceCreate = jest.fn(invoiceCreateImpl || (async () => {
      const id = `invoice-${Math.random().toString(36).slice(2)}`;
      invoices.set(id, { id, total: 300, sent_at: null });
      return { id, total: 300 };
    }));
    const sendViaSMSAndEmail = jest.fn(deliveryImpl || (async (invoiceId) => {
      const inv = invoices.get(invoiceId);
      if (inv) inv.sent_at = new Date();
      return { ok: true, sms: { ok: true }, email: { ok: true } };
    }));
    const notifyAdmin = jest.fn(notifyAdminImpl || (async () => true));

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
      reconcileTermiteAnnualActivations, conn, createTermForAnnualPrepay, invoiceCreate, sendViaSMSAndEmail, notifyAdmin, terms, invoices,
    };
  }

  // ---- activation-retry pass ------------------------------------------

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

    expect(counts).toMatchObject({
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

    expect(counts).toMatchObject({
      scanned: 0, activated: 0, skipped: 0, failed: 0,
    });
    expect(estimates.get('est-1').annual_plan_activation_status).toBe('awaiting_signature');
  });

  test('already activated: not scanned in the first place (the join WHERE excludes it)', async () => {
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

    expect(counts).toMatchObject({
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
        id: 'contract-1', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date('2026-09-20T00:00:00Z'), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-1' } },
      }],
      ['contract-2', {
        id: 'contract-2', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date('2026-09-21T00:00:00Z'), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'est-2' } },
      }],
    ]);
    let call = 0;
    const terms = new Map();
    const { reconcileTermiteAnnualActivations, conn } = setup({
      estimates,
      contracts,
      terms,
      // First term-creation call (whichever row hits it first — oldest
      // signed_at first, so est-1) throws; activateTermiteAnnualPlanForSignedContract
      // catches it internally and reports skipped:'error' for that row —
      // the reconcile loop itself never sees a thrown error from a
      // well-behaved activation, so this proves the OTHER row still
      // completes either way.
      termCreateImpl: async ({ prepayInvoiceId, sourceEstimateId }) => {
        call += 1;
        if (call === 1) throw new Error('term creation exploded');
        const id = 'term-ok';
        terms.set(id, { id, source_estimate_id: sourceEstimateId, prepay_invoice_id: prepayInvoiceId });
        return { id };
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

  test('no awaiting-signature estimates at all: a clean zero-count scan', async () => {
    const { reconcileTermiteAnnualActivations, conn } = setup({ estimates: new Map(), contracts: new Map() });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts).toMatchObject({
      scanned: 0, activated: 0, skipped: 0, failed: 0,
    });
  });

  // ---- codex P1 (this round), item 3: ordering / starvation ------------

  test('codex P1: with more unsigned-awaiting estimates than the limit, a signed one still activates', async () => {
    const estimates = new Map();
    const contracts = new Map();
    // 5 unsigned-awaiting estimates with NO contract at all (never even
    // sent for signature yet) — the old unordered "scan estimates first,
    // LIMIT there" shape could fill its whole page with exactly these and
    // never reach the signed one below. A tiny limit (2) makes the
    // starvation reproducible without a large fixture.
    for (let i = 0; i < 5; i += 1) {
      const id = `unsigned-${i}`;
      estimates.set(id, {
        id, customer_id: `cust-unsigned-${i}`, annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
      });
    }
    estimates.set('signed-est', {
      id: 'signed-est', customer_id: 'cust-signed', annual_plan_activation_status: 'awaiting_signature', annual_plan_deferred_invoice: baseSnapshot(),
    });
    contracts.set('signed-contract', {
      id: 'signed-contract', document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed', signed_at: new Date('2026-09-25T00:00:00Z'), annual_plan_version: null, document_variables_snapshot: { estimate: { id: 'signed-est' } },
    });
    const { reconcileTermiteAnnualActivations, conn } = setup({ estimates, contracts });

    const counts = await reconcileTermiteAnnualActivations({ conn, limit: 2 });

    // The query is driven from SIGNED contracts, of which there is only
    // one — the 5 unsigned-awaiting estimates never enter this query at
    // all (no contract row joins to them), so they can't crowd it out.
    expect(counts.scanned).toBe(1);
    expect(counts.activated).toBe(1);
    expect(estimates.get('signed-est').annual_plan_activation_status).toBe('activated');
  });

  // ---- codex P1 (this round), item 1: delivery retry --------------------

  test('codex P1: an activated estimate whose invoice never delivered is retried and delivered once', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'activated', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const terms = new Map([
      ['term-1', { id: 'term-1', source_estimate_id: 'est-1', prepay_invoice_id: 'invoice-1' }],
    ]);
    const invoices = new Map([
      ['invoice-1', { id: 'invoice-1', total: 300, sent_at: null }], // never delivered
    ]);
    const { reconcileTermiteAnnualActivations, conn, sendViaSMSAndEmail } = setup({
      estimates, contracts: new Map(), terms, invoices,
    });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts.deliveryScanned).toBe(1);
    expect(counts.delivered).toBe(1);
    expect(counts.deliveryFailed).toBe(0);
    expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
    expect(sendViaSMSAndEmail).toHaveBeenCalledWith('invoice-1', expect.any(Object));
    expect(invoices.get('invoice-1').sent_at).not.toBeNull();
  });

  test('codex P1: a delivered invoice is not re-scanned or re-sent', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'activated', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const terms = new Map([
      ['term-1', { id: 'term-1', source_estimate_id: 'est-1', prepay_invoice_id: 'invoice-1' }],
    ]);
    const invoices = new Map([
      ['invoice-1', { id: 'invoice-1', total: 300, sent_at: new Date() }], // already delivered
    ]);
    const { reconcileTermiteAnnualActivations, conn, sendViaSMSAndEmail } = setup({
      estimates, contracts: new Map(), terms, invoices,
    });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts.deliveryScanned).toBe(0);
    expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('codex P1: a persistent delivery failure is reported and does not stop the rest of the sweep', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'activated', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const terms = new Map([
      ['term-1', { id: 'term-1', source_estimate_id: 'est-1', prepay_invoice_id: 'invoice-1' }],
    ]);
    const invoices = new Map([
      ['invoice-1', { id: 'invoice-1', total: 300, sent_at: null }],
    ]);
    const { reconcileTermiteAnnualActivations, conn, notifyAdmin } = setup({
      estimates,
      contracts: new Map(),
      terms,
      invoices,
      deliveryImpl: async () => { throw new Error('sms provider down'); },
    });

    const counts = await reconcileTermiteAnnualActivations({ conn });

    expect(counts.deliveryScanned).toBe(1);
    expect(counts.delivered).toBe(0);
    expect(counts.deliveryFailed).toBe(1);
    expect(invoices.get('invoice-1').sent_at).toBeNull(); // still undelivered — will retry again next tick
    expect(notifyAdmin).toHaveBeenCalledWith(
      'estimate', expect.any(String), expect.any(String),
      expect.objectContaining({ bell: true, dedupeKey: expect.stringContaining('delivery_failed') }),
    );
  });

  test('codex P1 (item 2): two consecutive sweep ticks against the same still-undelivered invoice pass the IDENTICAL dedupeKey', async () => {
    const estimates = new Map([
      ['est-1', {
        id: 'est-1', customer_id: 'cust-1', annual_plan_activation_status: 'activated', annual_plan_deferred_invoice: baseSnapshot(),
      }],
    ]);
    const terms = new Map([
      ['term-1', { id: 'term-1', source_estimate_id: 'est-1', prepay_invoice_id: 'invoice-1' }],
    ]);
    const invoices = new Map([
      ['invoice-1', { id: 'invoice-1', total: 300, sent_at: null }],
    ]);
    const { reconcileTermiteAnnualActivations, conn, notifyAdmin } = setup({
      estimates,
      contracts: new Map(),
      terms,
      invoices,
      deliveryImpl: async () => { throw new Error('sms provider still down'); },
    });

    await reconcileTermiteAnnualActivations({ conn }); // tick 1
    await reconcileTermiteAnnualActivations({ conn }); // tick 2 — same estimate, still undelivered

    expect(notifyAdmin).toHaveBeenCalledTimes(2);
    const firstKey = notifyAdmin.mock.calls[0][3].dedupeKey;
    const secondKey = notifyAdmin.mock.calls[1][3].dedupeKey;
    expect(firstKey).toBe('termite-annual-activation:est-1:delivery_failed');
    expect(secondKey).toBe(firstKey);
    // The mock notifyAdmin here doesn't implement real dedupe (that lives
    // in notification-service.js, unmocked elsewhere) — asserting the two
    // ticks pass the IDENTICAL key proves this module correctly PARTICIPATES
    // in notifyAdmin's own dedupe contract, which is what actually
    // collapses them to one bell in production.
  });
});
