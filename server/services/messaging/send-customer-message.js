/**
 * send_customer_message — the canonical send path for every customer/lead-
 * facing outbound message. Internal sends (BI briefing) flow through the
 * same wrapper with audience: 'internal'.
 *
 * This module is the application-side enforcement layer. It is NOT a
 * compliance/legal solution by itself — carrier registration (A2P 10DLC),
 * consent-copy wording, privacy-policy language, and legal review remain
 * separate. What this layer guarantees:
 *
 *   1. No customer/lead-facing SMS bypasses the policy chain.
 *   2. Suppression is checked before every customer/lead send.
 *   3. SMS permits emoji for every audience.
 *   4. Sensitive purposes (payment_link, billing) require identity context.
 *   5. Segment count is computed and logged for audit/visibility.
 *   6. Internal BI keeps its emoji/3-segment behavior via audience='internal'.
 *   7. Every send attempt — sent OR blocked — is recorded in the audit log.
 *
 * Validator chain order (deterministic):
 *
 *   normalize_recipient
 *   require_input_ids                  — required IDs present per policy
 *   load_contact_state                 — pull notification_prefs + customer
 *   load_suppression_state             — pull active suppression record
 *   check_suppression                  — STOP/wrong-number list
 *   check_consent_for_purpose          — sms_enabled + per-purpose flag/marketing
 *   validate_identity_trust            — identityTrustLevel >= policy.minIdentityTrust
 *   validate_no_customer_emoji         — enforce non-SMS emoji policy
 *   persist_audit_log                  — every attempt, blocked or sent
 *   send_via_provider                  — twilio for sms; email/portal_chat in follow-up
 *   persist_delivery_attempt           — fold provider outcome into audit row
 *
 * Each validator returns { ok: true } | { ok: false, code, reason }. The
 * wrapper stops at the first non-ok result, persists an audit row marked
 * blocked, and returns without invoking the provider.
 *
 * @typedef {import('./policy').SendCustomerMessageInput} SendCustomerMessageInput
 */

const logger = require('../logger');
const policyModule = require('./policy');
const { loadContactState, checkConsentForPurpose } = require('./validators/consent');
const { loadSuppressionState, checkSuppression } = require('./validators/suppression');
const { checkLineType } = require('./validators/line-type');
const { validateRequiredIds, validateIdentityTrust, resolveTrustLevel } = require('./validators/identity');
const { validateNoCustomerEmoji } = require('./validators/voice');
const { checkSendWindow } = require('./validators/send-window');
const { checkContactCompliance } = require('./compliance-contact-checks');
const { countSegments } = require('./segment-counter');
const { normalizeGsmPunctuation } = require('./gsm-normalize');
const { stripSmsUrlScheme } = require('./sms-link-policy');
const { persistAudit } = require('./audit');
const { sendViaTwilio, mediaUrlsAllowed, mapPurposeToMessageType } = require('./providers/twilio-sms');
const { isEnabled } = require('../../config/feature-gates');

const DEFAULT_PROVIDER_RETRY_DELAY_MS = 5 * 60 * 1000;

// Receipt re-sharing needs invoice-specific SMS evidence. receipt_sent_at
// also covers email; provider success can mean push or an owner-silence
// sentinel. Only an accepted Twilio SMS/MMS for a settled invoice qualifies.
async function recordReceiptSmsDelivery(input, outcome) {
  const receipt = (input.purpose === 'payment_receipt' && input.metadata?.original_message_type === 'receipt')
    || (input.purpose === 'appointment' && input.metadata?.original_message_type === 'service_complete_paid_receipt');
  if (!receipt || input.channel !== 'sms' || !input.invoiceId || !input.customerId
    || outcome.sent !== true || outcome.deliveryOutcome !== 'accepted' || outcome.provider !== 'twilio'
    || !/^(SM|MM)[a-f0-9]{32}$/i.test(outcome.providerMessageId || '')) return;
  try {
    const db = require('../../models/db');
    await db('invoices')
      .where({ id: input.invoiceId, customer_id: input.customerId })
      .whereIn('status', ['paid', 'refunded'])
      .whereNull('payer_id')
      .whereNull('receipt_sms_sent_at')
      .update({ receipt_sms_sent_at: outcome.sentAt ? new Date(outcome.sentAt) : db.fn.now() });
  } catch (err) {
    // The provider already accepted. A missing fact keeps Quick Links
    // closed; it must never turn this delivery into a retry/double text.
    logger.warn(`[messaging] receipt SMS evidence failed for invoice ${input.invoiceId}: ${err.message}`);
  }
}

// Grouped unit-move hold for appointment notices (codex #3609 r30/r31).
// A visit mid-move (or stranded partial) stamps move_hold_until on its
// members' reminder rows; a notice rendered for the OLD slot must not
// reach the customer. Checked twice: at step 6.4 (early, audited block)
// and again inside the provider preSendCheck at the actual Twilio
// handoff — the provider's own internal awaits (redirect check, template
// lookup, customer/location query) are exactly the gap a mover can stamp
// into. Fail closed: callers treat MOVE_HOLD as a deferral (flags left
// unmarked, the sweep retries), so a held-on-blip notice is delayed,
// never lost.
const MOVE_HOLD_PURPOSES = ['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h'];
function appointmentMoveHoldApplies(input) {
  // enforceMoveHold: explicit opt-in for appointment-describing sends whose
  // purpose is outside the reminder set (the rain-out Quick Move notice —
  // codex r37): the text quotes a date/window, so a hold stamped mid-render
  // must block it exactly like a reminder.
  return !!input.appointmentId && (MOVE_HOLD_PURPOSES.includes(input.purpose) || input.enforceMoveHold === true);
}
async function appointmentMoveHeld(input) {
  // Delegates to THE shared guard (visit-groups.appointmentSendHeld — one
  // implementation with the appointment-email path, codex r47): live hold,
  // rendered-slot ABA comparison, and a hold RE-READ after the slot/visit
  // awaits. Fail closed inside the helper.
  return require('../visit-groups').appointmentSendHeld(input.appointmentId, Number.isFinite(input.renderedSlotMs) ? input.renderedSlotMs : null);
}

// Street-level address hold (GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL, owner ruling
// 2026-10-01): NO customer text, email or app message about a visit that is a live
// unconfirmed street-level hold goes out until the office confirms the address. This is the
// shared send step every visit-scoped customer message passes (appointmentId is the visit);
// appointment-email.js enforces the same predicate for the email sender. Fail closed: a
// lookup error holds the send (retryable — the hold clears when the office confirms).
const STREET_LEVEL_HOLD_BLOCK = Object.freeze({
  code: 'STREET_LEVEL_HOLD',
  reason: 'Visit is an address hold awaiting the office confirm',
});
// The visit a send is about: appointmentId, or (callers that thread only metadata, e.g. the
// card request) metadata.scheduled_service_id / scheduledServiceId. metadata.visit_id is a visit
// GROUP id and is not used.
function heldVisitIdOf(input) {
  return input.appointmentId || input.metadata?.scheduled_service_id || input.metadata?.scheduledServiceId || null;
}
// Every visit a send's BODY links to, resolved on the server from the text (composer-customer-links
// visitsLinkedInBody: reschedule, appointment, track, prep and card-request links, long or /l/ short). The
// body is the authority: a pasted link, a restored draft, a scheduled replay and an old composer tab carry
// no client metadata, yet reach the same customer. Memoized per input (the hold is asked twice, at 6.35 and
// at the provider boundary). A resolution error fails CLOSED like the hold predicate itself: it rejects, the
// caller treats it as held (retryable).
const bodyVisitLookups = new WeakMap();
function visitsLinkedInBodyOf(input) {
  if (!bodyVisitLookups.has(input)) {
    bodyVisitLookups.set(input, require('../composer-customer-links').visitsLinkedInBody(input.body));
  }
  return bodyVisitLookups.get(input);
}
// Every visit the send is about: the explicit ids (appointmentId, metadata.scheduled_service_id, and the
// composer's metadata.linked_scheduled_service_ids, kept as an additional input) plus the visits the body's
// own links resolve to.
async function heldVisitIdsOf(input) {
  const linked = Array.isArray(input.metadata?.linked_scheduled_service_ids) ? input.metadata.linked_scheduled_service_ids : [];
  const fromBody = typeof input.body === 'string' && input.body ? (await visitsLinkedInBodyOf(input)).map((v) => v.id) : [];
  return [...new Set([heldVisitIdOf(input), ...linked, ...fromBody].filter(Boolean).map(String))];
}
async function streetLevelHoldBlocksSend(input) {
  // Visit-scoped content is held whatever the generic audience classification says: a phone-only
  // composer send (a reschedule link inserted for a number whose owner was not adopted) and a shared-phone
  // scheduled send classify as 'lead' yet still carry a customer's visit link. Only staff-facing
  // audiences (internal briefings, admin, tech) are never about a customer's held visit.
  if (['internal', 'admin', 'tech'].includes(input.audience)) return false;
  // The card-on-file invitation the office-confirm hook itself sends (and its lazy-activation twin)
  // is part of releasing the hold: the hook runs before the confirmed stamp lands, and only after
  // the office approved the address (the activation guards refuse a hold otherwise).
  if (input.purpose === 'card_request' && input.metadata?.trigger === 'outbound_review_confirm') return false;
  let visitIds;
  try {
    visitIds = await heldVisitIdsOf(input);
  } catch (err) {
    logger.warn(`[send_customer_message] linked-visit lookup failed — holding the send: ${err.code || err.name || 'error'}`);
    return true;
  }
  if (!visitIds.length) return false;
  // Enforced from the DURABLE hold predicate regardless of the rollout gate: turning the gate off
  // stops NEW holds but never releases the customer messages of holds already open.
  const { isStreetLevelHoldVisit } = require('../street-level-hold');
  for (const visitId of visitIds) {
    if (await isStreetLevelHoldVisit(visitId)) return true;
  }
  return false;
}

// A hand-composed text replayed from the scheduled-SMS queue whose reschedule link points at a visit that
// can no longer be rescheduled (cancelled, skipped, completed, underway — the same status gate the
// /reschedule/:token page applies on click, reschedule-eligibility RESCHEDULABLE_STATUSES) is a stale link:
// end it blocked and say why, instead of sending it (a held visit that left the hold by cancelling is
// not a live hold any more, so the hold step alone would let it through). Scheduled replays of operator
// text only: every immediate send, and every automated notice, keeps its prior behavior.
const LINKED_VISIT_ENDED_BLOCK = Object.freeze({
  code: 'LINKED_VISIT_ENDED',
  reason: 'The visit this reschedule link points at is no longer reschedulable (cancelled, skipped or completed)',
});
// `fresh`: re-resolve the body's visits (no memo) — the provider-boundary recheck reads their LIVE status.
async function endedLinkedVisitBlocksSend(input, { fresh = false } = {}) {
  if (input.entryPoint !== 'scheduled_sms_cron' || input.metadata?.humanAuthored !== true) return false;
  if (['internal', 'admin', 'tech'].includes(input.audience) || typeof input.body !== 'string' || !input.body) return false;
  let linked;
  try {
    linked = fresh
      ? await require('../composer-customer-links').visitsLinkedInBody(input.body)
      : await visitsLinkedInBodyOf(input);
  } catch {
    // Step 6.36's memoized lookup already succeeded for the hold step, so an error here is the boundary's
    // fresh read failing: fail CLOSED (the caller defers retryably), never send on an unreadable visit.
    return fresh ? 'lookup_failed' : false;
  }
  const { RESCHEDULABLE_STATUSES } = require('../reschedule-eligibility');
  return linked.some((v) => v.rescheduleLink && v.status && !RESCHEDULABLE_STATUSES.has(String(v.status).toLowerCase()));
}

// callback_number_needed hold — keyed on the DESTINATION NUMBER (codex
// round 6 on PR #4807, structural). Rounds 2–5 keyed it on the visit
// (appointmentId / metadata.scheduled_service_id / metadata.visit_id), and
// every round found another sender with no visit context at all — estimate
// and invoice follow-ups text customers.phone, which for a call-created
// customer IS the number the caller disclaimed. The check now reads
// disclaimed_number_holds for the send's own `to`, so it covers EVERY SMS
// this pipeline sends regardless of what metadata the caller threads.
// Checked at step 6.45 (audited block) AND again inside
// providerPreparationCheck at the provider handoff (round-6 P1: a hold
// committed during preDispatchCheck or the provider's own async
// preparation must still stop the send). twilio.js's sendSMS dispatch()
// runs the same predicate once more as its LAST await before
// messages.create() — on the caller's handoff transaction when there is
// one — which is also what covers the legacy callers that reach sendSMS
// without this pipeline. SMS only — push never dials the number. Fails
// CLOSED (see disclaimed-number-holds.js).
const CALLBACK_NUMBER_HOLD_BLOCK = Object.freeze({
  ok: false,
  code: 'CALLBACK_NUMBER_HOLD',
  reason: 'Caller disclaimed this number (callback_number_needed)',
  // Durable-but-liftable (the office resolving the callback card clears
  // it) — a retryable miss, never a permanent suppression.
  retryable: true,
});
async function callbackNumberHoldBlocksSend(input) {
  if (input.channel !== 'sms') return false;
  return require('../disclaimed-number-holds').disclaimedNumberBlocksSend({ to: input.to });
}

// Annual-offer delivery guard (delivery-guards slice, re-cut of #4569): no
// sender rechecks annual-plan eligibility itself — it passes estimateId(s)
// through to this send library. Codex round 3 on #4608 (structural move,
// P1 PRRT_kwDOR3YQi86j8Ydm): the AUTHORITATIVE check now lives one layer
// further down, inside services/twilio.js's sendSMS — the true provider
// boundary, run from INSIDE whatever locked withSmsHandoff a caller
// supplies, immediately before messages.create(). This call stays only as
// an early, cheap refusal: it runs before the provider preparation hook's
// other rechecks (suppression, consent, window) and before any lock is acquired,
// so an already-withheld send fails fast without the cost of getting that
// far — but it is NOT the last word; twilio.js re-derives and re-verdicts
// fresh, after the lock, right before the SDK call, and that is the check
// that actually decides whether the SMS goes out.
function annualOfferGuardEstimateIds(input) {
  if (Array.isArray(input.estimateIds) && input.estimateIds.length) return input.estimateIds;
  return input.estimateId ? [input.estimateId] : [];
}
// Codex round 1 on #4608 (P1): keying this ONLY on a caller-supplied
// estimateId made the guard opt-in — a composer manual SMS whose body
// carries a minted estimate link, and the estimate-public.js service-
// details email, never passed one and sailed straight past it. Always run
// the guard (never short-circuit on 'no explicit ids') and let it derive
// the estimate from the final message body/content itself — estimate-
// annual-guard.js's estimateIdsFromContent runs no query at all when
// neither an explicit id nor a link is present, so this costs nothing on
// the vast majority of sends that carry no estimate content whatsoever.
async function annualOfferGuardVerdict(input, trx) {
  try {
    const { annualHandoffGuard } = require('../estimate-annual-guard');
    // Codex r2 P1: reuse the caller's locked transaction when one is
    // supplied (the billing-email boundary check below, inside
    // withCustomerCommsLock) instead of opening a second root-pool
    // connection for this same read while that lock is held.
    const db = trx || require('../../models/db');
    const verdict = await annualHandoffGuard({
      db, estimateIds: annualOfferGuardEstimateIds(input), texts: [input.body],
    })();
    return verdict.blocked
      ? { ok: false, code: 'ANNUAL_OFFER_WITHHELD', reason: 'annual_offer_withheld', retryable: false }
      : { ok: true };
  } catch (err) {
    // Fail closed — an infrastructure error here must block the send, never
    // silently allow it through as though the offer were unaffected.
    return { ok: false, code: err?.code || 'ANNUAL_OFFER_GUARD_FAILED', reason: err?.message || 'annual offer guard failed', retryable: true };
  }
}

function nextProviderRetryAt(providerOutcome, now = new Date()) {
  if (!providerOutcome || !providerOutcome.retryable) return null;
  if (providerOutcome.nextAllowedAt) {
    const explicit = new Date(providerOutcome.nextAllowedAt);
    if (!Number.isNaN(explicit.getTime())) return explicit;
  }
  const delayMs = Number.isFinite(providerOutcome.retryAfterMs)
    ? Math.max(0, providerOutcome.retryAfterMs)
    : DEFAULT_PROVIDER_RETRY_DELAY_MS;
  return new Date(now.getTime() + delayMs);
}

/**
 * The single source of truth for "did this attempt definitely NOT reach the
 * customer" — derived from this module's own closed outcome vocabulary
 * rather than left to each caller's own reading of `blocked`.
 *
 * The contract (enforced end to end: twilio-sms.js's DELIVERY_OUTCOMES set
 * plus explicitDeliveryOutcome, which collapses anything not in it to
 * 'uncertain' before a value ever reaches a caller):
 *
 *   deliveryOutcome: 'accepted'   -> definitely SENT.
 *   deliveryOutcome: 'not_sent'   -> definitely NOT SENT, independent of
 *                                    `blocked` — a pipeline/validator
 *                                    refusal, a disabled template, the
 *                                    owner-silence kill switch (which also
 *                                    sets `sent: true` for its own
 *                                    accounting — `sent` answers a
 *                                    different question than
 *                                    deliveryOutcome; only deliveryOutcome
 *                                    says whether the customer's carrier
 *                                    was ever asked), or a definitive
 *                                    provider rejection (a synchronous
 *                                    Twilio error isDefinitiveTwilioRejection
 *                                    recognizes) are all tagged this way,
 *                                    whether or not `blocked` is set.
 *   deliveryOutcome: 'uncertain'  -> UNKNOWN — the SDK handoff was crossed
 *                                    (or a push attempt may still be in
 *                                    flight: appPending/appRetryable/
 *                                    APP_DELIVERY_HOLD tag 'uncertain' even
 *                                    though `blocked` is also true there)
 *                                    with no definitive verdict either way.
 *   missing/malformed value        -> UNKNOWN, EXCEPT one gap this
 *                                    contract does not close: withSendLock's
 *                                    own LOCK_BUSY / PROMISED_LINK_IN_PROGRESS
 *                                    objects (reschedule-link-promises.js)
 *                                    return straight out of
 *                                    sendCustomerMessage() before
 *                                    sendCustomerMessageCore ever tags a
 *                                    deliveryOutcome — for exactly that one
 *                                    untagged shape, `blocked === true` is
 *                                    the only signal available and is known
 *                                    to mean NOT SENT (sendCore was never
 *                                    invoked). An explicit deliveryOutcome,
 *                                    when present, always overrides this
 *                                    fallback.
 *
 * Nothing in this vocabulary is actually ambiguous once deliveryOutcome is
 * read directly: every blocked:true shape that could still mean "maybe
 * reached the provider" (the push in-flight/retry shapes) tags 'uncertain'
 * explicitly rather than leaving deliveryOutcome unset.
 *
 * @param {{ deliveryOutcome?: string, blocked?: boolean } | null | undefined} outcome
 *   A sendCustomerMessage() result, or a thrown error's own
 *   `.providerOutcome` (sendCustomerMessageCore tags every throw with the
 *   provider outcome it had observed, or the pre-dispatch 'not_sent'
 *   default when the throw happened before dispatch ever ran).
 * @returns {'sent' | 'not_sent' | 'unknown'}
 */
function classifyDeliveryCertainty(outcome) {
  if (!outcome) return 'unknown';
  if (outcome.deliveryOutcome === 'accepted') return 'sent';
  if (outcome.deliveryOutcome === 'not_sent') return 'not_sent';
  if (outcome.deliveryOutcome === 'uncertain') return 'unknown';
  if (outcome.blocked === true) return 'not_sent';
  return 'unknown';
}

// Purposes whose SMS/App notices are billing follow-up (pay / update-card link or a
// charge announcement) and so wait out an active collections dispute hold.
const HOLD_GATED_MESSAGE_PURPOSES = Object.freeze(['payment_failure', 'autopay']);

// The machine-initiated dunning senders (Day 3-90 invoice follow-up ladder, late-payment checker,
// balance reminder workflow, previsit balance reminder) send under the shared purposes
// 'payment_link' / 'billing', which the invoice sender, an operator's project payment link and
// the price-change notice also use - so they are recognised by their entry point
// (collection-hold HOLD_GATED_DUNNING_ENTRY_POINTS), not by purpose alone.
// A queued replay (every deferred row replays under entry point scheduled_sms_cron) of a dunning
// text whose purpose is the shared 'payment_link': the follow-up ladder's quiet-hours requeue. Its
// registry recheck reads the hold before dispatch; this is the boundary read for a hold that commits
// after it (Codex #5424 r14). The other gated queued rows replay under a gated purpose already.
const HOLD_GATED_REPLAY_ORIGINS = Object.freeze(['invoice_followup_deferred']);
function isHoldGatedBillingMessage(input = {}) {
  if (input.audience !== 'customer' || !input.customerId) return false;
  if (HOLD_GATED_MESSAGE_PURPOSES.includes(input.purpose)) return true;
  if (input.entryPoint === 'scheduled_sms_cron'
    && HOLD_GATED_REPLAY_ORIGINS.includes(String(input.metadata?.original_entry_point || ''))) return true;
  return require('../collections/collection-hold').HOLD_GATED_DUNNING_ENTRY_POINTS.has(String(input.entryPoint || ''));
}

// The ONE gated hold predicate (round-11 P1, structural): run at step 1.5 AND again inside
// providerPreparationCheck, the last pre-provider callback, so a dispute committed during the
// policy / contact / consent / caller-check awaits (or any pre-work added later) still stops the
// send. Returns null (send may proceed) or the coded WAIT verdict. Exemptions live here, once: a
// customer's own action (customerInitiated / holdExempt 'customer') and a deliberate operator send
// (holdExempt 'operator') skip a plain dispute hold only - a fallback hold still waits; a lookup
// failure answers held (fail closed).
// `database` is the provider handoff's held transaction when the final-boundary re-check runs inside
// one (providerPreparationCheck's `handoffDb`): the read MUST reuse that connection (a savepoint read),
// never open a root-pool one - at DB_POOL_MAX=2 a second connection waiting on the locks the handoff
// holds would deadlock the send against its own pool (Codex #5424 r13 P1). Undefined = the root pool.
// The exemptions skip a plain DISPUTE hold only: a wrong-number / wrong-party fallback hold (an
// all-channel outreach block) still stops the notice.
async function billingHoldBlock(input = {}, database = undefined) {
  const collectionHold = require('../collections/collection-hold');
  if (!isHoldGatedBillingMessage(input)) return null;
  const ignoreDisputeHold = input.customerInitiated === true || collectionHold.holdExemptionApplies(input.holdExempt);
  const held = await collectionHold.messagingHeldByCollectionHold(input.customerId, database, { ignoreDisputeHold });
  if (!held.held) return null;
  logger.info(`[send_customer_message] billing notice (${input.purpose}${input.entryPoint ? `/${input.entryPoint}` : ''}) suppressed for customer ${input.customerId}: collections dispute hold${held.reason === 'lookup_failed' ? ' (lookup failed - fail closed)' : ''}`);
  // ONE hold outcome everywhere (Codex #5424 r14): the retryable, deferred COLLECTION_HOLD_DEFER
  // shape with nextAllowedAt. A queued replay (scheduler, registry, email retry rails) treats it as
  // a wait and refunds the attempt; a caller that must not retry (the immediate completion text)
  // reads it through collectionHold.isHoldSuppression and decides itself.
  return { ok: false, ...collectionHold.holdDeferOutcome(held) };
}

function isAutopayCustomerSms(input = {}) {
  if (input.channel !== 'sms') return false;
  if (!['customer', 'lead'].includes(input.audience)) return false;

  const originalMessageType = String(input.metadata?.original_message_type || '').toLowerCase();
  const entryPoint = String(input.entryPoint || '').toLowerCase();
  return input.purpose === 'autopay'
    || originalMessageType.startsWith('autopay_')
    || entryPoint.startsWith('autopay_');
}

function checkAutopayCustomerSmsGate(input) {
  if (!isAutopayCustomerSms(input)) return { ok: true };
  if (isEnabled('autopayCustomerSms')) return { ok: true };
  return {
    ok: false,
    code: 'AUTOPAY_CUSTOMER_SMS_DISABLED',
    reason: 'AutoPay customer SMS is disabled',
  };
}

/**
 * Normalize a phone string to E.164 (best-effort). Mirrors the existing
 * twilio.js normalizePhone. Exported for delivery claims so reconciliation
 * uses exactly the same destination as dispatch.
 */
function normalizeRecipient(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  // Fall back to the input if we can't confidently normalize — twilio
  // will reject malformed numbers downstream and we'll log the failure.
  return trimmed;
}

/**
 * @param {SendCustomerMessageInput} input
 * @returns {Promise<{
 *   sent: boolean,
 *   blocked: boolean,
 *   reason?: string,
 *   code?: string,
 *   retryable?: boolean,
 *   deferred?: boolean,
 *   deliveryOutcome: 'accepted' | 'not_sent' | 'uncertain',
 *   nextAllowedAt?: string,
 *   providerMessageId?: string,
 *   sentAt?: string,
 *   auditLogId?: string | null,
 *   segmentCount?: number,
 *   encoding?: 'GSM_7' | 'UCS_2',
 * }>}
 */
async function sendCustomerMessage(input) {
  // The feature's canonical compound gate (this delivery gate AND
  // GATE_CALL_COMMITMENTS); live mode only — shadow observes, it never locks.
  const promises = require('../reschedule-link-promises');
  if (promises.mode() === 'true') {
    return promises.withSendLock(input, (lockedInput) => sendCustomerMessageCore(lockedInput));
  }
  return sendCustomerMessageCore(input);
}

async function sendCustomerMessageCore(input) {
  let providerOutcome = { sent: false, deliveryOutcome: 'not_sent' };
  let providerHandoffReservation = null;
  // Short codes the SMS link wrap put in THIS attempt's body (stamped to the
  // sms_log row in the finally below once the send is accepted).
  let wrappedLinkCodes = [];
  try {
  // 1. Contract validation
  const contractCheck = validateContract(input);
  if (!contractCheck.ok) {
    logger.warn(`[send_customer_message] contract violation: ${contractCheck.reason}`);
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CONTRACT_VIOLATION', reason: contractCheck.reason };
  }

  // 1.5 Collections DISPUTE hold (owner ruling 2026-09-30): a payment-failure notice carries
  // a pay / update-card link and is billing follow-up the customer was told is on hold. The
  // billing-cron attempts, the Stripe webhook notices and every other live payment_failure
  // sender reach the provider through here, so the live hold check sits at this one boundary
  // (the accepted millisecond window of collection-hold.js: no cross-writer locking). Suppress
  // - never queue: dunning after the release covers it; the retry row stays as it is. Fail
  // closed on an unverifiable hold. A notice for a payment the customer just made themselves
  // (customerInitiated) is not follow-up and is exempt.
  // The machine-initiated 'autopay' purpose is the same follow-up: the card-expiry sweeps
  // (autopay-notifications, workflows/payment-expiry) text an update-card portal link and the
  // pre-charge reminder announces a charge the hold has stopped. Every purpose-'autopay'
  // sender is a cron sweep; a customer-driven autopay notice would carry customerInitiated.
  // The machine-initiated DUNNING senders (isHoldGatedBillingMessage: the follow-up ladder, the
  // late-payment and balance reminders, the previsit balance reminder) are the same follow-up:
  // their preflight consulted the hold minutes earlier, but they await credit application, link
  // shortening, ledger writes and rendering before reaching here, so a hold placed in between
  // stops the send at this boundary. The suppression is a WAIT: every caller keeps the touch due
  // (no failed row, nothing paused) and it goes out after the release. Exempt: a customer's own
  // action (customerInitiated / holdExempt 'customer') and a deliberate operator send
  // (holdExempt 'operator', e.g. the office "send now" button); payer-billed invoices never reach
  // these senders (they pause or skip before sending).
  const heldBlock = await billingHoldBlock(input);
  if (heldBlock) {
    const { ok: _heldOk, ...heldOutcome } = heldBlock;
    return { sent: false, blocked: true, ...heldOutcome };
  }

  // 2. Resolve policy
  let policy;
  try {
    policy = policyModule.resolvePolicy(input.audience, input.purpose);
  } catch (err) {
    logger.warn(`[send_customer_message] unknown policy: ${err.message}`);
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNKNOWN_POLICY', reason: err.message };
  }

  // 3. Normalize recipient + clone input so downstream sees the canonical
  //    form. Caller closures stay outside message state and audit payloads.
  const {
    preDispatchCheck,
    preProviderCheck,
    preSendCheck,
    providerPreSendCheck: suppliedProviderPreSendCheck,
    onDispatchStart,
    onDispatchAbort,
    // codex #5196 r4 P2: same shape as onDispatchAbort, fired instead when
    // twilio.js's own messages.create() throws a definitive rejection —
    // the phone lock is still held at that point (onDispatchAbort's own
    // comment explains why).
    onDispatchRejected,
    // codex #5018 structural fix (post-r7): opts a caller's sms_log insert
    // INTO the handoff transaction (twilio.js's dispatch() reads this same
    // option). Threaded unchanged, alongside onDispatchStart/onDispatchAbort/
    // onDispatchRejected, through dispatchToProvider -> providers/twilio-sms.js -> twilio.js.
    // Omitted (the default for every caller that doesn't name it), twilio.js
    // falls back to origin/main's own post-handoff, out-of-transaction insert.
    logInHandoff,
    withSmsHandoff: suppliedSmsHandoff,
    withProviderHandoff,
    // Invoice-send-via-SMS's explicit billing Email leg only (see
    // billingEmailLeg below): the invoice claim/visit/ownership/balance
    // check withProviderHandoff runs for SMS/App, composed instead into
    // providerPreparationCheck and run under the Email authority's OWN lock
    // — withProviderHandoff itself is never invoked for this leg (see
    // dispatchProvider below), so it never takes this handoff's lock on the
    // same invoice row the authority already holds on a different connection.
    billingEmailPreSendCheck,
    providerHandoffReservation: suppliedProviderHandoffReservation,
    ...inputRest
  } = input;
  const providerCoordination = require('./provider-handoff-reservation');
  if (require('../sms-gratitude-context').gratitudeClaimsPossible()
    && providerCoordination.isProviderHandoffHandle(suppliedProviderHandoffReservation)) {
    providerHandoffReservation = suppliedProviderHandoffReservation;
  }
  const normalizedTo = normalizeRecipient(input.to);
  const sendInput = { ...inputRest, to: normalizedTo };
  // Request lifecycle email companions have no text leg. Keep their App
  // intent even when the saved choice or gate changes before dispatch.
  if (sendInput.metadata?.appOnly === true || sendInput.metadata?.billingDeliveryLeg === 'push') sendInput.channel = 'push';
  // Recursive explicit App routing selects its leg before hook validation.
  const previsitAppLeg = input.entryPoint === 'previsit_balance_reminder' && sendInput.channel === 'push';
  const withSmsHandoff = previsitAppLeg ? null : suppliedSmsHandoff;
  const providerPreSendCheck = previsitAppLeg ? undefined : suppliedProviderPreSendCheck;
  // The locked handoff holds a caller's authority rows through the actual
  // provider request. Immediate lead replies and the visit-summary bearer
  // link (its immediate send and its scheduled replay), plus promised
  // reschedule links, are the callers whose authority may change between
  // validation and the handoff.
  const smsHandoffAllowed = (input.audience === 'lead' && input.purpose === 'conversational'
      && ['lead_response_auto_reply', 'lead_webhook_auto_reply'].includes(input.entryPoint))
    || (input.audience === 'customer' && input.purpose === 'service_completion'
      && input.metadata?.original_message_type === 'visit_summary'
      && ['visit_closeout_summary', 'scheduled_sms_cron'].includes(input.entryPoint))
    // A review ask that follows a combined-visit summary shares that
    // summary's packet row through the request.
    || (input.audience === 'customer' && input.purpose === 'review_request'
      && ['review_request_send', 'review_outreach_touch'].includes(input.entryPoint))
    || (input.audience === 'customer' && input.purpose === 'appointment'
      && input.entryPoint === 'reschedule-link-promise'
      && input.metadata?.original_message_type === 'reschedule_link_promise'
      && Boolean(input.metadata?.followThroughCommitmentId))
    // Legacy previsit balance Text keeps its current automatic App routing,
    // but an actual Twilio leg holds the complete balance quote through the
    // provider request. The producer supplies no preSendCheck; its final
    // predicate is providerPreSendCheck on the held transaction.
    || (input.audience === 'customer' && input.purpose === 'billing'
      && input.entryPoint === 'previsit_balance_reminder'
      && typeof providerPreSendCheck === 'function')
    // Recruiting texts hold the application row through the provider
    // request: the deferred replay (deferred-replay-registry
    // recruiting_comms_deferred) and the immediate sends (recruiting-comms.js
    // lockedRecruitingHandoff — Codex #4623 r19 P1) alike.
    || (input.audience === 'applicant'
      && /^job_/.test(String(input.metadata?.original_message_type || '')))
    // Gratitude owns an existing auto-send reservation and holds the shared
    // thread lock through its final predicate and provider request. This is
    // the one customer-conversational lane allowed to supply that handoff.
    || (input.audience === 'customer' && input.purpose === 'conversational'
      && input.entryPoint === 'sms_auto_send_executor'
      && input.metadata?.original_message_type === 'ai_gratitude'
      && Boolean(input.metadata?.agentDecisionId)
      && typeof providerPreSendCheck === 'function')
    // The delayed booking-link follow-up (call-booking-link-text.js, codex
    // #5018 r11 P1): a lead with no customer row yet, so there is no
    // customer-comms lock to hold — only the phone-lock leg (matching the
    // STOP writer's own lockSmsPhone) applies. Suppression/consent reload
    // under that lock, then the lane's own providerPreSendCheck (its mutable
    // never-send checks) re-runs on the SAME held connection right after.
    || (input.audience === 'lead' && input.purpose === 'missed_call_followup'
      && input.entryPoint === 'call_booking_link_text'
      && typeof providerPreSendCheck === 'function')
    // Manual Leads-page compose (admin-leads.js POST /:id/send-sms, codex
    // #5018 r15 P2): staff can type any message, a manual consultation
    // link included — the SAME phone lock the automated lane above takes
    // serializes the two so a concurrent worker's own delivered-link check
    // and this send can't interleave. Either audience, since the route
    // resolves 'customer' when the lead's own linked customer owns this
    // exact phone, 'lead' otherwise — manual semantics are unconditional
    // either way, so no providerPreSendCheck requirement here.
    || (['lead', 'customer'].includes(input.audience) && input.purpose === 'conversational'
      && input.entryPoint === 'admin_leads_send_sms')
    // Communications composer sends (admin-communications.js POST /sms,
    // codex #5018 pre-push P2): the SAME shape and reason as the manual
    // Leads-page compose above — a consultation link can ride this
    // composer's body too, racing the SAME worker's own delivered-link
    // check. Covers both purposes this ONE route's sendMessage ever emits
    // (card_request when the composer carries a visit's card-request link,
    // conversational otherwise) — applied to every composer SMS from this
    // route, not only consultation-carrying ones, since it is a phone lock
    // only and manual semantics are unconditional either way.
    || (['lead', 'customer'].includes(input.audience)
      && ['conversational', 'card_request'].includes(input.purpose)
      && input.entryPoint === 'admin_communications_manual_sms')
    // The estimate page's "text me the packet" send (estimate-public.js
    // POST /:token/service-details/send, B01): a bearer-token page whose
    // recipient can be a stranger's wrong number, so the phone lock (the STOP /
    // wrong-number writers' own lockSmsPhone) is held through the provider
    // request, and for a customer-backed estimate the customer-comms lock too
    // (the sms_enabled writer's lock, taken first). Suppression and consent
    // reload under them and fail closed. A lead has no customer row: phone only.
    || (['lead', 'customer'].includes(input.audience) && input.purpose === 'estimate_followup'
      && input.entryPoint === 'estimate_service_details_send'
      && input.metadata?.original_message_type === 'estimate_service_details');
  if (withSmsHandoff && (typeof withSmsHandoff !== 'function' || sendInput.channel !== 'sms' || !smsHandoffAllowed)) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_SMS_HANDOFF', reason: 'Locked SMS handoff is not allowed for this message' };
  }
  if (typeof preSendCheck === 'function' && withSmsHandoff) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_SEND_GUARD_COMBINATION',
      reason: 'A caller pre-send check cannot be combined with a locked SMS handoff' };
  }
  // Invoice delivery needs one lock boundary that covers whichever provider
  // the canonical router actually chooses (push-first, push+SMS, or Twilio).
  // Keep this narrowly scoped to the invoice-send entry point and its queued
  // replay (the scheduler replays invoice_send_deferred rows under the
  // invoice lock too — deferred-replay-registry.js): other callers use the
  // stronger recipient/consent handoffs above, whose transaction is also
  // threaded into their fresh suppression reads.
  const invoiceDeliveryEntry = input.entryPoint === 'invoice_send_via_sms'
    || (input.entryPoint === 'scheduled_sms_cron'
      && input.metadata?.original_entry_point === 'invoice_send_deferred');
  const providerHandoffAllowed = input.audience === 'customer'
    && (sendInput.channel === 'sms' || (sendInput.channel === 'push' && input.metadata?.billingDeliveryLeg === 'push'))
    && input.purpose === 'payment_link'
    && invoiceDeliveryEntry;
  // The SAME invoice-send entry point's explicit billing Email leg (a
  // customer selection of Email, fanned out by dispatchBillingChannels)
  // never takes withProviderHandoff — that handoff's own
  // withInvoiceDepositSettlement lock would deadlock against the Email
  // authority's own lock on the same invoice row (billing-channel-email-
  // authority.js, a different connection). It gets the SAME invoice
  // preconditions a different way instead: billingEmailPreSendCheck, run
  // under the authority's own lock (see providerPreparationCheck below).
  // A caller on this leg with no such check is refused exactly like any
  // other unsupported handoff — never silently dropped to "no invoice
  // check at all".
  const billingEmailLeg = input.audience === 'customer'
    && sendInput.channel === 'email'
    && input.metadata?.billingDeliveryLeg === 'email'
    && input.purpose === 'payment_link'
    && invoiceDeliveryEntry;
  if (withProviderHandoff && !billingEmailLeg
    && (typeof withProviderHandoff !== 'function' || !providerHandoffAllowed || withSmsHandoff)) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_PROVIDER_HANDOFF',
      reason: 'Locked provider handoff is restricted to invoice delivery' };
  }
  if (billingEmailLeg && typeof billingEmailPreSendCheck !== 'function') {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_PROVIDER_HANDOFF',
      reason: 'Billing Email delivery requires an invoice pre-send check' };
  }
  // SMS link schemes are removed before audit counting, matching the final
  // Twilio boundary for direct callers.
  // Typographic punctuation (curly quotes, em dashes, real ellipses) forces
  // the whole body into UCS-2 — 67 chars/segment instead of 153 — silently
  // multiplying segment count, and multi-segment texts have failed to reach
  // handsets that still ACK delivery. Normalizing at this choke point covers
  // every source at once: templates, hardcoded builders, interpolated
  // variables, AI drafts, and manual admin sends. Before countSegments so
  // the audit row records what actually goes to the provider.
  // Customer/lead audiences ONLY: internal briefings (audience 'internal')
  // are redirected to bell/push inside TwilioService.sendSMS, where GSM
  // encoding is irrelevant and bullets/punctuation must stay verbatim —
  // internal bodies that DO continue to Twilio are normalized at that
  // boundary instead, after the redirect check. Media sends (MMS) are also
  // exempt: MMS is not segment-encoded, so rewriting a human-authored
  // caption buys nothing. The exemption uses the provider's OWN
  // authorization predicate — unauthorized media URLs are dropped by the
  // provider and the message goes out as plain SMS, so it must be
  // normalized here or the audit row's body/segment metadata would
  // disagree with what was delivered.
  const sendHasMedia = Array.isArray(sendInput.metadata?.mediaUrls)
    && sendInput.metadata.mediaUrls.length > 0
    && mediaUrlsAllowed(sendInput);
  if (sendInput.channel === 'sms' && typeof sendInput.body === 'string'
    && ['customer', 'lead', 'applicant'].includes(sendInput.audience) && !sendHasMedia) {
    sendInput.body = normalizeGsmPunctuation(stripSmsUrlScheme(sendInput.body));
  }

  // Round 8 P1: mirrors email's withheldLinkPolicy 'rewrite' (estimate-
  // deposits.js's deposit.receipt) for SMS — the deposit receipt text
  // carries the SAME estimate link and the guard's default REFUSE would
  // deny proof of payment for an offer that changed state after the
  // deposit, not before it. Unlike email (where the guard — and any
  // rewrite — runs at the actual sendgrid.sendOne dispatch), the stored
  // sms_log body and segment count are both computed HERE, well before the
  // authoritative provider-boundary guard (services/twilio.js dispatch())
  // ever runs — so the rewrite must happen here too, before segmentMeta
  // and before any snapshot, or the stored/counted body would disagree
  // with what Twilio actually sends. Text-only (rewriteWithheldEstimateLinks
  // accepts html as undefined) since SMS has no html leg.
  //
  // Round 11 structural fix (P1, pre-push audit on 029ae44d53): the policy
  // is resolved HERE from the message's own purpose/message-type via
  // withheldLinkPolicyForSmsPurpose — the SAME place both an immediate
  // send AND a scheduled retry/requeue of it pass through — rather than
  // relying on each caller to pass an explicit withheldLinkPolicy. A
  // scheduled-SMS replay (scheduler.js) carries no explicit policy of its
  // own; without this it would refuse a retried deposit receipt instead of
  // rewriting it, exactly like the email retry sweep before sendOne
  // resolved its policy from templateKey. An explicit sendInput.
  // withheldLinkPolicy still wins when a caller passes one.
  //
  // Clearing estimateId/estimateIds here (not just leaving content
  // derivation to find nothing) matches the email mechanism's own
  // sendEstimateIds = [] override: an explicit id surviving past the
  // rewrite would still union into the boundary guard's check and refuse
  // a body that no longer carries the link at all, defeating the rewrite.
  // AnnualGuard.withheldLinkPolicyForSmsPurpose is cheap (a Set lookup) —
  // resolved unconditionally so the channel/body-type check below stays a
  // single flat condition instead of an extra nested if.
  const AnnualGuard = require('../estimate-annual-guard');
  const resolvedSmsWithheldLinkPolicy = sendInput.withheldLinkPolicy
    || AnnualGuard.withheldLinkPolicyForSmsPurpose(sendInput.purpose, sendInput.metadata?.original_message_type);
  let withheldLinksRewritten;
  if (sendInput.channel === 'sms' && typeof sendInput.body === 'string'
    && resolvedSmsWithheldLinkPolicy === 'rewrite') {
    try {
      const { rewriteWithheldEstimateLinks } = AnnualGuard;
      const db = require('../../models/db');
      const rewritten = await rewriteWithheldEstimateLinks({ db, text: sendInput.body });
      // Pre-push audit P1: the rewrite policy means "never refuse this
      // message on the estimate's account, only strip its links" — so the
      // explicit id is dropped whether or not a link was found. A link-free
      // receipt for a withheld estimate must still go out.
      sendInput.estimateId = null;
      sendInput.estimateIds = [];
      if (rewritten.rewrittenIds.length) {
        sendInput.body = rewritten.text;
        withheldLinksRewritten = rewritten.rewrittenIds;
        logger.warn(`[send_customer_message] rewrote ${rewritten.rewrittenIds.length} withheld estimate link(s) to the portal home for purpose=${sendInput.purpose}`);
      }
    } catch (err) {
      // Fail OPEN to the unrewritten body, never fail the send outright —
      // the authoritative boundary guard (twilio.js dispatch()) still runs
      // on whatever body reaches it and fails CLOSED (refuses) on its own
      // lookup error, so a rewrite-lookup hiccup degrades to "refused this
      // one time", never to "sent the raw withheld link".
      logger.warn(`[send_customer_message] withheld-link rewrite failed for purpose=${sendInput.purpose}: ${err.message}`);
    }
  }

  // 4. Load contact state once (consent + suppression share the lookup)
  let contactState = await loadContactState(sendInput);
  const suppressionInput = !sendInput.to && sendInput.metadata?.billingDeliveryLeg
    && String(contactState.customer?.id) === String(sendInput.customerId)
    ? { ...sendInput, to: contactState.customer.phone || null }
    : sendInput;
  contactState = await loadSuppressionState(suppressionInput, contactState);
  if (!suppressionInput.to && sendInput.metadata?.billingDeliveryLeg) contactState.suppressionLoaded = true;
  const BillingRouting = require('./billing-channel-routing');
  const { explicitBillingChannels } = require('../billing-delivery-channels');
  const billingCategory = BillingRouting.billingDeliveryCategory(sendInput);
  if (!sendInput.metadata?.billingDeliveryLeg && !contactState.lookupFailed
    && BillingRouting.usesBillingDeliveryPreferences(sendInput, contactState)
    && explicitBillingChannels(contactState.prefs, billingCategory) !== null) {
    // Codex r2 P1: carry the withheld-link rewrite's transformed receipt
    // state (rewritten body + cleared estimateId/estimateIds — the
    // SMS-shaped pass above) into every fanned-out leg, not just this
    // SMS-shaped call. dispatchBillingChannels still fans out the ORIGINAL
    // caller `input` — never sendInput wholesale — so a caller's
    // withProviderHandoff/preSendCheck/preDispatchCheck/withSmsHandoff hooks
    // (stripped out of sendInput above) still reach each per-leg recursive
    // sendCustomerMessageCore call exactly as before; only the transformed
    // receipt fields are merged in. Without this, the recursive App leg
    // (channel 'push') never gets the rewrite and the original estimateId
    // reaches annualOfferGuardVerdict, refusing an owed receipt when its
    // offer is withheld.
    return BillingRouting.dispatchBillingChannels(
      { ...input, body: sendInput.body, estimateId: sendInput.estimateId, estimateIds: sendInput.estimateIds },
      contactState.prefs, sendCustomerMessageCore,
    );
  }
  if (!sendInput.to && !sendInput.metadata?.billingDeliveryLeg
    && BillingRouting.isBillingDeliveryCandidate(sendInput)) {
    return {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'MISSING_BILLING_RECIPIENT',
      reason: 'Billing delivery requires an explicit Email, Text, or App selection when no phone recipient is available',
    };
  }
  const PushRouting = require('./push-channel-routing');
  if (await PushRouting.wantsAppFirst(sendInput)) {
    if (!validateNoCustomerEmoji({ ...sendInput, channel: 'push' }, policy).ok) {
      const fallback = await sendCustomerMessage({ ...input, channel: 'sms', metadata: {
        ...input.metadata, requestedChannel: 'push', appFallbackReason: 'push_body_unsupported',
      } });
      return { ...fallback, requestedChannel: 'push', fallbackReason: 'push_body_unsupported' };
    }
    sendInput.channel = 'push';
    sendInput.metadata = {
      ...sendInput.metadata, requestedChannel: 'push',
      notificationEventKey: sendInput.metadata?.notificationEventKey
        || (sendInput.invoiceId ? `invoice:${sendInput.invoiceId}:${sendInput.purpose}`
          : `${sendInput.purpose}:${sendInput.appointmentId || sendInput.estimateId || sendInput.customerId}:${require('crypto').createHash('sha256').update(sendInput.body).digest('hex')}`),
    };
  }


  // 5. Run validator pipeline. Each entry is { name, fn }; fn is invoked
  //    with (input, policy, contactState).
  // GATE_SMS_LINK_WRAP: every portal link in a customer/lead SMS becomes a
  // tracked /l/<code> short link (sms-link-wrap.js). Here — after the
  // withheld-link rewrite, the app/billing routing and every earlier body
  // transform, immediately before countSegments — so the audit row, segment
  // count and the text that goes out all describe the SAME wrapped body. Never
  // blocks: any failure inside keeps the original link.
  if (sendInput.channel === 'sms') {
    try {
      const linkWrap = await require('./sms-link-wrap').wrapPortalLinks({
        body: sendInput.body,
        channel: sendInput.channel,
        audience: sendInput.audience,
        purpose: sendInput.purpose,
        hasMedia: sendHasMedia,
        customerId: sendInput.customerId,
        leadId: sendInput.leadId,
      });
      if (linkWrap.codes.length) {
        sendInput.body = linkWrap.body;
        wrappedLinkCodes = linkWrap.codes;
      }
    } catch (err) {
      logger.warn(`[send_customer_message] SMS link wrap failed, body unchanged: ${err?.name || 'error'}`);
    }
  }

  const segmentMeta = countSegments(sendInput.body || '');
  const pipeline = [
    { name: 'require_input_ids',          fn: () => validateRequiredIds(sendInput, policy) },
    // Send window IMMEDIATELY after the pure input check (codex r26): the
    // window verdict must never be masked by a DB-dependent validator's
    // fail-closed result. A transient contact-state failure at 21:00 used
    // to surface CONSENT_LOOKUP_FAILED instead of QUIET_HOURS_HOLD, and
    // one-shot callers (Stripe billing notices) queue only on the hold —
    // they'd log the consent failure and lose the notice permanently. No
    // consent answer is needed tonight anyway: the row queues, and the
    // morning replay re-runs this whole pipeline — suppression, consent,
    // compliance — against CURRENT state before dispatch.
    { name: 'check_send_window',          fn: () => checkSendWindow(sendInput, policy, contactState) },
    { name: 'check_suppression',          fn: () => checkSuppression(sendInput, policy, contactState) },
    { name: 'check_consent_for_purpose',  fn: () => checkConsentForPurpose(sendInput, policy, contactState) },
    { name: 'check_contact_compliance',   fn: () => checkContactCompliance(sendInput, policy) },
    { name: 'check_autopay_sms_gate',      fn: () => checkAutopayCustomerSmsGate(sendInput) },
    { name: 'validate_identity_trust',    fn: () => validateIdentityTrust(sendInput, policy, contactState) },
    { name: 'validate_no_customer_emoji', fn: () => validateNoCustomerEmoji(sendInput, policy) },
    // Last: only pay for a Twilio line-type Lookup when the message would
    // otherwise actually send (gated dark behind GATE_PROACTIVE_LINETYPE_LOOKUP).
    { name: 'check_line_type',            fn: () => checkLineType(sendInput, policy, contactState) },
  ];

  const validatorsPassed = [];
  let blockedBy = null;

  for (const step of pipeline) {
    const result = await step.fn();
    if (result && result.ok) {
      validatorsPassed.push(step.name);
    } else {
      blockedBy = {
        code: result.code,
        reason: result.reason,
        validator: step.name,
        // Deferral contract (send-window): callers that reschedule off
        // { retryable, deferred, nextAllowedAt } — review requests, card-
        // request nudges — must see a window block as "try again at 8 AM",
        // not a terminal refusal.
        retryable: result.retryable === true,
        deferred: result.deferred === true,
        nextAllowedAt: result.nextAllowedAt || undefined,
      };
      break;
    }
  }

  const resolvedTrust = resolveTrustLevel(sendInput, contactState);

  // 6. If anything blocked, persist audit + return
  if (blockedBy) {
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: [blockedBy.validator],
      blockedBy: { code: blockedBy.code, reason: blockedBy.reason },
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return {
      sent: false,
      blocked: true,
      deliveryOutcome: 'not_sent',
      code: blockedBy.code,
      reason: blockedBy.reason,
      ...(blockedBy.retryable ? { retryable: true } : {}),
      ...(blockedBy.deferred ? { deferred: true } : {}),
      ...(blockedBy.nextAllowedAt ? { nextAllowedAt: blockedBy.nextAllowedAt } : {}),
      // A deferred hold is requeued by its caller: hand back the transformed
      // body (link wrap included) so the queued row is the text that goes out.
      ...(blockedBy.deferred ? { sentBody: sendInput.body } : {}),
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  // 6.35 Street-level address hold (see streetLevelHoldBlocksSend above): nothing about
  //      a held visit reaches the customer before the office confirms the address.
  if (await streetLevelHoldBlocksSend(sendInput)) {
    logger.info(`[send_customer_message] held: visit ${heldVisitIdOf(sendInput) || 'linked in the body'} is a street-level address hold (${sendInput.purpose})`);
    const blocked = { code: STREET_LEVEL_HOLD_BLOCK.code, reason: STREET_LEVEL_HOLD_BLOCK.reason };
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: ['street_level_hold'],
      blockedBy: blocked,
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return {
      sent: false,
      blocked: true,
      deliveryOutcome: 'not_sent',
      code: blocked.code,
      reason: blocked.reason,
      retryable: true,
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  // 6.36 Stale reschedule link on a scheduled operator text (see endedLinkedVisitBlocksSend): terminal.
  if (await endedLinkedVisitBlocksSend(sendInput)) {
    logger.info(`[send_customer_message] blocked: a linked visit is no longer reschedulable (${sendInput.entryPoint})`);
    const blocked = { code: LINKED_VISIT_ENDED_BLOCK.code, reason: LINKED_VISIT_ENDED_BLOCK.reason };
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: ['linked_visit_ended'],
      blockedBy: blocked,
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return {
      sent: false,
      blocked: true,
      deliveryOutcome: 'not_sent',
      code: blocked.code,
      reason: blocked.reason,
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  // 6.4 Grouped unit-move hold (codex #3609 r30 P1) — an appointment
  //     notice for a visit whose reminder row carries a live
  //     move_hold_until must not reach the provider: the visit is
  //     mid-move (or stranded partial) and the rendered body describes
  //     the OLD slot. Enforced HERE, in the canonical path every SMS leg
  //     passes — safeSend closures AND direct sendCustomerMessage callers
  //     (estimate accept, call pipeline) alike — so a hold stamped during
  //     any earlier await still blocks. Fail closed on a read error: the
  //     callers treat MOVE_HOLD as a deferral (flags left unmarked, the
  //     sweep retries), so a held-on-blip notice is delayed, never lost.
  if (appointmentMoveHoldApplies(sendInput)) {
    if (await appointmentMoveHeld(sendInput)) {
      const blocked = { code: 'MOVE_HOLD', reason: 'grouped unit move in progress — appointment notice held' };
      const audit = await persistAudit({
        input: sendInput,
        policy,
        segmentMeta,
        validatorsPassed,
        validatorsFailed: ['move_hold'],
        blockedBy: blocked,
        identityTrust: resolvedTrust,
        providerOutcome: null,
      });
      return {
        sent: false,
        blocked: true,
        deliveryOutcome: 'not_sent',
        code: blocked.code,
        reason: blocked.reason,
        auditLogId: audit.id,
        segmentCount: segmentMeta.segmentCount,
        encoding: segmentMeta.encoding,
      };
    }
  }

  // 6.45 callback_number_needed hold (see callbackNumberHoldBlocksSend
  //      above) — every SMS, keyed on `to`. Re-checked at the provider
  //      boundary below (providerPreparationCheck) and in twilio.js's
  //      dispatch().
  if (await callbackNumberHoldBlocksSend(sendInput)) {
    const blocked = { code: CALLBACK_NUMBER_HOLD_BLOCK.code, reason: CALLBACK_NUMBER_HOLD_BLOCK.reason };
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: ['callback_number_hold'],
      blockedBy: blocked,
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return {
      sent: false,
      blocked: true,
      deliveryOutcome: 'not_sent',
      code: blocked.code,
      reason: blocked.reason,
      retryable: true,
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  // 6.5 Caller-supplied recheck before provider preparation. Assigned lead
  //     replies additionally guard the actual SDK request withSmsHandoff.
  //     Callers with race-sensitive sends (clarify
  //     asks: an answer can arrive while the validators above run) get
  //     their freshest possible abort point inside the canonical path.
  //     Fail closed: a throwing check blocks the send.
  if (typeof preDispatchCheck === 'function') {
    let verdict;
    try {
      // Resolve the actual leg before caller guards run: an App attempt and
      // its SMS fallback have different transport requirements.
      verdict = await preDispatchCheck({ channel: sendInput.channel });
    } catch (err) {
      verdict = { ok: false, code: 'PRE_DISPATCH_CHECK_FAILED', reason: err.message };
    }
    if (!verdict || verdict.ok !== true) {
      const blocked = {
        code: (verdict && verdict.code) || 'PRE_DISPATCH_CHECK_FAILED',
        reason: (verdict && verdict.reason) || 'pre-dispatch check did not pass',
      };
      const audit = await persistAudit({
        input: sendInput,
        policy,
        segmentMeta,
        validatorsPassed,
        validatorsFailed: ['pre_dispatch_check'],
        blockedBy: blocked,
        identityTrust: resolvedTrust,
        providerOutcome: null,
      });
      return {
        sent: false,
        blocked: true,
        deliveryOutcome: 'not_sent',
        code: blocked.code,
        reason: blocked.reason,
        ...(verdict?.retryable === true ? { retryable: true } : {}),
        auditLogId: audit.id,
        segmentCount: segmentMeta.segmentCount,
        encoding: segmentMeta.encoding,
      };
    }
  }

  // 7. Dispatch to provider. preSendCheck is the send-window boundary
  // re-check, run by the provider IMMEDIATELY before the Twilio
  // messages.create() call: the pipeline check above ran before the
  // line-type Lookup and the caller's preDispatchCheck, and the provider
  // itself awaits an internal-redirect check, the SMS-template lookup and a
  // customer/location query before the handoff — any of which can straddle
  // the 20:00 ET cutoff. Re-checking at the last await means a send that
  // entered the pipeline at 19:59 can't reach Twilio at 20:01. Same
  // deferral contract as the pipeline block; cheap (pure clock math) and a
  // no-op for exempt inputs.
  // Until the adapter returns, a thrown transport call has crossed the SDK
  // handoff boundary but has no definitive acceptance/rejection result.
  let providerBoundaryBlock = null;
  const rememberBoundaryBlock = (verdict, validator) => {
    if (!verdict || verdict.ok === true) return verdict;
    providerBoundaryBlock = { ...verdict, validator };
    return verdict;
  };
  // Email authority and App bell persistence pass their held transaction
  // so the caller's boundary reads do not acquire another pooled connection.
  const runCallerPreSendCheck = async (database) => {
    if (typeof preSendCheck !== 'function') return { ok: true };
    try {
      const verdict = await preSendCheck({ channel: sendInput.channel, ...(database ? { database } : {}) });
      if (verdict?.ok === true) {
        if (Object.prototype.hasOwnProperty.call(verdict, 'validUntil')) {
          if (typeof verdict.validUntil !== 'number' || !Number.isFinite(verdict.validUntil)) {
            return { ok: false, code: 'PRE_SEND_CHECK_INVALID', reason: 'pre-send check returned an invalid validUntil', retryable: false };
          }
          if (Date.now() >= verdict.validUntil) {
            return { ok: false, code: 'PRE_SEND_CHECK_EXPIRED', reason: 'pre-send authority expired', retryable: true };
          }
        }
        return verdict;
      }
      return {
        ok: false,
        code: verdict?.code || 'PRE_SEND_CHECK_FAILED',
        reason: verdict?.reason || 'pre-send check did not pass',
        retryable: verdict?.retryable === true,
      };
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'PRE_SEND_CHECK_FAILED',
        reason: err?.message || 'pre-send check failed',
        retryable: err?.retryable === true,
      };
    }
  };
  const runCallerPreProviderCheck = async () => {
    if (typeof preProviderCheck !== 'function') return { ok: true };
    try {
      const verdict = await preProviderCheck({ channel: sendInput.channel });
      return verdict?.ok === true ? verdict : {
        ok: false,
        code: verdict?.code || 'PRE_PROVIDER_CHECK_FAILED',
        reason: verdict?.reason || 'pre-provider check did not pass',
        retryable: verdict?.retryable === true,
      };
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'PRE_PROVIDER_CHECK_FAILED',
        reason: err?.message || 'pre-provider check failed',
        retryable: err?.retryable === true,
      };
    }
  };
  const providerPreparationCheck = async ({ database: handoffDb } = {}) => {
    if (sendInput.metadata?.billingDeliveryLeg) {
      // Settings can change while a provider prepares its request. Never
      // send a leg the customer removed after the initial preference read.
      // Both the Email authority and App bell callback hold a transaction.
      // Reuse it here; a scheduler may already occupy the other pool slot.
      // Other callers continue to read through the root pool.
      let latest = await loadContactState(sendInput, handoffDb);
      const latestSuppressionInput = !sendInput.to
        && String(latest.customer?.id) === String(sendInput.customerId)
        ? { ...sendInput, to: latest.customer.phone || null }
        : sendInput;
      latest = await loadSuppressionState(latestSuppressionInput, latest, handoffDb);
      if (!latestSuppressionInput.to) latest.suppressionLoaded = true;
      const suppressionVerdict = await checkSuppression(sendInput, policy, latest);
      if (!suppressionVerdict.ok) return rememberBoundaryBlock(suppressionVerdict, 'check_suppression_boundary');
      const consentVerdict = await checkConsentForPurpose(sendInput, policy, latest);
      if (!consentVerdict.ok) return rememberBoundaryBlock(consentVerdict, 'check_consent_boundary');
      // billingEmailLeg's own invoice guard (claim/visit/ownership/balance —
      // the same checks withProviderHandoff runs for SMS/App), composed here
      // instead of via that handoff: this runs under the Email authority's
      // OWN lock on the invoice row (handoffDb IS that lock's
      // transaction — see the comment above), never a second lock on the
      // same row. billingEmailPreSendCheck is stripped from sendInput above
      // and reaches here only when this leg is billingEmailLeg (the
      // allowlist above refuses any other Email leg that supplies one).
      if (sendInput.metadata?.billingDeliveryLeg === 'email' && typeof billingEmailPreSendCheck === 'function') {
        const invoiceVerdict = await billingEmailPreSendCheck({ channel: 'email', database: handoffDb });
        if (!invoiceVerdict || invoiceVerdict.ok !== true) {
          return rememberBoundaryBlock(invoiceVerdict, 'billing_email_pre_send_check_boundary');
        }
      }
    }
    const windowVerdict = checkSendWindow(sendInput, policy, contactState);
    if (!windowVerdict || windowVerdict.ok !== true) {
      return rememberBoundaryBlock(windowVerdict, 'check_send_window_boundary');
    }
    // Move-hold boundary re-check at the ACTUAL Twilio handoff (uncapped
    // codex audit P1): the step-6.4 check runs before the provider's own
    // internal awaits — a unit move stamping during them must still hold
    // the send. Same deferral contract as the window hold.
    if (appointmentMoveHoldApplies(sendInput) && await appointmentMoveHeld(sendInput)) {
      return rememberBoundaryBlock(
        { ok: false, code: 'MOVE_HOLD', reason: 'grouped unit move in progress — appointment notice held', retryable: true },
        'move_hold_boundary',
      );
    }
    // Street-level address hold boundary re-check: a promotion that commits during the provider's
    // own awaits must still hold the send (the same retryable deferral as the move hold).
    if (await streetLevelHoldBlocksSend(sendInput)) {
      return rememberBoundaryBlock(
        { ok: false, code: STREET_LEVEL_HOLD_BLOCK.code, reason: STREET_LEVEL_HOLD_BLOCK.reason, retryable: true },
        'street_level_hold_boundary',
      );
    }
    // Stale reschedule link boundary re-check: a visit cancelled / skipped / completed since step 6.36 read it
    // (the lookup there is memoized) must still end the scheduled operator text, on its LIVE status.
    const endedVerdict = await endedLinkedVisitBlocksSend(sendInput, { fresh: true });
    if (endedVerdict === 'lookup_failed') {
      return rememberBoundaryBlock(
        { ok: false, code: 'LINKED_VISIT_LOOKUP_FAILED', reason: 'Could not re-read the visit this text links to', retryable: true },
        'linked_visit_lookup_boundary',
      );
    }
    if (endedVerdict) {
      return rememberBoundaryBlock(
        { ok: false, code: LINKED_VISIT_ENDED_BLOCK.code, reason: LINKED_VISIT_ENDED_BLOCK.reason },
        'linked_visit_ended_boundary',
      );
    }
    // callback_number_needed boundary re-check (codex round-6 P1): step
    // 6.45 ran before preDispatchCheck and the provider's own async
    // preparation — a hold committed in between (the call pipeline's
    // booking transaction landing while a follow-up was mid-flight) must
    // still stop the send here, the same way the move hold above does.
    if (await callbackNumberHoldBlocksSend(sendInput)) {
      return rememberBoundaryBlock({ ...CALLBACK_NUMBER_HOLD_BLOCK }, 'callback_number_hold_boundary');
    }
    const callerVerdict = await runCallerPreSendCheck(handoffDb);
    if (!callerVerdict.ok) return rememberBoundaryBlock(callerVerdict, 'pre_send_check_boundary');
    const providerVerdict = await runCallerPreProviderCheck();
    if (!providerVerdict.ok) return rememberBoundaryBlock(providerVerdict, 'pre_provider_check_boundary');
    const annualVerdict = await annualOfferGuardVerdict(sendInput, handoffDb);
    if (!annualVerdict.ok) return rememberBoundaryBlock(annualVerdict, 'annual_offer_guard_boundary');
    // Dispute-hold boundary re-check (round-11 P1): the step-1.5 read ran before policy, contact,
    // suppression, consent and caller checks; a hold committed since must still stop a gated
    // billing notice here. Same coded WAIT outcome; exemptions live in billingHoldBlock.
    const holdBlock = await billingHoldBlock(sendInput, handoffDb);
    if (holdBlock) return rememberBoundaryBlock(holdBlock, 'collection_hold_boundary');
    // The awaited caller guard may itself straddle 20:00 ET. Keep this pure
    // clock check as the final operation before returning to the provider.
    const finalWindowVerdict = checkSendWindow(sendInput, policy, contactState);
    return finalWindowVerdict?.ok === true
      ? { ...callerVerdict, ...finalWindowVerdict }
      : rememberBoundaryBlock(finalWindowVerdict, 'check_send_window_boundary');
  };
  // Push performs an ownership read after the awaited guard. It can then
  // re-check the window without another opaque caller await or a DB lock.
  providerPreparationCheck.isStillValid = () => checkSendWindow(sendInput, policy, contactState)?.ok === true;

  const acquiredProviderHandoff = await providerCoordination.acquireProviderHandoffReservation({
    existingHandle: providerHandoffReservation,
    applies: providerCoordination.canonicalCoordinationApplies(
      input,
      { providerPreSendCheck, withSmsHandoff },
    ),
    reservation: {
      to: sendInput.to,
      customerId: sendInput.customerId,
      fromNumber: sendInput.metadata?.fromNumber,
      body: sendInput.body,
      messageType: sendInput.metadata?.original_message_type || mapPurposeToMessageType(sendInput.purpose),
      adminUserId: sendInput.metadata?.adminUserId,
    },
    resolveFromNumber: async () => {
      const TwilioService = require('../twilio');
      return TwilioService.deriveOutboundNumber({
        customerLocationId: sendInput.metadata?.customerLocationId,
        customerId: sendInput.customerId,
      });
    },
  });
  providerHandoffReservation = acquiredProviderHandoff.handle;
  const providerCoordinationBlock = acquiredProviderHandoff.block && {
    sent: false,
    blocked: true,
    deliveryOutcome: acquiredProviderHandoff.block.deliveryOutcome,
    retryable: acquiredProviderHandoff.block.retryable,
    code: acquiredProviderHandoff.block.code,
    error: acquiredProviderHandoff.block.reason,
    validator: acquiredProviderHandoff.block.validator,
  };
  const dispatchProvider = () => {
    providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
    // A legacy previsit Text may route to App before provider dispatch. Its
    // SMS-only authority callback is irrelevant there; omitting it lets the
    // canonical App route deliver while every actual Twilio branch remains
    // fenced. Other handoff callers retain the prior strict behavior.
    const activeSmsHandoff = input.entryPoint === 'previsit_balance_reminder'
      && sendInput.channel !== 'sms' ? null : withSmsHandoff;
    const activeProviderPreSendCheck = input.entryPoint === 'previsit_balance_reminder'
      && sendInput.channel !== 'sms' ? undefined : providerPreSendCheck;
    return dispatchToProvider(sendInput, {
    // The caller's handoff receives (trx, onProviderStart): the callback fires
    // immediately before the provider request, after the rechecks below, so a
    // caller can tell a failed recheck (nothing sent) from a failed request.
    withSmsHandoff: activeSmsHandoff && (dispatch => activeSmsHandoff(async (trx, onProviderStart) => {
      // Lock acquisition may wait past an opt-out commit. Reuse the canonical
      // validators with fresh state on that same connection, before the SDK.
      const currentState = await loadSuppressionState(sendInput, await loadContactState(sendInput, trx), trx);
      if (currentState.lookupFailed || currentState.suppressionLoaded !== true) {
        return { ok: false, code: currentState.lookupFailed ? 'CONSENT_LOOKUP_FAILED' : 'SUPPRESSION_LOOKUP_FAILED',
          reason: 'SMS consent or suppression could not be rechecked before handoff', retryable: true };
      }
      const suppression = await checkSuppression(sendInput, policy, currentState);
      if (!suppression.ok) return suppression;
      const consent = await checkConsentForPurpose(sendInput, policy, currentState);
      if (!consent.ok) return consent;
      // Acquiring the handoff's locks can straddle the send-window cutoff:
      // re-judge the window on the fresh state immediately before the
      // provider request so a wait across it returns the ordinary hold.
      const windowVerdict = checkSendWindow(sendInput, policy, currentState);
      if (!windowVerdict || windowVerdict.ok !== true) return windowVerdict;
      // Awaited: the caller's durable pre-provider transition must commit
      // before the SDK request.
      if (typeof onProviderStart === 'function') await onProviderStart();
      // Pre-push audit P2 (twilio.js:953, round 12): forward the held `trx`
      // into twilio.js's own dispatch — its annual-offer recheck reads
      // through this SAME transaction (falling back to the plain db only
      // when there is none) instead of opening a second root-pool
      // connection while this one is still held.
      await dispatch(trx);
      return { ok: true };
    })),
    preSendCheck: providerPreparationCheck,
    // A separate caller predicate runs inside Twilio's final dispatch,
    // after its authoritative annual-offer guard. Keeping it distinct from
    // preSendCheck avoids invoking existing opaque preparation callbacks a
    // second time at the provider boundary.
    providerPreSendCheck: activeProviderPreSendCheck,
    // The REAL attempt boundary (codex #5018 r15 P1) — invoked by twilio.js
    // itself, immediately before dispatchStarted flips true and
    // messages.create() runs, AFTER providerPreSendCheck and
    // disclaimedNumberBlocksSend/preSendCheck.isStillValid have all
    // cleared. A caller's durable "this attempt may have reached the
    // provider" marker belongs here, never inside providerPreSendCheck
    // itself, which still has real refusal paths ahead of it.
    onDispatchStart,
    // codex #5018 r15 pre-push P1: onDispatchStart's own await is real
    // wall-clock time, which can itself cross the send window's close
    // boundary that the LAST synchronous isStillValid() check ran before
    // it. twilio.js invokes this to let the caller UNDO its own marker
    // when that recheck, run again right after onDispatchStart, finds the
    // window has closed — otherwise a send that never reached
    // messages.create() would be misclassified as ambiguous forever.
    onDispatchAbort,
    // codex #5196 r4 P2: fired instead of onDispatchAbort when
    // messages.create() itself throws a definitive rejection — still
    // inside the handoff, lock held. See twilio.js's dispatch().
    onDispatchRejected,
    // codex #5018 structural fix (post-r7): threaded straight through, same
    // as onDispatchStart/onDispatchAbort/onDispatchRejected above — see
    // this file's own destructure comment and twilio.js's dispatch() for
    // what it gates.
    logInHandoff,
    providerHandoffReservation,
  });
  };
  // billingEmailLeg never invokes withProviderHandoff itself (see the
  // allowlist above) — its invoice check runs instead inside
  // providerPreparationCheck, composed with billingEmailPreSendCheck, under
  // the Email authority's own lock.
  providerOutcome = providerCoordinationBlock || (withProviderHandoff && !billingEmailLeg
    ? await withProviderHandoff(dispatchProvider)
    : await dispatchProvider());
  await providerCoordination.finalizeProviderHandoffReservation({
    handle: providerHandoffReservation,
    outcome: {
      deliveryOutcome: providerOutcome.deliveryOutcome,
      providerMessageId: providerOutcome.providerMessageId,
      channel: providerOutcome.provider === 'push' ? 'push' : 'sms',
    },
    settle: true,
  });

  // Push fan-out normalizes a provider-hook refusal to false and therefore
  // loses its code. Restore that boundary refusal only when the provider
  // proves no leg was sent. Accepted or uncertain remains authoritative.
  // A prior visible App event settles its original copy independently of
  // a later native guard refusal; never replace that event's witness.
  if (providerBoundaryBlock && providerOutcome.deliveryOutcome === 'not_sent'
    && !(providerOutcome.provider === 'push' && providerOutcome.error === 'app_event_already_visible')) {
    providerOutcome = {
      ...providerOutcome,
      blocked: true,
      code: providerBoundaryBlock.code,
      error: providerBoundaryBlock.reason,
      validator: providerBoundaryBlock.validator,
      retryable: providerBoundaryBlock.retryable === true,
      deferred: providerBoundaryBlock.deferred === true,
      nextAllowedAt: providerBoundaryBlock.nextAllowedAt,
    };
  }

  // 7.5 Provider-handoff block (preSendCheck said no): map back onto the
  // same blocked/deferral contract as a pipeline validator, with a
  // dedicated validator name so audit rows distinguish the boundary race
  // from the ordinary pipeline block.
  if (providerOutcome.blocked) {
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: [providerOutcome.validator || 'check_send_window_boundary'],
      blockedBy: { code: providerOutcome.code, reason: providerOutcome.error },
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return providerCoordination.attachReservationContext(providerHandoffReservation, {
      sent: false,
      blocked: true,
      deliveryOutcome: providerOutcome.deliveryOutcome,
      ...(providerOutcome.bellPersisted ? { bellPersisted: true } : {}),
      code: providerOutcome.code,
      reason: providerOutcome.error,
      ...(providerOutcome.retryable ? { retryable: true } : {}),
      ...(providerOutcome.deferred ? { deferred: true } : {}),
      ...(providerOutcome.nextAllowedAt ? { nextAllowedAt: providerOutcome.nextAllowedAt } : {}),
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    });
  }

  await recordReceiptSmsDelivery(sendInput, providerOutcome);

  // 8. Persist final audit row with provider outcome. A throw past this
  // point carries the KNOWN provider outcome on the error, so callers with
  // durable send-once claims can distinguish a definite provider failure
  // (retryable) from an accepted-but-unaudited send (must not retry).
  let audit;
  try {
    audit = await persistAudit({
    input: sendInput,
    policy,
    segmentMeta,
    validatorsPassed,
    validatorsFailed: [],
    blockedBy: providerOutcome.sent ? null : { code: 'PROVIDER_FAILURE', reason: providerOutcome.error || 'unknown' },
    identityTrust: resolvedTrust,
      providerOutcome,
    });
  } catch (auditErr) {
    auditErr.providerOutcome = providerOutcome;
    // Accepted-but-unaudited callers still need the body that went out.
    auditErr.sentBody = sendInput.body;
    throw auditErr;
  }

  if (!providerOutcome.sent && sendInput.channel === 'push' && providerOutcome.appUnavailable) {
    // Codex r2 P1: pushEligibleRuntime's LATE re-read (push-channel-
    // routing.js, immediately before the provider handoff) can catch a
    // billing preference switch away from App that landed after this leg
    // was selected. That is the SAME race the consent-layer
    // BILLING_PREFERENCES_CHANGED/CHANNEL_NOT_SELECTED refusals cover for
    // Email/Text — a mid-dispatch choice change, not a dead App — so it
    // gets the identical SCHEDULABLE hold (Codex r3 P1 on PR #4843: deferred
    // + nextAllowedAt, the same ONE code, via the shared preferenceChangeHold()
    // helper) instead of falling into the terminal APP_UNAVAILABLE branch
    // below — a one-shot producer can now persist a retry row for this leg
    // exactly like it already does for the consent-layer refusals. The
    // caller's retry re-fans-out under the same notificationEventKey against
    // whatever the customer now has selected. Checked BEFORE the generic
    // appOnly/billingDeliveryLeg branch, which stays terminal for every
    // other appUnavailable reason (no fresh device, app gate off, …).
    if (sendInput.metadata?.billingDeliveryLeg === 'push' && providerOutcome.error === 'preference_changed') {
      const { preferenceChangeHold } = require('./billing-channel-routing');
      return { sent: false, blocked: true, ...preferenceChangeHold(), auditLogId: audit.id };
    }
    if (sendInput.metadata?.appOnly === true || sendInput.metadata?.billingDeliveryLeg === 'push') {
      return { sent: false, blocked: true, deliveryOutcome: providerOutcome.deliveryOutcome, code: 'APP_UNAVAILABLE', reason: providerOutcome.error, auditLogId: audit.id, ...(providerOutcome.eventVisibleAt ? { eventVisibleAt: providerOutcome.eventVisibleAt } : {}), ...(providerOutcome.bellPersisted ? { bellPersisted: true } : {}) };
    }
    if (providerOutcome.error === 'preference_changed'
      && ['appointment_reminder_72h', 'appointment_reminder_24h'].includes(sendInput.purpose)) {
      // The scan captured App; Email/Both now require a different set of
      // legs. Leave its reminder open so the next scan reads that choice.
      return { sent: false, blocked: true, deliveryOutcome: providerOutcome.deliveryOutcome, code: 'REMINDER_PREFERENCES_HOLD', reason: 'Reminder channel changed', retryable: true, deferred: true, auditLogId: audit.id };
    }
    // Re-enter the complete pipeline for an allowed backup, using fresh
    // consent/suppression state. Never clear an opt-out to enable fallback.
    const fallback = await sendCustomerMessage({
      ...input,
      channel: 'sms',
      metadata: { ...input.metadata, requestedChannel: 'push', appFallbackReason: providerOutcome.error || 'push_unavailable' },
    });
    return { ...fallback, requestedChannel: 'push', fallbackReason: providerOutcome.error || 'push_unavailable' };
  }

  if (!providerOutcome.sent) {
    const retryAt = nextProviderRetryAt(providerOutcome);
    return {
      sent: false,
      blocked: false,
      deliveryOutcome: providerOutcome.deliveryOutcome,
      code: providerOutcome.code === 'APP_PROVIDER_RETRY' ? providerOutcome.code : 'PROVIDER_FAILURE',
      reason: providerOutcome.error || 'provider returned no message id',
      retryable: !!providerOutcome.retryable,
      deferred: !!providerOutcome.retryable,
      terminal: providerOutcome.terminal === true,
      nextAllowedAt: retryAt ? retryAt.toISOString() : undefined,
      ...(providerOutcome.code === 'APP_PROVIDER_RETRY' ? { retryAfterMs: providerOutcome.retryAfterMs } : {}),
      providerErrorCode: providerOutcome.providerErrorCode,
      providerHttpStatus: providerOutcome.providerHttpStatus,
      // true = the provider layer already raised twilio_failure for this event.
      providerAlerted: providerOutcome.providerAlerted === true,
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
      ...(providerOutcome.bellPersisted ? { bellPersisted: true } : {}),
    };
  }

  // The audit row carries the promised window for a scheduling notice, and
  // persistAudit is best-effort: when its insert fails after the provider
  // accepted the message, the customer holds a window nothing records, the
  // reminder is marked sent and never retried, and the no-show detector
  // later reads an OLDER window as the latest promise (codex P1, PR #4403
  // round 9). Land the promise in the durable audit_log ledger instead.
  // Only for a send that actually quotes a slot for a known visit, and never
  // blocking: the text is already out.
  await recordPromiseEvidenceFallback(sendInput, providerOutcome, audit);

  // SMS offer ledger (GATE_SMS_OFFER_LEDGER, dark): a reply that came from an
  // agent decision and quoted appointment times leaves a record of the slots
  // the SENT text carried. Every decision send (reviewer, scheduled, auto-send)
  // passes through here with metadata.agentDecisionId. input.body is the text
  // the send checks approved; sendInput.body may have had its links rewritten.
  await recordSmsOfferAfterSend(input, sendInput, providerOutcome);

  return providerCoordination.attachReservationContext(providerHandoffReservation, {
    sent: true,
    blocked: false,
    deliveryOutcome: providerOutcome.deliveryOutcome,
    providerMessageId: providerOutcome.providerMessageId,
    sentAt: providerOutcome.sentAt,
    ...(providerOutcome.deduped === true ? { deduped: true } : {}),
    channel: providerOutcome.provider === 'push' ? 'push' : sendInput.channel,
    auditLogId: audit.id,
    segmentCount: segmentMeta.segmentCount,
    encoding: segmentMeta.encoding,
    // The audited body after every transform above (withheld-link rewrite,
    // GATE_SMS_LINK_WRAP short links): what the provider was handed.
    sentBody: sendInput.body,
    ...((withheldLinksRewritten || providerOutcome.withheldLinksRewritten)
      ? { withheldLinksRewritten: withheldLinksRewritten || providerOutcome.withheldLinksRewritten }
      : {}),
  });
  } catch (err) {
    const providerCoordination = require('./provider-handoff-reservation');
    await providerCoordination.finalizeProviderHandoffReservation({
      handle: providerHandoffReservation,
      outcome: err?.providerOutcome || providerOutcome,
      settle: true,
    });
    // A recursive fallback may already carry its more specific outcome.
    if (!err.providerOutcome) err.providerOutcome = providerOutcome;
    if (providerHandoffReservation) {
      require('./provider-handoff-reservation')
        .attachReservationContext(providerHandoffReservation, err.providerOutcome);
    }
    throw err;
  } finally {
    // Fire-and-forget: stamping never adds latency to the send path. The
    // .catch is a backstop (settleWrappedLinks never throws); code only, never
    // the message — a Knex error embeds the bound target_url.
    if (wrappedLinkCodes.length) {
      void require('./sms-link-wrap').settleWrappedLinks(wrappedLinkCodes, providerOutcome)
        .catch((err) => logger.warn(`[send_customer_message] wrapped-link stamp failed: ${String((err && (err.code || err.name)) || 'error').slice(0, 40)}`));
    }
  }
}

// Never throws and never blocks the result: the text is already out. Gate off
// (the default), the ledger module is not even loaded.
async function recordSmsOfferAfterSend(input, sendInput, providerOutcome) {
  try {
    const agentDecisionId = input?.metadata?.agentDecisionId;
    if (!agentDecisionId || providerOutcome?.provider === 'push') return;
    if (!require('../../config/feature-gates').gateEnvValue('GATE_SMS_OFFER_LEDGER')) return;
    await require('../sms-offers').recordOfferForSend({
      agentDecisionId,
      outgoingBody: input.body,
      providerMessageId: providerOutcome?.providerMessageId || null,
      to: sendInput.to,
      sentAt: providerOutcome?.sentAt ? new Date(providerOutcome.sentAt) : new Date(),
    });
  } catch (err) {
    logger.warn(`[send-customer-message] sms offer ledger skipped: ${err.message}`);
  }
}

// The audit row is where a scheduling notice's promised window lives, and
// persistAudit is best-effort: when its insert fails after the provider
// accepted the message, the customer holds a window nothing records, the
// reminder is marked sent and never retried, and the no-show detector later
// reads an OLDER window as the latest promise (codex P1, PR #4403 round 9).
// Land the promise in the durable audit_log ledger instead.
//
// Held to the same delivery bar the detector applies to an ordinary audit
// row: a real Twilio SM/MM sid, or a push the routing layer proved. sent:true
// alone is not enough — the success-shaped sentinels ('owner-silence',
// gate-/template-/internal-) report a send that reached nobody, and minting
// promise evidence from one would assert a window the customer was never
// told. The sid rides along in the row so the detector can still drop the
// promise if the carrier later reports the message undelivered. Never
// blocking: the text is already out.
async function recordPromiseEvidenceFallback(sendInput, providerOutcome, audit) {
  if (audit.id || !sendInput.appointmentId) return;
  // A SERIES confirmation is recorded even with no window of its own: a
  // date-only move quotes no arrival range, and refusing to write anything
  // there loses both the anchor's unknown-window promise and the siblings'
  // supersession proof, leaving every one of those visits on its older
  // window (codex P1, PR #4403 round 15).
  const seriesMoveId = sendInput.metadata?.original_message_type === 'reschedule_series_confirmation'
    ? sendInput.metadata?.series_move_id || null : null;
  // A notice that quoted no window (promisedWindowUnknown — a windowless
  // reschedule) records an UNKNOWN-window promise: its renderedSlotMs only
  // guarded the send, and skipping it would leave the visit on its older
  // window.
  const windowUnknown = sendInput.promisedWindowUnknown === true;
  const knownSlot = !windowUnknown && sendInput.renderedSlotMs != null && Number.isFinite(Number(sendInput.renderedSlotMs));
  if (!knownSlot && !seriesMoveId && !windowUnknown) return;
  const providerSid = String(providerOutcome.providerMessageId || '');
  const deliverable = /^(SM|MM)[a-f0-9]{32}$/i.test(providerSid)
    || (providerOutcome.provider === 'push' && providerOutcome.deliveryOutcome === 'accepted');
  if (!deliverable) return;
  await require('../no-show-detector').recordSentWindowFallback({
    visitId: sendInput.appointmentId, startAtMs: knownSlot ? sendInput.renderedSlotMs : null, windowUnknown,
    communicatedAt: providerOutcome.sentAt || new Date(),
    providerSid: providerOutcome.provider === 'push' ? null : providerSid,
    // ONLY the series confirmation proves the siblings were superseded, and
    // only that message type: the placement confirmation carries the same
    // move id but its copy says later commitments stand until staff review,
    // and Quick Move's moved-SMS names the anchor alone (codex P1, PR #4403
    // rounds 12 and 14). The detector reads this proof from the audit row we
    // just failed to write, so it rides along here.
    seriesMoveId,
    // Stop-wide copy stays stop-wide in the fallback: a notice that speaks
    // for a whole grouped stop supersedes every member's own promise, and
    // recording it as per-service would leave the siblings on their pre-move
    // windows (codex P1, PR #4403 round 26).
    stopWide: !!sendInput.metadata?.notificationEventKey,
  }).catch(() => {});
}

function validateContract(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'input must be an object' };
  }
  const missingRecipient = input.to == null || (typeof input.to === 'string' && !input.to.trim());
  const billingRecipientCanResolve = missingRecipient
    && require('./billing-channel-routing').isBillingDeliveryCandidate(input);
  if ((!input.to || typeof input.to !== 'string') && !billingRecipientCanResolve) {
    return { ok: false, reason: 'to (recipient) is required' };
  }
  const hasMedia = Array.isArray(input.metadata?.mediaUrls) && input.metadata.mediaUrls.length > 0;
  const mediaAllowed = input.metadata?.allowMediaUrls === true || !!input.metadata?.adminUserId;
  if (typeof input.body !== 'string') {
    return { ok: false, reason: 'body is required' };
  }
  if (!input.body.trim() && hasMedia && !mediaAllowed) {
    return { ok: false, reason: 'media-only SMS requires explicit media authorization' };
  }
  if (!input.body.trim() && !hasMedia) {
    return { ok: false, reason: 'body or media is required' };
  }
  if (!policyModule.MESSAGE_CHANNELS.includes(input.channel)) {
    return { ok: false, reason: `channel must be one of: ${policyModule.MESSAGE_CHANNELS.join(', ')}` };
  }
  if (!policyModule.MESSAGE_AUDIENCES.includes(input.audience)) {
    return { ok: false, reason: `audience must be one of: ${policyModule.MESSAGE_AUDIENCES.join(', ')}` };
  }
  if (!policyModule.MESSAGE_PURPOSES.includes(input.purpose)) {
    return { ok: false, reason: `purpose must be one of: ${policyModule.MESSAGE_PURPOSES.join(', ')}` };
  }
  if (input.purpose === 'internal_briefing' && !['internal', 'admin'].includes(input.audience)) {
    return { ok: false, reason: 'internal_briefing purpose requires internal or admin audience' };
  }
  if (['internal', 'admin'].includes(input.audience) && input.purpose !== 'internal_briefing') {
    return { ok: false, reason: 'internal/admin audience requires internal_briefing purpose' };
  }
  if (
    input.identityTrustLevel != null &&
    !policyModule.IDENTITY_TRUST_LEVELS.includes(input.identityTrustLevel)
  ) {
    return { ok: false, reason: `identityTrustLevel must be one of: ${policyModule.IDENTITY_TRUST_LEVELS.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Per-channel provider routing. Only sms ships in this commit; email and
 * portal_chat dispatchers land when the corresponding call sites migrate.
 */
async function dispatchToProvider(input, hooks = {}) {
  if (input.channel === 'email' && input.metadata?.billingDeliveryLeg === 'email') {
    return require('../billing-channel-email').sendBillingChannelEmail(input, hooks);
  }
  if (input.channel === 'sms' || input.channel === 'push') {
    return sendViaTwilio(input, hooks);
  }
  return {
    sent: false,
    deliveryOutcome: 'not_sent',
    error: `Provider for channel "${input.channel}" not yet wired in send_customer_message`,
  };
}

module.exports = {
  sendCustomerMessage,
  normalizeRecipient,
  // The shared "was this definitely not sent" derivation — every site
  // that decides whether to retire a delivery_outcome_uncertain-style flag
  // must route through this instead of reading `blocked`/`deliveryOutcome`
  // itself, so a future outcome shape only needs updating here.
  classifyDeliveryCertainty,
  // Exposed for tests
  _internals: {
    validateContract,
    recordPromiseEvidenceFallback,
    recordSmsOfferAfterSend,
    nextProviderRetryAt,
    isAutopayCustomerSms,
    checkAutopayCustomerSmsGate,
  },
};
