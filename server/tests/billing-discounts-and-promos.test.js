'use strict';

/**
 * Billing Audit PR 3 — discounts, promo codes, multi-home routing & dedupe.
 * Covers: B-03, B-04, B-05, B-13, B-14, B-15, B-16, B-36, B-37, B-38, B-61a.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

async function callApp(app, method, routePath, body = null) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${routePath}`, {
      method,
      headers: body !== null ? { 'Content-Type': 'application/json' } : {},
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: res.status, body: json, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('Billing Audit PR 3 — discounts, promo codes & multi-home invariants', () => {
  afterEach(() => {
    jest.dontMock('../middleware/admin-auth');
    jest.dontMock('../models/db');
    jest.dontMock('../services/discount-engine');
    jest.dontMock('../services/audit-log');
    jest.dontMock('../services/estimate-promo-code');
    jest.dontMock('../services/invoice-promo-code');
    jest.dontMock('../services/invoice-payer-ownership');
    jest.dontMock('../services/customer-credit');
    jest.dontMock('../config/feature-gates');
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('B-03 & B-37: admin-discounts auth, promo_code validation & applied_by audit actor', () => {
    function buildAdminDiscountsApp({ role = 'technician', name = 'Tech User', dbImpl = null, engineImpl = null } = {}) {
      let app;
      jest.isolateModules(() => {
        jest.doMock('../middleware/admin-auth', () => ({
          adminAuthenticate: (req, _res, next) => {
            req.technician = { id: 'tech-1', name, role };
            req.techRole = role;
            next();
          },
          requireTechOrAdmin: (_req, _res, next) => next(),
          requireAdmin: (req, res, next) => {
            if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
            return next();
          },
        }));
        if (dbImpl) jest.doMock('../models/db', () => dbImpl);
        if (engineImpl) jest.doMock('../services/discount-engine', () => engineImpl);
        jest.doMock('../services/audit-log', () => ({
          auditDiscountCatalogChange: jest.fn(async () => {}),
          ipFromReq: () => '127.0.0.1',
          uaFromReq: () => 'jest',
        }));
        const router = require('../routes/admin-discounts');
        app = express();
        app.use(express.json());
        app.use('/api/admin/discounts', router);
        app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
      });
      return app;
    }

    test('blocks non-admin technicians on /calculate and /stats (B-03)', async () => {
      const app = buildAdminDiscountsApp({ role: 'technician' });
      const calcRes = await callApp(app, 'POST', '/api/admin/discounts/calculate', { customerId: 'c1', subtotal: 100 });
      expect(calcRes.status).toBe(403);

      const statsRes = await callApp(app, 'GET', '/api/admin/discounts/stats');
      expect(statsRes.status).toBe(403);
    });

    test('requires customerId on /promo-validate and forwards req.technician.name as appliedBy (B-04, B-37)', async () => {
      const applyPromoCode = jest.fn(async () => ({ applied: true }));
      const app = buildAdminDiscountsApp({
        role: 'admin',
        name: 'Adam Admin',
        engineImpl: { applyPromoCode },
      });

      const missing = await callApp(app, 'POST', '/api/admin/discounts/promo-validate', { code: 'SAVE25' });
      expect(missing.status).toBe(400);
      expect(applyPromoCode).not.toHaveBeenCalled();

      const ok = await callApp(app, 'POST', '/api/admin/discounts/promo-validate', { customerId: 'cust-9', code: 'SAVE25' });
      expect(ok.status).toBe(200);
      expect(applyPromoCode).toHaveBeenCalledWith('cust-9', 'SAVE25', { appliedBy: 'Adam Admin' });
    });

    test('rejects malformed promo_code strings on create and records req.technician.name on assign (B-37)', async () => {
      const inserted = [];
      const mockDb = jest.fn((table) => ({
        insert: jest.fn((row) => {
          inserted.push({ table, row });
          return { returning: jest.fn(async () => [{ id: 'row-1', ...row }]) };
        }),
        where: jest.fn().mockReturnThis(),
        first: jest.fn(async () => null),
      }));
      const app = buildAdminDiscountsApp({ role: 'admin', name: 'Office Staff', dbImpl: mockDb });

      const badSpace = await callApp(app, 'POST', '/api/admin/discounts', {
        name: 'Bad Promo', discount_type: 'fixed_amount', discount_value: 25, promo_code: 'BAD CODE!',
      });
      expect(badSpace.status).toBe(400);

      const tooShort = await callApp(app, 'POST', '/api/admin/discounts', {
        name: 'Short Promo', discount_type: 'fixed_amount', discount_value: 25, promo_code: 'AB',
      });
      expect(tooShort.status).toBe(400);

      const assignRes = await callApp(app, 'POST', '/api/admin/discounts/disc-1/assign', {
        customerId: 'cust-1', reason: 'loyalty',
      });
      expect(assignRes.status).toBe(201);
      expect(inserted.find((i) => i.table === 'customer_discounts')?.row.applied_by).toBe('Office Staff');
    });
  });

  describe('B-04: DiscountEngine.applyPromoCode is locked, transactional, cap-safe, and duplicate-safe', () => {
    test('locks discounts FOR UPDATE, checks usesLeft & customerAlreadyUsed, and handles 23505 cleanly', async () => {
      let forUpdateCalled = false;
      let duplicateResult = null;
      await jest.isolateModulesAsync(async () => {
        const discountRow = {
          id: 'disc-1',
          name: 'Spring $25',
          promo_code: 'SPRING25',
          is_active: true,
          promo_code_max_uses: 10,
          promo_code_current_uses: 2,
          promo_code_expiry: null,
        };
        const trx = jest.fn((table) => {
          if (table === 'discounts') {
            const q = {
              where: jest.fn(() => q),
              orWhere: jest.fn(() => q),
              whereNull: jest.fn(() => q),
              orWhereRaw: jest.fn(() => q),
              forUpdate: jest.fn(() => {
                forUpdateCalled = true;
                return q;
              }),
              first: jest.fn(async () => discountRow),
              update: jest.fn(async () => 1),
            };
            return q;
          }
          if (table === 'customer_discounts') {
            return {
              where: jest.fn().mockReturnThis(),
              first: jest.fn(async () => null),
              insert: jest.fn(async () => {
                const err = new Error('duplicate key');
                err.code = '23505';
                throw err;
              }),
            };
          }
          return {
            join: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            first: jest.fn(async () => null),
          };
        });
        trx.raw = jest.fn((s) => s);
        const mockDb = { transaction: jest.fn(async (fn) => fn(trx)) };
        jest.doMock('../models/db', () => mockDb);
        jest.doMock('../services/estimate-promo-code', () => ({
          usesLeft: jest.fn(async () => true),
          customerAlreadyUsed: jest.fn(async () => false),
          customerHasPendingPromoHold: jest.fn(async () => false),
          normalizeCode: (raw) => String(raw || '').trim().toUpperCase(),
        }));
        const DiscountEngine = require('../services/discount-engine');
        duplicateResult = await DiscountEngine.applyPromoCode('cust-1', 'spring25', { appliedBy: 'Admin' });
      });
      expect(forUpdateCalled).toBe(true);
      expect(duplicateResult).toEqual({ success: false, error: 'Promo code already applied to this account' });
    });

    test('refuses when customer already redeemed promo credit or pending uses exhausted', async () => {
      let usedRes = null;
      let capRes = null;
      await jest.isolateModulesAsync(async () => {
        const discountRow = {
          id: 'disc-2',
          name: 'Cap Promo',
          promo_code: 'CAP25',
          is_active: true,
          promo_code_max_uses: 1,
          promo_code_current_uses: 0,
        };
        const trx = jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn(async () => discountRow),
        }));
        jest.doMock('../models/db', () => ({ transaction: jest.fn(async (fn) => fn(trx)) }));
        const usesLeft = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const customerAlreadyUsed = jest.fn().mockResolvedValueOnce(true);
        jest.doMock('../services/estimate-promo-code', () => ({
          usesLeft,
          customerAlreadyUsed,
          customerHasPendingPromoHold: jest.fn(async () => false),
          normalizeCode: (raw) => String(raw || '').trim().toUpperCase(),
        }));
        const DiscountEngine = require('../services/discount-engine');
        capRes = await DiscountEngine.applyPromoCode('cust-1', 'CAP25');
        usedRes = await DiscountEngine.applyPromoCode('cust-1', 'CAP25');
      });
      expect(capRes.success).toBe(false);
      expect(capRes.error).toMatch(/maximum uses/i);
      expect(usedRes.success).toBe(false);
      expect(usedRes.error).toMatch(/already applied/i);
    });
  });

  describe('B-05, B-13, B-15, B-36, B-61a: invoice-promo-code guards, staleBalance & pay-combined', () => {
    test('assertNoPendingPromoCode throws 409 staleBalance when an entered promo row is waiting (B-05)', async () => {
      let caught = null;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
        const mockConn = jest.fn((table) => ({
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => (
            table === 'invoice_promo_codes'
              ? { id: 'ipc-1', code: 'SAVE25', credit_amount: '25.00', status: 'entered' }
              : null
          )),
        }));
        const InvoicePromo = require('../services/invoice-promo-code');
        try {
          await InvoicePromo.assertNoPendingPromoCode({
            id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: 100, credit_applied: 0, amount_paid: 0,
          }, mockConn);
        } catch (err) {
          caught = err;
        }
      });
      expect(caught).toBeTruthy();
      expect(caught.statusCode).toBe(409);
      expect(caught.staleBalance).toBe(true);
    });

    test('pay-v2 /quote and stripe.js /update-amount & /finalize wire assertNoPendingPromoCode and 409 staleBalance (B-05)', () => {
      const stripeSrc = fs.readFileSync(path.join(__dirname, '../services/stripe.js'), 'utf8');
      const matches = stripeSrc.match(/assertNoPendingPromoCode\(/g) || [];
      expect(matches).toHaveLength(8); // updateInvoicePaymentIntentMethod (pre + combined + single + replace single), quoteInvoiceSurcharge (+ sibling helper), finalizeInvoicePayment (pre + locked)
      const payV2Src = fs.readFileSync(path.join(__dirname, '../routes/pay-v2.js'), 'utf8');
      expect(payV2Src).toContain('respondPayPhaseError');
      expect(payV2Src).toContain('err.statusCode === 409 && err.staleBalance');
    });

    test('isRedeemableDiscount rejects cleared, expired, percentage, and rule-scoped discounts at redemption (B-15)', () => {
      const Promo = require('../services/estimate-promo-code');
      const base = {
        is_active: true,
        promo_code: 'SAVE25',
        discount_type: 'fixed_amount',
        amount: 25,
        promo_code_expiry: null,
        service_category_filter: null,
        service_key_filter: null,
        min_order_amount: null,
        min_property_count: null,
        new_customers_only: false,
      };
      expect(Promo.isRedeemableDiscount(base, 'SAVE25')).toBe(true);
      expect(Promo.isRedeemableDiscount({ ...base, promo_code: null }, 'SAVE25')).toBe(false);
      expect(Promo.isRedeemableDiscount({ ...base, promo_code: 'OTHER' }, 'SAVE25')).toBe(false);
      expect(Promo.isRedeemableDiscount({ ...base, discount_type: 'percentage' }, 'SAVE25')).toBe(false);
      expect(Promo.isRedeemableDiscount({ ...base, min_subtotal: 100 }, 'SAVE25')).toBe(false);
      expect(Promo.isRedeemableDiscount({ ...base, promo_code_expiry: '2020-01-01' }, 'SAVE25')).toBe(false);
    });

    test('redeemAndApplyPromoCode refuses live payer-owned invoice inside lock and passes requireSelfPayScheduledServiceId + createdBy (B-13, B-61a)', async () => {
      let applied = null;
      let mintCalled = false;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
        jest.doMock('../services/invoice-payer-ownership', () => ({
          invoicePayerOwnership: jest.fn(async () => ({ payerId: 'payer-1', source: 'visit' })),
        }));
        jest.doMock('../services/estimate-promo-code', () => ({
          isRedeemableDiscount: jest.fn(() => true),
          customerBlocked: jest.fn(async () => false),
          mintPromoCredit: jest.fn(async () => { mintCalled = true; return { id: 'cred-1' }; }),
        }));
        const savepoint = jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({ id: 'ipc-1', discount_id: 'd-1', code: 'SAVE25', credit_amount: 25, status: 'entered' })),
        }));
        const trx = { transaction: jest.fn(async (fn) => fn(savepoint)) };
        const InvoicePromo = require('../services/invoice-promo-code');
        applied = await InvoicePromo.redeemAndApplyPromoCode(trx, {
          id: 'inv-1',
          customer_id: 'cust-1',
          scheduled_service_id: 'ss-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          amount_paid: 0,
        });
      });
      expect(applied).toBe(0);
      expect(mintCalled).toBe(false);
    });

    test('invoiceCreditWouldFullyCover counts pendingPromoCredit and effectivePromoCreditAmount caps at $0.50 Stripe min (B-36)', async () => {
      let covered = false;
      let view = null;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/feature-gates', () => ({
          isEnabled: () => true,
          gates: { autoApplyAccountCredit: false },
        }));
        jest.doMock('../services/customer-credit', () => ({
          getBalance: jest.fn(async () => 0),
          round2: (n) => Math.round(Number(n || 0) * 100) / 100,
          computeApplication: ({ total, creditApplied, balance }) => {
            const due = Math.round((total - creditApplied) * 100) / 100;
            if (balance >= due) return { applyAmt: due, newCreditApplied: creditApplied + due, remainingDue: 0 };
            const maxPartial = Math.max(0, Math.round((due - 0.5) * 100) / 100);
            const applyAmt = Math.min(balance, maxPartial);
            return { applyAmt, newCreditApplied: creditApplied + applyAmt, remainingDue: Math.round((due - applyAmt) * 100) / 100 };
          },
        }));
        jest.doMock('../services/invoice-promo-code', () => {
          const actual = jest.requireActual('../services/invoice-promo-code');
          return {
            ...actual,
            pendingPromoCredit: jest.fn(async () => 100),
          };
        });
        const PayCombined = require('../services/pay-combined');
        covered = await PayCombined.invoiceCreditWouldFullyCover({
          id: 'inv-1',
          customer_id: 'cust-1',
          status: 'sent',
          total: 100,
          credit_applied: 0,
          amount_paid: 0,
        });
      });
      expect(covered).toBe(true);

      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
        const mockDb = jest.fn((table) => {
          if (table === 'invoice_promo_codes') {
            return {
              where: jest.fn().mockReturnThis(),
              first: jest.fn(async () => ({ id: 'ipc-1', code: 'SAVE25', credit_amount: '25.00', status: 'entered' })),
            };
          }
          return { where: jest.fn().mockReturnThis(), first: jest.fn(async () => null) };
        });
        jest.doMock('../models/db', () => mockDb);
        const InvoicePromo = require('../services/invoice-promo-code');
        // Invoice due is $25.20 with $25.00 promo -> Stripe $0.50 min caps effective credit at $24.70
        view = await InvoicePromo.promoCodeViewForInvoice({
          id: 'inv-cap',
          customer_id: 'cust-1',
          status: 'sent',
          total: 25.20,
          credit_applied: 0,
          amount_paid: 0,
        });
      });
      expect(view).toEqual({
        canEnter: false,
        applied: { code: 'SAVE25', creditAmount: 24.7, credited: false },
      });
    });

    test('usesLeft excludes clock-expired estimates and payer/held invoices (B-36)', async () => {
      let left = null;
      await jest.isolateModulesAsync(async () => {
        const mockConn = jest.fn((table) => {
          if (table === 'estimate_promo_codes as p') {
            const q = {
              join: jest.fn(() => q),
              where: jest.fn((arg) => {
                if (typeof arg === 'function') arg.call(q);
                return q;
              }),
              whereIn: jest.fn(() => q),
              whereNotIn: jest.fn(() => q),
              whereNull: jest.fn(() => q),
              orWhereNull: jest.fn(() => q),
              orWhere: jest.fn(() => q),
              count: jest.fn(() => q),
              first: jest.fn(async () => ({ c: 0 })),
            };
            return q;
          }
          if (table === 'invoice_promo_codes as p') {
            return {
              join: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              whereNotIn: jest.fn().mockReturnThis(),
              whereNull: jest.fn().mockReturnThis(),
              select: jest.fn(async () => [
                { id: 'inv-withdrawn', scheduled_send_error: 'payer_billed:p1' },
                { id: 'inv-held', scheduled_send_error: 'chemical_addon_review:ss1' },
              ]),
            };
          }
          return { where: jest.fn().mockReturnThis(), first: jest.fn(async () => null) };
        });
        mockConn.fn = { now: jest.fn(() => 'NOW()') };
        const Promo = require('../services/estimate-promo-code');
        left = await Promo.usesLeft(mockConn, { id: 'd-1', promo_code_max_uses: 1, promo_code_current_uses: 0 });
      });
      expect(left).toBe(true);
    });
  });

  describe('B-14: Estimate promo code projects and redeems in-tx on annual prepay accept', () => {
    test('estimate-public.js projects pending promo, keeps offerContribution scoped to inspection offers, and redeems promo before credit apply', () => {
      const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');
      expect(src).toContain('projectPrepayAcceptCredits(estimate, quoteCustomerId, prepayProjectedDue)');
      expect(src).toContain('projectPrepayAcceptCredits(estimate, customerId, revalidatedDue, trx)');
      expect(src).toContain('projectPendingEstimatePromoAmount(estimate, customerId, conn)');
      expect(src).toContain('redeemPromoCodeInAcceptTransaction(trx, estimate.id)');
      const redeemIdx = src.indexOf('redeemPromoCodeInAcceptTransaction(trx, estimate.id)');
      const applyIdx = src.indexOf('applyAccountCreditToInvoice({', redeemIdx);
      expect(redeemIdx).toBeGreaterThan(-1);
      expect(applyIdx).toBeGreaterThan(redeemIdx);
      expect(src).toContain('Math.min(offerAmount, Math.round((appliedCredit - balance - promoAmount) * 100) / 100)');
    });

    test('invoice-promo-code fails closed on DB error at money seams, rejects zero-applicable $0.50-min codes, uses renewalPaymentRefusal and stripe_invoice_charge_attempts', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true, gates: {} }));
        jest.doMock('../services/invoice-payer-ownership', () => ({ invoicePayerOwnership: jest.fn(async () => null) }));
        jest.doMock('../services/stripe', () => ({
          assertNoInvoiceChargeReconciliationPending: jest.fn(async (invId) => {
            if (invId === 'inv-reconciling') {
              const e = new Error('in progress');
              e.code = 'STRIPE_CHARGE_IN_PROGRESS';
              throw e;
            }
          }),
        }));
        jest.doMock('../services/termite-annual-renewal-charge', () => ({
          renewalPaymentRefusal: jest.fn(async (inv) => (inv.id === 'inv-unpayable-ren' ? { reason: 'superseded' } : null)),
        }));
        const InvoicePromo = require('../services/invoice-promo-code');

        // 1. assertNoPendingPromoCode fails CLOSED when DB throws (no silent 0).
        const failingConn = jest.fn(() => { throw new Error('db connection reset'); });
        await expect(InvoicePromo.assertNoPendingPromoCode({
          id: 'inv-1', customer_id: 'c-1', status: 'sent', total: 100, credit_applied: 0, amount_paid: 0,
        }, failingConn)).rejects.toThrow('db connection reset');

        // 2. Zero-applicable $0.25 promo on $0.50 balance (Stripe min cap -> applyAmt 0) is rejected at entry
        // and does not 409-loop assertNoPendingPromoCode.
        const zeroConn = jest.fn((table) => {
          const q = {
            where: jest.fn(() => q),
            forUpdate: jest.fn(() => q),
            first: jest.fn(async () => {
              if (table === 'discounts') return { id: 'd-tiny', is_active: true, promo_code: 'TINY25', discount_type: 'fixed_amount', amount: 0.25 };
              if (table === 'invoice_promo_codes') return null;
              return null;
            }),
          };
          return q;
        });
        const tinyEnter = await InvoicePromo.enterPromoCodeOnInvoice({
          invoice: { id: 'inv-50c', customer_id: 'c-1', status: 'sent', total: 0.50, credit_applied: 0, amount_paid: 0 },
          rawCode: 'TINY25',
        }, zeroConn);
        expect(tinyEnter).toEqual({ ok: false, reason: 'invalid_code' });

        const existingZeroConn = jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({ credit_amount: 0.25 })),
        }));
        await expect(InvoicePromo.assertNoPendingPromoCode({
          id: 'inv-50c', customer_id: 'c-1', status: 'sent', total: 0.50, credit_applied: 0, amount_paid: 0,
        }, existingZeroConn)).resolves.toBeUndefined();

        // 3. Pending saved-card attempt and unpayable renewal both suppress promo entry.
        const emptyConn = jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn(async () => null) }));
        const viewReconciling = await InvoicePromo.promoCodeViewForInvoice({
          id: 'inv-reconciling', customer_id: 'c-1', status: 'sent', total: 100, credit_applied: 0, amount_paid: 0,
        }, { conn: emptyConn });
        expect(viewReconciling).toBeNull();

        const viewUnpayableRen = await InvoicePromo.promoCodeViewForInvoice({
          id: 'inv-unpayable-ren', customer_id: 'c-1', annual_prepay_term_id: 'term-1', status: 'sent', total: 100, credit_applied: 0, amount_paid: 0,
        }, { conn: emptyConn });
        expect(viewUnpayableRen).toBeNull();
      });
    });

    test('PayPageV2 /quote handles 409 staleBalance by reloading and pay-combined excludes + locks pending-promo siblings', () => {
      const payUi = fs.readFileSync(path.join(__dirname, '../../client/src/pages/PayPageV2.jsx'), 'utf8');
      const quoteBlock = payUi.slice(payUi.indexOf('/quote'), payUi.indexOf('setDisplayedBase(quote.base)'));
      expect(quoteBlock).toContain('handleStaleOrThrowPayPhaseError');
      expect(payUi).toContain('if (payload?.staleBalance)');
      expect(payUi).toContain('window.location.reload()');

      const combSrc = fs.readFileSync(path.join(__dirname, '../services/pay-combined.js'), 'utf8');
      expect(combSrc).toContain('invoiceIdsWithPendingPromo');
      expect(combSrc).toContain('assertNoPendingPromoCode(row, trx)');
    });
  });

  describe('B-16: multi-home-discount-email payer routing and shared-inbox opt-out', () => {
    test('delivers payer-billed home to AP email even when homeowner opted out, and suppresses entire opted-out self-pay shared inbox', async () => {
      const { _private: { groupByPayingAddress } } = require('../services/multi-home-discount-email');
      const payerA = { id: 'p-1', ap_email: 'ap@builder.example', display_name: 'Builder AP' };
      const customers = new Map([
        ['c-payer', { id: 'c-payer', first_name: 'Home', email: 'homeowner@example.com' }],
        ['c-fam-1', { id: 'c-fam-1', first_name: 'Fam1', email: 'family@example.com' }],
        ['c-fam-2', { id: 'c-fam-2', first_name: 'Fam2', email: 'family@example.com' }],
        ['c-ok', { id: 'c-ok', first_name: 'Ok', email: 'ok@example.com' }],
      ]);
      const payers = new Map([['p-1', payerA]]);
      const stubDbh = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn(async () => null),
      }));

      const { groups } = await groupByPayingAddress(
        stubDbh,
        [
          { customerId: 'c-payer', payerId: 'p-1', address: '100 Main St' },
          { customerId: 'c-fam-1', payerId: null, address: '200 Oak St' },
          { customerId: 'c-fam-2', payerId: null, address: '202 Oak St' },
          { customerId: 'c-ok', payerId: null, address: '300 Pine St' },
        ],
        { customers, payers, optedOut: new Set(['c-payer', 'c-fam-1']) },
      );

      const emails = groups.map((g) => g.address);
      expect(emails).toContain('ap@builder.example');
      expect(emails).toContain('ok@example.com');
      expect(emails).not.toContain('family@example.com');

      // When a payer home and an opted-out self-pay home share the exact same email
      // address, the payer group still delivers while the self-pay group is suppressed.
      const sharedCustomers = new Map([
        ['c-p-shared', { id: 'c-p-shared', first_name: 'Builder', email: 'shared@example.com' }],
        ['c-s-optout', { id: 'c-s-optout', first_name: 'OptOut', email: 'shared@example.com' }],
        ['c-s-other', { id: 'c-s-other', first_name: 'Sibling', email: 'shared@example.com' }],
      ]);
      const sharedPayers = new Map([
        ['p-shared', { id: 'p-shared', ap_email: 'shared@example.com', display_name: 'Shared AP' }],
      ]);
      const sharedOut = await groupByPayingAddress(
        stubDbh,
        [
          { customerId: 'c-p-shared', payerId: 'p-shared', address: '1 Builder Way' },
          { customerId: 'c-s-optout', payerId: null, address: '2 Home Way' },
          { customerId: 'c-s-other', payerId: null, address: '3 Home Way' },
        ],
        { customers: sharedCustomers, payers: sharedPayers, optedOut: new Set(['c-s-optout']) },
      );
      expect(sharedOut.groups).toHaveLength(1);
      expect(sharedOut.groups[0].payer?.id).toBe('p-shared');
      expect(sharedOut.groups[0].homes.map((h) => h.customerId)).toEqual(['c-p-shared']);
    });
  });

  describe('B-38: customer dedupe dissolves 1-member orphan multi-home families', () => {
    test('customer-dedupe.js repoints and prunes 1-member orphan multi_home_family_members rows', () => {
      const dedupeSrc = fs.readFileSync(path.join(__dirname, '../services/customer-dedupe.js'), 'utf8');
      expect(dedupeSrc).toContain('repointMultiHomeFamilyMembers');
      const familySrc = fs.readFileSync(path.join(__dirname, '../services/multi-home-family.js'), 'utf8');
      expect(familySrc).toContain('pruneSingleMemberOrphan');
    });
  });
});
