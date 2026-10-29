/**
 * Queue one customer text for later: the single writer behind
 *   - the Communications page (POST /admin/communications/schedule-sms), and
 *   - the Intelligence Bar's schedule_sms card (intelligence-bar/schedule-sms-tools.js).
 *
 * Moved out of admin-communications.js without changing what the route does: every guard, every status code, every
 * message and the one transaction are the route's own (Codex rounds on #3844, #3856, #5568, the r28 and r30 applicant
 * rules). The route answers with this function's { status, body } unchanged. The scheduled-SMS cron replays the queued
 * row later from the stored admin_user_id (server/services/scheduler.js), at the exact minute for operator rows.
 *
 * Guards, in the order they run (each returns before any write):
 *   1. admin only: a technician's route scope would outlive the reassignment it was granted under (#5568 r14);
 *   2. a translation-trial reply is sent now or not at all (409);
 *   3. to, body and scheduledFor are required (400);
 *   4. a retained "Text back" context on a recruiting row is an applicant reply: never scheduled here (409);
 *   5. an explicit customerId must be a live customer whose phone matches `to` (404 / 400); no customerId falls back
 *      to the single customer on that phone, which is NOT explicit context;
 *   6. a draft whose links point at a street-level address hold is not queued (409 street_level_hold);
 *   7. without explicit customer context, an active applicant phone is not scheduled here (409);
 *   8. marketing, seasonal marketing and retention message types are refused (400);
 *   9. immediate-only links (Auto Pay setup, contract signing, card request, statement pay, prep pages, review asks,
 *      branded short links that point at a review) are refused (400; 503 when a short link cannot be read);
 *  10. the time must parse and be in the future (400);
 *  11. the from number must be a Waves Twilio number (400);
 *  12. an Agent Review draft must still own a pending decision (409), then the decision is parked in the transaction.
 *
 * Effects, one transaction under the suggest-thread lock: refuse (409) when an automated reply is mid-send to the same
 * thread; park the used Agent Review decision and every other pending house-voice suggestion on the thread; insert the
 * sms_log row (status scheduled, scheduled_for, message_type, admin_user_id, metadata human_authored / decision ids /
 * linked visits). After the commit: stamp the Speed-to-Lead first response (best effort).
 *
 * Route-local helpers are passed in as `hooks` (they also serve the immediate /sms route): verifyAgentDecisionForSend,
 * recruitingReplyContext, findSingleCustomerForPhone. The Intelligence Bar passes none, and never sends the inputs that
 * use them (an Agent Review draft, a reply context, linked visits, a translation trial).
 *
 * Bar-only options (the route sends neither):
 *   underLock(trx)  runs inside the transaction right after the thread lock, before any insert. It returns null to go on,
 *                   { refuse: { status, error, code } } to abort with nothing written, or { existing: { id, scheduledFor } }
 *                   to answer success without a second row (a repeated Confirm queues one text).
 */
const db = require('../models/db');
const logger = require('./logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { normalizePhone } = require('../utils/phone');
const { parseETDateTime } = require('../utils/datetime-et');
const { isRecruitingPhone } = require('../utils/recruiting-thread-scope');
const { isEnabled } = require('../config/feature-gates');
const { markSuggestionScheduled, parkThreadSuggestions, lockSuggestThread } = require('./sms-suggest-mode');
const autoSendExecutor = require('./sms-auto-send');
const { gratitudeClaimsPossible } = require('./sms-gratitude-context');
const { unansweredClaimsPossible } = require('./sms-unanswered-reply');
const { linkedVisitIdsFrom } = require('./street-level-hold');

const BLOCKED_SCHEDULED_PURPOSES = new Set(['marketing', 'marketing_seasonal', 'retention']);

const phoneDigits = (value) => String(value || '').replace(/\D/g, '');
function normalizePhoneLast10(value) {
  const digits = phoneDigits(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}
function normalizeReplyForComparison(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// A tokenized review page link (/rate/:token or its /api/rate/:token/go
// short form), scheme-less or not — what buildReviewRequestLink inserts.
const REVIEW_LINK_RE = /\/(?:api\/)?rate\/[A-Za-z0-9_-]{6,}/i;
// Branded /l/:code short links — what buildReviewUrl normally hands out
// (shortenOrPassthrough); resolved through short_codes.kind below.
// {5,}: legacy five-character codes still resolve (short-url.js).
// Case-insensitive like REVIEW_LINK_RE: Express routing is case-insensitive
// and the public resolver lowercases the code, so /L/AbCdE resolves too
// (GH Codex #3856 r15 P1).
const SHORT_LINK_RE = /\/l\/([A-Za-z0-9_-]{5,})/gi;
const REVIEW_LINK_SCHEDULE_ERROR = 'Review request links can only go on an immediate send — send now, or remove the review link before scheduling';

// Links a scheduled text may NOT carry — every one is an immediate-send-only
// bearer or ask, re-checked only on the /sms path (the scheduler dispatches
// straight into sendCustomerMessage). The composer refuses client-side;
// this is the authoritative fence. Returns { status, error } or null.
async function scheduledSmsLinkRefusal(cleanBody, to) {
  // An Auto Pay setup link is a 30-day bearer credential with no
  // schedule-time re-check.
  const { autopayLinkSendCheck, immediateOnlyLinkSendCheck } = require('./composer-customer-links');
  const autopayCheck = await autopayLinkSendCheck(cleanBody, normalizePhoneLast10(to));
  if (autopayCheck.present) {
    return { status: 400, error: 'Auto Pay setup links expire — send them now, or remove the link before scheduling' };
  }
  // Same fence for the other per-row bearers the composer inserts
  // (contract signing, card request, statement pay, expiring prep pages)
  // (GH Codex #3844 r1 P1).
  const immediateOnly = await immediateOnlyLinkSendCheck(cleanBody);
  if (immediateOnly.present) {
    return { status: 400, error: `${immediateOnly.label} links are re-checked at delivery — send them now, or remove the link before scheduling` };
  }
  // A review ask rides the immediate /sms send only — that path claims and
  // marks the inline row and emails the Both copy; a scheduled row would
  // deliver it untracked (invisible to the cap and cooldown) and never
  // email (GH Codex #3856 r4 P1).
  if (REVIEW_LINK_RE.test(cleanBody)) return { status: 400, error: REVIEW_LINK_SCHEDULE_ERROR };
  // A pasted branded short link hides the /rate/ path — ask short_codes
  // what it points at (GH Codex #3856 r5 P1). Fail closed on a lookup miss.
  // Lowercased like the public resolver (public-shortlinks.js): short_codes.code
  // is case-sensitive, and a pasted /l/AbCdE still resolves for the customer
  // (GH Codex #3856 r12 P1).
  const shortCodes = [...cleanBody.matchAll(SHORT_LINK_RE)].map((m) => m[1].toLowerCase());
  if (!shortCodes.length) return null;
  let reviewCodes;
  try {
    reviewCodes = await db('short_codes').whereIn('code', shortCodes).where({ kind: 'review' }).select('code');
  } catch (lookupErr) {
    logger.warn(`[communications] short-link kind lookup failed — refusing to schedule: ${lookupErr.message}`);
    return { status: 503, error: 'Could not verify the links in this message — try again in a moment.' };
  }
  return reviewCodes.length ? { status: 400, error: REVIEW_LINK_SCHEDULE_ERROR } : null;
}

// The customer a scheduled text is linked to: the selected one, whose phone
// must match `to`; else a digit-normalized, deleted-filtered, ambiguity-aware
// lookup (a raw exact-string phone match misses formatting variants and can
// link the scheduled SMS to a soft-deleted or arbitrary duplicate customer).
// Returns { customerId } or { status, error }.
async function trustedCustomerForScheduledSms(customerId, to, findSingleCustomerForPhone) {
  if (!customerId) {
    const fallback = findSingleCustomerForPhone ? await findSingleCustomerForPhone(to).catch(() => null) : null;
    return { customerId: fallback ? fallback.id : null };
  }
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'phone');
  if (!customer) return { status: 404, error: 'customerId not found' };
  const normalizedTo = normalizePhone(to);
  const normalizedCustomerPhone = normalizePhone(customer.phone);
  if (!normalizedTo || !normalizedCustomerPhone || normalizedTo !== normalizedCustomerPhone) {
    return { status: 400, error: 'to must match the selected customer phone' };
  }
  return { customerId: customer.id };
}

const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/**
 * @param {object} input  the route body: to, body, scheduledFor, customerId, fromNumber, from, messageType,
 *                        agentDecisionId, agentDraft, replyToMessageId, translationTrialId, linkedVisitIds
 * @param {object} actor  { techRole, technicianId }
 * @param {object} hooks  { verifyAgentDecisionForSend, recruitingReplyContext, findSingleCustomerForPhone, underLock }
 * @returns {Promise<{status:number, body:object}>}
 */
async function scheduleCustomerSms(input, actor, hooks = {}) {
  // Deferred sends are office-only. The scheduler replays a queued row later
  // from the stored admin_user_id with no re-check of the sender's route, so a
  // technician's route-scoped authorization at enqueue time would outlive the
  // reassignment it was granted under (Codex #5568 r14 P1). Refused before any
  // lookup or insert, with the staff default-deny gate on or off.
  // (The route's technicianCustomerGuard only ever acts on a technician, who cannot pass this line.)
  if (actor?.techRole !== 'admin') return fail(403, 'Admin access required');
  const { to, body, scheduledFor, customerId, fromNumber, from, messageType, agentDecisionId, agentDraft, replyToMessageId, translationTrialId } = input || {};
  // A reply taken from the translation card answers the customer's latest text as of now; nothing re-checks
  // it when a queued send fires, so it is sent now or not at all.
  if (translationTrialId) return fail(409, 'A suggested reply in the customer\'s language can only be sent now, not scheduled.');
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!to || !cleanBody || !scheduledFor) return fail(400, 'to, body, scheduledFor required');
  // A retained "Text back" context on a recruiting row makes this an
  // applicant reply whatever customer is selected (Codex r30 P1, same
  // rule as the immediate /sms path): applicant texts are never
  // scheduled here, so refuse before the customer bypass below.
  const recruitingContext = hooks.recruitingReplyContext ? await hooks.recruitingReplyContext(replyToMessageId, to) : null;
  if (recruitingContext) return fail(409, 'Applicant texts are not scheduled here — send now from the recruiting queue or the reply box');
  // Explicit customer context is validated FIRST (Codex r28 P2): a
  // customerId the operator selected, whose phone matches `to`, is a
  // customer text even when an open application shares the phone — the
  // same rule the immediate /sms path applies (Codex r16 P1). The
  // no-customerId fallback (single customer on the phone) is NOT explicit
  // context and does not bypass the applicant guard.
  const trusted = await trustedCustomerForScheduledSms(customerId, to, hooks.findSingleCustomerForPhone);
  if (trusted.error) return fail(trusted.status, trusted.error);
  const trustedCustomerId = trusted.customerId;
  // A draft whose reschedule / appointment link points at a street-level address hold is not queued:
  // nothing about a held visit reaches the customer before the office confirms the address.
  const scheduledLinkedVisitIds = linkedVisitIdsFrom(input?.linkedVisitIds);
  if (scheduledLinkedVisitIds.length) {
    const { isStreetLevelHoldVisit, HOLD_REFUSAL } = require('./street-level-hold');
    for (const visitId of scheduledLinkedVisitIds) {
      if (await isStreetLevelHoldVisit(visitId)) return fail(409, HOLD_REFUSAL, { code: 'street_level_hold' });
    }
  }
  const explicitCustomerContext = Boolean(customerId && trustedCustomerId);
  // Recruiting boundary (Codex r7 P0): a scheduled 'manual' text to an
  // applicant would later hand their reply to the customer pipeline —
  // applicant texts are not scheduled from here at all (owner sends now
  // from the recruiting queue / reply box; the send window queues them
  // itself), and a non-admin is refused outright.
  if (!explicitCustomerContext && await isRecruitingPhone(to, undefined, { activeOnly: true })) {
    return fail(409, 'Applicant texts are not scheduled here — send now from the recruiting queue or the reply box');
  }
  if (messageType) {
    const { purposeForScheduledMessageType } = require('./scheduler');
    if (BLOCKED_SCHEDULED_PURPOSES.has(purposeForScheduledMessageType(messageType))) {
      return fail(400, 'marketing/retention sends are not allowed on this endpoint');
    }
  }
  const linkRefusal = await scheduledSmsLinkRefusal(cleanBody, to);
  if (linkRefusal) return fail(linkRefusal.status, linkRefusal.error);

  // ET wall-clock parse — datetime-local strings without offset are
  // interpreted in ET, ISO strings pass through unchanged.
  const sendAt = parseETDateTime(scheduledFor);
  if (Number.isNaN(sendAt.getTime())) return fail(400, 'invalid scheduledFor');
  if (sendAt <= new Date()) return fail(400, 'scheduledFor must be in the future');

  const chosenFrom = fromNumber || from || TWILIO_NUMBERS.getOutboundNumber();
  if (!TWILIO_NUMBERS.findByNumber(chosenFrom)) return fail(400, 'fromNumber must be a Waves Twilio number');

  // An Agent Review draft can be scheduled instead of sent now. Carry the
  // verified decision id on the scheduled row so the 5-min dispatch cron
  // resolves it (accepted/corrected) when the send actually fires —
  // otherwise the suggestion stays pending and gets miscounted as
  // ignored/expired despite a human-approved send.
  let scheduledAgentDecision = null;
  if (agentDecisionId && agentDraft) {
    scheduledAgentDecision = hooks.verifyAgentDecisionForSend
      ? await hooks.verifyAgentDecisionForSend({ agentDecisionId, to, trustedCustomerId, outgoingBody: body })
      : null;
    // Stale card — most often another operator just handled the same
    // suggestion. Queueing anyway would schedule a duplicate reply with
    // no decision linkage to resolve or cancel.
    if (!scheduledAgentDecision) return fail(409, 'This Agent Review draft was just handled elsewhere — refresh the thread before scheduling.');
  }

  // Operator hand-composed this scheduled SMS unless an unchanged AI draft
  // is being queued through. Persisted as provenance so the dispatch cron
  // can exempt the deferred send from the stale-month guard, same as the
  // immediate manual send. An unchanged agent draft stays month-checked.
  const scheduledBodyIsUnchangedAgentDraft = !!scheduledAgentDecision?.suggested_message
    && normalizeReplyForComparison(cleanBody) === normalizeReplyForComparison(scheduledAgentDecision.suggested_message);
  const scheduledHumanAuthored = !scheduledBodyIsUnchangedAgentDraft;

  // Queue + park in ONE transaction: the used decision AND every other
  // pending house-voice suggestion on this thread move to 'scheduled', so
  // nothing stays actionable in the composer while the queued reply
  // waits. Fire resolves the used one and ignores the parked ones;
  // cancel/failure reopens them all. A park failure rolls the queue
  // insert back — never a queued send with a still-actionable card.
  let row;
  let existing = null;
  try {
    row = await db.transaction(async (trx) => {
      // Same thread lock as the drafter's publish and the post-send
      // sweep — park + queue commit atomically with respect to both.
      await lockSuggestThread(trx, normalizePhoneLast10(to) || to);

      // Bar only: the card's pins and a repeated Confirm, re-checked while this lock is held.
      if (hooks.underLock) {
        const verdict = await hooks.underLock(trx);
        if (verdict?.refuse) {
          const refusal = new Error(verdict.refuse.error);
          refusal.statusCode = verdict.refuse.status || 409;
          refusal.refusal = verdict.refuse;
          throw refusal;
        }
        if (verdict?.existing) { existing = verdict.existing; return null; }
      }

      // Don't queue a reply while an autonomous house-voice reply (Phase E)
      // is mid-send to this thread — it could land as a duplicate when this
      // one dispatches. The 'scheduled' sms_log row inserted below is itself
      // the marker the auto-send's guard sees, so this check only needs to
      // cover the reverse race (auto claimed first). No-op while both
      // autonomous lanes are dormant and gratitude was never activated.
      if ((isEnabled('smsAutoSend') || gratitudeClaimsPossible() || unansweredClaimsPossible())
        && await autoSendExecutor.hasActiveAutoSendClaim(trx, { threadLast10: normalizePhoneLast10(to), customerId: trustedCustomerId })) {
        const conflict = new Error('An automated reply is going out to this conversation right now — refresh in a moment before scheduling.');
        conflict.statusCode = 409;
        throw conflict;
      }

      let usedDecisionId = null;
      if (scheduledAgentDecision) {
        const parkedUsed = await markSuggestionScheduled(
          { decisionId: scheduledAgentDecision.id, scheduledFor: sendAt }, trx,
        );
        // 0 rows = a concurrent request claimed/resolved this decision
        // between verification and the guarded park. Queueing anyway
        // would double-send the same reply — abort and roll back.
        if (parkedUsed === 0) {
          const conflict = new Error('This Agent Review draft was just handled elsewhere — refresh the thread before sending.');
          conflict.statusCode = 409;
          throw conflict;
        }
        usedDecisionId = scheduledAgentDecision.id;
      }
      const parkedIds = await parkThreadSuggestions(
        { phoneLast10: normalizePhoneLast10(to), excludeDecisionId: scheduledAgentDecision?.id }, trx,
      );

      const metaObj = {};
      if (usedDecisionId) metaObj.agent_decision_id = usedDecisionId;
      if (parkedIds.length) metaObj.parked_decision_ids = parkedIds;
      if (scheduledHumanAuthored) metaObj.human_authored = true;
      // The visits the draft's links point at: the cron replay forwards them so the shared send step
      // re-checks for a street-level hold at DELIVERY (a visit can become one after this enqueue).
      if (scheduledLinkedVisitIds.length) metaObj.linked_scheduled_service_ids = scheduledLinkedVisitIds;
      const metadata = Object.keys(metaObj).length ? JSON.stringify(metaObj) : null;

      const [inserted] = await trx('sms_log')
        .insert({
          customer_id: trustedCustomerId,
          direction: 'outbound',
          from_phone: chosenFrom,
          to_phone: to,
          message_body: cleanBody,
          status: 'scheduled',
          message_type: messageType || 'manual',
          admin_user_id: actor.technicianId || null,
          scheduled_for: sendAt,
          metadata,
        })
        .returning(['id', 'scheduled_for']);
      return inserted;
    });
  } catch (scheduleErr) {
    if (scheduleErr.refusal) return fail(scheduleErr.statusCode, scheduleErr.refusal.error, scheduleErr.refusal.code ? { code: scheduleErr.refusal.code } : {});
    if (scheduleErr.statusCode === 409) return fail(409, scheduleErr.message);
    throw scheduleErr;
  }
  if (existing) return { status: 200, body: { success: true, id: existing.id, scheduledFor: new Date(existing.scheduledFor).toISOString(), alreadyQueued: true } };

  // Scheduling a reply is the operator's response act — stamp the
  // Speed-to-Lead clock NOW (the scheduled-SMS cron replays human and
  // automation rows under one entry point, so fire time can't tell them
  // apart; the decision to respond already happened here). If the queued
  // send later fails, the failure alert lane surfaces it.
  try {
    const { stampFirstResponseByContact } = require('./lead-estimate-link');
    await stampFirstResponseByContact({
      phone: to,
      performedBy: actor.technicianId ? `admin:${actor.technicianId}` : 'admin',
    });
  } catch (stampErr) {
    logger.warn(`[admin-communications] scheduled-reply first-response stamp failed: ${stampErr.message}`);
  }

  return { status: 200, body: { success: true, id: row?.id, scheduledFor: sendAt.toISOString() } };
}

module.exports = {
  scheduleCustomerSms,
  scheduledSmsLinkRefusal,
  trustedCustomerForScheduledSms,
  BLOCKED_SCHEDULED_PURPOSES,
  REVIEW_LINK_SCHEDULE_ERROR,
};
