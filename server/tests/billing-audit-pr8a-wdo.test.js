/**
 * Regression suite for Full Billing Audit PR 8A (WDO fee parsing/fallbacks,
 * report-only billing bell policy, prepaid credit/promo visit closeout,
 * WDO report-hold probes on undo/void/reverse-prepaid, mark-sent-outside
 * send-in-flight fence, disputed WDO invoice handling, and held-WDO
 * service-record/document egress suppression).
 *
 * Covers findings: B-25, B-26, B-27, B-33, B-47, B-48, B-58.
 * Synthetic fixtures only — no customer PII.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

function makeChain(resolved = []) {
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const q = {};
  for (const method of [
    'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
    'orWhere', 'orWhereRaw', 'orWhereNull', 'orWhereIn', 'andWhere',
    'leftJoin', 'join', 'select', 'distinct', 'orderBy', 'limit', 'offset',
    'count', 'forUpdate', 'forShare', 'forNoKeyUpdate', 'noWait', 'update', 'delete', 'insert',
  ]) {
    q[method] = jest.fn(() => q);
  }
  q.first = jest.fn(async () => (Array.isArray(resolved) ? resolved[0] : resolved));
  q.returning = jest.fn(async () => rows);
  q.catch = jest.fn((fn) => Promise.resolve(rows).catch(fn));
  q.finally = jest.fn((fn) => Promise.resolve(rows).finally(fn));
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

describe('B-25: WDO inspection fee parser, booked visit fallback & draft reprice guard', () => {
  test('shared @waves/report-redaction parser rejects negatives/ranges/prose and parses explicit $ amounts', () => {
    const {
      parseWdoFeeAmount,
      parseWdoFee,
      wdoFeeIsExplicitZero,
    } = require('@waves/report-redaction');

    expect(parseWdoFeeAmount('-50')).toBeNull();
    expect(parseWdoFeeAmount('-$50')).toBeNull();
    expect(parseWdoFeeAmount('$-50')).toBeNull();
    expect(parseWdoFeeAmount('($50)')).toBeNull();
    expect(parseWdoFeeAmount('-0')).toBeNull();
    expect(parseWdoFeeAmount('.50')).toBe(0.5);
    expect(parseWdoFeeAmount('$.50')).toBe(0.5);
    expect(parseWdoFeeAmount('2nd inspection $175')).toBe(175);
    expect(parseWdoFeeAmount('0% discount $175')).toBe(175);
    expect(parseWdoFeeAmount('$150-$250')).toBeNull();
    expect(parseWdoFeeAmount('$150-250')).toBeNull();
    expect(parseWdoFeeAmount('150-250')).toBeNull();
    expect(parseWdoFeeAmount('150 to $250')).toBeNull();
    expect(parseWdoFeeAmount('$150/$250')).toBeNull();
    expect(parseWdoFeeAmount('2nd inspection')).toBeNull();
    expect(parseWdoFeeAmount('2200 sq ft')).toBeNull();
    expect(parseWdoFeeAmount('2026-11-27')).toBeNull();
    expect(parseWdoFeeAmount('0 — comped')).toBe(0);
    expect(parseWdoFeeAmount('$0.00')).toBe(0);
    expect(parseWdoFee('1,250')).toBe(1250);
    expect(parseWdoFee('-50')).toBe(0);
    expect(wdoFeeIsExplicitZero('0% discount $175')).toBe(false);
    expect(wdoFeeIsExplicitZero('0% discount')).toBe(false);
    expect(wdoFeeIsExplicitZero('0')).toBe(true);
    expect(wdoFeeIsExplicitZero('$0.00')).toBe(true);
  });

  test('projectCompletionInvoiceAmount falls back to linked WDO visit primary/estimated price before $250', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => jest.fn());
      const { projectCompletionInvoiceAmount } = require('../services/project-completion');

      expect(projectCompletionInvoiceAmount({
        project: { project_type: 'wdo_inspection', findings: { inspection_fee: '' } },
        scheduledService: { estimated_price: '150.00' },
      })).toBe(150);

      // Billable add-ons: primary_line_price wins over group estimated_price
      expect(projectCompletionInvoiceAmount({
        project: { project_type: 'wdo_inspection', findings: { inspection_fee: 'TBD' } },
        scheduledService: {
          primary_line_price: '175.00',
          estimated_price: '255.00',
          service_addons: [{ estimated_price: '80.00' }],
        },
      })).toBe(175);

      // Explicit $0 still overrides booked visit price
      expect(projectCompletionInvoiceAmount({
        project: { project_type: 'wdo_inspection', findings: { inspection_fee: '$0' } },
        scheduledService: { estimated_price: '175.00' },
      })).toBe(0);
    });
  });

  test('maybeRepriceWdoDraft preserves existing draft fee when inspection_fee is blank and visit has no price, and reprices from booked visit when present', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockDb = jest.fn();
      mockDb.fn = { now: jest.fn(() => 'NOW') };
      mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
      const mockInvoiceUpdate = jest.fn(async (id, patch) => ({
        id,
        status: 'draft',
        title: 'WDO Inspection',
        line_items: patch.line_items,
      }));

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../config', () => ({ jwt: { secret: 'test-jwt-secret' }, s3: { bucket: 'b', region: 'us-east-1' } }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/invoice', () => ({ update: mockInvoiceUpdate }));
      jest.doMock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn() }));
      jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
      jest.doMock('@anthropic-ai/sdk', () => jest.fn());
      jest.doMock('../services/property-lookup/ai-property-lookup', () => ({ lookupPropertyFromAITrio: jest.fn() }));

      const { _private: { maybeRepriceWdoDraft } } = require('../routes/admin-projects');

      const draft175 = {
        id: 'inv-draft-1',
        status: 'draft',
        title: 'WDO Inspection',
        line_items: [{ description: 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)', quantity: 1, unit_price: 175, amount: 175 }],
      };

      // Blank fee + no visit link: MUST keep $175 draft instead of overwriting with $250
      const kept = await maybeRepriceWdoDraft(draft175, { id: 'p-1', project_type: 'wdo_inspection', findings: { inspection_fee: '' } }, { database: mockDb });
      expect(kept).toBe(draft175);
      expect(mockInvoiceUpdate).not.toHaveBeenCalled();

      // Stale $250 draft + linked visit booked at $175 primary (+ $80 add-on): reprices to $175
      const draft250 = {
        ...draft175,
        line_items: [{ description: 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)', quantity: 1, unit_price: 250, amount: 250 }],
      };
      mockDb.mockImplementation((table) => {
        if (table === 'scheduled_services') return makeChain([{ id: 'ss-1', primary_line_price: '175.00', estimated_price: '255.00' }]);
        if (table === 'scheduled_service_addons') return makeChain([{ estimated_price: '80.00', base_price: '80.00' }]);
        return makeChain([]);
      });
      const repriced = await maybeRepriceWdoDraft(
        draft250,
        { id: 'p-2', project_type: 'wdo_inspection', scheduled_service_id: 'ss-1', findings: { inspection_fee: '' } },
        { database: mockDb },
      );
      expect(mockInvoiceUpdate).toHaveBeenCalledWith('inv-draft-1', expect.objectContaining({
        line_items: [expect.objectContaining({ unit_price: 175, amount: 175 })],
      }));
      expect(repriced.line_items[0].amount).toBe(175);
    });
  });
});

describe('B-26: report-only-payment-alert passes bellDefault: true and counts raised only when rang === true', () => {
  test('passes bellDefault: true and increments raised strictly when res.rang === true', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockDb = jest.fn();
      mockDb.raw = jest.fn((sql) => sql);
      const mockRaise = jest.fn();
      const mockClose = jest.fn();

      const records = [
        { id: 'sr-1', invoice_id: 'inv-1', customer_id: 'c-1', created_at: '2026-11-26T15:00:00Z', first_name: 'Synthetic', last_name: 'One', technician_name: 'Tech A' },
        { id: 'sr-2', invoice_id: 'inv-2', customer_id: 'c-2', created_at: '2026-11-26T15:00:00Z', first_name: 'Synthetic', last_name: 'Two', technician_name: 'Tech B' },
      ];
      const invoices = [
        { id: 'inv-1', status: 'draft', total: '129.00', amount_paid: '0', credit_applied: '0', payer_id: null },
        { id: 'inv-2', status: 'sent', total: '150.00', amount_paid: '0', credit_applied: '0', payer_id: null },
      ];
      let invoiceCall = 0;
      mockDb.mockImplementation((table) => {
        if (table === 'service_records as sr') return makeChain(records);
        if (table === 'invoices') {
          const row = invoices[Math.min(invoiceCall, invoices.length - 1)];
          invoiceCall += 1;
          return makeChain([row]);
        }
        if (table === 'notifications') return makeChain([]);
        return makeChain([]);
      });
      mockRaise
        .mockResolvedValueOnce({ id: 'n-1', rang: true })
        .mockResolvedValueOnce({ id: null, suppressed: true, rang: false });

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/admin-alert-episodes', () => ({
        raiseAdminAlertWithReopen: mockRaise,
        closeAdminAlertByDedupeKey: mockClose,
        openAdminAlertKeys: jest.fn().mockResolvedValue([]),
        closeAdminAlertKeys: jest.fn().mockResolvedValue(undefined),
      }));

      const { runReportOnlyPaymentCheck } = require('../services/report-only-payment-alert');
      const result = await runReportOnlyPaymentCheck({ now: new Date('2026-11-27T16:00:00Z') });

      expect(result.checked).toBe(2);
      expect(result.raised).toBe(1);
      expect(mockRaise).toHaveBeenCalledTimes(2);
      for (const call of mockRaise.mock.calls) {
        expect(call[0]).toBe('billing');
        expect(call[3]).toEqual(expect.objectContaining({ bellDefault: true }));
      }
    });
  });
});

describe('B-27: prepaid full credit / promo settlements invoke closeOutVisitForIssuedInvoice post-commit', () => {
  test('StripeService.settleHeldCoverage calls closeOutVisitForIssuedInvoice fail-soft', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockCloseout = jest.fn().mockRejectedValueOnce(new Error('transient closeout error'));
      const mockStop = jest.fn().mockResolvedValue(undefined);
      const mockPlans = jest.fn().mockResolvedValue(0);
      const mockSync = jest.fn().mockResolvedValue(undefined);
      const mockDb = jest.fn(() => makeChain([{ id: 'inv-held-1', status: 'prepaid' }]));
      mockDb.fn = { now: jest.fn(() => 'NOW') };
      mockDb.raw = jest.fn((sql) => sql);

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/customer-credit', () => ({
        applyAccountCreditToInvoice: jest.fn().mockResolvedValue({ fullyCovered: true, applied: 150 }),
      }));
      jest.doMock('../services/invoice-followups', () => ({ stopOnPayment: mockStop }));
      jest.doMock('../services/payment-plans', () => ({ completeActivePlansForPaidInvoice: mockPlans }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: mockSync }));
      jest.doMock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: mockCloseout }));

      const StripeService = require('../services/stripe');
      const res = await StripeService.settleHeldCoverage('inv-held-1');

      expect(res).toEqual({ settled: true, alreadySettled: false, reason: null });
      expect(mockStop).toHaveBeenCalledWith('inv-held-1');
      expect(mockPlans).toHaveBeenCalledWith('inv-held-1', 'credit_coverage');
      expect(mockCloseout).toHaveBeenCalledWith({ invoiceId: 'inv-held-1', trigger: 'paid' });
    });
  });

  test('customer-credit.runPostFullCoverageSideEffects calls closeOutVisitForIssuedInvoice fail-soft', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.dontMock('../services/customer-credit');
      const mockCloseout = jest.fn().mockResolvedValue({ closed: false, reason: 'report_after_pay_held' });
      const mockDb = jest.fn(() => makeChain([{ id: 'inv-cc-1', status: 'prepaid' }]));
      mockDb.fn = { now: jest.fn(() => 'NOW') };
      mockDb.raw = jest.fn((sql) => sql);

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn().mockResolvedValue(undefined) }));
      jest.doMock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn().mockResolvedValue(undefined) }));
      jest.doMock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: mockCloseout }));

      const { runPostFullCoverageSideEffects } = require('../services/customer-credit');
      await runPostFullCoverageSideEffects('inv-cc-1');

      expect(mockCloseout).toHaveBeenCalledWith({ invoiceId: 'inv-cc-1', trigger: 'paid' });
    });
  });

  test('POST /api/admin/invoices/:id/apply-credit invokes closeOutVisitForIssuedInvoice post-commit when fully covered', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockCloseout = jest.fn().mockRejectedValueOnce(new Error('non-fatal closeout error'));
      const invoiceRow = {
        id: 'inv-apply-1',
        customer_id: 'cust-1',
        invoice_number: 'WPC-2026-9901',
        status: 'sent',
        total: '129.00',
        amount_paid: '0.00',
        credit_applied: '0.00',
        payer_id: null,
        stripe_payment_intent_id: null,
        scheduled_service_id: 'ss-1',
      };
      const prepaidRow = { ...invoiceRow, status: 'prepaid', credit_applied: '129.00', paid_at: '2026-11-27T16:00:00Z' };
      const mockDb = jest.fn((table) => {
        if (table === 'invoices') {
          const q = makeChain([prepaidRow]);
          q.first = jest.fn()
            .mockResolvedValueOnce(invoiceRow) // pre-read
            .mockResolvedValueOnce(invoiceRow) // locked read
            .mockResolvedValueOnce(prepaidRow) // syncTerm fresh
            .mockResolvedValueOnce(prepaidRow); // final response
          return q;
        }
        if (table === 'customers') return makeChain([{ id: 'cust-1' }]);
        if (table === 'payments' || table === 'payment_plans') return makeChain([]);
        return makeChain([]);
      });
      mockDb.fn = { now: jest.fn(() => 'NOW') };
      mockDb.raw = jest.fn((sql) => sql);
      mockDb.transaction = jest.fn(async (cb) => cb(mockDb));

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/stripe', () => ({
        assertNoInvoiceChargeReconciliationPending: jest.fn().mockResolvedValue(undefined),
        retrievePaymentIntent: jest.fn(),
        cancelPaymentIntent: jest.fn(),
      }));
      jest.doMock('../services/customer-credit', () => ({
        round2: (n) => Math.round(Number(n || 0) * 100) / 100,
        getBalance: jest.fn().mockResolvedValue(200),
        postCreditMovement: jest.fn().mockResolvedValue({ balanceAfter: 71 }),
      }));
      jest.doMock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn().mockResolvedValue(undefined) }));
      jest.doMock('../services/payment-plans', () => ({
        completeActivePlansForPaidInvoice: jest.fn().mockResolvedValue(0),
        completeActivePlansForInvoice: jest.fn().mockResolvedValue(0),
      }));
      jest.doMock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn().mockResolvedValue(undefined) }));
      jest.doMock('../services/annual-prepay-renewals', () => ({
        syncTermForInvoicePayment: jest.fn().mockResolvedValue(undefined),
        acquireTermiteGateAtEntry: jest.fn().mockResolvedValue([]),
      }));
      jest.doMock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: mockCloseout }));
      jest.doMock('../middleware/admin-auth', () => ({
        adminAuthenticate: (req, _res, next) => next(),
        requireAdmin: (req, _res, next) => next(),
        requireTechOrAdmin: (req, _res, next) => next(),
      }));

      const invoicesRouter = require('../routes/admin-invoices');
      const layer = invoicesRouter.stack.find((l) => l.route?.path === '/:id/apply-credit' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;

      let statusCode = 200;
      let payload = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(body) { payload = body; return this; },
      };
      const req = {
        params: { id: 'inv-apply-1' },
        body: { note: 'Synthetic credit apply' },
        technicianId: 'admin-1',
        techRole: 'admin',
        technician: { name: 'Synthetic Admin' },
      };
      await handler(req, res, (err) => { throw err; });

      expect(statusCode).toBe(200);
      expect(payload).toMatchObject({ ok: true, fully_covered: true, applied: 129, balance: 71 });
      expect(mockCloseout).toHaveBeenCalledWith({
        invoiceId: 'inv-apply-1',
        trigger: 'paid',
        actorTechnicianId: 'admin-1',
        actorRole: 'admin',
      });
    });
  });

  test('stripe.js chargeInvoiceWithSavedCard and createInvoicePaymentIntent both route coveredByCredit through runCreditCoveragePostSettlement', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/stripe.js'), 'utf8');
    // Verify the shared helper invokes closeOutVisitForIssuedInvoice({ invoiceId, trigger: 'paid' })
    // and all 3 credit-coverage settlement paths call it.
    expect(src).toMatch(/async function runCreditCoveragePostSettlement[\s\S]*closeOutVisitForIssuedInvoice\(\{ invoiceId, trigger: 'paid' \}\)/);
    const callMatches = src.match(/await runCreditCoveragePostSettlement\(invoiceId,/g) || [];
    expect(callMatches.length).toBe(3);
  });
});

describe('B-33: WDO report-hold probes on manual-payment undo, voidInvoice, and reverse-prepaid', () => {
  test('manualPaymentUndoRefusal blocks undo when linked WDO report was released or is releasing', async () => {
    await jest.isolateModulesAsync(async () => {
      const nowIso = new Date().toISOString();
      const mockDb = jest.fn((table) => {
        if (table === 'audit_log') {
          const q = makeChain([{
            created_at: nowIso,
            metadata: { paymentId: 'pay-1', partial: false, automated: false },
          }]);
          q.first = jest.fn(async () => ({ id: 'audit-done-1' }));
          return q;
        }
        if (table === 'payments') {
          return makeChain([{
            id: 'pay-1',
            customer_id: 'cust-1',
            status: 'paid',
            amount: '175.00',
            created_at: nowIso,
          }]);
        }
        if (table === 'projects') return makeChain([{ id: 'proj-wdo-1' }]);
        return makeChain([]);
      });
      mockDb.raw = jest.fn(async (sql) => ({
        rows: String(sql).includes('FROM projects') ? [{ '?column?': 1 }] : [],
      }));
      jest.doMock('../models/db', () => mockDb);

      const { manualPaymentUndoRefusal } = require('../services/invoice-manual-payment-undo');
      const { refusal } = await manualPaymentUndoRefusal(
        mockDb,
        {
          id: 'inv-wdo-1',
          customer_id: 'cust-1',
          invoice_number: 'WPC-1',
          status: 'paid',
          payment_method: 'cash',
          total: '175.00',
          amount_paid: '175.00',
          payment_recorded_at: nowIso,
          updated_at: nowIso,
        },
      );

      expect(refusal).toEqual(expect.objectContaining({
        code: 'wdo_report_released',
      }));
      expect(refusal.message).toMatch(/WDO report/i);
    });
  });

  test('reconcileWdoReportHoldOnInvoiceVoid refuses releasing holds & released settled invoices, clears open holds, and flags closed holds', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockAudit = jest.fn().mockResolvedValue('audit-1');
      jest.doMock('../services/audit-log', () => ({ recordAuditEvent: mockAudit }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../models/db', () => jest.fn());

      const {
        reconcileWdoReportHoldOnInvoiceVoid,
        assertNoReleasedWdoReportHoldForInvoice,
      } = require('../services/project-report-hold');

      const buildTrx = (projectRows) => {
        const updateCalls = [];
        const trx = jest.fn((table) => {
          if (table === 'projects') {
            const q = makeChain(projectRows);
            q.update = jest.fn((patch) => { updateCalls.push(patch); return Promise.resolve(1); });
            return q;
          }
          return makeChain([]);
        });
        trx.fn = { now: jest.fn(() => 'NOW') };
        trx.updateCalls = updateCalls;
        return trx;
      };

      // 1. Releasing hold → refused with "Cannot void ..."
      await expect(reconcileWdoReportHoldOnInvoiceVoid(
        buildTrx([{ id: 'p-1', status: 'in_progress', project_type: 'wdo_inspection', report_hold_status: 'releasing' }]),
        { id: 'inv-1', invoice_number: 'WPC-1' },
        { priorStatus: 'sent' },
      )).rejects.toThrow(/^Cannot void.*being sent/i);

      // 2. Prepaid invoice whose report was already released → refused with "Cannot void ..."
      await expect(reconcileWdoReportHoldOnInvoiceVoid(
        buildTrx([{ id: 'p-2', status: 'sent', project_type: 'wdo_inspection', report_hold_status: 'released', report_hold_released_at: '2026-11-27T12:00:00Z' }]),
        { id: 'inv-2', invoice_number: 'WPC-2' },
        { priorStatus: 'prepaid', priorPrepaidAt: '2026-11-27T11:59:00Z' },
      )).rejects.toThrow(/^Cannot void.*already released/i);

      // 3. Unpaid held invoice on an OPEN project → clears hold & unlinks invoice_id
      mockAudit.mockClear();
      const openTrx = buildTrx([{ id: 'p-open', status: 'in_progress', project_type: 'wdo_inspection', report_hold_status: 'held' }]);
      const openRes = await reconcileWdoReportHoldOnInvoiceVoid(openTrx, { id: 'inv-3', invoice_number: 'WPC-3' }, { priorStatus: 'sent' });
      expect(openRes).toEqual({ clearedProjectIds: ['p-open'] });
      expect(openTrx.updateCalls[0]).toMatchObject({
        report_hold_status: null,
        report_hold_at: null,
        invoice_id: null,
      });
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'wdo.report_hold_cleared_on_invoice_void',
        resource_id: 'p-open',
      }));

      // 4. Unpaid held invoice on a CLOSED project → keeps hold visible & stamps error
      mockAudit.mockClear();
      const closedTrx = buildTrx([{ id: 'p-closed', status: 'closed', project_type: 'wdo_inspection', report_hold_status: 'held' }]);
      const closedRes = await reconcileWdoReportHoldOnInvoiceVoid(closedTrx, { id: 'inv-4', invoice_number: 'WPC-4' }, { priorStatus: 'sent' });
      expect(closedRes).toEqual({ clearedProjectIds: [] });
      expect(closedTrx.updateCalls[0]).toMatchObject({
        report_hold_next_attempt_at: null,
      });
      expect(closedTrx.updateCalls[0].report_hold_last_error).toMatch(/voided/i);
      expect(closedTrx.updateCalls[0]).not.toHaveProperty('invoice_id');
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'wdo.report_hold_flagged_on_invoice_void',
        resource_id: 'p-closed',
      }));

      // 5. reverse-prepaid guard: throws 409 operational when prepaid + released, no-op when when=false
      const releasedTrx = buildTrx([{ id: 'p-rel', status: 'sent', project_type: 'wdo_inspection', report_hold_status: 'released', report_hold_released_at: '2026-11-27T12:00:00Z' }]);
      await expect(assertNoReleasedWdoReportHoldForInvoice(releasedTrx, 'inv-5', { lock: true, action: 'reverse_prepaid', when: true }))
        .rejects.toMatchObject({ statusCode: 409, isOperational: true, code: 'wdo_report_released' });
      await expect(assertNoReleasedWdoReportHoldForInvoice(releasedTrx, 'inv-5', { lock: true, action: 'reverse_prepaid', when: false }))
        .resolves.toBeNull();
    });
  });
});

describe('B-48: disputed invoices surfaced in WDO attention & blocked in send-with-invoice and report-hold', () => {
  test('wdo-report-attention summarize labels disputed stuck holds and project-report-hold blocks disputed invoices', async () => {
    const { _private: { summarize } } = require('../services/wdo-report-attention');
    const summary = summarize({
      signedUnsent: [],
      stuckAppts: [],
      stuckHolds: [{ id: 'p-1', invoice_status: 'disputed' }],
    });
    expect(summary).toContain('1 disputed');

    const { assertNoPaymentStarted } = require('../services/project-report-hold');
    await expect(assertNoPaymentStarted({ status: 'disputed', amount_paid: 0, credit_applied: 0 }))
      .rejects.toThrow(/already started/i);
  });

  test('send-with-invoice returns 409 invoice_disputed on both dry_run preview and send when linked invoice is disputed', async () => {
    await jest.isolateModulesAsync(async () => {
      const disputedInvoice = {
        id: 'inv-disp-1',
        customer_id: 'cust-1',
        invoice_number: 'WPC-2026-4800',
        status: 'disputed',
        total: '175.00',
      };
      const projectRow = {
        id: 'proj-disp-1',
        customer_id: 'cust-1',
        project_type: 'wdo_inspection',
        project_date: '2026-11-27',
        status: 'in_progress',
        invoice_id: 'inv-disp-1',
        wdo_signature: { image: 'data:image/png;base64,AA', signer_name: 'Synthetic Licensee', signed_at: '2026-11-27T10:00:00Z' },
        findings: {
          property_address: '100 Synthetic Rd, Testville, FL 34200',
          inspection_fee: '175',
          wdo_finding: 'No visible signs of WDO observed',
          inspection_scope: 'Entire accessible structure',
        },
        report_hold_status: null,
      };
      const customerRow = {
        id: 'cust-1',
        first_name: 'Synthetic',
        last_name: 'Homeowner',
        email: 'synthetic@example.invalid',
      };
      const mockDb = jest.fn((table) => {
        if (table === 'projects') return makeChain([projectRow]);
        if (table === 'customers') return makeChain([customerRow]);
        if (table === 'invoices') return makeChain([disputedInvoice]);
        if (table === 'project_photos') return makeChain([]);
        return makeChain([]);
      });
      mockDb.fn = { now: jest.fn(() => 'NOW') };
      mockDb.raw = jest.fn((sql) => sql);
      mockDb.transaction = jest.fn(async (cb) => cb(mockDb));

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../config', () => ({ jwt: { secret: 'test-jwt-secret' }, s3: { bucket: 'b', region: 'us-east-1' } }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../middleware/admin-auth', () => ({
        adminAuthenticate: (req, _res, next) => next(),
        requireAdmin: (req, _res, next) => next(),
        requireTechOrAdmin: (req, _res, next) => next(),
      }));
      jest.doMock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn() }));
      jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
      jest.doMock('@anthropic-ai/sdk', () => jest.fn());
      jest.doMock('../services/property-lookup/ai-property-lookup', () => ({ lookupPropertyFromAITrio: jest.fn() }));

      const projectsRouter = require('../routes/admin-projects');
      const layer = projectsRouter.stack.find((l) => l.route?.path === '/:id/send-with-invoice' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;

      for (const body of [{ dry_run: true }, { dry_run: false }, { dry_run: true, invoice_id: 'inv-disp-1' }]) {
        let statusCode = 200;
        let payload = null;
        const res = {
          status(code) { statusCode = code; return this; },
          json(b) { payload = b; return this; },
        };
        await handler(
          { params: { id: 'proj-disp-1' }, body, technicianId: 'admin-1', techRole: 'admin' },
          res,
          (err) => { throw err; },
        );
        expect(statusCode).toBe(409);
        expect(payload.code).toBe('invoice_disputed');
        expect(payload.invoice_id).toBe('inv-disp-1');
      }
    });
  });
});

describe('B-58: held WDO project suppresses title, recommendations, and legacy/shared PDF reports until released', () => {
  test('completionTechnicianNotes and service-record builders omit title and recommendations when reportHeld is true', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => jest.fn());
      const {
        completionTechnicianNotes,
        buildServiceRecordInsert,
        buildServiceRecordProjectCompletionUpdate,
      } = require('../services/project-completion');

      const project = {
        id: 'proj-wdo-held',
        project_type: 'wdo_inspection',
        title: 'Active Subterranean Termite Finding',
        recommendations: 'Immediate soil treatment recommended',
        project_date: '2026-11-27',
      };

      expect(completionTechnicianNotes(project, { reportHeld: true })).toBe('Project completed.');
      expect(completionTechnicianNotes(project, { reportHeld: false })).toContain('Active Subterranean Termite Finding');

      const profile = {
        completionMode: 'report_only',
        portalVisibility: 'after_pay',
        portalAttachPolicy: 'on_send',
        serviceName: 'WDO Inspection',
      };
      const serviceRecordCols = {
        status: true,
        scheduled_service_id: true,
        service_line: true,
        structured_notes: true,
        completion_source: true,
        protocol_defaults_used: true,
        service_data: true,
      };
      const insertRow = buildServiceRecordInsert({
        project,
        profile,
        serviceRecordCols,
        scheduledService: { id: 'ss-1', customer_id: 'cust-1', service_type: 'WDO Inspection', scheduled_date: '2026-11-27' },
        portalAttached: false,
        reportHeld: true,
      });
      expect(insertRow.technician_notes).toBe('Project completed.');
      const insertNotes = JSON.parse(insertRow.structured_notes);
      expect(insertNotes.projectTitle).toBeNull();
      expect(insertNotes.reportHeld).toBe(true);

      const updateRow = buildServiceRecordProjectCompletionUpdate({
        serviceRecord: { technician_notes: null, structured_notes: '{}' },
        project,
        profile,
        serviceRecordCols,
        portalAttached: false,
        reportHeld: true,
      });
      expect(updateRow.status).toBe('completed');
      const updateNotes = JSON.parse(updateRow.structured_notes);
      expect(updateNotes.projectTitle).toBeNull();
      expect(updateNotes.reportHeld).toBe(true);
    });
  });

  test('documents.js blocks /service-report/:id, /share/auto_report_:id, and /shared/:token with 404 while WDO hold is active', async () => {
    await jest.isolateModulesAsync(async () => {
      const heldRecord = {
        id: 'sr-held-wdo',
        customer_id: 'cust-1',
        service_date: '2026-11-27',
        service_type: 'WDO Inspection',
        structured_notes: JSON.stringify({
          projectCompletion: true,
          projectId: 'proj-wdo-held',
          projectType: 'wdo_inspection',
          reportHeld: true,
        }),
      };
      const shareToken = 'a'.repeat(64);
      const shareLinkRow = {
        id: 'link-1',
        service_record_id: 'sr-held-wdo',
        customer_id: 'cust-1',
        share_token: shareToken,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      };
      const mockDb = jest.fn((table) => {
        if (table === 'service_records') return makeChain([heldRecord]);
        if (table === 'projects') return makeChain([{ report_hold_status: 'held' }]);
        if (table === 'document_share_links') return makeChain([shareLinkRow]);
        return makeChain([]);
      });
      mockDb.raw = jest.fn((sql) => sql);

      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../middleware/auth', () => ({ authenticate: (_req, _res, next) => next() }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

      const documentsRouter = require('../routes/documents');
      const invoke = async (method, routePath, req) => {
        const layer = documentsRouter.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        let statusCode = 200;
        let payload = null;
        const res = {
          status(code) { statusCode = code; return this; },
          json(b) { payload = b; return this; },
        };
        await handler(req, res, (err) => { throw err; });
        return { statusCode, payload };
      };

      const pdfRes = await invoke('get', '/service-report/:serviceRecordId', {
        params: { serviceRecordId: 'sr-held-wdo' },
        customerId: 'cust-1',
      });
      expect(pdfRes.statusCode).toBe(404);

      const shareRes = await invoke('post', '/share/:id', {
        params: { id: 'auto_report_sr-held-wdo' },
        customerId: 'cust-1',
      });
      expect(shareRes.statusCode).toBe(404);

      const publicRes = await invoke('get', '/shared/:token', {
        params: { token: shareToken },
      });
      expect(publicRes.statusCode).toBe(404);
    });
  });

  test('pre-push fixes: trailing comma fee text, discounted multi-addon refusal, report_token revocation on void, pre-closeout service_record_id hold & fee redaction', async () => {
    const { parseWdoFeeAmount } = require('@waves/report-redaction');
    expect(parseWdoFeeAmount('$0, waived')).toBe(0);
    expect(parseWdoFeeAmount('$175, due at closing')).toBe(175);
    expect(parseWdoFeeAmount('$1,250, due at closing')).toBe(1250);
    expect(parseWdoFeeAmount('$1,23, due')).toBeNull();

    const { bookedWdoVisitFee } = require('../services/wdo-inspection-fee');
    expect(bookedWdoVisitFee({
      primary_line_price: 175,
      estimated_price: 230,
      service_addons: [{ estimated_price: 80 }],
    })).toBeNull();
    expect(bookedWdoVisitFee({
      primary_line_price: 175,
      estimated_price: 255,
      service_addons: [{ estimated_price: 80 }],
    })).toBe(175);

    const { projectRecordedFeeValues } = require('../services/project-types');
    expect(projectRecordedFeeValues(
      { project_type: 'wdo_inspection', findings: { inspection_fee: '' } },
      { scheduledService: { estimated_price: 175 } },
    )).toEqual(['175', 250]);

    await jest.isolateModulesAsync(async () => {
      const updates = [];
      const heldProject = {
        id: 'proj-open-void',
        status: 'scheduled',
        report_hold_status: 'held',
        report_token: 'tok-stale-123',
        invoice_id: 'inv-void',
      };
      const dbMock = jest.fn((table) => {
        const q = makeChain(table === 'projects' ? [heldProject] : []);
        q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
        return q;
      });
      dbMock.fn = { now: jest.fn(() => 'NOW') };
      jest.doMock('../models/db', () => dbMock);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => null) }));

      const { reconcileWdoReportHoldOnInvoiceVoid, isServiceRecordProjectReportHeld } = require('../services/project-report-hold');
      await reconcileWdoReportHoldOnInvoiceVoid(dbMock, { id: 'inv-void' });
      expect(updates[0]).toMatchObject({ report_hold_status: null, report_token: null, invoice_id: null });

      // Pre-closeout service_record without stamped projectType/projectId still checks projects.service_record_id
      expect(await isServiceRecordProjectReportHeld({}, dbMock, { serviceRecordId: 'sr-precloseout' })).toBe(true);
    });
  });
});
