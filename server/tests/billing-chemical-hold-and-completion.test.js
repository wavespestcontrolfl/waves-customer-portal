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

    test('still marks hasOpenFeeInvoice=true when gate is off so billBothPlain does not double-bill', () => {
      delete process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE;
      const cov = resolveOpenSetupFeeCoverage(
        { open: [{ id: 'inv-open-2', invoiceNumber: 'INV-2026-9002', cents: 9900 }] },
        { countedRows: [], feeCovered: false, expectedSetupFeeCents: 9900, liveFeeCentsNow: 0 },
      );
      expect(cov.hasOpenFeeInvoice).toBe(true);
      expect(cov.feeOnOpenInvoice).toBe(false);
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
      // Locked enrollment hold check & preserved INVOICE_CHEMICAL_ADDON_HOLD code on /update-amount & collectibility guards
      const payV2Src = fs.readFileSync(path.join(__dirname, '../routes/pay-v2.js'), 'utf8');
      expect(payV2Src.match(/enrollmentInvoiceRefusal\(trx, invoice\.id\)/g)).toHaveLength(2);
      expect(payV2Src).toContain('errorPayload(err, { staleBalance: !!err.staleBalance })');
      // Locked provider-boundary chemical hold check even for recipientOverride emails
      const emailSrc = fs.readFileSync(path.join(__dirname, '../services/invoice-email.js'), 'utf8');
      expect(emailSrc).toContain('invoiceDispatchOwnershipRefusal');
      expect(emailSrc).toContain('helpers.invoiceHeldForChemicalReview(current)');
      // Public route contract documents validate-handoff chemical hold + withdrawal codes
      const contractsSrc = fs.readFileSync(path.join(__dirname, '../../docs/public-route-contracts.md'), 'utf8');
      expect(contractsSrc).toContain("`409 { code: 'INVOICE_CHEMICAL_ADDON_HOLD' }`");
      expect(contractsSrc).toContain("`409 { code: 'invoice_withdrawn_from_customer' }`");
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
  });
});
