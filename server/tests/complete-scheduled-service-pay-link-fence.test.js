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
    const claimAt = block.indexOf('paymentFailedDeclineClaim = await InvoiceServiceForDeclineClaim.claimInvoiceForSend(invoice.id, { firstDeliveryOnly: true });');
    const sendAt = block.indexOf('const failResult = await sendCustomerMessage({');
    const restoreAt = block.indexOf('await InvoiceServiceForDeclineClaim.restoreSendClaim(invoice.id, paymentFailedDeclineClaim.previousStatus, paymentFailedDeclineClaim.claimed)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(claimAt);
    expect(restoreAt).toBeGreaterThan(sendAt);
    // The restore only fires on a non-delivered exit — a delivered notice
    // finalizes through markDeliverySent's own CAS instead.
    expect(block).toMatch(/if \(!paymentFailedNoticeDelivered\) \{\s*\n\s*await InvoiceServiceForDeclineClaim\.restoreSendClaim\(/);
  });

  // Round-20 P1 (#4131, second claim-mode bug — same shape as the payer AP
  // email two rounds ago): this notice only ever performs a FIRST delivery
  // of the pay link. The default claim mode treats 'sent'/'viewed'/
  // 'overdue' as claimable (the deliberate resend allowance every genuine
  // resend caller needs), so an office Immediate send that finalizes to
  // 'sent' between this handler's own read and this claim would still be
  // granted here as an "intentional resend" and text the SAME pay link a
  // second time. firstDeliveryOnly closes that gap.
  test('the decline notice claim uses firstDeliveryOnly — this sender never treats an already-delivered row as a resendable claim', () => {
    const start = source.indexOf("if (paymentFailedBody) {");
    const end = source.indexOf('} catch (failErr) {', start);
    const block = source.slice(start, end);
    expect(block).toMatch(/claimInvoiceForSend\(invoice\.id, \{ firstDeliveryOnly: true \}\)/);
  });

  test('the payer AP invoice email claims the invoice BEFORE sendInvoiceEmail, and restores on every non-delivered exit', () => {
    const start = source.indexOf('const sendPayerInvoiceToApIfEligible = async () => {');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 5500); // generous bound — this function is small
    const end = start + block.indexOf('\n    };\n'); // the function's own closing
    const claimAt = block.indexOf('payerApClaim = await InvoiceServiceForClaim.claimInvoiceForSend(invoice.id, { firstDeliveryOnly: true });');
    const sendAt = block.indexOf('const payerSend = await InvoiceEmail.sendInvoiceEmail(invoice.id);');
    const restoreAt = block.indexOf('await InvoiceServiceForClaim.restoreSendClaim(invoice.id, payerApClaim.previousStatus, payerApClaim.claimed)');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(claimAt);
    expect(restoreAt).toBeGreaterThan(sendAt);
    expect(block).toMatch(/if \(!payerApDelivered\) \{\s*\n\s*await InvoiceServiceForClaim\.restoreSendClaim\(/);
    expect(end).toBeGreaterThan(restoreAt);
  });

  // Round-18 P1 (#4131): this branch only runs once payerInvoiceAlreadyDelivered
  // read false, so it is always a first delivery — never a resend. The default
  // claim mode treats 'sent'/'viewed'/'overdue' as claimable (a deliberate resend
  // allowance for every OTHER caller of claimInvoiceForSend), so a bare claim here
  // would be granted as a "resend" for a row another sender finalized between that
  // read and this claim, texting the AP inbox a second copy. firstDeliveryOnly
  // closes that gap by refusing the claim outright once the row shows first-delivery
  // evidence, instead of only checking a point-in-time snapshot.
  test('the payer AP claim uses firstDeliveryOnly — this sender never treats an already-delivered row as a resendable claim', () => {
    const start = source.indexOf('const sendPayerInvoiceToApIfEligible = async () => {');
    const block = source.slice(start, start + 5500);
    expect(block).toMatch(/claimInvoiceForSend\(invoice\.id, \{ firstDeliveryOnly: true \}\)/);
  });
});
