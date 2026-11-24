'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { computeRefundSurcharge } = require('../../../server/services/stripe-pricing');

const cents = (dollars) => Math.round(Number(dollars) * 100);
const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata || {});

// The office refunds the saved-card payment the earlier journey made: part of it, then the rest. What Stripe is told to
// return, what the payment row records and what the signed Stripe event later confirms must be the same money, once.
module.exports = {
  name: 'refund-matches-entered-amount-once',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, webhookSecret } = ctx;
    const headers = { Authorization: `Bearer ${ctx.adminToken}` };
    const captured = () => fs.readFileSync(ctx.captureFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = captured().length;
    const startedAt = new Date();
    const since = () => captured().slice(before);
    const stripeCalls = (from = 0) => since().filter((entry) => entry.kind === 'stripe').slice(from);
    const refundTexts = () => since().filter((entry) => entry.kind === 'sms');
    const payment = () => db('payments').where({ stripe_payment_intent_id: fixture.cardPaymentIntentId }).first();
    const refund = (data) => page.request.post(`${baseUrl}/api/admin/customers/${fixture.customerId}/refund`, { headers, data });
    const original = await payment();
    assert.equal(original.status, 'paid');
    const paidCents = cents(original.amount);
    const surchargeCents = original.surcharge_amount_cents;
    const baseCents = original.base_amount_cents;
    assert.equal(baseCents + surchargeCents, paidCents);
    assert.ok(surchargeCents > 0, 'The payment being refunded carries a card fee');

    // 1. Requests that cannot be a valid refund reach no Stripe call and change nothing.
    for (const [data, status] of [[{}, 400], [{ paymentId: original.id, amount: 0 }, 400], [{ paymentId: original.id, amount: -5 }, 400],
      [{ paymentId: original.id, amount: paidCents / 100 + 1 }, 400]]) {
      assert.equal((await refund(data)).status(), status, JSON.stringify(data));
    }
    const foreign = await page.request.post(`${baseUrl}/api/admin/customers/${fixture.foreignCustomerId}/refund`, { headers, data: { paymentId: original.id, amount: 1 } });
    assert.equal(foreign.status(), 404, 'Another customer cannot refund this payment');
    assert.deepEqual(stripeCalls(), [], 'A refused refund must reach no Stripe call');
    assert.deepEqual(await payment(), original);

    // 2. A partial refund, submitted twice at once. The entered amount is base dollars; Stripe is sent that amount plus
    // the card fee share the production calculator prorates, and both submissions carry the same idempotency key.
    const enteredCents = 5000;
    const share = computeRefundSurcharge({ refundBaseCents: enteredCents, originalBaseCents: baseCents, originalSurchargeCents: surchargeCents });
    assert.ok(share > 0 && share < surchargeCents);
    const partial = { paymentId: original.id, amount: enteredCents / 100, reason: 'requested_by_customer' };
    const attempts = await Promise.all([refund(partial), refund(partial)]);
    assert.ok(attempts.some((response) => response.status() === 200), JSON.stringify(await Promise.all(attempts.map((response) => response.text()))));
    const creates = stripeCalls().filter((entry) => entry.method === 'refunds.create');
    assert.ok(creates.length >= 1);
    for (const entry of creates) {
      assert.equal(entry.payment_intent, fixture.cardPaymentIntentId);
      assert.equal(entry.amount, enteredCents + share);
      assert.equal(entry.reason, 'requested_by_customer');
      assert.equal(entry.idempotencyKey, creates[0].idempotencyKey, 'Both submissions use one idempotency key');
    }
    assert.ok(creates[0].idempotencyKey);
    assert.deepEqual([...new Set(stripeCalls().map((entry) => entry.method))].sort(), ['charges.retrieve', 'refunds.create'], 'Only the refund and its charge read');
    const results = since().filter((entry) => entry.kind === 'stripe-refund-result');
    const refundIds = [...new Set(results.map((entry) => entry.refundId))];
    assert.equal(refundIds.length, 1, 'One refund exists at Stripe, however many times it was asked for');
    const partialRow = await payment();
    assert.equal(cents(partialRow.refund_amount), enteredCents + share);
    assert.equal(partialRow.status, 'paid');
    assert.equal(partialRow.stripe_refund_id, refundIds[0]);
    assert.equal(partialRow.refunded_surcharge_cents, share);
    assert.equal(meta(partialRow).pending_refund_key, undefined, 'No attempt is left pending');
    assert.deepEqual(meta(partialRow).stamped_refund_ids, refundIds);
    assert.equal((await db('invoices').where({ id: fixture.cardInvoiceId }).first()).status, 'paid', 'A partial refund leaves the invoice paid');

    // 3. The signed event Stripe sends for that refund confirms the same amounts, and a redelivery changes nothing.
    const eventCharge = (refunded, refundIdsNow, amountRefunded, refundAmount) => ({ id: `ch_${fixture.cardPaymentIntentId}`, object: 'charge',
      payment_intent: fixture.cardPaymentIntentId, amount: paidCents, amount_refunded: amountRefunded, refunded, currency: 'usd',
      refunds: { object: 'list', data: [{ id: refundIdsNow, object: 'refund', amount: refundAmount, status: 'succeeded', reason: 'requested_by_customer',
        created: Math.floor(Date.now() / 1000), charge: `ch_${fixture.cardPaymentIntentId}`, payment_intent: fixture.cardPaymentIntentId }] } });
    // The office notice a refund event raises carries only the amount, so its id is stored for the run's own cleanup.
    const recordNotices = async () => {
      const notices = await db('notifications').where('created_at', '>=', startedAt).whereRaw("metadata->>'triggerKey' = 'payment_refunded'").select('id');
      fixture.refundNoticeIds = notices.map((row) => row.id);
      fs.writeFileSync(ctx.fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    };
    const post = async (id, charge) => {
      const payload = JSON.stringify({ id, type: 'charge.refunded', created: Math.floor(Date.now() / 1000), data: { object: charge } });
      const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const result = await json(await page.request.post(`${baseUrl}/api/stripe/webhook`, { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload }));
      await recordNotices();
      return result;
    };
    const stripeBefore = stripeCalls().length;
    await post(fixture.refundEventIds[0], eventCharge(false, refundIds[0], enteredCents + share, enteredCents + share));
    await post(fixture.refundEventIds[1], eventCharge(false, refundIds[0], enteredCents + share, enteredCents + share));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const afterEvent = await payment();
    assert.equal(cents(afterEvent.refund_amount), enteredCents + share);
    assert.equal(afterEvent.status, 'paid');
    assert.equal(afterEvent.stripe_refund_id, refundIds[0]);
    assert.equal(afterEvent.refunded_surcharge_cents, share);
    assert.equal((await db('invoices').where({ id: fixture.cardInvoiceId }).first()).status, 'paid');
    assert.deepEqual(stripeCalls(stripeBefore).filter((entry) => entry.method !== 'charges.retrieve'), [], 'The event creates nothing at Stripe');

    // 4. Refunding the rest sends no amount (Stripe returns what remains), and the whole payment ends refunded.
    const remaining = paidCents - (enteredCents + share);
    const rest = await json(await refund({ paymentId: original.id, reason: 'requested_by_customer' }));
    const restCreates = stripeCalls().filter((entry) => entry.method === 'refunds.create' && entry.amount === undefined);
    assert.equal(restCreates.length, 1);
    assert.notEqual(restCreates[0].idempotencyKey, creates[0].idempotencyKey);
    const restResult = since().filter((entry) => entry.kind === 'stripe-refund-result').pop();
    assert.notEqual(restResult.refundId, refundIds[0]);
    assert.equal(cents(rest.refund_issued_amount), remaining);
    const fullRow = await payment();
    assert.equal(fullRow.status, 'refunded');
    assert.equal(cents(fullRow.refund_amount), paidCents);
    assert.equal(fullRow.refunded_surcharge_cents, surchargeCents);
    assert.equal(fullRow.stripe_refund_id, restResult.refundId);
    assert.deepEqual(meta(fullRow).stamped_refund_ids, [refundIds[0], restResult.refundId]);
    const refundedInvoice = await db('invoices').where({ id: fixture.cardInvoiceId }).first();
    assert.equal(refundedInvoice.status, 'refunded', 'A full refund reopens nothing and marks the invoice refunded');

    // 5. Its signed event, and a repeat of the request, leave the books as the refund wrote them and refund nothing more.
    const createsBefore = stripeCalls().filter((entry) => entry.method === 'refunds.create').length;
    await post(fixture.refundEventIds[2], eventCharge(true, restResult.refundId, paidCents, remaining));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const again = await refund({ paymentId: original.id, reason: 'requested_by_customer' });
    // The route answers a refused refund with a generic 500 (the reason is only in the server log); the money is what counts.
    assert.ok(again.status() >= 400, 'A second full refund is refused');
    const partialAgain = await refund({ paymentId: original.id, amount: 1 });
    assert.ok(partialAgain.status() >= 400, 'A refund of a refunded payment is refused');
    assert.equal(stripeCalls().filter((entry) => entry.method === 'refunds.create').length, createsBefore, 'No refund is created after the payment is fully refunded');
    const settled = await payment();
    assert.equal(settled.status, 'refunded');
    assert.equal(cents(settled.refund_amount), paidCents);
    assert.equal(settled.refunded_surcharge_cents, surchargeCents);
    assert.equal(settled.stripe_refund_id, restResult.refundId);
    assert.equal((await db('invoices').where({ id: fixture.cardInvoiceId }).first()).status, 'refunded');
    assert.equal(since().filter((entry) => entry.kind === 'stripe-refund-result' && !entry.replayed).length, 2, 'Exactly two refunds exist at Stripe');

    // 6. The customer's refund notice is an email, which QA has no transport for; the attempt log shows one per refund,
    // and nothing is texted.
    assert.deepEqual(refundTexts(), [], 'A refund sends no text');
    const notices = (await db('customer_interactions').where({ customer_id: fixture.customerId, interaction_type: 'email_outbound' })
      .whereRaw("metadata::jsonb ->> 'event_type' = 'payment.refund_issued'")).map((row) => meta(row).refund_id);
    assert.deepEqual([...new Set(notices)].sort(), [refundIds[0], restResult.refundId].sort());
    return { paidCents, partialRefundCents: enteredCents + share, restRefundCents: remaining, refunds: 2, noticeAttempts: notices.length };
  },
};
