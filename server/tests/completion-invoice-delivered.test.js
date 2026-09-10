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
  const state = { status: 'draft' };
  const chain = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => ({ id: 'inv-1', status: state.status }));
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
  const db = jest.fn(() => chain());
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
    expect(completion).toMatch(/const linkOtherwiseEligible = !suppressCompletionInvoiceLink\s*&& includePayLink !== false[\s\S]{0,1600}?&& !invoice\?\.payer_id;[\s\S]{0,1200}?if \(linkOtherwiseEligible && preMintedInvoice && invoice\?\.id/);
    expect(completion).toMatch(/const allowCompletionInvoiceLinkBase = linkOtherwiseEligible && !reusedInvoiceClaimedElsewhere;/);
    // A refused claim is classified: settled/gone → report-only; in-flight send or transient failure → the resumable 503 (retryable delivery).
    expect(completion).toMatch(/const nothingLeftToDeliver = \/Cannot send a \(paid\|prepaid\|voided\) invoice\|Cannot send an invoice while payment is processing\|Invoice not found\|Invoice is not sendable\/i\.test\(claimMessage\);\s*if \(!nothingLeftToDeliver\) \{[\s\S]{0,300}?return exitForCompletionSmsResume\(new Error\(`Invoice \$\{invoice\.id\} delivery claim unavailable: \$\{claimMessage\}`\)\);/);
    expect(completion.match(/completionInvoiceLinkDelivered = true;/g)).toHaveLength(2);
    // ONE release, in the outer finally — covers the normal end, the 503 resume returns and a throw.
    expect(completion).toMatch(/throw err;\s*\} finally \{[\s\S]{0,900}?if \(completionInvoiceSendClaim\?\.claimed && !completionInvoiceLinkDelivered\) \{\s*await require\('\.\.\/services\/invoice'\)\.restoreSendClaim\(completionInvoiceSendClaim\.invoiceId, completionInvoiceSendClaim\.previousStatus, true\);[\s\S]{0,120}?\}\s*\}\s*\}\s*\n\s*module\.exports = \{/);
    expect(completion.match(/restoreSendClaim\(completionInvoiceSendClaim\.invoiceId/g)).toHaveLength(1);
  });
});
