/**
 * Intelligence Bar — the ONE effects plan for send_invoice and charge_invoice
 * server/services/intelligence-bar/invoice-action-effects.js
 *
 * A send or a charge does more than its headline: the Send handler's post-delivery block and the
 * payment_intent.succeeded handler each run a list of follow-on effects (lead conversion, billing
 * reminders, the visit closeout, review outreach, the receipt ...). This module lists ALL of them
 * for one invoice, in one place:
 *
 *   planSendEffects(invoice, customer, ctx)   - what sendViaSMSAndEmail does after a delivery
 *   planChargeEffects(invoice, customer, ctx) - what the paid-invoice handlers do after a charge
 *
 * Each effect is { key, applies, state, line, kind }. `line` is the card sentence (null = nothing to
 * say), `state` is the short fact that decides the effect, and `applies` says whether it happens.
 * The card renders every line, `_version.effects` pins the digest of the whole list, and the
 * confirmed run recomputes the list under the invoice claim / charge lock and refuses as
 * preview_changed on any difference.
 *
 * Nothing here re-implements a handler's test. Each effect calls the function the handler itself
 * calls (invoice.js leadConversionApplies / alreadyDeliveredForFirstSend, lead-estimate-link.js
 * invoiceSentConversionTargets, invoice-followups.js planFollowupSequence / stopOnPaymentVerdict,
 * review-request.js paidInvoiceReviewSkip, invoice-delivery-review.js reviewDecisionForInvoice,
 * invoice-issued-closeout.js issuedCloseoutTarget, project-report-hold.js heldReportsForInvoice).
 *
 * SEND_CALL_COVERAGE / CHARGE_CALL_COVERAGE name every side-effect call in those two handlers and the
 * effect that represents it (or why it cannot apply to a bar action). A source-contract test reads
 * the handlers' code and fails when a call is not listed here, so a new effect cannot slip in
 * unnamed.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const { etDateString, formatETTime } = require('../../utils/datetime-et');

const money = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const etStamp = (value) => {
  const at = new Date(value);
  return `${etDateString(at)} ${formatETTime(at)} ET`;
};
const shortId = (id) => String(id).slice(0, 8);

const effect = (key, applies, state, line, kind = 'operational') => ({ key, applies: Boolean(applies), state: String(state), line: line || null, kind });

// The pin: every effect's key, whether it happens, and the fact behind it.
const effectsDigest = (effects) => crypto.createHash('sha256')
  .update(JSON.stringify(effects.map((e) => [e.key, e.applies, e.state]))).digest('hex').slice(0, 32);

// Handler calls -> the effect that represents each one. `null` effect = cannot apply to a bar action (reason given).
const SEND_CALL_COVERAGE = {
  convertLeadOnInvoiceSent: { effect: 'lead_conversion' },
  scheduleForInvoice: { effect: 'followups' },
  closeOutVisitForIssuedInvoice: { effect: 'closeout' },
  enrollReviewAfterInvoiceDelivery: { effect: 'review' },
  autoApplyAccountCreditIfEnabled: { effect: 'credit' },
  reverseAppliedCredit: { effect: 'credit' },
  resolveAdoptedRowsAfterDelivery: { effect: null, why: 'settles queued-send bookkeeping rows; no message or record the customer sees' },
  restoreSendClaim: { effect: null, why: 'gives the send claim back after a failure; nothing is delivered' },
  requeueHeldInvoice: { effect: null, why: 'only on a collections-hold refusal, which the bar never overrides (holdExempt null)' },
  voidOpenInvoicesForCancelledService: { effect: null, why: 'only when the linked visit was cancelled; the bar sets refusalOnly and never voids' },
};
const CHARGE_CALL_COVERAGE = {
  stopOnPayment: { effect: 'followup_stop' },
  syncTermForInvoicePayment: { effect: 'annual_prepay' },
  completeActivePlansForInvoice: { effect: 'payment_plan' },
  closeOutVisitAfterPaidInvoice: { effect: 'closeout' },
  scheduleReviewAfterPaidInvoice: { effect: 'review' },
  enqueueReceiptDelivery: { effect: 'receipt' },
  scheduleReceiptDeliveryDrain: { effect: 'receipt' },
  scheduleHoldReleaseSweep: { effect: 'held_report' },
  notifyPaymentSuccess: { effect: 'admin_notice' },
  resetAchFailureStateForSucceededIntent: { effect: null, why: 'bank payments only; the bar charges cards' },
  mirrorSavedMethodForSucceededIntent: { effect: null, why: 'needs save_card_opt_in on the PaymentIntent; a bar charge uses a card already saved' },
  recordOrphanSucceededPaymentIntent: { effect: null, why: 'orphan fence for a PaymentIntent that matches no invoice; a bar charge is bound to its invoice' },
  resolveSettledInvoiceSavedCardChargeAttempt: { effect: null, why: 'closes the charge path\'s own attempt claim; no customer-facing effect' },
  resolveOrphanSucceededPaymentIntentIfSettled: { effect: null, why: 'clears an orphan fence for a settled intent; no customer-facing effect' },
  recordCardHoldNoShowFeePayment: { effect: null, why: 'no-show fee intents only; a bar charge pays an invoice' },
  recordAppointmentCardNoShowFeePayment: { effect: null, why: 'no-show fee intents only; a bar charge pays an invoice' },
  postCreditMovement: { effect: null, why: 'statement and credit-intent payments only; a bar charge pays one invoice' },
};

const FOLLOWUP_STATE_TEXT = {
  active: 'reminders will run',
  autopay_hold: 'held: the customer is on Auto Pay',
  payment_plan: 'none: the invoice has an active payment plan',
  rearm: 'reminders resume after an earlier void',
  autopay_unreadable: 'Auto Pay could not be checked; reminders may run',
  not_schedulable: 'none: the invoice is not in a billable state',
  payer_billed: 'none: the invoice is billed to a payer',
};
const followupStateText = (state) => (state.startsWith('existing:')
  ? `the invoice already has a reminder sequence (${state.slice(9)}); it is left as it is`
  : FOLLOWUP_STATE_TEXT[state] || state);

function closeoutLine(closeout, lead) {
  const visit = `${closeout.serviceType || 'visit'} on ${closeout.date}`;
  return closeout.resuming
    ? `${lead} also finishes a closeout already started for the linked visit (${visit}): completes its remaining steps; no completion text, report, review request or charge`
    : `${lead} also completes the linked visit (${visit}) and creates its service record; no completion text, report, review request or charge`;
}
const closeoutState = (closeout) => (closeout ? `${closeout.visitId}:${closeout.resuming === true ? 'resuming' : 'new'}` : 'none');

// GATE_INVOICE_ISSUED_CLOSES_VISIT: the closeout's own read-only probe, with the handler's trigger.
async function closeoutEffect(invoice, trigger, lead) {
  const closeout = await require('../invoice-issued-closeout').issuedCloseoutTarget(invoice, { trigger });
  return effect('closeout', Boolean(closeout), closeoutState(closeout), closeout ? closeoutLine(closeout, lead) : null);
}

function deliveryNote(invoice, delivered) {
  if (invoice.sent_at) return `Already sent on ${etStamp(invoice.sent_at)}. This sends it again.`;
  if (delivered) return `Already delivered (invoice status ${invoice.status}). This sends it again.`;
  return 'Not sent before.';
}

// What sendViaSMSAndEmail does after the delivery lands. invoice = the row BEFORE the claim (its status is
// the prior status); ctx.requestReview is the bar's send argument (false: no review decision is taken).
async function planSendEffects(invoice, customer, { database = db, requestReview = false } = {}) {
  const Invoice = require('../invoice');
  const delivered = Invoice.alreadyDeliveredForFirstSend(invoice);
  // The row the follow-up and lead steps see after the delivery: a first delivery has gone out as 'sent'.
  const afterStatus = delivered ? invoice.status : 'sent';

  const conversionApplies = Invoice.leadConversionApplies({
    customerId: invoice.customer_id,
    priorStatus: invoice.status,
    priorDelivered: Invoice.priorDeliveredForLeadConversion(invoice),
  });
  const targets = conversionApplies
    ? await require('../lead-estimate-link').invoiceSentConversionTargets(invoice.customer_id, database)
    : { reason: 'not_first_delivery', leadIds: [] };
  const leadIds = targets.leadIds || [];
  const lead = effect('lead_conversion', leadIds.length > 0, leadIds.length ? leadIds.join(',') : (targets.reason || 'none'),
    leadIds.length ? `Sending this invoice also marks ${leadIds.length === 1 ? 'lead' : 'leads'} ${leadIds.map(shortId).join(', ')} won` : null);

  const followup = await require('../invoice-followups').planFollowupSequence({ ...invoice, status: afterStatus }, database, customer || null);
  const cadence = `Day ${followup.cadence.join(', ')}`;
  const followups = effect('followups', followup.arms, followup.state,
    `Sending this invoice also arms billing reminders on ${cadence} unless Auto Pay or a payment plan suppresses them (currently: ${followupStateText(followup.state)})`,
    'comms');

  const review = require('../invoice-delivery-review').reviewDecisionForInvoice(invoice, requestReview, null).requestReview === true;
  return finish([
    effect('delivery', true, delivered ? 'resend' : 'first', deliveryNote(invoice, delivered)),
    await closeoutEffect(invoice, 'sent', 'Sending this invoice'),
    lead,
    followups,
    effect('review', review, review ? 'requested' : 'none',
      review ? 'Sending this invoice also enrolls the customer in review outreach' : 'No review request is sent.'),
    effect('credit', false, 'skipped',
      'No account credit is applied by this send. If the visit is cancelled before the send runs, nothing is sent and the invoice is held for review (never voided by the bar).', 'billing'),
  ]);
}

// The paid-invoice effects, one builder each, in card order. c = { invoice, customer, database, creditCents, closeout }.
const CHARGE_EFFECT_BUILDERS = [
  async (c) => effect('credit', c.creditCents > 0, String(c.creditCents), c.creditCents > 0 ? `${money(c.creditCents)} of account credit is applied first` : null, 'billing'),
  async (c) => c.closeout,
  // The review step runs after the closeout and reads the record it links.
  async (c) => {
    const { invoice } = c;
    const recordId = invoice.service_record_id || (c.closeout.applies ? 'from_closeout' : null);
    const packetId = invoice.visit_completion_packet_id || null;
    const Reviews = require('../review-request');
    const notes = invoice.service_record_id ? await Reviews.completionNotes(invoice.service_record_id) : {};
    const skip = Reviews.paidInvoiceReviewSkip({ customer_id: invoice.customer_id, service_record_id: recordId }, notes);
    const applies = Boolean(packetId) || !skip;
    const line = packetId
      ? 'Once the charge is paid, the payment may also enroll the customer in review outreach (the visit completion packet decides)'
      : 'Once the charge is paid, the payment also enrolls the customer in review outreach (the review limits, such as an opt-out or a recent ask, can still hold it back)';
    return effect('review', applies, packetId ? `packet:${packetId}` : (skip ? `skip:${skip}` : 'enrolls'), applies ? line : null, 'comms');
  },
  async (c) => {
    const followups = require('../invoice-followups');
    const seq = await c.database('invoice_followup_sequences').where({ invoice_id: c.invoice.id }).first('status', 'touches_sent');
    const verdict = followups.stopOnPaymentVerdict(seq);
    // stopOnPayment texts the thank-you only to a customer with a phone on file.
    const thanks = verdict.thankYou && Boolean(c.customer?.phone);
    return effect('followup_stop', verdict.stops, verdict.stops ? `stops${thanks ? '+thank_you' : ''}` : 'none',
      verdict.stops ? `Once the charge is paid, the payment also stops the billing reminders for this invoice${thanks ? ' and texts the customer a thank-you (a reminder was already sent)' : ''}` : null, 'comms');
  },
  async (c) => {
    const plan = await require('../invoice-followups').activePaymentPlan(c.database, c.invoice.id);
    return effect('payment_plan', Boolean(plan), plan ? 'completes' : 'none', plan ? 'Once the charge is paid, the payment also completes the active payment plan on this invoice' : null, 'billing');
  },
  async (c) => effect('annual_prepay', Boolean(c.invoice.annual_prepay_term_id), c.invoice.annual_prepay_term_id || 'none',
    c.invoice.annual_prepay_term_id ? 'Once the charge is paid, the payment also updates the annual plan term this invoice pays for' : null, 'billing'),
  async (c) => {
    const held = await require('../project-report-hold').heldReportsForInvoice(c.invoice.id, c.database);
    return effect('held_report', held.length > 0, held.join(','),
      held.length ? `Once the charge is paid, the payment also releases the held service report (project ${held.map(shortId).join(', ')}) to the customer` : null, 'comms');
  },
  async () => effect('receipt', true, 'enqueue',
    'After the charge succeeds, the customer gets the payment receipt by email and/or text per their receipt settings; a text waits for 8 AM–8 PM ET.', 'comms'),
  async () => effect('admin_notice', true, 'bell', 'The admin team gets a payment bell.'),
];

// What the paid-invoice handlers do after a saved-card charge settles. ctx.creditCents = the account credit
// the charge applies first (the quote's projection, the same number the card shows).
async function planChargeEffects(invoice, customer, { database = db, creditCents = 0 } = {}) {
  const c = { invoice, customer, database, creditCents, closeout: await closeoutEffect(invoice, 'paid', 'Once the charge is paid, the payment') };
  const effects = [];
  for (const build of CHARGE_EFFECT_BUILDERS) effects.push(await build(c));
  return finish(effects);
}

function finish(effects) {
  return { effects, digest: effectsDigest(effects) };
}

module.exports = {
  planSendEffects,
  planChargeEffects,
  effectsDigest,
  closeoutLine,
  SEND_CALL_COVERAGE,
  CHARGE_CALL_COVERAGE,
};
