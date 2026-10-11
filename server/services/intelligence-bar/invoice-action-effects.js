/**
 * Intelligence Bar — the ONE effects plan for send_invoice
 * server/services/intelligence-bar/invoice-action-effects.js
 *
 * A send does more than its headline: the Send handler's post-delivery block runs a list of follow-on
 * effects (lead conversion, billing reminders, the visit closeout, review outreach ...). This module lists
 * ALL of them for one invoice, in one place:
 *
 *   planSendEffects(invoice, customer, ctx) - what sendViaSMSAndEmail does after a delivery
 *
 * Each effect is { key, applies, state, line, kind }. `line` is the card sentence (null = nothing to
 * say), `state` is the short fact that decides the effect, and `applies` says whether it happens.
 * The card renders every line, `_version.effects` pins the digest of the whole list, and the
 * confirmed run recomputes the list under the invoice claim and refuses as
 * preview_changed on any difference.
 *
 * Nothing here re-implements a handler's test. Each effect calls the function the handler itself
 * calls (invoice.js leadConversionApplies / alreadyDeliveredForFirstSend, lead-estimate-link.js
 * invoiceSentConversionTargets, invoice-followups.js planFollowupSequence,
 * invoice-delivery-review.js reviewDecisionForInvoice, invoice-issued-closeout.js issuedCloseoutTarget).
 *
 * SEND_CALL_COVERAGE names every side-effect call in that handler and the
 * effect that represents it (or why it cannot apply to a bar action). A source-contract test reads
 * the handlers' code and fails when a call is not listed here, so a new effect cannot slip in
 * unnamed.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const { etDateString, formatETTime } = require('../../utils/datetime-et');

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
  recordApprovedCloseoutDelivery: { effect: null, why: 'an audit row on the invoice that binds the closeout pin to this delivery; nothing the customer sees' },
  recordApprovedCloseoutRetired: { effect: null, why: 'an audit row on the invoice that marks the closeout pin of a handed-back claim as finished; nothing the customer sees' },
  enrollReviewAfterInvoiceDelivery: { effect: 'review' },
  autoApplyAccountCreditIfEnabled: { effect: 'credit' },
  reverseAppliedCredit: { effect: 'credit' },
  resolveAdoptedRowsAfterDelivery: { effect: null, why: 'settles queued-send bookkeeping rows; no message or record the customer sees' },
  restoreSendClaim: { effect: null, why: 'gives the send claim back after a failure; nothing is delivered' },
  requeueHeldInvoice: { effect: null, why: 'only on a collections-hold refusal, which the bar never overrides (holdExempt null)' },
  voidOpenInvoicesForCancelledService: { effect: null, why: 'only when the linked visit was cancelled; the bar sets refusalOnly and never voids' },
};

const FOLLOWUP_STATE_TEXT = {
  active: 'reminders will run',
  autopay_hold: 'held: the customer is on Auto Pay',
  payment_plan: 'none: the invoice has an active payment plan',
  rearm: 'reminders resume after an earlier void',
  autopay_unreadable: 'Auto Pay could not be checked; reminders may run',
  not_schedulable: 'none: the invoice is not in a billable state',
  payer_billed: 'none: the invoice is billed to a payer',
  paused: 'held: an earlier pause on the invoice is restored, so reminders stay paused until someone resumes them',
  completed: 'none: every reminder step has already passed',
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
// `database` is the planner's own handle: inside the send claim it is the claim's transaction, and a probe on the root pool
// would take a second connection while that one is held (DB_POOL_MAX=2 deadlocks).
async function closeoutEffect(invoice, trigger, lead, database = db) {
  const closeout = await require('../invoice-issued-closeout').issuedCloseoutTarget(invoice, { trigger, conn: database });
  return effect('closeout', Boolean(closeout), closeoutState(closeout), closeout ? closeoutLine(closeout, lead) : null);
}

// The files attached to the invoice the customer can open from the online invoice (the delivery email points
// to them). Pinned by id, name, size and edit time, read with the caller's handle so the send claim reads
// them under the claim.
async function attachmentsEffect(invoice, database) {
  const Helpers = require('../invoice-helpers');
  const rows = await Helpers.loadInvoiceAttachmentRows(database, invoice.id);
  const names = rows.map((row) => String(row.file_name || 'file').replace(/\s+/g, ' ').trim());
  const state = Helpers.attachmentsFingerprint(rows);
  return effect('attachments', rows.length > 0, state, rows.length ? `Attachments the customer can open from the online invoice: ${names.join(', ')}` : 'No attachments.');
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
    await attachmentsEffect(invoice, database),
    await closeoutEffect(invoice, 'sent', 'Sending this invoice', database),
    lead,
    followups,
    effect('review', review, review ? 'requested' : 'none',
      review ? 'Sending this invoice also enrolls the customer in review outreach' : 'No review request is sent.'),
    effect('credit', false, 'skipped',
      'No account credit is applied by this send. If the visit is cancelled before the send runs, nothing is sent and the invoice is held for review (never voided by the bar).', 'billing'),
  ]);
}

// The visit the approved plan would close out, or 'none': what the send hands its closeout as the approved target.
function approvedCloseoutTarget(effects) {
  const closeout = (effects || []).find((e) => e.key === 'closeout');
  return closeout && closeout.applies ? String(closeout.state).split(':')[0] : 'none';
}

// The leads the approved plan would mark won, as an opaque digest of the id set (convertLeadFromEvent's expectedLeadSet; the
// card never carries full ids), or 'none': what the send hands its lead conversion so it converts those leads and no others.
function approvedLeadTargets(effects) {
  const lead = (effects || []).find((e) => e.key === 'lead_conversion');
  return lead && lead.applies ? require('../invoice-helpers').leadSetDigest(String(lead.state).split(',')) : 'none';
}

function finish(effects) {
  return { effects, digest: effectsDigest(effects) };
}

module.exports = {
  planSendEffects,
  approvedCloseoutTarget,
  approvedLeadTargets,
  effectsDigest,
  closeoutLine,
  SEND_CALL_COVERAGE,
  FOLLOWUP_STATE_TEXT,
};
