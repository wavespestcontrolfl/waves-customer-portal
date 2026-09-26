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
  try {
  // 1. Contract validation
  const contractCheck = validateContract(input);
  if (!contractCheck.ok) {
    logger.warn(`[send_customer_message] contract violation: ${contractCheck.reason}`);
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CONTRACT_VIOLATION', reason: contractCheck.reason };
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
    providerPreSendCheck,
    withSmsHandoff,
    withProviderHandoff,
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
  // The locked handoff holds a caller's authority rows through the actual
  // provider request. Immediate lead replies and the visit-summary bearer
  // link (its immediate send and its scheduled replay), plus promised
  // reschedule links, are the callers whose authority may change between
  // validation and the handoff.
  const smsHandoffAllowed = (input.audience === 'lead' && input.purpose === 'conversational'
      && input.entryPoint === 'lead_response_auto_reply')
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
      && typeof providerPreSendCheck === 'function');
  if (withSmsHandoff && (typeof withSmsHandoff !== 'function' || sendInput.channel !== 'sms' || !smsHandoffAllowed)) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_SMS_HANDOFF', reason: 'Locked SMS handoff is not allowed for this message' };
  }
  if (typeof preSendCheck === 'function' && withSmsHandoff) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_SEND_GUARD_COMBINATION',
      reason: 'A caller pre-send check cannot be combined with a locked SMS handoff' };
  }
  // Invoice delivery needs one lock boundary that covers whichever provider
  // the canonical router actually chooses (push-first, push+SMS, or Twilio).
  // Keep this narrowly scoped to the invoice-send entry point: other callers
  // use the stronger recipient/consent handoffs above, whose transaction is
  // also threaded into their fresh suppression reads.
  const providerHandoffAllowed = input.audience === 'customer'
    && (sendInput.channel === 'sms' || (sendInput.channel === 'push' && input.metadata?.billingDeliveryLeg === 'push'))
    && input.purpose === 'payment_link'
    && input.entryPoint === 'invoice_send_via_sms';
  if (withProviderHandoff
    && (typeof withProviderHandoff !== 'function' || !providerHandoffAllowed || withSmsHandoff)) {
    return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_PROVIDER_HANDOFF',
      reason: 'Locked provider handoff is restricted to invoice delivery' };
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
  const runCallerPreSendCheck = async () => {
    if (typeof preSendCheck !== 'function') return { ok: true };
    try {
      const verdict = await preSendCheck({ channel: sendInput.channel });
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
  const providerPreparationCheck = async ({ trx: billingEmailTrx } = {}) => {
    if (sendInput.metadata?.billingDeliveryLeg) {
      // Settings can change while a provider prepares its request. Never
      // send a leg the customer removed after the initial preference read.
      // Codex r2 P1: an explicit Email leg's caller
      // (billing-channel-email-authority.js) already holds
      // withCustomerCommsLock's transaction for this exact recheck and
      // threads it through as `trx` — reuse it for these reads instead of
      // opening a second root-pool connection (DB_POOL_MAX=2 deadlock risk
      // under two concurrent billing emails). Push/SMS callers never supply
      // a trx here, so they keep reading through the plain pool unchanged.
      let latest = await loadContactState(sendInput, billingEmailTrx);
      const latestSuppressionInput = !sendInput.to
        && String(latest.customer?.id) === String(sendInput.customerId)
        ? { ...sendInput, to: latest.customer.phone || null }
        : sendInput;
      latest = await loadSuppressionState(latestSuppressionInput, latest, billingEmailTrx);
      if (!latestSuppressionInput.to) latest.suppressionLoaded = true;
      const suppressionVerdict = await checkSuppression(sendInput, policy, latest);
      if (!suppressionVerdict.ok) return rememberBoundaryBlock(suppressionVerdict, 'check_suppression_boundary');
      const consentVerdict = await checkConsentForPurpose(sendInput, policy, latest);
      if (!consentVerdict.ok) return rememberBoundaryBlock(consentVerdict, 'check_consent_boundary');
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
    // callback_number_needed boundary re-check (codex round-6 P1): step
    // 6.45 ran before preDispatchCheck and the provider's own async
    // preparation — a hold committed in between (the call pipeline's
    // booking transaction landing while a follow-up was mid-flight) must
    // still stop the send here, the same way the move hold above does.
    if (await callbackNumberHoldBlocksSend(sendInput)) {
      return rememberBoundaryBlock({ ...CALLBACK_NUMBER_HOLD_BLOCK }, 'callback_number_hold_boundary');
    }
    const callerVerdict = await runCallerPreSendCheck();
    if (!callerVerdict.ok) return rememberBoundaryBlock(callerVerdict, 'pre_send_check_boundary');
    const providerVerdict = await runCallerPreProviderCheck();
    if (!providerVerdict.ok) return rememberBoundaryBlock(providerVerdict, 'pre_provider_check_boundary');
    const annualVerdict = await annualOfferGuardVerdict(sendInput, billingEmailTrx);
    if (!annualVerdict.ok) return rememberBoundaryBlock(annualVerdict, 'annual_offer_guard_boundary');
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
  const dispatchProvider = (handoffTrx) => {
    providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
    // Codex r4 P1 on #4843: when the caller's own withProviderHandoff
    // exposes its transaction (invoice.js's send-claim + deposit-settlement
    // handoff), thread it into providerPreparationCheck's `{ trx }` param —
    // the SAME plumbing the Email leg's locked authority already uses (see
    // billing-channel-email-authority.js's preSendBlock) — so the Text and
    // App legs' fresh contact/suppression rereads (and, further down,
    // pushEligibleRuntime's read for a billing leg) reuse this connection
    // instead of opening a second one on the root pool while the handoff
    // trx is held (DB_POOL_MAX=2 deadlock risk). twilio.js and push-
    // channel-routing.js call preSendCheck() with no arguments, so the
    // closure below is what actually delivers the trx to them; when there
    // is no handoff (plain `await dispatchProvider()`), handoffTrx is
    // undefined and every read falls back to the plain pool exactly as
    // before.
    const preSendCheckWithHandoffTrx = (args = {}) => providerPreparationCheck({ ...args, trx: args?.trx || handoffTrx });
    preSendCheckWithHandoffTrx.isStillValid = providerPreparationCheck.isStillValid;
    preSendCheckWithHandoffTrx.handoffTrx = handoffTrx;
    return dispatchToProvider(sendInput, {
    // The caller's handoff receives (trx, onProviderStart): the callback fires
    // immediately before the provider request, after the rechecks below, so a
    // caller can tell a failed recheck (nothing sent) from a failed request.
    withSmsHandoff: withSmsHandoff && (dispatch => withSmsHandoff(async (trx, onProviderStart) => {
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
    preSendCheck: preSendCheckWithHandoffTrx,
    // A separate caller predicate runs inside Twilio's final dispatch,
    // after its authoritative annual-offer guard. Keeping it distinct from
    // preSendCheck avoids invoking existing opaque preparation callbacks a
    // second time at the provider boundary.
    providerPreSendCheck,
    providerHandoffReservation,
  });
  };
  providerOutcome = providerCoordinationBlock || (withProviderHandoff
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
  if (providerBoundaryBlock && providerOutcome.deliveryOutcome === 'not_sent') {
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
      return { sent: false, blocked: true, deliveryOutcome: providerOutcome.deliveryOutcome, code: 'APP_UNAVAILABLE', reason: providerOutcome.error, auditLogId: audit.id };
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

  return providerCoordination.attachReservationContext(providerHandoffReservation, {
    sent: true,
    blocked: false,
    deliveryOutcome: providerOutcome.deliveryOutcome,
    providerMessageId: providerOutcome.providerMessageId,
    sentAt: providerOutcome.sentAt,
    channel: providerOutcome.provider === 'push' ? 'push' : sendInput.channel,
    auditLogId: audit.id,
    segmentCount: segmentMeta.segmentCount,
    encoding: segmentMeta.encoding,
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
  const knownSlot = sendInput.renderedSlotMs != null && Number.isFinite(Number(sendInput.renderedSlotMs));
  if (!knownSlot && !seriesMoveId) return;
  const providerSid = String(providerOutcome.providerMessageId || '');
  const deliverable = /^(SM|MM)[a-f0-9]{32}$/i.test(providerSid)
    || (providerOutcome.provider === 'push' && providerOutcome.deliveryOutcome === 'accepted');
  if (!deliverable) return;
  await require('../no-show-detector').recordSentWindowFallback({
    visitId: sendInput.appointmentId, startAtMs: knownSlot ? sendInput.renderedSlotMs : null,
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
    nextProviderRetryAt,
    isAutopayCustomerSms,
    checkAutopayCustomerSmsGate,
  },
};
