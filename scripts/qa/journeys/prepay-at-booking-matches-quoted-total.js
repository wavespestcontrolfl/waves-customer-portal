'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { computeChargeAmount, SURCHARGE_API_VERSION } = require('../../../server/services/stripe-pricing');
const { CONSENT_VERSION } = require('../../../server/services/payment-method-consent-text');

const dollars = (amountCents) => `$${(amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// The customer books a year of quarterly pest control and pays it up front with the card already saved on the account.
// The estimate page quotes the exact card total first; the accept that follows must charge that total, once.
module.exports = {
  name: 'prepay-at-booking-matches-quoted-total',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json, fixtureFile, webhookSecret } = ctx;
    const captured = () => fs.readFileSync(ctx.captureFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = captured().length;
    const since = () => captured().slice(before);
    const stripeMethods = () => since().filter((entry) => entry.kind === 'stripe').map((entry) => entry.method);
    const accept = (data) => page.request.put(`${baseUrl}/api/estimates/${fixture.prepayToken}/accept`, { data });
    const body = { paymentMethodPreference: 'prepay_annual', slotId: `${fixture.nextDate}_09-00_${fixture.technicianId}`,
      consentTextVersion: CONSENT_VERSION };

    // The customer's slot hold lasts 15 minutes; this journey runs last, so renew it as picking the time again would.
    await db('scheduled_services').where({ id: fixture.prepayAppointmentId }).update({ reservation_expires_at: new Date(Date.now() + 15 * 60000) });

    // Every invoice the customer had before this booking, so the booking's own invoice can be found by difference.
    const invoiceIdsBefore = new Set((await db('invoices').where({ customer_id: fixture.customerId }).select('id')).map((row) => row.id));
    const newInvoiceIds = async () => (await db('invoices').where({ customer_id: fixture.customerId }).select('id'))
      .map((row) => row.id).filter((id) => !invoiceIdsBefore.has(id));

    // 1. The accept without an acknowledged total is answered with the quote the page shows, and nothing is booked or charged.
    const quoted = await json(await accept(body), 402);
    assert.equal(quoted.code, 'PREPAY_CHARGE_QUOTE');
    const { quote } = quoted;
    const expected = computeChargeAmount(quote.base, 'card', { funding: 'credit' });
    assert.ok(expected.surchargeCents > 0, 'A saved credit card must add a card fee');
    assert.equal(quote.totalCents, expected.totalCents, 'The quote total is the production card total');
    assert.equal(Math.round(quote.total * 100), expected.totalCents);
    assert.equal(Math.round(quote.surcharge * 100), expected.surchargeCents);
    assert.equal(Math.round(quote.base * 100), expected.baseCents);
    assert.equal(quote.last4, fixture.cardLastFour);
    // A pest plan's prepay waives the setup fee rather than taking a percent off (estimate-public.js annual prepay),
    // so the year is exactly four visits at the seeded visit price.
    const heldVisit = await db('scheduled_services').where({ id: fixture.prepayAppointmentId }).first('estimated_price');
    assert.equal(Math.round(quote.base * 100), Math.round(Number(heldVisit.estimated_price) * 4 * 100), 'The year is four visits at the quoted rate');
    assert.deepEqual(stripeMethods(), [], 'A quote must reach no Stripe call');
    assert.equal((await db('estimates').where({ id: fixture.prepayEstimateId }).first()).status, 'sent');
    assert.equal((await db('invoices').where({ customer_id: fixture.customerId, total: quote.base }).whereNot({ id: fixture.cardInvoiceId })).length, 0);

    // 2. An acknowledgement for any other total is refused with a fresh quote, before anything moves.
    const stale = await json(await accept({ ...body, prepayChargeAcknowledgedTotalCents: quote.totalCents - 100,
      prepayChargeAcknowledgedMethodKey: quote.methodKey, prepayChargeConsentAccepted: true }), 402);
    assert.equal(stale.quote.totalCents, quote.totalCents);
    assert.deepEqual(stripeMethods(), [], 'A stale acknowledgement must reach no Stripe call');

    // 3. The accept that acknowledges the quoted total books the year and charges that total.
    const acknowledged = { ...body, prepayChargeAcknowledgedTotalCents: quote.totalCents,
      prepayChargeAcknowledgedMethodKey: quote.methodKey, prepayChargeConsentAccepted: true };
    const accepted = await json(await accept(acknowledged));
    assert.equal(accepted.prepayChargeStatus, 'paid');
    assert.equal(Math.round(Number(accepted.prepayChargedTotal) * 100), quote.totalCents, 'The confirmation names the quoted total');
    assert.deepEqual(stripeMethods(), ['paymentIntents.create'], 'The accept makes exactly one Stripe call');
    const [call] = since().filter((entry) => entry.kind === 'stripe');
    assert.equal(call.amount, quote.totalCents);
    assert.equal(call.currency, 'usd');
    assert.equal(call.customer, fixture.stripeCustomerId);
    assert.equal(call.payment_method, fixture.stripePaymentMethodId);
    assert.equal(call.off_session, true);
    assert.equal(call.confirm, true);
    assert.equal(call.amount_details.surcharge.amount, quote.surcharge * 100);
    assert.equal(call.apiVersion, SURCHARGE_API_VERSION, 'A surcharge must be sent on the surcharge API version');
    assert.ok(call.idempotencyKey, 'Stripe must receive an idempotency key');

    // 4. The year is recorded once: one accepted estimate, one paid invoice for the quoted base, one payment for the total.
    assert.equal((await db('estimates').where({ id: fixture.prepayEstimateId }).first()).status, 'accepted');
    // The paid booking keeps the held visit: it no longer expires, belongs to this estimate and records the prepay choice.
    const booked = await db('scheduled_services').where({ id: fixture.prepayAppointmentId }).first();
    assert.equal(booked.reservation_expires_at, null, 'The paid booking must clear the slot hold expiry');
    assert.equal(booked.source_estimate_id, fixture.prepayEstimateId);
    assert.equal(booked.payment_method_preference, 'prepay_annual');
    assert.ok(['pending', 'confirmed'].includes(booked.status), `The booked visit stays scheduled (status ${booked.status})`);
    // Exactly one new invoice: the one Stripe charged and the one the estimate's prepay term points at.
    assert.deepEqual(await newInvoiceIds(), [call.metadata.waves_invoice_id], 'The booking creates exactly one invoice, the charged one');
    const terms = await db('annual_prepay_terms').where({ source_estimate_id: fixture.prepayEstimateId });
    assert.equal(terms.length, 1, 'One prepay term for the estimate');
    assert.equal(terms[0].prepay_invoice_id, call.metadata.waves_invoice_id, 'The prepay term names the charged invoice');
    const invoice = await db('invoices').where({ id: call.metadata.waves_invoice_id }).first();
    assert.equal(invoice.customer_id, fixture.customerId);
    assert.equal(invoice.status, 'paid');
    assert.equal(Math.round(Number(invoice.total) * 100), expected.totalCents);
    const payments = await db('payments').where({ customer_id: fixture.customerId }).whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [invoice.id]);
    assert.equal(payments.length, 1);
    assert.equal(Math.round(Number(payments[0].amount) * 100), quote.totalCents);
    assert.equal(payments[0].base_amount_cents, expected.baseCents);
    assert.equal(payments[0].surcharge_amount_cents, expected.surchargeCents);
    assert.equal(payments[0].status, 'paid');
    fixture.prepayInvoiceId = invoice.id;
    fixture.prepayPaymentIntentId = payments[0].stripe_payment_intent_id;
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });

    // 5. The receipt text the charge schedules waits for its committed stamp, then exactly one text carries the total.
    let receiptSentAt = null;
    for (let attempt = 0; attempt < 100 && !receiptSentAt; attempt++) {
      receiptSentAt = (await db('invoices').where({ id: invoice.id }).first('receipt_sent_at')).receipt_sent_at;
      if (!receiptSentAt) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(receiptSentAt, 'The prepay receipt text stamps receipt_sent_at');
    const texts = () => since().filter((entry) => entry.kind === 'sms' && entry.body?.includes(dollars(quote.totalCents)));
    assert.equal(texts().length, 1, 'Exactly one text carries the prepay total');
    assert.equal(texts()[0].to, fixture.phone);
    assert.ok(texts()[0].body.includes(invoice.invoice_number), 'The text names the prepay invoice');

    // 6. A repeated accept, and the signed Stripe event that normally follows, change nothing.
    // The stamp is written after the text goes; let the job finish its own attempt (the QA server has no email
    // transport, so it ends scheduled for a retry) before taking the snapshot the webhook must leave alone.
    let jobBefore;
    for (let attempt = 0; attempt < 50; attempt++) {
      jobBefore = await db('receipt_delivery_jobs').where({ invoice_id: invoice.id }).first('id', 'status', 'attempts', 'next_attempt_at');
      if (jobBefore.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.notEqual(jobBefore.status, 'running');
    const again = await json(await accept(acknowledged));
    assert.equal(again.alreadyAccepted, true);
    const event = { id: fixture.prepayEventId, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
      data: { object: { id: payments[0].stripe_payment_intent_id, object: 'payment_intent', status: 'succeeded', amount: call.amount,
        amount_received: call.amount, currency: call.currency, payment_method_types: call.payment_method_types,
        latest_charge: `ch_${payments[0].stripe_payment_intent_id}`, customer: call.customer, payment_method: call.payment_method,
        metadata: call.metadata } } };
    const payload = JSON.stringify(event);
    const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    await json(await page.request.post(`${baseUrl}/api/stripe/webhook`,
      { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload }));
    await new Promise((resolve) => setTimeout(resolve, 4000));
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await db('receipt_delivery_jobs').where({ invoice_id: invoice.id, status: 'running' }).first())) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The repeat reaches no Stripe call; the webhook only reads the charge to learn the card, and creates nothing.
    assert.deepEqual(stripeMethods(), ['paymentIntents.create', 'charges.retrieve'], 'Neither the repeat nor the webhook may create or change anything at Stripe');
    assert.equal(since().find((entry) => entry.method === 'charges.retrieve').id, `ch_${payments[0].stripe_payment_intent_id}`);
    const settled = await db('payments').where({ stripe_payment_intent_id: payments[0].stripe_payment_intent_id });
    assert.equal(settled.length, 1);
    assert.equal(Math.round(Number(settled[0].amount) * 100), quote.totalCents);
    assert.equal(settled[0].surcharge_amount_cents, expected.surchargeCents);
    assert.equal(settled[0].status, 'paid');
    const settledInvoice = await db('invoices').where({ id: invoice.id }).first();
    assert.equal(settledInvoice.status, 'paid');
    assert.equal(Math.round(Number(settledInvoice.total) * 100), quote.totalCents);
    const jobs = await db('receipt_delivery_jobs').where({ invoice_id: invoice.id });
    assert.equal(jobs.length, 1, 'No second receipt job');
    assert.deepEqual({ id: jobs[0].id, status: jobs[0].status, attempts: jobs[0].attempts, next: String(jobs[0].next_attempt_at) },
      { id: jobBefore.id, status: jobBefore.status, attempts: jobBefore.attempts, next: String(jobBefore.next_attempt_at) });
    assert.equal(texts().length, 1, 'Still one text with the total');
    assert.deepEqual(await newInvoiceIds(), [invoice.id], 'The repeat and the webhook create no other invoice');
    // The paid term is live and records the year's price the customer was quoted.
    const settledTerms = await db('annual_prepay_terms').where({ source_estimate_id: fixture.prepayEstimateId });
    assert.equal(settledTerms.length, 1);
    assert.equal(settledTerms[0].status, 'active', `The paid prepay term must be active (status ${settledTerms[0].status})`);
    assert.equal(Math.round(Number(settledTerms[0].prepay_amount) * 100), expected.baseCents,
      `The term records the quoted year price (prepay_amount ${settledTerms[0].prepay_amount})`);
    return { quotedTotalCents: quote.totalCents, stripeAmountCents: call.amount, invoiceId: invoice.id, paymentCount: settled.length,
      textsWithTotal: texts().length, allTexts: since().filter((entry) => entry.kind === 'sms').length };
  },
};
