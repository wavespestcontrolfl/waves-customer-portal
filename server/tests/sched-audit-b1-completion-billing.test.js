'use strict';

const fs = require('fs');
const path = require('path');

describe('Schedule & Dispatch audit Batch 1 — completion, billing & warn-never-block', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('P0-1: memberBillingEligibility claims and stamps paf_held_term_id on PAF grouped first visits and clears obsolete stamps for prepaid/payer members', async () => {
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const Payer = require('../services/payer');
    const { _test } = require('../services/visit-completion-invoice');

    const updates = [];
    const fakeTrx = jest.fn((table) => {
      const q = {
        join: jest.fn(() => q),
        where: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        first: jest.fn(async () => null),
        update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      };
      return q;
    });

    jest.spyOn(Payer, 'resolveForInvoice').mockResolvedValue({ payerId: null });
    const termSpy = jest.spyOn(AnnualPrepayRenewals, 'pafDeferredHoldingTerm').mockResolvedValueOnce({ id: 'term-paf-1' });
    const coversSpy = jest.spyOn(AnnualPrepayRenewals, 'annualPrepayCoversVisit').mockResolvedValue(false);

    const member = {
      id: 'svc-paf-1',
      customer_id: 'cust-paf-1',
      record_status: 'completed',
      record_notes: {},
      prepaid_method: null,
      prepaid_amount: null,
      paf_held_term_id: null,
    };
    const customer = { id: 'cust-paf-1', billing_mode: 'per_application' };

    const res1 = await _test.memberBillingEligibility(member, customer, fakeTrx);
    expect(res1).toEqual({
      state: 'office_required',
      reason: 'covered_billing_lane',
      serviceId: 'svc-paf-1',
      invoiceId: null,
    });
    expect(termSpy).toHaveBeenCalledWith(member, fakeTrx, { throwOnError: true, claim: true });
    expect(member.paf_held_term_id).toBe('term-paf-1');
    expect(updates).toContainEqual({ table: 'scheduled_services', patch: { paf_held_term_id: 'term-paf-1' } });
    expect(coversSpy).not.toHaveBeenCalled();

    // Reopened member now payer-billed clears obsolete paf_held_term_id.
    updates.length = 0;
    Payer.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    const reopened = { ...member, paf_held_term_id: 'term-old-1' };
    const res2 = await _test.memberBillingEligibility(reopened, customer, fakeTrx);
    expect(res2).toEqual({
      state: 'office_required',
      reason: 'payer_billed_member',
      serviceId: 'svc-paf-1',
      invoiceId: null,
    });
    expect(reopened.paf_held_term_id).toBeNull();
    expect(updates).toContainEqual({ table: 'scheduled_services', patch: { paf_held_term_id: null } });

    // Reopened/repriced self-pay visit whose old paf_held_term_id no longer
    // matches either live PAF hold check must clear its stale stamp BEFORE
    // checking annualPrepayCoversVisit (skipDeferredHold: true) so the packet
    // can bill it instead of suppressing coverage on the obsolete stamp.
    termSpy.mockReset();
    termSpy.mockResolvedValue(null);
    Payer.resolveForInvoice.mockReset();
    Payer.resolveForInvoice.mockResolvedValue({ payerId: null });
    coversSpy.mockReset();
    const callsBeforeCovers = [];
    coversSpy.mockImplementation(async (m, _conn, opts) => {
      callsBeforeCovers.push({ stampAtCall: m.paf_held_term_id, skipDeferredHold: opts?.skipDeferredHold });
      return false;
    });
    const repriced = { ...member, paf_held_term_id: 'term-stale' };
    const res3 = await _test.memberBillingEligibility(repriced, customer, fakeTrx);
    expect(res3).toBeNull();
    expect(repriced.paf_held_term_id).toBeNull();
    expect(callsBeforeCovers).toEqual([{ stampAtCall: null, skipDeferredHold: true }]);
  });

  test('P0-1: Phase 2 packetEffects excludes packet-billed and amount-only prepaid members from PAF holds', async () => {
    const { isPacketBilledMember, isExcludedFromPafHold } = require('../services/complete-scheduled-service');
    const seen = [];
    const fakeDb = jest.fn((table) => ({
      where: jest.fn((clause) => { seen.push({ table, clause }); return {
        whereNotNull: jest.fn((col) => { seen.push({ whereNotNull: col }); return {
          first: jest.fn(async () => ({ id: 'item-1' })),
        }; }),
      }; }),
    }));
    expect(await isPacketBilledMember(null, 'svc-1', fakeDb)).toBe(false);
    expect(await isPacketBilledMember({ phase: 'records', packetId: 'pkt-1' }, 'svc-1', fakeDb)).toBe(false);
    expect(await isPacketBilledMember({ phase: 'effects', packetId: 'pkt-1' }, 'svc-1', fakeDb)).toBe(true);
    expect(seen).toContainEqual({
      table: 'visit_completion_packet_items',
      clause: { packet_id: 'pkt-1', scheduled_service_id: 'svc-1' },
    });
    expect(seen).toContainEqual({ whereNotNull: 'invoice_id' });

    // Positive prepaid_amount with no prepaid_method must exclude PAF holds in
    // BOTH Phase 1 (memberBillingEligibility) and Phase 2 (isExcludedFromPafHold).
    expect(isExcludedFromPafHold({
      visitIsPayerBilled: false,
      svc: { prepaid_method: null, prepaid_amount: '95.00' },
      packetBilledMember: false,
    })).toBe(true);
    expect(isExcludedFromPafHold({
      visitIsPayerBilled: false,
      svc: { prepaid_method: null, prepaid_amount: 0 },
      packetBilledMember: true,
    })).toBe(true);
    expect(isExcludedFromPafHold({
      visitIsPayerBilled: false,
      svc: { prepaid_method: null, prepaid_amount: null },
      packetBilledMember: false,
    })).toBe(false);

    const completeSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(completeSrc).toContain('const packetBilledMember = await isPacketBilledMember(packetContext, svc.id, db);');
    expect(completeSrc).toContain('const pafExcluded = isExcludedFromPafHold({ visitIsPayerBilled, svc, packetBilledMember });');
    expect(completeSrc).toContain('if (pafExcluded && svc.paf_held_term_id)');
    expect(completeSrc).toContain('if (!pafExcluded && !isBackfillCompletion)');

    const packetSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'visit-completion-invoice.js'), 'utf8');
    expect(packetSrc).toContain(".whereNotNull('paf_held_term_id')");
    expect(packetSrc).toContain('.update({ paf_held_term_id: null })');
  });

  test('P1-5a: stampChemicalReviewHoldOnVisitInvoices skips payer_id and payer_statement_id AP invoices', async () => {
    const { stampChemicalReviewHoldOnVisitInvoices } = require('../services/complete-scheduled-service');
    const updatedIds = [];
    const trx = jest.fn((table) => {
      if (table === 'invoices') {
        const state = { id: null };
        const q = {
          where: jest.fn((arg) => {
            if (arg && typeof arg === 'object' && arg.id) state.id = arg.id;
            return q;
          }),
          whereNotIn: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          forUpdate: jest.fn(() => q),
          noWait: jest.fn(() => q),
          select: jest.fn(async (...cols) => {
            expect(cols).toEqual(expect.arrayContaining(['payer_id', 'payer_statement_id']));
            return [
              { id: 'inv-self', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: null, payer_id: null, payer_statement_id: null },
              { id: 'inv-ap-payer', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: null, payer_id: 'payer-1', payer_statement_id: null },
              { id: 'inv-ap-stmt', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: null, payer_id: null, payer_statement_id: 'stmt-1' },
              { id: 'inv-withdrawn', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: 'payer_billed:payer-2', payer_id: null, payer_statement_id: null },
            ];
          }),
          update: jest.fn(async () => { updatedIds.push(state.id); return 1; }),
        };
        return q;
      }
      if (table === 'invoice_followup_sequences') {
        const q = { where: jest.fn(() => q), update: jest.fn(async () => 1) };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });

    const result = await stampChemicalReviewHoldOnVisitInvoices(trx, { serviceId: 'svc-chem-1' });
    expect(result.stampedIds).toEqual(['inv-self']);
    expect(updatedIds).toEqual(['inv-self']);
  });

  test('P1-5b: applyPrepaidCreditToInvoice computes against invoiceAmountDue (total minus credit_applied)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    const helper = source.match(/const applyPrepaidCreditToInvoice = async \(invoiceRow\) => \{([\s\S]*?)\n {4}\};/);
    expect(helper).not.toBeNull();
    expect(helper[1]).toContain('const amountDueCents = toCents(invoiceAmountDue(lockedInvoice));');
    expect(helper[1]).toContain('const creditCents = Math.min(prepaidCents, amountDueCents);');
    expect(helper[1]).toContain('const remainingDueCents = Math.max(0, amountDueCents - creditCents);');
    expect(helper[1]).toContain('const remainingTotalCents = Math.max(0, invoiceTotalCents - creditCents);');
    expect(helper[1]).toContain('const paidByPrepayment = remainingDueCents <= 0;');
  });

  test('P1-5c: acceptanceTaxRefusal and mintPacketInvoiceInner pass skipCustomerExemption for payer-billed packets', async () => {
    const TaxCalculator = require('../services/tax-calculator');
    const { _test } = require('../services/visit-completion-invoice');
    const calcSpy = jest.spyOn(TaxCalculator, 'calculateTax').mockResolvedValue({ rate: 0.07, amount: 7 });

    const refusal = await _test.acceptanceTaxRefusal({
      invoice: { subtotal: 100, discount_amount: 0, tax_rate: 0.07, tax_amount: 7, payer_id: null },
      members: [{ id: 'm1', service_type: 'General Pest Control', property_id: 'prop-1' }],
      customer: { id: 'cust-1', property_type: 'commercial' },
      trx: {},
      payerId: 'payer-ap-1',
    });
    expect(refusal).toBeNull();
    expect(calcSpy).toHaveBeenCalledWith(
      'cust-1',
      'General Pest Control',
      100,
      { database: {}, skipCustomerExemption: true, propertyId: 'prop-1' },
    );

    // Tax-exempt payer taxes every line at 0% — mixed taxable + nontaxable
    // commercial services must NOT trigger mixed_tax_treatment.
    calcSpy.mockReset();
    const payerSeen = new Map([
      ['m-1', { payerId: 'payer-exempt', taxExempt: true }],
      ['m-2', { payerId: 'payer-exempt', taxExempt: true }],
    ]);
    const owner = _test.payerOwnerForPacket(payerSeen);
    expect(owner).toEqual({ payerId: 'payer-exempt', payerTaxExempt: true });

    const mixedExempt = await _test.hasMixedCommercialTaxTreatment({
      billed: [
        { member: { id: 'm-1', service_type: 'General Pest Control', property_id: 'prop-1' }, lineItems: [{ amount: 100, category: 'pest' }] },
        { member: { id: 'm-2', service_type: 'Lawn Care', property_id: 'prop-1' }, lineItems: [{ amount: 80, category: 'lawn' }] },
      ],
      customer: { id: 'cust-1', property_type: 'commercial' },
      trx: {},
      payerId: owner.payerId,
      payerTaxExempt: owner.payerTaxExempt,
    });
    expect(mixedExempt).toBe(false);
    expect(calcSpy).not.toHaveBeenCalled();

    const exemptAcceptance = await _test.acceptanceTaxRefusal({
      invoice: { subtotal: 180, discount_amount: 0, tax_rate: 0, tax_amount: 0, payer_id: 'payer-exempt' },
      members: [
        { id: 'm-1', service_type: 'General Pest Control', property_id: 'prop-1' },
        { id: 'm-2', service_type: 'Lawn Care', property_id: 'prop-1' },
      ],
      customer: { id: 'cust-1', property_type: 'commercial' },
      trx: {},
      payerId: 'payer-exempt',
      payerTaxExempt: true,
    });
    expect(exemptAcceptance).toBeNull();

    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'visit-completion-invoice.js'), 'utf8');
    expect(source).toContain('const skipCustomerExemption = Boolean(payerId);');
    expect(source).toContain('{ database: trx, skipCustomerExemption, propertyId: member.property_id || undefined }');
  });

  test('P1-6: markCompletionAttemptFailed guards on status=pending + updated_at generation and failed->pending 23505 runs in a savepoint returning 409', async () => {
    const { claimCompletionAttempt, markCompletionAttemptFailed } = require('../services/completion-attempts');

    let capturedWhere = null;
    let capturedAndWhere = null;
    const failKnex = jest.fn(() => {
      const q = {
        where: jest.fn((criteria) => { capturedWhere = criteria; return q; }),
        andWhere: jest.fn((...args) => { capturedAndWhere = args; return q; }),
        update: jest.fn(async () => 0),
      };
      return q;
    });
    const stampedAt = new Date('2026-11-27T15:00:00.000Z');
    await markCompletionAttemptFailed({ id: 'attempt-99', updated_at: stampedAt }, new Error('stalled'), failKnex);
    expect(capturedWhere).toEqual({ id: 'attempt-99', status: 'pending' });
    expect(capturedAndWhere).toEqual(['updated_at', stampedAt]);

    // Failed -> pending retry inside an active transaction uses a SAVEPOINT so 23505 never aborts the outer trx.
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    let savepointUsed = false;
    const makeQuery = () => {
      let whereArg = null;
      const q = {
        where: jest.fn((arg) => { whereArg = arg; return q; }),
        whereIn: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        andWhere: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => {
          if (whereArg && whereArg.idempotency_key === 'key-1') {
            return {
              id: 'att-failed-1',
              service_id: 'svc-race-1',
              idempotency_key: 'key-1',
              status: 'failed',
              request_hash: 'hash-1',
              snapshot_written_at: null,
            };
          }
          return null;
        }),
        insert: jest.fn(() => ({ returning: jest.fn(async () => { throw dupErr; }) })),
        update: jest.fn(() => ({ returning: jest.fn(async () => { throw dupErr; }) })),
      };
      return q;
    };
    const raceTrx = jest.fn(() => makeQuery());
    raceTrx.isTransaction = true;
    raceTrx.transaction = jest.fn(async (cb) => {
      savepointUsed = true;
      return cb(jest.fn(() => makeQuery()));
    });

    const result = await claimCompletionAttempt({
      serviceId: 'svc-race-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, raceTrx);
    expect(savepointUsed).toBe(true);
    expect(result).toEqual({
      action: 'conflict',
      status: 409,
      payload: {
        error: 'Completion already pending for this service.',
        code: 'service_completion_pending',
      },
    });
  });

  test('P1-8: inactive catalog product and missing broadcast sqft warn instead of throwing 400', () => {
    const { inactiveProductFinding, missingAreaSqftFinding } = require('../services/complete-scheduled-service');
    expect(inactiveProductFinding({ id: 'p-1', name: 'Old Chem' })).toMatchObject({
      code: 'inactive_product_warning',
      limitType: 'inactive_catalog_product',
      productId: 'p-1',
    });
    expect(missingAreaSqftFinding({ id: 'p-2', name: 'Broadcast Granular' })).toMatchObject({
      code: 'area_sqft_warning',
      limitType: 'broadcast_area_sqft_missing',
      productId: 'p-2',
    });

    const completeSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(completeSrc).not.toContain('Product is inactive:');
    expect(completeSrc).not.toContain("err.code = 'area_sqft_required';");
  });

  test('P2-1: clearSeriesPrepaid excludes completed visits so historical prepayment stamps survive', async () => {
    const { clearSeriesPrepaid } = require('../services/prepaid-series');
    const updatedWhereIn = [];
    let sawNotCompletedClause = false;
    const rows = [
      { id: 'svc-done', customer_id: 'cust-1', status: 'completed', is_recurring: true, recurring_pattern: 'quarterly', prepaid_amount: 90, prepaid_method: 'cash' },
      { id: 'svc-open', customer_id: 'cust-1', status: 'pending', is_recurring: true, recurring_pattern: 'quarterly', prepaid_amount: 90, prepaid_method: 'cash' },
    ];
    const makeTrx = () => {
      const fn = jest.fn((table) => {
        if (table === 'scheduled_services') {
          let isUpdate = false;
          let inIds = null;
          const q = {
            where: jest.fn(() => q),
            whereIn: jest.fn((col, ids) => { inIds = ids; return q; }),
            whereNotNull: jest.fn(() => q),
            whereRaw: jest.fn((sql) => { if (/completed/.test(sql)) sawNotCompletedClause = true; return q; }),
            orderBy: jest.fn(() => q),
            forUpdate: jest.fn(async () => rows.filter((r) => r.status !== 'completed')),
            update: jest.fn(() => {
              isUpdate = true;
              updatedWhereIn.push(inIds);
              return { returning: jest.fn(async () => [{ id: 'svc-open', annual_prepay_term_id: null }]) };
            }),
            then: (resolve, reject) => Promise.resolve(isUpdate ? [] : rows).then(resolve, reject),
          };
          return q;
        }
        if (table === 'audit_log as allocation') {
          const q = {
            where: jest.fn(() => q),
            whereIn: jest.fn(() => q),
            whereRaw: jest.fn(() => q),
            whereNotExists: jest.fn(() => q),
            select: jest.fn(async () => []),
          };
          return q;
        }
        throw new Error(`unexpected table ${table}`);
      });
      fn.transaction = async (cb) => cb(fn);
      return fn;
    };

    const trx = makeTrx();
    const res = await clearSeriesPrepaid(trx, { id: 'svc-done', customer_id: 'cust-1' });
    expect(res).toMatchObject({ success: true, clearedCount: 1 });
    expect(updatedWhereIn).toEqual([['svc-open']]);
    expect(sawNotCompletedClause).toBe(true);
  });
});
