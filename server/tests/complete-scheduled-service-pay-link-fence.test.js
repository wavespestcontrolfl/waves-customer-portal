/**
 * Round-17 class work (#4131): every pay-link sender in the completion path
 * must acquire the ONE shared send claim (claimInvoiceForSend in
 * server/services/invoice.js) before its provider call — a live send
 * holding the claim mid-flight must be invisible to no other sender.
 * Behavioral coverage for the two chokepoints this round wired in:
 *   - the payment_failed decline notice: invoice-send-claim-chokepoint-postgres.test.js
 *   - the completion-SMS block itself: pre-existing (round 16)
 * This is the SOURCE CONTRACT that locks the shape in place — a future edit
 * that moves the claim after the provider call (or drops it) fails HERE,
 * not at the next review round.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

describe('complete-scheduled-service.js pay-link senders acquire the shared claim (round-17 #4131)', () => {
  test('the payment_failed decline notice claims the invoice BEFORE its sendCustomerMessage call, and restores on every non-delivered exit', () => {
    const start = source.indexOf("if (paymentFailedBody) {");
    const end = source.indexOf('} catch (failErr) {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const claimAt = block.indexOf('paymentFailedDeclineClaim = await InvoiceServiceForDeclineClaim.claimInvoiceForSend(invoice.id);');
    const sendAt = block.indexOf('const failResult = await sendCustomerMessage({');
    const restoreAt = block.indexOf('await InvoiceServiceForDeclineClaim.restoreSendClaim(invoice.id, paymentFailedDeclineClaim.previousStatus, paymentFailedDeclineClaim.claimed)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(claimAt);
    expect(restoreAt).toBeGreaterThan(sendAt);
    // The restore only fires on a non-delivered exit — a delivered notice
    // finalizes through markDeliverySent's own CAS instead.
    expect(block).toMatch(/if \(!paymentFailedNoticeDelivered\) \{\s*\n\s*await InvoiceServiceForDeclineClaim\.restoreSendClaim\(/);
  });

  test('the payer AP invoice email claims the invoice BEFORE sendInvoiceEmail, and restores on every non-delivered exit', () => {
    const start = source.indexOf('const sendPayerInvoiceToApIfEligible = async () => {');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 4500); // generous bound — this function is small
    const end = start + block.indexOf('\n    };\n'); // the function's own closing
    const claimAt = block.indexOf('payerApClaim = await InvoiceServiceForClaim.claimInvoiceForSend(invoice.id);');
    const sendAt = block.indexOf('const payerSend = await InvoiceEmail.sendInvoiceEmail(invoice.id);');
    const restoreAt = block.indexOf('await InvoiceServiceForClaim.restoreSendClaim(invoice.id, payerApClaim.previousStatus, payerApClaim.claimed)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(claimAt);
    expect(restoreAt).toBeGreaterThan(sendAt);
    expect(block).toMatch(/if \(!payerApDelivered\) \{\s*\n\s*await InvoiceServiceForClaim\.restoreSendClaim\(/);
    expect(end).toBeGreaterThan(restoreAt);
  });
});
