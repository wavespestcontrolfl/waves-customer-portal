/**
 * completionInvoiceAlreadyDelivered — the durable "already sent" signal the
 * schedule / dispatch feeds expose as completionInvoiceAlreadySent and the
 * completion applies to a reused pre-minted invoice (Codex P1 #4131 r3):
 * an Invoices-page linked create sent NOW must not be re-texted at
 * completion.
 */
const fs = require('fs');
const path = require('path');
const { completionInvoiceAlreadyDelivered } = require('../services/invoice-helpers');

// The claim itself, interleaved: two deliverers read the same draft; the
// second UPDATE … WHERE status = 'draft' matches nothing once the first
// flipped it to 'sending', and the loser is refused — so an admin "send
// now" and the completion can never both text the pay link.
jest.mock('../models/db', () => {
  const state = { status: 'draft', sent_at: null, queuedCompletionText: null };
  const chain = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'sms_log'
      ? state.queuedCompletionText
      : { id: 'inv-1', status: state.status, sent_at: state.sent_at }));
    q.update = jest.fn((values) => ({
      returning: jest.fn(async () => {
        const expected = q.where.mock.calls[q.where.mock.calls.length - 1][0].status;
        if (state.status !== expected) return [];
        state.status = values.status;
        return [{ id: 'inv-1', status: state.status }];
      }),
      catch: jest.fn(async () => { state.status = values.status; }),
    }));
    return q;
  };
  const db = jest.fn((table) => chain(table));
  db.__state = state;
  db.fn = { now: () => new Date() };
  db.raw = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('the shared send claim (claimInvoiceForSend) under interleaving', () => {
  test('the first deliverer wins the claim; a second is refused; releasing restores the row', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend, restoreSendClaim } = require('../services/invoice');
    db.__state.status = 'draft';
    const first = await claimInvoiceForSend('inv-1');
    expect(first).toMatchObject({ previousStatus: 'draft', claimed: true });
    expect(db.__state.status).toBe('sending');
    await expect(claimInvoiceForSend('inv-1')).rejects.toThrow(/already in progress|not sendable/i);
    await restoreSendClaim('inv-1', first.previousStatus, first.claimed);
    expect(db.__state.status).toBe('draft');
  });

  test('a FIRST delivery (the linked create\'s immediate send) is refused as already_delivered once the completion delivered the row — never re-claimed from sent as a resend (GitHub r6 P1)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'sent';
    db.__state.sent_at = null;
    await expect(claimInvoiceForSend('inv-1', { firstDeliveryOnly: true })).rejects.toMatchObject({ code: 'already_delivered' });
    // A delivered-but-unfinalized draft (sent_at stamped) is delivered too.
    db.__state.status = 'draft';
    db.__state.sent_at = new Date();
    await expect(claimInvoiceForSend('inv-1', { firstDeliveryOnly: true })).rejects.toMatchObject({ code: 'already_delivered' });
    expect(db.__state.status).toBe('draft');
    // The operator's own resend (no flag) still claims from sent.
    db.__state.status = 'sent';
    db.__state.sent_at = null;
    const resend = await claimInvoiceForSend('inv-1');
    expect(resend).toMatchObject({ previousStatus: 'sent', claimed: true });
    db.__state.status = 'draft';
  });

  test('a queued completion text carrying the pay link (send-window hold) owns the delivery: every other claim is refused as in progress until it delivers or terminally fails (GitHub r5 P1)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.queuedCompletionText = { id: 'sms-q', scheduled_for: new Date('2026-09-11T12:00:00Z') };
    await expect(claimInvoiceForSend('inv-1')).rejects.toThrow(/already in progress.*queued for the send window/i);
    expect(db.__state.status).toBe('draft');
    const smsLogQuery = db.mock.results.map((r) => r.value).find((q) => q.whereRaw.mock.calls.length);
    expect(smsLogQuery.whereIn).toHaveBeenCalledWith('status', ['scheduled', 'sending']);
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("metadata->>'invoice_id' = ?", ['inv-1']);
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("metadata->>'entry_point' = ANY(?)", [['dispatch_completion_deferred', 'autopay_completion_decline_deferred']]);
    // Delivered or terminally failed → the row is no longer live → claimable again.
    db.__state.queuedCompletionText = null;
    const claim = await claimInvoiceForSend('inv-1');
    expect(claim).toMatchObject({ previousStatus: 'draft', claimed: true });
    db.__state.status = 'draft';
  });
});

describe('completionInvoiceAlreadyDelivered', () => {
  test('delivered = sent_at stamped, or a sent / paid / prepaid status', () => {
    expect(completionInvoiceAlreadyDelivered({ status: 'draft', sent_at: new Date() })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'sent', sent_at: null })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'paid' })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'prepaid' })).toBe(true);
  });
  test('not delivered = no invoice, a draft, sending, or overdue-unsent', () => {
    expect(completionInvoiceAlreadyDelivered(null)).toBe(false);
    expect(completionInvoiceAlreadyDelivered({ status: 'draft', sent_at: null })).toBe(false);
    expect(completionInvoiceAlreadyDelivered({ status: 'sending' })).toBe(false);
    expect(completionInvoiceAlreadyDelivered({})).toBe(false);
  });
  test('source contract: every visit feed exposes completionInvoiceAlreadySent from the attached invoice, and the completion applies it to a reused pre-minted invoice', () => {
    const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(schedule.match(/completionInvoiceAlreadySent: completionInvoiceAlreadyDelivered\(checkoutInvoice\)/g)).toHaveLength(2);
    expect(schedule.match(/'credit_applied', 'payer_id', 'sent_at'\)/g)).toHaveLength(2);
    const dispatch = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(dispatch).toContain("completionInvoiceAlreadySent: require('../services/invoice-helpers').completionInvoiceAlreadyDelivered(checkoutInvoice)");
    expect(dispatch).toContain(".first('id', 'status', 'total', 'token', 'sent_at')");
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/const suppressCompletionInvoiceLink = !!invoiceAlreadySent\s*\|\| !!\(preMintedInvoice && require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(preMintedInvoice\)\);/);
    // …and takes the ONE send claim before texting a link for a reused invoice (Codex P1 r4):
    // claim at the decision, finalize via markDeliverySent when the link went out, release otherwise (normal end and thrown path).
    expect(completion).toMatch(/const claim = await InvoiceServiceForClaim\.claimInvoiceForSend\(invoice\.id\);[\s\S]{0,600}?if \(require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(claim\.invoice\)\) \{\s*await InvoiceServiceForClaim\.restoreSendClaim\(invoice\.id, claim\.previousStatus, claim\.claimed\);[\s\S]{0,300}?reusedInvoiceClaimedElsewhere = true;\s*\} else \{\s*completionInvoiceSendClaim = \{ invoiceId: invoice\.id, previousStatus: claim\.previousStatus, claimed: claim\.claimed \};/);
    // The claim is attempted only when every other pay-link gate already passes.
    // …including a decline notice that already delivered the link (GitHub r6 P1): report-only, no claim.
    expect(completion).toMatch(/const linkOtherwiseEligible = !suppressCompletionInvoiceLink\s*&& includePayLink !== false[\s\S]{0,2200}?&& !invoice\?\.payer_id\s*(?:\/\/[^\n]*\n\s*)*&& !paymentFailedNoticeSent;[\s\S]{0,1200}?if \(linkOtherwiseEligible && preMintedInvoice && invoice\?\.id/);
    expect(completion).toMatch(/const allowCompletionInvoiceLink = linkOtherwiseEligible && !reusedInvoiceClaimedElsewhere;/);
    expect(completion).not.toMatch(/allowCompletionInvoiceLinkBase/);
    // A refused claim is classified: settled/gone → report-only; in-flight send or transient failure → the resumable 503 (retryable delivery).
    expect(completion).toMatch(/const nothingLeftToDeliver = \/Cannot send a \(paid\|prepaid\|voided\) invoice\|Cannot send an invoice while payment is processing\|Invoice not found\|Invoice is not sendable\/i\.test\(claimMessage\);\s*if \(!nothingLeftToDeliver\) \{[\s\S]{0,300}?return exitForCompletionSmsResume\(new Error\(`Invoice \$\{invoice\.id\} delivery claim unavailable: \$\{claimMessage\}`\)\);/);
    // The link is delivered at PROVIDER ACCEPTANCE, before markDeliverySent, on both the success path and the accepted-then-threw catch (GitHub r5 P1): a failed status sync never hands the claim back on a texted link.
    expect(completion.match(/completionInvoiceLinkDelivered = true;/g)).toHaveLength(2);
    expect(completion).toMatch(/completionSmsProviderAccepted = smsResult\.sent === true;[\s\S]{0,900}?if \(completionSmsProviderAccepted && invoice\?\.id && invoiceCreated && payUrl && allowCompletionInvoiceLink\) \{\s*completionInvoiceLinkDelivered = true;\s*\}/);
    expect(completion).toMatch(/if \(invoice\?\.id && invoiceCreated && payUrl && snap\.invoiceLinkAllowed\) \{[\s\S]{0,300}?completionInvoiceLinkDelivered = true;\s*try \{\s*const InvoiceService = require\('\.\.\/services\/invoice'\);\s*invoice = await InvoiceService\.markDeliverySent/);
    expect(completion).not.toMatch(/markDeliverySent\([\s\S]{0,200}?\}\);\s*completionInvoiceLinkDelivered = true;/);
    // ONE release, in the outer finally — covers the normal end, the 503 resume returns and a throw.
    expect(completion).toMatch(/throw err;\s*\} finally \{[\s\S]{0,900}?if \(completionInvoiceSendClaim\?\.claimed && !completionInvoiceLinkDelivered\) \{\s*await require\('\.\.\/services\/invoice'\)\.restoreSendClaim\(completionInvoiceSendClaim\.invoiceId, completionInvoiceSendClaim\.previousStatus, true\);[\s\S]{0,120}?\}\s*\}\s*\}\s*\n\s*module\.exports = \{/);
    expect(completion.match(/restoreSendClaim\(completionInvoiceSendClaim\.invoiceId/g)).toHaveLength(1);
  });
});
