/**
 * sendInvoiceFromBar (the Intelligence Bar's send_invoice, owner ruling
 * 2026-10-07) runs the SAME named handler as POST /admin/invoices/:id/send with
 * a capture response. The bar's call reaches the service with the route's own
 * arguments; only the adapter-only fields (the approved total, recipients and
 * version for a send) are added, and the HTTP route never carries them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));

const express = require('express');
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
    const recipients = { phone: '9415550100' };
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
    // The bar sends one text: no email leg, and a queued pay-link text is never adopted (round 13).
    expect(barCall[1]).toEqual({ ...pageCall[1], expectedTotal: 129, expectedRecipients: recipients, expectedVersion: version, skipAccountCreditAutoApply: true, holdExempt: null, refusalOnly: true, channels: ['sms'], adoptsQueuedInvoiceSend: false });
    expect(pageCall[1].channels).toBeUndefined();
    expect(pageCall[1].adoptsQueuedInvoiceSend).toBeUndefined();
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
  test('sendViaSMSAndEmail hands the phone to the text leg; the bar starts no email leg', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('));
    expect(fn).toContain('...(expectedRecipients ? { expectedSmsPhone: expectedRecipients.phone } : {}),');
    expect(fn).not.toContain('expectedEmail');
    // Both re-entries (the zero-due retry and the renewal gate) keep the pins.
    expect(fn.slice(0, fn.indexOf('let packetClaim')).match(/^\s+expectedRecipients, refusalOnly, expectedVersion, channels, adoptsQueuedInvoiceSend,$/gm)).toHaveLength(2);
  });

  test('the send\'s closeout at finalization is handed the visit the card approved, and no other delivery call site is', () => {
    const src = require('fs').readFileSync(require.resolve('../services/invoice.js'), 'utf8');
    const fn = src.slice(src.indexOf('  async sendViaSMSAndEmail('), src.indexOf('  async markDeliverySent('));
    expect(fn).toContain('approvedTarget: expectedVersion?.closeoutTarget || null });');
    expect(fn.match(/closeOutVisitForIssuedInvoice\(\{/g)).toHaveLength(1);
    expect(src.match(/approvedTarget: expectedVersion/g)).toHaveLength(1);
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
