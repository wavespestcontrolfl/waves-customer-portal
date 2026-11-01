const { billingLegDeliveryState, billingLegContactTime, originalBillingContactArgs } = require('./messaging/billing-channel-routing');
/**
 * Per-Invoice Follow-up Sequence Engine
 *
 * Each unpaid invoice has one row in `invoice_followup_sequences` that tracks
 * which step fires next and when. The cron calls `runPending()` Tue–Fri at
 * 10:16 AM (touches stay anchored to 10:00; the tick is staggered off :00 —
 * see the scheduler block) to send due touches. The Stripe webhook calls `stopOnPayment()` the
 * instant payment succeeds — no "thanks for paying" + "you owe us" crossing.
 *
 * See server/config/invoice-followups.js for step timing + copy.
 *
 * EVERY UPDATE IN THIS FILE MUST STAMP `updated_at`. `timestamps(true, true)`
 * only defaults the column at INSERT — Knex does not maintain it and migration
 * 20260414000032 installs no trigger, so before this was fixed an unstamped
 * UPDATE left the value frozen at creation time. Anything asking "has this
 * sequence been touched since <time>?" — audit reads, reconciliation, and the
 * ownership-change checks below — was therefore reading a timestamp that never
 * moved, even for a sequence that had already dunned several times.
 *
 * A blanket BEFORE UPDATE trigger was considered and REJECTED: it would also
 * fire on pure ownership repoints (a customer merge rewriting customer_id),
 * which must stay invisible to "was this row touched?" checks — a bump there
 * would make the repoint itself read as activity. Explicit stamps, the repo's
 * convention in ~314 other call sites, keep a real mutation and a repoint
 * distinguishable.
 */

const db = require('../models/db');
const invoiceHelpers = require('./invoice-helpers');
const { invoiceWithdrawnFromCustomer } = invoiceHelpers;
const logger = require('./logger');
const { invoiceAmountDue } = require('./invoice-helpers');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { gates } = require('../config/feature-gates');
const { TERMINAL_SCHEDULED_SERVICE_STATUSES } = require('./scheduled-service-statuses');
const StripeService = require('./stripe');
const { sendMicrodepositVerificationEmail } = require('./microdeposit-verification-email');
const config = require('../config/invoice-followups');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { customerOnAutopay, isBankMethodType } = require('./autopay-eligibility');
const { publicPortalUrl } = require('../utils/portal-url');
const EmailTemplateLibrary = require('./email-template-library');
const { currency } = require('./email-template');
const { formatDateOnly } = require('../utils/date-only');
const { approvalDigest, phoneKey, emailKey } = require('../utils/approval-digest');
const { etDateString, etCalendarDayOf, formatETDayDate } = require('../utils/datetime-et');
const { explicitBillingChannels } = require('./billing-delivery-channels');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const {
  billingEmailRecipient, operatorEmailRecipient, selfPayOnlyHandoff, billingEmailSendOutcome, billingEmailSendFailure,
} = require('./billing-email-sender');
const { verdictAllows, verdictDurablyDenied } = require('./billing-reminder-delivery');
const CustomerDunningKeys = require('./customer-dunning/constants');

const FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID = {
  d3_friendly: 'invoice.followup_3_day',
  d7_reminder: 'invoice.followup_7_day',
  d14_firmer: 'invoice.followup_14_day',
  d30_final: 'invoice.followup_30_day',
  // Day 90 ladder only (GATE_DUNNING_LADDER_90).
  d60_reminder: 'invoice.followup_60_day',
  d90_final_notice: 'invoice.followup_90_day',
};

const TERMINAL_INVOICE_STATUSES = ['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'];
const NON_SCHEDULABLE_INVOICE_STATUSES = [...TERMINAL_INVOICE_STATUSES, 'draft'];
// Delivered statuses (the retired late-payment checker's candidate query
// used the same whitelist): a sequence is only revived on an invoice the
// customer has.
const PUBLISHED_INVOICE_STATUSES = ['sent', 'viewed', 'overdue'];

// A dunning touch fires on its first ELIGIBLE send day or not at all (owner
// ruling 2026-08-04, after the 07-29→08-04 cron outage left 17 sequences due).
// Touches are anchored to 10:00 AM NY and the cron ticks minutes later, so a
// healthy fire is minutes past its eligible day's anchor; anything past this
// grace missed its day (the next chance is ≥24h later) and is skipped
// forward, never sent late — a revived cron must not burst a week of stale
// payment reminders. Staleness is measured from firstEligibleFireAt(due),
// NOT the raw due date: Sat/Sun/Mon-anchored touches have always fired on
// Tuesday and must not look three days old by their first chance (Codex r1).
const STALE_TOUCH_GRACE_MS = 20 * 60 * 60 * 1000;

function clean(value) {
  return String(value || '').trim();
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function normalizedStatus(invoice) {
  return String(invoice?.status || '').trim().toLowerCase();
}

function isTerminalInvoice(invoice) {
  return TERMINAL_INVOICE_STATUSES.includes(normalizedStatus(invoice));
}

function isSchedulableInvoice(invoice) {
  return !NON_SCHEDULABLE_INVOICE_STATUSES.includes(normalizedStatus(invoice));
}

// scheduleForInvoice's own never-arm verdicts for an invoice row (it applies them before and again
// under the invoice lock; the Intelligence Bar's effects plan applies them to the post-send row).
// A payer-billed or withdrawn invoice is never dunned to the homeowner. Returns the reason, or null.
function followupArmBlock(invoice) {
  if (!isSchedulableInvoice(invoice)) return 'not_schedulable';
  if (invoice.payer_id || invoiceWithdrawnFromCustomer(invoice)) return 'payer_billed';
  return null;
}

// An active payment plan owns collection: no ordinary dunning is armed or re-armed under it.
function activePaymentPlan(database, invoiceId) {
  return database('payment_plans').where({ invoice_id: invoiceId, status: 'active' }).first('id');
}

// The system stops a void leaves on a sequence; the resend re-arms them (scheduleForInvoice).
const VOID_STOP_STAMPS = ['invoice_voided', 'invoice_voided:prev=paused', 'invoice_terminal_status:void'];

// A sequence the SYSTEM stopped for a void (no admin id): the resend re-arms it.
function isSystemVoidStop(existing) {
  return existing.status === 'stopped'
    && VOID_STOP_STAMPS.includes(String(existing.stopped_reason || ''))
    && !existing.stopped_by_admin_id;
}

// What a resend does to a system-void-stopped sequence: ONE decision, made by scheduleForInvoice (which then writes it) and
// by the Intelligence Bar's planner (which only reads it), so the card cannot describe an outcome the scheduler does not make.
// In this order (each check ends the decision):
//   payment_plan  an active payment plan owns collection: the row is left stopped;
//   paused        a pause retained through the void (paused_* fields, the ':prev=paused' stamp, or the legacy migration stamp)
//                 is restored as PAUSED, never as active dunning;
//   autopay_hold  the row was held for Auto Pay and the customer is still enrolled (`holdForAutopay` is read only now);
//   active / completed  otherwise the cadence resumes from `anchor`: active with the next touch, or completed when every step
//                 has passed.
// `planActive` and `holdForAutopay` are async readers so a reader runs only when the checks before it did not decide.
// Where a re-armed void-stopped sequence's cadence starts: a shifted anchor_at wins, else when the invoice went out
// (sent_at, sms_sent_at, created_at; never the due date). scheduleForInvoice and the Intelligence Bar's preview both call this.
function voidStopRearmAnchor(existing, invoice) {
  return existing.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
}

async function voidStopRearmDecision(existing, { planActive, holdForAutopay, anchor, steps }) {
  const stamp = String(existing.stopped_reason || '');
  if (await planActive()) return { kind: 'payment_plan' };
  if (stamp === 'invoice_voided:prev=paused' || stamp === 'invoice_terminal_status:void'
    || existing.paused_reason || existing.paused_by_admin_id || existing.paused_until) return { kind: 'paused' };
  if (await holdForAutopay()) return { kind: 'autopay_hold', nextTouchAt: null };
  const nextTouchAt = computeNextTouchAt(anchor, existing.step_index, steps);
  return { kind: nextTouchAt ? 'active' : 'completed', nextTouchAt };
}

// Collections policy consult lives in the SHARED rail guard (codex
// 2026-08-14: one implementation, not three that drift) — gate-off
// byte-identical, per-channel verdicts, invoice-membership required.
const { collectionsChannelPermitted: railGuardPermitted } = require('./collections/rail-guard');

// A bank-verification re-nudge (mdPending) is written as purpose
// payment_verification, not an overdue reminder, so it names no source and
// the spacing shadow never observes it (Codex #5189 r5); its policy verdict
// is unchanged.
async function collectionsChannelPermitted(customerId, invoiceId, channel, excludeLedgerIds = [], detail = false, verification = false, holdExempt = null) {
  return railGuardPermitted({
    customerId, invoiceId, channel, purpose: 'late_payment', excludeLedgerIds,
    ...(verification ? {} : { source: 'invoice_followups' }), logTag: 'invoice-followups', detail,
    // The operator "send now" button only (owner ruling 2026-09-30: deliberate office
    // sends keep the pay link during a hold); automated ladder touches still wait.
    ...(holdExempt ? { holdExempt } : {}),
  });
}

function followupLedgerKey(row, step, channel) {
  return `invoice_followups:${row.id}:${step.id}:${channel}`;
}

// Same shape as the notificationEventKey already stamped on the actual send
// (sendCustomerMessage's metadata, below) — but stamped on the ledger row
// ITSELF too, so a step that fires through multiple explicitly selected
// channels writes ledger siblings collapseDunningReminderEvents (dunning
// spacing shadow/replay) can group as one customer contact instead of
// counting each channel's leg as an independent reminder (codex r2 P2).
// One event per sequence + step, the same identity as the ledger's own
// reservation key (followupLedgerKey minus the channel; Codex #5189 r4): a
// step fires once per sequence — revival resumes at the step that had
// not yet fired — so a repeat of the key is a retry of the same touch.
function followupEventKey(row, step) {
  return `invoice-followup:${row.id}:${step.id}`;
}

async function currentStepLedgerIds(row, step, channels) {
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') return [];
  if (!channels.length) return [];
  const rows = await db('collections_contact_ledger')
    .where({ source: 'invoice_followups' })
    .whereIn('idempotency_key', channels.map((channel) => followupLedgerKey(row, step, channel)));
  return (rows || []).map((entry) => entry.id);
}

function terminalFollowupEmailRefusal(result) {
  if (result?.resolved === true) return true;
  return result?.ok === false && result.retryable !== true && result.deferred !== true
    && result.deliveryOutcome !== 'uncertain' && (
      ['billing_email_not_selected', 'missing_email', 'template_unavailable'].includes(result.reason)
      || (result.blocked === true && /^Suppressed: /.test(result.reason || ''))
    );
}

function followupEmailOutcomeUncertain(result, explicit) {
  return explicit && (result?.deliveryOutcome === 'uncertain'
    || (result?.error && result?.deliveryOutcome !== 'not_sent')
    || (result?.deduped && !result?.blocked));
}

// A dispute hold that landed after the preflight consult refused this leg at the provider boundary
// (the ONE retryable COLLECTION_HOLD_DEFER outcome). That is a WAIT: nothing reached the customer
// and nothing failed, so the reservation is released (no failed row, no spent attempt) and the touch
// stays due (see the held-touch retime in fireTouch); it goes out after the release.
function heldByDisputeHold(result) {
  return require('./collections/collection-hold').isHoldSuppression(result);
}

async function settleFollowupEmailLedger(ContactLedger, ledger, result, explicit, originalDeliveryTimes) {
  if (heldByDisputeHold(result)) {
    await ContactLedger.releaseHeldReservation(ledger);
    return true;
  }
  if (result?.ok === true) {
    const originalContact = originalBillingContactArgs(result);
    originalDeliveryTimes.push(...originalContact.map((stamp) => stamp.occurredAt));
    return (explicit || originalContact.length > 0) && typeof ContactLedger.markDelivered === 'function'
      && !await ContactLedger.markDelivered(ledger, ...originalContact);
  }
  if (followupEmailOutcomeUncertain(result, explicit)) return true;
  // A retryable refusal before the provider never reached the customer. An
  // explicit selection's keyed reservation is left out of its own step's
  // collections consult (currentStepLedgerIds); a no-choice attempt's
  // unkeyed row is not, so it is stamped never_contacted (the pre-send
  // doctrine, outbound-voice/origination.js), retried once, or the 24-hour
  // window would refuse the retry the step is held for until the next day.
  const neverContacted = !explicit && result?.retryable === true && result.deliveryOutcome === 'not_sent';
  const stamp = {
    reason: result?.reason || result?.error || 'email_not_sent',
    ...(explicit && terminalFollowupEmailRefusal(result)
      ? { resolved: true, resolution: 'email_terminal_refusal' } : {}),
    ...(neverContacted ? { never_contacted: true } : {}),
  };
  const stamped = await ContactLedger.markSendFailed(ledger, stamp);
  if (!stamped && neverContacted) await ContactLedger.markSendFailed(ledger, stamp);
  return false;
}

/**
 * Load the SMS body from the editable sms_templates table. Returns null if the
 * template row is missing or disabled — caller pauses the sequence in that case.
 */
async function resolveBody(step, ctx) {
  if (!step.template_key || typeof smsTemplatesRouter.getTemplate !== 'function') return null;
  return smsTemplatesRouter.getTemplate(step.template_key, {
    first_name: ctx.name || 'there',
    invoice_title: ctx.invoiceTitle || 'your service',
    amount: ctx.amount || '0.00',
    pay_url: ctx.payUrl || '',
    receipt_url: ctx.payUrl || '',
    service_date: ctx.serviceDate || '',
    service_date_clause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
  }, {
    workflow: 'invoice_followup',
    entity_type: 'invoice',
    entity_id: ctx.invoiceId || null,
  });
}

// ── The Intelligence Bar's send-now approval (card pin) ──────────────────────
// The card shows the reminder text with the pay link as a token and the recipients as masked values; the service pins the
// phone, the email recipient and the text's digest and refuses at dispatch (right after the claim, before either leg) when
// any of them differs from what is live.
const APPROVAL_PAY_LINK_TOKEN = '[pay link]';

// The base wording of the step's text (no alternate wordings, no audit row), the pay link as a token: what the card shows.
async function renderApprovalSmsBody(step, ctx) {
  if (!step.template_key || typeof smsTemplatesRouter.getTemplate !== 'function') return null;
  return smsTemplatesRouter.getTemplate(step.template_key, {
    first_name: ctx.name || 'there',
    invoice_title: ctx.invoiceTitle || 'your service',
    amount: ctx.amount || '0.00',
    pay_url: APPROVAL_PAY_LINK_TOKEN,
    receipt_url: APPROVAL_PAY_LINK_TOKEN,
    service_date: ctx.serviceDate || '',
    service_date_clause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
  }, { workflow: 'invoice_followup', entity_type: 'invoice', entity_id: ctx.invoiceId || null }, { noVariants: true, audit: false });
}

// What the bar's card approved for ONE send-now, as the send must honor it (a page send carries no approval: null).
// channels: only a channel on the card goes out. smsBody: the exact approved text (the pay link as a token), sent as it is:
// the send never re-resolves the template, so alternate wordings or an edit cannot change it. emailContentHash: the whole
// email, enforced again at the email send. An approval that names a channel without its text or hash is invalid (fail closed).
function approvedSendPlan(approved) {
  if (!approved) return null;
  const sms = approved.channels?.sms === true;
  const email = approved.channels?.email === true;
  const body = typeof approved.smsBody === 'string' ? approved.smsBody : null;
  const smsValid = !sms || Boolean(body && body.includes(APPROVAL_PAY_LINK_TOKEN) && approvalDigest(body) === approved.smsDigest);
  const emailValid = !email || (typeof approved.emailContentHash === 'string' && approved.emailContentHash.length > 0
    && typeof approved.emailRenderedDigest === 'string' && approved.emailRenderedDigest.length > 0);
  const dueValid = Number.isInteger(approved.dueCents) && approved.dueCents > 0;
  return { sms, email, body, emailContentHash: email ? approved.emailContentHash : null, emailRenderedDigest: email ? approved.emailRenderedDigest : null, valid: (sms || email) && smsValid && emailValid && dueValid };
}

// Why the live recipients differ from the card's pin, or null.
async function approvalDrift(approved, customer) {
  if (approvalDigest(phoneKey(customer.phone)) !== approved.phoneDigest) return 'recipient_changed';
  const { to } = await operatorEmailRecipient(customer, 'invoice-followups');
  return approvalDigest(emailKey(to)) === approved.emailDigest ? null : 'recipient_changed';
}

async function logFollowupEmailAttempt({
  customerId,
  invoiceId,
  stepId,
  templateKey,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
}) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `Invoice follow-up email ${status}`,
      body: failureReason
        ? `Invoice follow-up ${stepId} email ${status}: ${failureReason}`
        : `Invoice follow-up ${stepId} email ${status}.`,
      metadata: JSON.stringify({
        invoice_id: invoiceId,
        step_id: stepId,
        template_key: templateKey,
        channel: 'email',
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[invoice-followups] email audit log failed for invoice ${invoiceId}: ${err.message}`);
  }
}

// The reminder email's merge values, built one way for the Intelligence Bar's card and for the send, so the card's rendered
// subject and body are exactly what the send renders (the pay link is the only value that differs: a token on the card).
function followupEmailPayload({ recipient, customer, invoice, invoiceTitle, invoiceNumber, serviceDateClause, payUrl }) {
  return {
    first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
    invoice_title: invoiceTitle,
    invoice_number: invoiceNumber,
    amount_due: currency(invoiceAmountDue(invoice)),
    due_date: formatDateOnly(invoice.due_date, { fallback: '' }),
    service_date: formatDateOnly(invoice.service_date, { fallback: '' }),
    service_date_clause: serviceDateClause,
    pay_url: payUrl,
    customer_portal_url: `${publicPortalUrl()}/?tab=billing`,
  };
}

// The rendered email for a payload: subject, plain text, the template content hash and one digest over all of them (what the
// card pins). Null when the template is not set up.
async function renderedEmailFingerprint(templateKey, payload) {
  const Library = require('./email-template-library');
  const loaded = await Library.loadTemplateByKey(templateKey);
  if (!loaded?.template || !loaded.activeVersion) return null;
  const rendered = Library.renderTemplate({ template: loaded.template, version: loaded.activeVersion, payload });
  const subject = String(rendered.subject || '').replace(/\s+/g, ' ').trim();
  const text = String(rendered.text || '').trim();
  const contentHash = Library.templateContentHash(loaded.template, loaded.activeVersion);
  return { subject, text, contentHash, digest: approvalDigest([templateKey, subject, text, contentHash]) };
}

// The send's own rendering against the card's digest (the pay link as the card's token): a changed greeting, amount or wording
// since the card was shown refuses the leg before anything is sent.
async function emailDriftRefusal(templateKey, payload, expectedEmailDigest) {
  if (!expectedEmailDigest) return null;
  const live = await renderedEmailFingerprint(templateKey, { ...payload, pay_url: APPROVAL_PAY_LINK_TOKEN }).catch(() => null);
  return live && live.digest === expectedEmailDigest ? null : { ok: false, skipped: true, reason: 'email_content_changed' };
}

// The email leg's own fresh read of the invoice (local audit on r42): the pre-dispatch guard added for the text protects only
// that leg, and a payer assigned since the batch would still email the homeowner a payment demand for AP-owned debt.
async function followupEmailInvoice(invoiceId) {
  const invoice = await db('invoices').where({ id: invoiceId }).first().catch(() => null);
  if (!invoice || isTerminalInvoice(invoice)) return { refusal: { ok: false, skipped: true, reason: 'invoice_not_eligible' } };
  if (invoice.payer_id || invoiceWithdrawnFromCustomer(invoice)) return { refusal: { ok: false, skipped: true, reason: 'invoice_payer_billed' } };
  return { invoice };
}

// Who this email may go to. The customer's billing choices, recipient and invoice ownership come from the shared billing email
// authority (owner ruling 2026-09-27), read here and again under its locks at the provider handoff. An operator's explicit send
// skips the customer's choices, as before, and rechecks ownership only. The bar's approved address (its digest) is checked
// against the address resolved HERE, the one the email goes to.
async function followupEmailRecipient({ authorityInput, customer, enforceBillingPreference, expectedRecipientDigest }) {
  const resolved = enforceBillingPreference
    ? await billingEmailRecipient(authorityInput, 'invoice-followups')
    : await operatorEmailRecipient(customer, 'invoice-followups');
  if (resolved.refusal) return resolved;
  if (expectedRecipientDigest && approvalDigest(emailKey(resolved.to)) !== expectedRecipientDigest) {
    return { refusal: { ok: false, skipped: true, reason: 'email_recipient_changed' } };
  }
  return resolved;
}

// The touch's merge values on the invoice's fresh row (the touch's own title and service date win when it carries them).
function followupEmailPayloadForTouch({ recipient, customer, invoice, row, ctx }) {
  return followupEmailPayload({
    recipient, customer, invoice,
    invoiceTitle: ctx.invoiceTitle || invoice.title || invoice.service_type || 'your service',
    invoiceNumber: invoice.invoice_number || row.invoice_number || '',
    serviceDateClause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
    payUrl: ctx.payUrl,
  });
}

// The provider handoff: the billing email authority for an automated touch, the self-pay check for an operator's send. An
// operator's "send now" email (no billing-preference enforcement) keeps the dispute-hold exemption if the provider-retry rail
// later re-sends its stored copy.
function followupEmailDispatchOptions({ enforceBillingPreference, honorDisputeHold, authorityInput, to, templateKey, state, row, customer }) {
  if (enforceBillingPreference) {
    return {
      categories: [],
      withProviderHandoff: (dispatch) => dispatchUnderBillingEmailAuthority({
        input: authorityInput, recipientEmail: to, templateKey, dispatch, state,
      }),
    };
  }
  return {
    categories: honorDisputeHold ? [] : [require('./collections/collection-hold').OPERATOR_INITIATED_EMAIL_CATEGORY],
    withProviderHandoff: selfPayOnlyHandoff(row.invoice_id, state, { holdCustomerId: customer.id, ignoreDisputeHold: !honorDisputeHold }),
  };
}

// expectedContentHash (the Intelligence Bar's send-now card only): the email template content hash the card showed
// (email-template-library templateContentHash: subject, preview, every block, text body, wrapper, sender). sendTemplate refuses
// a different one before anything is sent.
// expectedRecipientDigest (the bar's card only): the approved address's digest, checked against the address resolved HERE, the one
// the email goes to. approvalDrift checked it earlier on its own read; a billing email changed between the two reads sends nothing.
async function sendFollowupEmail({ row, customer, step, ctx, enforceBillingPreference = true, expectedContentHash = null, expectedEmailDigest = null, expectedRecipientDigest = null, honorDisputeHold = false }) {
  const templateKey = FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!templateKey) return { ok: false, skipped: true, reason: 'no_email_template_mapping' };

  const { invoice: latestInvoice, refusal: invoiceRefusal } = await followupEmailInvoice(row.invoice_id);
  if (invoiceRefusal) return invoiceRefusal;

  const authorityInput = {
    customerId: customer.id, invoiceId: row.invoice_id, channel: 'email',
    metadata: { billingDeliveryCategory: 'invoice' },
  };
  const { recipient, to, refusal } = await followupEmailRecipient({ authorityInput, customer, enforceBillingPreference, expectedRecipientDigest });
  if (refusal) return refusal;

  const payload = followupEmailPayloadForTouch({ recipient, customer, invoice: latestInvoice, row, ctx });
  const drifted = await emailDriftRefusal(templateKey, payload, expectedEmailDigest);
  if (drifted) return drifted;

  const log = (fields) => logFollowupEmailAttempt({
    customerId: customer.id, invoiceId: row.invoice_id, stepId: step.id, templateKey, ...fields,
  });
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  const { categories, withProviderHandoff } = followupEmailDispatchOptions({
    enforceBillingPreference, honorDisputeHold, authorityInput, to, templateKey, state, row, customer,
  });
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      ...(expectedContentHash ? { expectedContentHash } : {}),
      to,
      payload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `invoice_followup:${row.invoice_id}:${step.id}`,
      idempotencyKey: `invoice_followup_email:${row.invoice_id}:${step.id}`,
      categories: ['invoice_followup', step.id, ...categories],
      suppressionGroupKey: 'transactional_required',
      withProviderHandoff,
    });
    return await billingEmailSendOutcome(result, state, log);
  } catch (err) {
    // The card's pinned email content changed: refused before the provider, nothing sent on this leg.
    if (expectedContentHash && /reviewed email content changed/i.test(err?.message || '')) {
      return { ok: false, skipped: true, reason: 'email_content_changed' };
    }
    return billingEmailSendFailure(err, state.handoffStarted, log, {
      logTag: 'invoice-followups', label: `${step.id} for invoice ${row.invoice_id}`,
    });
  }
}


/**
 * Compute the timestamp at which step `index` should fire for a given invoice.
 * Returns null if `index` is beyond the configured steps. Anchored to when the
 * invoice was sent (so "3-day friendly nudge" = 3 days after send), lands at
 * 10:00 AM America/New_York regardless of server timezone or DST.
 */
// GATE_DUNNING_LADDER_90, read at call time (strict 'true'): the ladder runs
// Day 3/10/17/30/60/90 (config.stepsThrough90) and owns its invoice to the
// end. Off: the legacy Day 3/7/14/30 cadence, byte-identical.
function ladderThrough90Live() {
  return process.env.GATE_DUNNING_LADDER_90 === 'true';
}

function followupSteps() {
  return ladderThrough90Live() ? config.stepsThrough90 : config.steps;
}

// The at-risk pipeline_stage stamp for 60/90-day debt: called from this
// ladder's Day 60/90 steps. The
// caller has already confirmed the tier and a delivery. Only an active
// customer in a live customer stage (or NULL, a legacy row) moves:
// fireTouch excludes only deleted customers, so a churned/past/dormant
// customer, a lead or a lost record must be protected here.
async function markAtRiskForLongOverdue(customerId, database = db) {
  const { CUSTOMER_STAGES } = require('./customer-stages');
  await database('customers').where({ id: customerId })
    .where('active', true)
    // Only a live customer stage (or NULL, a legacy row) moves to at_risk:
    // a lead or lost record must not become a customer here, bypassing the
    // lifecycle stamps a real stage change applies (Codex #5294 r1 P1), and
    // a churned/past/dormant customer keeps its stage.
    .where(function () {
      this.whereNull('pipeline_stage').orWhereIn('pipeline_stage', CUSTOMER_STAGES);
    })
    .update({
      pipeline_stage: 'at_risk',
      pipeline_stage_changed_at: new Date(),
    });
}

function sequenceAnchor(row) {
  return row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at || row.created_at;
}

// The due time of a step on one specific cadence (legacy or Day 90 ladder),
// whatever the gate says: the switch needs both to tell which cadence
// scheduled a stored touch.
function cadenceTouchAt(steps, anchorDate, stepIndex) {
  const step = steps[stepIndex];
  if (!step) return null;
  return anchorTo10amNY(new Date(anchorDate), step.daysAfterSend, config.sendWindow.hour);
}

// Gate off after the Day 90 ladder scheduled a touch: a stored time that is
// exactly the ladder's Day 10 or Day 17 goes back to the legacy Day 7 or
// Day 14, unless that day already passed its send window, in which case the
// ladder's later day stands so the touch is not lost (codex #5126 r2).
function legacyTouchFor(row, now = new Date()) {
  const index = Number(row.step_index);
  if (!row.next_touch_at || config.steps[index]?.daysAfterSend === config.stepsThrough90[index]?.daysAfterSend) return null;
  const anchor = sequenceAnchor(row);
  const ladderAt = cadenceTouchAt(config.stepsThrough90, anchor, index);
  const legacyAt = cadenceTouchAt(config.steps, anchor, index);
  if (!ladderAt || !legacyAt || ladderAt.getTime() !== new Date(row.next_touch_at).getTime()) return null;
  return isStaleTouch(legacyAt, now) ? null : legacyAt;
}

// `steps` (default: the live ladder) lets a caller that carries an APPROVED cadence compute from it instead of today's gate.
function computeNextTouchAt(anchorDate, stepIndex, steps = followupSteps()) {
  const step = steps[stepIndex];
  if (!step) return null;
  return anchorTo10amNY(new Date(anchorDate), step.daysAfterSend, config.sendWindow.hour);
}

/**
 * Return a Date that represents {hour}:00 America/New_York on the calendar
 * day that is {daysAfter} days past {anchorDate} (measured in NY local time).
 * DST-safe — probes EDT/EST on the target day and picks the right UTC offset.
 */
function anchorTo10amNY(anchorDate, daysAfter, hour) {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(anchorDate).map((p) => [p.type, p.value])
  );
  // Advance calendar days in UTC math (safe across DST day-length quirks).
  const base = new Date(Date.UTC(+nyParts.year, +nyParts.month - 1, +nyParts.day));
  base.setUTCDate(base.getUTCDate() + daysAfter);
  const y = base.getUTCFullYear(), m = base.getUTCMonth(), d = base.getUTCDate();
  // Probe DST at noon UTC on the target day (always mid-afternoon NY, never ambiguous).
  const probe = new Date(Date.UTC(y, m, d, 12));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).format(probe).slice(-3); // "EDT" or "EST"
  const offsetHours = tzName === 'EDT' ? 4 : 5;
  return new Date(Date.UTC(y, m, d, hour + offsetHours));
}

// The re-arm decision for a void-stopped sequence, from one function for the scheduler and the Intelligence Bar's preview
// (voidStopRearmDecision, from voidStopRearmAnchor). `database` is the caller's handle (the scheduler's locked transaction, or
// the planner's read handle); `knownCustomer` saves a customer read when the caller already has the row.
async function rearmDecisionFor(database, invoice, existing, { knownCustomer = null, steps } = {}) {
  return voidStopRearmDecision(existing, {
    planActive: () => activePaymentPlan(database, invoice.id),
    holdForAutopay: async () => {
      if (!existing.is_autopay_held) return false;
      try {
        return await customerOnAutopay(knownCustomer || await database('customers').where({ id: invoice.customer_id }).first(), { db: database, failClosed: true });
      } catch (err) {
        logger.warn(`[invoice-followups] re-arm autopay re-check failed for invoice ${invoice.id} — keeping the hold: ${err.message}`);
        return true;
      }
    },
    anchor: voidStopRearmAnchor(existing, invoice),
    steps,
  });
}

// The row a re-arm decision writes over the system stop (paused goes back to paused; everything else to its decided status).
function rearmPatch(decision, now) {
  if (decision.kind === 'paused') return { updated_at: now, status: 'paused', stopped_reason: null, stopped_by_admin_id: null, next_touch_at: null };
  return {
    updated_at: now,
    status: decision.kind,
    is_autopay_held: decision.kind === 'autopay_hold',
    stopped_reason: null,
    stopped_by_admin_id: null,
    next_touch_at: decision.nextTouchAt,
  };
}

// A sequence row already exists (under the invoice lock). Only a SYSTEM void stop is lifted; an admin's own stop, pause or a
// completed row is never clobbered.
// Unvoid -> resend lifecycle re-arm (Codex #3493 r2): voidInvoice terminally stops the sequence with the SYSTEM stop
// 'invoice_voided' (no admin id). An unvoided invoice keeps that stop while it sits in draft (dunning must never fire against
// an unpublished draft), and the RESEND (which is what calls scheduleForInvoice, after the status flip out of draft) is the
// point where reminders become legitimate again. The UPDATE stays conditional on the exact system stop, so a concurrent admin
// pause/stop (which rewrites status/stopped_* under the same invoice lock) wins. An autopay-held row goes back to
// 'autopay_hold', not 'active' (activating it would dun an autopay customer); autopay standing is re-checked live. An
// exhausted cadence restores terminal 'completed' so the legacy late-payment checker owns the invoice again. The void stop over
// a PAUSED row carries the ':prev=paused' suffix so a metadata-less legacy pause survives the round-trip, and
// 'invoice_terminal_status:void' is the same system stop stamped by the 20260601000012 backfill migration (Codex #3493 r12 P0).
async function reconcileExistingSequence(trx, invoice, existing, steps) {
  if (!isSystemVoidStop(existing)) return existing;
  const voidStopStamp = String(existing.stopped_reason || '');
  // Every check is rearmDecisionFor's (shared with the Intelligence Bar's planner); this only writes the decision. Never
  // re-arm under an ACTIVE payment plan (Codex #3493 r6), restore a retained PAUSE rather than active dunning (r3/r8, and the
  // legacy migration stamp unconditionally, r14 P0), and hold an Auto Pay customer (r7 + r12: the retained held marker AND
  // live enrollment must agree; a read error keeps the hold, r16). The cadence anchors on when the invoice went out, NOT the
  // due date (r4); a shifted anchor_at wins. The write stays conditional on the exact system stop, so a racing admin
  // pause/stop wins.
  const decision = await rearmDecisionFor(trx, invoice, existing, { steps });
  if (decision.kind === 'payment_plan') return existing;
  const [written] = await trx('invoice_followup_sequences')
    .where({ id: existing.id, status: 'stopped', stopped_reason: voidStopStamp })
    .whereNull('stopped_by_admin_id')
    .update(rearmPatch(decision, trx.fn.now()))
    .returning('*');
  return written || existing;
}

// Orphan adoption leaves an invoice whose customer has unresolved ACH failures to a person. Takes the webhook's own
// per-customer lock first, so a failure logged before it is seen here and one still in flight waits for this row.
async function adoptionBlockedByAchFailures(trx, invoice) {
  // An invoice whose customer has unresolved ACH failures is left for a
  // person (Codex #5202 r1 P1): a fresh autopay hold would wait for
  // webhooks that may never come, and seeding the counter from
  // ach_failure_log double-counts a failure the webhook has logged but
  // not yet passed to handleAutopayFailure. Checked for EVERY adoption,
  // before autopay eligibility (Codex #5202 r2 P1): failures that
  // committed since selection can have already moved the customer off
  // autopay, which would otherwise arm an ACTIVE row. The webhook's own
  // per-customer lock (stripe-webhook.js 'ach.escalation') fences the
  // read: a failure logged before it is seen here; one still in flight
  // waits for this row to commit, and its handleAutopayFailure then
  // counts it against this row as usual.
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    ['ach.escalation', String(invoice.customer_id)],
  );
  if (!(await unresolvedAchFailureCount(invoice.customer_id, trx))) return false;
  logger.info(`[invoice-followups] adoption left invoice ${invoice.id} for a person: customer has unresolved ACH failures`);
  return true;
}

// What a NEW sequence row would be, or null when none should be armed: { stepIndex, nextTouchAt, onAutopay }.
async function newSequencePlanFor(trx, invoice, { adoption, steps }) {
  // Never arm dunning under an active payment plan (codex r7 P1). Plan
  // creation stops sequences inside its own invoice-locked transaction —
  // this check runs under the SAME lock, so whichever writer commits first
  // the invariant holds (plan first → we refuse here; we commit first → the
  // plan's stop catches the fresh row).
  if (await activePaymentPlan(trx, invoice.id)) return null;

  const customer = await trx('customers').where({ id: invoice.customer_id }).first();
  if (adoption && await adoptionBlockedByAchFailures(trx, invoice)) return null;
  // Adoption fails closed on an unreadable payment method (Codex #5202 r1
  // P1): the default swallows the read error as "not on autopay" and would
  // arm an ACTIVE row for an enrolled customer. The throw rolls this
  // transaction back, so no row exists and the next sweep retries.
  let onAutopay = !!await customerOnAutopay(customer, { db: trx, ...(adoption ? { failClosed: true } : {}) });
  // Auto Pay never collects a bill from a won Bill-by-invoice proposal (owner
  // 2026-10-30, bill-by-invoice.js), so no charge or failure would end its
  // hold: its reminders run. A failed read arms the reminders too (this
  // path's own posture for an unreadable Auto Pay read); adoption fails
  // closed and retries, like its method read.
  if (onAutopay) {
    try {
      onAutopay = !await require('./bill-by-invoice').billByInvoiceInvoice(trx, invoice);
    } catch (err) {
      if (adoption) throw err;
      onAutopay = false;
      logger.warn(`[invoice-followups] Bill-by-invoice check failed for invoice ${invoice.id} — reminders armed: ${err.message}`);
    }
  }

  // Where the cadence starts (newSequenceAnchor). A failed read arms nothing: a guessed send-day start would text
  // "past due" before a Net-terms due date. Adoption throws and retries; the direct send leaves the invoice to the
  // orphan adoption sweep, which arms it from a good read.
  let start;
  try {
    start = await newSequenceAnchor(trx, invoice);
  } catch (err) {
    if (adoption) throw err;
    logger.warn(`[invoice-followups] reminder start read failed for invoice ${invoice.id}, left for adoption: ${err.message}`);
    return null;
  }
  const anchorAt = start.anchor;
  // Adoption lands the row on its first step whose send day has not
  // passed, already re-dated past this run, in this same insert (Codex
  // #5202 r1 P2: a separate deferral write could fail after the stale
  // skip and leave the first reminder to be passed over next run).
  const landing = adoption ? adoptionLanding(anchorAt, new Date()) : { stepIndex: 0, nextAt: computeNextTouchAt(anchorAt, 0, steps) };
  if (!landing) {
    logger.info(`[invoice-followups] adoption left invoice ${invoice.id} for a person: every ladder step has passed`);
    return null;
  }
  return { stepIndex: landing.stepIndex, nextTouchAt: landing.nextAt, onAutopay, anchorAt: start.anchorAt };
}

// Where a NEW sequence's cadence starts. Normally when the invoice went out: sent_at, then sms_sent_at, then created_at
// (manual-only, email-only and older rows still schedule). A bill from a won commercial proposal that is due after the
// day it went out (Net terms, proposal-win.js proposalTermsDueDate) starts on its due date instead (owner 2026-11-01):
// it is not past due before then, and every step after the first says how many days past due it is. That start is
// returned as `anchorAt` for the row's anchor_at, so later steps, a void re-arm (voidStopRearmAnchor) and the customer
// schedule (sequenceAnchor) keep it. Throws when the proposal read fails.
async function newSequenceAnchor(conn, invoice) {
  const sentAnchor = invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
  const dueDay = invoice.due_date ? etCalendarDayOf(invoice.due_date) : null;
  if (!dueDay || !sentAnchor || dueDay <= etDateString(new Date(sentAnchor))) return { anchor: sentAnchor, anchorAt: null };
  if (!await require('./bill-by-invoice').wonProposalInvoice(conn, invoice)) return { anchor: sentAnchor, anchorAt: null };
  // Noon UTC is morning in New York, so the steps count from the due date's own calendar day (anchorTo10amNY).
  const anchorAt = new Date(`${dueDay}T12:00:00Z`);
  return { anchor: anchorAt, anchorAt };
}

async function insertSequence(trx, invoice, plan) {
  const [row] = await trx('invoice_followup_sequences').insert({
    invoice_id: invoice.id,
    customer_id: invoice.customer_id,
    status: plan.onAutopay ? 'autopay_hold' : 'active',
    step_index: plan.stepIndex,
    next_touch_at: plan.onAutopay ? null : plan.nextTouchAt,
    is_autopay_held: plan.onAutopay,
    ...(plan.anchorAt ? { anchor_at: plan.anchorAt } : {}),
  }).returning('*');
  return row;
}

// The ladder a CARRIED cadence (an array of days after the send) stands for: the Intelligence Bar pins the cadence its card showed
// and hands it through the send, so a GATE_DUNNING_LADDER_90 flip between the claim and this call cannot change the schedule it
// approved. Null/empty = today's live ladder (every other caller).
function stepsForCadence(approvedCadence) {
  return Array.isArray(approvedCadence) && approvedCadence.length ? approvedCadence.map((daysAfterSend) => ({ daysAfterSend })) : followupSteps();
}

/**
 * Create (or re-hydrate) a sequence row for a newly-issued invoice.
 * Call this from the invoice-send flow.
 */
async function scheduleForInvoice(invoiceId, { adoption = false, approvedCadence = null } = {}) {
  const steps = stepsForCadence(approvedCadence);
  // Cheap unlocked pre-checks: a missing / non-schedulable / payer-billed
  // invoice never arms a sequence, and none of those verdicts can be flipped
  // by an ownership change (a merge moves customer_id, not status or payer).
  // Re-verified
  // under the lock below, so a status change racing this read is caught there.
  const preview = await db('invoices').where({ id: invoiceId }).first();
  if (!preview) return null;
  // Third-party Bill-To: the follow-up/dunning sequence emails and texts the
  // homeowner with the pay link, but a payer-billed invoice's AR rolls to the
  // payer's AP inbox — never chase the homeowner for it. Phase 1 has no payer
  // dunning sequence, so we simply don't arm follow-ups for payer invoices.
  // The withdrawal stamp is the same signal in the other direction (Codex
  // #4311 r31 P1): a combined-visit invoice whose Bill-To moved AFTER the
  // homeowner already held its pay link keeps `payer_id` NULL and a
  // collectible status, so a payer_id-only guard would arm dunning that
  // chases the homeowner for debt the payer now owes.
  if (followupArmBlock(preview)) return null;

  // OWNERSHIP IS DERIVED UNDER THE INVOICE LOCK (r19 P1).
  //
  // customer_id used to be captured from the pre-lock read above and then
  // carried through several awaits into the INSERT. Any writer that holds the
  // invoice's lock in between — a customer merge repointing invoices.customer_id
  // is the live one — commits while we wait, after which this insert resumes and
  // arms a sequence owned by the PREVIOUS customer for an invoice that has since
  // moved. The FK is on invoice_id, so nothing rejects it, and the next cron
  // touch duns the wrong customer with the invoice's bearer /pay/:token.
  //
  // The invoice row is the serialization point the whole invoice family already
  // shares (fireStep's claim, InvoiceService.update, stripe-webhook's
  // succeeded-PI handler). Taking it here and deriving customer_id from the
  // POST-lock row is the same settlement-ownership pattern those callers
  // document: we always arm against whoever owns the invoice once the lock is
  // ours. Never a pre-lock copy.
  //
  // Everything under the lock is DB work on this connection (customerOnAutopay
  // takes the trx), so the lock is never held across external I/O.
  return db.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return null;
    // Re-verify post-lock: an edit or payment that committed while we waited
    // can have made this invoice non-schedulable or payer-billed.
    if (followupArmBlock(invoice)) return null;

    // Existing-row check moved under the lock too: it and the INSERT must be
    // one atomic decision, or two concurrent arms race the unique(invoice_id).
    const existing = await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
    // Orphan adoption only arms an invoice that has NO row: one that gained
    // a row since the sweep selected it belongs to whoever armed it.
    if (existing) return adoption ? null : reconcileExistingSequence(trx, invoice, existing, steps);
    const plan = await newSequencePlanFor(trx, invoice, { adoption, steps });
    return plan ? insertSequence(trx, invoice, plan) : null;
  });
}

// What scheduleForInvoice would do for this invoice row once the send lands, read-only (the
// Intelligence Bar's effects plan shows it on the send card). It applies scheduleForInvoice's own
// predicates: followupArmBlock, an existing row (and the void re-arm), activePaymentPlan, the new row's
// start (newSequenceAnchor: `startsOn` is the due date a Net-terms bill counts its steps from), and
// customerOnAutopay for the Auto Pay hold. state is one of: active, autopay_hold, payment_plan,
// not_schedulable, payer_billed, rearm, existing:<status>, start_unreadable, autopay_unreadable, no_invoice.
async function planFollowupSequence(invoice, database = db, knownCustomer = null) {
  const cadence = followupSteps().map((step) => step.daysAfterSend);
  const block = invoice ? followupArmBlock(invoice) : 'no_invoice';
  if (block) return { arms: false, state: block, cadence };
  const existing = await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first();
  if (existing) {
    if (!isSystemVoidStop(existing)) return { arms: false, state: `existing:${existing.status}`, cadence };
    // The same decision scheduleForInvoice makes for a void-stopped sequence (rearmDecisionFor, from voidStopRearmAnchor).
    const decision = await rearmDecisionFor(database, invoice, existing, { knownCustomer });
    const REARM_STATE = { payment_plan: 'payment_plan', paused: 'paused', autopay_hold: 'autopay_hold', active: 'rearm', completed: 'completed' };
    return { arms: ['active', 'autopay_hold'].includes(decision.kind), state: REARM_STATE[decision.kind], cadence, nextTouchAt: decision.nextTouchAt || null };
  }
  if (await activePaymentPlan(database, invoice.id)) return { arms: false, state: 'payment_plan', cadence };
  // The send arms nothing on an unreadable start (newSequencePlanFor): the orphan adoption sweep arms it later.
  let start;
  try {
    start = await newSequenceAnchor(database, invoice);
  } catch {
    return { arms: false, state: 'start_unreadable', cadence };
  }
  const startsOn = start.anchorAt ? etCalendarDayOf(start.anchorAt) : null;
  try {
    const customer = knownCustomer || await database('customers').where({ id: invoice.customer_id }).first();
    // The same Bill-by-invoice exception the new sequence takes (newSequencePlanFor).
    const onAutopay = await customerOnAutopay(customer, { db: database, failClosed: true })
      && !await require('./bill-by-invoice').billByInvoiceInvoice(database, invoice);
    return { arms: true, state: onAutopay ? 'autopay_hold' : 'active', cadence, ...(startsOn ? { startsOn } : {}) };
  } catch {
    return { arms: true, state: 'autopay_unreadable', cadence, ...(startsOn ? { startsOn } : {}) };
  }
}

// GATE_DUNNING_ADOPT_ORPHANS, read at call time (strict 'true'): an invoice
// sent outside the direct-send path (the only caller of scheduleForInvoice)
// never got a sequence row and was left to the legacy late-payment checker
// alone (deleted 2026-10-29). Off: byte-identical — runPending never looks
// for orphans.
function adoptOrphanInvoicesLive() {
  return process.env.GATE_DUNNING_ADOPT_ORPHANS === 'true';
}

/**
 * Where an adopted row lands (pure): the first step whose send day has not
 * passed — the same stale test runPending's skip-forward applies — dated no
 * earlier than the NEXT run, so a row is never sent in the run that adopted
 * it and never lands on a day already stale by the time it is picked up.
 * null = every step's day has passed (Fable #5202 P1): arming it would
 * stale-complete without a single reminder, so it is left for a person.
 * `fromIndex` starts the walk past steps a row already sent (the Auto Pay hold timeout).
 */
function adoptionLanding(anchorAt, now, fromIndex = 0) {
  let stepIndex = fromIndex;
  let nextAt = computeNextTouchAt(anchorAt, stepIndex);
  while (nextAt && isStaleTouch(nextAt, now)) {
    stepIndex += 1;
    nextAt = computeNextTouchAt(anchorAt, stepIndex);
  }
  if (!nextAt) return null;
  if (nextAt.getTime() <= now.getTime()) {
    nextAt = firstEligibleFireAt(anchorTo10amNY(now, 1, config.sendWindow.hour));
  }
  return { stepIndex, nextAt };
}

// The count stripe-webhook.js's ACH failure handler escalates on: unresolved
// failures in the last 90 days.
async function unresolvedAchFailureCount(customerId, database = db) {
  return Number((await database('ach_failure_log')
    .where({ customer_id: customerId, resolved: false })
    .where('failure_date', '>=', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
    .count('* as cnt')
    .first())?.cnt || 0);
}

// Candidate selection, shared by the dry run and the live sweep (which runs
// it under the retiring checker's cron lock, so every history read below
// sees whatever an in-flight checker run wrote).
async function selectAdoptionCandidates() {
  const rows = await db('invoices as i')
    .leftJoin('invoice_followup_sequences as s', 's.invoice_id', 'i.id')
    .join('customers as c', 'c.id', 'i.customer_id')
    .whereNull('s.id')
    // Delivered statuses ONLY — not "not draft/terminal", which also admits
    // 'scheduled'/'sending', an invoice queued for its FIRST send that has
    // not reached the customer.
    .whereIn('i.status', PUBLISHED_INVOICE_STATUSES)
    .whereNull('i.payer_id')
    .where(function withdrawnExcluded() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    .whereNull('c.deleted_at')
    // Same guard scheduleForInvoice applies under the invoice lock — filtered
    // here too so the dry-run candidate set matches what adoption would do.
    .whereNotExists(function noActivePlan() {
      this.select(1).from('payment_plans')
        .whereRaw('payment_plans.invoice_id = i.id')
        .andWhere('payment_plans.status', 'active');
    })
    .orderByRaw('COALESCE(i.sent_at, i.sms_sent_at, i.created_at) asc')
    .select(
      'i.id as invoice_id', 'i.invoice_number', 'i.customer_id', 'i.total', 'i.credit_applied', 'i.amount_paid',
      'i.sent_at', 'i.sms_sent_at', 'i.created_at',
    );

  const now = new Date();
  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    const candidate = {
      invoice_id: row.invoice_id,
      customer_id: row.customer_id,
      sent_at: row.sent_at || row.sms_sent_at || row.created_at,
      amount_due: invoiceAmountDue(row),
    };
    // amount due > 0 — the same "is there anything to collect" test the
    // legacy checker's own dunning decision is built on.
    if (!(candidate.amount_due > 0)) continue;
    const skip = (reason) => skipped.push({ invoice_id: candidate.invoice_id, customer_id: candidate.customer_id, reason });
    // Same rule as the reopened-invoice revival: an invoice the legacy
    // checker ever contacted carries state the ladder does not model, so the
    // sweep leaves it and the dry-run lists it for a person to settle.
    const history = await legacyCheckerContacted(candidate.invoice_id, row.invoice_number);
    if (history.unavailable || history.contacted) {
      skip(history.unavailable ? 'legacy_history_unreadable' : 'has_legacy_history');
      continue;
    }
    if (!adoptionLanding(candidate.sent_at, now)) { skip('past_final_step'); continue; }
    // Same rule scheduleForInvoice re-checks under the ACH lock.
    let achFailures;
    try {
      achFailures = await unresolvedAchFailureCount(candidate.customer_id);
    } catch (err) {
      logger.warn(`[invoice-followups] ACH history read failed for invoice ${candidate.invoice_id} — skipped this run: ${err.message}`);
      skip('ach_history_unreadable');
      continue;
    }
    if (achFailures) { skip('ach_failure_history'); continue; }
    candidates.push({
      ...candidate,
      days_since_sent: Math.floor((now.getTime() - new Date(candidate.sent_at).getTime()) / 86400000),
    });
  }
  return { candidates, skipped };
}

/**
 * Find delivered, open, homeowner-billed invoices with NO
 * invoice_followup_sequences row and no legacy checker history, and arm one
 * for each through scheduleForInvoice — the exact path a normal invoice send
 * takes, so every one of its guards (payer-billed, active payment plan,
 * autopay hold, ownership-under-lock) applies unchanged. Nothing is sent
 * here: scheduleForInvoice's adoption mode lands the row on its first step
 * whose day has not passed, dated no earlier than the next run, in the same
 * insert.
 *
 * `dryRun: true` writes nothing and returns the candidates plus the
 * skipped-with-reason list (the hand list for a person: has_legacy_history,
 * past_final_step, ach_failure_history); oldest-sent-first either way, same
 * selection as the live sweep.
 *
 * The live sweep runs under the 'late-payment-check' cron lock (the retired
 * checker's old lock, kept so two pods never sweep at once). If that lock is
 * held, the sweep is refused for this run.
 */
async function adoptOrphanInvoices({ dryRun = false } = {}) {
  if (dryRun) return selectAdoptionCandidates();

  const { runExclusive } = require('../utils/cron-lock');
  const locked = await runExclusive('late-payment-check', async () => {
    const { candidates, skipped } = await selectAdoptionCandidates();
    const adoptedIds = [];
    for (const candidate of candidates) {
      try {
        const armed = await scheduleForInvoice(candidate.invoice_id, { adoption: true });
        if (armed) adoptedIds.push(candidate.invoice_id);
      } catch (err) {
        // One candidate's failure must never abort the whole sweep — the
        // transaction rolled back, and the next run re-selects it fresh.
        logger.error(`[invoice-followups] adoption failed for invoice ${candidate.invoice_id}: ${err.message}`);
      }
    }
    return { adopted: adoptedIds.length, invoiceIds: adoptedIds, skipped };
  }, { recordHealth: false, waitForSlot: false });
  // runExclusive's own refusal is { skipped: true, reason }; the body's
  // result carries a skipped ARRAY, which is truthy even when empty.
  if (locked?.skipped === true) {
    logger.warn(`[invoice-followups] adoption refused this run: the late-payment-check lock is held (${locked.reason})`);
    return { adopted: 0, invoiceIds: [], skipped: [], refused: 'checker_lock_held' };
  }
  const leftForAPerson = locked.skipped.filter((s) => s.reason !== 'legacy_history_unreadable' && s.reason !== 'ach_history_unreadable').length;
  if (leftForAPerson) {
    logger.info(`[invoice-followups] adoption left ${leftForAPerson} invoice(s) for a person to settle (see the dry-run script)`);
  }
  if (locked.adopted) {
    logger.info(`[invoice-followups] adopted ${locked.adopted} orphan invoice(s): ${locked.invoiceIds.join(', ')}`);
  }
  return locked;
}

/**
 * Cron entry point — fires all due touches.
 */
async function runPending() {
  const now = new Date();

  // Only run during configured window (double-guard; cron also enforces this)
  const dow = now.getDay();
  if (!config.sendWindow.daysOfWeek.includes(dow)) {
    logger.info('[invoice-followups] outside send window (day); skipping');
    return { sent: 0, skipped: 0 };
  }

  const ladder = ladderThrough90Live();
  if (ladder) await reviveLegacyFinishedSequences();
  await reviveReopenedLowStepSequences();
  // Adoption runs BEFORE the batch select; an adopted row is always dated
  // after this run, so the batch never picks it up today.
  // A sweep failure never costs the day's due touches (Codex #5202 r2 P1): a
  // touch missed at this tick is past its stale grace by the next one.
  if (adoptOrphanInvoicesLive()) {
    try {
      await adoptOrphanInvoices();
    } catch (err) {
      logger.error(`[invoice-followups] orphan adoption sweep failed — due touches still run: ${err.message}`);
    }
  }

  // Customer-level overdue reminders (dunning consolidation §4): the kill
  // switch releases every schedule that is dark BEFORE the batch below reads
  // its members, then (live gate only) promotion takes customers with 2+
  // active sequences onto one schedule. Neither ever sends in this run.
  await prepareCustomerSchedules(now);

  // No deleted-customer filter here: fireStep() pauses those sequences
  // (status='paused', next_touch_at=null) so they're handled terminally
  // rather than staying armed and past-due until a restore fires a
  // stale collection touch.
  const rows = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.status', 'active')
    .where(function dueNowOrLadderScheduled() {
      this.where('s.next_touch_at', '<=', now);
      // Gate off after the Day 90 ladder scheduled a Day 10/17 touch (codex
      // #5126 r2): pick it up while its earlier legacy day is due, so
      // turning the ladder off restores the legacy reminder instead of
      // holding the invoice, and the late-payment checker, until the
      // ladder's day. The loop below leaves every other early row alone.
      if (!ladder && LADDER_MOVED_STEPS.length) {
        this.orWhere(function ladderScheduledTouch() {
          this.where('s.step_index', '>=', Math.min(...LADDER_MOVED_STEPS))
            .where('s.step_index', '<=', Math.max(...LADDER_MOVED_STEPS))
            .where('s.next_touch_at', '<=', new Date(now.getTime() + LADDER_MAX_SHIFT_MS));
        });
      }
    })
    .whereNotIn('i.status', TERMINAL_INVOICE_STATUSES)
    // Third-party Bill-To: never dun a payer-billed invoice through this
    // homeowner sequence — fireStep would text the payer's bearer /pay/:token to
    // row.customer_id (the service recipient). scheduleForInvoice already refuses
    // to arm these, but an active row can pre-date the payer (backfill run after
    // payer invoices issued, or an older/manual sequence); exclude them here and
    // guard fireStep too.
    .whereNull('i.payer_id')
    // …and the withdrawal stamp, which records exactly the same ownership
    // move on a row whose payer_id stays NULL (Codex #4311 r31 P1).
    .where(function withdrawnExcluded() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    // A customer on an open customer_dunning_schedules row: the schedule owns
    // the cadence and these rows are membership state, never fired here —
    // except an invoice waiting on bank micro-deposit verification, which the
    // schedule's set excludes (balance-set.js) and so never reminds: its own
    // row keeps sending the verification nudge (the loop below decides, per
    // row, outside any lock). With no schedule rows this excludes nothing (pinned).
    .where(gates.divertMicrodepositDunning ? notOwnedOrMicrodepositCandidate : notOwnedByCustomerSchedule)
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied', 'i.amount_paid', 'i.status as invoice_status',
      'i.payer_id as invoice_payer_id', 'i.scheduled_send_error as invoice_send_error',
      'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
      'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at',
      'i.created_at as invoice_created_at',
    );

  const owners = await microdepositCandidateOwners(rows);
  let sent = 0, skipped = 0;
  for (const batchRow of rows) {
    let row = batchRow;
    try {
      // A row of a customer on a combined schedule is in the batch only as a
      // possible micro-deposit nudge: unless its invoice is waiting on that
      // verification right now, it is the schedule's and is left untouched
      // (no retime, no stale skip, no claim, not counted).
      if (owners.has(String(row.customer_id))) {
        if (!(await awaitingMicrodepositVerification(row))) continue;
        row = { ...row, owned_microdeposit: true };
      }
      // A legacy-cadence touch moved to its Day 90 ladder day is processed
      // on that new day in this same run when the new day is today (pre-push
      // audit P1): skipping it would let the next tick find it past its
      // stale grace and pass it over.
      const retimed = ladder ? await deferToLadderDay(row) : await restoreLegacyDay(row, now);
      if (retimed === EARLY_ROW) continue;
      if (retimed) {
        if (!retimed.moved || retimed.due.getTime() > now.getTime()) { skipped++; continue; }
        row = { ...row, next_touch_at: retimed.due };
      }
      if (row.next_touch_at && isStaleTouch(row.next_touch_at, now)) {
        const skip = await skipStaleTouches(row, now);
        skipped++;
        // The landing step can itself be due THIS run (a step went stale over
        // a weekend and the next one anchors to today) — fire it now, or the
        // next tick would find it past ITS eligible day and stale-skip it too
        // (Codex r1 P2). fireStep revalidates against the just-persisted
        // step/due under the invoice lock, so a concurrent change no-ops.
        if (skip.updated && skip.nextAt
            && skip.nextAt.getTime() <= now.getTime()
            && !isStaleTouch(skip.nextAt, now)) {
          sent += await fireCounted({ ...row, step_index: skip.nextIndex, next_touch_at: skip.nextAt });
        }
        continue;
      }
      const fired = await fireCounted(row);
      sent += fired;
      skipped += 1 - fired;
    } catch (err) {
      logger.error(`[invoice-followups] step fire failed for invoice ${row.invoice_id}: ${err.message}`);
      skipped++;
    }
  }
  await runCustomerScheduleEngine(now);
  logger.info(`[invoice-followups] runPending: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

// One batch row through fireStep, counted the way runPending always has (1 =
// sent), except a row fireStep refused because its customer is on an open
// customer-level schedule (0): nothing was claimed or sent.
async function fireCounted(row) {
  const out = await fireStep(row, { ownedMicrodeposit: row.owned_microdeposit === true });
  return out && out.ownedBy ? 0 : 1;
}

// ── micro-deposit verification nudges on a combined schedule ─────────────
//
// The customer-level set excludes an invoice whose PaymentIntent waits on the
// customer's two bank micro-deposits (balance-set.js, `excluded.md`): the
// combined reminder never names or nudges it. That invoice's OWN row stays its
// one sender (Codex local review P1: owning every row of the customer left
// these verification nudges with no sender at all), on its own cadence, through
// fireTouch's existing verification copy, contact policy and spacing. Who owns
// an invoice is decided by the same live Stripe signal both sides read (the
// engine at its resolve, this path at the touch): waiting on verification ->
// this row, otherwise the schedule. No Stripe call ever runs under a lock: the
// batch pre-check below runs before the fence, and fireTouch re-checks after
// the claim committed and sends NOTHING unless the invoice is still waiting.

function notOwnedOrMicrodepositCandidate() {
  this.whereRaw(`(NOT EXISTS (SELECT 1 FROM customer_dunning_schedules c WHERE c.customer_id = s.customer_id AND c.status IN (${
    CustomerDunningKeys.OPEN_STATUSES.map(() => '?').join(', ')})) OR i.stripe_payment_intent_id IS NOT NULL)`, CustomerDunningKeys.OPEN_STATUSES);
}

// The customers among the batch's PaymentIntent rows that are on an open
// schedule (one read; none when no row carries a PaymentIntent).
async function microdepositCandidateOwners(rows) {
  if (!gates.divertMicrodepositDunning) return new Set();
  const ids = [...new Set(rows.filter((r) => r.invoice_stripe_pi).map((r) => String(r.customer_id)))];
  if (!ids.length) return new Set();
  const owned = await db('customer_dunning_schedules').whereIn('customer_id', ids)
    .whereIn('status', CustomerDunningKeys.OPEN_STATUSES).select('customer_id');
  return new Set((owned || []).map((r) => String(r.customer_id)));
}

// Fail CLOSED for an owned row: an unreadable state reads as "not waiting", so
// the row stays the schedule's (which holds the whole set on the same
// unreadable state) and nothing is sent from either side.
const awaitingMicrodepositVerification = (row) => gates.divertMicrodepositDunning && !!row.invoice_stripe_pi
  && StripeService.isInvoiceAwaitingMicrodepositVerification({ id: row.invoice_id, stripe_payment_intent_id: row.invoice_stripe_pi });

// ── customer-level overdue reminders (dunning consolidation) ─────────────
//
// Ownership is dynamic: an open customer_dunning_schedules row for the
// customer. The schedule engine (services/customer-dunning/) takes the
// customer's advisory key EXCLUSIVELY for promotion, its claim and every
// close/release; the per-invoice paths below take the SAME key SHARED, always
// BEFORE any invoice or sequence row lock (the engine's order: key -> schedule
// row -> invoice rows -> sequence rows), and re-read ownership under it. The
// key is a session-independent transaction lock, released at commit.

const OPEN_SCHEDULE_SQL = `SELECT id FROM customer_dunning_schedules WHERE customer_id = ? AND status IN (${
  CustomerDunningKeys.OPEN_STATUSES.map(() => '?').join(', ')}) LIMIT 1`;

function notOwnedByCustomerSchedule() {
  this.whereRaw(`NOT EXISTS (SELECT 1 FROM customer_dunning_schedules c WHERE c.customer_id = s.customer_id AND c.status IN (${
    CustomerDunningKeys.OPEN_STATUSES.map(() => '?').join(', ')}))`, CustomerDunningKeys.OPEN_STATUSES);
}

const lockCustomerDunningShared = (trx, customerId) => trx.raw(
  'SELECT pg_advisory_xact_lock_shared(hashtext(?))', [CustomerDunningKeys.lockKey(customerId)],
);

// Read AFTER the shared key is held, as its own statement: a promotion that
// committed while this transaction waited for the key is then visible (a
// READ COMMITTED statement snapshot is taken when the statement starts).
async function openCustomerScheduleId(trx, customerId) {
  const result = await trx.raw(OPEN_SCHEDULE_SQL, [customerId, ...CustomerDunningKeys.OPEN_STATUSES]);
  return result?.rows?.[0]?.id || null;
}

// The engine's gate readers. Absent only where a suite stubs feature-gates
// for the per-invoice engine alone; production always exports them.
function customerDunningGates() {
  const FeatureGates = require('../config/feature-gates');
  return typeof FeatureGates.dunningCustomerScheduleLive === 'function'
    && typeof FeatureGates.dunningCustomerScheduleShadowLive === 'function' ? FeatureGates : null;
}

// Before the batch: release whatever is dark (releaseIfDark logs and raises
// its own read / release failures to the office), then promote under the live
// gate. Promotion never sends in its own run (seed.js). Neither can cost the
// run its per-invoice touches: an owned row stays out of the batch either way.
async function prepareCustomerSchedules(now) {
  const gatesModule = customerDunningGates();
  if (!gatesModule) return;
  try {
    await require('./customer-dunning/wiring').releaseIfDark(now);
    if (gatesModule.dunningCustomerScheduleLive()) await require('./customer-dunning/schedule').promote(now);
  } catch (err) {
    logger.error(`[invoice-followups] customer-dunning release/promotion failed — per-invoice touches still run: ${err.message}`);
  }
}

// After the per-invoice loop: the live schedules (GATE_DUNNING_CUSTOMER_SCHEDULE
// and its prerequisites), else the shadow run, which writes NOTHING. A failure
// here never costs the run its per-invoice result.
async function runCustomerScheduleEngine(now) {
  const gatesModule = customerDunningGates();
  if (!gatesModule) return;
  const live = gatesModule.dunningCustomerScheduleLive();
  if (!live && !gatesModule.dunningCustomerScheduleShadowLive()) return;
  try {
    const Runner = require('./customer-dunning/runner');
    // `now` is runPending's start (read from the wall clock): claims are
    // stamped from it plus all time elapsed since, including the per-invoice
    // loop above, so none is born expired. Cadence still uses `now`.
    if (live) await Runner.runCustomerSchedules(now, { clockStartedAt: now.getTime() });
    else await Runner.shadowRun(now);
  } catch (err) {
    logger.error(`[invoice-followups] customer-dunning ${live ? 'run' : 'shadow run'} failed: ${err.message}`);
  }
}

/**
 * Shared by both revival paths below: a 'completed' sequence in
 * [minStepIndex, maxStepIndexExclusive) whose invoice is open again gets
 * put back at the step it finished on (never advanced), guarded on the row
 * still being that finished sequence. A step whose send day already passed
 * is passed over by the stale-touch pass in the same run, never sent late —
 * the same guarantee adoptOrphanInvoices' fresh rows rely on.
 *
 * `reanchorToNow` (reviveReopenedLowStepSequences only — Codex pre-push P0
 * D): the OLD send-time anchor stays right for a Day 60/90 finish (its next
 * touch is still measured from the original send), but a low-step finish
 * reopened long after its own Day 90 would otherwise land back on the SAME
 * already-exhausted timeline — computeNextTouchAt would return null, the
 * row stale-completes without sending, and this function would try to
 * revive it again on every future run, forever. Re-anchoring to NOW (the
 * reopen IS a new debt event) guarantees a future next_touch_at, so it is
 * picked up, sent, and NEVER re-selected as 'completed' by this query
 * again — no loop.
 *
 * Delivered/published statuses only (PUBLISHED_INVOICE_STATUSES, the same
 * whitelist the retired late-payment checker used) — not the wider
 * "not terminal" test, for the same reason: a sequence's invoice should
 * never be draft/scheduled/sending by the time it HAS a finished sequence,
 * but if one ever were, it has not reached the customer and must not be
 * revived into an active reminder.
 */
// Has the legacy checker ever contacted the customer about this invoice?
// Such an invoice carries state the ladder does not model (which tier it
// delivered, a pending email retry, spacing from that delivery), so the
// ladder never picks it up on its own; the person settling it can arm a
// sequence by hand. An unreadable history is not an empty one.
async function legacyCheckerContacted(invoiceId, invoiceNumber = null) {
  try {
    const rows = await db('collections_contact_ledger')
      .where({ source: 'late_payment_checker' })
      .whereRaw('invoice_ids @> ?::jsonb', [JSON.stringify([invoiceId])]);
    if ((rows || []).length > 0) return { contacted: true };
    // The ledger has no rows from before it existed (its migration did not
    // backfill), so the checker's own dedupe record counts too (Codex #5202
    // r1 P1): activity_log 'late_payment_reminder', keyed by metadata
    // invoiceId on newer rows and by invoiceKey `<number or id>|<tier> DAYS`
    // on every row.
    const refs = [String(invoiceId), ...(invoiceNumber ? [String(invoiceNumber)] : [])];
    const activity = await db('activity_log')
      .where({ action: 'late_payment_reminder' })
      .where(function thisInvoice() {
        this.whereRaw("metadata->>'invoiceId' = ?", [String(invoiceId)])
          .orWhereRaw(`split_part(metadata->>'invoiceKey', '|', 1) IN (${refs.map(() => '?').join(', ')})`, refs);
      })
      .first('id');
    return { contacted: !!activity };
  } catch (err) {
    logger.warn(`[invoice-followups] legacy-history lookup failed for invoice ${invoiceId} — treating as contacted for this run: ${err.message}`);
    return { contacted: true, unavailable: true };
  }
}

async function reviveFinishedSequences(minStepIndex, maxStepIndexExclusive, { reanchorToNow = false } = {}) {
  const rows = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.status', 'completed')
    .where('s.step_index', '>=', minStepIndex)
    .where('s.step_index', '<', maxStepIndexExclusive)
    .whereIn('i.status', PUBLISHED_INVOICE_STATUSES)
    .whereNull('i.payer_id')
    .where(function withdrawnExcluded() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    .select(
      's.id', 's.invoice_id', 's.step_index', 's.anchor_at', 's.created_at', 'i.invoice_number',
      'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at', 'i.created_at as invoice_created_at',
    );
  let revived = 0;
  const leftForAPerson = [];
  for (const row of rows) {
    try {
      const anchorAt = reanchorToNow ? new Date() : sequenceAnchor(row);
      const nextAt = computeNextTouchAt(anchorAt, row.step_index);
      if (!nextAt) continue;
      const patch = {
        updated_at: db.fn.now(), status: 'active', next_touch_at: nextAt,
        ...(reanchorToNow ? { anchor_at: anchorAt } : {}),
      };
      const guard = { id: row.id, status: 'completed', step_index: row.step_index };
      if (!reanchorToNow) {
        revived += Number(await db('invoice_followup_sequences').where(guard).update(patch)) || 0;
        continue;
      }
      // Reopened-invoice revival (re-anchored to now, so it WILL send): an
      // invoice the legacy checker already contacted may have had its 60- and
      // 90-day tiers, and re-dunning it from Day 10 would follow a final
      // notice with five more reminders (Fable review of #5198) — left for a
      // person. And the invoice is re-read under its row lock so a payment
      // that settled it between the select and this update cannot leave an
      // active sequence on a paid invoice (Codex #5198 r1).
      if ((await legacyCheckerContacted(row.invoice_id, row.invoice_number)).contacted) {
        leftForAPerson.push(row.invoice_id);
        continue;
      }
      revived += await db.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id: row.invoice_id }).forUpdate().first('status', 'payer_id', 'scheduled_send_error');
        if (!invoice || !PUBLISHED_INVOICE_STATUSES.includes(normalizedStatus(invoice)) || invoice.payer_id
          || /^payer_billed:/.test(String(invoice.scheduled_send_error || ''))) return 0;
        return Number(await trx('invoice_followup_sequences').where(guard).update(patch)) || 0;
      });
    } catch (err) {
      // One row's failure must never abort the whole revival pass (Fable
      // pre-push P2 E) — the next run re-selects it fresh.
      logger.error(`[invoice-followups] revival failed for sequence ${row.id}: ${err.message}`);
    }
  }
  if (leftForAPerson.length) {
    logger.info(`[invoice-followups] reopened invoice(s) with legacy checker history left for a person to settle: ${leftForAPerson.join(', ')}`);
  }
  return revived;
}

/**
 * Day 90 ladder (GATE_DUNNING_LADDER_90): a sequence finished at the Day 60
 * or Day 90 step on a still-open invoice picks up again at that step. That
 * is a sequence that ran out of the legacy Day 3/7/14/30 steps, or one a
 * payment finished at Day 60 or Day 90 whose invoice a dispute reopened.
 * A payment finish before Day 30 keeps its lower index; see
 * reviveReopenedLowStepSequences below for what owns THAT case. The same invoice guards as the send batch apply.
 */
async function reviveLegacyFinishedSequences() {
  const revived = await reviveFinishedSequences(config.steps.length, followupSteps().length);
  if (revived) logger.info(`[invoice-followups] Day 90 ladder: ${revived} finished sequence(s) resumed at Day 60 or Day 90`);
  return revived;
}

// A sequence that finished BEFORE the legacy Day 30 end — an invoice paid
// (stopOnPayment) after only its early touches fired, then reopened by a
// dispute/refund reversal — used to rely on the legacy late-payment checker
// (deleted 2026-10-29) as its only fallback: hasActiveSequence deliberately
// excludes a low-step 'completed' row from "owned" (codex #5126 r1). This
// revives it, at the step it finished on, so the ladder owns the reopened
// invoice the same way it owns a Day 60/90 finish above.
async function reviveReopenedLowStepSequences() {
  // step_index === config.steps.length (exhausted the legacy cadence
  // without ever being paid) sits OUTSIDE [0, config.steps.length) — never
  // selected here, so it can never loop through this path either; that
  // long-standing "hand off to the legacy checker" case is unrelated to a
  // reopened invoice and out of this lane's scope.
  const revived = await reviveFinishedSequences(0, config.steps.length, { reanchorToNow: true });
  if (revived) logger.info(`[invoice-followups] retired checker: ${revived} reopened invoice(s) resumed on their follow-up sequence (re-anchored to the reopen)`);
  return revived;
}


// Steps the two cadences time differently (Day 7 vs 10, Day 14 vs 17), and
// the widest gap between them plus a day's margin.
const LADDER_MOVED_STEPS = config.steps
  .map((_step, index) => index)
  .filter((index) => config.steps[index].daysAfterSend !== config.stepsThrough90[index]?.daysAfterSend);
const LADDER_MAX_SHIFT_MS = (Math.max(0, ...LADDER_MOVED_STEPS.map((index) => (
  config.stepsThrough90[index].daysAfterSend - config.steps[index].daysAfterSend
))) + 1) * 24 * 60 * 60 * 1000;
const EARLY_ROW = Symbol('early');

/**
 * The cron's guarded write on its batch snapshot (same id, still active, same step, same due time) for the stale skip and the
 * Day 90 ladder moves. A live touch claim is never moved past: the Intelligence Bar's approved send-now holds one while it
 * dispatches and leaves next_touch_at as it was (stale or not), and its own advance owns the step. Only an expired claim (a
 * crashed sender, past TOUCH_CLAIM_TTL_MS) lets the cron through. Returns the query for the caller's .update().
 */
function cronSnapshotUpdate(row, now) {
  const claimExpiredBefore = new Date(now.getTime() - TOUCH_CLAIM_TTL_MS);
  return db('invoice_followup_sequences')
    .where({ id: row.id, status: 'active', step_index: row.step_index })
    .where('next_touch_at', row.next_touch_at)
    .where(function unclaimedOrExpired() {
      this.whereNull('touch_claimed_at').orWhere('touch_claimed_at', '<', claimExpiredBefore);
    });
}

/**
 * Gate off (codex #5126 r2): a row still waiting on a time the Day 90 ladder
 * scheduled goes back to its legacy day. Returns EARLY_ROW for a row the
 * widened batch select picked up that is not due on either cadence (left
 * alone), otherwise null (a due row, processed as before) or
 * { moved, due }, guarded like deferToLadderDay. A legacy day still ahead
 * is written back so every reader sees it; the legacy stale rule applies
 * (legacyTouchFor keeps the ladder's day when the legacy day already passed).
 */
async function restoreLegacyDay(row, now) {
  if (!row.next_touch_at || new Date(row.next_touch_at).getTime() <= now.getTime()) return null;
  const legacyAt = legacyTouchFor(row, now);
  if (!legacyAt) return EARLY_ROW;
  const updated = await cronSnapshotUpdate(row, now)
    .update({ updated_at: db.fn.now(), next_touch_at: legacyAt });
  logger.info(`[invoice-followups] Day 90 ladder off: invoice ${row.invoice_id} step ${row.step_index} `
    + `${updated ? `moved back to ${legacyAt.toISOString()}` : 'unchanged (sequence moved since batch select)'}`);
  return { moved: Number(updated) === 1, due: legacyAt };
}

/**
 * Day 90 ladder: a touch stored on the legacy cadence (Day 7 or Day 14)
 * waits for its new day (Day 10 or Day 17). Guarded on the batch snapshot,
 * like the stale skip. Returns null when no move is needed, otherwise
 * { moved, due }: moved false means the sequence changed since the batch
 * select and this run leaves it alone.
 */
async function deferToLadderDay(row) {
  if (!ladderThrough90Live() || !row.next_touch_at) return null;
  const due = computeNextTouchAt(sequenceAnchor(row), row.step_index);
  if (!due || due.getTime() <= new Date(row.next_touch_at).getTime()) return null;
  const updated = await cronSnapshotUpdate(row, new Date())
    .update({ updated_at: db.fn.now(), next_touch_at: due });
  logger.info(`[invoice-followups] Day 90 ladder: invoice ${row.invoice_id} step ${row.step_index} `
    + `${updated ? `moved to ${due.toISOString()}` : 'unchanged (sequence moved since batch select)'}`);
  return { moved: Number(updated) === 1, due };
}

// NY weekday of a touch's anchor (touches always sit at 10:00 NY, so the
// short weekday name is unambiguous).
const NY_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The earliest tick that was ever allowed to send a touch due at `dueAt`:
 * touches anchor to 10:00 NY on any calendar day, but the cron only runs on
 * sendWindow.daysOfWeek — a Sat/Sun/Mon-anchored touch has always fired on
 * Tuesday. Staleness must be measured from this moment, not the raw due
 * date, or every routine weekend-anchored touch would look days old by its
 * first chance to send and be skipped as stale (Codex r1 P1).
 */
function firstEligibleFireAt(dueAt) {
  let candidate = new Date(dueAt);
  for (let i = 0; i < 7; i++) {
    const dowName = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    }).format(candidate);
    if (config.sendWindow.daysOfWeek.includes(NY_DOW[dowName])) return candidate;
    candidate = anchorTo10amNY(candidate, 1, config.sendWindow.hour);
  }
  return new Date(dueAt);
}

function isStaleTouch(dueAt, now) {
  return now.getTime() - firstEligibleFireAt(dueAt).getTime() > STALE_TOUCH_GRACE_MS;
}

// The earliest a held step may be retried: the start of the next NY calendar
// day. The cron fires once a day (10:16 NY, Tue–Fri), so a same-day retry
// time would be about a day old by the next tick and skipStaleTouches would
// pass the step by instead of retrying it. A Saturday-to-Monday date rolls
// to Tuesday's anchor at staleness time (firstEligibleFireAt).
function heldTouchFloor(now = new Date()) {
  return anchorTo10amNY(now, 1, 0);
}

// How long the FINAL step may keep being held past its own scheduled day.
const FINAL_STEP_HOLD_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hold a claimed touch, undelivered and not terminal, for the next NY
 * calendar day: the retime the collections-policy and ledger-outage returns
 * in fireTouch owe. Leaving the row due instead lets runPending's stale grace
 * pass the step by at the next daily tick — a silently missed reminder.
 *
 * BOUNDED (owner ruling, audit P1): a hold that renews every day would pin a
 * sequence on one step forever under a persistent denial and later send very
 * old copy. A held step therefore retries daily only while it is still the
 * current stage: the hold applies only when the retry day is BEFORE the next
 * step's scheduled date (same anchor and cadence fireTouch advances along).
 * Otherwise nothing is written and the row stays due as before, so the stale
 * skip moves it to the next step, whose copy supersedes this one. The FINAL
 * step has no next step, so its hold is capped at 7 days after its own
 * scheduled date; past that the row is left as it was.
 *
 * Days are compared as NY calendar days at the day the cron can actually retry
 * (firstEligibleFireAt: a Friday hold retries Tuesday, which may already be the
 * next step's day).
 *
 * Operator send-now is never held (see the guard at the top).
 *
 * Guarded like the stale skip: it lands only while this worker still holds the
 * claim (fireStep's stamp) on the same active step AND the claimed next_touch_at
 * is unchanged, so an admin edit, pause or a manual send-now that moved the
 * sequence since is left alone. Best-effort:
 * a failed write leaves the prior behaviour (row still due) and never throws
 * out of the touch. Returns whether the retime landed.
 */
async function holdTouchUntilNextDay(row, claimStamp, why, { operatorInitiated = false } = {}) {
  // An operator send-now keeps today's behaviour: its row is selected without
  // the invoice anchor aliases (the anchor would fall back to the sequence's
  // created_at), and it is a one-off click, not a cron cadence to protect.
  if (operatorInitiated) return false;
  const floor = heldTouchFloor();
  let nextStepAt;
  let withinWindow;
  try {
    const anchorAt = sequenceAnchor(row);
    nextStepAt = computeNextTouchAt(anchorAt, row.step_index + 1);
    const ownStepAt = computeNextTouchAt(anchorAt, row.step_index);
    // Compare the day the cron can ACTUALLY retry (first send-window day on or
    // after the floor), not the raw floor: a Friday hold retries Tuesday, which
    // may already be the next step's day (Codex #5404 r1 P1).
    const retryDay = etDateString(firstEligibleFireAt(floor));
    withinWindow = nextStepAt
      ? retryDay < etDateString(firstEligibleFireAt(nextStepAt))
      : !!ownStepAt && retryDay <= etDateString(new Date(ownStepAt.getTime() + FINAL_STEP_HOLD_MAX_MS));
  } catch (err) {
    logger.warn(`[invoice-followups] hold bound could not be computed for sequence ${row.id} (${why}): ${err.message} — not held`);
    return false;
  }
  if (!withinWindow) {
    logger.info(`[invoice-followups] sequence ${row.id} step ${row.step_index} not held (${why}) — ${nextStepAt ? "the next step's day arrives first" : 'past the final step\'s 7-day hold window'}; left to the stale skip`);
    return false;
  }
  const guard = { id: row.id, status: 'active', step_index: row.step_index };
  if (claimStamp) guard.touch_claimed_at = claimStamp;
  try {
    let query = db('invoice_followup_sequences').where(guard);
    // A send-now that rewrote next_touch_at meanwhile must not be overwritten
    // (Codex #5404 r1 P2). Compared at millisecond precision: some writers
    // stamp it with the DB clock (microseconds, e.g. visit-completion-packets'
    // trx.fn.now()) while pg hands JS a millisecond Date, so plain equality
    // would never match and every hold would silently no-op.
    if (row.next_touch_at) {
      query = query.whereRaw("date_trunc('milliseconds', next_touch_at) = ?", [new Date(row.next_touch_at)]);
    }
    const updated = await query.update({ updated_at: db.fn.now(), next_touch_at: floor });
    if (Number(updated) > 0) {
      logger.info(`[invoice-followups] sequence ${row.id} step ${row.step_index} held (${why}) — retimed to ${floor.toISOString()}`);
      return true;
    }
    logger.warn(`[invoice-followups] hold retime no-op for sequence ${row.id} (${why}) — sequence changed since the claim`);
  } catch (err) {
    logger.warn(`[invoice-followups] hold retime failed for sequence ${row.id} (${why}): ${err.message}`);
  }
  return false;
}

/**
 * Advance a sequence past touches whose eligible send day already passed,
 * without sending them. Walks the same anchored timeline fireTouch advances
 * along until it finds a step still sendable; no sendable step left = completed.
 * The update is a single guarded statement predicated on the batch snapshot
 * (status/step/due unchanged), so it no-ops — and the next tick re-decides —
 * if an admin edit or a manual sendNextTouchNow moved the sequence meanwhile.
 * Deliberately no customer_interactions row: nothing customer-facing happened.
 */
async function skipStaleTouches(row, now) {
  const anchorAt = row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at
    || row.invoice_created_at || row.created_at;
  let nextIndex = row.step_index;
  let nextAt = new Date(row.next_touch_at);
  const skippedSteps = [];
  while (nextAt && isStaleTouch(nextAt, now)) {
    skippedSteps.push(followupSteps()[nextIndex]?.id || `step_${nextIndex}`);
    nextIndex += 1;
    nextAt = computeNextTouchAt(anchorAt, nextIndex);
  }
  const updated = await cronSnapshotUpdate(row, now)
    .update({
      updated_at: db.fn.now(),
      step_index: nextIndex,
      next_touch_at: nextAt,
      status: nextAt ? 'active' : 'completed',
    });
  if (updated) {
    logger.info(
      `[invoice-followups] skipped stale touch(es) [${skippedSteps.join(', ')}] for invoice ${row.invoice_id} — `
      + `sequence ${nextAt ? `resumes at step ${nextIndex} (${new Date(nextAt).toISOString()})` : 'completed (no future steps)'}`,
    );
  } else {
    logger.info(`[invoice-followups] stale-skip no-op for invoice ${row.invoice_id} — sequence changed since batch select`);
  }
  return { skippedSteps, nextIndex, nextAt: nextAt || null, updated: !!updated };
}

/**
 * Send a single step for one sequence row.
 *
 * Serialized against delivered-invoice edits (2026-07-17 lane): a short
 * claim is stamped on the sequence row before rendering/sending, and
 * InvoiceService.update refuses (pre-check + atomic predicate) while a
 * fresh claim exists — so a reminder can't quote amounts an admin is
 * rewriting mid-send. The claim clears in `finally`; a crashed sender
 * self-heals via the TTL window.
 */
const TOUCH_CLAIM_TTL_MS = 10 * 60 * 1000;
// approved (the Intelligence Bar's send-now card only): { invoiceUpdatedAtMs } — the invoice edit time the card showed, checked
// on the invoice row this claim locks; a difference claims and sends nothing (returns { previewChanged: true }).
// report (the same caller only): an object fireTouch fills with the per-leg outcomes (touchLegReport); the return value then
// says what happened: { notClaimed }, { previewChanged } or { legs }. Every other caller passes neither and gets what it got.
// The cron's claim: a sequence nobody holds (or whose claim expired) takes this stamp.
function takeDueClaim(trx, sequenceId, claimStamp, preClaimed) {
  if (preClaimed) return 1; // already ours (checked under the locks by dueOrPreClaimed)
  return trx('invoice_followup_sequences')
    .where({ id: sequenceId })
    .where(function () {
      this.whereNull('touch_claimed_at').orWhere(
        'touch_claimed_at', '<', new Date(claimStamp.getTime() - TOUCH_CLAIM_TTL_MS),
      );
    })
    // The claim stamps updated_at too: "a worker is mid-send on this
    // sequence" is precisely the activity an ownership-change check must
    // see, and it is the backstop for the ownership gate in fireStep — a claim
    // taken before the undo's verification pass makes the undo refuse instead
    // of repointing a sequence out from under an in-flight touch.
    .update({ touch_claimed_at: claimStamp, updated_at: trx.fn.now() });
}

// The claim fireStep works under: the one an approved send-now already took, or a fresh stamp.
const claimOf = (claim) => claim || { preClaimed: false, claimStamp: new Date() };

// The fired row is due now (a cron claim), or still carries the claim an approved send-now took in its locked UPDATE.
function dueOrPreClaimed(liveSeq, preClaimed, claimStamp) {
  if (preClaimed) return Boolean(liveSeq.touch_claimed_at) && new Date(liveSeq.touch_claimed_at).getTime() === claimStamp.getTime();
  return Boolean(liveSeq.next_touch_at) && new Date(liveSeq.next_touch_at).getTime() <= Date.now();
}

// A pre-taken claim that fireStep does not carry into a send is released (only while it is still this call's).
function releaseSendNowClaim(row, preClaimed, claimStamp, claimedSeq) {
  if (!preClaimed || claimedSeq) return undefined;
  return db('invoice_followup_sequences').where({ id: row.id, touch_claimed_at: claimStamp })
    .update({ touch_claimed_at: null, updated_at: db.fn.now() })
    .catch((err) => logger.warn(`[invoice-followups] could not release the send-now claim for ${row.invoice_id}: ${err.message}`));
}

// claim { preClaimed, claimStamp }: an approved send-now already wrote in the locked UPDATE that judged its card (no re-arm, no
// moment where the row is due and unclaimed); it is checked here under the locks, never re-taken, and released if the send
// does not go on.
async function fireStep(row, { operatorInitiated = false, ownedMicrodeposit = false, approved = null, report = null, claim = null } = {}) {
  const { preClaimed, claimStamp } = claimOf(claim);
  // The cleanup is predicated on OUR stamp: if this send outlives the TTL
  // and another worker replaces the stale claim, an unconditional clear
  // here would release the successor's live claim and let an edit race its
  // in-flight reminder.
  let claimedSeq = null;
  let claimedInvoice = null;
  let ownedBy = null;
  let previewChanged = false;
  try {
    // Claim inside a transaction that locks the INVOICE row first.
    // InvoiceService.update locks the same row before re-checking the claim,
    // so Postgres strictly orders an edit against this claim — without a
    // common row lock, both single-statement writes could pass on
    // pre-commit snapshots of each other. The transaction holds no external
    // work: it commits before any rendering or sending.
    await db.transaction(async (trx) => {
      // The customer's dunning key, SHARED, before the invoice row: the
      // schedule engine takes it EXCLUSIVELY and then locks member invoice
      // rows, so taking it after the invoice lock would invert that order and
      // could deadlock. A promotion either commits first (seen below) or waits
      // for this claim to commit and then refuses on its fresh stamp.
      await lockCustomerDunningShared(trx, row.customer_id);
      const lockedInvoice = await trx('invoices')
        .where({ id: row.invoice_id })
        .forUpdate()
        .first();
      if (!lockedInvoice) return;
      if (approved && (lockedInvoice.updated_at ? new Date(lockedInvoice.updated_at).getTime() : null) !== approved.invoiceUpdatedAtMs) {
        previewChanged = true;
        return;
      }
      // Post-claim... now post-LOCK revalidation: the caller's row is a
      // batch snapshot — a due-date edit (rescheduleForInvoiceEdit, which
      // commits atomically with its invoice edit) can postpone
      // next_touch_at, or an admin can pause/stop/advance the sequence.
      // Fire only if it is still active, on the same step, and actually
      // due; progress from the LIVE anchor so a postponed timeline is
      // never overwritten from the stale snapshot.
      const liveSeq = await trx('invoice_followup_sequences').where({ id: row.id }).first();
      if (!liveSeq || liveSeq.status !== 'active' || liveSeq.step_index !== row.step_index || !dueOrPreClaimed(liveSeq, preClaimed, claimStamp)) {
        return;
      }
      // OWNERSHIP REVALIDATION UNDER THE LOCK (r19 P1 — customer-facing leak).
      //
      // `row` is a batch snapshot from runPending's join (or sendNextTouchNow's).
      // An ownership change that committed between that SELECT and this lock
      // (a customer merge repoints BOTH the invoice and its sequence) leaves
      // `row.customer_id` naming the previous owner — nothing above re-read it.
      // fireTouch would then render this invoice's bearer /pay/:token and
      // text/email one customer's bill to a DIFFERENT customer.
      //
      // Refuse rather than re-target: an ownership flip means the state this
      // batch row was built from is gone, and re-deriving a send from half-
      // refreshed fields is how the original bug happened. Skipping leaves the
      // sequence active and due, so the next cron pass re-selects it fresh.
      // Sequence and invoice must also agree with EACH OTHER — a split between
      // them is exactly the state the undo's child probe refuses to create, so
      // seeing it here means something else diverged: fail closed.
      if (
        String(liveSeq.customer_id) !== String(row.customer_id) ||
        String(lockedInvoice.customer_id) !== String(row.customer_id)
      ) {
        logger.warn(
          `[invoice-followups] ownership changed under the lock for sequence ${row.id} (invoice ${row.invoice_id}) — skipping this touch; the next run re-selects it fresh`,
        );
        return;
      }
      // A customer on an open customer-level schedule: the schedule owns the
      // cadence; this row is membership state and is never fired or claimed —
      // unless the caller brings it as a micro-deposit nudge (runPending's
      // pre-check): then it is claimed, and fireTouch sends only the
      // verification nudge, only if the invoice is still waiting on it.
      ownedBy = await openCustomerScheduleId(trx, row.customer_id);
      if (ownedBy && !ownedMicrodeposit) return;
      const claimed = await takeDueClaim(trx, row.id, claimStamp, preClaimed);
      if (claimed) {
        claimedSeq = liveSeq;
        claimedInvoice = lockedInvoice;
      }
    });
  } catch (err) {
    // Falls through: nothing was claimed, so the not-claimed answer below is the one given (and a pre-taken claim is released).
    logger.error(`[invoice-followups] touch claim failed for invoice ${row.invoice_id}: ${err.message}`);
    claimedSeq = null;
    previewChanged = false;
    ownedBy = null;
  }
  await releaseSendNowClaim(row, preClaimed, claimStamp, claimedSeq);
  if (previewChanged) return { previewChanged: true };
  if (ownedBy && !ownedMicrodeposit) {
    logger.info(`[invoice-followups] sequence ${row.id} not fired — customer ${row.customer_id} is on customer reminder schedule ${ownedBy}`);
    return { ownedBy };
  }
  if (!claimedSeq) {
    logger.info(`[invoice-followups] sequence ${row.id} in flight or changed after batch select; skipping touch`);
    return report ? { notClaimed: true } : undefined;
  }
  // Hand fireTouch POST-LOCK state, not the batch snapshot (r19 P1). The
  // ownership gate above proved customer_id has not moved; these are the
  // remaining send-driving fields the lock proves fresher than the batch
  // select. invoice_payer_id especially: fireTouch's Bill-To guard reads it to
  // decide whether sending would leak the payer's bearer link, and a payer
  // assigned since the batch SELECT would otherwise be invisible to it.
  row.anchor_at = claimedSeq.anchor_at;
  // The locked, claimed due time: holdTouchUntilNextDay's guard compares it, so a
  // send-now rewrite after the claim is a no-op there, not an overwrite.
  row.next_touch_at = claimedSeq.next_touch_at;
  row.customer_id = claimedSeq.customer_id;
  row.invoice_payer_id = claimedInvoice.payer_id ?? null;
  row.invoice_status = claimedInvoice.status;
  row.token = claimedInvoice.token;
  try {
    await fireTouch(row, { operatorInitiated, claimStamp, verificationOnly: !!ownedBy, report, approved, expectedContentHash: approved?.emailContentHash || null });
    fillUnsentLegs(report);
  } finally {
    await db('invoice_followup_sequences')
      .where({ id: row.id, touch_claimed_at: claimStamp })
      // Stamped as well, so a send that THREW before reaching any status write
      // still leaves the row looking touched to the undo's activity gate.
      .update({ touch_claimed_at: null, updated_at: db.fn.now() })
      .catch((err) => logger.warn(
        `[invoice-followups] could not clear touch claim for ${row.invoice_id}: ${err.message}`,
      ));
  }
  if (report?.previewChanged) return { previewChanged: true };
  return report ? { legs: report.legs || null } : undefined;
}

// The per-leg outcome of one touch, for the Intelligence Bar's send-now card: { state, reason? } per channel.
// States: sent (a new delivery), already_delivered (an earlier delivery of this step, not repeated), held (kept for a later
// run), queued (text deferred to the send-window open), skipped (nothing to send to or with), not_sent (refused before the
// provider), unknown (the provider may have taken it: never read as "not sent"). Reasons are codes, never addresses.
const legReason = (value) => (typeof value === 'string' && value ? value.slice(0, 80) : undefined);
function emailLegReport(result, permitted) {
  const r = result || {};
  if (r.ok === true) return { state: r.deduped ? 'already_delivered' : 'sent' };
  if (r.deduped) return { state: 'unknown', reason: 'duplicate_unconfirmed' };
  if (r.deliveryOutcome === 'uncertain' || r.deliveryOutcome === 'accepted') return { state: 'unknown', reason: legReason(r.reason) || 'provider_unconfirmed' };
  // A leg the card never approved is skipped whatever the policy says about Email now (the policy verdict only classifies legs that could have gone).
  if (r.reason === 'not_approved') return { state: 'skipped', reason: 'not_approved' };
  if (permitted !== true) return { state: 'held', reason: 'collections_policy_denied' };
  if (heldByDisputeHold(r)) return { state: 'held', reason: 'collection_hold' };
  if (r.deferred === true || r.retryable === true) return { state: 'held', reason: legReason(r.reason) };
  if (r.skipped === true || r.resolved === true) return { state: 'skipped', reason: legReason(r.reason) };
  if (r.blocked === true || r.deliveryOutcome === 'not_sent') return { state: 'not_sent', reason: legReason(r.reason) };
  return { state: 'unknown', reason: 'email_outcome_unconfirmed' };
}

// The leg the bar's approved card allows (every leg when there is no card: the page's own send and the cron).
function approvedLeg(bar, leg) {
  return !bar || Boolean(bar[leg]);
}

// What the bar's card pinned for the email leg (the content hash, the rendered digest, the approved address), checked at the
// send. The bar's send honors a dispute hold on the provider-retry rail; an operator's page send does not.
function approvedEmailChecks(bar, approved, expectedContentHash) {
  if (!bar) return { expectedContentHash, expectedEmailDigest: null, expectedRecipientDigest: null, honorDisputeHold: false };
  return {
    expectedContentHash: bar.emailContentHash,
    expectedEmailDigest: bar.emailRenderedDigest,
    expectedRecipientDigest: approved.emailDigest,
    honorDisputeHold: true,
  };
}

// An approved send goes out only as the card showed it: a card with no valid channel set, a bank-verification message instead
// of the reminder, or other recipients send nothing. The reason, or null when the card still holds.
async function approvedSendDrift({ bar, approved, customer, mdPending }) {
  if (!bar) return null;
  if (!bar.valid) return 'approval_invalid';
  if (mdPending) return 'message_changed';
  return approvalDrift(approved, customer);
}

// The card no longer matches what would go out: nothing is sent and the caller restores the time (report.previewChanged).
function refuseApprovedSend(row, report, why) {
  logger.warn(`[invoice-followups] send-now on sequence ${row.id} refused: ${why}`);
  if (report) report.previewChanged = true;
}

// The amount in the approved text and email: any other balance now is a different message.
function approvedAmountChanged(bar, approved, row) {
  return Boolean(bar) && Math.round(invoiceAmountDue(row) * 100) !== approved.dueCents;
}

// Account credit before the reminder, so it bills the amount DUE. An approved send never draws credit (the card's amount is
// frozen in its text): credit that WOULD apply refuses it. Otherwise best-effort and idempotent; `applied` is what THIS dun drew,
// reversed later if no channel delivered.
async function drawDunCredit({ row, customer, bar }) {
  const credit = require('./customer-credit');
  if (bar) {
    const wouldApply = await credit.autoApplyWouldApply({ id: row.invoice_id, customer_id: customer.id, total: row.total, credit_applied: row.credit_applied, amount_paid: row.amount_paid });
    return wouldApply ? { refused: true, applied: 0 } : { applied: 0 };
  }
  try {
    const drawn = await credit.autoApplyAccountCreditIfEnabled(row.invoice_id);
    return { applied: drawn?.applied || 0 };
  } catch (creditErr) {
    logger.warn(`[invoice-followups] account-credit apply before dun skipped for ${row.invoice_id}: ${creditErr.message}`);
    return { applied: 0 };
  }
}

// No reminder went out: reverse the credit THIS dun drew (any prior applied credit stays). The invoice is collectible here, so
// reverseAppliedCredit (which refuses 'sending'/'prepaid') applies.
async function reverseDunCredit(invoiceId, amount, why) {
  if (!(amount > 0)) return;
  try {
    const { reverseAppliedCredit } = require('./customer-credit');
    await reverseAppliedCredit({ invoiceId, amount, createdBy: 'system:dun_undelivered' });
  } catch (e) {
    logger.warn(`[invoice-followups] credit reversal after ${why} skipped for ${invoiceId}: ${e.message}`);
  }
}

// Which legs the customer's choices select: Text (and App) or the explicit set, and Email. No explicit choice = Text and Email.
function touchChannelPlan(selectedChannels) {
  const nonEmailChannels = selectedChannels === null ? ['sms']
    : ['push', 'sms'].filter((channel) => selectedChannels.includes(channel));
  const emailSelected = selectedChannels === null || selectedChannels.includes('email');
  return { nonEmailChannels, emailSelected, policyChannels: [...nonEmailChannels, ...(emailSelected ? ['email'] : [])] };
}

// A denial that will lift (a spacing window, a releasable hold) is transient; flag, suppression and standing are durable.
function hasTransientDenial(policyChannels, policyResults) {
  return policyChannels.some((_channel, index) => !verdictDurablyDenied(policyResults[index]));
}

// Nothing was delivered: the touch is retried the next day when a leg really had a transient denial or outage. The email
// result's default reason reads 'collections_policy_denied' even when Email was never selected, so it only counts here while a
// leg really has one. A terminal outcome on one leg (SMS non-mobile, blocked) never discards another leg's transient denial
// (Codex #5404 r2 P1).
function hasTransientLeg({ policyChannels, policyResults, smsSkipReason, emailResult }) {
  return policyChannels.some((_channel, index) => !verdictAllows(policyResults[index]) && !verdictDurablyDenied(policyResults[index]))
    || smsSkipReason === 'ledger_unavailable' || emailResult.reason === 'ledger_unavailable';
}

// The text body of the reminder (or of the bank-verification nudge that replaces it).
function reminderSmsBody({ mdPending, ctx, step, row }) {
  if (!mdPending) return resolveBody(step, ctx);
  return renderSmsTemplate('bank_verification_incomplete', {
    first_name: ctx.name, billing_url: `${publicPortalUrl()}/?tab=billing`,
  }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: row.invoice_id });
}

// The text leg of the bar's report when the sender blocked or deferred it.
// The SMS/App leg's last check before the provider: the invoice is still self-pay (every send), and for the Intelligence Bar's
// approved send-now (bar) the Eastern 8 AM-8 PM window again. operatorInitiated skips the canonical sender's window validator
// (the Invoices page's own Send-now keeps that exemption), and a card confirmed at 7:59 PM can wait on locks past 8 PM.
function followupDispatchCheck(invoiceId, bar) {
  const ownership = invoiceHelpers.selfPayAtDispatch(invoiceId, db);
  if (!bar) return ownership;
  return async (ctx) => {
    if (!require('./messaging/send-window').isWithinSendWindowET()) {
      return { ok: false, code: 'OUTSIDE_SEND_WINDOW', reason: 'the bar\'s approved send is not sent between 8 PM and 8 AM Eastern' };
    }
    return ownership(ctx);
  };
}

function blockedSmsLeg(sendResult, { smsDeferredOwned, smsOutcomeMayHaveDelivered }) {
  if (smsDeferredOwned) return { state: 'queued', reason: 'send_window' };
  if (smsOutcomeMayHaveDelivered) return { state: 'unknown', reason: legReason(sendResult.code) || 'provider_unconfirmed' };
  return { state: sendResult.deferred ? 'held' : 'not_sent', reason: legReason(sendResult.code) || 'sms_blocked' };
}

// The per-leg report (the bar's send-now card). The explicit-channel branch keeps its state in flags; the single-text branch set
// smsLeg itself.
function fillLegReport(report, { smsLeg, emailResult, emailPermitted, actualSmsSent, appSent, smsSent, smsSkipReason, smsOutcomeMayHaveDelivered, smsHoldUnowned }) {
  if (!report) return;
  let sms = smsLeg;
  if (!sms) {
    if (actualSmsSent || appSent) sms = { state: 'sent' };
    else if (smsSent) sms = { state: 'already_delivered' };
    else if (smsSkipReason === 'outcome_unconfirmed' || smsOutcomeMayHaveDelivered) sms = { state: 'unknown', reason: 'provider_unconfirmed' };
    else if (smsHoldUnowned || ['collections_policy_denied', 'collection_hold'].includes(smsSkipReason)) sms = { state: 'held', reason: legReason(smsSkipReason) };
    else sms = { state: 'not_sent', reason: legReason(smsSkipReason) };
  }
  report.legs = { sms, email: emailLegReport(emailResult, emailPermitted) };
}

// The latest earlier delivery time of this step's legs, else the last touch time.
function latestDeliveryAt(times, fallback) {
  return times.length ? new Date(Math.max(...times.map((time) => new Date(time).getTime()))) : fallback;
}

// Move the sequence on after a touch. A verification nudge of a customer on a combined schedule (verificationOnly) advances its
// row only while it still holds the row exactly as it claimed it: a release of the schedule lands every member (a new step, or the
// schedule's pause), and a send outliving its claim TTL must not overwrite that landing. (A release refuses while this claim is
// fresh: closeUnderLock's member-claim check.) The row returns to 'active' (or completes) only while it is still 'active' (the
// claim required it): a pause or stop that landed during the send is not overwritten. A write that matched nothing there still
// records the touch (step, count, time).
async function advanceAfterTouch({ row, verificationOnly, claimStamp, freshDelivery, originalAt }) {
  const nextIndex = row.step_index + 1;
  // anchor_at (set when an admin edit shifted the due date) overrides the send-time anchor so the whole remaining cadence stays
  // on one timeline.
  const anchorAt = row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at || row.created_at;
  const nextAt = computeNextTouchAt(anchorAt, nextIndex);
  const touched = {
    updated_at: db.fn.now(),
    touches_sent: row.touches_sent + 1,
    step_index: nextIndex,
    last_touch_at: freshDelivery ? new Date() : originalAt,
  };
  const progressed = await db('invoice_followup_sequences').where({
    id: row.id,
    ...(verificationOnly ? { touch_claimed_at: claimStamp, step_index: row.step_index, status: 'active' } : { status: 'active' }),
  }).update({ ...touched, next_touch_at: nextAt, status: nextAt ? 'active' : 'completed' });
  if (verificationOnly) {
    if (!Number(progressed)) {
      logger.warn(`[invoice-followups] sequence ${row.id} not advanced after its verification nudge — the row changed under the send (a customer reminder schedule released it); its landing is kept`);
    }
    return;
  }
  if (progressed === 0) {
    await db('invoice_followup_sequences').where({ id: row.id }).update(touched);
    logger.warn(`[invoice-followups] sequence ${row.id} was paused or stopped during its send — the touch is recorded and its status is kept`);
  }
}

// A touch that ends before any sender ran: the report (the bar's per-leg outcome) says so on both legs, with the reason.
// Delivery is "unknown" only when a sender actually ran and its answer was not clear; a touch that stops earlier is a plain
// "nothing was sent" (held = the reminder stays on its schedule, skipped = it does not apply, not_sent = it could not go).
function exitNoSend(report, state, reason) {
  if (report) report.legs = { sms: { state, reason }, email: { state, reason } };
}

// Every exit of fireTouch that did not reach a sender leaves report.legs unset; fireStep fills it (fillUnsentLegs), so no
// pre-send exit reads as an unknown delivery (a refusal for a changed card is report.previewChanged, never legs).
function fillUnsentLegs(report) {
  if (report && !report.legs && !report.previewChanged) exitNoSend(report, 'not_sent', 'not_sent_before_dispatch');
}

async function fireTouch(row, { operatorInitiated = false, claimStamp = null, verificationOnly = false, report = null, approved = null, expectedContentHash = null } = {}) {
  // A row of a customer on a combined schedule (fireStep's ownedMicrodeposit):
  // re-judged now, after the claim committed and outside any lock. No longer
  // waiting on verification -> the invoice is the schedule's: nothing is sent
  // or written here (the claim clears in fireStep's finally).
  if (verificationOnly && !(await awaitingMicrodepositVerification(row))) {
    logger.info(`[invoice-followups] sequence ${row.id} not sent — invoice ${row.invoice_id} is no longer waiting on bank verification and customer ${row.customer_id} is on a customer reminder schedule`);
    return exitNoSend(report, 'skipped', 'customer_schedule');
  }
  const step = followupSteps()[row.step_index];
  if (!step) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'completed',
      next_touch_at: null,
    });
    return exitNoSend(report, 'skipped', 'no_reminder_step');
  }

  // Third-party Bill-To: never send a dunning touch for a payer-billed invoice —
  // fireStep builds /pay/:token and texts it to row.customer_id (the homeowner),
  // leaking the payer's bearer pay link. runPending already filters these out;
  // this covers sendNextTouchNow's direct call too. Pause terminally (not a bare
  // return) so a later re-arm can't fire a stale touch. Prefer the selected
  // invoice_payer_id; fall back to a lookup when the caller didn't select it.
  // RE-READ, always (Codex #4311 r32 P1). The batch select happens before the
  // sequence claim and the provider request; a Bill-To change committing in
  // that window stamps the invoice and pauses the sequence, and this worker —
  // already claimed — would text the homeowner a pay link for debt that now
  // belongs to AP. The selected columns are only a fast path for what the
  // fence used to read; ownership itself is judged on the live row.
  const liveInvoice = await db('invoices').where({ id: row.invoice_id })
    .first('payer_id', 'scheduled_send_error').catch(() => undefined);
  if (liveInvoice === undefined) {
    // Unreadable ownership is not "self-pay" — but it is not a Bill-To change
    // either (local audit): pausing here would retire the sequence over a
    // transient DB blip, and neither this engine nor the legacy sweep would
    // ever pick it up again. Skip THIS touch and keep a schedule, so the next
    // sweep re-judges it.
    await db('invoice_followup_sequences').where({ id: row.id }).where({ status: 'active' })
      .update({ updated_at: db.fn.now(), next_touch_at: new Date(Date.now() + 30 * 60 * 1000) })
      .catch(() => {});
    logger.warn(`[invoice-followups] skipped sequence ${row.id} — could not re-read invoice ${row.invoice_id} ownership before the touch; retrying in 30m`);
    return exitNoSend(report, 'not_sent', 'ownership_unverified');
  }
  const payerId = liveInvoice.payer_id ?? null;
  const sendError = liveInvoice.scheduled_send_error ?? null;
  if (payerId || invoiceWithdrawnFromCustomer({ scheduled_send_error: sendError })) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'paused',
      next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused sequence ${row.id} — invoice ${row.invoice_id} is billed to a third-party payer`);
    return exitNoSend(report, 'skipped', 'invoice_payer_billed');
  }

  const customer = await db('customers').where({ id: row.customer_id }).first();
  // Guard every send path (cron runPending filters too, but sendNextTouchNow
  // reaches here directly) — soft-deleted customers get no follow-up touches.
  // Pause rather than bare-return: sendNextTouchNow re-arms the sequence
  // (active + past-due next_touch_at) before calling here, so leaving it
  // active would fire a stale touch if the customer is later restored.
  if (customer?.deleted_at) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'paused',
      next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused sequence ${row.id} — customer ${row.customer_id} is soft-deleted`);
    return exitNoSend(report, 'skipped', 'customer_unavailable');
  }
  if (!customer) {
    logger.warn(`[invoice-followups] skipped sequence ${row.id} — customer ${row.customer_id} is missing`);
    return exitNoSend(report, 'skipped', 'customer_unavailable');
  }
  // The card's recipients and text, against what is live right now: a change sends neither leg (the caller restores the time).
  const bar = approvedSendPlan(approved);
  // The dispute-hold exemption belongs to the Invoices page's own operator Send-now. The bar's approved send never has it: a hold
  // created after the card was shown stops the text, the email and the policy check (the card sends nothing the page would not).
  const holdExempt = operatorInitiated && !bar ? 'operator' : null;
  const mdPending = verificationOnly || (gates.divertMicrodepositDunning
    && await StripeService.isInvoiceAwaitingMicrodepositVerification({
      id: row.invoice_id,
      stripe_payment_intent_id: row.invoice_stripe_pi,
    }));
  // An approved send goes out only as the card showed it: a card with no valid channel set, a bank-verification message
  // instead of the reminder, or other recipients send nothing.
  const drift = await approvedSendDrift({ bar, approved, customer, mdPending });
  if (drift) return refuseApprovedSend(row, report, drift);
  const category = mdPending ? 'payment_issue' : 'invoice';
  let explicitChannels = null;
  if (!operatorInitiated) {
    try {
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
      explicitChannels = explicitBillingChannels(prefs || {}, category);
    } catch (err) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — channel preferences unavailable: ${err.message}`);
      return exitNoSend(report, 'not_sent', 'preferences_unavailable');
    }
  }
  // Collections policy — BOTH legs' permissions resolved here, ahead of the
  // account-credit draw (a fully-denied touch must not draw down credit and
  // then need a reversal). Each channel decides independently (codex
  // 2026-08-14: the email leg must not ride the SMS verdict). Gate off ⇒
  // both true without consulting, byte-identical (pinned by test). A policy
  // denial is a TRANSIENT state (frequency window, releasable hold) — a
  // both-denied touch returns with the sequence still active and retimed to
  // the next day (holdTouchUntilNextDay), so a later tick re-decides; it is never paused terminally for policy.
  const selectedChannels = explicitChannels;
  const { nonEmailChannels, emailSelected, policyChannels } = touchChannelPlan(selectedChannels);
  let ownLedgerIds = [];
  if (selectedChannels !== null) {
    try { ownLedgerIds = await currentStepLedgerIds(row, step, policyChannels); }
    catch (err) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — step ledger unavailable: ${err.message}`);
      await holdTouchUntilNextDay(row, claimStamp, 'step_ledger_unavailable', { operatorInitiated });
      return exitNoSend(report, 'held', 'ledger_unavailable');
    }
  }
  const policyResults = await Promise.all(policyChannels.map((channel) =>
    collectionsChannelPermitted(row.customer_id, row.invoice_id, channel, ownLedgerIds, true, mdPending, holdExempt)));
  const channelPolicy = Object.fromEntries(policyChannels.map((channel, index) => [channel, verdictAllows(policyResults[index])]));
  const emailDurablyDenied = verdictDurablyDenied(policyResults[policyChannels.indexOf('email')]);
  const smsPermitted = channelPolicy.sms === true;
  const emailPermitted = channelPolicy.email === true;
  if (!Object.values(channelPolicy).some(Boolean)) {
    logger.info(`[invoice-followups] collections policy denied selected channels for sequence ${row.id} — touch deferred to a later run`);
    // Held, not skipped: retimed past today so the daily tick's stale grace
    // does not pass this step by. Nothing was drawn or sent here. Only when
    // some denied channel is TRANSIENT (a spacing window, a releasable hold):
    // when every channel is durably denied (flag, suppression, standing) the
    // denial will not lift, so the step is left due as before — one attempt.
    const transientDenial = hasTransientDenial(policyChannels, policyResults);
    if (transientDenial) await holdTouchUntilNextDay(row, claimStamp, 'collections_policy_denied', { operatorInitiated });
    // Both channels denied: no sender ran. Held when a denial is transient (the reminder stays on its schedule), else skipped.
    return exitNoSend(report, transientDenial ? 'held' : 'skipped', 'collections_policy_denied');
  }
  // Apply any available account credit before dunning so the reminder bills amount
  // due, not the gross balance — credit issued AFTER the invoice was sent isn't drawn
  // down until a payment-ask seam runs, and this dunning touch is one of them. Gated +
  // best-effort + idempotent. Re-read the (possibly reduced) invoice; if credit fully
  // covered it the invoice is now prepaid/paid — stop the sequence instead of dunning.
  // Track what THIS dun drew down so the no-channel-delivered path below can reverse
  // it (don't consume credit for an undelivered reminder; matches the send/project
  // rollback).
  const credit = await drawDunCredit({ row, customer, bar });
  if (credit.refused) return refuseApprovedSend(row, report, 'account credit would apply since the card was shown');
  const dunAppliedCredit = credit.applied;
  // The refresh runs in its OWN try: it is what keeps the reminder's
  // amounts/copy on the just-edited live row instead of the batch snapshot
  // (edits are fenced out from the claim onward, so this read is the settled
  // state) — a credit-helper failure above must not bypass it.
  try {
    const fresh = await db('invoices').where({ id: row.invoice_id })
      .first('total', 'credit_applied', 'amount_paid', 'status', 'title', 'token', 'due_date', 'invoice_number',
        'payer_id', 'scheduled_send_error');
    // FAIL CLOSED on an unreadable row (Codex #4311 r38 P1): this read is the
    // last-minute ownership backstop, and it sits inside a refresh block that
    // was written to fail OPEN for the price fields. Continuing on stale batch
    // data is exactly the case the backstop exists for, so a missing row stops
    // the touch and the sweep re-judges it next run.
    if (!fresh) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — invoice ${row.invoice_id} could not be re-read before the send`);
      return exitNoSend(report, 'not_sent', 'invoice_unreadable');
    }
    // OWNERSHIP AGAIN, on this last read before the provider (local audit):
    // the policy, credit and ledger work above is all awaited, and a Bill-To
    // assignment landing in that window would otherwise be invisible to this
    // already-claimed worker. The pause it wrote is authoritative; this send
    // simply stops.
    if (fresh && (fresh.payer_id || invoiceWithdrawnFromCustomer(fresh))) {
      logger.info(`[invoice-followups] dropped touch for sequence ${row.id} — invoice ${row.invoice_id} moved to a third-party payer during this run`);
      return exitNoSend(report, 'skipped', 'invoice_payer_billed');
    }
    if (fresh) {
      row.total = fresh.total;
      row.credit_applied = fresh.credit_applied;
      row.amount_paid = fresh.amount_paid;
      row.title = fresh.title;
      row.token = fresh.token;
      row.due_date = fresh.due_date;
      row.invoice_number = fresh.invoice_number;
      // The amount in the approved text and email: any other balance now is a different message.
      if (approvedAmountChanged(bar, approved, row)) return refuseApprovedSend(row, report, 'the amount due changed since the card was shown');
      if (['prepaid', 'paid'].includes(String(fresh.status || '').toLowerCase())) {
        await stopOnPayment(row.invoice_id).catch(() => {});
        return exitNoSend(report, 'skipped', 'invoice_not_eligible');
      }
    }
  } catch (refreshErr) {
    // FAIL CLOSED (Codex #4311 r38 P1): this block carries the last-minute
    // ownership backstop now, so an unreadable refresh can no longer fall
    // through to the provider on stale batch data — precisely when a Bill-To
    // change may have landed. The sequence keeps its schedule and the next
    // sweep re-judges it.
    logger.warn(`[invoice-followups] skipped sequence ${row.id} — invoice refresh before dun failed for ${row.invoice_id}: ${refreshErr.message}`);
    return exitNoSend(report, 'not_sent', 'invoice_unreadable');
  }
  // Dun for amount DUE (total − applied account credit), not the pre-credit total.
  const amount = invoiceAmountDue(row).toFixed(2);
  // ADMIN-BUG-R23: service_date is a DATE column, not an instant — formatting
  // it through an America/New_York instant formatter shifts a UTC-midnight
  // pg Date (TZ=UTC in production) to the PREVIOUS Eastern day. formatDateOnly
  // normalises to noon UTC first, matching the correct email-leg call one
  // line below at :196.
  const serviceDate = formatDateOnly(row.service_date, { fallback: '' });

  const payUrl = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${row.token}`, {
    kind: 'invoice', entityType: 'invoices', entityId: row.invoice_id, customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(row),
  });
  const ctx = {
    name: customer.first_name || 'there',
    invoiceTitle: row.title || 'your service',
    amount,
    serviceDate,
    payUrl,
    invoiceId: row.invoice_id,
  };

  // Divert micro-deposit-blocked invoices to a verification re-nudge: the customer
  // isn't ignoring the bill, they haven't confirmed their two ACH micro-deposits.
  // Swap this touch's message to the verification copy, matching the
  // webhook's one-time nudge, but keep the cadence so the re-nudge repeats on the
  // normal schedule until the PI clears (then the terminal-status filter stops it).
  // Email leg — policy-permitted only, with RECORD-THEN-SEND ledger
  // discipline: the collections_contact_ledger row precedes the delivery
  // attempt; an insert failure skips the leg (no unledgered contact, ever),
  // a definite failed delivery stamps send_failed, while an unknown outcome
  // keeps the claim held until delivery evidence can settle it.
  const ContactLedger = require('./collections/contact-ledger');
  const originalDeliveryTimes = [];
  const emailApproved = approvedLeg(bar, 'email');
  let emailResult = { ok: false, skipped: true, reason: emailApproved ? 'collections_policy_denied' : 'not_approved' };
  // A spacing-window denial keeps the selected Email owed on this step; a
  // durable one (flag, suppression) waives it so the step cannot be pinned
  // forever. The global-hold gate above still stops an all-denied touch.
  let emailHold = selectedChannels !== null && emailSelected && !emailPermitted && !emailDurablyDenied;
  // A dispute hold refused a leg at the send boundary after the preflight (a wait, not a failure).
  let holdSuppressedAtBoundary = false;
  if (emailPermitted && emailApproved) {
    let emailLedger = null;
    try {
      emailLedger = await ContactLedger.recordContact({
        customerId: customer.id,
        channel: 'email',
        purpose: mdPending ? 'payment_verification' : 'invoice_followup',
        invoiceIds: [row.invoice_id],
        source: 'invoice_followups',
        metadata: { step_id: step.id, notificationEventKey: followupEventKey(row, step) },
        ...(selectedChannels !== null ? { idempotencyKey: followupLedgerKey(row, step, 'email') } : {}),
      });
    } catch (ledgerErr) {
      emailResult = { ok: false, skipped: true, reason: 'ledger_unavailable' };
      logger.warn(`[invoice-followups] email leg skipped for sequence ${row.id} — contact ledger unavailable: ${ledgerErr.message}`);
    }
    if (emailLedger) {
      const claim = selectedChannels !== null && typeof ContactLedger.claimAttempt === 'function'
        ? await ContactLedger.claimAttempt(emailLedger) : { allowed: true };
      if (claim.delivered) {
        emailResult = { ok: true, deduped: true };
        if (emailLedger.occurred_at) originalDeliveryTimes.push(emailLedger.occurred_at);
      } else if (claim.resolved) {
        emailResult = {
          ok: false,
          delivered: false,
          skipped: true,
          resolved: true,
          reason: claim.resolution || 'prior_email_terminally_settled',
        };
      }
      else if (!claim.allowed) emailResult = { ok: false, deferred: true, reason: 'prior_email_outcome_unconfirmed' };
      else {
        emailResult = mdPending
          ? await sendMicrodepositVerificationEmail({
              invoice: { id: row.invoice_id, title: row.title, total: row.total, credit_applied: row.credit_applied, amount_paid: row.amount_paid },
              customer,
              touchKey: step.id, // one branded verification email per follow-up step (same cadence as the SMS)
              enforceBillingPreference: !operatorInitiated,
            })
          : await sendFollowupEmail({ row, customer, step, ctx, enforceBillingPreference: !operatorInitiated, ...approvedEmailChecks(bar, approved, expectedContentHash) });
        const attemptHeld = await settleFollowupEmailLedger(
          ContactLedger, emailLedger, emailResult, selectedChannels !== null, originalDeliveryTimes,
        );
        emailHold = emailHold || attemptHeld;
        if (heldByDisputeHold(emailResult)) holdSuppressedAtBoundary = true;
      }
    } else if (selectedChannels !== null) emailHold = true;
  }
  if (selectedChannels !== null && emailSelected && !emailDurablyDenied && emailResult.ok !== true
    && !terminalFollowupEmailRefusal(emailResult)) emailHold = true;

  let smsSent = false;
  let actualSmsSent = false;
  let appSent = false;
  let smsLeg = null;
  let smsSkipReason = null;
  let smsDeferUntil = null;
  let smsDeferredOwned = false;
  let smsOutcomeMayHaveDelivered = false;
  // The held SMS leg failed to reach the scheduled rail: nothing durable
  // owns it, so this touch must stay retryable (codex r21).
  let smsHoldUnowned = false;
  if (selectedChannels !== null) {
    const holdStep = (result = {}) => {
      smsHoldUnowned = true;
      const requested = result.nextAllowedAt ? new Date(result.nextAllowedAt) : null;
      const floor = heldTouchFloor();
      const at = requested && !Number.isNaN(requested.getTime()) && requested > floor ? requested : floor;
      if (!smsDeferUntil || at > smsDeferUntil) smsDeferUntil = at;
    };
    if (emailHold) holdStep();
    const permittedLegs = nonEmailChannels.filter((channel) => channelPolicy[channel] === true
      && (channel === 'push' || customer.phone));
    let body = null;
    if (permittedLegs.length) {
      body = await reminderSmsBody({ mdPending, ctx, step, row });
    }
    for (const channel of nonEmailChannels) {
      if (!channelPolicy[channel]) { smsSkipReason = 'collections_policy_denied'; continue; }
      if (channel === 'sms' && !customer.phone) { smsSkipReason = 'no_customer_phone'; continue; }
      if (!body) { smsSkipReason = 'missing_template'; continue; }
      let ledger;
      try {
        ledger = await ContactLedger.recordContact({
          customerId: customer.id, channel,
          purpose: mdPending ? 'payment_verification' : 'invoice_followup',
          invoiceIds: [row.invoice_id], source: 'invoice_followups',
          metadata: { step_id: step.id, notificationEventKey: followupEventKey(row, step) },
          idempotencyKey: followupLedgerKey(row, step, channel),
        });
      } catch (err) {
        smsSkipReason = 'ledger_unavailable';
        holdStep();
        logger.warn(`[invoice-followups] ${channel} ledger unavailable for sequence ${row.id}: ${err.message}`);
        continue;
      }
      const claim = typeof ContactLedger.claimAttempt === 'function'
        ? await ContactLedger.claimAttempt(ledger) : { allowed: true };
      if (claim.delivered) {
        smsSent = true;
        if (ledger.occurred_at) originalDeliveryTimes.push(ledger.occurred_at);
        continue;
      }
      if (!claim.allowed) { holdStep(); continue; }
      let result;
      try {
        result = await sendCustomerMessage({
          to: customer.phone, body, channel, audience: 'customer', purpose: 'payment_link',
          customerId: customer.id, invoiceId: row.invoice_id, entryPoint: 'invoice_followup_sequence',
          metadata: {
            original_message_type: mdPending ? 'bank_verification_incomplete' : 'invoice_followup',
            notificationEventKey: `invoice-followup:${row.id}:${step.id}`,
            billingDeliveryCategory: category, billingDeliveryLeg: channel,
            followup_sequence_id: row.id,
            rendered_amount: amount,
            collections_ledger_id: ledger.id,
            ...(channel === 'push' ? { appOnly: true } : {}),
          },
          hasEmailLeg: emailSelected,
          // An operator "send now" keeps its pay link during a dispute hold on EVERY Text/App leg
          // (owner ruling 2026-09-30), the same exemption the legacy single-SMS call carries.
          // (Today an operator send never resolves explicit channels, so this leg is only reached
          // by automated touches; the exemption is threaded so the two paths cannot diverge.)
          ...(operatorInitiated ? { operatorInitiated: true } : {}),
          ...(holdExempt ? { holdExempt } : {}),
          preDispatchCheck: followupDispatchCheck(row.invoice_id, bar),
        });
      } catch (err) {
        result = err.providerOutcome || { deliveryOutcome: 'uncertain', deferred: true };
      }
      const delivery = billingLegDeliveryState(channel, result || {});
      if (delivery) {
        const occurredAt = billingLegContactTime(result);
        smsSent = true;
        if (delivery === 'deduped' && occurredAt) originalDeliveryTimes.push(occurredAt);
        if (channel === 'push') appSent ||= delivery === 'delivered'; else actualSmsSent ||= delivery === 'delivered';
        if (typeof ContactLedger.markDelivered === 'function'
          && !await ContactLedger.markDelivered(ledger, ...(occurredAt ? [{ occurredAt }] : []))) holdStep();
      } else if (heldByDisputeHold(result)) {
        // Dispute hold landed after the preflight: a WAIT, never a failed send.
        await ContactLedger.releaseHeldReservation(ledger);
        holdStep(result);
        smsSkipReason = 'collection_hold';
        holdSuppressedAtBoundary = true;
      } else if (result?.deliveryOutcome === 'not_sent'
        || (result?.deliveryOutcome == null && result?.blocked === true)) {
        if (!await ContactLedger.markSendFailed(ledger, { code: result.code || 'not_sent' })) holdStep();
        if (result.retryable || result.deferred || result.code === 'CONSENT_LOOKUP_FAILED') holdStep(result);
        smsSkipReason = result.code || 'not_sent';
      } else {
        holdStep(result);
        smsSkipReason = 'outcome_unconfirmed';
      }
    }
    if (!nonEmailChannels.length) smsSkipReason = 'no_non_email_selected';
  } else if (!approvedLeg(bar, 'sms')) {
    // Not on the card: no text, whatever the customer's phone or the template says now.
    smsSkipReason = 'not_approved';
    smsLeg = { state: 'skipped', reason: 'not_approved' };
  } else if (!smsPermitted) {
    // Collections policy denial — transient; the no-channel branch below
    // leaves the sequence armed instead of pausing it.
    smsSkipReason = 'collections_policy_denied';
    smsLeg = { state: 'held', reason: 'collections_policy_denied' };
  } else if (customer.phone) {
    const messageType = mdPending ? 'bank_verification_incomplete' : 'invoice_followup';
    // An approved send uses the card's exact text (only the pay link token becomes the live link), never a re-resolved template.
    const body = bar ? bar.body.split(APPROVAL_PAY_LINK_TOKEN).join(ctx.payUrl) : await reminderSmsBody({ mdPending, ctx, step, row });
    if (!body) {
      smsSkipReason = 'missing_template';
      smsLeg = { state: 'skipped', reason: 'missing_template' };
      logger.warn(`[invoice-followups] template ${step.template_key} missing/disabled for sequence ${row.id}`);
    } else {
      // RECORD-THEN-SEND: the ledger row precedes the SMS attempt; an
      // insert failure skips the send (no unledgered contact, ever).
      let smsLedger = null;
      try {
        smsLedger = await ContactLedger.recordContact({
          customerId: customer.id,
          channel: 'sms',
          purpose: mdPending ? 'payment_verification' : 'invoice_followup',
          invoiceIds: [row.invoice_id],
          source: 'invoice_followups',
          metadata: { step_id: step.id, notificationEventKey: followupEventKey(row, step) },
        });
      } catch (ledgerErr) {
        smsSkipReason = 'ledger_unavailable';
        smsLeg = { state: 'skipped', reason: 'ledger_unavailable' };
        logger.warn(`[invoice-followups] SMS leg skipped for sequence ${row.id} — contact ledger unavailable: ${ledgerErr.message}`);
      }
      const sendResult = smsLedger ? await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'payment_link',
        customerId: customer.id,
        invoiceId: row.invoice_id,
        entryPoint: 'invoice_followup_sequence',
        // Send-window operator marker: only the admin "send now" route sets
        // it (an operator clicked THIS touch at this moment); the 10:16 ET
        // cron path stays fenced.
        ...(operatorInitiated ? { operatorInitiated: true } : {}),
        // The office "send now" click is a deliberate operator send: it keeps its pay link during a
        // dispute hold (owner ruling 2026-09-30), so the customer-message boundary lets it through.
        // Automated ladder touches carry no exemption and wait.
        ...(holdExempt ? { holdExempt } : {}),
        metadata: {
          original_message_type: messageType,
          notificationEventKey: `invoice-followup:${row.id}:${step.id}`,
          billingDeliveryCategory: mdPending ? 'payment_issue' : 'invoice',
          followup_sequence_id: row.id,
          rendered_amount: amount,
          collections_ledger_id: smsLedger.id,
        },
        hasEmailLeg: true,
        // The LAST ownership check, run by the canonical sender immediately
        // before provider preparation (Codex #4311 r42 P1): the short-link
        // round-trip and the contact-ledger writes are awaited after the
        // re-read above, and this rail holds no claim a Bill-To writer
        // fences on. Fail-closed, with no lock held across provider I/O.
        preDispatchCheck: followupDispatchCheck(row.invoice_id, bar),
      }) : null;
      if (sendResult && heldByDisputeHold(sendResult)) {
        // Dispute hold landed after the preflight: nothing was sent and nothing failed. Release the
        // reservation and keep the touch due (retimed a day, like the preflight hold) - never
        // paused, never queued onto the scheduled-SMS rail (the queued row would carry the pay link).
        await ContactLedger.releaseHeldReservation(smsLedger);
        smsSkipReason = 'collection_hold';
        smsLeg = { state: 'held', reason: 'collection_hold' };
        smsDeferUntil = heldTouchFloor();
        smsHoldUnowned = true;
        holdSuppressedAtBoundary = true;
        logger.info(`[invoice-followups] SMS leg of sequence ${row.id} held by a collections dispute hold at the send boundary — touch stays due`);
      } else if (sendResult && (sendResult.blocked || sendResult.sent === false)) {
        smsOutcomeMayHaveDelivered = ['accepted', 'uncertain'].includes(sendResult.deliveryOutcome);
        await ContactLedger.markSendFailed(smsLedger, { code: sendResult.code || 'sms_blocked' });
        smsSkipReason = sendResult.code || 'sms_blocked';
        // Send-window block (this cron runs hourly, incl. nights): not a
        // delivery failure — remember the window open so the no-channel
        // branch below defers the touch instead of pausing the sequence.
        if (sendResult.deferred && sendResult.nextAllowedAt) {
          const at = new Date(sendResult.nextAllowedAt);
          if (!Number.isNaN(at.getTime())) smsDeferUntil = at;
          // Email already carried this touch: the no-channel defer below
          // won't run and step_index advances, so the held SMS leg must be
          // persisted NOW or it is never retried. Queue the exact rendered
          // body on the scheduled-SMS rail for the window open — one
          // enqueue per touch fire. An enqueue FAILURE leaves the pay-link
          // text with no owner at all, so the step is held back for a
          // retry instead of advancing (the email's per-step idempotency
          // key dedupes its leg on the re-fire).
          if (smsDeferUntil && emailResult.ok) {
            try {
              const TWILIO_NUMBERS = require('../config/twilio-numbers');
              await db('sms_log').insert({
                customer_id: customer.id,
                direction: 'outbound',
                from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                to_phone: customer.phone,
                message_body: body,
                status: 'scheduled',
                scheduled_for: smsDeferUntil,
                message_type: messageType,
                metadata: JSON.stringify({
                  entry_point: 'invoice_followup_deferred',
                  original_message_type: messageType,
                  invoice_id: row.invoice_id,
                  customer_id: customer.id,
                  // Minted ONCE at enqueue: the replay's delivery-time
                  // ledger reservation is keyed to it, so executor retries
                  // of this same queued row can never double-count.
                  ledger_reservation_key: require('crypto').randomUUID(),
                  followup_sequence_id: row.id,
                  notificationEventKey: `invoice-followup:${row.id}:${step.id}`,
                  billingDeliveryCategory: mdPending ? 'payment_issue' : 'invoice',
                  hasEmailLeg: true,
                  original_block_code: sendResult.code,
                  replay_purpose: 'payment_link',
                  // The amount the frozen body NAMES (codex r27): credit
                  // applied/reversed overnight changes the balance while
                  // the invoice stays collectible — the replay suppresses
                  // on mismatch and the sequence's next touch re-renders.
                  rendered_amount: amount,
                  refresh_customer_phone: true,
                  resolve_from_by_customer: true,
                }),
              });
              smsDeferredOwned = true;
              logger.info(`[invoice-followups] SMS leg of sequence ${row.id} held outside the 8AM-8PM ET send window — queued for ${smsDeferUntil.toISOString()} (email leg delivered)`);
            } catch (queueErr) {
              smsHoldUnowned = true;
              logger.error(`[invoice-followups] Held SMS requeue failed for sequence ${row.id}: ${queueErr.message} — holding the step for retry at the window open (email leg already delivered, idempotency-keyed)`);
            }
          }
        }
        smsLeg = blockedSmsLeg(sendResult, { smsDeferredOwned, smsOutcomeMayHaveDelivered });
        logger.warn(`[invoice-followups] SMS blocked for sequence ${row.id}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
      } else if (sendResult) {
        smsSent = true;
        actualSmsSent = true;
        // The sender answers { sent: true, deduped: true } for a text it delivered earlier (the original acceptance): that is
        // not a new delivery.
        smsLeg = sendResult.deduped === true ? { state: 'already_delivered' } : { state: 'sent' };
      }
    }
  } else {
    smsSkipReason = 'no_customer_phone';
    smsLeg = { state: 'skipped', reason: 'no_customer_phone' };
    logger.warn(`[invoice-followups] no phone for customer ${row.customer_id}`);
  }
  fillLegReport(report, {
    smsLeg, emailResult, emailPermitted, actualSmsSent, appSent, smsSent, smsSkipReason, smsOutcomeMayHaveDelivered, smsHoldUnowned,
  });

  if (!smsSent && !emailResult.ok) {
    // A retryable email outcome (the shared billing email check could not
    // authorize this touch yet) holds the step for any customer, not only an
    // explicit channel selection: a customer with no explicit choice and no
    // phone would otherwise fall to the pause below and lose every remaining
    // follow-up over one transient refusal.
    if (!smsDeferUntil && (emailResult.retryable === true || emailResult.deferred === true)) {
      smsDeferUntil = heldTouchFloor();
    }
    if (smsDeferUntil) {
      if (holdSuppressedAtBoundary) {
        logger.info(`[invoice-followups] touch for sequence ${row.id} held by a collections dispute hold at the send boundary — kept due until ${smsDeferUntil.toISOString()}`);
      }
      // Nothing failed — the touch fired outside the 8AM-8PM ET send
      // window and no email leg covered it. Keep the sequence active and
      // move ONLY this touch to the window open; the same step re-fires at
      // 8:00 AM with a fresh credit draw (tonight's is reversed below,
      // same as the pause branch — nothing was delivered).
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        next_touch_at: smsDeferUntil,
      });
    } else if (
      ['collections_policy_denied', 'ledger_unavailable'].includes(smsSkipReason)
      || ['collections_policy_denied', 'ledger_unavailable'].includes(emailResult.reason)
    ) {
      // Transient collections-policy denial / ledger outage — NOT a
      // delivery failure. Keep the sequence active (no status write) and
      // retime it to the next day so a later tick re-decides; pausing
      // terminally here would turn a 24h frequency window into a
      // permanently silenced sequence, and leaving the row due would let the
      // daily tick's stale grace skip the step instead of retrying it.
      // Classified by what ACTUALLY happened on each leg: the email result's
      // default reason reads 'collections_policy_denied' even when Email was
      // never selected, so it only counts while a leg really has a transient
      // denial or outage. A terminal outcome on one leg (SMS non-mobile,
      // blocked) never discards another leg's transient denial: the email
      // leg must still be retried once its window passes (Codex #5404 r2 P1).
      if (hasTransientLeg({ policyChannels, policyResults, smsSkipReason, emailResult })) {
        await holdTouchUntilNextDay(row, claimStamp, smsSkipReason || emailResult.reason, { operatorInitiated });
      }
      logger.info(`[invoice-followups] touch for sequence ${row.id} handled by collections policy/ledger — retrying on a later run`);
    } else {
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        status: 'paused',
        paused_reason: smsSkipReason || emailResult.reason || emailResult.error || 'no_channel_delivered',
        next_touch_at: null,
      });
    }
    // No reminder went out — reverse the credit THIS dun drew down so we don't consume
    // it for an undelivered touch (matches the invoice/project send rollback). Only
    // this dun's increment; any prior applied credit stays. The invoice is collectible
    // here, so reverseAppliedCredit (which refuses 'sending'/'prepaid') applies.
    await reverseDunCredit(row.invoice_id, dunAppliedCredit, 'undelivered dun');
    return;
  }

  // Held SMS with no durable owner (codex r21): the email carried its own
  // leg, but advancing step_index here would retire a pay-link text that
  // was never queued and is never retried. Keep THIS step current and move
  // the touch to the window open — the re-fire re-renders the SMS and
  // re-attempts the enqueue, while the email's per-step idempotency key
  // (invoice_followup_email:<invoice>:<step>) suppresses a second email.
  // No credit reversal: unlike the nothing-delivered defer above, the email
  // leg DID deliver against this draw.
  if (smsHoldUnowned && smsDeferUntil) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      next_touch_at: smsDeferUntil,
    });
    logger.warn(`[invoice-followups] sequence ${row.id} step ${row.step_index} held at its current index — the deferred SMS leg never reached the rail; retrying at ${smsDeferUntil.toISOString()}`);
    return;
  }

  const freshDelivery = actualSmsSent || appSent || (emailResult.ok && !emailResult.deduped);
  const originalAt = latestDeliveryAt(originalDeliveryTimes, row.last_touch_at);
  // Only an earlier accepted leg reached the customer on this path. Return
  // this run's credit draw; the previous attempt's applied credit stays put.
  if (!freshDelivery && !smsDeferredOwned && !smsOutcomeMayHaveDelivered) {
    await reverseDunCredit(row.invoice_id, dunAppliedCredit, 'prior-delivery replay');
  }
  await advanceAfterTouch({ row, verificationOnly, claimStamp, freshDelivery, originalAt });

  // (Contact-ledger rows were written BEFORE each leg's delivery attempt —
  // record-then-send, codex 2026-08-14 — so there is nothing to record here.)

  // Day 60/90 (Day 90 ladder, GATE_DUNNING_LADDER_90) owns the at-risk stamp
  // for these debt-age tiers (it took it over from the retired balance
  // reminder, Codex P2, dunning unification). Stamped here — ABOVE
  // the freshDelivery early return below — because reaching this point
  // already means a channel confirmed delivery, fresh OR deduped (the
  // no-channel-delivered branch above returns before here). A dun replay
  // that only re-confirms an already-delivered leg (freshDelivery === false)
  // still owes this stamp (Codex P2, round 2): a deduped Day 60/90 replay
  // must not lose the transition.
  // Guarded (Codex P1): the sequence has already advanced above and the
  // customer already has the message — a transient failure on this
  // best-effort lifecycle stamp must never throw out of fireTouch and cost
  // the step advance / interaction logging below, or strand the sequence on
  // this step for as long as the stamp keeps failing. Same reasoning
  // the retired late-payment checker's callers used.
  // Only while the Day 90 ladder is live.
  // Never for a bank-verification nudge (mdPending): that customer is
  // completing a payment, and a pending microdeposit is a dunning stop
  // (Codex #5294 r2 P1).
  if (ladderThrough90Live() && !mdPending
    && (step.id === 'd60_reminder' || step.id === 'd90_final_notice')) {
    try {
      await markAtRiskForLongOverdue(row.customer_id);
    } catch (stampErr) {
      logger.warn(`[invoice-followups] at-risk stamp failed for customer ${row.customer_id} (sequence ${row.id}): ${stampErr.message}`);
    }
  }

  // An already delivered leg advances its step without a new outbound touch.
  if (!freshDelivery) return;

  // Log to customer_interactions for the 360 view
  try {
    await db('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: selectedChannels === null || actualSmsSent ? 'sms_outbound'
        : appSent ? 'app_outbound' : 'email_outbound',
      subject: `Invoice follow-up — ${step.label} (${row.invoice_number || row.invoice_id})`,
      body: `Step ${row.step_index + 1}/${followupSteps().length} fired. Amount: $${amount}.`,
      metadata: JSON.stringify({
        invoice_id: row.invoice_id,
        step_id: step.id,
        step_index: row.step_index,
        sms_sent: actualSmsSent,
        app_sent: appSent,
        email_sent: !!emailResult.ok,
        email_reason: emailResult.reason || emailResult.error || null,
      }),
    });
  } catch { /* non-critical */ }
}

/**
 * Called from the Stripe webhook the instant an invoice is paid.
 * Marks the sequence completed and optionally sends a thank-you.
 */
async function stopOnPayment(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq) return;
  if (seq.status === 'completed' || seq.status === 'stopped') return;

  const sentAReminder = seq.touches_sent > 0;

  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'completed',
    next_touch_at: null,
  });

  if (sentAReminder && config.thankYou.enabled) {
    try {
      const customer = await db('customers').where({ id: seq.customer_id }).first();
      const invoice = await db('invoices').where({ id: invoiceId }).first();
      if (customer?.phone) {
        const payUrl = invoice?.token
          ? await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
              kind: 'invoice',
              entityType: 'invoices',
              entityId: invoice.id,
              customerId: customer.id,
              codePrefix: invoiceShortCodePrefix(invoice),
            })
          : '';
        const body = await resolveBody(config.thankYou, {
          name: customer.first_name,
          payUrl,
        });
        if (!body) {
          logger.warn(`[invoice-followups] thank-you template ${config.thankYou.template_key} missing/disabled — skipping for invoice ${invoiceId}`);
        } else {
          const sendResult = await sendCustomerMessage({
            to: customer.phone,
            body,
            channel: 'sms',
            audience: 'customer',
            purpose: 'payment_receipt',
            customerId: customer.id,
            invoiceId,
            entryPoint: 'invoice_followup_thank_you',
            metadata: { original_message_type: 'invoice_thank_you' },
          });
          if (sendResult.blocked || sendResult.sent === false) {
            // Send-window hold: this is event-driven (the payment just
            // landed) and the sequence is already marked completed —
            // nothing retries, so queue the thank-you for 8:00 AM. A paid
            // invoice's acknowledgment can't go stale, so no recheck.
            if (sendResult.code === 'QUIET_HOURS_HOLD' && sendResult.deferred && sendResult.nextAllowedAt) {
              try {
                const TWILIO_NUMBERS = require('../config/twilio-numbers');
                await db('sms_log').insert({
                  customer_id: customer.id,
                  direction: 'outbound',
                  from_phone: TWILIO_NUMBERS.getOutboundNumber(),
                  to_phone: customer.phone,
                  message_body: body,
                  status: 'scheduled',
                  scheduled_for: new Date(sendResult.nextAllowedAt),
                  message_type: 'invoice_thank_you',
                  metadata: JSON.stringify({
                    entry_point: 'invoice_followup_thank_you_deferred',
                    invoice_id: invoiceId,
                    original_block_code: sendResult.code,
                    replay_purpose: 'payment_receipt',
                    refresh_customer_phone: true,
                    resolve_from_by_customer: true,
                  }),
                });
                logger.info(`[invoice-followups] thank-you SMS for invoice ${invoiceId} held outside the 8AM-8PM ET send window — queued for ${sendResult.nextAllowedAt}`);
              } catch (queueErr) {
                logger.error(`[invoice-followups] held thank-you requeue failed for invoice ${invoiceId}: ${queueErr.message}`);
              }
            } else {
              logger.warn(`[invoice-followups] thank-you SMS blocked for invoice ${invoiceId}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[invoice-followups] thank-you SMS failed: ${err.message}`);
    }
  }
}

/**
 * Release an autopay-held sequence into the active queue — call from the
 * ACH failure handler after failures cross the threshold.
 */
async function releaseFromAutopayHold(invoiceId) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || seq.status !== 'autopay_hold') return;

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  // CONDITIONAL on the status the reads observed (Codex #3493 r14): an
  // unvoid's lifecycle stop (or any other writer) can land between the
  // unlocked reads above and this write — an unconditional update would
  // overwrite that stop with an active cadence and dun a restored draft.
  // A lost release is safe: the sequence stays held/stopped and the next
  // legitimate transition owns it.
  await db('invoice_followup_sequences').where({ id: seq.id, status: 'autopay_hold' }).update(autopayReleaseFields(seq, invoice));
}

// The fields an Auto Pay hold release writes (releaseFromAutopayHold, and the timeout's guarded release).
function autopayReleaseFields(seq, invoice) {
  return {
    updated_at: db.fn.now(),
    status: 'active',
    is_autopay_held: false,
    // A shifted anchor (delivered-invoice due-date edit while held) wins so
    // the re-armed step lands on the same timeline fireStep progression uses.
    next_touch_at: computeNextTouchAt(seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at, seq.step_index),
  };
}

// GATE_AUTOPAY_HOLD_TIMEOUT. A hold is released only by an Auto Pay failure, and Auto Pay never
// charges some invoices (an annual-prepay invoice staff created after a visit), so such a hold
// never ends. A hold older than this with no charge activity since it began is released.
const AUTOPAY_HOLD_TIMEOUT_DAYS = 3;
const AUTOPAY_HOLD_SWEEP_PAGE = 500;
const AUTOPAY_HOLD_SHADOW_ACTION = 'invoice_followup.autopay_hold_timeout_shadow';
const AUTOPAY_HOLD_CHARGE_ACTION = 'invoice_followup.autopay_hold_timeout_charge';
// Written (and committed) right before the charge is called. The final AUTOPAY_HOLD_CHARGE_ACTION row is the
// LAST write of a finished attempt, so a marker with no later final row is an attempt that did not finish.
const AUTOPAY_HOLD_CHARGE_STARTED_ACTION = 'invoice_followup.autopay_hold_timeout_charge_started';
// chargeInvoiceWithSavedCard codes after which money may have moved or a charge is still being settled:
// never release the hold, never retry, tell the office to check Stripe.
const AUTOPAY_HOLD_AMBIGUOUS_CODES = [
  'STRIPE_CHARGED_DB_FAILED', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_CHARGE_ATTEMPT_FENCE_LOST',
];
// chargeInvoiceWithSavedCard's requireBankDebitDue refusal: the bank debit date has not arrived (stripe.js). Raised
// before any credit apply or Stripe call, so the charge path releases its claim and the attempt row keeps only the
// message (decline_code null): the recovery pass recognises the refusal by BANK_DEBIT_NOT_DUE_PATTERN.
const BANK_DEBIT_NOT_DUE_CODE = 'BANK_DEBIT_NOT_DUE';
const BANK_DEBIT_NOT_DUE_PATTERN = /Bank debit date has not arrived/i;
// A payments row that is money a person took, not Auto Pay acting: paid, with no gateway (processor), charge or
// PaymentIntent. recordManualPayment writes exactly this for cash, check, Zelle, Venmo, PayPal and other, and so do
// the prepaid-credit rows (complete-scheduled-service, admin-schedule) and the check/cash branch of the payment
// reconcile. Every Auto Pay and pay-page writer (stripe.js, pay-combined, the Stripe webhook, billing-cron's
// failed or deferred monthly rows) sets processor 'stripe' or a Stripe id, or is not 'paid', so it still blocks.
const OFF_GATEWAY_PAID_TENDER = "p.status = 'paid' AND p.processor IS NULL AND p.stripe_charge_id IS NULL AND p.stripe_payment_intent_id IS NULL";

// An invoice an annual-prepay term references (annual_prepay_terms.prepay_invoice_id, unique per invoice) is governed
// by a dedicated rail: termite-annual-renewal-charge.js (renewalChargeCeiling: signed flat-fee cap, surcharge rule,
// renewal gate), termite-annual-signature-charge.js (signed agreement) and recurring-card-on-file.js (the deferred
// prepay) all charge through that one column, and no other annual_prepay_terms column names an invoice. The hold
// sweep never charges these (it has none of those authorizations); charge mode releases them as 'true' does.
function annualPrepayTermRail() {
  this.select(db.raw('1')).from('annual_prepay_terms as apt').whereRaw('apt.prepay_invoice_id = s.invoice_id');
}

/**
 * The SQL half of the timeout rule, on a builder over `invoice_followup_sequences as s`. The sweep's
 * select finds candidates with it, and the release applies it again inside its UPDATE, so a failure
 * bump, payment, retry, plan, visit or schedule that lands in between keeps the hold.
 * - the hold began (updated_at: every hold writer, and handleAutopayFailure's counter bump, stamps it)
 *   before the cutoff;
 * - no stripe_invoice_charge_attempts row for the invoice at all (any age, any state: an attempt means
 *   Auto Pay acted, and an unresolved one still needs its reconciliation);
 * - no payments row (any status) for the customer created since the hold began, other than an off-gateway
 *   paid tender (see OFF_GATEWAY_PAID_TENDER: cash, check, Zelle and the like), and no failed one still on
 *   billing-cron's retry ladder (next_retry_at set);
 * - no active payment plan for the invoice;
 * - no linked visit that is still open (Auto Pay charges when the visit closes: an invoice sent before
 *   its visit is waiting for that charge);
 * - no open customer-level schedule for the customer (that engine owns its reminders: it promotes only
 *   `active` rows, so a hold it never touched would otherwise sit, but a row it owns is judged by it).
 */
function staleAutopayHoldClause(query, cutoff, { chargeMode = false, afterOwnCharge = false, holdStamp = null, termRail = null } = {}) {
  // Three rule sets for the money rules (attempts, payments); every other rule is shared:
  // - default ('true' and 'shadow'): no attempt row at all, no payment for the customer since the hold began
  //   other than an off-gateway paid tender;
  // - chargeMode (GATE_AUTOPAY_HOLD_TIMEOUT=charge candidates): chargeModeAttemptRule + chargeModePaymentRules +
  //   no active dispute hold (the charge would refuse it, see collections/collection-hold.js) + chargeModeUnreviewedRule;
  // - afterOwnCharge (with the observed holdStamp): the sweep itself called the charge on this invoice and it
  //   failed cleanly, so ONLY the rows that charge wrote are exempt: a 'failed' attempt (not
  //   authentication_required) and a 'failed' payment. The age rule and the hold-stamp equality are dropped (the
  //   charge can bump updated_at); the invoice-specific and in-flight payment rules apply since the hold stamp.
  // termRail ('only' | 'none' | null) splits the holds by the dedicated annual-prepay rails (see annualPrepayTermRail):
  // charge mode releases the 'only' set as 'true' does and charges the 'none' set. Not used by 'true' or 'shadow'.
  const base = query.where('s.status', 'autopay_hold');
  if (afterOwnCharge) {
    if (!holdStamp) throw new Error('afterOwnCharge needs the observed holdStamp');
    base
      .whereNotExists(function noOpenChargeAttempt() {
        // A 'failed' attempt that asks the customer to authenticate (authentication_required) leaves a live
        // PaymentIntent the customer can still complete, so it blocks the release like an open attempt does.
        this.select(db.raw('1')).from('stripe_invoice_charge_attempts as a')
          .whereRaw('a.invoice_id = s.invoice_id')
          .whereRaw("(a.status IS DISTINCT FROM 'failed' OR a.decline_code = 'authentication_required')");
      });
    chargeModePaymentRules(base, '?::timestamptz', [holdStamp]);
  } else if (chargeMode) {
    base.where('s.updated_at', '<', cutoff)
      .whereNotExists(function noActiveDisputeHold() {
        require('./collections/collection-hold').disputeHoldExistsSql(this, 's.customer_id');
      });
    chargeModeAttemptRule(base);
    chargeModeUnreviewedRule(base);
    chargeModePaymentRules(base, 's.updated_at', []);
  } else {
    base
      .where('s.updated_at', '<', cutoff)
      .whereNotExists(function noChargeAttempt() {
        this.select(db.raw('1')).from('stripe_invoice_charge_attempts as a')
          .whereRaw('a.invoice_id = s.invoice_id');
      })
      .whereNotExists(function noPayment() {
        this.select(db.raw('1')).from('payments as p')
          .whereRaw('p.customer_id = s.customer_id')
          .whereRaw('p.created_at >= s.updated_at')
          .whereRaw(`NOT (${OFF_GATEWAY_PAID_TENDER})`);
      });
  }
  if (termRail) base[termRail === 'only' ? 'whereExists' : 'whereNotExists'](annualPrepayTermRail);
  return base
    .whereNotExists(function noPendingRetry() {
      this.select(db.raw('1')).from('payments as r')
        .whereRaw('r.customer_id = s.customer_id')
        .where('r.status', 'failed')
        .whereNotNull('r.next_retry_at');
    })
    .whereNotExists(function noActivePaymentPlan() {
      this.select(db.raw('1')).from('payment_plans as pp')
        .whereRaw('pp.invoice_id = s.invoice_id')
        .where('pp.status', 'active');
    })
    .whereNotExists(function noOpenVisit() {
      this.select(db.raw('1')).from('invoices as vi')
        .join('scheduled_services as v', 'v.id', 'vi.scheduled_service_id')
        .whereRaw('vi.id = s.invoice_id')
        .where(function openVisit() {
          this.whereNotIn('v.status', TERMINAL_SCHEDULED_SERVICE_STATUSES).orWhereNull('v.status');
        });
    })
    .where(notOwnedByCustomerSchedule);
}

// The facts the visit-bill verdict (visitBillVerdict) reads, as one hash: the invoice's subtotal, discount, total and
// payer, the visit's price, payer and prepayment stamp (prepaid_amount, prepaid_method), and the customer's per-application fee, dues rate, billing mode and payer. An
// office review is stored with this hash, and the same SQL reads it again, so an unchanged bill is not reviewed twice
// and a changed one is (a new event). The caller names the invoice and customer columns (`s.invoice_id`, `s.customer_id`).
function chargeFactsFingerprintSql(invoiceRef, customerRef) {
  const field = (column) => `COALESCE(${column}::text, '~')`;
  return `(SELECT md5(concat_ws('|', ${[
    'fi.subtotal', 'fi.discount_amount', 'fi.total', 'fi.payer_id', 'fv.estimated_price', 'fv.primary_line_price', 'fv.payer_id',
    'fv.prepaid_amount', 'fv.prepaid_method',
    'fc.per_application_fee', 'fc.monthly_rate', 'fc.billing_mode', 'fc.payer_id',
  ].map(field).join(', ')}))
    FROM invoices fi
    LEFT JOIN scheduled_services fv ON fv.id = fi.scheduled_service_id
    LEFT JOIN customers fc ON fc.id = ${customerRef}
    WHERE fi.id = ${invoiceRef})`;
}

// Charge mode, attempts: any attempt row excludes the invoice (an attempt means Auto Pay acted and an unresolved
// one still needs its reconciliation), EXCEPT a 'failed' attempt covered by a final audit row written after it:
// 'deferred' (a collection-hold refusal, retryable once the hold clears) or 'review' whose fingerprint no longer matches
// the bill (a refusal the office has since changed the bill for: one retry per change).
function chargeModeAttemptRule(base) {
  return base.whereNotExists(function noUncoveredAttempt() {
    this.select(db.raw('1')).from('stripe_invoice_charge_attempts as a')
      .whereRaw('a.invoice_id = s.invoice_id')
      .whereRaw(
        `NOT (COALESCE(a.status, '') = 'failed' AND EXISTS (
          SELECT 1 FROM audit_log d WHERE d.action = ? AND d.resource_id = s.invoice_id AND a.created_at <= d.created_at
            AND (d.metadata->>'outcome' = 'deferred'
              OR (d.metadata->>'outcome' = 'review' AND d.metadata->>'fingerprint' IS DISTINCT FROM ${chargeFactsFingerprintSql('s.invoice_id', 's.customer_id')}))))`,
        [AUTOPAY_HOLD_CHARGE_ACTION],
      );
  });
}

// Charge mode, office review: a hold whose newest final row is a 'review' of the SAME facts is not a candidate. The
// office was told once; only a changed bill or visit price (a new fingerprint) is evaluated again.
function chargeModeUnreviewedRule(base) {
  return base.whereNotExists(function noUnchangedReview() {
    this.select(db.raw('1')).from('audit_log as r')
      .where('r.action', AUTOPAY_HOLD_CHARGE_ACTION)
      .whereRaw('r.resource_id = s.invoice_id')
      .whereRaw("r.metadata->>'outcome' = 'review'")
      .whereRaw(`r.metadata->>'fingerprint' = ${chargeFactsFingerprintSql('s.invoice_id', 's.customer_id')}`)
      .whereNotExists(function noLaterFinalRow() {
        this.select(db.raw('1')).from('audit_log as l')
          .where('l.action', AUTOPAY_HOLD_CHARGE_ACTION)
          .whereRaw('l.resource_id = r.resource_id')
          .whereRaw('l.created_at > r.created_at');
      });
  });
}

// Charge mode, payments. A customer's settled payment for a SIBLING invoice no longer blocks (charging the first
// held invoice would otherwise disqualify the rest of that customer's holds for good). Two rules instead:
//  (a) no non-failed payment for THIS invoice since the hold (the charge path writes both metadata.invoice_id and
//      "Invoice <number>" in the description);
//  (b) no in-flight (processing / pending) payment for the customer since the hold, for any invoice.
// `since` is the SQL for the hold start: s.updated_at for candidates, the observed hold stamp after a charge.
function chargeModePaymentRules(base, since, bindings) {
  return base
    .whereNotExists(function noOwnInvoicePayment() {
      this.select(db.raw('1')).from('payments as p')
        .whereRaw('p.customer_id = s.customer_id')
        .whereRaw(`p.created_at >= ${since}`, bindings)
        .whereRaw("p.status IS DISTINCT FROM 'failed'")
        .whereRaw("(p.metadata->>'invoice_id' = s.invoice_id::text OR p.description ILIKE '%' || (SELECT ci.invoice_number FROM invoices ci WHERE ci.id = s.invoice_id) || '%')");
    })
    .whereNotExists(function noInFlightPayment() {
      this.select(db.raw('1')).from('payments as p')
        .whereRaw('p.customer_id = s.customer_id')
        .whereRaw(`p.created_at >= ${since}`, bindings)
        .whereIn('p.status', ['processing', 'pending']);
    });
}

// The office hears once per released invoice, a day or more before its first reminder, so a person can charge
// the card on file first (owner 2026-10-29). The key carries the hold's own stamp: one alert per invoice and
// hold episode, and a re-run finds the row active and never reaches here. Best effort: alertStaff never throws.
// `landing` null = every step's day has passed, so the released row completes without a reminder.
async function alertAutopayHoldReleased(row, invoice, landing) {
  const due = `invoice ${invoice.invoice_number} ($${invoiceHelpers.invoiceAmountDue(invoice).toFixed(2)})`;
  await require('./customer-dunning/schedule').alertStaff({
    verb: 'charge the card on file',
    generic: 'charge a customer\'s card on file',
    short: true,
    why: landing
      ? `Auto Pay did not charge ${due}; reminders start ${formatETDayDate(landing.nextAt)}.`
      : `Auto Pay did not charge ${due}, and no reminder steps are left to send.`,
    doneWhen: 'invoice_charged',
    dedupeKey: `autopay-hold-timeout:${row.invoice_id}:${row.hold_stamp}`,
    customerId: row.customer_id,
    metadata: { invoice_id: row.invoice_id, sequence_id: row.id },
  });
}

// The timeout's release: releaseFromAutopayHold's fields, except the first touch lands no earlier than the next
// send-window run (adoptionLanding, the rule promotion uses): releasing in the run that then sends would give the
// office no day to charge the card first. Written only while the row is still the hold the sweep observed (the
// same updated_at, to the microsecond, compared as text so no JS Date rounding enters) and the whole SQL rule
// still holds in the same statement. Returns whether it released.
// Charge mode options: chargeMode (its candidate rules), afterOwnCharge (the sweep's own charge failed cleanly:
// the hold stamp is not compared, see staleAutopayHoldClause), alert false (charge mode raises its own alert).
async function releaseStaleAutopayHold(row, cutoff, now = new Date(), { chargeMode = false, afterOwnCharge = false, alert = true } = {}) {
  const seq = await db('invoice_followup_sequences').where({ id: row.id }).first('anchor_at', 'step_index');
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!seq || !invoice || isTerminalInvoice(invoice) || followupArmBlock(invoice)) return false;
  const fields = autopayReleaseFields(seq, invoice);
  const landing = adoptionLanding(seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at, now, seq.step_index);
  const guarded = staleAutopayHoldClause(db('invoice_followup_sequences as s'), cutoff, { chargeMode, afterOwnCharge, holdStamp: row.hold_stamp })
    .where('s.id', row.id);
  // The hold's own stamp is compared only when no charge was called: a called charge can move updated_at.
  if (!afterOwnCharge) guarded.whereRaw('s.updated_at = ?::timestamptz', [row.hold_stamp]);
  const count = await guarded.update(landing ? { ...fields, step_index: landing.stepIndex, next_touch_at: landing.nextAt } : fields);
  if (count > 0 && alert) await alertAutopayHoldReleased(row, invoice, landing);
  return count > 0;
}

// ---- GATE_AUTOPAY_HOLD_TIMEOUT=charge (owner 2026-10-28, "Charge the saved card") -------------------------

const cents = (dollars) => Math.round((Number(dollars) || 0) * 100);
const moneyLabel = (amountCents) => `$${(amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// What a failed charge call means. 'ambiguous': money may have moved or a charge is still settling (the
// codes the charge path documents, a reconciliation flag, or a decline that leaves a live PaymentIntent for
// the customer to finish: authentication_required). 'declined': a real processor decline. 'refused': any
// other refusal, which the charge path raises before it submits anything to Stripe. 'not_due': the bank debit
// date has not arrived (quiet: retried on a later run).
function classifyAutopayHoldChargeError(err) {
  const code = err && err.code;
  // A collection-hold refusal is retryable and was never attempted (collections/collection-hold.js): deferred.
  if (require('./collections/collection-hold').isCollectionHoldRefusal(err)) return 'deferred';
  // A bank debit before the invoice's due date was refused under the lock, also before anything reached Stripe.
  if (code === BANK_DEBIT_NOT_DUE_CODE) return 'not_due';
  if (AUTOPAY_HOLD_AMBIGUOUS_CODES.includes(code) || err?.reconciliationRequired === true) return 'ambiguous';
  if (err?.wavesCardDecline?.declineCode === 'authentication_required') return 'ambiguous';
  if (err?.wavesCardDecline || code === 'STRIPE_CHARGE_FAILED') return 'declined';
  return 'refused';
}

// True when a charge attempt for the invoice is still open or settled. The stale-hold rule guarantees the
// invoice had no attempt row before this sweep charged it, so any row that is not 'failed' is ours and means
// the outcome is not a clean refusal. A read that fails reads as open: the safe direction is to not release.
async function invoiceHasOpenChargeAttempt(invoiceId) {
  try {
    const open = await db('stripe_invoice_charge_attempts')
      .where({ invoice_id: invoiceId })
      .whereNot('status', 'failed')
      .first('id');
    return Boolean(open);
  } catch (err) {
    logger.error(`[invoice-followups] autopay hold charge: could not read the charge attempt for invoice ${invoiceId}: ${err.message}`);
    return true;
  }
}

// Office-alert copy per kind. The alert goes out BEFORE the release and the final audit row (applyAutopayHoldPlan),
// so its copy never claims a release already happened. `why` is one sentence of at most 110 characters.
const AUTOPAY_HOLD_REASON_TEXT = {
  declined: 'the card was declined',
  refused: 'Auto Pay refused the charge',
  no_method: 'no Auto Pay card or bank is on file',
  over_cap: 'the bill is above the visit price the customer agreed to',
  no_cap: 'no agreed visit price or dues rate is on file to cap the charge',
  not_performed: 'the visit is not a finished, performed visit',
  payer: 'the bill goes to a third-party payer',
  prepaid: 'the visit carries a prepayment the bill does not show',
};
const AUTOPAY_HOLD_ALERT_COPY = {
  ambiguous: {
    actions: [(who) => `check Stripe first for ${who}`, (who) => `check Stripe for ${who}`],
    doneWhen: 'stripe_checked_and_marked_done',
    why: (c) => `${c.label} may have been charged; check Stripe before anything else.`,
    detail: (c) => `The Auto Pay hold on invoice ${c.number} timed out and the sweep tried to charge the saved Auto Pay method for ${c.amount}. The outcome is unclear (${c.errorCode || 'unknown'}). The hold was NOT released and nothing will retry. Check Stripe for a payment on this invoice before you collect, retry or send anything.`,
  },
  declined: {
    actions: [(who) => `check ${who}'s failed Auto Pay charge`, (who) => `check ${who}'s Auto Pay charge`],
    doneWhen: 'invoice_collected_or_marked_done',
    why: (c) => `${c.label} was not charged (${c.reasonText}); reminders start.`,
    detail: (c) => `The Auto Pay hold on invoice ${c.number} timed out and the sweep tried to charge the saved Auto Pay method for ${c.amount}: ${c.reasonText}${c.errorMessage ? ` (${String(c.errorMessage).slice(0, 200)})` : ''}. The sweep releases the hold next, so the normal reminder ladder starts unless the invoice changed in the meantime.`,
  },
  // Office review (owner 2026-10-29, option B): the hold is KEPT, nothing was charged, no reminder goes to the customer.
  // One alert per invoice; a changed bill or visit price is evaluated again (the fingerprint on the final audit row).
  review: {
    actions: [(who) => `review ${who}'s held Auto Pay charge`, (who) => `review ${who}'s Auto Pay charge`],
    doneWhen: 'invoice_reviewed_or_marked_done',
    why: (c) => `${c.label} was not charged: ${c.reasonText}.`,
    detail: (c) => `The Auto Pay hold on invoice ${c.number} timed out, but the sweep did not charge the saved Auto Pay method for ${c.amount}: ${c.reasonText}${c.errorMessage ? ` (${String(c.errorMessage).slice(0, 200)})` : ''}. The hold was kept and no reminder goes to the customer. Fix the invoice or the visit price, or collect it yourself. The sweep looks at it again only after the bill or the visit price changes.`,
  },
  deferred: {
    actions: [(who) => `check ${who}'s held Auto Pay charge`, (who) => `check ${who}'s held charge`],
    doneWhen: 'collection_hold_cleared',
    why: (c) => `${c.label} was not charged; a dispute hold stopped the Auto Pay charge.`,
    detail: (c) => `The Auto Pay hold on invoice ${c.number} timed out and the sweep tried to charge the saved Auto Pay method for ${c.amount}, but a dispute hold on this customer stopped the charge before anything reached Stripe. The Auto Pay hold was NOT released. The sweep tries again after the dispute hold clears.`,
  },
};

// One office alert (category billing) per invoice and kind. Never throws: the charge is already decided.
async function raiseAutopayHoldChargeAlert({ kind, invoice, row, amountCents, reason, errorCode, errorMessage }) {
  try {
    const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
    const { lookupCustomerName, fitAction } = require('./admin-alert-names');
    const name = (await lookupCustomerName(db, row.customer_id)) || 'this customer';
    const copy = AUTOPAY_HOLD_ALERT_COPY[kind];
    const ctx = {
      label: `${moneyLabel(amountCents)} on invoice ${invoice.invoice_number || ''}`.trim(),
      number: invoice.invoice_number || invoice.id,
      amount: moneyLabel(amountCents),
      reasonText: AUTOPAY_HOLD_REASON_TEXT[reason] || AUTOPAY_HOLD_REASON_TEXT.refused,
      errorCode,
      errorMessage,
    };
    const alert = await raiseAdminAlert('billing', {
      area: 'Billing',
      action: fitAction('Billing', name, copy.actions),
      why: cutAtWord(copy.why(ctx), 110),
      severity: 'needs-you',
      link: `/admin/invoices?invoice=${encodeURIComponent(invoice.id)}`,
      subject: { type: 'invoice', id: String(invoice.id) },
      doneWhen: copy.doneWhen,
      who: 'person',
    }, {
      // A needs-you money item must ring (see autopay-sca-parked.js): billing is not on the bell allowlist.
      bell: true,
      dedupeKey: `autopay_hold_charge:${kind}:${invoice.id}`,
      dedupeOpenOnly: true,
      detail: copy.detail(ctx),
      metadata: { customerId: String(row.customer_id), invoiceId: String(invoice.id), sequenceId: String(row.id), reason, errorCode: errorCode || null },
    });
    if (!alert) logger.error(`[invoice-followups] autopay hold charge: office alert NOT filed for invoice ${invoice.id} (${kind})`);
    return alert;
  } catch (alertErr) {
    logger.error(`[invoice-followups] autopay hold charge: office alert threw for invoice ${invoice.id} (${kind}): ${alertErr.message}`);
    return null;
  }
}

// One audit_log row per charge attempt: ids, amounts and codes only, no card data, no names. critical: a write
// that fails throws, so a final row that was not recorded is never mistaken for a finished attempt.
async function recordAutopayHoldChargeAudit({ row, invoice, outcome, reason = null, errorCode = null, amountCents, methodType = null, released = null, fingerprint = null }) {
  const { recordAuditEvent } = require('./audit-log');
  await recordAuditEvent({
    critical: true,
    actor_type: 'system',
    action: AUTOPAY_HOLD_CHARGE_ACTION,
    resource_type: 'invoice',
    resource_id: invoice.id,
    metadata: {
      sequence_id: row.id,
      customer_id: row.customer_id,
      outcome,
      reason,
      error_code: errorCode,
      amount_cents: amountCents,
      method_type: methodType,
      released,
      // An office review carries the hash of the facts the verdict read (chargeFactsFingerprintSql).
      ...(fingerprint ? { fingerprint } : {}),
    },
  });
}

// True when the customer has an active dispute hold, or when that cannot be read (fail closed, like the charge).
async function disputeHoldBlocksCharge(customerId) {
  try {
    return await require('./collections/collection-hold').customerHasActiveCollectionHoldChecked(customerId);
  } catch (err) {
    logger.warn(`[invoice-followups] autopay hold charge: dispute hold check failed for customer ${customerId}; deferred: ${err.message}`);
    return true;
  }
}

// ---- charge mode: visit bills only, inside the completion rail's own authorization (owner 2026-10-29, option B) ----

// The customer's Auto Pay columns on the visit read (customerOnAutopay's input) and the aliases the completion
// verdict functions read (completion-charge-verdict.js: svc.cust_billing_mode, cust_monthly_rate, cust_per_application_fee).
const VISIT_BILL_CUSTOMER_COLUMNS = [
  'c.billing_mode as cust_billing_mode', 'c.monthly_rate as cust_monthly_rate', 'c.per_application_fee as cust_per_application_fee',
  'c.autopay_enabled as cust_autopay_enabled', 'c.autopay_paused_until as cust_autopay_paused_until',
  'c.autopay_payment_method_id as cust_autopay_payment_method_id', 'c.ach_status as cust_ach_status',
];
// Invoice states the completion route never charges (complete-scheduled-service.js): the hold waits.
const VISIT_BILL_NO_CHARGE_STATUSES = ['paid', 'prepaid', 'void', 'processing'];

// Every fact the verdict reads. The fingerprint is read FIRST: a bill edited after it was read changes the hash the
// review is stored with, so the next run evaluates it again (never the other way round). A failed read throws.
async function readVisitBillFacts(row, invoiceId) {
  const fingerprintRow = await db('invoice_followup_sequences as s').where('s.id', row.id)
    .first(db.raw(`${chargeFactsFingerprintSql('s.invoice_id', 's.customer_id')} AS fingerprint`));
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  const svc = invoice?.scheduled_service_id
    ? await db('scheduled_services as ss').join('customers as c', 'c.id', 'ss.customer_id')
      .where('ss.id', invoice.scheduled_service_id).first('ss.*', ...VISIT_BILL_CUSTOMER_COLUMNS)
    : null;
  if (!invoice || !svc || !fingerprintRow?.fingerprint) throw new Error('the invoice or its visit could not be read');
  const record = await db('service_records').where({ scheduled_service_id: svc.id })
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).first('status', 'structured_notes');
  return { fingerprint: fingerprintRow.fingerprint, invoice, svc, record };
}

// The completion route's lane for this visit bill: the same read-only verdict functions it runs, strict (a lookup
// failure throws, so the hold waits and is retried), and the same Auto Pay test (customerOnAutopay). `candidate` is the
// lane as if Auto Pay were active: the cap review must not depend on it (a bill over the cap is reviewed even for a
// customer with no method); `autopayActive` alone decides charge versus release afterwards.
async function visitBillLane(svc, invoice) {
  const verdicts = require('./completion-charge-verdict');
  const customerAutopayActive = await require('./autopay-eligibility').customerOnAutopay({
    id: svc.customer_id,
    autopay_enabled: svc.cust_autopay_enabled,
    autopay_paused_until: svc.cust_autopay_paused_until,
    autopay_payment_method_id: svc.cust_autopay_payment_method_id,
    ach_status: svc.cust_ach_status,
  }, { db, failClosed: true });
  const perApplicationBilling = svc.cust_billing_mode === 'per_application';
  const appt = await verdicts.resolveAppointmentCardLane({
    svc, invoice, alreadyPaid: false, visitPerformed: true, perApplicationBilling,
    annualPrepayBilling: svc.cust_billing_mode === 'annual_prepay', explicitMembershipLane: svc.cust_billing_mode === 'monthly_membership',
    conn: db, strict: true,
  });
  const ext = await verdicts.resolveExtendedLane({
    svc, invoice, alreadyPaid: false, visitPerformed: true, perApplicationBilling,
    apptCardOneTimeCharge: appt.apptCardOneTimeCharge, apptCardLaneUnresolved: appt.apptCardLaneUnresolved, customerAutopayActive: true,
    conn: db, strict: true,
  });
  // A Bill-by-invoice visit is on no Auto Pay lane (bill-by-invoice.js): the hold is released to its reminders.
  const perApplicationCharge = await verdicts.resolvePerApplicationCharge({ svc, perApplicationBilling, conn: db, strict: true });
  const candidate = perApplicationCharge || appt.apptCardOneTimeCharge || ext.extendedChargeCandidate;
  return { candidate, autopayActive: customerAutopayActive, perApplicationBilling, appt, ext };
}

// The completion route's charge options (complete-scheduled-service.js), by name, plus the hold's own guards. The
// cap ceiling replaces the exact-total demand: the charge may be lower than the quote, never above the agreed price.
function visitBillChargeOptions(row, invoice, svc, lane, cap) {
  const extended = lane.ext.extendedAutopayCharge;
  return {
    maxAuthorizedSubtotal: cap.capCeiling,
    requireAutopayForCustomerId: row.customer_id,
    requireSelfPayScheduledServiceId: svc.id,
    requireOneTimeLane: lane.appt.apptCardOneTimeCharge,
    requireNoAppointmentCardLane: extended,
    requireExtendedCompletionAnchor: extended,
    requireInvoiceScheduledServiceBinding: true,
    refuseWhenDunningStopped: true,
    requireCompletedVisit: true,
    requirePerformedVisit: true,
    allowIssuedInvoiceCloseoutFor: invoice.id,
    requireNoUnappliedVisitPrepayment: true,
    requireBankDebitDue: true,
    ...(extended ? { maxAuthorizedChargeCents: Math.round(invoiceAmountDue(invoice) * 100) } : {}),
  };
}

async function decideVisitBill(row, { fingerprint, invoice, svc, record }) {
  const review = (reason) => ({ kind: 'review', reason, fingerprint });
  if (VISIT_BILL_NO_CHARGE_STATUSES.includes(String(invoice.status || '').toLowerCase())) return { kind: 'skipped' };
  if (invoice.payer_id) return review('payer');
  // A visit the issued-invoice closeout job closed after its bill was sent counts as performed FOR THIS CHARGE only.
  if (String(svc.status || '') !== 'completed' || !require('./visit-outcomes').closeoutPerformedForCharge(record, { issuedCloseoutInvoiceId: invoice.id })) {
    return review('not_performed');
  }
  const payer = await require('./payer').resolveForInvoice({
    database: db, customerId: String(svc.customer_id), scheduledServiceId: String(svc.id), throwOnError: true,
  });
  if (payer?.payerId) return review('payer');
  // A prepayment stamped on the visit that this bill does not show (a backfill closeout skips applying it) would be
  // charged over, on any lane.
  if (await require('./billing-lane').visitCarriesUnappliedPrepayment({ dbConn: db, svc, invoice })) return review('prepaid');
  const lane = await visitBillLane(svc, invoice);
  if (!lane.candidate) return { kind: 'release_true' };
  const cap = await require('./completion-charge-verdict').resolveCompletionChargeCap({
    svc, invoice, perApplicationBilling: lane.perApplicationBilling,
    apptCardOneTimeCharge: lane.appt.apptCardOneTimeCharge, apptCardAcceptedAmount: lane.appt.apptCardAcceptedAmount,
    extendedLaneAnchor: lane.ext.extendedLaneAnchor, secureSetupFee: null, conn: db, strict: true,
  });
  if (cap.verdict === 'above_cap') return review('over_cap');
  if (cap.verdict === 'no_accepted_amount') return review('no_cap');
  if (!lane.autopayActive) return { kind: 'release_true' };
  return { kind: 'proceed', fingerprint, options: visitBillChargeOptions(row, invoice, svc, lane, cap) };
}

/**
 * The verdict for a hold on a visit-bound invoice, before any quote, marker or charge. Writes nothing.
 *   { kind: 'skipped' }                            a lookup failed (or the invoice is settling): hold kept, retried
 *   { kind: 'release_true' }                       no completion lane admits the bill (gate off, Auto Pay inactive, ...)
 *   { kind: 'review', reason, fingerprint }        office review, hold kept: not_performed | payer | over_cap | no_cap
 *   { kind: 'proceed', options, fingerprint }      charge with these options (the completion route's own set)
 */
async function visitBillVerdict(row, invoiceId) {
  try {
    return await decideVisitBill(row, await readVisitBillFacts(row, invoiceId));
  } catch (err) {
    logger.error(`[invoice-followups] autopay hold charge: visit-bill verdict failed for invoice ${invoiceId}; hold kept, next run retries: ${err.message}`);
    return { kind: 'skipped' };
  }
}

// The durable marker: committed BEFORE the charge, so a crash or a failed release after a clean decline can be
// recovered (recoverAutopayHoldCharges). Returns false when it cannot be written (nothing is then charged).
async function writeChargeStartMarker(row, invoice, quote) {
  try {
    await require('./audit-log').recordAuditEvent({
      critical: true,
      actor_type: 'system',
      action: AUTOPAY_HOLD_CHARGE_STARTED_ACTION,
      resource_type: 'invoice',
      resource_id: invoice.id,
      metadata: { sequence_id: row.id, customer_id: row.customer_id, hold_stamp: row.hold_stamp, amount_cents: Math.round(quote.total * 100) },
    });
    return true;
  } catch (markerErr) {
    logger.error(`[invoice-followups] autopay hold charge: could not write the start marker for invoice ${invoice.id}; nothing charged, next run retries: ${markerErr.message}`);
    return false;
  }
}

// Why the charge path refused a visit bill before submitting anything (the review alert's reason).
function refusalReviewReason(err) {
  const byCode = { PAYER_BILLED_GUARD: 'payer', VISIT_NOT_COMPLETED: 'not_performed', UNAPPLIED_VISIT_PREPAYMENT: 'prepaid' };
  return byCode[err?.code] || 'refused';
}

/**
 * GATE_AUTOPAY_HOLD_TIMEOUT=charge, step one for ONE stale hold on a visit-bound invoice: pick the method Auto Pay
 * itself would charge, judge the bill with the completion route's own authorization (visitBillVerdict), quote it,
 * charge it, and report what happened as ONE decision object:
 *   { kind: 'skipped' }                                   a method or verdict lookup that threw: nothing was tried
 *   { kind: 'release_true' }                              no completion lane admits the bill: released as 'true' releases it
 *   { kind: 'charged', status, result, ... }              paid, processing (bank) or covered by account credit
 *   { kind: 'held_off' }                                  a dispute hold stops the charge: nothing was tried, nothing written
 *   { kind: 'bank_wait' }                                 a bank method whose invoice due date is after today (ET): nothing was tried, nothing written
 *   { kind: 'no_debit_date' }                             a bank method on an invoice with no due date: no authorized debit date, nothing was tried
 *   { kind: 'review', reason, fingerprint, ... }          over the agreed price, no price, not performed, a payer, or a guard refusal: hold kept, one office alert
 *   { kind: 'deferred', reason: 'deferred', err, ... }    the charge itself refused on a dispute hold (a race): retried later
 *   { kind: 'not_due', reason: 'not_due', err, ... }      the charge itself refused a bank debit before the due date (a race): retried later
 *   { kind: 'ambiguous', reason: 'ambiguous', err, ... }  money may have moved or a charge is still settling
 *   { kind: 'declined', reason: 'declined' | 'no_method', err, ... }   a real decline or no method; nothing was charged
 * `chargeCalled` says whether chargeInvoiceWithSavedCard was reached (it decides the release guards).
 */
async function attemptAutopayHoldCharge(row, invoice, now = new Date()) {
  let method;
  try {
    // rethrow: a failed lookup must not read as "no method" (that releases the hold). Only a lookup that
    // succeeds and finds nothing is no_method.
    method = await require('./autopay-eligibility').getChargeableAutopayMethod({ id: row.customer_id }, db, { rethrow: true });
  } catch (lookupErr) {
    logger.error(`[invoice-followups] autopay hold charge: Auto Pay method lookup failed for invoice ${row.invoice_id}; hold kept, next run retries: ${lookupErr.message}`);
    return { kind: 'skipped' };
  }
  const decision = (fields) => ({ kind: 'declined', reason: null, chargeCalled: false, err: null, result: null, status: null, quote: null, method, fingerprint: null, ...fields });
  // A dispute hold that appeared since the select (or one that cannot be read): the charge would refuse it, so
  // nothing is attempted. No marker, no attempt, no release, no alert; the next run tries again.
  if (await disputeHoldBlocksCharge(row.customer_id)) return { kind: 'held_off' };
  // The mandatory office-review conditions come BEFORE every release decision below (no method, no bank debit date):
  // a payer, an unperformed visit, a bill over its cap or an unapplied prepayment is never released into reminders.
  const verdict = await visitBillVerdict(row, invoice.id);
  if (verdict.kind === 'review') return decision({ kind: 'review', reason: verdict.reason, fingerprint: verdict.fingerprint });
  if (verdict.kind === 'skipped') return verdict;
  if (!method) return decision({ reason: 'no_method' });
  // The bank consent (payment-method-consent-text.js) authorizes a debit for the invoice on or after its due date (or
  // on the Auto Pay billing day the customer selected, an alternative EARLIER date: waiting for the due date never
  // exceeds the authorization, so the billing day is ignored). Date-only ET strings. No due date = no authorized
  // debit date. Both leave before the quote and the start marker; the charge re-checks this under the invoice lock.
  if (isBankMethodType(method.method_type)) {
    if (!invoice.due_date) return { kind: 'no_debit_date' };
    if (etCalendarDayOf(invoice.due_date) > etDateString(now)) return { kind: 'bank_wait' };
  }
  if (verdict.kind !== 'proceed') return verdict;

  let quote;
  try {
    quote = await StripeService.quoteInvoiceSavedCardCharge(invoice.id, method.id);
  } catch (quoteErr) {
    // A quote moves no money, and a refused quote is never a reason to start reminders (it can be a payer): review.
    return decision({ kind: 'review', reason: refusalReviewReason(quoteErr), fingerprint: verdict.fingerprint, err: quoteErr });
  }
  if (!await writeChargeStartMarker(row, invoice, quote)) return { kind: 'skipped' };
  try {
    // quote.total is the surcharge-inclusive total: the ceiling on what the charge path may collect. No exact-total
    // demand: the verdict's cap ceiling (maxAuthorizedSubtotal) is the agreed price, and a lower total is allowed.
    const result = await StripeService.chargeInvoiceWithSavedCard(invoice.id, method.id, {
      ...verdict.options,
      maxAuthorizedTotalCents: Math.round(quote.total * 100),
    });
    const status = result && result.covered_by_credit === true ? 'covered_by_credit' : String(result?.status || 'paid');
    return decision({ kind: 'charged', chargeCalled: true, quote, result, status });
  } catch (chargeErr) {
    return decision(await chargeFailureFields(chargeErr, invoice.id, { quote, fingerprint: verdict.fingerprint }));
  }
}

// What a thrown charge means as decision fields. A clean decline, refusal or deferral leaves no open attempt;
// anything else may have reached Stripe. A refusal raised before anything reached Stripe is never a decline: the
// office reviews it and the hold is kept.
async function chargeFailureFields(chargeErr, invoiceId, { quote, fingerprint }) {
  let reason = classifyAutopayHoldChargeError(chargeErr);
  if (reason !== 'ambiguous' && await invoiceHasOpenChargeAttempt(invoiceId)) reason = 'ambiguous';
  const fields = { chargeCalled: true, quote, err: chargeErr, fingerprint };
  if (reason === 'refused') return { ...fields, kind: 'review', reason: refusalReviewReason(chargeErr) };
  return { ...fields, kind: ['ambiguous', 'deferred', 'not_due'].includes(reason) ? reason : 'declined', reason };
}

// Step two: what each decision does. One table instead of parallel branches.
// - releases: the hold is released (the guards: afterOwnCharge only when a charge was called);
// - stops: closes the follow-up sequence (the charge path already did; the same idempotent call again);
// - alert: the one office alert kind; log: [level, text]; result: the sweep outcome.
const AUTOPAY_HOLD_CHARGE_PLANS = {
  charged: {
    releases: false,
    stops: (d) => ['paid', 'covered_by_credit', 'charged'].includes(d.status),
    audit: (d) => d.status,
    alert: null,
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} ${d.status}`],
    result: () => 'charged',
  },
  // Recovery only: a marker whose charge never reached a claim. Nothing was charged; the normal clause
  // picks the hold up again on the next run.
  abandoned: {
    releases: false,
    stops: () => false,
    audit: () => 'abandoned',
    alert: null,
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} had a start marker but no charge attempt; left for the next run`],
    result: () => 'abandoned',
  },
  ambiguous: {
    releases: false,
    stops: () => false,
    audit: () => 'ambiguous',
    alert: 'ambiguous',
    log: (d, released, invoice) => ['error', `[invoice-followups] autopay hold charge: invoice ${invoice.id} outcome unclear (${d.err?.code || 'open charge attempt'}); hold kept, nothing retried`],
    result: () => 'ambiguous',
  },
  // The charge refused on a collection hold before anything reached Stripe (a race with the select): the hold stays,
  // one office alert says so, and the invoice is retried once the dispute hold clears.
  deferred: {
    releases: false,
    stops: () => false,
    audit: () => 'deferred',
    alert: 'deferred',
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} deferred by a dispute hold; hold kept, retried after it clears`],
    result: () => 'deferred',
  },
  // The charge refused a bank debit before the invoice due date (a race with the select): the hold stays, no
  // alert, the final row reads 'deferred' so chargeModeAttemptRule lets the next run charge it once it is due.
  not_due: {
    releases: false,
    stops: () => false,
    audit: () => 'deferred',
    alert: null,
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} bank debit date not reached; hold kept, retried on or after the due date`],
    result: () => 'not_due',
  },
  // Office review: the hold is kept and nobody is texted. The final row carries the fingerprint of the facts the verdict
  // read; chargeModeUnreviewedRule keeps the hold out of the sweep until the bill or the visit price changes.
  review: {
    releases: false,
    stops: () => false,
    audit: () => 'review',
    alert: 'review',
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} needs office review (${d.reason}); hold kept, nothing charged`],
    result: () => 'review',
  },
  declined: {
    releases: true,
    stops: () => false,
    audit: (d, released) => (released ? 'declined_released' : 'declined_not_released'),
    alert: 'declined',
    log: (d, released, invoice) => ['info', `[invoice-followups] autopay hold charge: invoice ${invoice.id} ${d.reason}; hold ${released ? 'released' : 'not released'}`],
    result: (d, released) => (released ? 'declined_released' : 'release_failed'),
  },
};

// Released exactly as GATE_AUTOPAY_HOLD_TIMEOUT=true releases it: its clause and recheck (releaseStaleAutopayHold with
// no charge-mode options), its office alert, no charge attempt, no marker, no charge audit row. Used for an invoice
// a dedicated annual-prepay rail governs, an invoice bound to no visit, a visit bill no completion lane admits and a
// bank method with no authorized debit date.
async function releaseAsTrue(row, cutoff, now) {
  return { outcome: (await releaseStaleAutopayHold(row, cutoff, now)) ? 'true_released' : 'skipped' };
}

// Decisions that end a hold's turn before any marker, quote or charge: nothing is written for them.
const AUTOPAY_HOLD_EARLY_OUTCOMES = { skipped: 'skipped', held_off: 'deferred', bank_wait: 'not_due' };

/**
 * GATE_AUTOPAY_HOLD_TIMEOUT=charge: the action for ONE stale hold the sweep selected. Charges the method Auto
 * Pay itself would charge (attemptAutopayHoldCharge), then applies the decision's plan. Only a visit's own bill is
 * charged by itself, inside the completion route's authorization (visitBillVerdict); an invoice bound to no visit is
 * released as 'true' releases it.
 * - paid / processing (bank) / covered by account credit: the hold stays; a paid or credit-covered invoice
 *   closes its follow-up sequence through stopOnPayment (the charge path calls it; this is the same call
 *   again, a no-op once completed), a bank charge closes it when the webhook settles it;
 * - a real card decline or no chargeable method: the hold is released as 'true' releases it (original guards
 *   when no charge was called; only our own failed rows exempted when one was), and one office alert says why;
 * - over the agreed price, no agreed price, not a performed visit, a payer, or a guard refusal ('review'): the hold is
 *   KEPT, nothing is charged or sent, one office alert says why, and the final audit row carries a fingerprint of the
 *   facts read; the hold is looked at again only after those facts change;
 * - ambiguous: the hold stays, nothing retries, and one office alert says to check Stripe.
 * - a bank method before its invoice due date: nothing is written and the hold stays ('not_due'); a bank method on an
 *   invoice with no due date has no authorized debit date, so it is released as 'true' releases it ('true_released').
 * Returns { outcome: 'charged' | 'declined_released' | 'release_failed' | 'review' | 'ambiguous' | 'deferred' | 'not_due' | 'true_released' | 'skipped' | 'alert_failed' }.
 */
async function chargeStaleAutopayHold(row, cutoff, now = new Date()) {
  // An annual-prepay term rail invoice (row.termRail, see annualPrepayTermRail) is never charged here.
  if (row.termRail) return releaseAsTrue(row, cutoff, now);
  // Still the same stale hold? Minutes can pass between the read and this row; money must not move on a
  // hold that a payment, plan, visit or failure bump has since changed. A read, not a lock.
  const stillStale = await staleAutopayHoldClause(db('invoice_followup_sequences as s'), cutoff, { chargeMode: true })
    .where('s.id', row.id)
    .whereRaw('s.updated_at = ?::timestamptz', [row.hold_stamp])
    .first('s.id');
  if (!stillStale) return { outcome: 'skipped' };
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice || isTerminalInvoice(invoice) || followupArmBlock(invoice)) return { outcome: 'skipped' };
  // Only a visit's own bill is charged by itself (owner 2026-10-29): an invoice bound to no visit has no agreed price
  // to cap it, so it is released as 'true' releases it.
  if (!invoice.scheduled_service_id) return releaseAsTrue(row, cutoff, now);

  const d = await attemptAutopayHoldCharge(row, invoice, now);
  if (AUTOPAY_HOLD_EARLY_OUTCOMES[d.kind]) return { outcome: AUTOPAY_HOLD_EARLY_OUTCOMES[d.kind] };
  if (d.kind === 'no_debit_date' || d.kind === 'release_true') return releaseAsTrue(row, cutoff, now);

  const covered = d.status === 'covered_by_credit';
  const amountCents = covered ? 0 : (d.quote ? Math.round(d.quote.total * 100) : cents(invoiceAmountDue(invoice)));
  return applyAutopayHoldPlan(row, cutoff, invoice, d, amountCents);
}

// Applies a decision's plan. Order matters. The office alert goes FIRST: if it cannot be filed nothing else is
// done (no release, no final row), the hold stays 'autopay_hold' with an unfinished marker, and the next run's
// recovery retries the alert and finishes. After a delivered alert: release, stopOnPayment, and the final audit
// row LAST, so the presence of that row means the attempt finished.
// The hash stored on a review's final row: the one the verdict read, else (a recovered attempt) the bill as it is now.
async function reviewFingerprint(row, d) {
  if (d.fingerprint) return d.fingerprint;
  const current = await db('invoice_followup_sequences as s').where('s.id', row.id)
    .first(db.raw(`${chargeFactsFingerprintSql('s.invoice_id', 's.customer_id')} AS fingerprint`));
  return current?.fingerprint || null;
}

async function applyAutopayHoldPlan(row, cutoff, invoice, d, amountCents) {
  const plan = AUTOPAY_HOLD_CHARGE_PLANS[d.kind];
  if (plan.alert) {
    const alert = await raiseAutopayHoldChargeAlert({
      kind: plan.alert, invoice, row, amountCents, reason: d.reason, errorCode: d.err?.code || null, errorMessage: d.err?.message || null,
    });
    if (!alert) {
      logger.error(`[invoice-followups] autopay hold charge: the office alert was not filed for invoice ${invoice.id}; attempt left unfinished, the next run retries`);
      return { outcome: 'alert_failed' };
    }
  }
  // No charge called (no method, quote refused): the original guards, hold stamp included. A charge that
  // failed cleanly exempts only the failed attempt and failed payment it wrote itself.
  const released = plan.releases && await releaseStaleAutopayHold(row, cutoff, new Date(), { chargeMode: true, afterOwnCharge: d.chargeCalled, alert: false });
  if (plan.stops(d)) {
    await stopOnPayment(invoice.id).catch((stopErr) => logger.error(`[invoice-followups] autopay hold charge: stopOnPayment failed for invoice ${invoice.id}: ${stopErr.message}`));
  }
  await recordAutopayHoldChargeAudit({
    row, invoice, outcome: plan.audit(d, released), reason: d.reason, errorCode: d.err?.code || null, amountCents, methodType: d.method?.method_type || null, released,
    fingerprint: plan.alert === 'review' ? await reviewFingerprint(row, d) : null,
  });
  const [level, text] = plan.log(d, released, invoice);
  logger[level](text);
  return { outcome: plan.result(d, released) };
}

/**
 * Charge-mode recovery (never charges). A start marker with no later final row, on a sequence still held, is an
 * attempt that did not finish: the process died, or the release/alert/audit step failed after the charge path
 * recorded a clean decline (which the stale clause then excludes forever). Only the stripe_invoice_charge_attempts
 * rows created at or after the marker decide it.
 */
async function unfinishedAutopayHoldCharges() {
  return db('audit_log as m')
    .joinRaw("JOIN invoice_followup_sequences s ON s.id::text = m.metadata->>'sequence_id' AND s.invoice_id = m.resource_id")
    .where('m.action', AUTOPAY_HOLD_CHARGE_STARTED_ACTION)
    .where('s.status', 'autopay_hold')
    .whereNotExists(function noFinalRow() {
      this.select(db.raw('1')).from('audit_log as f')
        .where('f.action', AUTOPAY_HOLD_CHARGE_ACTION)
        .whereRaw('f.resource_id = m.resource_id')
        .whereRaw("f.metadata->>'sequence_id' = m.metadata->>'sequence_id'")
        .whereRaw('f.created_at >= m.created_at');
    })
    .orderBy('m.created_at', 'asc')
    .select('m.resource_id as invoice_id', 'm.created_at as started_at', 'm.metadata as metadata', 's.customer_id');
}

// Which plan an unfinished attempt maps to, from the attempt rows created since its marker. A failed attempt that
// asks the customer to authenticate is ambiguous, like the live classifier reads it. A failed attempt whose message
// is a collection-hold or bank-debit-date refusal was never attempted: retry later (the first alerts, the second
// is quiet). Any other failed attempt with no decline code was a guard refusal before Stripe (the charge path stores
// a decline code only for a customer decline): office review, never a release. One with a decline code is declined.
function recoveredAttemptKind(attempts, invoice) {
  if (!attempts.length) return 'abandoned';
  const clean = attempts.every((attempt) => attempt.status === 'failed' && attempt.decline_code !== 'authentication_required');
  const refusedBy = (pattern) => attempts.some((attempt) => pattern.test(String(attempt.error_message || '')));
  if (clean && refusedBy(/billing dispute|Collection hold could not be verified/i)) return 'deferred';
  if (clean && refusedBy(BANK_DEBIT_NOT_DUE_PATTERN)) return 'not_due';
  if (clean) return attempts.some((attempt) => attempt.decline_code) ? 'declined' : 'review';
  return ['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase()) ? 'charged' : 'ambiguous';
}
const RECOVERED_REASON = { declined: 'recovered', ambiguous: 'ambiguous', deferred: 'collection_hold', not_due: 'bank_debit_not_due', review: 'refused' };

async function recoverAutopayHoldCharge(marker, cutoff) {
  const meta = marker.metadata || {};
  const invoice = await db('invoices').where({ id: marker.invoice_id }).first();
  if (!invoice) return null;
  const attempts = await db('stripe_invoice_charge_attempts')
    .where({ invoice_id: marker.invoice_id })
    .where('created_at', '>=', marker.started_at)
    .select('status', 'decline_code', 'error_message');
  const kind = recoveredAttemptKind(attempts, invoice);
  const row = { id: meta.sequence_id, invoice_id: marker.invoice_id, customer_id: marker.customer_id, hold_stamp: meta.hold_stamp };
  const d = { kind, reason: RECOVERED_REASON[kind] || null, chargeCalled: true, err: null, result: null, status: kind === 'charged' ? 'charged' : null, quote: null, method: null, fingerprint: null };
  return (await applyAutopayHoldPlan(row, cutoff, invoice, d, Number(meta.amount_cents) || 0)).outcome;
}

// Returns { recovered, errors, invoiceIds }. invoiceIds are left out of this run's charges, abandoned ones too.
async function recoverAutopayHoldCharges(cutoff) {
  const result = { recovered: 0, errors: 0, invoiceIds: new Set() };
  let markers;
  try {
    markers = await unfinishedAutopayHoldCharges();
  } catch (err) {
    result.errors += 1;
    logger.error(`[invoice-followups] autopay hold charge recovery could not read the start markers: ${err.message}`);
    return result;
  }
  for (const marker of markers) {
    result.invoiceIds.add(String(marker.invoice_id));
    try {
      const outcome = await recoverAutopayHoldCharge(marker, cutoff);
      if (outcome === 'alert_failed') result.errors += 1;
      else if (outcome) result.recovered += 1;
    } catch (err) {
      result.errors += 1;
      logger.error(`[invoice-followups] autopay hold charge recovery failed for invoice ${marker.invoice_id}: ${err.message}`);
    }
  }
  return result;
}

/**
 * The charge-mode sweep over the selected holds, one saved-method charge at a time. An unexpected throw on one
 * hold is counted and the sweep goes on: before the charge call it moved no money, after it the charge path's
 * own attempt row fences the invoice.
 */
async function chargeStaleAutopayHolds(allDue, cutoff, now = new Date()) {
  const counts = { charged: 0, declined_released: 0, true_released: 0, release_failed: 0, ambiguous: 0, review: 0, deferred: 0, not_due: 0, skipped: 0, errors: 0 };
  // First finish what an earlier run left half done. The recovery pass never charges, and an invoice it
  // touched is not charged again in this run.
  const recovery = await recoverAutopayHoldCharges(cutoff);
  counts.errors += recovery.errors;
  const due = allDue.filter((row) => !recovery.invoiceIds.has(String(row.invoice_id)));
  for (const row of due) {
    try {
      const { outcome } = await chargeStaleAutopayHold(row, cutoff, now);
      // An alert that could not be filed leaves the attempt unfinished for the next run's recovery.
      counts[outcome === 'alert_failed' ? 'errors' : outcome] += 1;
    } catch (err) {
      counts.errors += 1;
      logger.error(`[invoice-followups] autopay hold charge failed for invoice ${row.invoice_id}: ${err.message}`);
    }
  }
  logger.info(`[invoice-followups] autopay hold timeout (charge): ${due.length} stale hold(s): ${counts.charged} charged, ${counts.declined_released} released after a decline or refusal, ${counts.true_released} released as true (term rail, no visit, no completion lane or no bank debit date), ${counts.review} held for office review, ${counts.ambiguous} ambiguous, ${counts.deferred} deferred, ${counts.not_due} waiting for a bank debit date, ${counts.skipped} skipped, ${counts.release_failed} not released, ${recovery.recovered} recovered, ${counts.errors} error(s)`);
  return { mode: 'charge', candidates: due.length, released: counts.declined_released + counts.true_released, recorded: 0, recovered: recovery.recovered, ...counts };
}

// 'shadow': one audit_log row per would-release invoice per ET day, nothing else. Returns how many were newly recorded.
async function recordShadowAutopayHolds(due, now) {
  let recorded = 0;
  const { recordAuditEvent } = require('./audit-log');
  const etDay = etDateString(now);
  for (const row of due) {
    const already = await db('audit_log')
      .where({ action: AUTOPAY_HOLD_SHADOW_ACTION, resource_type: 'invoice', resource_id: row.invoice_id })
      .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?::date", [etDay])
      .first('id');
    if (already) continue;
    const heldSince = new Date(row.updated_at);
    await recordAuditEvent({
      actor_type: 'system',
      action: AUTOPAY_HOLD_SHADOW_ACTION,
      resource_type: 'invoice',
      resource_id: row.invoice_id,
      metadata: {
        sequence_id: row.id,
        held_since: heldSince.toISOString(),
        days_held: Math.floor((now.getTime() - heldSince.getTime()) / 86400000),
      },
    });
    recorded += 1;
  }
  return recorded;
}

// Every held row `staleAutopayHoldClause(..., clauseOptions)` selects, in id-keyset pages so rows the skips pass over
// never hide the rows behind them, minus invoices that are terminal, payer-billed or no longer schedulable.
async function selectStaleAutopayHolds(cutoff, pageSize, clauseOptions) {
  const due = [];
  let afterId = null;
  for (;;) {
    const page = staleAutopayHoldClause(db('invoice_followup_sequences as s'), cutoff, clauseOptions)
      .orderBy('s.id', 'asc')
      .limit(pageSize)
      .select('s.id', 's.invoice_id', 's.customer_id', 's.updated_at', db.raw('s.updated_at::text as hold_stamp'));
    if (afterId) page.where('s.id', '>', afterId);
    const rows = await page;

    for (const row of rows) {
      const invoice = await db('invoices').where({ id: row.invoice_id }).first();
      if (!invoice || isTerminalInvoice(invoice) || followupArmBlock(invoice)) continue;
      due.push(row);
    }
    if (rows.length < pageSize) break;
    afterId = rows[rows.length - 1].id;
  }
  return due;
}

/**
 * Release Auto Pay holds that Auto Pay never acted on: `autopay_hold` sequences that meet
 * staleAutopayHoldClause, on an invoice that is not terminal, not payer-billed and still schedulable,
 * for a customer with no OPEN customer-level schedule (an open one owns its reminders and judges Auto Pay
 * itself). The live engine's coverage (GATE_DUNNING_CUSTOMER_SCHEDULE, its allowlist) is not a skip: with no
 * allowlist it covers every customer, and the engine never promotes an `autopay_hold` row, so skipping
 * covered customers would leave every uncharged Auto Pay invoice held for good. Every held row is read, in
 * id-keyset pages, so rows the skips pass over never hide the rows behind them. 'true' releases each through releaseStaleAutopayHold; 'shadow'
 * writes at most one audit_log row per invoice per ET day and changes nothing; 'charge' charges the saved
 * Auto Pay method first (chargeStaleAutopayHold) and releases only a declined hold or one with no method, except that an
 * annual-prepay term rail invoice, an invoice bound to no visit and a bill no completion lane admits are never charged
 * (released as 'true' releases them), an over-cap, no-cap, unperformed or payer bill is kept for office review, and a bank
 * method waits for the invoice due date (no due date: released as 'true'); off returns before any query.
 */
async function releaseStaleAutopayHolds({ now = new Date(), pageSize = AUTOPAY_HOLD_SWEEP_PAGE } = {}) {
  const mode = require('../config/feature-gates').autopayHoldTimeoutMode();
  if (!['shadow', 'true', 'charge'].includes(mode)) return { mode: 'off', candidates: 0, released: 0, recorded: 0 };

  const cutoff = new Date(now.getTime() - AUTOPAY_HOLD_TIMEOUT_DAYS * 86400000);
  // Charge mode splits the holds: an annual-prepay term rail invoice is released as 'true' releases it (the 'true'
  // clause, termRail 'only'), every other hold is a charge candidate (termRail 'none'). 'true' and 'shadow' select once.
  const railDue = mode === 'charge'
    ? (await selectStaleAutopayHolds(cutoff, pageSize, { termRail: 'only' })).map((row) => ({ ...row, termRail: true }))
    : [];
  const due = await selectStaleAutopayHolds(cutoff, pageSize, mode === 'charge' ? { chargeMode: true, termRail: 'none' } : {});

  let released = 0;
  let recorded = 0;
  if (mode === 'charge') return chargeStaleAutopayHolds([...railDue, ...due], cutoff, now);
  if (mode === 'true') {
    for (const row of due) {
      if (await releaseStaleAutopayHold(row, cutoff, now)) released += 1;
    }
    logger.info(`[invoice-followups] autopay hold timeout: released ${released} of ${due.length} stale hold(s)`);
  } else {
    recorded = await recordShadowAutopayHolds(due, now);
    logger.info(`[invoice-followups] autopay hold timeout (shadow): ${due.length} would release, ${recorded} newly recorded`);
  }
  return { mode, candidates: due.length, released, recorded };
}

/**
 * Called per-customer when autopay fails — bumps the counter on every
 * active autopay-held sequence for that customer, and releases any whose
 * count has crossed the threshold.
 *
 * A customer-level schedule (dunning consolidation §8) is deliberately NOT
 * written here. Its autopay hold is not parked: the engine revisits an
 * `autopay_hold` schedule at every run and judges `customerOnAutopay` itself —
 * resumed (and sent in that same run) once the customer is off autopay, closed
 * once the balance is gone, held again while autopay still stands. Releasing
 * it here would hand the members back to the per-invoice ladder only for the
 * next run to promote them again; resuming it would be re-held at the next
 * revisit. The member rows below are still counted and released as before:
 * they are the schedule's membership state (a released member stops holding
 * the set as `member_autopay_hold`).
 */
async function handleAutopayFailure(customerId) {
  const rows = await db('invoice_followup_sequences')
    .where({ customer_id: customerId, status: 'autopay_hold' })
    .select('*');

  for (const row of rows) {
    const nextCount = row.autopay_failures_observed + 1;
    if (nextCount >= config.autopayFailureThreshold) {
      await releaseFromAutopayHold(row.invoice_id);
    } else {
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        autopay_failures_observed: nextCount,
      });
    }
  }
}

/**
 * Admin controls — called from the invoice detail UI.
 */
// approved (the Intelligence Bar's card pin only; the page passes none): { sequenceId, status, stepIndex }. The write is one
// conditional UPDATE on exactly that reminder state, so a stop, resume or cron advance after the card changes nothing
// ({ previewChanged: true }). The same pin is judged by resumeSequence and stopSequence under their row locks.
// A reminder claimed by a send in flight (touch_claimed_at) never matches: the send will write its own progression.
const matchesApprovedReminder = (seq, approved) => Boolean(seq) && String(seq.id) === String(approved.sequenceId)
  && seq.status === approved.status && seq.step_index === approved.stepIndex && !seq.touch_claimed_at;

async function pauseSequence(invoiceId, { reason, until, adminId, approved } = {}) {
  const query = db('invoice_followup_sequences').where({ invoice_id: invoiceId });
  if (approved) query.where({ id: approved.sequenceId, status: approved.status, step_index: approved.stepIndex }).whereNull('touch_claimed_at');
  const changed = await query.update({
    updated_at: db.fn.now(),
    status: 'paused',
    paused_reason: reason || null,
    paused_until: until || null,
    paused_by_admin_id: adminId || null,
    next_touch_at: null,
  });
  if (approved && !Number(changed)) return { previewChanged: true };
  return undefined;
}

// System settlement stops that resumeSequence's two AUTOMATIC re-arm
// callers (reverse-prepaid, annual-prepay coverage reopen) may lift on
// their own — never an admin's stop, and never a payment-plan stop that
// merely rode along under one of these reasons. stopSequence's
// preservePriorStop (:1636-1639) keeps the ORIGINAL reason/admin id on a
// row that was already 'stopped' before the system stop landed, so a row
// only carries one of these exact reasons with no admin id when the
// system stop really was the first/only stop — the same fence
// scheduleForInvoice's own isSystemVoidStop applies for the unvoid re-arm
// (:385-388).
const SYSTEM_SETTLEMENT_STOP_REASONS = ['annual_prepay_covered'];

// Strip the shared `:prev=<state>` suffix (stopSequence encodes the row's
// pre-stop status onto the reason so a later resume can restore it — see
// resumeSequence's own `:prev=paused` branch above) before comparing
// against the known system reasons: 'annual_prepay_covered:prev=paused' is
// exactly as system-owned as a bare 'annual_prepay_covered' (Codex round 1
// P2 — the exact-membership check here used to reject the suffixed variant
// outright, leaving a paused-then-covered-then-reversed sequence stopped
// forever).
function systemStopReasonBase(reason) {
  return String(reason || '').replace(/:prev=\w+$/, '');
}

// Every reason a SYSTEM caller passes to stopSequence today (invoice.js
// stopInvoiceFollowupSequence: the void lifecycle stop and the annual-prepay
// coverage stop). stopSequence only encodes the `:prev=paused` suffix on a
// stop with no admin id, and only these reasons arrive that way — so this
// set, with no admin attribution, is what makes the suffix trustworthy
// state metadata rather than operator free text (Codex round 3 P2).
const SYSTEM_STOP_REASONS = ['invoice_voided', 'annual_prepay_covered'];

// True when a stop stamp is one the SYSTEM wrote (recognized reason base,
// no admin attribution) — the only stamps whose `:prev=<state>` suffix
// may be read back as the row's pre-stop status. An admin-authored reason
// that happens to end in `:prev=paused` is free text, never metadata.
function isSystemStopStamp(seq) {
  return !seq.stopped_by_admin_id
    && SYSTEM_STOP_REASONS.includes(systemStopReasonBase(seq.stopped_reason));
}

// The eligibility rule for the two AUTOMATIC re-arm callers: a naturally
// completed row, or a stop the settlement itself created — never an admin's
// stop, never a payment-plan's. Pure; exercised through
// resumeSequenceIfSystemResumable (the only production caller) and, for the
// predicate alone, via the _test export — there is deliberately NO public
// read-then-decide helper, because composing a separate read with
// resumeSequence is exactly the check-then-act race the locked helper
// below exists to close.
function canSystemResume(seq) {
  if (!seq) return false;
  if (seq.status === 'completed') return true;
  return seq.status === 'stopped'
    && !seq.stopped_by_admin_id
    && SYSTEM_SETTLEMENT_STOP_REASONS.includes(systemStopReasonBase(seq.stopped_reason));
}

// Atomic check-and-act for the two AUTOMATIC re-arm callers: a separate
// eligibility read followed by a later resumeSequence call
// leaves a window where an admin's stop can commit in between — this
// FOR UPDATEs the row and resumes it, if eligible, inside the SAME
// transaction, so a concurrent admin stop either lands first (seen here,
// and correctly left alone) or waits behind this lock and applies its stop
// after we commit (also correct — the admin's later action always wins).
// Returns whether it resumed anything.
async function resumeSequenceIfSystemResumable(invoiceId) {
  return db.transaction(async (trx) => {
    const seq = await trx('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .forUpdate()
      .first('status', 'stopped_reason', 'stopped_by_admin_id');
    if (!canSystemResume(seq)) return false;
    await resumeSequence(invoiceId, trx);
    return true;
  });
}

// The reminder row a resume acts on. With the card's pin the whole resume runs on the row locked FOR UPDATE, and a row that no
// longer matches the card is { previewChanged: true } (nothing is written). Without a pin: the plain read, as always.
async function readResumableSequence(invoiceId, dbc, approved) {
  const seqQuery = dbc('invoice_followup_sequences').where({ invoice_id: invoiceId });
  if (approved) seqQuery.forUpdate();
  const seq = await seqQuery.first();
  if (approved && !matchesApprovedReminder(seq, approved)) return { previewChanged: true };
  return { seq };
}

// A paused row still carrying the hold marker must NOT resume into active dunning while the customer is still enrolled in
// Auto Pay: re-enter the hold on LIVE eligibility; a stale flag (customer since unenrolled) is dropped and the cadence resumes.
// Fail toward the QUIET state on a read error (Codex #3493 r15). failClosed: without it a payment_methods read error is
// swallowed inside the eligibility helper and reads as confirmed unenrollment (Codex #3493 r16).
async function resumeStillAutopayHeld(seq, invoiceId, dbc) {
  try {
    const customer = await dbc('customers').where({ id: seq.customer_id }).first();
    return customer ? await customerOnAutopay(customer, { db: dbc, failClosed: true }) : false;
  } catch (err) {
    logger.warn(`[invoice-followups] resume autopay re-check failed for invoice ${invoiceId} — keeping the hold: ${err.message}`);
    return true;
  }
}

async function resumeSequence(invoiceId, dbc = db, { approved = null } = {}) {
  // With the card's pin the whole resume runs in one transaction on the reminder row locked FOR UPDATE: a stop (or any other
  // change) that committed after the card is seen and nothing is written ({ previewChanged: true }); a stop that arrives later
  // waits for this commit. Every other caller keeps the unlocked read it always had.
  if (approved && !dbc.isTransaction) return dbc.transaction((trx) => resumeSequence(invoiceId, trx, { approved }));
  const { seq, previewChanged } = await readResumableSequence(invoiceId, dbc, approved);
  if (previewChanged) return { previewChanged: true };
  if (!seq) return;
  const invoice = await dbc('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;
  // A stop stamped with the shared `:prev=<state>` convention (stopSequence
  // :1700-1709, scheduleForInvoice's unvoid re-arm :385-388/:413-428)
  // preserved an underlying non-stopped state under the stop — e.g. a
  // 'paused' row that a later system stop (annual_prepay_covered, a void)
  // landed on top of, with no admin ever stopping it. Resuming must restore
  // THAT state, not steamroll straight into active dunning; checked before
  // exhaustion/hold so it takes priority the same way the unvoid re-arm's
  // repause branch does. The only encoded prior state today is 'paused',
  // and pauseSequence never touches next_touch_at/is_autopay_held on a
  // later stop, so restoring is just flipping status back — no other field
  // needs recomputing.
  // SYSTEM stamps only (Codex round 3 P2): this route also lifts admin
  // stops, whose reason is operator free text — "customer requested:prev=paused"
  // typed into the stop box must resume into active dunning like any other
  // admin stop, not be read as encoded state and leave the row paused.
  if (isSystemStopStamp(seq) && /:prev=paused$/.test(String(seq.stopped_reason || ''))) {
    await dbc('invoice_followup_sequences').where({ id: seq.id }).update({
      updated_at: dbc.fn.now(),
      status: 'paused',
      stopped_reason: null,
      stopped_by_admin_id: null,
      next_touch_at: null,
    });
    return;
  }
  // A shifted anchor (delivered-invoice due-date edit while paused) wins so
  // the re-armed step lands on the same timeline fireStep progression uses.
  const nextTouchAt = computeNextTouchAt(seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at, seq.step_index);
  if (!nextTouchAt) {
    // Sequence exhausted — step_index is past the last configured step, so
    // there is nothing to schedule. 'active' with a null due time is a dead
    // state: runPending can never select it, yet hasActiveSequence sees it
    // as live and suppresses the legacy late-payment checker — a reopened
    // invoice would never be reminded again. Restore terminal 'completed'
    // (clearing any plan-owned stamp: this is a natural completion now) so
    // the legacy checker owns the invoice again.
    await dbc('invoice_followup_sequences').where({ id: seq.id }).update({
      updated_at: dbc.fn.now(),
      status: 'completed',
      paused_reason: null,
      paused_until: null,
      paused_by_admin_id: null,
      stopped_reason: null,
      stopped_by_admin_id: null,
      next_touch_at: null,
    });
    return;
  }
  // A paused row still carrying the hold marker (e.g. a legacy
  // autopay_hold flattened by the 20260601000012 backfill and restored to
  // the quiet 'paused' state by the unvoid re-arm) must NOT resume into
  // active dunning while the customer is still enrolled — ordinary payment
  // reminders would fire before the failure threshold ever releases the
  // hold. Re-enter the hold on LIVE eligibility; a stale flag (customer
  // since unenrolled) is dropped and the cadence resumes. Fail toward the
  // QUIET state on a read error (Codex #3493 r15).
  if (seq.is_autopay_held && await resumeStillAutopayHeld(seq, invoiceId, dbc)) {
    await dbc('invoice_followup_sequences').where({ id: seq.id }).update({
      updated_at: dbc.fn.now(),
      status: 'autopay_hold',
      paused_reason: null,
      paused_until: null,
      paused_by_admin_id: null,
      stopped_reason: null,
      stopped_by_admin_id: null,
      next_touch_at: null,
    });
    return;
  }
  await dbc('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: dbc.fn.now(),
    status: 'active',
    // The stored hold marker survived only as far as the live-enrollment
    // check above — a resumed active cadence must not read as held.
    is_autopay_held: false,
    paused_reason: null,
    paused_until: null,
    paused_by_admin_id: null,
    // A re-armed row must carry NO stale stop stamp (codex PR r9 P1): a
    // lingering payment_plan_created:* on an active row would let a later
    // settlement cleanup claim an unrelated administrative pause as
    // plan-owned and flip it 'completed', re-arming dunning a dispute
    // reopen was supposed to leave alone.
    stopped_reason: null,
    stopped_by_admin_id: null,
    next_touch_at: nextTouchAt,
  });
}

/**
 * Shift an ACTIVE sequence's whole timeline after an admin edits a
 * delivered invoice's due date (the 2026-07-17 ruling made
 * sent/viewed/overdue invoices editable). Moving the due date +N days
 * moves the cadence anchor +N days and stamps it on the row
 * (`anchor_at`), so BOTH the current touch and every later step (fireStep
 * progression reads anchor_at first) stay on one shifted timeline —
 * re-anchoring only the current step would leave progression computing
 * later steps from sent_at in the past and burst the remaining reminders
 * on consecutive cron runs. Paused / autopay-held rows shift the anchor
 * but keep next_touch_at null until their release paths re-arm them;
 * stopped / completed rows are terminal and untouched.
 */
async function rescheduleForInvoiceEdit(invoiceId, { previousDueDate, newDueDate } = {}, dbc = db) {
  const dayMs = 24 * 60 * 60 * 1000;
  const prev = previousDueDate ? new Date(previousDueDate) : null;
  const next = newDueDate ? new Date(newDueDate) : null;
  if (!prev || !next || Number.isNaN(prev.getTime()) || Number.isNaN(next.getTime())) return;
  const deltaDays = Math.round((next.getTime() - prev.getTime()) / dayMs);
  if (!deltaDays) return;

  // Paused / autopay-held sequences shift their anchor too — their release
  // paths re-arm the CURRENT step themselves, but fireStep progression
  // computes later steps from anchor_at, and a stale anchor would land those
  // in the past and burst them on consecutive cron runs. Only an active
  // sequence carries a scheduled next touch; held/paused rows keep
  // next_touch_at null until released. Stopped/completed are terminal.
  const RESCHEDULABLE_STATUSES = ['active', 'paused', 'autopay_hold'];
  const seq = await dbc('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || !RESCHEDULABLE_STATUSES.includes(seq.status)) return;
  const invoice = await dbc('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  const baseAnchor = seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
  const shiftedAnchor = shiftAnchorNYCalendarDays(new Date(baseAnchor), deltaDays);
  const patch = { anchor_at: shiftedAnchor };
  if (seq.status === 'active') {
    patch.next_touch_at = computeNextTouchAt(shiftedAnchor, seq.step_index);
  }
  await dbc('invoice_followup_sequences').where({ id: seq.id })
    .update({ ...patch, updated_at: dbc.fn.now() });
}

/**
 * Advance an anchor by N America/New_York CALENDAR days. The cadence only
 * consumes an anchor's NY calendar date (anchorTo10amNY), so the shifted
 * anchor is pinned to noon UTC of the target day — fixed 24-hour arithmetic
 * would move a near-midnight anchor across the spring DST boundary onto the
 * wrong Eastern date and delay every remaining reminder by a day.
 */
function shiftAnchorNYCalendarDays(anchorDate, days) {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(anchorDate).map((p) => [p.type, p.value])
  );
  const base = new Date(Date.UTC(+nyParts.year, +nyParts.month - 1, +nyParts.day, 12));
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

async function stopSequence(invoiceId, { reason, adminId, approved } = {}) {
  // "Stop dunning" also means "don't force-collect on the pay page"
  // (payIncludeBalance): if this invoice rides another invoice's combined
  // PaymentIntent as a SIBLING, release that session — cancel the PI while
  // it is still unconfirmed and clear its stamps, so a customer mid-pay
  // reloads to a fresh total without this invoice instead of charging it
  // after the stop (codex #3427 r4 P1: the money-seam locks can't see a
  // stop that lands between the last verification and the browser's
  // confirm). Money already in flight (processing/succeeded) is never
  // touched — the stop can't retract a confirmed payment.
  //
  // FAIL CLOSED, release BEFORE the stop (codex r5 P1): the browser can
  // call Stripe confirmPayment directly with no later server verification,
  // so a swallowed cancel failure would report the stop as done while the
  // confirmable PI (post /update-amount) can still charge the stopped
  // invoice. The stop must not acknowledge until the release succeeds —
  // an unreadable PI throws too (it could be a combined session), and the
  // admin simply retries the stop.
  // The whole stop runs in ONE transaction holding the pay.combined.customer
  // advisory lock (codex r10 P1): without it, a combined /setup between this
  // PI read and the sequence commit could stamp the siblings AFTER the scan
  // saw no PI but BEFORE the stop landed — setup's stopped-dunning check
  // would pass and the customer could confirm a PI that still includes the
  // newly stopped invoice. Under the shared lock the stop and any setup are
  // strictly ordered: setup first → the release below cancels its PI; stop
  // first → setup's in-lock stopped-dunning re-check excludes the invoice.
  // The card's pin (approved: { sequenceId, status, stepIndex }; the page passes none): checked first, before anything is
  // released at Stripe, and again on the reminder row this transaction locks FOR UPDATE, before the stop is written.
  if (approved && !matchesApprovedReminder(await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first('id', 'status', 'step_index', 'touch_claimed_at'), approved)) {
    return { previewChanged: true };
  }
  let previewChanged = false;
  let needsInvoicesPage = false;
  const invoice = await db('invoices').where({ id: invoiceId }).first('id', 'customer_id', 'stripe_payment_intent_id', 'invoice_number');
  await db.transaction(async (trx) => {
    const PayCombined = require('./pay-combined');
    // The pre-transaction customer read can be OBSOLETE (codex r22 P1): a
    // merge holding both combined locks but not yet committed still shows
    // the loser's customer_id — locking that would serialize against the
    // wrong customer while /setup locks the winner. Re-read the owner
    // AFTER each lock and re-lock under the current owner if it moved
    // (xact locks accumulate, so old+new both stay held — strictly safer).
    if (invoice?.customer_id) {
      let ownerId = String(invoice.customer_id);
      for (let attempt = 0; ; attempt++) {
        await PayCombined.lockCombinedCustomers(trx, [ownerId]);
        const freshOwner = await trx('invoices').where({ id: invoiceId }).first('customer_id');
        const freshId = freshOwner?.customer_id ? String(freshOwner.customer_id) : null;
        if (!freshId || freshId === ownerId) break;
        if (attempt >= 4) throw new Error(`Invoice ownership kept changing while stopping dunning for ${invoiceId} — try again`);
        ownerId = freshId;
      }
    }
    // The card's pin, judged on the reminder row locked FOR UPDATE BEFORE anything is read or released at Stripe: a mismatch
    // leaves the transaction with no write at all. Same lock order as the stop always had (combined locks, then this row).
    if (approved) {
      const lockedSeq = await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).forUpdate().first('id', 'status', 'step_index', 'touch_claimed_at');
      if (!matchesApprovedReminder(lockedSeq, approved)) { previewChanged = true; return; }
    }
    // Re-read under the lock — a setup that committed while we waited may
    // have stamped a PI the unlocked read missed.
    const lockedInvoice = invoice
      ? await trx('invoices').where({ id: invoiceId }).first('id', 'stripe_payment_intent_id', 'invoice_number')
      : null;
    if (lockedInvoice?.stripe_payment_intent_id) {
      const StripeService = require('./stripe');
      let pi;
      try {
        pi = await StripeService.retrievePaymentIntent(lockedInvoice.stripe_payment_intent_id);
      } catch (err) {
        throw new Error(`Could not verify invoice ${lockedInvoice.invoice_number}'s active payment before stopping dunning (${err.message}) — try again`);
      }
      // Null = Stripe unconfigured, not "no session" (codex r23 P1): the
      // attached PI may be a live combined session a browser can still
      // confirm — the stop must not acknowledge past an unverifiable one.
      if (!pi) {
        throw new Error(`Could not verify invoice ${lockedInvoice.invoice_number}'s active payment before stopping dunning (payment service unavailable) — try again`);
      }
      const isSiblingOnCombined = pi
        && PayCombined.isCombinedPiMetadata(pi.metadata)
        && String(pi.metadata?.waves_invoice_id || '') !== String(invoiceId)
        && PayCombined.paymentIntentOwnsInvoice(pi.metadata, invoiceId);
      // NO microdeposit exemption (codex r11 P1): this release only fires
      // for a SIBLING riding someone else's combined PI — the stop is an
      // explicit "don't collect this invoice", and a pending bank
      // verification is still an uncaptured session that would charge the
      // stopped sibling once verified. Cancel it like the payer-change
      // fence does; only processing/succeeded money is left alone.
      const unconfirmed = pi && ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
      // The bar never cancels a combined session (nor cleans its stamps): it stops nothing and leaves the stop to the page.
      if (approved && isSiblingOnCombined && (pi.status === 'canceled' || unconfirmed)) { needsInvoicesPage = true; return; }
      if (isSiblingOnCombined && pi.status === 'canceled') {
        // A prior attempt's cancel succeeded but its transaction rolled
        // back (codex r26 P2) — finish the stamp cleanup on retry instead
        // of committing the stop past a dead-PI binding.
        await PayCombined.clearPaymentIntentStamps(trx, pi.id);
        logger.info(`[invoice-followups] stop-dunning on ${lockedInvoice.invoice_number}: combined PI ${pi.id} was already canceled — stamps cleaned on retry`);
      } else if (isSiblingOnCombined && unconfirmed) {
        try {
          await StripeService.cancelPaymentIntent(pi.id);
        } catch (err) {
          throw new Error(`Could not release the combined payment session holding invoice ${lockedInvoice.invoice_number} (${err.message}) — dunning NOT stopped, try again`);
        }
        await PayCombined.clearPaymentIntentStamps(trx, pi.id);
        logger.info(`[invoice-followups] stop-dunning on ${lockedInvoice.invoice_number} released combined PI ${pi.id} (unconfirmed) and cleared its stamps`);
      } else if (isSiblingOnCombined) {
        logger.warn(`[invoice-followups] stop-dunning on ${lockedInvoice.invoice_number}: combined PI ${pi.id} is ${pi.status} — money may be in flight, not touched`);
      }
    }
    // Preserve ANY pre-existing stop's fields under a SYSTEM stop
    // (Codex #3493 r3/r5): the void lifecycle stop used to overwrite
    // stopped_reason/stopped_by_admin_id, erasing the only evidence that
    // dunning was already stopped on purpose — the unvoid→resend re-arm
    // then read the row as system-owned ('invoice_voided') and revived
    // reminders someone had killed. Not limited to admin-ATTRIBUTED stops:
    // the admin stop route recorded a NULL admin id for a while (it read
    // req.user, which auth never populates), so legacy admin stops are
    // indistinguishable from system ones except by their reason — keeping
    // the original reason is what keeps the re-arm off them. An explicit
    // admin stop (adminId present) still re-attributes.
    // FOR UPDATE (Codex #3493 r8): without the lock, an admin stop that
    // commits between this read and the unconditional write below gets its
    // fresh attribution clobbered by the system stop. Locking serializes:
    // the admin's committed stop is seen (and preserved), or their write
    // waits for this one and re-attributes on top (adminId present wins).
    const priorSeq = await trx('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .forUpdate()
      .first('id', 'step_index', 'status', 'touch_claimed_at', 'stopped_reason', 'stopped_by_admin_id');
    if (approved && !matchesApprovedReminder(priorSeq, approved)) { previewChanged = true; return; }
    // A PLAN-owned stop is NOT preserved under a system stop (Codex #3493
    // r10): voidInvoice cancels the active plan in the same transaction, so
    // the plan-owned reason would be an orphan nothing can lift — the
    // resend re-arm recognizes only the void stamp, and isDunningStopped
    // suppresses the legacy path too. Genuine admin/system stops keep
    // their reason as before.
    const priorStopReason = String(priorSeq?.stopped_reason || '');
    const priorStopIsPlanOwned = priorStopReason.startsWith('payment_plan_created:');
    const preservePriorStop = !adminId
      && priorSeq
      && priorSeq.status === 'stopped'
      && !priorStopIsPlanOwned;
    // A PAUSED row's meaning must survive a SYSTEM stop even when the pause
    // carries NO metadata (Codex #3493 r8 P0: the old pause route recorded a
    // null admin id and the UI permits a blank reason, so legacy pauses can
    // have every paused_* field null). Encode the prior status into the
    // stop stamp with the same `:prev=<status>` convention the payment-plan
    // stop uses; the resend re-arm restores 'paused' from it.
    // Carry a pause through the round trip: a paused row, OR a replaced
    // plan stamp that itself recorded prev=paused, keeps the pause
    // encoded on the new stamp so the resend re-arm restores 'paused'.
    const encodePausedPrev = !adminId && priorSeq
      && (priorSeq.status === 'paused'
        || (priorStopIsPlanOwned && priorStopReason.endsWith(':prev=paused')));
    await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).update({
      updated_at: trx.fn.now(),
      status: 'stopped',
      next_touch_at: null,
      ...(preservePriorStop ? {} : {
        stopped_reason: encodePausedPrev
          ? `${reason || 'stopped'}:prev=paused`
          : (reason || null),
        stopped_by_admin_id: adminId || null,
      }),
    });
  });
  if (needsInvoicesPage) return { needsInvoicesPage: true };
  return previewChanged ? { previewChanged: true } : undefined;
}

// An operator send-now with nothing to send never answers as a success (the panel would toast "Done" over
// a click that sent nothing): the route turns these into a 409 with this copy.
const SEND_NOW_FINISHED = Object.freeze({
  ok: false, reason: 'nothing_to_send', message: 'Not sent: this invoice is paid or its reminders are finished.',
});
const SEND_NOW_PREVIEW_CHANGED = Object.freeze({
  ok: false, reason: 'preview_changed', message: 'The invoice or its reminder changed after the card was shown, so nothing was sent.',
});
const SEND_NOW_NO_SEQUENCE = Object.freeze({
  ok: false, reason: 'nothing_to_send', message: 'Not sent: this invoice has no follow-up reminders.',
});

/**
 * Send the next touch right now, even if it's not due yet. Virginia uses this
 * when a customer is dodging (e.g. "push them to day-14 language today").
 *
 * Returns undefined for a per-invoice send that went to fireStep, and
 * { ok: false, reason: 'nothing_to_send', message } when there is nothing to
 * send (no sequence, a stopped / completed one, a paid or void invoice). For a
 * customer on an open customer-level schedule it returns the schedule's
 * send-now result ({ routedTo: 'customer_schedule', scheduleId, ... },
 * customer-dunning/wiring.js). The combined step goes out only when `combined`
 * ({ scheduleId, stepIndex }, the step the operator was shown and confirmed)
 * names that schedule at its current step; otherwise nothing is sent
 * (COMBINED_CONFIRM_REQUIRED, or SCHEDULE_CHANGED for a step that moved on). A
 * `combined` confirmation for a customer no longer on a schedule sends nothing
 * either: the invoice's own step is not the message the operator confirmed
 * (COMBINED_SCHEDULE_CLOSED).
 *
 * A `combined` confirmation is judged BEFORE this invoice's own exits: the
 * operator confirmed the schedule's step, not this invoice's, so this invoice
 * having been paid (or its row finished) since the panel loaded does not end
 * the click while the schedule still covers the customer's other invoices.
 */
const Wiring = () => require('./customer-dunning/wiring');

// A `combined` confirmation names a customer schedule: judged BEFORE this invoice's own exits, under the customer's dunning key
// (SHARED), as every per-invoice path reads ownership.
async function sendNowCombined(invoiceId, seq, combined) {
  const customerId = seq?.customer_id
    ?? (await db('invoices').where({ id: invoiceId }).first('customer_id'))?.customer_id ?? null;
  if (!customerId) return Wiring().combinedScheduleClosed(combined.scheduleId);
  let owner = null;
  await db.transaction(async (trx) => {
    await lockCustomerDunningShared(trx, customerId);
    owner = await openCustomerScheduleId(trx, customerId);
  });
  return owner
    ? Wiring().sendNowForInvoiceOnSchedule(owner, customerId, combined)
    : Wiring().combinedScheduleClosed(combined.scheduleId);
}

// The Intelligence Bar's card pin (approved: { sequenceId, status, stepIndex, invoiceUpdatedAtMs }), judged under the invoice row
// lock and the reminder row lock: the reminder the card showed is still this reminder, still unclaimed, on the same step, and
// the invoice is as it was. Returns the claim stamp taken in the SAME locked UPDATE (no re-arm: the due time is left alone, so
// there is no moment at which the row is due and unclaimed for the cron's runPending to take), or null when anything differs
// (nothing is written, so a pause or a cron advance that landed after the card is never overwritten).
async function claimApprovedSendNow(trx, seq, invoiceId, approved) {
  const lockedInvoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first('updated_at');
  const liveSeq = await trx('invoice_followup_sequences').where({ id: seq.id }).forUpdate()
    .first('id', 'status', 'step_index', 'next_touch_at', 'touch_claimed_at');
  const sameInvoice = lockedInvoice && (lockedInvoice.updated_at ? new Date(lockedInvoice.updated_at).getTime() : null) === approved.invoiceUpdatedAtMs;
  const sameReminder = liveSeq && String(liveSeq.id) === String(approved.sequenceId) && liveSeq.status === approved.status
    && liveSeq.step_index === approved.stepIndex && !liveSeq.touch_claimed_at;
  if (!sameInvoice || !sameReminder) return null;
  const claim = new Date();
  await trx('invoice_followup_sequences').where({ id: seq.id }).update({ updated_at: trx.fn.now(), touch_claimed_at: claim });
  return claim;
}

// The page's click: set next_touch_at in the past + status active so fireStep takes it as due.
function rearmForSendNow(trx, seq) {
  return trx('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: trx.fn.now(),
    status: 'active',
    next_touch_at: new Date(Date.now() - 1000),
  });
}

// Unless the customer is on a customer-level schedule (then the click needs the operator's confirmation of the schedule's
// CURRENT step, refused here with nothing sent, and this membership row is left exactly as it is), claim (approved) or re-arm
// (page). Checked and written under the customer's dunning key (SHARED), so a promotion cannot commit between the check and
// the write. Returns { ownedBy, previewChanged, claim }.
async function armSendNow(seq, invoiceId, approved) {
  const armed = { ownedBy: null, previewChanged: false, claim: null };
  await db.transaction(async (trx) => {
    await lockCustomerDunningShared(trx, seq.customer_id);
    armed.ownedBy = await openCustomerScheduleId(trx, seq.customer_id);
    if (armed.ownedBy) return;
    if (!approved) { await rearmForSendNow(trx, seq); return; }
    armed.claim = await claimApprovedSendNow(trx, seq, invoiceId, approved);
    armed.previewChanged = !armed.claim;
  });
  return armed;
}

// The approved send's claim is released after a refusal before fireStep, and only while it is still this call's claim (a stamp
// that moved on is somebody else's). No claim (the page's click) = nothing to release.
function releaseSendNowClaimFor(seqId, claim, invoiceId) {
  if (!claim) return undefined;
  return db('invoice_followup_sequences')
    .where({ id: seqId, touch_claimed_at: claim })
    .update({ updated_at: db.fn.now(), touch_claimed_at: null })
    .catch((err) => logger.warn(`[invoice-followups] could not release the claim after a refused send-now on ${invoiceId}: ${err.message}`));
}

function loadSendNowRow(seqId) {
  return db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.id', seqId)
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied', 'i.amount_paid',
      'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
    )
    .first();
}

// The template content hash as it is live now, or null when it cannot be read (then it matches nothing).
async function liveEmailTemplateHash(stepIndex) {
  try {
    const Library = require('./email-template-library');
    const templateKey = FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[followupSteps()[stepIndex]?.id];
    const loaded = templateKey ? await Library.loadTemplateByKey(templateKey) : null;
    return loaded?.template && loaded.activeVersion ? Library.templateContentHash(loaded.template, loaded.activeVersion) : null;
  } catch { return null; }
}

// What the card pinned, against the row fireStep will claim and the live template, before the send (a cron advance between the
// claim and this read; a changed email sends neither leg; sendTemplate enforces the same hash again at the email send itself).
// An approved send-now that names the email must carry its hash: without one the email would go out unrestricted.
// Returns SEND_NOW_PREVIEW_CHANGED or null.
async function approvedSendRefusal(approved, row) {
  if (!approved) return null;
  if (row.step_index !== approved.stepIndex) return SEND_NOW_PREVIEW_CHANGED;
  if (approvedSendPlan(approved).email && !approved.emailContentHash) return SEND_NOW_PREVIEW_CHANGED;
  if (approved.emailContentHash && await liveEmailTemplateHash(row.step_index) !== approved.emailContentHash) return SEND_NOW_PREVIEW_CHANGED;
  return null;
}

// The exits before anything is armed: a combined confirmation, no sequence, a finished sequence, a finished invoice.
async function sendNowEarlyExit(invoiceId, seq, combined) {
  if (combined) return sendNowCombined(invoiceId, seq, combined);
  if (!seq) return SEND_NOW_NO_SEQUENCE;
  if (seq.status === 'stopped' || seq.status === 'completed') return SEND_NOW_FINISHED;
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  return !invoice || isTerminalInvoice(invoice) ? SEND_NOW_FINISHED : null;
}

// What the click returns once fireStep has answered. fired.ownedBy: a promotion that committed after the arm (fireStep refused
// under the key; nothing was claimed or sent), so the click needs the schedule's step confirmed. fired.previewChanged: the
// approved send found the card out of date. Otherwise `report` gives what each leg did ({ legs: null } = the run could not
// establish it), or { notClaimed } when another run held the reminder (nothing was sent by this click).
async function sendNowResult(fired, { seq, report, release }) {
  if (fired?.ownedBy) return Wiring().sendNowForInvoiceOnSchedule(fired.ownedBy, seq.customer_id, null);
  if (fired?.previewChanged) {
    await release();
    return SEND_NOW_PREVIEW_CHANGED;
  }
  return report ? { ok: true, report: fired || { legs: null } } : undefined;
}

async function sendNextTouchNow(invoiceId, { operatorInitiated = false, combined = null, approved = null, report = false } = {}) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  const early = await sendNowEarlyExit(invoiceId, seq, combined);
  if (early) return early;

  const armed = await armSendNow(seq, invoiceId, approved);
  if (armed.previewChanged) return SEND_NOW_PREVIEW_CHANGED;
  if (armed.ownedBy) return Wiring().sendNowForInvoiceOnSchedule(armed.ownedBy, seq.customer_id, null);

  const release = () => releaseSendNowClaimFor(seq.id, armed.claim, invoiceId);
  const row = await loadSendNowRow(seq.id).catch(async (err) => { await release(); throw err; });
  const refusal = row ? await approvedSendRefusal(approved, row) : SEND_NOW_FINISHED;
  if (refusal) {
    await release();
    return refusal;
  }
  const claim = armed.claim && { preClaimed: true, claimStamp: armed.claim };
  const reportOut = report ? {} : null;
  const fired = await fireStep(row, { operatorInitiated, approved, report: reportOut, claim });
  return sendNowResult(fired, { seq, report, release });
}

/**
 * Decides whether an invoice is already handled by the per-invoice sequence
 * (so the account-level reminder skips it).
 */
async function hasActiveSequence(invoiceId) {
  const ladder = ladderThrough90Live();
  const legacyCount = config.steps.length;
  const query = db('invoice_followup_sequences')
    .where({ invoice_id: invoiceId })
    .whereIn('status', ['active', 'paused', 'autopay_hold', ...(ladder ? ['completed'] : [])]);
  if (ladder) {
    // Under the Day 90 ladder a sequence that ran past the Day 30 end still
    // owns its invoice, so the late-payment checker and the balance workflow
    // do not pick it up afterwards (the handoff behind most customers
    // reminded by two systems within a week). A payment finish before that
    // (a lower step) does not: if a dispute reopens that invoice, the
    // checker handles it as before (codex #5126 r1). Finishes at Day 60 or
    // Day 90 on an open invoice are resumed by the ladder's next run.
    query.whereNot(function paidBeforeDay30End() {
      this.where('status', 'completed').where('step_index', '<', legacyCount);
    });
  } else {
    // Gate off after the Day 90 ladder advanced an active row past Day 30:
    // the legacy cadence never fires that step, so the row no longer holds
    // the invoice and the legacy checker takes over (codex #5126 r1).
    // Pauses and autopay holds keep holding it. Legacy rows never have an
    // active step past the legacy count.
    query.whereNot(function advancedByLadder() {
      this.where('status', 'active').where('step_index', '>=', legacyCount);
    });
  }
  const seq = await query.first();
  return !!seq;
}

/**
 * When a sequence's next touch will actually fire, for readers outside this
 * module that run before it (the annual-prepay reminder's same-day
 * suppression, codex #5126 r1). Under the Day 90 ladder a touch stored on
 * the legacy Day 7 or Day 14 fires on its Day 10 or Day 17, which this
 * module's next run writes back, and a sequence finished at the Day 60 or
 * Day 90 step on its open invoice is resumed by that run: its touch is the
 * first step not already past its send day, the one the run would send. A
 * step past the live cadence fires no touch at all. `seq` carries status,
 * step_index, next_touch_at, anchor_at and created_at; the invoice supplies
 * the send-time anchor when needed.
 */
async function liveNextTouchAt(invoiceId, seq, now = new Date()) {
  if (!seq) return null;
  const index = Number(seq.step_index);
  const steps = followupSteps();
  const pendingRevival = ladderThrough90Live() && seq.status === 'completed'
    && index >= config.steps.length && index < steps.length;
  if (!pendingRevival && (!seq.next_touch_at || index >= steps.length)) return null;
  // Gate off, only a step the two cadences time differently can need the
  // anchor: a touch the ladder scheduled goes back to its legacy day.
  const cadencesDiffer = config.steps[index]?.daysAfterSend !== config.stepsThrough90[index]?.daysAfterSend;
  if (!ladderThrough90Live() && !cadencesDiffer) return seq.next_touch_at;
  let anchored = seq;
  if (!seq.anchor_at) {
    const invoice = await db('invoices').where({ id: invoiceId }).first('sent_at', 'sms_sent_at', 'created_at');
    anchored = {
      ...seq, invoice_sent_at: invoice?.sent_at, invoice_sms_sent_at: invoice?.sms_sent_at, invoice_created_at: invoice?.created_at,
    };
  }
  if (!ladderThrough90Live()) return legacyTouchFor(anchored, now) || seq.next_touch_at;
  if (pendingRevival) {
    let step = index;
    let due = computeNextTouchAt(sequenceAnchor(anchored), step);
    while (due && isStaleTouch(due, now)) {
      step += 1;
      due = computeNextTouchAt(sequenceAnchor(anchored), step);
    }
    return due;
  }
  const due = computeNextTouchAt(sequenceAnchor(anchored), index);
  return due && due.getTime() > new Date(seq.next_touch_at).getTime() ? due : seq.next_touch_at;
}

/**
 * True when an admin has explicitly STOPPED this invoice's follow-up sequence.
 * A stop is a deliberate "stop all automated dunning for this invoice" instruction
 * (e.g. customer is paying by mailed check). The account-level balance reminder
 * must honor it too — otherwise stopping follow-ups in the invoice UI silently hands
 * the customer off to the legacy reminder path and they keep getting "X days overdue"
 * texts. `hasActiveSequence` deliberately excludes 'stopped' (a stopped sequence is no
 * longer "active"/handling the invoice), so this is a separate, explicit check.
 */
async function isDunningStopped(invoiceId, database = db) {
  const seq = await database('invoice_followup_sequences')
    .where({ invoice_id: invoiceId, status: 'stopped' })
    .first();
  return !!seq;
}

module.exports = {
  voidStopRearmDecision,
  voidStopRearmAnchor,
  isSystemVoidStop,
  activePaymentPlan,
  adoptOrphanInvoices,
  scheduleForInvoice,
  planFollowupSequence,
  followupArmBlock,
  runPending,
  // Used by the scheduled-SMS executor to suppress stale deferred
  // invoice/dunning replays (paid/void overnight).
  isTerminalInvoice,
  stopOnPayment,
  releaseFromAutopayHold,
  releaseStaleAutopayHolds,
  AUTOPAY_HOLD_TIMEOUT_DAYS,
  handleAutopayFailure,
  pauseSequence,
  resumeSequence,
  resumeSequenceIfSystemResumable,
  // The Intelligence Bar's resume card: whether the resume would return the reminders to their Auto Pay hold.
  resumeStillAutopayHeld,
  rescheduleForInvoiceEdit,
  stopSequence,
  sendNextTouchNow,
  hasActiveSequence,
  isDunningStopped,
  followupSteps,
  liveNextTouchAt,
  skipStaleTouches,
  firstEligibleFireAt,
  STALE_TOUCH_GRACE_MS,
  ladderThrough90Live,
  // Cadence helpers, exported for services/customer-dunning/ (dunning
  // consolidation) so the customer schedule computes step dates with the
  // exact code the per-invoice ladder uses. No logic lives behind these.
  computeNextTouchAt,
  anchorTo10amNY,
  sequenceAnchor,
  heldTouchFloor,
  adoptionLanding,
  isStaleTouch,
  FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID,
  markAtRiskForLongOverdue,
  adoptOrphanInvoicesLive,
  // The Intelligence Bar's send-now card: the same text rendering and digest the service pins at dispatch.
  approvalDigest,
  renderApprovalSmsBody,
  followupEmailPayload,
  renderedEmailFingerprint,
  // Exported for tests only (fireStep + the batch ownership predicate: the
  // customer-dunning PostgreSQL concurrency suite drives them directly).
  _test: {
    canSystemResume, isSystemStopStamp, holdTouchUntilNextDay, fireStep, notOwnedByCustomerSchedule, notOwnedOrMicrodepositCandidate,
    reviveLegacyFinishedSequences, reviveReopenedLowStepSequences, releaseStaleAutopayHold,
  },
};
