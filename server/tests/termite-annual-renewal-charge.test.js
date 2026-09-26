// termite-annual-renewal-charge.js — slice 6b, the automatic termite annual
// renewal charge (dark behind GATE_TERMITE_ANNUAL_PLAN). This suite mocks
// every sibling service the module calls into (InvoiceService,
// AnnualPrepayRenewals.createTermForAnnualPrepay, the annual-prepay overlap
// lock, RecurringCards, StripeService, notification-service,
// cancellation-processor's station-retrieval task, and the customer
// messaging pipeline) — those modules' own behavior is covered by their own
// suites. This suite proves ONLY this module's own responsibilities: the
// exact-amount/date math on mint, the renewed_from_term_id idempotency
// re-check under lock, the at-most-once Stripe-attempt fence, the
// no-consent/no-method/decline/ambiguous branches and their bells, the
// grace-lapse void + retrieval task, and the gate.
describe('termite annual renewal charge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
  });

  function mockCommon() {
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  }

  // ---- date helpers -------------------------------------------------------

  describe('addDaysYmd', () => {
    test('month-end rollover in a non-leap year', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2027-02-28', 1)).toBe('2027-03-01');
    });

    test('leap-year Feb 29 exists and rolls over correctly', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2028-02-28', 1)).toBe('2028-02-29');
      expect(_private.addDaysYmd('2028-02-29', 1)).toBe('2028-03-01');
    });

    test('negative days for the grace-lapse cutoff', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      expect(_private.addDaysYmd('2026-10-31', -30)).toBe('2026-10-01');
    });
  });

  // ---- candidate query composition ---------------------------------------

  describe('whereDueForRenewal / whereNoticeWitnessed', () => {
    function recordingQuery() {
      const calls = [];
      const q = {};
      const methods = ['whereNotNull', 'whereIn', 'whereNull', 'where', 'whereNotExists', 'whereExists', 'orWhereNotNull'];
      for (const m of methods) {
        q[m] = jest.fn((...args) => { calls.push([m, args]); return q; });
      }
      return { q, calls };
    }

    test('requires annual_plan_version, a renewable status, no decision, term_end <= today, and no existing successor', () => {
      mockCommon();
      const { _private } = require('../services/termite-annual-renewal-charge');
      const { q, calls } = recordingQuery();
      _private.whereDueForRenewal(q, '2026-09-26');
      expect(calls.some(([m, args]) => m === 'whereNotNull' && args[0] === 't.annual_plan_version')).toBe(true);
      expect(calls.some(([m, args]) => m === 'whereIn' && args[0] === 't.status' && args[1].includes('active') && args[1].includes('renewal_pending'))).toBe(true);
      expect(calls.some(([m, args]) => m === 'whereNull' && args[0] === 't.renewal_decision')).toBe(true);
      expect(calls.some(([m, args]) => m === 'where' && args[0] === 't.term_end' && args[1] === '<=' && args[2] === '2026-09-26')).toBe(true);
      expect(calls.some(([m]) => m === 'whereNotExists')).toBe(true);
    });
  });

  // ---- mint -----------------------------------------------------------------

  function makeMintTrx({ parent, existingSuccessor = undefined }) {
    const parentUpdate = jest.fn().mockResolvedValue(1);
    const trx = jest.fn((table) => {
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn((filter) => {
          if (filter && Object.hasOwn(filter, 'renewed_from_term_id')) {
            return { first: jest.fn().mockResolvedValue(existingSuccessor) };
          }
          if (filter && filter.id === parent.id) {
            return {
              forUpdate: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(parent) }),
              whereNull: jest.fn((col) => {
                expect(col).toBe('renewal_decision');
                return { update: parentUpdate };
              }),
            };
          }
          throw new Error(`unexpected where(${JSON.stringify(filter)}) on annual_prepay_terms`);
        }),
      };
    });
    return { trx, parentUpdate };
  }

  function baseParent(overrides = {}) {
    return {
      id: 'parent-1',
      customer_id: 'cust-1',
      annual_plan_version: 'v3',
      status: 'active',
      renewal_decision: null,
      plan_label: 'Waves Subterranean Termite Protection',
      prepay_amount: '249.00',
      monthly_rate: '20.75',
      coverage_service_type: 'termite_annual',
      coverage_visit_count: 1,
      coverage_cadence: 'annual',
      term_end: '2026-09-26',
      renewal_charge_consent_at: new Date('2025-09-01T00:00:00Z'),
      prepay_invoice_id: 'parent-invoice-1',
      ...overrides,
    };
  }

  function mockMintDeps({ invoiceCreateImpl, createTermImpl, overlapImpl } = {}) {
    const invoiceCreate = jest.fn(invoiceCreateImpl || (async (args) => ({
      id: 'succ-invoice-1', total: Number(args.lineItems[0].unit_price), tax_amount: 0, token: 'tok-1',
    })));
    jest.doMock('../services/invoice', () => ({ create: invoiceCreate, sendViaSMSAndEmail: jest.fn(), voidInvoice: jest.fn() }));
    const createTermForAnnualPrepay = jest.fn(createTermImpl || (async (args) => ({
      id: 'succ-term-1',
      customer_id: args.customerId,
      prepay_invoice_id: args.prepayInvoiceId,
      prepay_amount: args.prepayAmount,
      term_start: args.termStart,
      term_end: args.termEnd,
    })));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay }));
    const lockAndAssertNoAnnualPrepayOverlap = jest.fn(overlapImpl || (async () => undefined));
    jest.doMock('../routes/admin-customers', () => ({ lockAndAssertNoAnnualPrepayOverlap }));
    return { invoiceCreate, createTermForAnnualPrepay, lockAndAssertNoAnnualPrepayOverlap };
  }

  describe('mintRenewalSuccessor', () => {
    test('mints the successor for exactly parent.prepay_amount, term_end inclusive -> next-day start + 12mo end, and marks the parent renewed', async () => {
      mockCommon();
      const parent = baseParent();
      const { trx, parentUpdate } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay, lockAndAssertNoAnnualPrepayOverlap } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result.minted).toBe(true);
      expect(result.successor.id).toBe('succ-term-1');
      expect(lockAndAssertNoAnnualPrepayOverlap).toHaveBeenCalledWith(trx, 'cust-1', '2026-09-27', false, expect.any(String));
      expect(invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        taxRate: 0,
        skipAccrual: true,
        lineItems: [expect.objectContaining({ quantity: 1, unit_price: 249 })],
      }));
      expect(createTermForAnnualPrepay).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        prepayInvoiceId: 'succ-invoice-1',
        prepayAmount: 249,
        termStart: '2026-09-27', // parent term_end (inclusive) + 1 day
        termEnd: '2027-09-27', // +12mo same day
        renewedFromTermId: 'parent-1',
        annualPlanVersion: 'v3',
        coverageServiceType: 'termite_annual',
      }));
      expect(parentUpdate).toHaveBeenCalledWith(expect.objectContaining({
        status: 'renewed', renewal_decision: 'renew',
      }));
    });

    test('never recomputes the price — throws if the minted invoice total drifts from prepay_amount', async () => {
      mockCommon();
      const parent = baseParent();
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      mockMintDeps({ invoiceCreateImpl: async () => ({ id: 'bad-invoice', total: 260, tax_amount: 0, token: 'tok' }) });

      const { _private } = require('../services/termite-annual-renewal-charge');
      await expect(_private.mintRenewalSuccessor('parent-1', conn)).rejects.toThrow(/does not match the quoted renewal fee/);
    });

    test('idempotent — a successor that already exists is returned untouched, and nothing else mints again', async () => {
      mockCommon();
      const parent = baseParent();
      const existingSuccessor = { id: 'already-there', renewed_from_term_id: 'parent-1' };
      const { trx } = makeMintTrx({ parent, existingSuccessor });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate, createTermForAnnualPrepay } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toEqual({ successor: existingSuccessor, minted: false });
      expect(invoiceCreate).not.toHaveBeenCalled();
      expect(createTermForAnnualPrepay).not.toHaveBeenCalled();
    });

    test('a declined renewal (renewal_decision already set) is never minted or charged', async () => {
      mockCommon();
      const parent = baseParent({ renewal_decision: 'cancel', status: 'cancelled' });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toBeNull();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });

    test('a non-renewable status (already renewal-decided some other way) mints nothing', async () => {
      mockCommon();
      const parent = baseParent({ status: 'refunded' });
      const { trx } = makeMintTrx({ parent });
      const conn = { transaction: jest.fn(async (cb) => cb(trx)) };
      const { invoiceCreate } = mockMintDeps();

      const { _private } = require('../services/termite-annual-renewal-charge');
      const result = await _private.mintRenewalSuccessor('parent-1', conn);

      expect(result).toBeNull();
      expect(invoiceCreate).not.toHaveBeenCalled();
    });
  });

  // ---- charge decision --------------------------------------------------

  function makeClaimConn(claimResult = 1) {
    const claimUpdate = jest.fn().mockResolvedValue(claimResult);
    const conn = jest.fn((table) => {
      if (table !== 'annual_prepay_terms') throw new Error(`unexpected table ${table}`);
      return {
        where: jest.fn().mockReturnValue({
          whereNull: jest.fn((col) => {
            expect(col).toBe('renewal_charge_attempted_at');
            return { update: claimUpdate };
          }),
        }),
      };
    });
    return { conn, claimUpdate };
  }

  function baseSuccessor(overrides = {}) {
    return {
      id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1', prepay_amount: 249, ...overrides,
    };
  }

  describe('decideAndCharge', () => {
    test('no consent on the parent -> the pay-link invoice goes out and staff are belled; no method resolution, no Stripe call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      const resolvePrepayChargeMethod = jest.fn();
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn } = makeClaimConn();
      const successor = baseSuccessor();
      const parent = baseParent({ renewal_charge_consent_at: null });

      const outcome = await _private.decideAndCharge(successor, parent, conn);

      expect(outcome.status).toBe('no_consent');
      expect(sendViaSMSAndEmail).toHaveBeenCalledWith('succ-invoice-1', expect.any(Object));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/no auto-charge consent/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:no_consent',
      }));
      expect(resolvePrepayChargeMethod).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('consent present but no chargeable saved method -> invoice + bell, no Stripe call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({ resolvePrepayChargeMethod: jest.fn(async () => null) }));
      const chargeInvoiceWithSavedCard = jest.fn();
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn } = makeClaimConn();
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome.status).toBe('no_method');
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/no saved card/i), expect.any(String), expect.any(Object));
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    test('a Stripe decline: one attempt, one bell, pay-link delivered, and the SAME successor never re-attempts on a later call', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn(async () => ({ id: 'n1' }));
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
        isAmbiguousSavedMethodChargeError: jest.fn(() => false),
      }));
      const declineErr = new Error('Your card was declined.');
      const chargeInvoiceWithSavedCard = jest.fn(async () => { throw declineErr; });
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard }));
      // sendRenewalChargeFailedNotice's dependencies — best-effort, but
      // exercised here to confirm it's actually reached on a real decline.
      jest.doMock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.com' }));
      const renderSmsTemplate = jest.fn(async () => 'rendered body');
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate }));
      const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
      jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
      const dbMock = jest.fn((table) => {
        if (table === 'customers') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551212', first_name: 'Pat' }) }) };
        if (table === 'invoices') return { where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue({ token: 'tok-1' }) }) };
        throw new Error(`unexpected table ${table}`);
      });
      jest.doMock('../models/db', () => dbMock);

      const { _private } = require('../services/termite-annual-renewal-charge');
      const successor = baseSuccessor();
      const { conn, claimUpdate } = makeClaimConn(1); // first call claims (1 row)

      const outcome = await _private.decideAndCharge(successor, baseParent(), conn);
      expect(outcome.status).toBe('failed');
      expect(claimUpdate).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledWith('succ-invoice-1', 'pm-1', expect.objectContaining({
        maxAuthorizedChargeCents: 24900, maxAuthorizedTotalCents: 24900,
      }));
      expect(notifyAdmin).toHaveBeenCalledWith('billing', expect.stringMatching(/declined/i), expect.any(String), expect.objectContaining({
        dedupeKey: 'termite-renewal-charge:succ-term-1:declined',
      }));
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      // Best-effort decline notice actually fires with the templated path.
      await Promise.resolve(); // let the fire-and-forget-shaped await settle
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'payment_failure' }));

      // A later call against the SAME successor, once already attempted,
      // never re-attempts (the caller's own claim query now returns 0 rows —
      // simulated directly here, matching what the real UPDATE ... WHERE
      // renewal_charge_attempted_at IS NULL would return the second time).
      const { conn: secondConn, claimUpdate: secondClaim } = makeClaimConn(0);
      const secondOutcome = await _private.decideAndCharge(successor, baseParent(), secondConn);
      expect(secondOutcome.status).toBe('already_attempted');
      expect(secondClaim).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1); // still just the one attempt total
    });

    test('a successful charge rings no bell and sends no pay-link invoice', async () => {
      mockCommon();
      const sendViaSMSAndEmail = jest.fn(async () => ({ ok: true }));
      jest.doMock('../services/invoice', () => ({ sendViaSMSAndEmail }));
      const notifyAdmin = jest.fn();
      jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
      jest.doMock('../services/recurring-card-on-file', () => ({
        resolvePrepayChargeMethod: jest.fn(async () => ({ paymentMethodRowId: 'pm-1' })),
      }));
      const chargeInvoiceWithSavedCard = jest.fn(async () => ({ status: 'paid' }));
      jest.doMock('../services/stripe', () => ({ chargeInvoiceWithSavedCard }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const { conn } = makeClaimConn(1);
      const outcome = await _private.decideAndCharge(baseSuccessor(), baseParent(), conn);

      expect(outcome.status).toBe('charged');
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
    });
  });

  // ---- grace lapse --------------------------------------------------------

  describe('processGraceLapseForTerm', () => {
    test('voids the successor invoice (which cascades the term to cancelled through the existing sync) and raises the station-retrieval task exactly once', async () => {
      mockCommon();
      const voidInvoice = jest.fn(async () => ({}));
      jest.doMock('../services/invoice', () => ({ voidInvoice }));
      const raiseTermiteRetrievalTask = jest.fn(async () => ({ raised: true }));
      jest.doMock('../services/cancellation-processor', () => ({ raiseTermiteRetrievalTask }));

      const { _private } = require('../services/termite-annual-renewal-charge');
      const term = { id: 'succ-term-1', customer_id: 'cust-1', prepay_invoice_id: 'succ-invoice-1' };
      await _private.processGraceLapseForTerm(term, jest.fn());

      expect(voidInvoice).toHaveBeenCalledWith('succ-invoice-1');
      expect(raiseTermiteRetrievalTask).toHaveBeenCalledWith('cust-1', null, expect.objectContaining({
        termId: 'succ-term-1', episodeKey: 'renewal_grace_lapse',
      }));
    });
  });

  // ---- gate ---------------------------------------------------------------

  describe('runTermiteAnnualRenewalSweep', () => {
    test('gate off -> no-op end to end, no queries at all', async () => {
      mockCommon();
      // No other mocks: if the gate check didn't short-circuit before any
      // DB access, requiring the real annual-prepay-renewals / invoice /
      // stripe modules here would blow up on missing config.
      const { runTermiteAnnualRenewalSweep, termiteAnnualRenewalChargeLive } = require('../services/termite-annual-renewal-charge');
      expect(termiteAnnualRenewalChargeLive()).toBe(false);
      const result = await runTermiteAnnualRenewalSweep();
      expect(result.gate).toBe('off');
      expect(result.minted).toBe(0);
      expect(result.charged).toBe(0);
    });

    test('gate on reads the env var fresh on every call (no restart needed)', async () => {
      mockCommon();
      const { termiteAnnualRenewalChargeLive } = require('../services/termite-annual-renewal-charge');
      expect(termiteAnnualRenewalChargeLive()).toBe(false);
      process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
      expect(termiteAnnualRenewalChargeLive()).toBe(true);
    });
  });
});
