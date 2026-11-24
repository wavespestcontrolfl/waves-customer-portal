'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { computeChargeAmount } = require('../../../server/services/stripe-pricing');

const cents = (shown) => Math.round(Number(String(shown).replace(/[^0-9.]/g, '')) * 100);
const dollars = (amountCents) => `$${(amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// The row's value is the last text node of its label's row, whatever the page's layout.
async function shownValue(page, label) {
  const row = page.getByText(label, { exact: true }).first().locator('xpath=..');
  await row.waitFor();
  return (await row.innerText()).split('\n').pop().trim();
}

module.exports = {
  name: 'saved-card-charge-matches-shown-total',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, artifactDir, captureFile, fixtureFile, webhookSecret, waitForFonts } = ctx;
    const headers = { Authorization: `Bearer ${ctx.adminToken}` };
    const captured = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = captured().length;

    // 1. The customer opens the pay link. Stripe.js cannot load in QA (no publishable key, external requests blocked),
    // so the card form is absent and the page states the invoice amount before any card fee, which only Stripe's
    // card element can add. The page's failure report would raise a staff alert, so it is answered locally.
    await page.route('**/api/pay/*/error', (route) => route.fulfill({ status: 204 }));
    await page.goto(`${baseUrl}/pay/${fixture.cardInvoiceToken}`);
    const shownBase = await shownValue(page, 'Total due');
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'saved-card-pay-page.png'), fullPage: true });
    await page.unroute('**/api/pay/*/error');
    assert.equal(cents(shownBase), Math.round(fixture.cardInvoiceSubtotal * 100), 'Pay page must show the invoice amount');

    // The card total the server must charge: the page's amount plus the fee for this saved credit card, from the
    // production calculator rather than a number written into this journey.
    const expected = computeChargeAmount(cents(shownBase) / 100, 'card', { funding: 'credit' });
    assert.ok(expected.surchargeCents > 0, 'A saved credit card must add a card fee');
    assert.equal(expected.totalCents, cents(shownBase) + expected.surchargeCents);

    // 2. The admin sheet's first call prices the charge; the server's quote must be that same card total.
    const quote = (await json(await page.request.post(`${baseUrl}/api/admin/invoices/${fixture.cardInvoiceId}/charge-card-quote`,
      { headers, data: { paymentMethodId: fixture.cardPaymentMethodId } }))).quote;
    assert.equal(Math.round(quote.total * 100), expected.totalCents);
    assert.equal(Math.round(quote.surcharge * 100), expected.surchargeCents);

    // 3. A total that is not the quoted one is refused before Stripe sees anything.
    const stale = await page.request.post(`${baseUrl}/api/admin/invoices/${fixture.cardInvoiceId}/charge-card`,
      { headers, data: { paymentMethodId: fixture.cardPaymentMethodId, expectedTotal: cents(shownBase) / 100 } });
    assert.equal(stale.status(), 400);
    assert.match((await stale.json()).error, /amount changed/i);
    assert.equal(captured().slice(before).filter((entry) => entry.kind === 'stripe').length, 0, 'A refused charge must not reach Stripe');
    // Opening the pay link marked the invoice viewed; the refused charge left it open.
    assert.equal((await db('invoices').where({ id: fixture.cardInvoiceId }).first()).status, 'viewed');

    // 4. The charge, bound to the quoted total.
    const charge = await json(await page.request.post(`${baseUrl}/api/admin/invoices/${fixture.cardInvoiceId}/charge-card`,
      { headers, data: { paymentMethodId: fixture.cardPaymentMethodId, expectedTotal: quote.total } }));
    assert.equal(charge.success, true);

    // (a) What Stripe received is the card total, once, with the fee declared as a surcharge.
    const stripeCalls = () => captured().slice(before).filter((entry) => entry.kind === 'stripe');
    const creates = () => stripeCalls().filter((entry) => entry.method === 'paymentIntents.create');
    assert.deepEqual(stripeCalls().map((entry) => entry.method), ['paymentIntents.create'], 'The charge makes exactly one Stripe call');
    const [call] = creates();
    assert.equal(call.amount, expected.totalCents);
    assert.equal(call.currency, 'usd');
    assert.equal(call.customer, fixture.stripeCustomerId);
    assert.equal(call.payment_method, fixture.stripePaymentMethodId);
    assert.equal(call.off_session, true);
    assert.equal(call.confirm, true);
    assert.equal(call.amount_details.surcharge.amount, expected.surchargeCents);
    assert.equal(call.metadata.waves_invoice_id, fixture.cardInvoiceId);
    assert.ok(call.idempotencyKey, 'Stripe must receive an idempotency key');

    // (b) The invoice is paid and the payment row carries the same amount and fee split.
    const invoice = await db('invoices').where({ id: fixture.cardInvoiceId }).first();
    assert.equal(invoice.status, 'paid');
    assert.equal(Math.round(Number(invoice.total) * 100), expected.totalCents);
    const payments = await db('payments').where({ customer_id: fixture.customerId }).whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [fixture.cardInvoiceId]);
    assert.equal(payments.length, 1);
    assert.equal(Math.round(Number(payments[0].amount) * 100), expected.totalCents);
    assert.equal(payments[0].base_amount_cents, expected.baseCents);
    assert.equal(payments[0].surcharge_amount_cents, expected.surchargeCents);
    assert.equal(payments[0].status, 'paid');
    assert.equal(charge.paymentIntentId, payments[0].stripe_payment_intent_id);
    fixture.cardPaymentIntentId = payments[0].stripe_payment_intent_id;
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });

    // The customer's receipt page states the same card total and fee that Stripe was sent.
    await page.goto(`${baseUrl}/receipt/${fixture.cardInvoiceToken}`);
    const receiptTotal = await shownValue(page, 'Total charged');
    const receiptFee = await shownValue(page, 'Credit card surcharge (2.9%)');
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'saved-card-receipt.png'), fullPage: true });
    assert.equal(cents(receiptTotal), call.amount);
    assert.equal(cents(receiptFee), call.amount_details.surcharge.amount);

    // (c) The receipt queue drains by itself (the charge schedules it). Wait for the committed receipt stamp, which the
    // worker writes after the text transport returns, then count the texts that carry the amount.
    let receiptSentAt = null;
    for (let attempt = 0; attempt < 100 && !receiptSentAt; attempt++) {
      receiptSentAt = (await db('invoices').where({ id: fixture.cardInvoiceId }).first('receipt_sent_at')).receipt_sent_at;
      if (!receiptSentAt) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(receiptSentAt, 'Receipt text stamps receipt_sent_at');
    const receiptTexts = captured().slice(before).filter((entry) => entry.kind === 'sms' && entry.body?.includes(dollars(call.amount)));
    assert.equal(receiptTexts.length, 1, 'Exactly one receipt text must carry the card total');
    assert.equal(receiptTexts[0].to, fixture.phone);
    assert.equal(receiptTexts[0].customerId, fixture.customerId);
    assert.ok(receiptTexts[0].body.includes(fixture.cardInvoiceNumber), 'Receipt text names the invoice');
    const job = await db('receipt_delivery_jobs').where({ invoice_id: fixture.cardInvoiceId }).first();
    assert.equal(job.source, 'card_on_file');

    // The same signed Stripe event that normally follows must settle nothing twice.
    const event = { id: fixture.cardEventId, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
      data: { object: { id: fixture.cardPaymentIntentId, object: 'payment_intent', status: 'succeeded', amount: call.amount,
        amount_received: call.amount, currency: call.currency, payment_method_types: call.payment_method_types,
        latest_charge: `ch_${fixture.cardPaymentIntentId}`, customer: call.customer, payment_method: call.payment_method,
        metadata: call.metadata } } };
    const payload = JSON.stringify(event);
    const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    await json(await page.request.post(`${baseUrl}/api/stripe/webhook`,
      { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload }));
    assert.equal((await db('stripe_webhook_events').where({ id: fixture.cardEventId }).first()).processed, true);
    // The webhook must leave every settled amount as the charge wrote it: one payment row, same amount and fee split,
    // same invoice total, no second charge and no second receipt text.
    const settled = await db('payments').where({ stripe_payment_intent_id: fixture.cardPaymentIntentId });
    assert.equal(settled.length, 1);
    assert.equal(Math.round(Number(settled[0].amount) * 100), call.amount);
    assert.equal(settled[0].base_amount_cents, expected.baseCents);
    assert.equal(settled[0].surcharge_amount_cents, call.amount_details.surcharge.amount);
    assert.equal(settled[0].status, 'paid');
    const settledInvoice = await db('invoices').where({ id: fixture.cardInvoiceId }).first();
    assert.equal(settledInvoice.status, 'paid');
    assert.equal(Math.round(Number(settledInvoice.total) * 100), call.amount);
    assert.equal(captured().slice(before).filter((entry) => entry.kind === 'sms' && entry.body?.includes(dollars(call.amount))).length, 1);
    assert.equal(creates().length, 1, 'The webhook must not create a second charge');

    return { invoiceId: fixture.cardInvoiceId, shownBeforeFee: shownBase, cardTotalCharged: receiptTotal, cardFee: receiptFee,
      stripeAmountCents: call.amount, paymentCount: payments.length, receiptTexts: receiptTexts.length };
  },
};
