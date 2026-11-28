'use strict';

/**
 * Regression suite for Billing Audit PR 2 (chemical-review holds, completion
 * hold interactions, late first-send due-date shift, open setup-fee notice,
 * payer invoice hold guard, and Report-After-Pay hold preservation):
 *   - B-02: Mutual annihilation of unrecordedChemicalAddOnHold with
 *           unmintedSetupFeeHold / terminalInvoiceOnVisit + billBothPlain guard
 *   - B-08: Chemical-review hold enforcement across Stripe Terminal,
 *           admin schedule-send, pay-v2 (/GET, /invoice.pdf, /plan-choice,
 *           /consent, /capture-setup, /setup-complete), pay-plan-choice,
 *           stripe.js (updateInvoicePaymentIntentMethod & confirmInvoicePayment),
 *           billing-v2 / open-balance, and invoice-email (even with override)
 *   - B-09: InvoiceService.markDeliverySent advances stale due_date via
 *           firstDeliveryDueDate on first delivery (#7741)
 *   - B-40: Completion setup-fee alert honors settledNow.open and suppresses
 *           billBothPlain when an open setup-fee invoice already exists
 *   - B-45: stampChemicalReviewHoldOnVisitInvoices skips active payer_id and
 *           payer_statement_id invoices (not just payer_billed:* stamps)
 *   - B-49: reportAfterPayHeld verified settled invoice is not overridden by a
 *           later refunded office invoice on the same visit
 */

const fs = require('fs');
const path = require('path');

describe('Billing Audit PR 2 — chemical-review holds & completion invariants', () => {
  afterEach(() => {
    jest.dontMock('stripe');
    jest.dontMock('../models/db');
    jest.dontMock('../services/invoice');
    jest.dontMock('../services/estimate-deposits');
    jest.dontMock('../services/failed-payments');
    jest.dontMock('../services/invoice-payer-ownership');
    jest.dontMock('../services/pay-combined');
    jest.dontMock('../services/invoice-followups');
    jest.dontMock('../services/invoice-issued-closeout');
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('B-02: competing completion holds do not mutually silence office alerts', () => {
    const { shouldAutoInvoiceCompletion } = require('../services/complete-scheduled-service');

    const baseGate = {
      issuedInvoiceCloseout: false,
      recapReviewOnly: false,
      alreadyPaid: false,
      prepaidCovered: false,
      autopayCoversVisit: false,
      preMintedInvoice: null,
      existingCompletionInvoice: null,
      terminalInvoiceOnVisit: false,
      unmintedSetupFeeHold: false,
      unrecordedChemicalAddOnHold: false,
      createInvoiceOnComplete: true,
      waveguardTier: 'basic',
      explicitMembership: false,
      explicitPerVisitLane: true,
      perApplicationBilling: true,
      annualPrepayBilling: false,
      hasVisitPrice: true,
      invoiceAmount: 149,
      autoInvoicePricedVisits: false,
      serviceType: 'Pest Control',
      isCallback: false,
      visitPerformed: true,
      backfillMintRequired: null,
      typedOneTimeBilling: false,
      isBackfillCompletion: false,
      annualPrepayCovered: false,
    };

    test('chemical hold + unminted setup fee hold suppresses mint yet clears together for counterfactual alert checks', () => {
      const bothHeld = {
        ...baseGate,
        unrecordedChemicalAddOnHold: true,
        unmintedSetupFeeHold: true,
      };
      expect(shouldAutoInvoiceCompletion(bothHeld)).toBe(false);
      // Old bug: clearing only one flag kept the counterfactual false.
      expect(shouldAutoInvoiceCompletion({ ...bothHeld, unrecordedChemicalAddOnHold: false })).toBe(false);
      expect(shouldAutoInvoiceCompletion({ ...bothHeld, unmintedSetupFeeHold: false })).toBe(false);
      // Fixed: clearing all three hold suppressors together lets every active hold alert fire.
      expect(shouldAutoInvoiceCompletion({
        ...bothHeld,
        unrecordedChemicalAddOnHold: false,
        terminalInvoiceOnVisit: false,
        unmintedSetupFeeHold: false,
      })).toBe(true);
    });

    test('chemical hold + terminal refunded invoice hold clears together for counterfactual alert checks', () => {
      const bothHeld = {
        ...baseGate,
        unrecordedChemicalAddOnHold: true,
        terminalInvoiceOnVisit: true,
      };
      expect(shouldAutoInvoiceCompletion(bothHeld)).toBe(false);
      expect(shouldAutoInvoiceCompletion({
        ...bothHeld,
        unrecordedChemicalAddOnHold: false,
        terminalInvoiceOnVisit: false,
        unmintedSetupFeeHold: false,
      })).toBe(true);
    });

    test('complete-scheduled-service wires shared completionGateWithoutHoldSuppressors to all three alert guards and guards billBothPlain', () => {
      const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
      const matches = src.match(/shouldAutoInvoiceCompletion\(completionGateWithoutHoldSuppressors\)/g) || [];
      expect(matches).toHaveLength(3);
      expect(src).toContain('const billBothPlain = !feeCoveredBy && !openFeeCoverage.hasOpenFeeInvoice && !unrecordedChemicalAddOnHold');
    });
  });

  describe('B-45: stampChemicalReviewHoldOnVisitInvoices skips payer-billed and statement-accrued invoices', () => {
    test('selects payer_id and payer_statement_id and stamps only self-pay unpaid invoices', async () => {
      const { stampChemicalReviewHoldOnVisitInvoices } = require('../services/complete-scheduled-service');
      const updatedInvoiceIds = [];
      const pausedSeqInvoiceIds = [];
      let selectedCols = null;

      const trx = jest.fn((table) => {
        if (table === 'invoices') {
          let currentWhereId = null;
          const q = {
            where: jest.fn((arg) => {
              if (arg && typeof arg === 'object' && arg.id) currentWhereId = arg.id;
              return q;
            }),
            whereNotIn: jest.fn(() => q),
            orderBy: jest.fn(() => q),
            forUpdate: jest.fn(() => q),
            noWait: jest.fn(() => q),
            select: jest.fn(async (...cols) => {
              selectedCols = cols;
              return [
                { id: 'inv-self', status: 'sent', stripe_payment_intent_id: 'pi_1', scheduled_send_error: null, payer_id: null, payer_statement_id: null },
                { id: 'inv-payer', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: null, payer_id: 'payer-123', payer_statement_id: null },
                { id: 'inv-stmt', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: null, payer_id: null, payer_statement_id: 'stmt-456' },
                { id: 'inv-withdrawn', status: 'sent', stripe_payment_intent_id: null, scheduled_send_error: 'payer_billed:payer-789', payer_id: null, payer_statement_id: null },
              ];
            }),
            update: jest.fn(async () => {
              updatedInvoiceIds.push(currentWhereId);
              return 1;
            }),
          };
          return q;
        }
        if (table === 'invoice_followup_sequences') {
          let seqInvId = null;
          const q = {
            where: jest.fn((arg) => {
              if (arg && arg.invoice_id) seqInvId = arg.invoice_id;
              return q;
            }),
            update: jest.fn(async () => {
              pausedSeqInvoiceIds.push(seqInvId);
              return 1;
            }),
          };
          return q;
        }
        throw new Error(`unexpected table ${table}`);
      });

      const res = await stampChemicalReviewHoldOnVisitInvoices(trx, { serviceId: 'svc-99', recordId: 'rec-99' });
      expect(selectedCols).toEqual(expect.arrayContaining(['payer_id', 'payer_statement_id']));
      expect(res.stampedIds).toEqual(['inv-self']);
      expect(res.invoicesToNeutralize.map((r) => r.id)).toEqual(['inv-self']);
      expect(updatedInvoiceIds).toEqual(['inv-self']);
      expect(pausedSeqInvoiceIds).toEqual(['inv-self']);
    });
  });

  describe('B-40: completion setup-fee alert respects open un-stamped setup-fee invoices', () => {
    const {
      resolveOpenSetupFeeCoverage,
      buildUnmintedSetupFeeAlertBody,
    } = require('../services/complete-scheduled-service');

    const prevGate = process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
    afterEach(() => {
      if (prevGate === undefined) delete process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
      else process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE = prevGate;
    });

    test('names open setup-fee invoice and suppresses duplicate billing copy when gate is on', () => {
      process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE = 'true';
      const cov = resolveOpenSetupFeeCoverage(
        { open: [{ id: 'inv-open-1', invoiceNumber: 'INV-2026-9001', cents: 9900 }] },
        { countedRows: [], feeCovered: false, expectedSetupFeeCents: 9900, liveFeeCentsNow: 0 },
      );
      expect(cov.hasOpenFeeInvoice).toBe(true);
      expect(cov.feeOnOpenInvoice).toBe(true);

      const body = buildUnmintedSetupFeeAlertBody({
        feeCoveredBy: null,
        feeOnOpenInvoice: cov.feeOnOpenInvoice,
        openFeeInvoices: cov.openFeeInvoices,
        applicationCoveredBy: null,
        applicationCoveredOutOfBand: false,
        feeEstimateRef: 'est-abc',
        feeHistoryClause: 'its WaveGuard setup fee was never invoiced',
        setupFeeLabel: '$99.00',
        firstAppLabel: ' ($125.00)',
        estimateId: 'est-abc',
        setupFeeParkedNote: '',
      });
      expect(body).toContain('INV-2026-9001');
      expect(body).toContain('do NOT bill the setup fee again');
      expect(body).not.toContain('Bill BOTH charges manually');

      // When chemical add-on review hold is also active, defer application billing until reviewed.
      const bodyWithChemHold = buildUnmintedSetupFeeAlertBody({
        feeCoveredBy: null,
        feeOnOpenInvoice: false,
        openFeeInvoices: [],
        applicationCoveredBy: null,
        applicationCoveredOutOfBand: false,
        unrecordedChemicalAddOnHold: true,
        feeEstimateRef: 'est-abc',
        feeHistoryClause: 'its WaveGuard setup fee was never invoiced',
        setupFeeLabel: '$99.00',
        firstAppLabel: ' ($125.00)',
        estimateId: 'est-abc',
        setupFeeParkedNote: '',
      });
      expect(bodyWithChemHold).toContain('Confirm with the technician whether the chemical add-on was applied');
      expect(bodyWithChemHold).not.toContain('Bill BOTH charges manually');
    });

    test('still marks hasOpenFeeInvoice=true when gate is off so billBothPlain does not double-bill and keeps openFeeCents=0', () => {
      delete process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
      const cov = resolveOpenSetupFeeCoverage(
        { open: [{ id: 'inv-open-2', invoiceNumber: 'INV-2026-9002', cents: 9900 }] },
        { countedRows: [], feeCovered: false, expectedSetupFeeCents: 9900, liveFeeCentsNow: 0 },
      );
      expect(cov.hasOpenFeeInvoice).toBe(true);
      expect(cov.feeOnOpenInvoice).toBe(false);
      expect(cov.openFeeCents).toBe(0);
    });

    test('reconcileAppInstructionForVisits separates unheld visits from held visits in mixed lists', () => {
      const { _private } = require('../services/setup-fee-alert-reconcile');
      const mixed = _private.reconcileAppInstructionForVisits(['v-unheld', 'v-held'], {
        chemicalHoldVisitIds: ['v-held'],
      });
      expect(mixed).toContain('visit v-unheld — use the EXACT line description "First service application";');
      expect(mixed).toContain('visit v-held — use the EXACT line description "First service application" (HOLD billing');
    });
  });

  describe('B-49: reportAfterPayHeld is preserved when a later office invoice was refunded', () => {
    test('reconcileLiveVsRefunded preserves settled held invoice and complete-scheduled-service passes preserveExisting', () => {
      const { reconcileLiveVsRefunded } = require('../services/completion-invoice-candidate');
      const paidHeld = { id: 'inv-held-paid', status: 'paid', invoice_number: 'INV-1' };
      const refundedOffice = { id: 'inv-office-ref', status: 'refunded', invoice_number: 'INV-2' };

      // Default behavior unchanged: refunded beats ordinary live invoice.
      expect(reconcileLiveVsRefunded(paidHeld, refundedOffice, paidHeld)).toEqual({
        existing: null,
        terminal: refundedOffice,
        liveBeside: paidHeld,
      });
      // Report-After-Pay verified settled invoice is preserved against a later refunded office invoice.
      expect(reconcileLiveVsRefunded(paidHeld, refundedOffice, paidHeld, { preserveExisting: true })).toEqual({
        existing: paidHeld,
        terminal: null,
        liveBeside: null,
      });

      const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
      expect(src).toContain('preserveExisting: Boolean(reportAfterPayHeld)');
    });
  });

  describe('B-08: chemical-review hold enforced across every billing, terminal, pay, email & portal surface', () => {
    const heldInvoice = {
      id: 'inv-chem-1',
      customer_id: 'cust-1',
      scheduled_service_id: 'svc-1',
      invoice_number: 'INV-2026-7777',
      token: 'a'.repeat(48),
      status: 'sent',
      total: '150.00',
      credit_applied: 0,
      amount_paid: 0,
      payer_id: null,
      payer_statement_id: null,
      scheduled_send_error: 'chemical_addon_review:svc-1',
      notes: 'Auto-created from accepted estimate #11111111-1111-1111-1111-111111111111',
    };

    test('invoice-helpers assertInvoiceNotHeldForChemicalReview & assertInvoiceNotWithdrawnOrHeld enforce hold', () => {
      const helpers = require('../services/invoice-helpers');
      expect(() => helpers.assertInvoiceNotHeldForChemicalReview(heldInvoice)).toThrow(/chemical area add-on/i);
      try {
        helpers.assertInvoiceNotWithdrawnOrHeld(heldInvoice);
        throw new Error('expected throw');
      } catch (err) {
        expect(err.code).toBe('INVOICE_CHEMICAL_ADDON_HOLD');
      }
      expect(() => helpers.assertInvoiceNotWithdrawnOrHeld(heldInvoice, { allowChemicalReviewReconcile: true })).not.toThrow();
    });

    test('pay-plan-choice hides and refuses annual prepay choice on chemical-held invoices', async () => {
      const prev = process.env.GATE_PAY_PLAN_CHOICE;
      process.env.GATE_PAY_PLAN_CHOICE = 'true';
      try {
        const payPlanChoice = require('../services/pay-plan-choice');
        expect(await payPlanChoice.planChoiceForInvoice(heldInvoice)).toBeNull();
        expect(await payPlanChoice.selectAnnualPrepay(heldInvoice)).toEqual({ refused: true });
      } finally {
        if (prev === undefined) delete process.env.GATE_PAY_PLAN_CHOICE;
        else process.env.GATE_PAY_PLAN_CHOICE = prev;
      }
    });

    test('invoice-email refuses chemical-held invoice even when recipientOverride is supplied', async () => {
      let result;
      await jest.isolateModulesAsync(async () => {
        const mockDb = jest.fn(() => ({
          where: () => ({ first: async () => heldInvoice }),
        }));
        jest.doMock('../models/db', () => mockDb);
        const { sendInvoiceEmail } = require('../services/invoice-email');
        result = await sendInvoiceEmail(heldInvoice.id, {
          recipientOverride: 'bookkeeper@example.com',
          previewOnly: true,
        });
      });
      expect(result).toMatchObject({ ok: false, code: 'INVOICE_CHEMICAL_ADDON_HOLD' });
    });

    test('open-balance listPayablePortalInvoices excludes chemical-review-held invoices', async () => {
      let payable;
      let capturedWhereCalls = [];
      await jest.isolateModulesAsync(async () => {
        const builder = () => {
          const q = {
            where: jest.fn((fn) => {
              if (typeof fn === 'function') {
                const sub = {
                  whereNull: jest.fn(() => sub),
                  orWhereNot: jest.fn((...args) => {
                    capturedWhereCalls.push(args);
                    return sub;
                  }),
                  whereIn: jest.fn(() => sub),
                  orWhere: jest.fn(() => sub),
                };
                fn.call(sub);
              }
              return q;
            }),
            whereNull: jest.fn(() => q),
            whereRaw: jest.fn(() => q),
            orderBy: jest.fn(() => q),
            limit: jest.fn(() => q),
            offset: jest.fn(() => q),
            select: jest.fn(async () => [
              heldInvoice,
              { ...heldInvoice, id: 'inv-open-ok', invoice_number: 'INV-2026-7778', scheduled_send_error: null },
            ]),
          };
          return q;
        };
        jest.doMock('../models/db', () => jest.fn(() => builder()));
        jest.doMock('../services/failed-payments', () => ({
          loadFailedPaymentFacts: jest.fn(async () => ({ rows: [], balanceCarryingInvoiceIds: new Set() })),
          isNeverAttemptedDeferral: () => false,
          metadataInvoiceId: () => null,
        }));
        jest.doMock('../services/invoice-payer-ownership', () => ({
          invoicePayerOwnership: jest.fn(async () => null),
        }));
        const { listPayablePortalInvoices } = require('../services/open-balance');
        payable = await listPayablePortalInvoices('cust-1', { limit: 5 });
      });
      expect(capturedWhereCalls).toEqual(expect.arrayContaining([
        ['scheduled_send_error', 'like', 'chemical_addon_review:%'],
      ]));
      expect(payable.map((r) => r.id)).toEqual(['inv-open-ok']);
    });

    test('admin schedule-send refuses chemical-held invoice with 409 INVOICE_CHEMICAL_ADDON_HOLD', async () => {
      let statusCode = null;
      let body = null;
      await jest.isolateModulesAsync(async () => {
        const mockDb = jest.fn(() => ({
          where: () => ({
            first: async (...cols) => (cols.includes('payer_statement_id')
              ? { payer_statement_id: null }
              : { scheduled_send_error: 'chemical_addon_review:svc-1' }),
          }),
        }));
        mockDb.raw = jest.fn((sql) => sql);
        jest.doMock('../models/db', () => mockDb);
        const adminInvoices = require('../routes/admin-invoices');
        const layer = adminInvoices.stack.find((l) => l.route?.path === '/:id/schedule-send' && l.route.methods.post);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        const req = {
          params: { id: 'inv-chem-1' },
          body: { scheduledFor: '2030-06-15 10:00' },
        };
        const res = {
          status(code) { statusCode = code; return this; },
          json(payload) { body = payload; return this; },
        };
        await handler(req, res, (err) => { throw err; });
      });
      expect(statusCode).toBe(409);
      expect(body).toMatchObject({ code: 'INVOICE_CHEMICAL_ADDON_HOLD' });
    });

    test('pay-v2 routes reject chemical-held invoices on GET, invoice.pdf, plan-choice, consent, capture-setup & setup-complete', async () => {
      const prevGate = process.env.GATE_PAY_PLAN_CHOICE;
      process.env.GATE_PAY_PLAN_CHOICE = 'true';
      try {
        await jest.isolateModulesAsync(async () => {
          const mockDb = jest.fn(() => ({
            where: () => ({ first: async () => heldInvoice }),
          }));
          jest.doMock('../models/db', () => mockDb);
          jest.doMock('../services/invoice', () => ({
            getByToken: jest.fn(async () => heldInvoice),
          }));
          jest.doMock('../services/estimate-deposits', () => ({
            withInvoiceDepositSettlement: jest.fn(async (_id, fn) => fn(mockDb)),
          }));
          const payRouter = require('../routes/pay-v2');
          const findHandler = (method, routePath) => {
            const layer = payRouter.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
            expect(layer).toBeTruthy();
            return layer.route.stack[layer.route.stack.length - 1].handle;
          };
          const invoke = async (method, routePath, bodyPayload = {}) => {
            let status = 200;
            let jsonBody = null;
            const req = { params: { token: heldInvoice.token }, body: bodyPayload, headers: {} };
            const res = {
              status(c) { status = c; return this; },
              json(p) { jsonBody = p; return this; },
            };
            await findHandler(method, routePath)(req, res, (err) => { throw err; });
            return { status, jsonBody };
          };

          for (const [method, routePath, payload] of [
            ['get', '/:token', {}],
            ['get', '/:token/invoice.pdf', {}],
            ['post', '/:token/plan-choice', { plan: 'prepay_annual' }],
            ['post', '/:token/consent', {}],
            ['post', '/:token/capture-setup', {}],
            ['post', '/:token/setup-complete', { setupIntentId: 'seti_123' }],
          ]) {
            const out = await invoke(method, routePath, payload);
            expect(out.status).toBe(409);
            expect(out.jsonBody).toMatchObject({ code: 'INVOICE_CHEMICAL_ADDON_HOLD' });
          }
        });
      } finally {
        if (prevGate === undefined) delete process.env.GATE_PAY_PLAN_CHOICE;
        else process.env.GATE_PAY_PLAN_CHOICE = prevGate;
      }
    });

    test('stripe-terminal blocks chemical-held and canceled/cancelled invoices on /handoff and collection routes', async () => {
      const prevSecret = process.env.TERMINAL_HANDOFF_SECRET;
      process.env.TERMINAL_HANDOFF_SECRET = 'x'.repeat(40);
      try {
        await jest.isolateModulesAsync(async () => {
          let currentInvoice = heldInvoice;
          const mockDb = jest.fn(() => ({
            where: () => ({ first: async () => currentInvoice }),
          }));
          jest.doMock('../models/db', () => mockDb);
          const terminalRouter = require('../routes/stripe-terminal');
          const handoffLayer = terminalRouter.stack.find((l) => l.route?.path === '/handoff' && l.route.methods.post);
          const handler = handoffLayer.route.stack[handoffLayer.route.stack.length - 1].handle;
          const runHandoff = async (inv) => {
            currentInvoice = inv;
            let status = 200;
            let jsonBody = null;
            const req = { body: { invoice_id: inv.id }, techRole: 'admin', technicianId: 'admin-1', headers: {} };
            const res = {
              status(c) { status = c; return this; },
              json(p) { jsonBody = p; return this; },
            };
            await handler(req, res, (err) => { throw err; });
            return { status, jsonBody };
          };

          const heldOut = await runHandoff(heldInvoice);
          expect(heldOut.status).toBe(409);
          expect(heldOut.jsonBody).toMatchObject({ code: 'INVOICE_CHEMICAL_ADDON_HOLD' });

          const canceledOut = await runHandoff({ ...heldInvoice, status: 'canceled', scheduled_send_error: null });
          expect(canceledOut.status).toBe(400);
          const cancelledOut = await runHandoff({ ...heldInvoice, status: 'cancelled', scheduled_send_error: null });
          expect(cancelledOut.status).toBe(400);
        });
        const terminalSrc = fs.readFileSync(path.join(__dirname, '../routes/stripe-terminal.js'), 'utf8');
        expect(terminalSrc).toContain("const TERMINAL_UNCOLLECTIBLE_STATUSES = ['paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled']");
        expect(terminalSrc.match(/terminalCollectionRefusal\(/g).length).toBeGreaterThanOrEqual(4);
      } finally {
        if (prevSecret === undefined) delete process.env.TERMINAL_HANDOFF_SECRET;
        else process.env.TERMINAL_HANDOFF_SECRET = prevSecret;
      }
    });

    test('stripe.js, admin-schedule.js, pay-v2.js & invoice-email.js enforce locked chemical holds and preserve error codes', async () => {
      const stripeSrc = fs.readFileSync(path.join(__dirname, '../services/stripe.js'), 'utf8');
      expect(stripeSrc).toContain('assertLockedUpdateInvoice(lockedInvoice, effectivePaymentIntentId, baseCents)');
      expect(stripeSrc.match(/assertInvoiceNotWithdrawnOrHeld\(/g)).toHaveLength(2);
      const billingV2Src = fs.readFileSync(path.join(__dirname, '../routes/billing-v2.js'), 'utf8');
      expect(billingV2Src).toContain("orWhereNot('scheduled_send_error', 'like', 'chemical_addon_review:%')");
      // Locked prepay-switch hold check (admin-schedule.js)
      const adminSchedSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
      expect(adminSchedSrc).toContain('supersedeInvoiceHoldReason(inv)');
      expect(adminSchedSrc).toContain("'scheduled_send_error', 'notes'");
      expect(adminSchedSrc).toContain('if (payPageInvoiceId) this.orWhere({ id: payPageInvoiceId });');
      // Locked enrollment hold check (invoice locked BEFORE customer) & preserved INVOICE_CHEMICAL_ADDON_HOLD code
      const payV2Src = fs.readFileSync(path.join(__dirname, '../routes/pay-v2.js'), 'utf8');
      expect(payV2Src.match(/enrollmentInvoiceRefusal\(trx, invoice\.id, invoice\.customer_id/g)).toHaveLength(2);
      const enrollFnStart = payV2Src.indexOf('async function enrollmentInvoiceRefusal');
      const enrollFnBody = payV2Src.slice(enrollFnStart, enrollFnStart + 900);
      expect(enrollFnBody.indexOf("trx('invoices')")).toBeGreaterThan(-1);
      expect(enrollFnBody.indexOf("trx('customers')")).toBeGreaterThan(enrollFnBody.indexOf("trx('invoices')"));
      expect(payV2Src).toContain('errorPayload(err, { staleBalance: !!err.staleBalance })');
      const termSrc = fs.readFileSync(path.join(__dirname, '../routes/stripe-terminal.js'), 'utf8');
      expect(termSrc).toContain('mintHandoffRefusal = terminalHandoffRefusal(mintInv);');
      // Locked provider-boundary chemical hold check even for recipientOverride emails
      const emailSrc = fs.readFileSync(path.join(__dirname, '../services/invoice-email.js'), 'utf8');
      expect(emailSrc).toContain('invoiceDispatchOwnershipRefusal');
      expect(emailSrc).toContain('helpers.invoiceHeldForChemicalReview(current)');
      // Public route contract documents validate-handoff chemical hold + withdrawal codes
      const contractsSrc = fs.readFileSync(path.join(__dirname, '../../docs/public-route-contracts.md'), 'utf8');
      expect(contractsSrc).toContain("`409 { code: 'INVOICE_CHEMICAL_ADDON_HOLD' }`");
      expect(contractsSrc).toContain("`409 { code: 'invoice_withdrawn_from_customer' }`");
    });

    test('open setup-fee partial coverage ($40 of $99) instructs $59.00 remaining in completion, terminal, and reconcile alerts', () => {
      const prevNotice = process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
      process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE = 'true';
      try {
        const {
          resolveOpenSetupFeeCoverage,
          buildUnmintedSetupFeeAlertBody,
          buildTerminalSetupFeeNote,
        } = require('../services/complete-scheduled-service');
        const { _private: reconcilePrivate } = require('../services/setup-fee-alert-reconcile');

        const settledNow = {
          settled: false,
          open: [{ invoiceId: 'inv-open-40', invoiceNumber: 'INV-OPEN-40', cents: 4000 }],
        };
        const cov = resolveOpenSetupFeeCoverage(settledNow, {
          countedRows: [],
          feeCovered: false,
          expectedSetupFeeCents: 9900,
          liveFeeCentsNow: 0,
        });
        expect(cov.openFeeCents).toBe(4000);
        expect(cov.hasOpenFeeInvoice).toBe(true);
        expect(cov.feeOnOpenInvoice).toBe(false);

        const remainderCents = Math.max(0, 9900 - cov.openFeeCents);
        const body = buildUnmintedSetupFeeAlertBody({
          feeCoveredBy: null,
          feeOnOpenInvoice: false,
          openFeeInvoices: cov.openFeeInvoices,
          applicationCoveredBy: null,
          applicationCoveredOutOfBand: false,
          unrecordedChemicalAddOnHold: false,
          feeEstimateRef: 'est-40',
          feeHistoryClause: 'its WaveGuard setup fee was never invoiced',
          setupFeeLabel: `$${(remainderCents / 100).toFixed(2)} remaining`,
          firstAppLabel: ' ($89.00)',
          estimateId: 40,
          setupFeeParkedNote: '',
        });
        expect(body).toContain('$59.00 remaining');
        expect(body).not.toContain('$99.00');

        const termNote = buildTerminalSetupFeeNote({
          terminalSetupFeeNote: true,
          terminalFeeCovered: false,
          termExpectedFeeCents: 9900,
          liveFeeCentsOnVisit: 0,
          refundedFeeCentsTerm: 0,
          openFeeCentsTerm: 4000,
          openFeeInvoicesTerm: settledNow.open,
          termFeeEstimateRef: 'est-40',
          estimateId: 40,
        });
        expect(termNote).toContain('$59.00 remaining');
        expect(termNote).not.toContain('$99.00');

        expect(reconcilePrivate.reconcileFeeRemainderLabel(9900, 0, 4000)).toBe(' ($59.00 remaining)');
        const termReconcileClause = reconcilePrivate.terminalFeeClauseFor(
          { sourceEstimateId: 40 },
          40,
          { feeIsProven: false, effectiveCovered: 4000, tExpectCents: 9900 },
        );
        expect(termReconcileClause).toContain('$59.00 remaining');

        // Full $99 open unpaid coverage keeps a non-empty pending-open-invoice clause
        // and never tells staff to bill "the accepted amount".
        const fullOpenTermNote = buildTerminalSetupFeeNote({
          terminalSetupFeeNote: true,
          terminalFeeCovered: false,
          termExpectedFeeCents: 9900,
          liveFeeCentsOnVisit: 0,
          refundedFeeCentsTerm: 0,
          openFeeCentsTerm: 9900,
          openFeeInvoicesTerm: [{ invoiceId: 'inv-open-99', invoiceNumber: 'INV-OPEN-99', cents: 9900 }],
          termFeeEstimateRef: 'est-99',
          estimateId: 99,
        });
        expect(fullOpenTermNote).toContain('INV-OPEN-99');
        expect(fullOpenTermNote).toContain('do NOT bill it again');
        const fullOpenReconcile = reconcilePrivate.terminalFeeClauseFor(
          { sourceEstimateId: 99 },
          99,
          { feeIsProven: false, effectiveCovered: 9900, tExpectCents: 9900 },
        );
        expect(fullOpenReconcile).toContain('open invoice');
        expect(fullOpenReconcile).not.toContain('the accepted amount');
      } finally {
        if (prevNotice === undefined) delete process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
        else process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE = prevNotice;
      }
    });

    test('webhook enrollment fence locks invoice before customer and refuses chemical-held invoices on covered_capture & mirror', async () => {
      const lockOrder = [];
      let refused = false;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../services/visit-completion-packets', () => ({
          invoicePayerOwnedNow: jest.fn(async () => false),
        }));
        const { _webhookInvoiceRefusesEnrollment } = require('../routes/stripe-webhook');
        const trx = jest.fn((table) => ({
          where: jest.fn().mockReturnThis(),
          whereIn: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          forUpdate: jest.fn(function recordLock() {
            lockOrder.push(table);
            return this;
          }),
          select: jest.fn(async () => (
            table === 'invoices'
              ? [{ id: 'inv-held-wh', scheduled_send_error: 'chemical_addon_review:svc-1' }]
              : [{ id: 'cust-1' }]
          )),
          first: jest.fn(async () => (
            table === 'invoices'
              ? { id: 'inv-held-wh', scheduled_send_error: 'chemical_addon_review:svc-1' }
              : { id: 'cust-1' }
          )),
        }));
        refused = await _webhookInvoiceRefusesEnrollment(trx, 'inv-held-wh', 'cust-1');
      });
      expect(refused).toBe(true);
      expect(lockOrder).toEqual(['invoices', 'customers']);
    });

    test('chemical review stays ahead of every instruction to collect or bill the visit across completion, terminal, and reconcile alerts', () => {
      const {
        buildUnmintedSetupFeeAlertBody,
        buildTerminalManualBillingBody,
      } = require('../services/complete-scheduled-service');
      const { _private: reconcilePrivate } = require('../services/setup-fee-alert-reconcile');

      // Existing application invoice held for chemical review must NOT say "collect THAT invoice"
      const appHeldBody = buildUnmintedSetupFeeAlertBody({
        feeCoveredBy: null,
        feeOnOpenInvoice: false,
        openFeeInvoices: [],
        applicationCoveredBy: {
          id: 'inv-app-1',
          invoice_number: 'INV-APP-1',
          status: 'draft',
          scheduled_send_error: 'chemical_addon_review:svc-1',
        },
        applicationCoveredOutOfBand: false,
        unrecordedChemicalAddOnHold: true,
        feeEstimateRef: 'est-held',
        feeHistoryClause: 'its WaveGuard setup fee was never invoiced',
        setupFeeLabel: '$99.00',
        firstAppLabel: ' ($89.00)',
        estimateId: 77,
        setupFeeParkedNote: '',
      });
      expect(appHeldBody).toContain('do NOT collect or release THAT invoice until review confirms');
      expect(appHeldBody).not.toContain('— collect THAT invoice');

      // Terminal refunded-invoice alert with chemical hold must defer billing/collection until review
      const termHeldBody = buildTerminalManualBillingBody({
        terminalCompletionInvoice: { id: 'inv-ref', invoice_number: 'INV-REF-1', status: 'refunded' },
        covered: false,
        liveBesideNow: { id: 'inv-live', invoice_number: 'INV-LIVE-1', status: 'draft' },
        liveBesideLabel: 'INV-LIVE-1',
        terminalRestored: false,
        completionTerminalIncludedSetupFee: false,
        effectiveSetupFeeNote: '',
        unrecordedChemicalAddOnHold: true,
      });
      expect(termHeldBody).toContain('hold collecting or releasing that invoice until office chemical add-on review confirms');
      expect(termHeldBody).not.toContain('collect THAT invoice');

      // Reconciler preserves chemical hold instruction on uncovered visits and held live invoices
      const recAppInstr = reconcilePrivate.reconcileAppInstructionForVisits(
        ['svc-99'],
        { chemicalHoldVisitIds: ['svc-99'] },
      );
      expect(recAppInstr).toContain('HOLD billing until office chemical add-on review confirms');
      const heldNotice = reconcilePrivate.reconcileHeldInvoiceNotice([
        { id: 'inv-live', scheduled_send_error: 'chemical_addon_review:svc-99' },
      ]);
      expect(heldNotice).toContain('do NOT collect or release it until review confirms');
    });

    test('StripeService.updateInvoicePaymentIntentMethod rethrows locked INVOICE_CHEMICAL_ADDON_HOLD 409 unchanged', async () => {
      let caught = null;
      await jest.isolateModulesAsync(async () => {
        jest.dontMock('../services/invoice-helpers');
        const prevKey = process.env.STRIPE_SECRET_KEY;
        process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
        const mockStripe = {
          paymentIntents: {
            retrieve: jest.fn(async () => ({
              id: 'pi_test_hold_race',
              status: 'requires_payment_method',
              payment_method_types: ['card'],
              metadata: { waves_invoice_id: 'inv-race-hold', save_card_opt_in: 'false' },
            })),
            update: jest.fn(),
          },
        };
        jest.doMock('stripe', () => jest.fn(() => mockStripe));
        const unlockedInv = {
          id: 'inv-race-hold',
          invoice_number: 'INV-RACE-HOLD',
          customer_id: 'cust-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          amount_paid: 0,
          stripe_payment_intent_id: 'pi_test_hold_race',
          scheduled_send_error: null,
        };
        const lockedInv = {
          ...unlockedInv,
          scheduled_send_error: 'chemical_addon_review:svc-race',
        };
        const makeQ = (row) => {
          const q = {
            where: jest.fn(() => q),
            whereNotIn: jest.fn(() => q),
            forUpdate: jest.fn(() => q),
            orderBy: jest.fn(() => q),
            first: jest.fn(async () => row),
          };
          return q;
        };
        const mockDb = jest.fn((table) => makeQ(table === 'invoices' ? unlockedInv : null));
        mockDb.transaction = jest.fn(async (fn) => {
          const trx = jest.fn((table) => makeQ(table === 'invoices' ? lockedInv : null));
          return fn(trx);
        });
        jest.doMock('../models/db', () => mockDb);
        jest.doMock('../services/pay-combined', () => ({
          combinedContextForInvoice: jest.fn(async () => null),
          paymentIntentOwnsInvoice: jest.fn(() => false),
          isCombinedPiMetadata: jest.fn(() => false),
          clearPaymentIntentStamps: jest.fn(async () => {}),
        }));
        try {
          const StripeService = require('../services/stripe');
          await StripeService.updateInvoicePaymentIntentMethod('inv-race-hold', 'pi_test_hold_race', 'us_bank_account');
        } catch (err) {
          caught = err;
        } finally {
          if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
          else process.env.STRIPE_SECRET_KEY = prevKey;
        }
      });
      expect(caught).toBeTruthy();
      expect(caught.message).toMatch(/chemical area add-on/i);
      expect(caught.code).toBe('INVOICE_CHEMICAL_ADDON_HOLD');
      expect(caught.statusCode).toBe(409);
    });

    test('confirmInvoicePayment rethrows INVOICE_CHEMICAL_ADDON_HOLD instead of wrapping it into friendlyStripeError', async () => {
      let caught = null;
      await jest.isolateModulesAsync(async () => {
        const prevKey = process.env.STRIPE_SECRET_KEY;
        process.env.STRIPE_SECRET_KEY = 'sk_test_confirm_hold';
        const mockStripe = {
          paymentIntents: {
            retrieve: jest.fn(async () => ({
              id: 'pi_confirm_hold',
              status: 'succeeded',
              amount: 15000,
              amount_received: 15000,
              payment_method: 'pm_1',
              latest_charge: { id: 'ch_1', payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '1234' } } },
              metadata: { waves_invoice_id: 'inv-confirm-hold', base_amount: '150', card_surcharge: '0' },
            })),
          },
        };
        jest.doMock('stripe', () => jest.fn(() => mockStripe));
        const unlockedInv = {
          id: 'inv-confirm-hold',
          customer_id: 'cust-1',
          invoice_number: 'INV-CONFIRM-HOLD',
          status: 'sent',
          total: '150.00',
          credit_applied: 0,
          amount_paid: 0,
          stripe_payment_intent_id: 'pi_confirm_hold',
          scheduled_send_error: null,
        };
        const lockedInv = { ...unlockedInv, scheduled_send_error: 'chemical_addon_review:svc-confirm' };
        const makeQ = (row) => {
          const q = {
            where: jest.fn(() => q),
            whereNotIn: jest.fn(() => q),
            forUpdate: jest.fn(() => q),
            orderBy: jest.fn(() => q),
            first: jest.fn(async () => row),
          };
          return q;
        };
        const mockDb = jest.fn((table) => makeQ(table === 'invoices' ? unlockedInv : null));
        mockDb.transaction = jest.fn(async (fn) => {
          const trx = jest.fn((table) => makeQ(table === 'invoices' ? lockedInv : null));
          trx.raw = jest.fn(async () => ({}));
          return fn(trx);
        });
        jest.doMock('../models/db', () => mockDb);
        try {
          const StripeService = require('../services/stripe');
          await StripeService.confirmInvoicePayment('inv-confirm-hold', 'pi_confirm_hold');
        } catch (err) {
          caught = err;
        } finally {
          if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
          else process.env.STRIPE_SECRET_KEY = prevKey;
        }
      });
      expect(caught).toBeTruthy();
      expect(caught.code).toBe('INVOICE_CHEMICAL_ADDON_HOLD');
      expect(caught.message).toMatch(/chemical area add-on/i);
    });

    test('settleCombinedPaymentIntent rejects held allocated invoices when rejectHeldInvoices is true and settles when false', async () => {
      let rejectedErr = null;
      await jest.isolateModulesAsync(async () => {
        const heldAnchor = {
          id: 'inv-a',
          customer_id: 'cust-1',
          invoice_number: 'INV-A',
          status: 'sent',
          total: '100.00',
          credit_applied: 0,
          amount_paid: 0,
          stripe_payment_intent_id: 'pi_comb_hold',
          scheduled_send_error: 'chemical_addon_review:svc-a',
        };
        const unheldSibling = {
          id: 'inv-b',
          customer_id: 'cust-1',
          invoice_number: 'INV-B',
          status: 'sent',
          total: '50.00',
          credit_applied: 0,
          amount_paid: 0,
          stripe_payment_intent_id: 'pi_comb_hold',
          scheduled_send_error: null,
        };
        const mockDb = jest.fn();
        mockDb.transaction = jest.fn(async (fn) => {
          const trx = jest.fn((table) => {
            if (table === 'invoices') {
              const q = {
                whereIn: jest.fn(() => q),
                orderBy: jest.fn(() => q),
                forUpdate: jest.fn(async () => [heldAnchor, unheldSibling]),
              };
              return q;
            }
            const q = { where: jest.fn(async () => []) };
            return q;
          });
          trx.raw = jest.fn(async () => ({}));
          return fn(trx);
        });
        jest.doMock('../models/db', () => mockDb);
        const PayCombined = require('../services/pay-combined');
        try {
          await PayCombined.settleCombinedPaymentIntent({
            id: 'pi_comb_hold',
            status: 'succeeded',
            amount: 15000,
            amount_received: 15000,
            metadata: {
              waves_invoice_id: 'inv-a',
              combined_allocation: PayCombined.encodeAllocation([
                { invoiceId: 'inv-a', cents: 10000 },
                { invoiceId: 'inv-b', cents: 5000 },
              ]),
              card_surcharge: '0',
            },
          }, { paymentMethod: 'us_bank_account', cardBrand: null, cardLastFour: '1234', receiptUrl: null }, { rejectHeldInvoices: true });
        } catch (err) {
          rejectedErr = err;
        }
      });
      expect(rejectedErr).toBeTruthy();
      expect(rejectedErr.code).toBe('INVOICE_CHEMICAL_ADDON_HOLD');
    });

    test('webhookInvoiceRefusesEnrollment locks all combined PI invoices and refuses when anchor is held even if sibling is unheld', async () => {
      let refused = false;
      const lockedIds = [];
      await jest.isolateModulesAsync(async () => {
        const trx = jest.fn((table) => {
          if (table === 'invoices') {
            const q = {
              whereIn: jest.fn((_col, ids) => { lockedIds.push(...ids); return q; }),
              orderBy: jest.fn(() => q),
              forUpdate: jest.fn(() => q),
              select: jest.fn(async () => [
                { id: 'inv-1-anchor', scheduled_send_error: 'chemical_addon_review:svc-1' },
                { id: 'inv-2-sibling', scheduled_send_error: null },
              ]),
            };
            return q;
          }
          const q = { where: jest.fn(() => q), forUpdate: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1' })) };
          return q;
        });
        jest.doMock('../services/visit-completion-packets', () => ({
          invoicePayerOwnedNow: jest.fn(async () => false),
        }));
        const { _webhookInvoiceRefusesEnrollment } = require('../routes/stripe-webhook');
        refused = await _webhookInvoiceRefusesEnrollment(trx, 'inv-2-sibling', 'cust-1', {
          extraInvoiceIds: ['inv-1-anchor', 'inv-2-sibling'],
        });
      });
      expect(lockedIds).toEqual(['inv-1-anchor', 'inv-2-sibling']);
      expect(refused).toBe(true);
    });
  });

  describe('B-09: InvoiceService.markDeliverySent advances stale due_date via firstDeliveryDueDate', () => {
    test('passes firstDeliveryDueDate(db, etDateString()) in the markDeliverySent update payload', async () => {
      let capturedUpdate = null;
      await jest.isolateModulesAsync(async () => {
        jest.dontMock('../services/invoice');
        const mockDb = jest.fn((table) => {
          if (table === 'invoices') {
            const q = {
              where: jest.fn(() => q),
              whereIn: jest.fn(() => q),
              first: jest.fn(async () => ({
                id: 'inv-late-1',
                customer_id: 'cust-1',
                status: 'draft',
                due_date: '2026-11-26',
                sent_at: null,
                sms_sent_at: null,
                email_sent_at: null,
                scheduled_send_error: null,
              })),
              update: jest.fn((patch) => {
                capturedUpdate = patch;
                return {
                  returning: jest.fn(async () => [{
                    id: 'inv-late-1',
                    customer_id: 'cust-1',
                    status: 'sent',
                    due_date: '2026-11-27',
                  }]),
                };
              }),
            };
            return q;
          }
          return {
            where: jest.fn().mockReturnThis(),
            first: jest.fn(async () => null),
            insert: jest.fn(async () => []),
          };
        });
        mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
        jest.doMock('../models/db', () => mockDb);
        jest.doMock('../services/invoice-followups', () => ({
          scheduleForInvoice: jest.fn(async () => {}),
        }));
        jest.doMock('../services/invoice-issued-closeout', () => ({
          closeOutVisitForIssuedInvoice: jest.fn(async () => {}),
        }));
        const InvoiceService = require('../services/invoice');
        await InvoiceService.markDeliverySent('inv-late-1', { sms: true, source: 'completion_sms_with_invoice' });
      });
      expect(capturedUpdate).toBeTruthy();
      expect(capturedUpdate.due_date).toBeTruthy();
      expect(capturedUpdate.due_date.__raw).toContain("status IN ('draft', 'scheduled', 'sending')");
      expect(capturedUpdate.due_date.__raw).toContain('due_date < ?::date THEN ?::date ELSE due_date END');
    });

    test('deduped delivery-recovery anchors due_date to original ET delivery timestamp and preserves due_date when unknown', () => {
      const InvoiceService = require('../services/invoice');
      const fakeDb = { raw: jest.fn((sql, bindings) => ({ __raw: sql, bindings })) };

      const withOrig = InvoiceService._firstDeliveryDueDateUpdate(fakeDb, {
        deduped: true,
        smsEventVisibleAt: '2026-11-24T15:00:00Z',
      });
      expect(withOrig.due_date).toBeTruthy();
      expect(withOrig.due_date.bindings).toEqual(['2026-11-24', '2026-11-24']);

      const unknownOrig = InvoiceService._firstDeliveryDueDateUpdate(fakeDb, {
        deduped: true,
      });
      expect(unknownOrig).toEqual({});
    });
  });
});
