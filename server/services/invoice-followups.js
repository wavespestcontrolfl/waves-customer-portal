const crypto = require('crypto');
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
const StripeService = require('./stripe');
const { sendMicrodepositVerificationEmail } = require('./microdeposit-verification-email');
const config = require('../config/invoice-followups');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { customerOnAutopay } = require('./autopay-eligibility');
const { publicPortalUrl } = require('../utils/portal-url');
const EmailTemplateLibrary = require('./email-template-library');
const { currency } = require('./email-template');
const { formatDateOnly } = require('../utils/date-only');
const { explicitBillingChannels } = require('./billing-delivery-channels');
const { dispatchUnderBillingEmailAuthority } = require('./billing-channel-email-authority');
const {
  billingEmailRecipient, operatorEmailRecipient, selfPayOnlyHandoff, billingEmailSendOutcome, billingEmailSendFailure,
} = require('./billing-email-sender');
const { verdictAllows, verdictDurablyDenied } = require('./billing-reminder-delivery');
const { anchorInvoiceOf } = require('./collections/account-anchor');

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
// Delivered statuses, the whitelist late-payment-checker.js's own candidate
// query uses: a sequence is only revived on an invoice the customer has.
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

// Collections policy consult lives in the SHARED rail guard (codex
// 2026-08-14: one implementation, not three that drift) — gate-off
// byte-identical, per-channel verdicts, invoice-membership required.
const { collectionsChannelPermitted: railGuardPermitted } = require('./collections/rail-guard');

// invoiceIds (combined touch, GATE_DUNNING_COMBINED_MESSAGE): every quoted
// invoice must be eligible, not just one — rail-guard.js's aggregate-rail
// contract. Omitted (the single-invoice path's every call site), the
// verdict is scoped to `invoiceId` alone, unchanged.
async function collectionsChannelPermitted(customerId, invoiceId, channel, excludeLedgerIds = [], detail = false, invoiceIds = null) {
  return railGuardPermitted({
    customerId, invoiceId, invoiceIds, channel, purpose: 'late_payment', excludeLedgerIds, logTag: 'invoice-followups', detail,
  });
}

function followupLedgerKey(row, step, channel) {
  return `invoice_followups:${row.id}:${step.id}:${channel}`;
}

async function currentStepLedgerIds(row, step, channels) {
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') return [];
  if (!channels.length) return [];
  const rows = await db('collections_contact_ledger')
    .where({ source: 'invoice_followups' })
    .whereIn('idempotency_key', channels.map((channel) => followupLedgerKey(row, step, channel)));
  return (rows || []).map((entry) => entry.id);
}

// Combined-touch twin of currentStepLedgerIds: the combined lane's own
// reservations use a DIFFERENT idempotency-key shape
// (invoice_followups:combined:<customerId>:<step.id>:<includedIdsKey>:<channel>,
// not the per-invoice followupLedgerKey) — but the SAME stability
// contract: no date component, stable for as long as this exact included-
// invoice-set sits at this exact step (one "episode"), same as
// followupLedgerKey's own row.id+step.id+channel shape (Fable review P2 —
// a day-scoped key would mint a FRESH reservation on every retry across a
// day boundary, losing claimAttempt's "a prior attempt's outcome is still
// unconfirmed" protection for a held touch retried tomorrow). A retry —
// same day or a later one after a hold — must exclude THESE keys too, or
// the policy consult can see the earlier partial attempt's own contact and
// deny the retry (Codex pre-push r2).
async function currentCombinedStepLedgerIds(customerId, step, includedIdsKey, channels) {
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') return [];
  if (!channels.length) return [];
  const rows = await db('collections_contact_ledger')
    .where({ source: 'invoice_followups' })
    .whereIn('idempotency_key', channels.map((channel) => `invoice_followups:combined:${customerId}:${step.id}:${includedIdsKey}:${channel}`));
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

// balanceIncomplete on ANY consulted channel's verdict (rail-guard.js) means
// the collections policy's own debt evidence was partial when it decided —
// billing-reminder-delivery.js's sendReminderChannels holds its WHOLE
// pending episode on this signal rather than deliver against a balance it
// cannot yet vouch for (partial evidence cannot authorize a leg OR settle a
// waiver). Shared by fireTouch and the combined touch so both dunning rails
// apply the identical rule.
function policyBalanceIncomplete(policyResults) {
  return (policyResults || []).some((verdict) => verdict && verdict.balanceIncomplete);
}

// The end-of-touch "nothing delivered, nothing held" decision fireTouch
// applies to its one invoice: a transient collections-policy/ledger reason
// leaves the sequence armed and due so a later tick re-decides (pausing
// terminally here would turn a 24h frequency window into a permanently
// silenced sequence); anything else is a genuine terminal failure and the
// sequence is paused. `reasons` is every skip/refusal reason gathered
// across the touch's leg(s); `pausedReason` is what gets stamped when this
// is NOT transient. Shared with the combined touch (fireCombinedTouchClaimed)
// so a customer's whole group is disposed of exactly the way fireTouch
// would dispose of a single invoice.
function noDeliveryDisposition(reasons, pausedReason) {
  const TRANSIENT_REASONS = ['collections_policy_denied', 'ledger_unavailable'];
  if ((reasons || []).some((reason) => TRANSIENT_REASONS.includes(reason))) return { leaveArmed: true };
  return { leaveArmed: false, pausedReason: pausedReason || 'no_channel_delivered' };
}

async function settleFollowupEmailLedger(ContactLedger, ledger, result, explicit, originalDeliveryTimes) {
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

async function sendFollowupEmail({ row, customer, step, ctx, enforceBillingPreference = true }) {
  const templateKey = FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!templateKey) return { ok: false, skipped: true, reason: 'no_email_template_mapping' };

  const latestInvoice = await db('invoices').where({ id: row.invoice_id }).first().catch(() => null);
  if (!latestInvoice || isTerminalInvoice(latestInvoice)) {
    return { ok: false, skipped: true, reason: 'invoice_not_eligible' };
  }
  // OWNERSHIP on the email leg's own fresh row (local audit on r42): the
  // pre-dispatch guard added for the text protects only that leg, and this
  // read checked terminal status alone — a payer assigned since the batch
  // would still email the homeowner a payment demand for AP-owned debt.
  if (latestInvoice.payer_id || invoiceWithdrawnFromCustomer(latestInvoice)) {
    return { ok: false, skipped: true, reason: 'invoice_payer_billed' };
  }

  const authorityInput = {
    customerId: customer.id, invoiceId: row.invoice_id, channel: 'email',
    metadata: { billingDeliveryCategory: 'invoice' },
  };
  // Who this email may go to. The customer's billing choices, recipient and
  // invoice ownership come from the shared billing email authority (owner
  // ruling 2026-09-27), read here and again under its locks at the provider
  // handoff. An operator's explicit send skips the customer's choices, as
  // before, and rechecks ownership only.
  const { recipient, to, refusal } = enforceBillingPreference
    ? await billingEmailRecipient(authorityInput, 'invoice-followups')
    : await operatorEmailRecipient(customer, 'invoice-followups');
  if (refusal) return refusal;

  const payload = {
    first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
    invoice_title: ctx.invoiceTitle || latestInvoice.title || latestInvoice.service_type || 'your service',
    invoice_number: latestInvoice.invoice_number || row.invoice_number || '',
    amount_due: currency(invoiceAmountDue(latestInvoice)),
    due_date: formatDateOnly(latestInvoice.due_date, { fallback: '' }),
    service_date: formatDateOnly(latestInvoice.service_date, { fallback: '' }),
    service_date_clause: ctx.serviceDate ? ` completed on ${ctx.serviceDate}` : '',
    pay_url: ctx.payUrl,
    customer_portal_url: `${publicPortalUrl()}/?tab=billing`,
  };

  const log = (fields) => logFollowupEmailAttempt({
    customerId: customer.id, invoiceId: row.invoice_id, stepId: step.id, templateKey, ...fields,
  });
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to,
      payload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `invoice_followup:${row.invoice_id}:${step.id}`,
      idempotencyKey: `invoice_followup_email:${row.invoice_id}:${step.id}`,
      categories: ['invoice_followup', step.id],
      suppressionGroupKey: 'transactional_required',
      withProviderHandoff: enforceBillingPreference
        ? (dispatch) => dispatchUnderBillingEmailAuthority({
          input: authorityInput, recipientEmail: to, templateKey, dispatch, state,
        })
        : selfPayOnlyHandoff(row.invoice_id, state),
    });
    return await billingEmailSendOutcome(result, state, log);
  } catch (err) {
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

// GATE_DUNNING_COMBINED_MESSAGE (dunning unification PR 2b), read at call
// time (strict 'true'): a customer with 2+ overdue invoices whose follow-up
// touches are due in the SAME run gets ONE combined text and ONE combined
// email instead of one per invoice. Off: byte-identical to today (every due
// row fires through fireStep exactly as before). Dark: off unless exactly
// 'true'. Wording awaits owner approval — do not flip until it is signed
// off (see the seed migration).
function combinedMessageLive() {
  return process.env.GATE_DUNNING_COMBINED_MESSAGE === 'true';
}

// SMS/email template keys for the combined touch, keyed by the SAME step id
// FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID uses (stable across the Day 90 ladder
// gate — see config/invoice-followups.js).
const COMBINED_SMS_TEMPLATE_BY_STEP_ID = {
  d3_friendly: 'invoice_followup_combined_3day',
  d7_reminder: 'invoice_followup_combined_10day',
  d14_firmer: 'invoice_followup_combined_17day',
  d30_final: 'invoice_followup_combined_30day',
  d60_reminder: 'invoice_followup_combined_60day',
  d90_final_notice: 'invoice_followup_combined_90day',
};
const COMBINED_EMAIL_TEMPLATE_BY_STEP_ID = {
  d3_friendly: 'invoice.followup_combined_3_day',
  d7_reminder: 'invoice.followup_combined_10_day',
  d14_firmer: 'invoice.followup_combined_17_day',
  d30_final: 'invoice.followup_combined_30_day',
  d60_reminder: 'invoice.followup_combined_60_day',
  d90_final_notice: 'invoice.followup_combined_90_day',
};

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

function computeNextTouchAt(anchorDate, stepIndex) {
  const step = followupSteps()[stepIndex];
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

/**
 * Create (or re-hydrate) a sequence row for a newly-issued invoice.
 * Call this from the invoice-send flow.
 */
async function scheduleForInvoice(invoiceId, { adoption = false } = {}) {
  // Cheap unlocked pre-checks: a missing / non-schedulable / payer-billed
  // invoice never arms a sequence, and none of those verdicts can be flipped
  // by an ownership change (a merge moves customer_id, not status or payer).
  // Re-verified
  // under the lock below, so a status change racing this read is caught there.
  const preview = await db('invoices').where({ id: invoiceId }).first();
  if (!preview) return null;
  if (!isSchedulableInvoice(preview)) return null;
  // Third-party Bill-To: the follow-up/dunning sequence emails and texts the
  // homeowner with the pay link, but a payer-billed invoice's AR rolls to the
  // payer's AP inbox — never chase the homeowner for it. Phase 1 has no payer
  // dunning sequence, so we simply don't arm follow-ups for payer invoices.
  // The withdrawal stamp is the same signal in the other direction (Codex
  // #4311 r31 P1): a combined-visit invoice whose Bill-To moved AFTER the
  // homeowner already held its pay link keeps `payer_id` NULL and a
  // collectible status, so a payer_id-only guard would arm dunning that
  // chases the homeowner for debt the payer now owes.
  if (preview.payer_id || invoiceWithdrawnFromCustomer(preview)) return null;

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
    if (!isSchedulableInvoice(invoice)) return null;
    if (invoice.payer_id || invoiceWithdrawnFromCustomer(invoice)) return null;

    // Existing-row check moved under the lock too: it and the INSERT must be
    // one atomic decision, or two concurrent arms race the unique(invoice_id).
    const existing = await trx('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
    // Orphan adoption only arms an invoice that has NO row: one that gained
    // a row since the sweep selected it belongs to whoever armed it.
    if (adoption && existing) return null;
    if (existing) {
      // Unvoid → resend lifecycle re-arm (Codex #3493 r2): voidInvoice
      // terminally stops the sequence with the SYSTEM stop
      // 'invoice_voided' (no admin id). An unvoided invoice keeps that
      // stop while it sits in draft — dunning must never fire against an
      // unpublished draft — and the RESEND (which is what calls this
      // function, after the status flip out of draft) is the lifecycle
      // point where reminders become legitimate again. Re-arm holds the
      // invoice lock here, and the UPDATE stays conditional on the exact
      // system stop, so a concurrent admin pause/stop (which rewrites
      // status/stopped_* under this same lock) wins and is never
      // clobbered. An autopay-held row goes back to 'autopay_hold', not
      // 'active' — activating it would dun an autopay customer (same rule
      // as the payment-plan reopen path); autopay standing is also
      // re-checked live in case enrollment changed while the row was
      // stopped. An exhausted cadence restores terminal 'completed' so
      // the legacy late-payment checker owns the invoice again (mirrors
      // resumeSequence's exhausted branch).
      // The void stop over a PAUSED row carries the ':prev=paused' suffix
      // (same convention as the payment-plan stop) so a metadata-less
      // legacy pause survives the void round-trip.
      // 'invoice_terminal_status:void' is the SAME system stop stamped by
      // the 20260601000012 backfill migration on sequences voided before
      // the runtime hook existed — without lifting it, a legacy voided
      // invoice restored and resent would never be reminded again
      // (Codex #3493 r12 P0).
      const voidStopStamp = String(existing.stopped_reason || '');
      const isSystemVoidStop = existing.status === 'stopped'
        && ['invoice_voided', 'invoice_voided:prev=paused', 'invoice_terminal_status:void'].includes(voidStopStamp)
        && !existing.stopped_by_admin_id;
      if (isSystemVoidStop) {
        // Never re-arm under an ACTIVE payment plan (Codex #3493 r6): plan
        // creation can't take ownership of a void-stopped row (its restamp
        // deliberately skips stops with non-plan reasons), so a plan created
        // between unvoid and resend leaves 'invoice_voided' in place — the
        // plan owns collection, and reviving ordinary dunning here would dun
        // a customer who is already paying. Same check as the INSERT path
        // below, under the same invoice lock.
        const planActive = await trx('payment_plans')
          .where({ invoice_id: invoiceId, status: 'active' })
          .first('id');
        if (planActive) return existing;
        // A pre-void ADMIN PAUSE survives the void stop as the retained
        // paused_* fields (stopSequence never clears them) or, for
        // metadata-less legacy pauses, as the ':prev=paused' stamp —
        // restore the PAUSE, not active dunning (Codex #3493 r3/r8). Same
        // conditional shape as the re-arm below so a racing admin write
        // still wins.
        // The LEGACY migration stamp restores to PAUSED unconditionally
        // (Codex #3493 r14 P0): the 20260601000012 backfill flattened
        // active/paused/autopay_hold rows to one stamp, and a blank-reason
        // legacy pause left NO recoverable signal — restoring to active
        // could revive reminders an admin explicitly paused. The quiet
        // state is the safe direction; the operator resumes deliberately.
        if (voidStopStamp === 'invoice_voided:prev=paused'
          || voidStopStamp === 'invoice_terminal_status:void'
          || existing.paused_reason || existing.paused_by_admin_id || existing.paused_until) {
          const [repaused] = await trx('invoice_followup_sequences')
            .where({ id: existing.id, status: 'stopped', stopped_reason: voidStopStamp })
            .whereNull('stopped_by_admin_id')
            .update({
              updated_at: trx.fn.now(),
              status: 'paused',
              stopped_reason: null,
              stopped_by_admin_id: null,
              next_touch_at: null,
            })
            .returning('*');
          return repaused || existing;
        }
        const customerNow = await trx('customers').where({ id: invoice.customer_id }).first();
        // Hold only when BOTH the retained held marker and live enrollment
        // agree (Codex #3493 r7 + r12): the stored flag alone goes stale
        // when the customer disables autopay while the invoice sits void
        // (a hold nothing can release), and live enrollment alone would
        // re-hold a sequence releaseFromAutopayHold already escalated to
        // active after the failure threshold (undoing the escalation on an
        // invoice that may see no further autopay attempt).
        let holdForAutopay = false;
        if (existing.is_autopay_held) {
          try {
            // failClosed: a swallowed payment_methods read error would
            // read as unenrolled and activate dunning for an enrolled
            // customer — on a read error keep the hold, the quiet
            // direction (Codex #3493 r16, same rule as resumeSequence).
            holdForAutopay = await customerOnAutopay(customerNow, { db: trx, failClosed: true });
          } catch (err) {
            logger.warn(`[invoice-followups] re-arm autopay re-check failed for invoice ${invoiceId} — keeping the hold: ${err.message}`);
            holdForAutopay = true;
          }
        }
        // Anchor like the ordinary scheduling path: the cadence is measured
        // from when the invoice went out (sent_at → sms_sent_at →
        // created_at), NOT the due date — a due date weeks past delivery
        // would delay every remaining reminder by those weeks (Codex #3493
        // r4). A shifted anchor_at (delivered-invoice due-date edit) still
        // wins.
        const nextTouchAt = holdForAutopay
          ? null
          : computeNextTouchAt(
            existing.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at,
            existing.step_index,
          );
        const [rearmed] = await trx('invoice_followup_sequences')
          .where({ id: existing.id, status: 'stopped', stopped_reason: voidStopStamp })
          .whereNull('stopped_by_admin_id')
          .update({
            updated_at: trx.fn.now(),
            status: holdForAutopay ? 'autopay_hold' : (nextTouchAt ? 'active' : 'completed'),
            is_autopay_held: !!holdForAutopay,
            stopped_reason: null,
            stopped_by_admin_id: null,
            next_touch_at: nextTouchAt,
          })
          .returning('*');
        return rearmed || existing;
      }
      // Don't clobber admin-controlled state; just make sure we're aligned.
      if (existing.status === 'stopped' || existing.status === 'completed') return existing;
      return existing;
    }

    // Never arm dunning under an active payment plan (codex r7 P1). Plan
    // creation stops sequences inside its own invoice-locked transaction —
    // this check runs under the SAME lock, so whichever writer commits first
    // the invariant holds (plan first → we refuse here; we commit first → the
    // plan's stop catches the fresh row).
    const activePlan = await trx('payment_plans')
      .where({ invoice_id: invoiceId, status: 'active' })
      .first('id');
    if (activePlan) return null;

    const customer = await trx('customers').where({ id: invoice.customer_id }).first();
    if (adoption) {
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
      if (await unresolvedAchFailureCount(invoice.customer_id, trx)) {
        logger.info(`[invoice-followups] adoption left invoice ${invoiceId} for a person: customer has unresolved ACH failures`);
        return null;
      }
    }
    // Adoption fails closed on an unreadable payment method (Codex #5202 r1
    // P1): the default swallows the read error as "not on autopay" and would
    // arm an ACTIVE row for an enrolled customer. The throw rolls this
    // transaction back, so no row exists and the next sweep retries.
    const onAutopay = await customerOnAutopay(customer, { db: trx, ...(adoption ? { failClosed: true } : {}) });

    // Anchor the cadence to when the invoice went out. Falls back through
    // sent_at → sms_sent_at → created_at so edge cases (manual-only, email-only,
    // or older rows without sent_at populated) still get scheduled correctly.
    const anchorAt = invoice.sent_at || invoice.sms_sent_at || invoice.created_at;
    // Adoption lands the row on its first step whose send day has not
    // passed, already re-dated past this run, in this same insert (Codex
    // #5202 r1 P2: a separate deferral write could fail after the stale
    // skip and leave the first reminder to be passed over next run).
    const landing = adoption ? adoptionLanding(anchorAt, new Date()) : { stepIndex: 0, nextAt: computeNextTouchAt(anchorAt, 0) };
    if (!landing) {
      logger.info(`[invoice-followups] adoption left invoice ${invoiceId} for a person: every ladder step has passed`);
      return null;
    }
    const nextAt = landing.nextAt;

    const [row] = await trx('invoice_followup_sequences').insert({
      invoice_id: invoiceId,
      customer_id: invoice.customer_id,
      status: onAutopay ? 'autopay_hold' : 'active',
      step_index: landing.stepIndex,
      next_touch_at: onAutopay ? null : nextAt,
      is_autopay_held: !!onAutopay,
    }).returning('*');
    return row;
  });
}

// GATE_DUNNING_ADOPT_ORPHANS, read at call time (strict 'true'): an invoice
// sent outside the direct-send path (the only caller of scheduleForInvoice)
// never got a sequence row and was left to the legacy late-payment-checker.js
// alone. The sweep only runs once that checker is retired
// (latePaymentCheckerRetiredLive): beside a still-running checker every
// adoption is a same-morning handoff (#5179 drew seven audit rounds of
// them). Off, or the checker still running: byte-identical — runPending
// never looks for orphans (the adopt gate alone logs one warning).
function adoptOrphanInvoicesLive() {
  return process.env.GATE_DUNNING_ADOPT_ORPHANS === 'true' && latePaymentCheckerRetiredLive();
}

function adoptGateSetWithCheckerRunning() {
  return process.env.GATE_DUNNING_ADOPT_ORPHANS === 'true' && !latePaymentCheckerRetiredLive();
}

/**
 * Where an adopted row lands (pure): the first step whose send day has not
 * passed — the same stale test runPending's skip-forward applies — dated no
 * earlier than the NEXT run, so a row is never sent in the run that adopted
 * it and never lands on a day already stale by the time it is picked up.
 * null = every step's day has passed (Fable #5202 P1): arming it would
 * stale-complete without a single reminder, so it is left for a person.
 */
function adoptionLanding(anchorAt, now) {
  let stepIndex = 0;
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
    // not reached the customer; the same evidence late-payment-checker.js's
    // own candidate query requires.
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
      'i.id as invoice_id', 'i.invoice_number', 'i.customer_id', 'i.total', 'i.credit_applied',
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
 * The live sweep runs under the legacy checker's own cron lock (Codex #5202
 * r1 P1): a checker run that started before the gate flip, or on a draining
 * pod, finishes (and writes its history) before candidates are read. If that
 * lock is held, the sweep is refused for this run.
 */
async function adoptOrphanInvoices({ dryRun = false } = {}) {
  if (dryRun) return selectAdoptionCandidates();

  if (!latePaymentCheckerRetiredLive()) {
    logger.warn('[invoice-followups] adoption refused: GATE_LATE_PAYMENT_CHECKER_OFF is not live — the sweep (and the script\'s --execute) only run once the legacy checker is retired');
    return { adopted: 0, invoiceIds: [], skipped: [], refused: 'checker_running' };
  }
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
    logger.warn(`[invoice-followups] adoption refused this run: the late-payment checker's lock is held (${locked.reason})`);
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
  if (latePaymentCheckerRetiredLive()) await reviveReopenedLowStepSequences();
  if (adoptGateSetWithCheckerRunning()) {
    logger.warn('[invoice-followups] GATE_DUNNING_ADOPT_ORPHANS ignored: GATE_LATE_PAYMENT_CHECKER_OFF is not live — the sweep only runs once the legacy checker is retired');
  }
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
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied', 'i.status as invoice_status',
      'i.payer_id as invoice_payer_id', 'i.scheduled_send_error as invoice_send_error',
      'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
      'i.sent_at as invoice_sent_at', 'i.sms_sent_at as invoice_sms_sent_at',
      'i.created_at as invoice_created_at',
    );

  let sent = 0, skipped = 0;
  if (!combinedMessageLive()) {
    // Gate off: byte-identical to before this lane — one loop, one row at a
    // time, retiming/stale-skip and the fire immediately follow each other
    // for that row (resolveDueTouch below is a pure extraction of this same
    // logic, not a behavior change).
    for (const batchRow of rows) {
      let row = batchRow;
      try {
        const resolved = await resolveDueTouch(row, now, ladder);
        if (resolved.earlyRow) continue;
        if (resolved.skipCount) skipped++;
        if (resolved.fireRow) {
          await fireStep(resolved.fireRow);
          sent++;
        }
      } catch (err) {
        logger.error(`[invoice-followups] step fire failed for invoice ${row.invoice_id}: ${err.message}`);
        skipped++;
      }
    }
    logger.info(`[invoice-followups] runPending: ${sent} sent, ${skipped} skipped`);
    return { sent, skipped };
  }

  // Gate on: resolve every row's due-ness first (same per-row logic as
  // above), THEN group the ones actually due by customer_id so a customer
  // with 2+ due rows fires ONE combined touch instead of one per invoice.
  const readyRows = [];
  for (const batchRow of rows) {
    let row = batchRow;
    try {
      const resolved = await resolveDueTouch(row, now, ladder);
      if (resolved.earlyRow) continue;
      if (resolved.skipCount) skipped++;
      if (resolved.fireRow) readyRows.push(resolved.fireRow);
    } catch (err) {
      logger.error(`[invoice-followups] step fire failed for invoice ${row.invoice_id}: ${err.message}`);
      skipped++;
    }
  }
  const groups = new Map();
  for (const row of readyRows) {
    const key = String(row.customer_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const groupRows of groups.values()) {
    try {
      if (groupRows.length < 2) await fireStep(groupRows[0]);
      else await fireCombinedTouch(groupRows);
      sent++;
    } catch (err) {
      logger.error(`[invoice-followups] step fire failed for customer ${groupRows[0]?.customer_id}: ${err.message}`);
      skipped++;
    }
  }
  logger.info(`[invoice-followups] runPending: ${sent} sent, ${skipped} skipped`);
  return { sent, skipped };
}

/**
 * Decide whether ONE due row (from runPending's batch select) should fire
 * this run — the retiming (Day 90 ladder day-move) and stale-touch-skip
 * logic, pulled out of runPending's loop so both the gate-off single-row
 * path and the gate-on grouping pass share it verbatim (GATE_DUNNING_COMBINED_MESSAGE
 * needs every row's due-ness resolved BEFORE it can group them by customer;
 * gate off never groups, so this is a pure extraction, not a behavior
 * change). `earlyRow` mirrors the old `continue` for EARLY_ROW (nothing
 * counted); `skipCount` mirrors the old unconditional `skipped++`;
 * `fireRow` is the row to fire now, or null.
 */
async function resolveDueTouch(row, now, ladder) {
  // A legacy-cadence touch moved to its Day 90 ladder day is processed on
  // that new day in this same run when the new day is today (pre-push
  // audit P1): skipping it would let the next tick find it past its stale
  // grace and pass it over.
  const retimed = ladder ? await deferToLadderDay(row) : await restoreLegacyDay(row, now);
  if (retimed === EARLY_ROW) return { earlyRow: true, skipCount: false, fireRow: null };
  if (retimed) {
    if (!retimed.moved || retimed.due.getTime() > now.getTime()) {
      return { earlyRow: false, skipCount: true, fireRow: null };
    }
    row = { ...row, next_touch_at: retimed.due };
  }
  if (row.next_touch_at && isStaleTouch(row.next_touch_at, now)) {
    const skip = await skipStaleTouches(row, now);
    // The landing step can itself be due THIS run (a step went stale over a
    // weekend and the next one anchors to today) — fire it now, or the next
    // tick would find it past ITS eligible day and stale-skip it too (Codex
    // r1 P2). The caller's fireStep/fireCombinedTouch revalidates against
    // the just-persisted step/due under the invoice lock, so a concurrent
    // change no-ops.
    const fireRow = (skip.updated && skip.nextAt
      && skip.nextAt.getTime() <= now.getTime()
      && !isStaleTouch(skip.nextAt, now))
      ? { ...row, step_index: skip.nextIndex, next_touch_at: skip.nextAt }
      : null;
    return { earlyRow: false, skipCount: true, fireRow };
  }
  return { earlyRow: false, skipCount: false, fireRow: row };
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
 * whitelist late-payment-checker.js's own candidate query uses) — not the wider
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
 * reviveReopenedLowStepSequences below for what owns THAT case once the
 * legacy checker retires. The same invoice guards as the send batch apply.
 */
async function reviveLegacyFinishedSequences() {
  const revived = await reviveFinishedSequences(config.steps.length, followupSteps().length);
  if (revived) logger.info(`[invoice-followups] Day 90 ladder: ${revived} finished sequence(s) resumed at Day 60 or Day 90`);
  return revived;
}

// GATE_LATE_PAYMENT_CHECKER_OFF, read at call time (strict 'true'). A
// sequence that finished BEFORE the legacy Day 30 end — an invoice paid
// (stopOnPayment) after only its early touches fired, then reopened by a
// dispute/refund reversal — has always relied on the legacy
// late-payment-checker.js as its ONLY fallback: hasActiveSequence
// deliberately excludes a low-step 'completed' row from "owned" (codex
// #5126 r1) precisely so that checker picks it back up. Retiring the
// checker removes that fallback with nothing to replace it (Codex pre-push
// r1 P1) — this revives it here instead, at the step it finished on, so the
// ladder owns the reopened invoice the same way it already owns a Day 60/90
// finish above. Off (checker still running): unchanged, this never runs.
// Retirement requires the Day 90 ladder to be live: with the ladder off the
// follow-up cadence ends at Day 30 and the checker is the only sender of the
// 60- and 90-day reminders (Codex on #5175).
function latePaymentCheckerRetiredLive() {
  return process.env.GATE_LATE_PAYMENT_CHECKER_OFF === 'true' && ladderThrough90Live();
}

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
  const updated = await db('invoice_followup_sequences')
    .where({ id: row.id, status: 'active', step_index: row.step_index })
    .where('next_touch_at', row.next_touch_at)
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
  const updated = await db('invoice_followup_sequences')
    .where({ id: row.id, status: 'active', step_index: row.step_index })
    .where('next_touch_at', row.next_touch_at)
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
  const updated = await db('invoice_followup_sequences')
    .where({ id: row.id, status: 'active', step_index: row.step_index })
    .where('next_touch_at', row.next_touch_at)
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

/**
 * Claim ONE due sequence row: lock its invoice, revalidate the batch
 * snapshot against the live sequence (still active, same step, actually
 * due, ownership unchanged), and stamp `touch_claimed_at`. Extracted from
 * fireStep (gate-off single-invoice path, unchanged) so the combined-touch
 * path (GATE_DUNNING_COMBINED_MESSAGE, dark) can claim several rows for one
 * customer under the SAME lock discipline instead of a second
 * implementation. Returns `{ claimedSeq, claimedInvoice }` or null — the
 * caller decides what "not claimed" means for its own row (fireStep skips
 * the touch; the combined path drops the row from its included set).
 */
async function claimTouchRow(row, claimStamp) {
  let claimedSeq = null;
  let claimedInvoice = null;
  // Claim inside a transaction that locks the INVOICE row first.
  // InvoiceService.update locks the same row before re-checking the claim,
  // so Postgres strictly orders an edit against this claim — without a
  // common row lock, both single-statement writes could pass on
  // pre-commit snapshots of each other. The transaction holds no external
  // work: it commits before any rendering or sending.
  await db.transaction(async (trx) => {
    const lockedInvoice = await trx('invoices')
      .where({ id: row.invoice_id })
      .forUpdate()
      .first();
    if (!lockedInvoice) return;
    // Post-claim... now post-LOCK revalidation: the caller's row is a
    // batch snapshot — a due-date edit (rescheduleForInvoiceEdit, which
    // commits atomically with its invoice edit) can postpone
    // next_touch_at, or an admin can pause/stop/advance the sequence.
    // Fire only if it is still active, on the same step, and actually
    // due; progress from the LIVE anchor so a postponed timeline is
    // never overwritten from the stale snapshot.
    const liveSeq = await trx('invoice_followup_sequences').where({ id: row.id }).first();
    if (
      !liveSeq ||
      liveSeq.status !== 'active' ||
      liveSeq.step_index !== row.step_index ||
      !liveSeq.next_touch_at ||
      new Date(liveSeq.next_touch_at).getTime() > Date.now()
    ) {
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
    const claimed = await trx('invoice_followup_sequences')
      .where({ id: row.id })
      .where(function () {
        this.whereNull('touch_claimed_at').orWhere(
          'touch_claimed_at', '<', new Date(claimStamp.getTime() - TOUCH_CLAIM_TTL_MS),
        );
      })
      // The claim stamps updated_at too: "a worker is mid-send on this
      // sequence" is precisely the activity an ownership-change check must
      // see, and
      // it is the backstop for the ownership gate above — a claim taken
      // before the undo's verification pass makes the undo refuse instead of
      // repointing a sequence out from under an in-flight touch.
      .update({ touch_claimed_at: claimStamp, updated_at: trx.fn.now() });
    if (claimed) {
      claimedSeq = liveSeq;
      claimedInvoice = lockedInvoice;
    }
  });
  return claimedSeq ? { claimedSeq, claimedInvoice } : null;
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
async function fireStep(row, { operatorInitiated = false } = {}) {
  // The cleanup is predicated on OUR stamp: if this send outlives the TTL
  // and another worker replaces the stale claim, an unconditional clear
  // here would release the successor's live claim and let an edit race its
  // in-flight reminder.
  const claimStamp = new Date();
  let claim = null;
  try {
    claim = await claimTouchRow(row, claimStamp);
  } catch (err) {
    logger.error(`[invoice-followups] touch claim failed for invoice ${row.invoice_id}: ${err.message}`);
    return;
  }
  if (!claim) {
    logger.info(`[invoice-followups] sequence ${row.id} in flight or changed after batch select; skipping touch`);
    return;
  }
  // Hand fireTouch POST-LOCK state, not the batch snapshot (r19 P1). The
  // ownership gate above proved customer_id has not moved; these are the
  // remaining send-driving fields the lock proves fresher than the batch
  // select. invoice_payer_id especially: fireTouch's Bill-To guard reads it to
  // decide whether sending would leak the payer's bearer link, and a payer
  // assigned since the batch SELECT would otherwise be invisible to it.
  row.anchor_at = claim.claimedSeq.anchor_at;
  row.customer_id = claim.claimedSeq.customer_id;
  row.invoice_payer_id = claim.claimedInvoice.payer_id ?? null;
  row.invoice_status = claim.claimedInvoice.status;
  row.token = claim.claimedInvoice.token;
  try {
    await fireTouch(row, { operatorInitiated });
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
}

/**
 * One combined SMS + one combined email for a customer with 2+ overdue
 * invoices whose follow-up touches are due in the same run
 * (GATE_DUNNING_COMBINED_MESSAGE, dark; runPending groups due rows by
 * customer_id before calling this — a customer with exactly one due row
 * never reaches here). Claims every row with the SAME lock discipline
 * fireStep uses (claimTouchRow), then hands off to fireCombinedTouchClaimed
 * once 2+ rows actually claimed; a row that loses its claim, or that the
 * remaining guards exclude, is skipped exactly as fireTouch would skip it —
 * never sent separately in this run.
 */
async function fireCombinedTouch(rowsForCustomer) {
  const claimStamp = new Date();
  const claimedRows = [];
  try {
    for (const row of rowsForCustomer) {
      let claim = null;
      try {
        claim = await claimTouchRow(row, claimStamp);
      } catch (err) {
        logger.error(`[invoice-followups] combined touch claim failed for invoice ${row.invoice_id}: ${err.message}`);
        continue;
      }
      if (!claim) {
        logger.info(`[invoice-followups] sequence ${row.id} in flight or changed after batch select; excluded from combined touch`);
        continue;
      }
      row.anchor_at = claim.claimedSeq.anchor_at;
      row.customer_id = claim.claimedSeq.customer_id;
      row.invoice_payer_id = claim.claimedInvoice.payer_id ?? null;
      row.invoice_status = claim.claimedInvoice.status;
      row.token = claim.claimedInvoice.token;
      claimedRows.push(row);
    }
    if (!claimedRows.length) return;
    // Only one row survived the claim — the normal per-invoice path (same
    // POST-LOCK state fireStep would hand it, since we already hold its
    // claim; fireStep itself would try to re-claim and find nothing).
    if (claimedRows.length === 1) {
      await fireTouch(claimedRows[0], {});
      return;
    }
    await fireCombinedTouchClaimed(claimedRows);
  } finally {
    if (claimedRows.length) {
      await db('invoice_followup_sequences')
        .whereIn('id', claimedRows.map((r) => r.id))
        .where('touch_claimed_at', claimStamp)
        .update({ touch_claimed_at: null, updated_at: db.fn.now() })
        .catch((err) => logger.warn(
          `[invoice-followups] could not clear combined touch claims for customer ${rowsForCustomer[0]?.customer_id}: ${err.message}`,
        ));
    }
  }
}

/**
 * Render and send the combined message for a customer's already-claimed
 * rows (2+). Mirrors fireTouch's own early guards (Bill-To ownership,
 * soft-deleted customer, a fresh paid/prepaid re-check) to decide the
 * INCLUDED set; a row the guards exclude gets the same sequence update
 * fireTouch would give it and drops out — never sent separately here.
 *
 * Deliberately narrower than fireTouch in two ways, both accepted scope
 * reductions for this dark lane (see the PR's own notes): no per-invoice
 * account-credit draw-down before dunning (the combined total reflects
 * credit already applied to each invoice, not a fresh draw this touch
 * would need to reverse on failure — fireTouch's credit dance is real
 * complexity this PR does not duplicate for an aggregate amount), and no
 * quiet-hours queueing of a blocked leg onto the scheduled-SMS rail — a
 * leg that can't send now is simply not sent this run; the sequence stays
 * on its current step and the next run tries again.
 */
async function fireCombinedTouchClaimed(rows) {
  const customerId = rows[0].customer_id;

  const customer = await db('customers').where({ id: customerId }).first();
  if (customer?.deleted_at) {
    await db('invoice_followup_sequences').whereIn('id', rows.map((r) => r.id)).update({
      updated_at: db.fn.now(), status: 'paused', next_touch_at: null,
    });
    logger.info(`[invoice-followups] paused ${rows.length} sequence(s) for customer ${customerId} — customer is soft-deleted (combined touch)`);
    return;
  }
  if (!customer) {
    logger.warn(`[invoice-followups] skipped combined touch for customer ${customerId} — customer is missing`);
    return;
  }

  // Resolves the eligible set, the anchor/step, and pulls out any
  // final-notice sibling — every early-return decision that requires,
  // extracted so this orchestrator only checks the outcome once (Codex r1
  // P2 — complexity). Returns null when nothing further is owed this run
  // (each such case fires its own row(s) through fireTouch already, inside
  // the helper).
  const group = await resolveCombinedGroup(rows, customerId);
  if (!group) return;
  const { included, anchorRow, step } = group;

  const smsTemplateKey = COMBINED_SMS_TEMPLATE_BY_STEP_ID[step.id];
  const emailTemplateKey = COMBINED_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!smsTemplateKey && !emailTemplateKey) return;

  const includedIds = included.map((r) => r.invoice_id);

  // The combined message quotes an exact invoice_count and total_due — the
  // link behind it must settle EXACTLY the included set, not a superset
  // (GATE_PAY_INCLUDE_BALANCE on, no payer/incomplete-read degradation, no
  // sibling excluded for its own reason, and no OTHER open invoice not due
  // today riding along and inflating the page's total past what the
  // message promised). See resolveCombinedPayLink: anything short of an
  // exact match falls back to firing every included invoice through its
  // own per-invoice touch instead, same as the single-survivor fallback
  // above (Codex pre-push r2 + r4).
  const { payUrl, totalDue: linkTotalDue, lineCents } = await resolveCombinedPayLink(customer, includedIds);
  if (!payUrl) {
    logger.info(`[invoice-followups] no pay link covers every invoice in the combined touch for customer ${customerId} — falling back to ${included.length} individual touches`);
    await fireIndividualTouchesForCombined(included, rows);
    return;
  }
  // The pay link's OWN reported balance, not a separately-derived sum
  // (Claude fallback-audit P1): this lane's own dollar-based total and the
  // pay page's cents-based one can disagree by a cent on rounding order
  // even over the identical invoice set, and the message must never quote
  // an amount the linked page itself would not also show.
  const totalDue = linkTotalDue.toFixed(2);

  const channelSelection = await resolveCombinedChannelPolicy(customer);
  if (!channelSelection) return;
  const {
    category, nonEmailChannels, emailSelected, policyChannels, explicit,
  } = channelSelection;

  const ContactLedger = require('./collections/contact-ledger');
  // A stable identity for THIS combined touch's included set — the same
  // step id recurs for a customer as new invoices reach it later, and the
  // included set itself can differ between two attempts at the same step
  // (an invoice drops out, another joins). Both the contact-ledger
  // reservation's own idempotency key AND the email template's provider-
  // level key are scoped to it, so a regrouped retry never reuses — and
  // silently "delivers" — a reservation that only ever quoted a DIFFERENT
  // set of invoices (Codex pre-push r1 + r3).
  // A digest, not the raw sorted UUID list: production customer/invoice ids
  // are 36-char UUIDs, so even the minimum two-invoice group already runs
  // ~165-171 chars — over collections_contact_ledger.idempotency_key's
  // varchar(120) (both ledger reservations would fail before either leg
  // could send) and, at 5+ invoices, over email_messages'
  // trigger_event_id/idempotency-key columns too (Codex r1 P1). A 16-hex
  // SHA-256 prefix of the sorted, comma-joined ids is stable for the same
  // included set and short enough to leave headroom in every key it rides.
  const includedIdsKey = crypto.createHash('sha256')
    .update(includedIds.map(String).sort().join(',')).digest('hex').slice(0, 16);
  // NO date component (Fable review P2): a held touch retried on a LATER
  // day must reuse the SAME reservation, or a fresh day-scoped key loses
  // claimAttempt's "a prior attempt's outcome is still unconfirmed"
  // protection across the day boundary — the same stability contract
  // followupLedgerKey already gives the single-invoice path (keyed by
  // sequence row id + step + channel, never a date).
  const combinedLedgerKey = (channel) => `invoice_followups:combined:${customerId}:${step.id}:${includedIdsKey}:${channel}`;

  const excludeLedgerIds = await combinedExcludeLedgerIds(
    included, rows, step, customerId, includedIdsKey, policyChannels,
  );

  const policyResults = await Promise.all(policyChannels.map((channel) =>
    collectionsChannelPermitted(customer.id, null, channel, excludeLedgerIds, true, includedIds)));
  // Partial debt evidence cannot authorize a leg OR settle a waiver
  // (billing-reminder-delivery.js's sendReminderChannels, and fireTouch's
  // own per-invoice check above) — hold the WHOLE combined touch rather
  // than dun a group against a balance the policy itself could not fully
  // see. Re-timed like any other hold so the next run doesn't read it stale.
  if (policyBalanceIncomplete(policyResults)) {
    logger.info(`[invoice-followups] combined touch for customer ${customerId} step ${step.id} held — collections policy balance evidence incomplete; retrying on a later run`);
    await reTimeHeldCombinedSequences(included, rows);
    return;
  }
  const channelPolicy = Object.fromEntries(policyChannels.map((channel, index) => [channel, verdictAllows(policyResults[index])]));
  if (!Object.values(channelPolicy).some(Boolean)) {
    // The aggregate check requires EVERY included invoice to sit in the
    // policy's own eligible set (rail-guard.js's includesQuotedInvoices) —
    // ONE sibling excluded from it (its own dispute/hold, not necessarily
    // the customer's own standing) denies the channel for the WHOLE group,
    // even when the rest are individually eligible. Rather than hold every
    // invoice hostage to that one, fall back to firing each included
    // invoice through its own per-invoice touch — the SAME fallback the
    // pay-link mismatch and ownership-change guards already take — so
    // fireTouch's own single-invoice policy check (no aggregate
    // invoiceIds) can send for the eligible ones while holding or skipping
    // the ineligible one on its own (Fable review P2).
    logger.info(`[invoice-followups] collections policy denied every selected channel for combined touch (customer ${customerId}) — falling back to ${included.length} individual touches`);
    await fireIndividualTouchesForCombined(included, rows);
    return;
  }

  // LAST-MINUTE re-verification, immediately before dispatch (Codex
  // pre-push r4): the guard pass in resolveCombinedIncludedInvoices ran
  // before several awaits (channel preferences, the collections-policy
  // consult, the ledger id lookups, the pay-balance link) during which a
  // sibling's Bill-To could still change — the claim only protects each
  // row's SEQUENCE state, not this. See combinedOwnershipStillEligible,
  // which covers every quoted invoice, not only the anchor. Any invoice
  // that moved bails the WHOLE combined send (the totals/copy already
  // reflect the stale set) — each invoice still legitimate goes through
  // its own per-invoice touch instead, same as the coverage fallback
  // above; the one that moved is picked up correctly by fireTouch's own
  // guards on a later run.
  const stillEligible = await combinedOwnershipStillEligible(included);
  if (!stillEligible) {
    logger.info(`[invoice-followups] an included invoice's ownership changed just before dispatch for customer ${customerId} — abandoning the combined send; falling back to ${included.length} individual touches`);
    await fireIndividualTouchesForCombined(included, rows);
    return;
  }

  // Durable vs transient policy denials, per selected channel — a
  // transient denial (spacing window, a releasable hold) must HOLD the
  // whole touch until it clears, same as fireTouch; a durable one (a flag,
  // no consent) is waived and never blocks the other leg.
  const durablyDenied = Object.fromEntries(
    policyChannels.map((channel, index) => [channel, verdictDurablyDenied(policyResults[index])]),
  );

  // ONE text leg and ONE email leg — "one combined text"/"one combined
  // email", not one attempt per selected channel. Extracted so each leg's
  // own hold/deliver decision tree is reasoned about on its own (Codex r1
  // P2); see sendCombinedSmsLeg / sendCombinedEmailLeg. lineCents rides the
  // SMS leg too now (Codex r2 P1) — the provider-boundary preDispatchCheck
  // re-verifies every included invoice's LIVE amount against it, same as
  // the email leg's preSendCheck below.
  const {
    smsOk, smsHold, smsChannel: smsChannelUsed, smsFresh, smsOriginalAt, smsReason,
  } = await sendCombinedSmsLeg({
    customer, included, includedIds, includedIdsKey, step, smsTemplateKey, payUrl, totalDue, lineCents,
    nonEmailChannels, channelPolicy, durablyDenied, emailSelected, anchorRow, combinedLedgerKey, ContactLedger, category,
  });
  const {
    emailOk, emailHold, emailFresh, emailOriginalAt, emailReason,
  } = await sendCombinedEmailLeg({
    customer, included, includedIds, includedIdsKey, step, emailTemplateKey, payUrl, totalDue, lineCents,
    channelPolicy, durablyDenied, emailSelected, combinedLedgerKey, ContactLedger, anchorRow, explicit,
  });

  // A selected leg still pending (transient policy denial, an uncertain
  // send, an unresolved prior attempt) holds the WHOLE combined touch —
  // every included sequence stays on its current step, exactly like
  // fireTouch holds its one invoice's touch, rather than silently dropping
  // the pending leg the moment a sibling leg succeeds (pre-push audit P1).
  if (smsHold || emailHold) {
    logger.info(`[invoice-followups] combined touch for customer ${customerId} step ${step.id} held — a selected leg is still pending (sms ${smsHold ? 'held' : 'settled'}, email ${emailHold ? 'held' : 'settled'}); ${included.length} sequence(s) left at their current step`);
    // Re-date next_touch_at to the held-touch floor, same as fireTouch's
    // own holdStep — leaving it at its already-due date would have every
    // included sequence read as stale on the NEXT run's isStaleTouch check
    // (now vs. the ORIGINAL due date, not today's hold) and stale-skip
    // right past this step without ever sending it (Fable review P1).
    await reTimeHeldCombinedSequences(included, rows);
    return;
  }

  if (!smsOk && !emailOk) {
    await handleCombinedNoDelivery({
      customerId, step, included, rows, smsReason, emailReason,
    });
    return;
  }

  // freshDelivery mirrors fireTouch's own freshDelivery: a leg that only
  // delivered via a DEDUPED retry (claim.delivered from an earlier attempt,
  // or a deduped provider/email outcome) is not a NEW send — last_touch_at
  // must carry the ORIGINAL occurrence forward and no new customer_interactions
  // row is written for it (Codex r2 P2 — advanceCombinedSequences used to
  // stamp "now" and log a fresh interaction on every deduped retry).
  const freshDelivery = !!(smsFresh || emailFresh);
  const originalTimes = [smsOriginalAt, emailOriginalAt]
    .filter(Boolean).map((t) => new Date(t)).filter((t) => !Number.isNaN(t.getTime()));
  const originalAt = originalTimes.length
    ? new Date(Math.max(...originalTimes.map((t) => t.getTime()))) : null;

  await advanceCombinedSequences({
    included, rows, customer, step, totalDue, smsOk, emailOk, includedIds,
    freshDelivery, originalAt, smsChannelUsed,
  });
}

/**
 * Per-row eligibility pass for a combined touch: re-reads each claimed
 * row's invoice live and applies the same exclusions fireTouch applies per
 * invoice (third-party Bill-To, a fresh paid/prepaid re-check, terminal
 * status, micro-deposit-pending diversion). An mdPending row is fired
 * through fireTouch immediately rather than left to re-exclude itself on
 * every future run (Codex pre-push r3 — see fireCombinedTouchClaimed's own
 * comment above its call). Extracted from fireCombinedTouchClaimed to keep
 * that orchestrator's complexity reasoned about one decision at a time
 * (Codex r1 P2).
 */
async function resolveCombinedIncludedInvoices(rows, customerId) {
  const included = [];
  const mdPendingRows = [];
  for (const row of rows) {
    const liveInvoice = await db('invoices').where({ id: row.invoice_id })
      .first('payer_id', 'scheduled_send_error', 'total', 'credit_applied', 'status', 'title',
        'token', 'due_date', 'invoice_number', 'stripe_payment_intent_id', 'service_date', 'created_at')
      .catch(() => undefined);
    if (liveInvoice === undefined) {
      // Retried at the next day's floor, like a held touch: the cron runs
      // once a day, so a 30-minute retry time would be past its stale grace
      // by the next tick. Guarded on the snapshot step like every other
      // write here, so a sequence that moved meanwhile is left alone.
      await db('invoice_followup_sequences').where({ id: row.id, status: 'active', step_index: row.step_index })
        .update({ updated_at: db.fn.now(), next_touch_at: heldTouchFloor() })
        .catch(() => {});
      logger.warn(`[invoice-followups] excluded invoice ${row.invoice_id} from combined touch for customer ${customerId} — could not re-read ownership; retrying next run`);
      continue;
    }
    const payerId = liveInvoice.payer_id ?? null;
    if (payerId || invoiceWithdrawnFromCustomer({ scheduled_send_error: liveInvoice.scheduled_send_error })) {
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(), status: 'paused', next_touch_at: null,
      });
      logger.info(`[invoice-followups] excluded invoice ${row.invoice_id} from combined touch — billed to a third-party payer`);
      continue;
    }
    if (['prepaid', 'paid'].includes(String(liveInvoice.status || '').toLowerCase())) {
      await stopOnPayment(row.invoice_id).catch(() => {});
      continue;
    }
    if (isTerminalInvoice(liveInvoice)) continue; // void/canceled etc — a race landed it here
    const mdPending = gates.divertMicrodepositDunning
      && await StripeService.isInvoiceAwaitingMicrodepositVerification({
        id: row.invoice_id, stripe_payment_intent_id: liveInvoice.stripe_payment_intent_id,
      }).catch(() => false);
    if (mdPending) {
      logger.info(`[invoice-followups] excluded invoice ${row.invoice_id} from combined touch — awaiting micro-deposit verification; dispatching its own verification reminder now`);
      mdPendingRows.push(row);
      continue;
    }
    included.push({ ...row, ...liveInvoice, invoice_id: row.invoice_id, sequence_id: row.id });
  }
  for (const row of mdPendingRows) {
    // Sequential: each fireTouch owns its own DB writes for its invoice.
    // try/catch per row (Fable review P2): one invoice's fireTouch failure
    // must not abort the rest of the group's mdPending verification sends —
    // the row that threw is simply picked up again on the next run.
    try {
      await fireTouch(row, {});
    } catch (err) {
      logger.error(`[invoice-followups] mdPending individual touch failed for invoice ${row.invoice_id}: ${err.message}`);
    }
  }
  return included;
}

/**
 * Resolves the eligible included set for a combined touch, picks the
 * anchor invoice/step, and pulls out any final-notice sibling — every
 * early-return decision that resolution requires, so
 * fireCombinedTouchClaimed's own orchestration checks the outcome once
 * instead of repeating the same length/step checks after each step
 * (Codex r1 P2 — complexity). Returns null when nothing further is owed
 * this run; a null-producing branch has already fired its own row(s)
 * through fireTouch, same as every other immediate-handling exclusion in
 * this lane.
 */
async function resolveCombinedGroup(rows, customerId) {
  const included = await resolveCombinedIncludedInvoices(rows, customerId);
  if (!included.length) return null;
  if (included.length === 1) {
    const soleRow = rows.find((r) => r.invoice_id === included[0].invoice_id);
    await fireTouch(soleRow, {});
    return null;
  }

  // Step from the OLDEST included invoice (account-anchor.js) — the
  // account-level framing the combined message uses even when the included
  // invoices sit at different points of their own cadence.
  const anchorInvoice = anchorInvoiceOf(included);
  const anchorRow = rows.find((r) => r.invoice_id === anchorInvoice.invoice_id);
  const step = followupSteps()[anchorRow.step_index];
  if (!step) return null; // exhausted cadence on the anchor invoice — nothing to send

  // A sibling already at ITS OWN final-notice step must never ride along
  // under an earlier anchor step's copy (see excludeFinalNoticeSiblings) —
  // pull it out and fire it individually first; only then decide whether
  // enough of the group remains for a combined send.
  const filtered = await excludeFinalNoticeSiblings(included, rows, anchorRow);
  if (!filtered.length) return null;
  if (filtered.length === 1) {
    const soleRow = rows.find((r) => r.invoice_id === filtered[0].invoice_id);
    await fireTouch(soleRow, {});
    return null;
  }
  return { included: filtered, anchorRow, step };
}

/**
 * The FINAL NOTICE step is a special case, in EITHER direction, of the
 * combined message's normal "the anchor's step renders the copy for
 * every included invoice" design (siblings at an earlier, non-final step
 * than the anchor otherwise combine under the anchor's own later copy on
 * purpose — see fireCombinedTouchClaimed's own docstring, "the combined
 * message intentionally spans them"):
 *
 *   - A sibling already at ITS OWN final-notice step must never be folded
 *     into a combined touch whose rendered content is an EARLIER step's
 *     copy (Fable review P2): advanceCombinedSequences would still retire
 *     that sequence's step past the final one, and the customer would
 *     never actually receive THAT invoice's final notice.
 *   - Symmetrically, a sibling NOT at the final step must never be folded
 *     into a combined touch whose rendered content IS the final-notice
 *     copy (Claude fallback-audit P1 — the original guard only covered
 *     the first direction): the customer would get an inappropriate "may
 *     be sent to collections" message for an invoice nowhere near that
 *     stage, while advanceCombinedSequences only advances its step_index
 *     by one, leaving no record that anything unusual was ever sent.
 *
 * Safe rule: a sibling may combine under a final-notice anchor ONLY when
 * the sibling is ALSO at the final step; a sibling may combine under a
 * non-final anchor at ANY non-final step (the normal spanning behavior).
 * Otherwise the sibling is pulled out and fired through its own
 * individual touch RIGHT NOW, which renders ITS real step's template,
 * rather than left to re-exclude itself (and risk the same staleness the
 * mdPending path above guards against) on a later run.
 */
async function excludeFinalNoticeSiblings(included, rows, anchorRow) {
  const lastStepIndex = followupSteps().length - 1;
  const anchorIsFinal = anchorRow.step_index === lastStepIndex;
  const keep = [];
  const pulledOut = [];
  for (const inv of included) {
    const invIsFinal = inv.step_index === lastStepIndex;
    // The combined message renders ONE step's copy (the anchor's) for the
    // whole group. A sibling at the FINAL step must never ride an EARLIER
    // anchor's copy (it would never actually receive its real final-notice
    // wording) — and, symmetrically (Claude fallback-audit P1: the
    // original guard only covered this first direction), a sibling NOT at
    // the final step must never ride a FINAL-NOTICE anchor's copy either —
    // it would get an inappropriate "may be sent to collections" message
    // for an invoice nowhere near that stage. Only a sibling at the SAME
    // step as the anchor may combine under a final-notice anchor's copy.
    if (anchorIsFinal ? !invIsFinal : invIsFinal) pulledOut.push(inv);
    else keep.push(inv);
  }
  for (const inv of pulledOut) {
    const originalRow = rows.find((r) => r.invoice_id === inv.invoice_id);
    if (!originalRow) continue;
    // Sequential, not Promise.all: each fireTouch owns its own DB writes.
    // try/catch per row (Fable review P2): one sibling's final-notice
    // fireTouch failure must not stop the OTHER final-notice siblings from
    // getting their own real final-notice send this run.
    try {
      await fireTouch(originalRow, {});
    } catch (err) {
      logger.error(`[invoice-followups] final-notice sibling touch failed for invoice ${inv.invoice_id}: ${err.message}`);
    }
  }
  return keep;
}

// Fire every included invoice through its own per-invoice touch instead of
// the combined message — the shared fallback the pay-link mismatch guard
// and the last-minute ownership recheck both take (Codex pre-push r2/r4).
async function fireIndividualTouchesForCombined(included, rows) {
  for (const inv of included) {
    // Sequential, not Promise.all: each fireTouch owns its own DB writes
    // and must not race a sibling invoice for the same customer.
    const individualRow = rows.find((r) => r.invoice_id === inv.invoice_id);
    if (!individualRow) continue;
    // try/catch per row (Fable review P2): one invoice's fireTouch failure
    // must not abort the fallback for the REST of the group — each row is
    // independent and the one that threw is picked up again next run.
    try {
      await fireTouch(individualRow, {});
    } catch (err) {
      logger.error(`[invoice-followups] individual fallback touch failed for invoice ${inv.invoice_id}: ${err.message}`);
    }
  }
}

/**
 * The combined message quotes an exact invoice_count and total_due — the
 * link behind it must settle EXACTLY the included set, not a superset
 * (GATE_PAY_INCLUDE_BALANCE on, no payer/incomplete-read degradation, no
 * sibling excluded for its own reason, and no OTHER open invoice not due
 * today riding along and inflating the page's total past what the message
 * promised). Returns { payUrl: null, totalDue: null } on anything short of
 * an exact match.
 *
 * totalDue is buildPayBalanceLink's OWN reported balance (pay-combined.js's
 * amountDueCents, summed in cents per invoice then divided back to
 * dollars) — the SAME figure the linked page will display and charge —
 * not re-derived here. Two independently-computed totals (this lane's own
 * dollar-based sum vs. the pay page's cents-based one) can diverge by a
 * cent on rounding order even when they agree on every input invoice, and
 * the caller must never quote a total the pay link itself would not also
 * show (Claude fallback-audit P1, AGENTS.md single-source-of-truth for
 * money math).
 */
async function resolveCombinedPayLink(customer, includedIds) {
  const { buildPayBalanceLink } = require('./composer-customer-links');
  try {
    const balanceLink = await buildPayBalanceLink([customer.id]);
    const coveredIds = new Set((balanceLink?.coveredInvoiceIds || []).map(String));
    const matchesIncludedSetExactly = coveredIds.size === includedIds.length
      && includedIds.every((id) => coveredIds.has(String(id)));
    if (!matchesIncludedSetExactly || !balanceLink?.url || !(balanceLink?.balance?.total > 0)) {
      return { payUrl: null, totalDue: null };
    }
    // The itemized lines come from the same read as the total, and must add
    // up to it exactly, or the message is not sent combined (pre-push audit
    // P1: lines re-derived from the batch rows could disagree by a payment
    // that landed between the two reads).
    const lineCents = balanceLink.coveredInvoiceCents || {};
    const lines = includedIds.map((id) => lineCents[String(id)]);
    const linesTotal = lines.reduce((sum, cents) => sum + (Number.isInteger(cents) ? cents : NaN), 0);
    if (!Number.isInteger(linesTotal) || linesTotal !== Math.round(balanceLink.balance.total * 100)) {
      return { payUrl: null, totalDue: null };
    }
    return { payUrl: balanceLink.url, totalDue: balanceLink.balance.total, lineCents };
  } catch (err) {
    logger.warn(`[invoice-followups] combined pay-balance link failed for customer ${customer.id}: ${err.message}`);
    return { payUrl: null, totalDue: null };
  }
}

/**
 * Which channels this customer's combined touch may use — the explicit-
 * selection resolution fireTouch applies per invoice, run once for the
 * whole group (category is always 'invoice': mdPending invoices are
 * excluded before this runs). Returns null on a preferences read failure;
 * the caller skips the touch for this run.
 */
async function resolveCombinedChannelPolicy(customer) {
  const category = 'invoice';
  try {
    const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
    const explicitChannels = explicitBillingChannels(prefs || {}, category);
    const nonEmailChannels = explicitChannels === null ? ['sms']
      : ['push', 'sms'].filter((channel) => explicitChannels.includes(channel));
    const emailSelected = explicitChannels === null || explicitChannels.includes('email');
    const policyChannels = [...nonEmailChannels, ...(emailSelected ? ['email'] : [])];
    return {
      // explicit mirrors fireTouch's own `selectedChannels !== null` —
      // threaded down to settleFollowupEmailLedger so a default-channel
      // (no explicit preference) email keeps its never_contacted stamp on a
      // retryable pre-provider refusal instead of being treated as an
      // explicit selection's terminal resolution (Codex r2 P2).
      category, nonEmailChannels, emailSelected, policyChannels, explicit: explicitChannels !== null,
    };
  } catch (err) {
    logger.warn(`[invoice-followups] skipped combined touch for customer ${customer.id} — channel preferences unavailable: ${err.message}`);
    return null;
  }
}

/**
 * excludeLedgerIds: THIS touch's own reservations must not count against
 * itself on a retry — both the per-invoice-keyed rows a legacy single
 * touch might have left, AND this lane's own combined-keyed rows for this
 * SAME included set (a partial success earlier already wrote one — same
 * day, or an earlier day if the touch was held and re-timed, since the
 * combined key carries no date; see currentCombinedStepLedgerIds), which
 * currentStepLedgerIds' per-invoice key format never matches (Codex
 * pre-push r2).
 *
 * Each row's legacy check uses ITS OWN current step, not the anchor's
 * (Fable review P2): a non-anchor sibling can sit at a DIFFERENT point of
 * its own cadence than the anchor (the combined message intentionally
 * spans them — see fireCombinedTouchClaimed's own comment), so a legacy
 * single touch it received earlier reserved a key at ITS OWN step id.
 * Checking every row against the anchor's step alone would miss that
 * sibling's real reservation and let the policy consult see it as an
 * unaccounted prior contact.
 */
async function combinedExcludeLedgerIds(included, rows, step, customerId, includedIdsKey, policyChannels) {
  const ownLedgerIdsPerRow = await Promise.all(included.map((inv) => {
    const originalRow = rows.find((r) => r.invoice_id === inv.invoice_id);
    const ownStep = followupSteps()[originalRow.step_index];
    if (!ownStep) return [];
    return currentStepLedgerIds(originalRow, ownStep, policyChannels).catch(() => []);
  }));
  const ownCombinedLedgerIds = await currentCombinedStepLedgerIds(
    customerId, step, includedIdsKey, policyChannels,
  ).catch(() => []);
  return [...new Set([...ownLedgerIdsPerRow.flat(), ...ownCombinedLedgerIds])];
}

/**
 * LAST-MINUTE re-verification, immediately before dispatch (Codex pre-push
 * r4): the per-row guard pass ran before several awaits (channel
 * preferences, the collections-policy consult, the ledger id lookups, the
 * pay-balance link) during which a sibling's Bill-To could still change —
 * the claim only protects each row's SEQUENCE state, not this. Covers
 * every quoted invoice, not only the anchor.
 */
async function combinedOwnershipStillEligible(included) {
  const freshOwnership = await Promise.all(included.map((inv) => db('invoices')
    .where({ id: inv.invoice_id }).first('payer_id', 'scheduled_send_error', 'status').catch(() => undefined)));
  return included.every((inv, index) => {
    const fresh = freshOwnership[index];
    if (!fresh) return false;
    if (fresh.payer_id || invoiceWithdrawnFromCustomer({ scheduled_send_error: fresh.scheduled_send_error })) return false;
    if (isTerminalInvoice(fresh)) return false;
    return true;
  });
}

/**
 * ONE text leg, on the best available channel the customer selected (sms
 * preferred; push only when sms is unavailable/unselected) — "one combined
 * text", not one attempt per selected channel. Mirrors fireTouch's own
 * hold/deliver decisions for its single-invoice SMS leg.
 */
// The reason a combined SMS/push leg never reached a send attempt at all —
// mirrors fireTouch's own smsSkipReason vocabulary for the SAME situations
// (no non-email channel selected, no phone, no template) so
// noDeliveryDisposition can apply the identical transient/terminal rule.
function combinedSmsUnavailableReason(smsChannel, smsTemplateKey, nonEmailChannels, customer) {
  if (!nonEmailChannels.length) return 'no_non_email_selected';
  if (!smsChannel) {
    const smsOnlySelected = nonEmailChannels.includes('sms') && !nonEmailChannels.includes('push');
    return smsOnlySelected && !customer.phone ? 'no_customer_phone' : 'collections_policy_denied';
  }
  return smsTemplateKey ? null : 'missing_template';
}

async function sendCombinedSmsLeg({
  customer, included, includedIds, includedIdsKey, step, smsTemplateKey, payUrl, totalDue, lineCents,
  nonEmailChannels, channelPolicy, durablyDenied, emailSelected, anchorRow, combinedLedgerKey, ContactLedger, category,
}) {
  let smsChannel = null;
  if (nonEmailChannels.includes('sms') && channelPolicy.sms === true && customer.phone) smsChannel = 'sms';
  else if (nonEmailChannels.includes('push') && channelPolicy.push === true) smsChannel = 'push';
  // A selected text channel this run couldn't pick because its ONLY
  // transient (not durable) — hold rather than silently drop it; matches
  // fireTouch's holdStep on a policy denial (pre-push audit P1).
  let smsHold = !smsChannel && nonEmailChannels.some((ch) => channelPolicy[ch] !== true && !durablyDenied[ch]);
  let smsOk = false;
  if (!smsChannel || !smsTemplateKey) {
    return {
      smsOk, smsHold, smsChannel,
      smsReason: combinedSmsUnavailableReason(smsChannel, smsTemplateKey, nonEmailChannels, customer),
    };
  }

  const body = await smsTemplatesRouter.getTemplate(smsTemplateKey, {
    first_name: customer.first_name || 'there',
    invoice_count: String(included.length),
    total_due: totalDue,
    pay_url: payUrl,
  }, { workflow: 'invoice_followup_combined', entity_type: 'customer', entity_id: customer.id });
  if (!body) {
    logger.warn(`[invoice-followups] combined SMS template ${smsTemplateKey} missing/disabled for customer ${customer.id}`);
    return { smsOk, smsHold, smsChannel, smsReason: 'missing_template' };
  }

  let ledger = null;
  try {
    ledger = await ContactLedger.recordContact({
      customerId: customer.id, channel: smsChannel, purpose: 'invoice_followup',
      invoiceIds: includedIds, source: 'invoice_followups',
      metadata: { step_id: step.id, combined: true, invoice_ids: includedIds },
      idempotencyKey: combinedLedgerKey(smsChannel),
    });
  } catch (err) {
    logger.warn(`[invoice-followups] combined ${smsChannel} ledger unavailable for customer ${customer.id}: ${err.message}`);
    smsHold = true; // retryable — don't drop the leg over a ledger blip
  }
  if (!ledger) return { smsOk, smsHold, smsChannel, smsReason: 'ledger_unavailable' };

  const claim = typeof ContactLedger.claimAttempt === 'function' ? await ContactLedger.claimAttempt(ledger) : { allowed: true };
  // A DEDUPED retry from an earlier attempt: nothing new is being sent this
  // run, so carry the ledger's ORIGINAL occurrence forward instead of
  // stamping "now" (Codex r2 P2 — mirrors fireTouch's own
  // originalDeliveryTimes.push(ledger.occurred_at) on this exact branch).
  if (claim.delivered) {
    return {
      smsOk: true, smsHold, smsChannel, smsFresh: false, smsOriginalAt: ledger.occurred_at || null,
    };
  }
  if (!claim.allowed) return { smsOk, smsHold: true, smsChannel, smsReason: 'prior_attempt_unconfirmed' }; // a prior attempt's outcome is still unconfirmed

  const dispatched = await dispatchCombinedSmsMessage({
    customer, smsChannel, body, includedIds, includedIdsKey, step, totalDue, payUrl, lineCents,
    emailSelected, anchorRow, category, ledger, ContactLedger, smsHold,
  });
  // dispatchCombinedSmsMessage/interpretCombinedSmsOutcome don't echo the
  // channel back in their result — fireCombinedTouchClaimed needs it to
  // record app_outbound vs sms_outbound (Codex r2 P2).
  return { ...dispatched, smsChannel };
}

/**
 * The actual provider handoff for the combined SMS/push leg, and the
 * fireTouch-mirrored interpretation of its outcome. Split from
 * sendCombinedSmsLeg (channel selection, template render, ledger claim) so
 * neither half reasons about the whole hold/deliver decision tree at once
 * (Codex r1 P2 — complexity).
 */
async function dispatchCombinedSmsMessage({
  customer, smsChannel, body, includedIds, includedIdsKey, step, totalDue, payUrl, lineCents,
  emailSelected, anchorRow, category, ledger, ContactLedger, smsHold,
}) {
  let result;
  try {
    result = await sendCustomerMessage({
      to: smsChannel === 'sms' ? customer.phone : undefined,
      body, channel: smsChannel, audience: 'customer', purpose: 'payment_link',
      customerId: customer.id, invoiceId: anchorRow.invoice_id, entryPoint: 'invoice_followup_sequence_combined',
      metadata: {
        original_message_type: 'invoice_followup_combined',
        // Scoped to the included set, same as the ledger/email keys —
        // otherwise a later group reaching the same step reuses this
        // App-push dedupe key and can silently skip the new reminder
        // (Codex pre-push r4).
        notificationEventKey: `invoice-followup-combined:${customer.id}:${step.id}:${includedIdsKey}`,
        billingDeliveryCategory: category, billingDeliveryLeg: smsChannel,
        invoice_ids: includedIds, rendered_amount: totalDue, collections_ledger_id: ledger.id,
        ...(smsChannel === 'push' ? { appOnly: true } : {}),
      },
      hasEmailLeg: emailSelected,
      // Every included invoice, not just the anchor: the quoted
      // count/total/pay link covers all of them, so a sibling reassigned
      // to a third-party payer between the last full re-read and this
      // provider handoff must still abort the send (Codex r1 P1). lineCents
      // (Codex r2 P1) also revalidates each invoice's LIVE amount due
      // against the snapshot this message quotes — a payment, credit
      // application, or edit landing since resolveCombinedPayLink read
      // otherwise lets a stale amount reach the customer; a mismatch
      // refuses the send as retryable, not terminal.
      preDispatchCheck: invoiceHelpers.selfPayAtDispatchMany(includedIds, db, lineCents),
    });
  } catch (err) {
    result = err.providerOutcome || { deliveryOutcome: 'uncertain' };
  }
  return interpretCombinedSmsOutcome({
    smsChannel, result, ledger, ContactLedger, smsHold,
  });
}

// The `delivery` (truthy) half of interpretCombinedSmsOutcome, split out to
// keep that function's own complexity down (Codex r2 P2 introduced the
// smsFresh/smsOriginalAt dedup distinction). A DEDUPED outcome
// (billingLegDeliveryState) is not a FRESH delivery — fireTouch's own SMS
// loop only counts actualSmsSent/appSent when delivery === 'delivered',
// never on 'deduped' — so carry the original occurrence time forward for
// last_touch_at instead of stamping "now".
async function interpretCombinedSmsDelivered({
  delivery, result, ledger, ContactLedger, smsHold,
}) {
  const occurredAt = billingLegContactTime(result);
  if (typeof ContactLedger.markDelivered === 'function') {
    await ContactLedger.markDelivered(ledger, ...(occurredAt ? [{ occurredAt }] : []));
  }
  return {
    smsOk: true,
    smsHold,
    smsFresh: delivery === 'delivered',
    smsOriginalAt: delivery === 'deduped' ? occurredAt : null,
  };
}

/**
 * fireTouch-mirrored interpretation of a combined SMS/push send outcome —
 * split out of dispatchCombinedSmsMessage so the provider call and the
 * hold/deliver decision tree are each reasoned about on their own (Codex
 * r1 P2 — complexity).
 */
async function interpretCombinedSmsOutcome({
  smsChannel, result, ledger, ContactLedger, smsHold,
}) {
  const delivery = billingLegDeliveryState(smsChannel, result || {});
  if (delivery) {
    return interpretCombinedSmsDelivered({
      delivery, result, ledger, ContactLedger, smsHold,
    });
  }
  if (result?.deliveryOutcome === 'not_sent' || (result?.deliveryOutcome == null && result?.blocked === true)) {
    // A DEFINITE provider rejection — but still hold when the stamp itself
    // didn't land, or the rejection is one fireTouch treats as
    // retryable/deferred rather than final (a consent lookup failure, a
    // send-window defer): mirrors fireTouch's own holdStep calls on this
    // exact branch (Codex pre-push r3).
    let held = smsHold;
    if (!await ContactLedger.markSendFailed(ledger, { code: result?.code || 'not_sent' })) held = true;
    if (result?.retryable || result?.deferred || result?.code === 'CONSENT_LOOKUP_FAILED') held = true;
    return { smsOk: false, smsHold: held, smsReason: result?.code || 'not_sent' };
  }
  // Uncertain / retryable (a thrown send, a deferred window): the provider
  // may still have accepted it — do NOT stamp send_failed (that would let
  // claimAttempt reopen the reservation and risk a duplicate text). Hold
  // instead, same as fireTouch's holdStep (pre-push audit P1).
  return { smsOk: false, smsHold: true, smsReason: 'outcome_unconfirmed' };
}

/**
 * ONE email leg for the combined touch. Mirrors fireTouch's own hold/
 * deliver decisions for its single-invoice email leg.
 */
async function sendCombinedEmailLeg({
  customer, included, includedIds, includedIdsKey, step, emailTemplateKey, payUrl, totalDue, lineCents,
  channelPolicy, durablyDenied, emailSelected, combinedLedgerKey, ContactLedger, anchorRow, explicit,
}) {
  let emailOk = false;
  // Selected but not (yet) permitted, and not a durable denial — hold, same
  // as fireTouch's own emailHold seed (pre-push audit P1).
  let emailHold = emailSelected && channelPolicy.email !== true && !durablyDenied.email;
  if (!emailSelected || channelPolicy.email !== true || !emailTemplateKey) {
    const emailReason = !emailSelected ? 'not_selected'
      : channelPolicy.email !== true ? 'collections_policy_denied' : 'missing_template';
    return { emailOk, emailHold, emailReason };
  }

  let emailLedger = null;
  try {
    emailLedger = await ContactLedger.recordContact({
      customerId: customer.id, channel: 'email', purpose: 'invoice_followup',
      invoiceIds: includedIds, source: 'invoice_followups',
      metadata: { step_id: step.id, combined: true, invoice_ids: includedIds },
      idempotencyKey: combinedLedgerKey('email'),
    });
  } catch (err) {
    logger.warn(`[invoice-followups] combined email ledger unavailable for customer ${customer.id}: ${err.message}`);
  }
  if (!emailLedger) return { emailOk, emailHold: true, emailReason: 'ledger_unavailable' }; // ledger unavailable — retry, don't drop the leg

  const claim = typeof ContactLedger.claimAttempt === 'function' ? await ContactLedger.claimAttempt(emailLedger) : { allowed: true };
  // A DEDUPED retry from an earlier attempt: nothing new is being sent this
  // run — carry the ledger's ORIGINAL occurrence forward instead of "now"
  // (Codex r2 P2, mirrors fireTouch's own claim.delivered branch).
  if (claim.delivered) {
    return {
      emailOk: true, emailHold, emailFresh: false, emailOriginalAt: emailLedger.occurred_at || null,
    };
  }
  if (!claim.allowed) return { emailOk, emailHold: true, emailReason: 'prior_attempt_unconfirmed' }; // a prior attempt's outcome is still unconfirmed

  const emailResult = await sendCombinedFollowupEmail({
    customer, step, anchorInvoiceId: anchorRow.invoice_id, includedIdsKey, includedIds, lineCents,
    payload: {
      invoice_count: String(included.length),
      total_due: `$${totalDue}`,
      pay_url: payUrl,
      customer_portal_url: `${publicPortalUrl()}/?tab=billing`,
      invoices: included.map((inv) => ({
        invoice_number: inv.invoice_number || '',
        invoice_title: inv.title || 'your service',
        amount_due: currency(lineCents[String(inv.invoice_id ?? inv.id)] / 100),
      })),
    },
  });
  return settleCombinedEmailSend({
    ContactLedger, emailLedger, emailResult, explicit, durablyDenied, emailHold,
  });
}

/**
 * The settle-and-classify half of sendCombinedEmailLeg, split out to keep
 * that function's own complexity down (Codex r2 P2 — complexity). Stamps
 * the ledger row and reasons about hold/fresh/original-time exactly the
 * way the caller's own doc comment (below, unchanged) describes.
 *
 * settleFollowupEmailLedger stamps the ledger row (delivered /
 * send_failed) and returns whether the step should stay HELD — delivery
 * itself is emailResult.ok. It returns NOT-held for any stamped failure,
 * including a merely RETRYABLE refusal, so mirror fireTouch's own
 * additional check: an unsuccessful, non-durably-denied result that is
 * not a genuinely TERMINAL refusal still holds (Codex pre-push r2) —
 * settling only on delivery or a true terminal refusal (missing address,
 * template unavailable, a suppression), never on an ordinary retryable
 * not-sent. `explicit` (Codex r2 P2, was hardcoded true) is whether the
 * customer actually chose their channels — same param fireTouch threads
 * through as `selectedChannels !== null` — so a default-channel send
 * keeps its never_contacted stamp on a retryable pre-provider refusal
 * instead of reading as an explicit selection's terminal resolution.
 */
async function settleCombinedEmailSend({
  ContactLedger, emailLedger, emailResult, explicit, durablyDenied, emailHold,
}) {
  const held = await settleFollowupEmailLedger(ContactLedger, emailLedger, emailResult, explicit, []);
  const emailOk = emailResult.ok === true;
  const terminal = terminalFollowupEmailRefusal(emailResult);
  const resolvedHold = emailHold || held || (!durablyDenied.email && emailOk !== true && !terminal);
  // A deduped PROVIDER outcome (not the pre-send claim.delivered above) —
  // e.g. a suppressed retry the provider itself recognized — is also not a
  // fresh delivery (mirrors fireTouch's `emailResult.ok && !emailResult.deduped`).
  const emailFresh = emailOk && emailResult.deduped !== true;
  const emailOriginalAt = emailOk && !emailFresh
    ? (originalBillingContactArgs(emailResult)[0]?.occurredAt || null) : null;
  return {
    emailOk,
    emailHold: resolvedHold,
    emailFresh,
    emailOriginalAt,
    emailReason: emailResult.reason || emailResult.error || null,
  };
}

/**
 * A held combined touch (see the caller above) must not leave
 * next_touch_at at its already-elapsed due date: the single-invoice path's
 * own holdStep always re-dates to heldTouchFloor() (the start of the next
 * NY calendar day) for exactly this reason — without it, the NEXT run's
 * isStaleTouch check measures from the ORIGINAL due date, finds the touch
 * stale, and skipStaleTouches advances the step without ever sending it
 * (Fable review P1). Only moves next_touch_at forward — a row already
 * scheduled at or after the floor (e.g. re-selected same-day) is left
 * alone — and only a still-active row at its batch-snapshot step, so an
 * admin edit or a manual advance in the meantime is never clobbered.
 */
async function reTimeHeldCombinedSequences(included, rows) {
  const floor = heldTouchFloor();
  for (const inv of included) {
    const originalRow = rows.find((r) => r.invoice_id === inv.invoice_id);
    if (!originalRow) continue;
    const current = originalRow.next_touch_at ? new Date(originalRow.next_touch_at) : null;
    if (current && current.getTime() >= floor.getTime()) continue;
    await db('invoice_followup_sequences')
      .where({ id: originalRow.id, status: 'active', step_index: originalRow.step_index })
      .update({ updated_at: db.fn.now(), next_touch_at: floor })
      .catch((err) => logger.warn(
        `[invoice-followups] could not re-time held combined touch for sequence ${originalRow.id}: ${err.message}`,
      ));
  }
}

/**
 * Nothing delivered and neither leg is held — mirror fireTouch's own
 * end-of-touch disposition exactly (noDeliveryDisposition, shared): a
 * transient collections-policy/ledger reason leaves the group armed and
 * due for a later run; anything else is a genuine terminal failure and
 * every included sequence is paused. Split out of fireCombinedTouchClaimed
 * to keep that orchestrator's own complexity down (Codex r2 P1 — this
 * branch previously left the rows completely untouched, so a genuinely
 * undeliverable customer re-attempted, and re-failed, every run forever
 * instead of ever pausing).
 */
async function handleCombinedNoDelivery({
  customerId, step, included, rows, smsReason, emailReason,
}) {
  const disposition = noDeliveryDisposition([smsReason, emailReason], smsReason || emailReason);
  if (disposition.leaveArmed) {
    logger.info(`[invoice-followups] combined touch for customer ${customerId} step ${step.id} held by collections policy/ledger — retrying on a later run`);
    return;
  }
  await pauseCombinedSequences(included, rows, disposition.pausedReason);
  logger.warn(`[invoice-followups] combined touch for customer ${customerId} step ${step.id} paused — ${included.length} sequence(s): ${disposition.pausedReason}`);
}

/**
 * The genuine terminal half of noDeliveryDisposition, for a whole combined
 * group: mirrors fireTouch's own terminal pause (status='paused',
 * next_touch_at=null, paused_reason stamped) but over every included
 * sequence at once, since the combined touch already committed to ONE
 * outcome for the whole group (Codex r2 P1).
 */
async function pauseCombinedSequences(included, rows, pausedReason) {
  const ids = included
    .map((inv) => rows.find((r) => r.invoice_id === inv.invoice_id)?.id)
    .filter(Boolean);
  if (!ids.length) return;
  await db('invoice_followup_sequences').whereIn('id', ids).update({
    updated_at: db.fn.now(),
    status: 'paused',
    paused_reason: pausedReason,
    next_touch_at: null,
  });
}

/**
 * Advance every included sequence past this step and log the per-invoice
 * audit trail, once delivery has settled. freshDelivery/originalAt mirror
 * fireTouch's own freshDelivery/originalAt (Codex r2 P2): a deduped retry
 * (claim.delivered from an earlier attempt, or a deduped provider/email
 * outcome) still advances the step, but last_touch_at carries the ORIGINAL
 * occurrence forward instead of "now", and gets no fresh customer_interactions
 * row — nothing new was actually sent.
 */
async function advanceCombinedSequences({
  included, rows, customer, step, totalDue, smsOk, emailOk, includedIds,
  freshDelivery, originalAt, smsChannelUsed,
}) {
  // One transaction for every included sequence's advance (Codex r1 P2):
  // the message already went out for the WHOLE group, so a failure partway
  // through these updates must not leave some sequences advanced and
  // others not — a stalled row would carry a different grouping/
  // idempotency identity next run and could pick up its own individual
  // reminder on top of the combined one just delivered.
  await db.transaction(async (trx) => {
    for (const inv of included) {
      const originalRow = rows.find((r) => r.invoice_id === inv.invoice_id);
      const nextIndex = originalRow.step_index + 1;
      const anchorAt = originalRow.anchor_at || originalRow.invoice_sent_at
        || originalRow.invoice_sms_sent_at || originalRow.invoice_created_at || originalRow.created_at;
      const nextAt = computeNextTouchAt(anchorAt, nextIndex);
      await trx('invoice_followup_sequences').where({ id: originalRow.id }).update({
        updated_at: trx.fn.now(),
        touches_sent: originalRow.touches_sent + 1,
        step_index: nextIndex,
        last_touch_at: freshDelivery ? new Date() : (originalAt || originalRow.last_touch_at),
        next_touch_at: nextAt,
        status: nextAt ? 'active' : 'completed',
      });
    }
  });
  // An already-delivered leg (a deduped retry) advances its step without a
  // new outbound touch — same as fireTouch's own `if (!freshDelivery)
  // return;` right after its sequence update.
  if (!freshDelivery) return;
  // customer_interactions rows are audit trail, not delivery state — kept
  // outside the transaction (non-critical, same as every other touch path)
  // so one insert failure never rolls back the sequence advances above.
  // Push-only delivery records as app_outbound, not sms_outbound (Codex r2
  // P2 — the channel actually used, mirroring fireTouch's own
  // actualSmsSent/appSent distinction).
  const interactionType = smsOk && smsChannelUsed === 'push' ? 'app_outbound'
    : smsOk ? 'sms_outbound' : 'email_outbound';
  for (const inv of included) {
    try {
      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: interactionType,
        subject: `Invoice follow-up (combined) — ${step.label} (${inv.invoice_number || inv.invoice_id})`,
        body: `Combined step fired for ${included.length} invoices totaling $${totalDue}. This invoice: ${currency(invoiceAmountDue(inv))}.`,
        metadata: JSON.stringify({
          invoice_id: inv.invoice_id, step_id: step.id, combined: true, invoice_ids: includedIds,
          sms_sent: smsOk, email_sent: emailOk,
        }),
      });
    } catch { /* non-critical */ }
  }
}

/**
 * Combined-touch twin of sendFollowupEmail: same billing-authority
 * recipient resolution, provider handoff and outcome settlement, rendering
 * the combined template with the per-customer payload built by
 * fireCombinedTouchClaimed (invoice_count/total_due/pay_url/invoices) plus
 * the resolved recipient's first name.
 */
async function sendCombinedFollowupEmail({
  customer, step, anchorInvoiceId, includedIdsKey, includedIds, lineCents, payload,
}) {
  const templateKey = COMBINED_EMAIL_TEMPLATE_BY_STEP_ID[step.id];
  if (!templateKey) return { ok: false, skipped: true, reason: 'no_email_template_mapping' };
  const authorityInput = {
    customerId: customer.id, invoiceId: anchorInvoiceId, channel: 'email',
    metadata: { billingDeliveryCategory: 'invoice' },
  };
  // Every included invoice, not just the anchor authorityInput carries
  // (Codex r1 P1) — dispatchUnderBillingEmailAuthority runs this both
  // before provider preparation and again at the locked provider-boundary
  // recheck, so a sibling reassigned to a third-party payer in that window
  // still aborts the whole combined send. lineCents (Codex r2 P1) also
  // revalidates each invoice's LIVE amount due against the amount this
  // email quotes at that same locked recheck — see selfPayAtDispatchMany.
  const preSendCheck = invoiceHelpers.selfPayAtDispatchMany(
    includedIds && includedIds.length ? includedIds : [anchorInvoiceId], db, lineCents,
  );
  const { recipient, to, refusal } = await billingEmailRecipient(authorityInput, 'invoice-followups');
  if (refusal) return refusal;
  const finalPayload = {
    ...payload,
    first_name: firstToken(recipient.name) || firstToken(customer.first_name) || 'there',
  };
  const log = (fields) => logFollowupEmailAttempt({
    customerId: customer.id, invoiceId: anchorInvoiceId, stepId: step.id, templateKey, ...fields,
  });
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to,
      payload: finalPayload,
      recipientType: 'customer',
      recipientId: customer.id,
      // Scoped to the INCLUDED invoice set, not just customer+step: the same
      // step id recurs for a customer as later invoices reach it, and an
      // unscoped key would dedupe a new pair's send against a stale prior
      // one at the same step (pre-push audit P1).
      triggerEventId: `invoice_followup_combined:${customer.id}:${step.id}:${includedIdsKey}`,
      idempotencyKey: `invoice_followup_combined_email:${customer.id}:${step.id}:${includedIdsKey}`,
      categories: ['invoice_followup', 'combined', step.id],
      suppressionGroupKey: 'transactional_required',
      withProviderHandoff: (dispatch) => dispatchUnderBillingEmailAuthority({
        input: authorityInput, recipientEmail: to, templateKey, dispatch, state, preSendCheck,
      }),
    });
    return await billingEmailSendOutcome(result, state, log);
  } catch (err) {
    return billingEmailSendFailure(err, state.handoffStarted, log, {
      logTag: 'invoice-followups', label: `combined ${step.id} for customer ${customer.id}`,
    });
  }
}

async function fireTouch(row, { operatorInitiated = false } = {}) {
  const step = followupSteps()[row.step_index];
  if (!step) {
    await db('invoice_followup_sequences').where({ id: row.id }).update({
      updated_at: db.fn.now(),
      status: 'completed',
      next_touch_at: null,
    });
    return;
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
    return;
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
    return;
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
    return;
  }
  if (!customer) {
    logger.warn(`[invoice-followups] skipped sequence ${row.id} — customer ${row.customer_id} is missing`);
    return;
  }
  const mdPending = gates.divertMicrodepositDunning
    && await StripeService.isInvoiceAwaitingMicrodepositVerification({
      id: row.invoice_id,
      stripe_payment_intent_id: row.invoice_stripe_pi,
    });
  const category = mdPending ? 'payment_issue' : 'invoice';
  let explicitChannels = null;
  if (!operatorInitiated) {
    try {
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
      explicitChannels = explicitBillingChannels(prefs || {}, category);
    } catch (err) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — channel preferences unavailable: ${err.message}`);
      return;
    }
  }
  // Collections policy — BOTH legs' permissions resolved here, ahead of the
  // account-credit draw (a fully-denied touch must not draw down credit and
  // then need a reversal). Each channel decides independently (codex
  // 2026-08-14: the email leg must not ride the SMS verdict). Gate off ⇒
  // both true without consulting, byte-identical (pinned by test). A policy
  // denial is a TRANSIENT state (frequency window, releasable hold) — a
  // both-denied touch returns with the sequence still active and due, so
  // the next tick re-decides; it is never paused terminally for policy.
  const selectedChannels = explicitChannels;
  const nonEmailChannels = selectedChannels === null ? ['sms']
    : ['push', 'sms'].filter((channel) => selectedChannels.includes(channel));
  const emailSelected = selectedChannels === null || selectedChannels.includes('email');
  const policyChannels = [...nonEmailChannels, ...(emailSelected ? ['email'] : [])];
  let ownLedgerIds = [];
  if (selectedChannels !== null) {
    try { ownLedgerIds = await currentStepLedgerIds(row, step, policyChannels); }
    catch (err) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — step ledger unavailable: ${err.message}`);
      return;
    }
  }
  const policyResults = await Promise.all(policyChannels.map((channel) =>
    collectionsChannelPermitted(row.customer_id, row.invoice_id, channel, ownLedgerIds, true)));
  // Partial debt evidence cannot authorize a leg (billing-reminder-delivery.js's
  // sendReminderChannels applies the identical rule) — hold the whole touch
  // rather than dun against a balance the policy itself could not fully see.
  if (policyBalanceIncomplete(policyResults)) {
    logger.info(`[invoice-followups] collections policy balance evidence incomplete for sequence ${row.id} — touch deferred to a later run`);
    return;
  }
  const channelPolicy = Object.fromEntries(policyChannels.map((channel, index) => [channel, verdictAllows(policyResults[index])]));
  const emailDurablyDenied = verdictDurablyDenied(policyResults[policyChannels.indexOf('email')]);
  const smsPermitted = channelPolicy.sms === true;
  const emailPermitted = channelPolicy.email === true;
  if (!Object.values(channelPolicy).some(Boolean)) {
    logger.info(`[invoice-followups] collections policy denied selected channels for sequence ${row.id} — touch deferred to a later run`);
    return;
  }
  // Apply any available account credit before dunning so the reminder bills amount
  // due, not the gross balance — credit issued AFTER the invoice was sent isn't drawn
  // down until a payment-ask seam runs, and this dunning touch is one of them. Gated +
  // best-effort + idempotent. Re-read the (possibly reduced) invoice; if credit fully
  // covered it the invoice is now prepaid/paid — stop the sequence instead of dunning.
  // Track what THIS dun drew down so the no-channel-delivered path below can reverse
  // it (don't consume credit for an undelivered reminder; matches the send/project
  // rollback).
  let dunAppliedCredit = 0;
  try {
    const { autoApplyAccountCreditIfEnabled } = require('./customer-credit');
    const dunCreditResult = await autoApplyAccountCreditIfEnabled(row.invoice_id);
    dunAppliedCredit = dunCreditResult?.applied || 0;
  } catch (creditErr) {
    logger.warn(`[invoice-followups] account-credit apply before dun skipped for ${row.invoice_id}: ${creditErr.message}`);
  }
  // The refresh runs in its OWN try: it is what keeps the reminder's
  // amounts/copy on the just-edited live row instead of the batch snapshot
  // (edits are fenced out from the claim onward, so this read is the settled
  // state) — a credit-helper failure above must not bypass it.
  try {
    const fresh = await db('invoices').where({ id: row.invoice_id })
      .first('total', 'credit_applied', 'status', 'title', 'token', 'due_date', 'invoice_number',
        'payer_id', 'scheduled_send_error');
    // FAIL CLOSED on an unreadable row (Codex #4311 r38 P1): this read is the
    // last-minute ownership backstop, and it sits inside a refresh block that
    // was written to fail OPEN for the price fields. Continuing on stale batch
    // data is exactly the case the backstop exists for, so a missing row stops
    // the touch and the sweep re-judges it next run.
    if (!fresh) {
      logger.warn(`[invoice-followups] skipped sequence ${row.id} — invoice ${row.invoice_id} could not be re-read before the send`);
      return;
    }
    // OWNERSHIP AGAIN, on this last read before the provider (local audit):
    // the policy, credit and ledger work above is all awaited, and a Bill-To
    // assignment landing in that window would otherwise be invisible to this
    // already-claimed worker. The pause it wrote is authoritative; this send
    // simply stops.
    if (fresh && (fresh.payer_id || invoiceWithdrawnFromCustomer(fresh))) {
      logger.info(`[invoice-followups] dropped touch for sequence ${row.id} — invoice ${row.invoice_id} moved to a third-party payer during this run`);
      return;
    }
    if (fresh) {
      row.total = fresh.total;
      row.credit_applied = fresh.credit_applied;
      row.title = fresh.title;
      row.token = fresh.token;
      row.due_date = fresh.due_date;
      row.invoice_number = fresh.invoice_number;
      if (['prepaid', 'paid'].includes(String(fresh.status || '').toLowerCase())) {
        await stopOnPayment(row.invoice_id).catch(() => {});
        return;
      }
    }
  } catch (refreshErr) {
    // FAIL CLOSED (Codex #4311 r38 P1): this block carries the last-minute
    // ownership backstop now, so an unreadable refresh can no longer fall
    // through to the provider on stale batch data — precisely when a Bill-To
    // change may have landed. The sequence keeps its schedule and the next
    // sweep re-judges it.
    logger.warn(`[invoice-followups] skipped sequence ${row.id} — invoice refresh before dun failed for ${row.invoice_id}: ${refreshErr.message}`);
    return;
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
  let emailResult = { ok: false, skipped: true, reason: 'collections_policy_denied' };
  // A spacing-window denial keeps the selected Email owed on this step; a
  // durable one (flag, suppression) waives it so the step cannot be pinned
  // forever. The global-hold gate above still stops an all-denied touch.
  let emailHold = selectedChannels !== null && emailSelected && !emailPermitted && !emailDurablyDenied;
  if (emailPermitted) {
    let emailLedger = null;
    try {
      emailLedger = await ContactLedger.recordContact({
        customerId: customer.id,
        channel: 'email',
        purpose: mdPending ? 'payment_verification' : 'invoice_followup',
        invoiceIds: [row.invoice_id],
        source: 'invoice_followups',
        metadata: { step_id: step.id },
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
              invoice: { id: row.invoice_id, title: row.title, total: row.total, credit_applied: row.credit_applied },
              customer,
              touchKey: step.id, // one branded verification email per follow-up step (same cadence as the SMS)
              enforceBillingPreference: !operatorInitiated,
            })
          : await sendFollowupEmail({ row, customer, step, ctx, enforceBillingPreference: !operatorInitiated });
        const attemptHeld = await settleFollowupEmailLedger(
          ContactLedger, emailLedger, emailResult, selectedChannels !== null, originalDeliveryTimes,
        );
        emailHold = emailHold || attemptHeld;
      }
    } else if (selectedChannels !== null) emailHold = true;
  }
  if (selectedChannels !== null && emailSelected && !emailDurablyDenied && emailResult.ok !== true
    && !terminalFollowupEmailRefusal(emailResult)) emailHold = true;

  let smsSent = false;
  let actualSmsSent = false;
  let appSent = false;
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
      body = mdPending
        ? await renderSmsTemplate('bank_verification_incomplete', {
            first_name: ctx.name, billing_url: `${publicPortalUrl()}/?tab=billing`,
          }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: row.invoice_id })
        : await resolveBody(step, ctx);
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
          metadata: { step_id: step.id }, idempotencyKey: followupLedgerKey(row, step, channel),
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
          preDispatchCheck: invoiceHelpers.selfPayAtDispatch(row.invoice_id, db),
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
  } else if (!smsPermitted) {
    // Collections policy denial — transient; the no-channel branch below
    // leaves the sequence armed instead of pausing it.
    smsSkipReason = 'collections_policy_denied';
  } else if (customer.phone) {
    const messageType = mdPending ? 'bank_verification_incomplete' : 'invoice_followup';
    const body = mdPending
      ? await renderSmsTemplate('bank_verification_incomplete', {
          first_name: ctx.name,
          billing_url: `${publicPortalUrl()}/?tab=billing`,
        }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: row.invoice_id })
      : await resolveBody(step, ctx);
    if (!body) {
      smsSkipReason = 'missing_template';
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
          metadata: { step_id: step.id },
        });
      } catch (ledgerErr) {
        smsSkipReason = 'ledger_unavailable';
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
        preDispatchCheck: invoiceHelpers.selfPayAtDispatch(row.invoice_id, db),
      }) : null;
      if (sendResult && (sendResult.blocked || sendResult.sent === false)) {
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
        logger.warn(`[invoice-followups] SMS blocked for sequence ${row.id}: ${sendResult.code || 'unknown'} ${sendResult.reason || ''}`);
      } else if (sendResult) {
        smsSent = true;
        actualSmsSent = true;
      }
    }
  } else {
    smsSkipReason = 'no_customer_phone';
    logger.warn(`[invoice-followups] no phone for customer ${row.customer_id}`);
  }

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
      // Nothing failed — the touch fired outside the 8AM-8PM ET send
      // window and no email leg covered it. Keep the sequence active and
      // move ONLY this touch to the window open; the same step re-fires at
      // 8:00 AM with a fresh credit draw (tonight's is reversed below,
      // same as the pause branch — nothing was delivered).
      await db('invoice_followup_sequences').where({ id: row.id }).update({
        updated_at: db.fn.now(),
        next_touch_at: smsDeferUntil,
      });
    } else {
      // Transient collections-policy denial / ledger outage — NOT a
      // delivery failure — leaves the sequence armed and due (no status
      // write) so a later tick re-decides; pausing terminally here would
      // turn a 24h frequency window into a permanently silenced sequence.
      // Anything else is a genuine terminal failure. Shared with the
      // combined touch's own no-delivery branch (noDeliveryDisposition).
      const disposition = noDeliveryDisposition(
        [smsSkipReason, emailResult.reason],
        smsSkipReason || emailResult.reason || emailResult.error,
      );
      if (disposition.leaveArmed) {
        logger.info(`[invoice-followups] touch for sequence ${row.id} held by collections policy/ledger — retrying on a later run`);
      } else {
        await db('invoice_followup_sequences').where({ id: row.id }).update({
          updated_at: db.fn.now(),
          status: 'paused',
          paused_reason: disposition.pausedReason,
          next_touch_at: null,
        });
      }
    }
    // No reminder went out — reverse the credit THIS dun drew down so we don't consume
    // it for an undelivered touch (matches the invoice/project send rollback). Only
    // this dun's increment; any prior applied credit stays. The invoice is collectible
    // here, so reverseAppliedCredit (which refuses 'sending'/'prepaid') applies.
    if (dunAppliedCredit > 0) {
      try {
        const { reverseAppliedCredit } = require('./customer-credit');
        await reverseAppliedCredit({ invoiceId: row.invoice_id, amount: dunAppliedCredit, createdBy: 'system:dun_undelivered' });
      } catch (e) {
        logger.warn(`[invoice-followups] credit reversal after undelivered dun skipped for ${row.invoice_id}: ${e.message}`);
      }
    }
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
  const originalAt = originalDeliveryTimes.length
    ? new Date(Math.max(...originalDeliveryTimes.map((time) => new Date(time).getTime()))) : row.last_touch_at;
  // Only an earlier accepted leg reached the customer on this path. Return
  // this run's credit draw; the previous attempt's applied credit stays put.
  if (!freshDelivery && !smsDeferredOwned && !smsOutcomeMayHaveDelivered && dunAppliedCredit > 0) {
    try {
      const { reverseAppliedCredit } = require('./customer-credit');
      await reverseAppliedCredit({ invoiceId: row.invoice_id, amount: dunAppliedCredit, createdBy: 'system:dun_undelivered' });
    } catch (e) {
      logger.warn(`[invoice-followups] credit reversal after prior-delivery replay skipped for ${row.invoice_id}: ${e.message}`);
    }
  }
  const nextIndex = row.step_index + 1;
  // anchor_at (set when an admin edit shifted the due date) overrides the
  // send-time anchor so the whole remaining cadence stays on one timeline.
  const anchorAt = row.anchor_at || row.invoice_sent_at || row.invoice_sms_sent_at || row.invoice_created_at || row.created_at;
  const nextAt = computeNextTouchAt(anchorAt, nextIndex);

  await db('invoice_followup_sequences').where({ id: row.id }).update({
    updated_at: db.fn.now(),
    touches_sent: row.touches_sent + 1,
    step_index: nextIndex,
    last_touch_at: freshDelivery ? new Date() : originalAt,
    next_touch_at: nextAt,
    status: nextAt ? 'active' : 'completed',
  });

  // (Contact-ledger rows were written BEFORE each leg's delivery attempt —
  // record-then-send, codex 2026-08-14 — so there is nothing to record here.)

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
  await db('invoice_followup_sequences').where({ id: seq.id, status: 'autopay_hold' }).update({
    updated_at: db.fn.now(),
    status: 'active',
    is_autopay_held: false,
    // A shifted anchor (delivered-invoice due-date edit while held) wins so
    // the re-armed step lands on the same timeline fireStep progression uses.
    next_touch_at: computeNextTouchAt(seq.anchor_at || invoice.sent_at || invoice.sms_sent_at || invoice.created_at, seq.step_index),
  });
}

/**
 * Called per-customer when autopay fails — bumps the counter on every
 * active autopay-held sequence for that customer, and releases any whose
 * count has crossed the threshold.
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
async function pauseSequence(invoiceId, { reason, until, adminId } = {}) {
  await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).update({
    updated_at: db.fn.now(),
    status: 'paused',
    paused_reason: reason || null,
    paused_until: until || null,
    paused_by_admin_id: adminId || null,
    next_touch_at: null,
  });
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

async function resumeSequence(invoiceId, dbc = db) {
  const seq = await dbc('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
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
  if (seq.is_autopay_held) {
    let stillEnrolled = true;
    try {
      const customer = await dbc('customers').where({ id: seq.customer_id }).first();
      // failClosed: without it a payment_methods read error is swallowed
      // inside the eligibility helper and reads as confirmed unenrollment
      // — this catch would never fire and an enrolled customer's hold
      // would activate into reminders (Codex #3493 r16).
      stillEnrolled = customer ? await customerOnAutopay(customer, { db: dbc, failClosed: true }) : false;
    } catch (err) {
      logger.warn(`[invoice-followups] resume autopay re-check failed for invoice ${invoiceId} — keeping the hold: ${err.message}`);
      stillEnrolled = true;
    }
    if (stillEnrolled) {
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

async function stopSequence(invoiceId, { reason, adminId } = {}) {
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
      .first('status', 'stopped_reason', 'stopped_by_admin_id');
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
}

/**
 * Send the next touch right now, even if it's not due yet. Virginia uses this
 * when a customer is dodging (e.g. "push them to day-14 language today").
 */
async function sendNextTouchNow(invoiceId, { operatorInitiated = false } = {}) {
  const seq = await db('invoice_followup_sequences').where({ invoice_id: invoiceId }).first();
  if (!seq || seq.status === 'stopped' || seq.status === 'completed') return;

  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice || isTerminalInvoice(invoice)) return;

  // Temporarily set next_touch_at in the past + status active, then fire
  await db('invoice_followup_sequences').where({ id: seq.id }).update({
    updated_at: db.fn.now(),
    status: 'active',
    next_touch_at: new Date(Date.now() - 1000),
  });

  const row = await db('invoice_followup_sequences as s')
    .join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.id', seq.id)
    .select(
      's.*',
      'i.id as invoice_id', 'i.token', 'i.title', 'i.total', 'i.credit_applied',
      'i.stripe_payment_intent_id as invoice_stripe_pi',
      'i.service_date', 'i.due_date', 'i.invoice_number',
    )
    .first();

  if (row) await fireStep(row, { operatorInitiated });
}

/**
 * Called by late-payment-checker.js to decide whether an invoice is already
 * handled by the per-invoice sequence (so we skip the account-level reminder).
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
 * (e.g. customer is paying by mailed check). The account-level late-payment-checker
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
  adoptOrphanInvoices,
  scheduleForInvoice,
  runPending,
  // Used by the scheduled-SMS executor to suppress stale deferred
  // invoice/dunning replays (paid/void overnight).
  isTerminalInvoice,
  stopOnPayment,
  releaseFromAutopayHold,
  handleAutopayFailure,
  pauseSequence,
  resumeSequence,
  resumeSequenceIfSystemResumable,
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
  // Pure predicates, exported for tests only.
  _test: { canSystemResume, isSystemStopStamp },
};
