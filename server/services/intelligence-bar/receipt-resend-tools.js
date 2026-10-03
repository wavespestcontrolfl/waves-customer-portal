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
const { receiptRecipients, receiptRecipientsKey, maskEmail, maskPhone } = require('./closeout-repair-tools');
const { sendInvoiceReceipt } = require('../invoice-receipt-resend');
const { issuedCloseoutTarget } = require('../invoice-issued-closeout');
const { expectedEmailSkip } = require('../receipt-delivery-queue');

const VIA_LABEL = { email: 'email only', sms: 'text only', both: 'email and text' };

const RECEIPT_RESEND_TOOLS = [
  {
    name: 'resend_receipt',
    description: `Send (or re-send) the paid receipt for ONE invoice to the customer, exactly as the Invoices page "Resend receipt" button does. The first call returns a PREVIEW and sends nothing: the invoice, the amount the receipt states, the paid date, whether a receipt was already sent and when (then the card says plainly it is a RE-SEND), the channels, and who it reaches (masked). The operator approves on the confirmation card; the confirmed run re-checks all of it, refuses if anything changed, and reports email and text separately (sent, not sent with the reason, or unknown when the provider did not answer), the outcome of the visit closeout, and what became of a queued automatic receipt for the invoice (back in the queue and will deliver on its own, held for reconciliation, or none) — say only what those fields report.
Refused with the reason: invoice not found, not paid, the automatic receipt is being delivered right now, the customer opted out of payment receipts, no recipient on file, amount unverifiable.
Takes invoice_id OR invoice_number (e.g. WPC-2026-0534), exactly one. via is email, sms or both (default both). memo is an optional note printed on the receipt — only include it when the operator gave you the words. The customer is contacted. Admin-only.
Use for: "resend the receipt for invoice X", "send the paid receipt again", "the customer never got their receipt". To know whether a receipt already went out, read receipt_sent_at from get_invoice_detail / get_customer_invoices; never guess.`,
    input_schema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', format: 'uuid', description: 'The paid invoice (from get_customer_invoices)' },
        invoice_number: { type: 'string', description: 'The invoice number, e.g. WPC-2026-0534 (use instead of invoice_id)' },
        via: { type: 'string', enum: ['email', 'sms', 'both'], description: 'Which channels to send on (default both)' },
        memo: { type: 'string', description: 'Optional note printed on the receipt (up to 400 characters; longer is cut)' },
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
      : [who.phone && `text to ${maskPhone(who.phone)}`, who.app && 'a Waves app notification'].filter(Boolean).join(' or ') || 'no text (no phone on file)';
    parts.push(who.phone || who.app ? `${text}, sent now if the customer's receipt settings allow` : text);
  }
  return parts.join('; ');
}

// The preview, or the plain refusal. Everything the confirmed run re-checks is
// in `_version` (hash-bound, hidden from the card): `receipt_state` is the
// receipt_sent_at the card showed — a key ending in _at is excluded from the
// fingerprint, so the instant is carried as a value, not a key.
async function buildPlan(input, { ownClaimToken = null } = {}) {
  const via = input.via === undefined || input.via === null ? 'both' : input.via;
  if (!['email', 'sms', 'both'].includes(via)) return { error: "via must be 'email', 'sms', or 'both'", code: 'invalid_target' };
  const memo = typeof input.memo === 'string' ? input.memo.trim().slice(0, 400) : '';
  const target = await resolveInvoiceId(input);
  if (target.error) return target;

  const who = await receiptRecipients(target.id, db, { resend: true, ownClaimToken });
  if (who.blocker) {
    return { error: `A receipt cannot be sent: ${who.blocker}.`, code: who.blocker === 'invoice not found' ? 'invoice_not_found' : 'resend_blocked', invoice_id: target.id };
  }
  if (via === 'email' && !who.email) return { error: 'A receipt cannot be sent by email: no receipt email on file.', code: 'resend_blocked', invoice_id: target.id };
  if (via === 'sms' && (who.payerBilled || !(who.phone || who.app))) {
    return { error: `A receipt cannot be sent by text: ${who.payerBilled ? 'a payer-billed receipt is never texted' : 'no phone on file'}.`, code: 'resend_blocked', invoice_id: target.id };
  }

  const { invoice } = who;
  let closeout;
  try {
    closeout = await issuedCloseoutTarget(invoice, { trigger: 'paid' });
  } catch {
    return { error: 'A receipt cannot be sent: the linked visit\'s closeout could not be checked.', code: 'resend_blocked', invoice_id: target.id };
  }
  const sentAt = invoice.receipt_sent_at ? new Date(invoice.receipt_sent_at) : null;
  // A queued automatic receipt is settled by this send (the release below): disclosed, not pinned.
  const queuedJob = await db('receipt_delivery_jobs').where({ invoice_id: invoice.id }).whereIn('status', ['queued', 'retry_scheduled']).first('id');
  const customer = await db('customers').where({ id: invoice.customer_id }).first('first_name', 'last_name');
  return {
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
    ...(memo ? { memo } : {}),
    ...(queuedJob ? {
      automatic_receipt: 'An automatic receipt is queued for this invoice. If this send does not deliver the email, it goes back in the queue and will try again on its own; a delivered email closes it.',
    } : {}),
    ...(closeout ? {
      // Backed by the closeout's own target (issuedCloseoutTarget) and its quiet posture (runQuietCloseout:
      // backfill, no completion text, no report, no review ask, no charge).
      visit_closeout: closeout.resuming
        ? `Also finishes a closeout already started for the linked visit — ${closeout.serviceType || 'visit'} on ${closeout.date}: completes its remaining steps, even if the receipt itself does not go out; no completion text, report, review request or charge`
        : `Also completes the linked visit — ${closeout.serviceType || 'visit'} on ${closeout.date}: creates its service record, even if the receipt itself does not go out; no completion text, report, review request or charge`,
    } : {}),
    _version: {
      invoice_id: invoice.id,
      via,
      amount: who.amount,
      recipients_key: receiptRecipientsKey(who),
      memo,
      // The linked visit the closeout would complete (null = none).
      closeout_visit: closeout?.visitId || null,
      // The instant the card showed (null = unsent): a stamp since is drift.
      receipt_state: sentAt ? `sent:${sentAt.getTime()}` : 'unsent',
    },
    note: 'PREVIEW ONLY — nothing was sent. Confirm sends exactly this; if anything changed it refuses.',
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
function queueNote(queue, { allDelivered }) {
  switch (queue) {
    case 'returned_to_queue': return 'The automatic receipt for this invoice is back in the queue and will try again on its own (it can email the customer the receipt), so a manual resend is not needed for that.';
    case 'held_for_reconciliation': return 'The automatic receipt for this invoice was held, not re-queued: the queue will not send it again. Check whether the customer got the receipt before sending again.';
    case 'release_failed': return 'The automatic receipt job could not be settled here; the queue recovers it on its own and may email the customer the receipt again.';
    case 'none':
    case 'removed': return allDelivered ? null : 'No automatic receipt is waiting in the queue, so nothing else will send this receipt.';
    default: return null; // 'completed' (closed by this send) or not reported
  }
}

async function commit(input, actionContext) {
  const pinned = input._verified_receipt_version;
  if (!pinned) return { error: 'Use the confirmation card to approve this change.' };
  const plan = await buildPlan(input);
  if (plan.error) return { error: `Nothing was sent: ${plan.error}`, preview_changed: true };
  const version = plan._version;
  if (JSON.stringify(version) !== JSON.stringify(pinned)) {
    return { error: 'What this receipt would do changed after the card was shown — nothing was sent. Ask again for a fresh confirmation card.', preview_changed: true };
  }

  const { status, body, closeout, delivery, queue } = await sendInvoiceReceipt(version.invoice_id, {
    memo: version.memo, via: version.via, actorTechnicianId: actionContext?.technicianId || null,
    // An unknown provider outcome parks a claimed automatic job instead of re-queuing it.
    holdUnknownOutcome: true,
    // The receipt state the card showed (the claim refuses an unsent receipt stamped since).
    sawUnsent: version.receipt_state === 'unsent',
    // The writer's final check: under its claim, ahead of the closeout and both legs, it re-derives
    // this approved version (receipt_sent_at, recipients, amount, linked visit, channels) and refuses
    // on any difference.
    expect: {
      approved: pinned,
      rederive: async ({ ownClaimToken }) => {
        const again = await buildPlan({ invoice_id: version.invoice_id, via: version.via, memo: version.memo }, { ownClaimToken });
        return again.error ? null : again._version;
      },
    },
  });
  if (status === 409) return { error: `Nothing was sent: ${body.error}`, code: body.code, preview_changed: true };
  if (status !== 200) return { error: `Nothing was sent: ${body.error}`, code: 'resend_blocked' };

  const email = channelOutcome(version.via !== 'sms', body.email, delivery?.email, { isExpectedSkip: (raw) => expectedEmailSkip({ error: raw }) });
  const text = channelOutcome(version.via !== 'email', body.sms, delivery?.sms, { reasons: SMS_REASONS, isExpectedSkip: (raw) => EXPECTED_SMS_SKIPS.has(raw) });
  const legs = [email, text].filter((leg) => leg.status !== 'not_requested');
  const delivered = legs.some((leg) => leg.status === 'sent');
  // The visit closeout that ran ahead of the legs: reported when the card named one or it ran.
  const visitCloseout = version.closeout_visit || closeout?.closed
    ? (closeout?.closed
      ? { status: 'completed', visit_id: closeout.visitId }
      : { status: 'not_completed', visit_id: version.closeout_visit, detail: String(closeout?.reason || 'not completed') })
    : null;
  const clean = legs.every((leg) => leg.status === 'sent' || (leg.status === 'not_sent' && leg.expected))
    && visitCloseout?.status !== 'not_completed';
  logger.info(`[intelligence-bar:resend-receipt] ${version.invoice_id}: email ${email.status}, text ${text.status}, automatic receipt ${queue || 'unreported'}`);
  const closeoutOnly = !delivered && visitCloseout?.status === 'completed' && !legs.some((leg) => leg.status === 'unknown');
  const what = delivered
    ? (clean ? 'The receipt was sent.' : 'Part of the receipt did not go out — see email and text.')
    : (closeoutOnly ? 'The receipt was not sent, but the linked visit was completed — see email, text and visit_closeout.' : 'The receipt was not sent — see email and text.');
  const result = {
    invoice_id: version.invoice_id,
    invoice_number: plan.invoice_number,
    email,
    text,
    ...(visitCloseout ? { visit_closeout: visitCloseout } : {}),
    ...(queue ? { automatic_receipt: queue } : {}),
    note: [what, queueNote(queue, { allDelivered: delivered && clean })].filter(Boolean).join(' '),
  };
  if (delivered) return clean ? { success: true, ...result } : { partial: true, ...result };
  if (legs.some((leg) => leg.status === 'unknown')) return { outcome_unknown: true, error: 'The receipt outcome is unknown — check before sending again.', ...result };
  // The closeout is a committed effect of its own: a visit completed with no receipt out is partial, not failed.
  if (closeoutOnly) return { partial: true, ...result };
  return { error: 'No receipt was sent.', failed: true, ...result };
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

module.exports = { RECEIPT_RESEND_TOOLS, executeReceiptResendTool };
