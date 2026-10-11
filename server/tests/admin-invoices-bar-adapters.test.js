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
    const version = { updatedAtMs: 4070908800000, digest: 'abc123' };
    const bar = await router.sendInvoiceFromBar({
      invoiceId: 'inv-1', body: { requestReview: false }, actor: { technicianId: 'staff-1' }, approvedSend: { expectedTotal: 129, recipients, version },
    });
    const barCall = InvoiceService.sendViaSMSAndEmail.mock.calls[1];
    expect(page).toEqual({ status: 200, json: { ok: true, sms: { ok: true }, email: { ok: true } } });
    expect(bar).toEqual(page);
    expect(barCall[0]).toBe('inv-1');
    // Same call as the page, except the bar never draws credit and never takes the
    // page's operator dispute-hold exemption, and it carries the approved total + recipients.
    expect(barCall[1]).toEqual({ ...pageCall[1], expectedTotal: 129, expectedRecipients: recipients, expectedVersion: version, skipAccountCreditAutoApply: true, holdExempt: null, refusalOnly: true });
    expect(pageCall[1].holdExempt).toBe('operator');
    expect(pageCall[1].refusalOnly).toBeUndefined();
    expect(pageCall[1].expectedTotal).toBeUndefined();
    expect(pageCall[1].expectedVersion).toBeUndefined();
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

describe('a send that loses the race to another delivery (PR #6117 round-1 P1)', () => {
  const inProgress = () => Object.assign(new Error('Invoice INV-1 is already being delivered by another request — not sent again'), { code: 'delivery_in_progress' });

  test('a never-sent invoice sent as a first delivery is a no-op success when another delivery owns the claim', async () => {
    InvoiceService.sendViaSMSAndEmail.mockRejectedValueOnce(inProgress());
    const result = await router.sendInvoiceFromBar({
      invoiceId: 'inv-1', body: { requestReview: false, firstDelivery: true }, actor: {}, approvedSend: { expectedTotal: 1 },
    });
    expect(InvoiceService.sendViaSMSAndEmail.mock.calls[0][1].firstDeliveryOnly).toBe(true);
    expect(result).toMatchObject({ status: 200, json: { ok: true, in_progress: true } });
  });

  test('a resend that finds a live claim is the route\'s 409, which the tool reports as uncertain', async () => {
    InvoiceService.sendViaSMSAndEmail.mockRejectedValueOnce(inProgress());
    await expect(router.sendInvoiceFromBar({ invoiceId: 'inv-1', body: { requestReview: false }, actor: {}, approvedSend: { expectedTotal: 1 } }))
      .resolves.toMatchObject({ status: 409, json: { code: 'delivery_in_progress' } });
  });

  test('a changed approved version comes back as the wrapper\'s refusal (400), not a delivery', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValueOnce({ ok: false, code: 'approved_version_changed', error: 'changed', sms: { ok: false }, email: { ok: false } });
    await expect(router.sendInvoiceFromBar({ invoiceId: 'inv-1', body: {}, actor: {}, approvedSend: { expectedTotal: 1, version: { updatedAtMs: 1, digest: 'x' } } }))
      .resolves.toMatchObject({ status: 400, json: { code: 'approved_version_changed', error: 'changed' } });
  });
});

describe('the approved recipients reach each send leg (source contract)', () => {
  test('sendViaSMSAndEmail hands the phone to the text leg and the email to the email leg', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('));
    expect(fn).toContain('...(expectedRecipients ? { expectedSmsPhone: expectedRecipients.phone } : {}),');
    expect(fn).toContain('...(expectedRecipients ? { expectedEmail: expectedRecipients.email } : {}),');
    // Both re-entries (the zero-due retry and the renewal gate) keep the pins.
    expect(fn.slice(0, fn.indexOf('let packetClaim')).match(/^\s+expectedRecipients, refusalOnly, expectedVersion,$/gm)).toHaveLength(2);
  });

  test('refusalOnly: a held text is never queued for later and a hold refusal is never requeued as a scheduled send', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('), src.indexOf('  async sendViaSMSAndEmail(') + 60000);
    expect(fn).toContain('if (restored && !allowClaimed && !refusalOnly && (sms.code === "COLLECTION_HOLD_DEFER" || email.code === "COLLECTION_HOLD_DEFER")) {');
    // The one deferred-text enqueue in the wrapper (entry point invoice_send_deferred) sits behind !refusalOnly.
    const gate = fn.indexOf('&& !refusalOnly\n      && REPLAY_HOLD_CODES.includes(sms.code)');
    const insert = fn.indexOf('await db("sms_log").insert({');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(insert);
    expect(fn.indexOf('await db("sms_log").insert({', insert + 1)).toBe(-1);
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

describe('the approved invoice version at the charge (PR #6117 round-2 P1, source contract + helper)', () => {
  const { invoiceMatchesApprovedVersion, approvedInvoiceVersionDigest } = require('../services/invoice-helpers');
  const row = { total: '129.00', credit_applied: '0.00', line_items: [{ description: 'Quarterly Pest Control', amount: 129 }], updated_at: new Date('2099-01-01T12:00:00.250Z') };
  const version = { updatedAtMs: new Date('2099-01-01T12:00:00.250Z').getTime(), digest: approvedInvoiceVersionDigest(row) };

  test('the helper matches only the same edit time and the same amount due / lines', () => {
    expect(invoiceMatchesApprovedVersion(row, version)).toBe(true);
    expect(invoiceMatchesApprovedVersion(row, null)).toBe(true);
    expect(invoiceMatchesApprovedVersion({ ...row, updated_at: new Date('2099-01-01T12:00:09Z') }, version)).toBe(false);
    expect(invoiceMatchesApprovedVersion({ ...row, credit_applied: '20.00' }, version)).toBe(false);
    expect(invoiceMatchesApprovedVersion({ ...row, line_items: [{ description: 'Other', amount: 129 }] }, version)).toBe(false);
  });

  test('chargeInvoiceWithSavedCard compares it with the LOCKED row after the collectible checks and before account credit, quotes and Stripe', () => {
    const src = require('fs').readFileSync(require.resolve('../services/stripe.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async chargeInvoiceWithSavedCard('));
    const check = fn.indexOf('invoiceMatchesApprovedVersion(lockedInvoice, expectedVersion)');
    expect(check).toBeGreaterThan(-1);
    expect(fn.indexOf('assertInvoiceCollectible(lockedInvoice);')).toBeLessThan(check);
    expect(fn.indexOf('applyAccountCreditToInvoice({ invoiceId }, trx)')).toBeGreaterThan(check);
    expect(fn.indexOf('paymentIntents.create')).toBeGreaterThan(check);
    expect(fn.slice(check, check + 400)).toContain("code: 'approved_version_changed'");
  });

  test('the route hands the bar\'s version to the charge and answers a version refusal as a coded 400; the page never sets it', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockResolvedValue({ paymentId: 'pay-1' });
    await router.chargeInvoiceFromBar({ invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1' }, actor: {}, chargeGuard: jest.fn(), version });
    expect(StripeService.chargeInvoiceWithSavedCard.mock.calls[0][2].expectedVersion).toEqual(version);
    await post('/inv-1/charge-card', { paymentMethodId: 'pm-1', ibChargeVersion: version, expectedVersion: version });
    expect(StripeService.chargeInvoiceWithSavedCard.mock.calls[1][2].expectedVersion).toBeUndefined();
    StripeService.chargeInvoiceWithSavedCard.mockRejectedValueOnce(Object.assign(new Error('Invoice changed after it was approved'), { code: 'approved_version_changed' }));
    await expect(router.chargeInvoiceFromBar({ invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1' }, actor: {}, chargeGuard: jest.fn(), version }))
      .resolves.toEqual({ status: 400, json: { error: 'Invoice changed after it was approved', code: 'approved_version_changed' } });
  });
});

describe('the receipt outcome the charge reports (PR #6117 round-2 P2, source contract)', () => {
  test('receiptQueued is set from the enqueue result and from its failure, never from the charge outcome, and reaches the return value', () => {
    const src = require('fs').readFileSync(require.resolve('../services/stripe.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async chargeInvoiceWithSavedCard('), src.indexOf('  // PAYMENT HISTORY'));
    expect(fn).toContain('receiptQueued = enqueueResult.enqueued === true || enqueueResult.deduped === true;');
    // The enqueue failure is still swallowed (the charge is paid), but now recorded.
    const catchAt = fn.indexOf('Card-on-file receipt queue failed');
    expect(fn.slice(catchAt - 300, catchAt)).toContain('receiptQueued = false;');
    expect(fn).toContain('...(receiptQueued === undefined ? {} : { receiptQueued, ...(receiptQueued ? {} : { receiptQueueError }) }),');
    // It is only set inside the paid branch: a processing charge reports nothing about a receipt.
    expect(fn.indexOf("if (status === 'paid') {")).toBeLessThan(fn.indexOf('receiptQueued = enqueueResult'));
  });
});

describe('chargeInvoiceFromBar', () => {
  test('runs the charge-card handler: the same StripeService call as the page, plus the cap guard and the stamp', async () => {
    StripeService.chargeInvoiceWithSavedCard.mockResolvedValue({ paymentId: 'pay-1', status: 'paid', amount: 132.87 });
    const page = await post('/inv-1/charge-card', { paymentMethodId: 'pm-1', expectedTotal: 132.87 });
    const pageCall = StripeService.chargeInvoiceWithSavedCard.mock.calls[0];
    const chargeGuard = jest.fn();
    const bar = await router.chargeInvoiceFromBar({
      invoiceId: 'inv-1', body: { paymentMethodId: 'pm-1', expectedTotal: 132.87 }, actor: { technicianId: 'staff-1' }, chargeGuard, closeoutTarget: 'visit-1', ibActionId: null,
    });
    const barCall = StripeService.chargeInvoiceWithSavedCard.mock.calls[1];
    expect(page).toEqual({ status: 200, json: { success: true, paymentId: 'pay-1', status: 'paid', amount: 132.87 } });
    expect(bar).toEqual(page);
    expect(barCall.slice(0, 2)).toEqual(['inv-1', 'pm-1']);
    const { assertUnderChargeLock, initiatedVia, expectedVersion, approvedCloseoutTarget, ibActionId, ...barOptions } = barCall[2];
    // The confirmed bar action id rides to the charge (PaymentIntent metadata, orphan mark); the page sets none.
    expect(ibActionId).toBeNull();
    expect(pageCall[2].ibActionId).toBeUndefined();
    expect(expectedVersion).toBeNull();
    // The visit the card approved for the paid-invoice closeout rides to the charge; the page sets none.
    expect(approvedCloseoutTarget).toBe('visit-1');
    expect(pageCall[2].approvedCloseoutTarget).toBeUndefined();
    expect(assertUnderChargeLock).toBe(chargeGuard);
    expect(initiatedVia).toBe('intelligence_bar');
    // Same options as the page (the trail's ip / user agent are request facts the bar has none of).
    expect({ ...barOptions, overrideTrail: { ...barOptions.overrideTrail, ip: 'x', userAgent: 'x' } })
      .toEqual({ ...pageCall[2], operatorOverride: false, overrideTrail: { ...pageCall[2].overrideTrail, ip: 'x', userAgent: 'x' } });
    expect(barOptions).toMatchObject({ expectedTotal: 132.87, operatorOverride: false, overrideTrail: { actorId: 'staff-1', route: 'admin_invoice_charge_card', invoiceId: 'inv-1' } });
    expect(pageCall[2].assertUnderChargeLock).toBeUndefined();
    expect(pageCall[2].initiatedVia).toBeUndefined();
    // The page overrides a dispute hold; the bar never does (no override trail can be written for it).
    expect(pageCall[2].operatorOverride).toBe(true);
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
