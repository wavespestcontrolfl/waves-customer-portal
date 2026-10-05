/**
 * Intelligence Bar — Resend a paid receipt
 * server/services/intelligence-bar/receipt-resend-tools.js
 *
 * `resend_receipt` sends (or re-sends) the paid receipt for ONE invoice — the
 * Invoices page "Resend receipt" button, through the same writer
 * (invoice-receipt-resend.js sendInvoiceReceipt, which the route also calls).
 *
 *   unconfirmed → a PREVIEW: invoice, the amount the receipt states, paid date,
 *                 whether a receipt already went out (and when — then it is a
 *                 RE-SEND), the channels, and who it reaches (masked). Nothing
 *                 is sent.
 *   confirmed   → re-reads all of that and refuses on any drift from what the
 *                 card showed (write-gates.js two-step: the route fingerprints
 *                 the preview, then hands its `_version` to the executor), then
 *                 calls the shared writer and reports each channel honestly.
 *
 * The shared writer first runs the visit closeout (GATE_INVOICE_ISSUED_CLOSES_VISIT,
 * the Invoices button's own behavior): with the gate on, a linked live visit is
 * completed even if both legs then fail. The card names that visit (the closeout
 * service's own would-close check), it is pinned, and the result reports the outcome.
 *
 * Recipients come from the closeout-repair receipt resolvers
 * (receiptRecipients, resend mode: the manual send's own email resolver, so the
 * card never names a different inbox than the send). A provider timeout is
 * reported as unknown. Every sentence in a result comes from a value the writer
 * returned (delivery, closeout, queue); nothing promises what it did not report.
 *
 * Results carry ids, states and reasons — no customer names, phones or
 * addresses beyond the masked recipients on the card.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString, formatETTime } = require('../../utils/datetime-et');
const { receiptRecipients, receiptRecipientsKey, normalizeReceiptEmail, maskEmail, maskPhone } = require('./closeout-repair-tools');
const { sendInvoiceReceipt } = require('../invoice-receipt-resend');
const { issuedCloseoutTarget } = require('../invoice-issued-closeout');
const { expectedEmailSkip } = require('../receipt-delivery-queue');

const VIA_LABEL = { email: 'email only', sms: 'text only', both: 'email and text' };

const RECEIPT_RESEND_TOOLS = [
  {
    name: 'resend_receipt',
    description: `Send (or re-send) the paid receipt for ONE invoice to the customer, exactly as the Invoices page "Resend receipt" button does. The first call returns a PREVIEW and sends nothing: the invoice, the amount the receipt states, the paid date, whether a receipt was already sent and when (then the card says plainly it is a RE-SEND), the channels, and who it reaches (masked). The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and reports email and text separately (sent, not sent with the reason, or unknown when the provider did not answer), the outcome of the visit closeout, and what became of a queued automatic receipt for the invoice (back in the queue and will deliver on its own, held for reconciliation, or none) — say only what those fields report.
Refused with the reason: a memo with a text-only send, invoice not found, not paid, a receipt for this invoice is being delivered right now, no recipient on file, amount unverifiable, an opted-out customer with no email leg. A customer who opted out of payment receipts is NOT refused by email (a staff resend usually answers their own request): only the email goes, the card says so, and you tell the operator before they confirm.
Takes invoice_id OR invoice_number (e.g. WPC-2026-0534), exactly one. via is email, sms or both (default both). memo is an optional note that appears in the receipt EMAIL only (the receipt text, the receipt PDF and the receipt page do not carry it), so it needs via email or both: a memo with via sms is refused — only include a memo when the operator gave you the words. The customer is contacted. Admin-only.
Use for: "resend the receipt for invoice X", "send the paid receipt again", "the customer never got their receipt". To know whether a receipt already went out, read receipt_sent_at from get_invoice_detail / get_customer_invoices; never guess.`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'The paid invoice (from get_customer_invoices)' },
        invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
        via: { type: 'string', enum: ['email', 'sms', 'both'], description: 'Which channels to send on (default both)' },
        memo: { type: 'string', description: 'Optional note that appears in the receipt email only, never in the text (up to 400 characters; longer is cut). Not allowed with via sms.' },
      },
    },
    _sideEffects: true,
  },
];

// The invoice the call names: exactly one of id / number.
async function resolveInvoiceId(input) {
  const rawId = String(input.invoice_id || '').trim();
  const rawNumber = String(input.invoice_number || '').trim();
  if (Boolean(rawId) === Boolean(rawNumber)) return { error: 'Give exactly one of invoice_id or invoice_number', code: 'invalid_target' };
  if (rawId) {
    return UUID_RE.test(rawId) ? { id: rawId.toLowerCase() } : { error: 'A valid invoice_id is required', code: 'invalid_target' };
  }
  const row = await db('invoices').where({ invoice_number: rawNumber.toUpperCase() }).first('id');
  return row ? { id: row.id } : { error: 'No invoice has that number', code: 'invoice_not_found' };
}

const etStamp = (value) => {
  const at = new Date(value);
  return `${etDateString(at)} ${formatETTime(at)} ET`;
};

// Who the receipt reaches, in plain words — email to the manual send's own
// recipient; the text goes now (operator-initiated, no send-window hold) when
// the customer's receipt settings allow it.
function reach(who, via) {
  const parts = [];
  if (via !== 'sms') parts.push(who.email ? `email to ${maskEmail(who.email)}${who.payerBilled ? " (the payer's billing inbox)" : ''}` : 'no email (none on file)');
  if (via !== 'email') {
    const text = who.payerBilled ? 'no text (a payer-billed receipt is never texted)'
      : who.optedOut ? 'no text (the customer opted out of payment receipts; only the email ignores that)'
      : [who.phone && `text to ${maskPhone(who.phone)}`, who.app && 'a Waves app notification'].filter(Boolean).join(' or ') || 'no text (no phone on file)';
    parts.push((who.phone || who.app) && !who.payerBilled && !who.optedOut ? `${text}, sent now if the customer's receipt settings allow` : text);
  }
  return parts.join('; ');
}

const VALID_VIA = ['email', 'sms', 'both'];
const blocked = (reason, code, invoiceId) => ({ error: reason, code, ...(invoiceId ? { invoice_id: invoiceId } : {}) });

// Eligibility: the invoice, who the receipt reaches, and that the chosen channel has someone to reach.
// Returns { via, memo, who } or the plain refusal.
async function checkEligibility(input, ownClaimToken) {
  const via = input.via === undefined || input.via === null ? 'both' : input.via;
  if (!VALID_VIA.includes(via)) return blocked("via must be 'email', 'sms', or 'both'", 'invalid_target');
  const memo = typeof input.memo === 'string' ? input.memo.trim().slice(0, 400) : '';
  // Refused before anything is read: the note is printed in the email only, never in the text.
  if (via === 'sms' && memo) {
    return blocked('A note appears in the receipt email only — the text receipt does not carry it. Send by email or both, or leave the note off.', 'memo_needs_email');
  }
  const target = await resolveInvoiceId(input);
  if (target.error) return target;
  const who = await receiptRecipients(target.id, db, { resend: true, ownClaimToken });
  if (who.blocker) {
    return blocked(`A receipt cannot be sent: ${who.blocker}.`, who.blocker === 'invoice not found' ? 'invoice_not_found' : 'resend_blocked', target.id);
  }
  if (via === 'email' && !who.email) return blocked('A receipt cannot be sent by email: no receipt email on file.', 'resend_blocked', target.id);
  // An opted-out customer is reached by the manual email only: sendReceipt honors the same opt-out for
  // the text and app legs (receipt_texts_opted_out), so a send with no email leg would send nothing.
  if (who.optedOut && (via === 'sms' || !who.email)) {
    return blocked(`A receipt cannot be sent: the customer opted out of payment receipts, so only an email can reach them, and ${via === 'sms' ? 'this send has no email' : 'no receipt email is on file'}.`, 'resend_blocked', target.id);
  }
  if (via === 'sms' && (who.payerBilled || !(who.phone || who.app))) {
    return blocked(`A receipt cannot be sent by text: ${who.payerBilled ? 'a payer-billed receipt is never texted' : 'no phone on file'}.`, 'resend_blocked', target.id);
  }
  return { via, memo, who };
}

// The linked visit the closeout would complete (null = none); a probe that cannot read fails closed.
async function probeCloseout(invoice) {
  try {
    return { closeout: await issuedCloseoutTarget(invoice, { trigger: 'paid' }) };
  } catch {
    return { error: blocked('A receipt cannot be sent: the linked visit\'s closeout could not be checked.', 'resend_blocked', invoice.id) };
  }
}

// The card's optional lines: a queued automatic receipt (disclosed, not pinned: the claim settles
// it) and the visit closeout (backed by issuedCloseoutTarget and the closeout's quiet posture,
// runQuietCloseout: backfill, no completion text, report, review ask or charge).
function optionalCardLines({ memo, queuedJob, closeout, optedOut }) {
  const closeoutLine = closeout?.resuming
    ? `Also finishes a closeout already started for the linked visit — ${closeout.serviceType || 'visit'} on ${closeout.date}: completes its remaining steps, even if the receipt itself does not go out; no completion text, report, review request or charge`
    : `Also completes the linked visit — ${closeout?.serviceType || 'visit'} on ${closeout?.date}: creates its service record, even if the receipt itself does not go out; no completion text, report, review request or charge`;
  return {
    ...(memo ? { memo, memo_note: 'The note appears in the receipt email only; the text receipt does not carry it.' } : {}),
    ...(queuedJob ? {
      // The queue honors the opt-out (processReceiptDeliveryJob closes the job as receipt_opted_out).
      automatic_receipt: optedOut
        ? 'An automatic receipt is queued for this invoice, but the customer opted out of payment receipts, so it will close without sending. Only this send can deliver the receipt.'
        : 'An automatic receipt is queued for this invoice. If this send does not deliver the email, it goes back in the queue and will try again on its own; a delivered email closes it.',
    } : {}),
    ...(closeout ? { visit_closeout: closeoutLine } : {}),
    ...(optedOut ? { opted_out: 'This customer opted out of payment receipts. Send only if they asked for this receipt.' } : {}),
  };
}

// Everything the confirmed run re-checks, hash-bound and hidden from the card: `receipt_state` is the
// receipt_sent_at the card showed — a key ending in _at is excluded from the fingerprint, so the
// instant is carried as a value, not a key.
// The paid instant the receipt email states (its text and PDF are built from invoice.paid_at): a refund or
// dispute restoration that rewrites it changes what the customer is sent. Milliseconds, as the email sender
// reports them in its handoff facts (null = no paid date).
const paidKey = (invoice) => (invoice?.paid_at ? new Date(invoice.paid_at).getTime() : null);

function approvedVersion({ invoice, via, who, memo, closeout, sentAt }) {
  return {
    invoice_id: invoice.id,
    via,
    amount: who.amount,
    paid: paidKey(invoice),
    recipients_key: receiptRecipientsKey(who),
    // The opt-out the card disclosed: one set since the card is drift.
    opted_out: who.optedOut === true,
    memo,
    // The linked visit the closeout would complete (null = none).
    closeout_visit: closeout?.visitId || null,
    // The instant the card showed (null = unsent): a stamp since is drift.
    receipt_state: sentAt ? `sent:${sentAt.getTime()}` : 'unsent',
  };
}

// The preview with the resolved reach it was built from: { plan, who, via }. `plan` is the preview, or
// the plain refusal (an `error` object) with no `who`.
async function derivePlan(input, { ownClaimToken = null } = {}) {
  const eligible = await checkEligibility(input, ownClaimToken);
  if (eligible.error) return { plan: eligible };
  const { via, memo, who } = eligible;
  const { invoice } = who;
  const probe = await probeCloseout(invoice);
  if (probe.error) return { plan: probe.error };
  const { closeout } = probe;
  const sentAt = invoice.receipt_sent_at ? new Date(invoice.receipt_sent_at) : null;
  const queuedJob = await db('receipt_delivery_jobs').where({ invoice_id: invoice.id }).whereIn('status', ['queued', 'retry_scheduled']).first('id');
  const customer = await db('customers').where({ id: invoice.customer_id }).first('first_name', 'last_name');
  const plan = {
    preview: true,
    invoice_id: invoice.id,
    invoice_number: who.invoiceNumber,
    customer_id: invoice.customer_id,
    customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || null,
    amount: who.amount,
    paid_date: invoice.paid_at ? etDateString(new Date(invoice.paid_at)) : null,
    resend: Boolean(sentAt),
    receipt_status: sentAt
      ? `Already sent on ${etStamp(sentAt)} — this is a RE-SEND: the customer gets another receipt`
      : 'No receipt is recorded as sent yet',
    channels: VIA_LABEL[via],
    recipients: reach(who, via),
    ...optionalCardLines({ memo, queuedJob, closeout, optedOut: who.optedOut }),
    _version: approvedVersion({ invoice, via, who, memo, closeout, sentAt }),
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
  };
  return { plan, who, via };
}

// The preview, or the plain refusal.
async function buildPlan(input, opts) {
  return (await derivePlan(input, opts)).plan;
}

// The facts an approved send may hand a provider, compared in memory at the provider boundary (no database
// read): what the senders report ({ channel, to, amount }) against the resolved reach this plan was built from.
// The comparison reuses receiptRecipientsKey — the same function that produced the approved recipients_key —
// with the sender's own value swapped in, so normalization cannot drift from the card's. App delivery
// resolves its devices inside the pipeline, so the plan can only know that App was part of the approved reach.
function approvedMatcher({ who, via }) {
  // Every leg states the receipt amount the card previews: net of a recorded refund, otherwise the
  // amount due (sendReceiptEmail and receiptAmountFor apply the same rule).
  const sameAmount = (amount) => Number(amount).toFixed(2) === Number(who.amount).toFixed(2);
  const sameReach = (swap) => receiptRecipientsKey({ email: who.email, phone: who.phone, app: who.app, ...swap }) === receiptRecipientsKey(who);
  return (facts) => {
    if (!facts) return false;
    if (!sameAmount(facts.amount)) return false;
    switch (facts.channel) {
      // The email (and its PDF) state the paid date; the text states none, so only the email is bound to it.
      case 'email': return via !== 'sms' && Boolean(who.email) && (facts.paid ?? null) === paidKey(who.invoice)
        && sameReach({ email: normalizeReceiptEmail(facts.to) });
      case 'sms': return via !== 'email' && !who.payerBilled && Boolean(who.phone) && sameReach({ phone: facts.to });
      case 'app': return via !== 'email' && !who.payerBilled && who.app === true;
      default: return false;
    }
  };
}

// Plain words for the reasons the two senders return.
const SMS_REASONS = {
  channel_email_only: 'the customer chose email-only receipts',
  receipt_texts_opted_out: 'the customer opted out of receipt texts',
  sms_suppressed: 'the customer opted out of texts',
  payer_billed: 'a payer-billed receipt is never texted',
  'no-phone': 'no phone on file',
  'template-missing': 'the receipt text template is switched off',
  'already-sent': 'already sent',
};
const EXPECTED_SMS_SKIPS = new Set(['channel_email_only', 'receipt_texts_opted_out', 'sms_suppressed', 'payer_billed', 'no-phone']);

// `certainty` is the shared writer's structured per-leg verdict (sent / not_sent /
// unknown / not_requested, from the senders' deliveryOutcome) — never the error text.
function channelOutcome(requested, result, certainty, { reasons = {}, isExpectedSkip }) {
  if (!requested) return { status: 'not_requested' };
  if (certainty === 'sent' || result?.ok) return { status: 'sent' };
  const raw = String(result?.error || 'not sent').slice(0, 160);
  if (certainty === 'unknown') {
    return { status: 'unknown', detail: 'the provider did not answer — the receipt may or may not have gone out; check before sending again' };
  }
  return { status: 'not_sent', detail: reasons[raw] || raw, expected: isExpectedSkip(raw) };
}

// What the queue will actually do, from the writer's own report of the automatic
// receipt job (releaseOperatorReceiptClaim) — never a guess.
function queueNote(queue, { allDelivered, optedOut = false }) {
  switch (queue) {
    case 'returned_to_queue': return optedOut
      ? 'The automatic receipt job is back in the queue, but the customer opted out of payment receipts, so it will close without sending. Nothing else will send this receipt.'
      : 'The automatic receipt for this invoice is back in the queue and will try again on its own (it can email the customer the receipt), so a manual resend is not needed for that.';
    case 'held_for_reconciliation': return 'The automatic receipt for this invoice was held, not re-queued: the queue will not send it again. Check whether the customer got the receipt before sending again.';
    case 'release_failed': return optedOut
      ? 'The automatic receipt job could not be settled here; the queue recovers it on its own, but the customer opted out of payment receipts, so it will close without sending. Nothing else will send this receipt.'
      : 'The automatic receipt job could not be settled here; the queue recovers it on its own and may email the customer the receipt again.';
    case 'none':
    case 'removed': return allDelivered ? null : 'No automatic receipt is waiting in the queue, so nothing else will send this receipt.';
    default: return null; // 'completed' (closed by this send) or not reported
  }
}

// What was lost with the send lock (the writer's own report): the step that found its session gone.
const LOCK_LOST_STEP = {
  before_claim: 'before anything started',
  before_closeout: 'before the visit closeout',
  before_email: 'before the email',
  before_text: 'before the text',
  before_stamp: 'before the sent-time stamp',
};
// The stamp sentence comes from the writer's own report (derived after the claim settled): not recorded,
// or recorded by the queue settlement because the send's own stamp had been skipped.
function stampSentence(stampWritten, stampBy) {
  if (stampWritten === false) return ' The receipt went out but its sent-time stamp was not recorded.';
  return stampBy === 'settlement' ? ' The sent-time stamp was recorded when the automatic receipt job was settled.' : '';
}
function lockNote(lockLost, stampWritten, stampBy) {
  if (!lockLost) return null;
  return `The send lock was lost partway through (${LOCK_LOST_STEP[lockLost] || lockLost}), so the steps after it were not started — a step shown as not sent with "send lock lost" never ran.${stampSentence(stampWritten, stampBy)}`;
}

// Classify the writer's per-leg report into the tool's own leg statuses.
function classifyLegs(version, body, delivery) {
  const email = channelOutcome(version.via !== 'sms', body.email, delivery?.email, { isExpectedSkip: (raw) => expectedEmailSkip({ error: raw }) });
  const text = channelOutcome(version.via !== 'email', body.sms, delivery?.sms, { reasons: SMS_REASONS, isExpectedSkip: (raw) => EXPECTED_SMS_SKIPS.has(raw) });
  const legs = [email, text].filter((leg) => leg.status !== 'not_requested');
  return {
    email,
    text,
    delivered: legs.some((leg) => leg.status === 'sent'),
    anyUnknown: legs.some((leg) => leg.status === 'unknown'),
    allExpected: legs.every((leg) => leg.status === 'sent' || (leg.status === 'not_sent' && leg.expected)),
  };
}

// The visit closeout that ran ahead of the legs: reported when the card named one or it ran.
function reportCloseout(version, closeout) {
  if (!(version.closeout_visit || closeout?.closed)) return null;
  return closeout?.closed
    ? { status: 'completed', visit_id: closeout.visitId }
    : { status: 'not_completed', visit_id: version.closeout_visit, detail: String(closeout?.reason || 'not completed') };
}

// The headline sentence. Unknown first: a leg whose delivery could not be confirmed is never worded as not sent.
function headline({ delivered, anyUnknown, clean, closeoutOnly }) {
  if (anyUnknown) {
    return delivered
      ? 'Part of the receipt was sent; delivery of the rest could not be confirmed — see email and text. Check before sending again.'
      : 'Delivery of the receipt could not be confirmed — it may or may not have gone out; see email and text. Check before sending again.';
  }
  if (delivered) return clean ? 'The receipt was sent.' : 'Part of the receipt did not go out — see email and text.';
  return closeoutOnly
    ? 'The receipt was not sent, but the linked visit was completed — see email, text and visit_closeout.'
    : 'The receipt was not sent — see email and text.';
}

// The result's outcome class (what executionOutcome reads), from the classified legs.
function outcomeEnvelope({ delivered, anyUnknown, clean, closeoutOnly }) {
  if (delivered) return clean ? { success: true } : { partial: true };
  if (anyUnknown) return { outcome_unknown: true, error: 'The receipt outcome is unknown — check before sending again.' };
  // The closeout is a committed effect of its own: a visit completed with no receipt out is partial, not failed.
  if (closeoutOnly) return { partial: true };
  return { error: 'No receipt was sent.', failed: true };
}

// The verified, pinned plan — or the refusal when anything changed since the card.
async function verifiedPlan(input) {
  const pinned = input._verified_receipt_version;
  if (!pinned) return { refusal: { error: 'Use the confirmation card to approve this change.' } };
  const derived = await derivePlan(input);
  const { plan } = derived;
  if (plan.error) return { refusal: { error: `Nothing was sent: ${plan.error}`, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'What this receipt would do changed after the card was shown — nothing was sent. Ask again for a fresh confirmation card.', preview_changed: true } };
  }
  return { plan, pinned, matches: approvedMatcher(derived) };
}

function callWriter(version, pinned, matches, actionContext) {
  return sendInvoiceReceipt(version.invoice_id, {
    memo: version.memo, via: version.via, actorTechnicianId: actionContext?.technicianId || null,
    // An unknown provider outcome parks a claimed automatic job instead of re-queuing it.
    holdUnknownOutcome: true,
    // The receipt state the card showed (the claim refuses an unsent receipt stamped since).
    sawUnsent: version.receipt_state === 'unsent',
    // The writer's final check: under its claim, ahead of the closeout and both legs, it re-derives
    // this approved version (receipt_sent_at, recipients, amount, linked visit, channels) and refuses
    // on any difference; and `matches` binds each sender's resolved recipient and amount to the approved
    // ones at the provider boundary.
    expect: {
      approved: pinned,
      matches,
      rederive: async ({ ownClaimToken }) => {
        const again = await buildPlan({ invoice_id: version.invoice_id, via: version.via, memo: version.memo }, { ownClaimToken });
        return again.error ? null : again._version;
      },
    },
  });
}

async function commit(input, actionContext) {
  const verified = await verifiedPlan(input);
  if (verified.refusal) return verified.refusal;
  const { plan, pinned, matches } = verified;
  const version = plan._version;
  const { status, body, closeout, delivery, queue, lockLost, stampWritten, stampBy } = await callWriter(version, pinned, matches, actionContext);
  if (status === 409) return { error: `Nothing was sent: ${body.error}`, code: body.code, preview_changed: true };
  if (status !== 200) return { error: `Nothing was sent: ${body.error}`, code: 'resend_blocked' };

  const { email, text, delivered, anyUnknown, allExpected } = classifyLegs(version, body, delivery);
  const visitCloseout = reportCloseout(version, closeout);
  const clean = allExpected && visitCloseout?.status !== 'not_completed';
  const closeoutOnly = !delivered && visitCloseout?.status === 'completed' && !anyUnknown;
  const verdict = { delivered, anyUnknown, clean, closeoutOnly };
  logger.info(`[intelligence-bar:resend-receipt] ${version.invoice_id}: email ${email.status}, text ${text.status}, automatic receipt ${queue || 'unreported'}`);
  return {
    ...outcomeEnvelope(verdict),
    invoice_id: version.invoice_id,
    invoice_number: plan.invoice_number,
    email,
    text,
    ...(visitCloseout ? { visit_closeout: visitCloseout } : {}),
    ...(queue ? { automatic_receipt: queue } : {}),
    ...(lockLost ? { send_lock_lost: lockLost, ...(stampWritten === false ? { receipt_stamp_written: false } : {}), ...(stampBy === 'settlement' ? { receipt_stamp_by: 'settlement' } : {}) } : {}),
    note: [headline(verdict), lockNote(lockLost, stampWritten, stampBy), queueNote(queue, { allDelivered: delivered && clean, optedOut: version.opted_out === true })].filter(Boolean).join(' '),
  };
}

async function executeReceiptResendTool(toolName, input = {}, actionContext = {}) {
  // Admin-only like the requireAdmin route it mirrors; the route and registry
  // refuse a technician too.
  if (actionContext && actionContext.isAdmin === false) {
    return { error: 'Receipt re-sends are limited to admin accounts', code: 'permission_denied' };
  }
  try {
    switch (toolName) {
      case 'resend_receipt': {
        // Only /confirm-action sets confirmed (route-derived, never a model param).
        if (input.confirmed !== true) return await buildPlan(input);
        return await commit(input, actionContext);
      }
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:resend-receipt] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow a delivered send: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The receipt send was interrupted — it may or may not have gone out. Check the invoice before sending again.' }
      : { error: 'Could not prepare the receipt re-send' };
  }
}

module.exports = { RECEIPT_RESEND_TOOLS, executeReceiptResendTool, approvedMatcher };
