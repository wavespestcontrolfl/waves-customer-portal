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
    // …and re-reads the reused invoice's LIVE state at the link decision, honoring the send's own 'sending' claim (Codex P1 r4).
    expect(completion).toMatch(/const live = await db\('invoices'\)\.where\(\{ id: invoice\.id \}\)\.first\('status', 'sent_at'\);\s*reusedInvoiceClaimedElsewhere = !!live && \(String\(live\.status\) === 'sending'\s*\|\| require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(live\)\);/);
    expect(completion).toMatch(/const allowCompletionInvoiceLinkBase = !suppressCompletionInvoiceLink\s*&& !reusedInvoiceClaimedElsewhere/);
  });
});
