'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = {
  name: 'payment-webhook-settles-once',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, artifactDir, webhookSecret, waitForFonts } = ctx;
    const event = { id: fixture.eventId, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
      data: { object: { id: fixture.paymentIntentId, status: 'succeeded', amount: 9900, amount_received: 9900,
        currency: 'usd', payment_method_types: ['us_bank_account'], latest_charge: `ch_${fixture.paymentIntentId}`,
        metadata: { invoice_id: fixture.invoiceId, customer_id: fixture.customerId } } } };
    const payload = JSON.stringify(event);
    const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const request = { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload };
    const deliveries = await Promise.all([
      page.request.post(`${baseUrl}/api/stripe/webhook`, request),
      page.request.post(`${baseUrl}/api/stripe/webhook`, request),
    ]);
    assert.ok(deliveries.some(response => response.status() === 200), 'One delivery must finish processing');
    for (const response of deliveries) {
      // An overlapping duplicate is deliberately retriable while the winner
      // owns the claim. Only that documented 503 is acceptable here.
      if (response.status() === 503) {
        assert.equal((await json(response, 503)).error, 'Event in-flight, retry');
      } else await json(response);
    }
    // Repeat after both in-flight deliveries settle as well.
    assert.equal((await json(await page.request.post(`${baseUrl}/api/stripe/webhook`, request))).duplicate, true);
    assert.equal((await db('stripe_webhook_events').where({ id: fixture.eventId }).first()).processed, true);
    assert.equal((await db('invoices').where({ id: fixture.invoiceId }).first()).status, 'paid');
    const payments = await db('payments').where({ stripe_payment_intent_id: fixture.paymentIntentId });
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0].amount), 99);
    assert.equal(payments[0].customer_id, fixture.customerId);
    assert.equal((await db('receipt_delivery_jobs').where({ invoice_id: fixture.invoiceId })).length, 1);
    await page.goto(`${baseUrl}/receipt/${fixture.invoiceToken}`);
    await page.getByText('$99.00', { exact: false }).first().waitFor();
    await waitForFonts(page);
    await page.screenshot({ path: path.join(artifactDir, 'receipt.png'), fullPage: true });
    return { invoiceId: fixture.invoiceId, customerId: payments[0].customer_id,
      paymentIntentId: fixture.paymentIntentId, paymentCount: payments.length, amount: Number(payments[0].amount),
      concurrentStatuses: deliveries.map(response => response.status()), processed: true, receiptJobs: 1 };
  },
};
