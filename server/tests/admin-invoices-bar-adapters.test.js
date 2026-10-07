/**
 * sendInvoiceFromBar / chargeInvoiceFromBar (the Intelligence Bar's
 * send_invoice / charge_invoice, owner ruling 2026-10-07) run the SAME named
 * handlers as POST /admin/invoices/:id/send and /:id/charge-card with a
 * capture response. The bar's call reaches the service with the route's own
 * arguments; only the adapter-only fields (the approved total for a send, the
 * cap guard + provenance stamp for a charge) are added, and the HTTP routes
 * never carry them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(), quoteInvoiceSavedCardCharge: jest.fn() }));
jest.mock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));

const express = require('express');
const StripeService = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const router = require('../routes/admin-invoices');

async function post(path, body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => jest.clearAllMocks());

describe('sendInvoiceFromBar', () => {
  test('runs the Send handler: the same service call as the page, plus the approved total and recipients, no credit draw, no hold exemption', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } });
    const page = await post('/inv-1/send', { requestReview: false });
    const pageCall = InvoiceService.sendViaSMSAndEmail.mock.calls[0];
    const recipients = { phone: '9415550100', email: 'robin@example.com' };
    const bar = await router.sendInvoiceFromBar({
      invoiceId: 'inv-1', body: { requestReview: false }, actor: { technicianId: 'staff-1' }, approvedSend: { expectedTotal: 129, recipients },
    });
    const barCall = InvoiceService.sendViaSMSAndEmail.mock.calls[1];
    expect(page).toEqual({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    expect(bar).toEqual(page);
    expect(barCall[0]).toBe('inv-1');
    // Same call as the page, except the bar never draws credit and never takes the
    // page's operator dispute-hold exemption, and it carries the approved total + recipients.
    expect(barCall[1]).toEqual({ ...pageCall[1], expectedTotal: 129, expectedRecipients: recipients, skipAccountCreditAutoApply: true, holdExempt: null, refusalOnly: true });
    expect(pageCall[1].holdExempt).toBe('operator');
    expect(pageCall[1].refusalOnly).toBeUndefined();
    expect(pageCall[1].expectedTotal).toBeUndefined();
    expect(pageCall[1].skipAccountCreditAutoApply).toBeUndefined();
    expect(pageCall[1]).toMatchObject({ requestReview: false, operatorInitiated: true, holdExempt: 'operator', actorTechnicianId: 'staff-1', firstDeliveryOnly: false, overridesReviewHold: false });
  });

  test('the handler\'s own refusals come back as its reply; an unexpected error rejects', async () => {
    InvoiceService.sendViaSMSAndEmail.mockRejectedValueOnce(new Error('Invoice already paid'));
    await expect(router.sendInvoiceFromBar({ invoiceId: 'inv-1', body: {}, actor: {}, approvedSend: { expectedTotal: 1 } }))
      .resolves.toEqual({ status: 400, json: { error: 'Invoice already paid' } });
    InvoiceService.sendViaSMSAndEmail.mockResolvedValueOnce({ ok: false, code: 'deposit_settlement_pending', error: 'held' });
    await expect(router.sendInvoiceFromBar({ invoiceId: 'inv-1', body: {}, actor: {}, approvedSend: { expectedTotal: 1 } }))
      .resolves.toMatchObject({ status: 409 });
    InvoiceService.sendViaSMSAndEmail.mockRejectedValueOnce(new Error('database down'));
    await expect(router.sendInvoiceFromBar({ invoiceId: 'inv-1', body: {}, actor: {}, approvedSend: { expectedTotal: 1 } }))
      .rejects.toThrow('database down');
  });
});

describe('the approved recipients reach each send leg (source contract)', () => {
  test('sendViaSMSAndEmail hands the phone to the text leg and the email to the email leg', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('));
    expect(fn).toContain('...(expectedRecipients ? { expectedSmsPhone: expectedRecipients.phone } : {}),');
    expect(fn).toContain('...(expectedRecipients ? { expectedEmail: expectedRecipients.email } : {}),');
    // Both re-entries (the zero-due retry and the renewal gate) keep the pins.
    expect(fn.slice(0, fn.indexOf('let packetClaim')).match(/^\s+expectedRecipients, refusalOnly,$/gm)).toHaveLength(2);
  });

  test('refusalOnly: a hold refusal is not requeued as a later scheduled send', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('));
    expect(fn).toContain('if (restored && !allowClaimed && !refusalOnly && (sms.code === "COLLECTION_HOLD_DEFER" || email.code === "COLLECTION_HOLD_DEFER")) {');
  });

  test('refusalOnly: a terminal visit at send is held for review, never voided, on both void paths', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('));
    const refuseIdx = fn.indexOf('if (claimed && refusalOnly) {');
    const voidIdx = fn.indexOf('voidOpenInvoicesForCancelledService(');
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeLessThan(voidIdx);
    expect(fn.slice(refuseIdx, voidIdx)).toContain('terminalVisitVoided = false;');
    expect(fn.match(/zeroDueWrapperOutcomeIfDetected\(invoiceId, err, allowClaimed, _zeroDueRetried \? null : retryOnce, \{ refusalOnly \}\)/g)).toHaveLength(2);
    expect(src).toContain('const voided = refusalOnly ? false : await voidTerminalZeroDueInvoice(invoiceId, outcome.scheduledServiceId);');
  });
});

describe('chargeInvoiceFromBar', () => {
  test('runs the charge-card handler: the same StripeService call as the page, plus the cap guard and the stamp', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockResolvedValue({ paymentId: 'pay-1', status: 'paid', amount: 132.87 });
    const page = await post('/inv-1/charge-card', { paymentMethodId: 'pm-1', expectedTotal: 132.87 });
    const pageCall = StripeService.chargeInvoiceWithSavedCard.mock.calls[0];
    const chargeGuard = jest.fn();
    const bar = await router.chargeInvoiceFromBar({
      invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1', expectedTotal: 132.87 }, actor: { technicianId: 'staff-1' }, chargeGuard,
    });
    const barCall = StripeService.chargeInvoiceWithSavedCard.mock.calls[1];
    expect(page).toEqual({ status: 200, json: { success: true, paymentId: 'pay-1', status: 'paid', amount: 132.87 } });
    expect(bar).toEqual(page);
    expect(barCall.slice(0, 2)).toEqual(['inv-1', 'pm-1']);
    const { assertUnderChargeLock, initiatedVia, ...barOptions } = barCall[2];
    expect(assertUnderChargeLock).toBe(chargeGuard);
    expect(initiatedVia).toBe('intelligence_bar');
    // Same options as the page (the trail's ip / user agent are request facts the bar has none of).
    expect({ ...barOptions, overrideTrail: { ...barOptions.overrideTrail, ip: 'x', userAgent: 'x' } })
      .toEqual({ ...pageCall[2], overrideTrail: { ...pageCall[2].overrideTrail, ip: 'x', userAgent: 'x' } });
    expect(barOptions).toMatchObject({ expectedTotal: 132.87, operatorOverride: true, overrideTrail: { actorId: 'staff-1', route: 'admin_invoice_charge_card', invoiceId: 'inv-1' } });
    expect(pageCall[2].assertUnderChargeLock).toBeUndefined();
    expect(pageCall[2].initiatedVia).toBeUndefined();
  });

  test('a body field cannot set the bar-only options on the HTTP route', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockResolvedValue({ paymentId: 'pay-1' });
    await post('/inv-1/charge-card', { paymentMethodId: 'pm-1', ibChargeGuard: 'x', initiatedVia: 'intelligence_bar' });
    expect(StripeService.chargeInvoiceWithSavedCard.mock.calls[0][2].initiatedVia).toBeUndefined();
    expect(StripeService.chargeInvoiceWithSavedCard.mock.calls[0][2].assertUnderChargeLock).toBeUndefined();
  });

  test('a guard refusal thrown inside the charge comes back as the route\'s 400 with its text; uncertain outcomes keep their 409', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValueOnce(new Error('Bar charge limit: the bar has charged $1400.00 today'));
    await expect(router.chargeInvoiceFromBar({ invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1', expectedTotal: 400 }, actor: {}, chargeGuard: jest.fn() }))
      .resolves.toEqual({ status: 400, json: { error: 'Bar charge limit: the bar has charged $1400.00 today' } });
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'STRIPE_AMBIGUOUS_OUTCOME' }));
    await expect(router.chargeInvoiceFromBar({ invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1', expectedTotal: 400 }, actor: {}, chargeGuard: jest.fn() }))
      .resolves.toMatchObject({ status: 409, json: { code: 'STRIPE_AMBIGUOUS_OUTCOME', ambiguous: true } });
  });
});
