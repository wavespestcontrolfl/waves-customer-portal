/**
 * Abandoned-booking recovery
 *
 * A public /book visitor who entered contact info + picked a slot but never
 * tapped "Confirm" is captured as a booking_intents row (routes/booking.js
 * POST /capture-intent). This service chases the un-converted ones:
 *   - Touch 1 — recovery SMS ~1h after abandon (warm; the slot may still be open)
 *   - Touch 2 — recovery email ~24h after abandon, if still not booked
 *
 * Ships LIVE behind bookingAbandonRecovery (kill switch
 * GATE_BOOKING_ABANDON_RECOVERY=false → shadow-logs counts, never sends).
 *
 * Mirrors the estimate deposit-abandonment stage (services/estimate-follow-up.js):
 * per-stage atomic claim flags, quiet hours, reply-pause, transactional consent,
 * release-on-failure so a blocked send retries next tick. Runs from scheduler.js.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { shortenOrPassthrough } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const Experiments = require('./experimentation/growthbook');

// Touch windows (hours from captured_at). The cron runs every 30 min, so the
// SMS fires ~1–1.5h after abandon. Max-age caps how stale a lead we'll chase.
const SMS_MIN_AGE_H = 1;
const SMS_MAX_AGE_H = 48;
const EMAIL_MIN_AGE_H = 24;
const EMAIL_MAX_AGE_H = 168; // 7 days

const BOOKING_URL = 'https://portal.wavespestcontrol.com/book?source=booking_recovery';

// Genuine TERMINAL suppression codes — the recipient can never receive this
// purpose, so keep the claim (never re-attempt). Everything else that blocks
// (CONSENT_LOOKUP_FAILED / CONTRACT_VIOLATION / UNKNOWN_POLICY / PROVIDER_FAILURE
// / QUIET_HOURS_HOLD) sent nothing operationally → release the claim and retry.
const TERMINAL_SMS_CODES = new Set([
  'SMS_OPTED_OUT', 'PURPOSE_OPTED_OUT', 'NO_MARKETING_CONSENT', 'NO_CONSENT_RECORD',
  'SUPPRESSED_OPT_OUT', 'SUPPRESSED_NON_MOBILE', 'SUPPRESSED_MANUAL_DNC',
  'SUPPRESSED_WRONG_NUMBER', 'SUPPRESSED_OTHER', 'NON_MOBILE_SMS_RECIPIENT',
]);

// 8a–8p America/New_York — never text outside business hours (matches the
// messaging quiet-hours validator window for enforced purposes). The pre-check
// avoids claim churn; the validator is the backstop.
function isQuietHours(now = new Date()) {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hour12: false, timeZone: 'America/New_York',
  }).format(now), 10);
  if (Number.isNaN(hour)) return false; // fail open
  return hour < 8 || hour >= 20;
}

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Reply-pause: if this phone has SMS'd Waves recently, let Virginia handle it
// live instead of a cron nudge. Soft-fails so a missing table never breaks the
// loop.
async function hasRepliedRecently(phone, days = 14) {
  const ten = last10(phone);
  if (!ten) return false;
  const cutoff = new Date(Date.now() - days * 86400000);
  try {
    const row = await db('messages')
      .join('conversations', 'messages.conversation_id', 'conversations.id')
      .where('messages.direction', 'inbound')
      .where('messages.channel', 'sms')
      .where('messages.created_at', '>=', cutoff)
      .whereRaw("RIGHT(regexp_replace(COALESCE(conversations.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .first('messages.id');
    return !!row;
  } catch (e) {
    logger.warn(`[booking-recovery] reply-pause check skipped: ${e.message}`);
    return false; // fail open
  }
}

// Suppress recovery if the booker already has an upcoming appointment booked by
// ANY path — incl. a CSR/admin booking that creates a scheduled_services row
// without touching booking_intents.converted_at (so the convert-mark + the
// capture-time self_booked check don't see it). Matches by customer_id when the
// intent resolved to one, else by the phone's last 10 digits.
async function hasActiveBooking(intent) {
  const ten = last10(intent.phone);
  if (!intent.customer_id && !ten) return false;
  try {
    const q = db('scheduled_services as ss')
      .leftJoin('customers as c', 'ss.customer_id', 'c.id')
      // Only a genuinely-active upcoming appointment counts — a rescheduled /
      // skipped / no-show / completed / cancelled row is NOT a spot to protect,
      // and suppressing on those would wrongly drop a real recovery.
      .whereNotIn('ss.status', ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'])
      .where('ss.scheduled_date', '>=', etDateString())
      .first('ss.id');
    if (intent.customer_id) q.where('ss.customer_id', intent.customer_id);
    else q.whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten]);
    return !!(await q);
  } catch (e) {
    logger.warn(`[booking-recovery] active-booking check skipped: ${e.message}`);
    return false; // fail open
  }
}

// Honor an existing customer's email opt-out (notification_prefs.email_enabled).
// email_suppressions covers hard bounces/unsubs; this covers a customer who
// turned email off in prefs but isn't suppressed.
async function customerEmailDisabled(customerId) {
  if (!customerId) return false;
  try {
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first('email_enabled');
    return !!prefs && prefs.email_enabled === false;
  } catch (e) {
    // FAIL CLOSED — if we can't verify the customer's email pref, don't email
    // (better to skip a recovery nudge than email someone who opted out).
    logger.warn(`[booking-recovery] email-pref lookup failed for customer=${customerId} — skipping: ${e.message}`);
    return true;
  }
}

async function renderSms(vars) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate('booking_abandonment_recovery', vars, {
        workflow: 'booking_abandon_recovery', entity_type: 'booking_intent',
      });
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[booking-recovery] SMS template lookup failed: ${err.message}`);
  }
  logger.warn('[booking-recovery] booking_abandonment_recovery SMS template missing/disabled');
  return null;
}

// Measured-rollout holdback (GrowthBook `booking-abandon-recovery`, Phase 2 of
// the experimentation initiative). Intent-to-treat: decided at candidacy, per
// PERSON (phone last-10 — the same key the send-dedup uses), before quiet-hours
// / reply-pause filters so both arms are measured from the same point. A
// held-back person gets NEITHER touch: both stage flags are claimed so the
// intent never re-surfaces. Fails open to "send" (today's behavior) on any
// miss — gate off, no phone, GrowthBook unreachable, feature absent.
async function heldBackByExperiment(intent, maxActivityBefore) {
  try {
    const assignment = await Experiments.assignBookingRecoveryExperiment(last10(intent.phone), intent.id);
    if (!(assignment.inExperiment && assignment.value === false)) return false;
    // followup_sms_sent_at intentionally NOT stamped — nothing was sent, and
    // that timestamp only exists to pace the email touch after a real SMS.
    // Claim under the SAME eligibility predicates as claimStage: if the
    // visitor converted, got suppressed, or resumed the form (fresh
    // last_activity_at) between the candidate SELECT and this UPDATE, the
    // claim loses and the row is left alone — a later re-abandon re-claims
    // under sticky control. The person is control-arm either way, so this
    // tick still sends nothing.
    const claimQuery = db('booking_intents')
      .where({ id: intent.id })
      .whereNull('converted_at')
      .where('suppressed', false);
    if (maxActivityBefore) claimQuery.where('last_activity_at', '<', maxActivityBefore);
    const affected = await claimQuery.update({
      followup_sms_sent: true,
      followup_email_sent: true,
      updated_at: db.fn.now(),
    });
    logger.info(`[booking-recovery] intent ${intent.id} held back (experiment control) — no touches${affected === 1 ? '' : ' (claim lost — converted/suppressed/resumed since select)'}`);
    return true;
  } catch (e) {
    logger.warn(`[booking-recovery] holdback check failed for intent ${intent.id} — sending as usual: ${e.message}`);
    return false;
  }
}

// Atomic stage claim — flips false/NULL → true, returns true only if THIS caller
// won. (The cron is single-instance via runExclusive, but the claim also guards
// an accidental overlap and pairs with release-on-failure.)
async function claimStage(intentId, flag, maxActivityBefore) {
  // Keep ALL eligibility predicates IN the atomic claim: if /booking/confirm, a
  // suppression, OR a fresh /capture-intent (the visitor returned and bumped
  // last_activity_at) lands between the candidate SELECT and this UPDATE, the
  // claim must lose (0 rows) so we never send to someone who already booked, opted
  // out, or is actively filling the form again.
  const q = db('booking_intents')
    .where({ id: intentId })
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((qq) => qq.where(flag, false).orWhereNull(flag));
  if (maxActivityBefore) q.where('last_activity_at', '<', maxActivityBefore);
  const affected = await q.update({ [flag]: true, updated_at: db.fn.now() });
  return affected === 1;
}

async function releaseStage(intentId, flag) {
  await db('booking_intents').where({ id: intentId }).update({ [flag]: false, updated_at: db.fn.now() });
}

// After a successful send to a phone, mark any OTHER open intents for the same
// phone as sent too, so a person who started /book twice gets ONE recovery touch.
async function markSiblingsSent(phone, flag, excludeId) {
  const ten = last10(phone);
  if (!ten) return;
  try {
    const patch = { [flag]: true, updated_at: db.fn.now() };
    // Marking SMS siblings sent must also stamp followup_sms_sent_at, or a sibling
    // intent would keep a NULL timestamp and the email stage could fire ~23h early
    // for it on a later tick (the in-run sentPhones guard only covers this tick).
    if (flag === 'followup_sms_sent') patch.followup_sms_sent_at = db.fn.now();
    await db('booking_intents')
      .whereNot('id', excludeId)
      .whereNull('converted_at')
      .where((q) => q.where(flag, false).orWhereNull(flag))
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .update(patch);
  } catch (e) {
    logger.warn(`[booking-recovery] sibling mark failed (non-blocking): ${e.message}`);
  }
}

function firstNameOf(intent) {
  // SECURITY: client-supplied + interpolated into the message, so strip anything
  // that isn't a plausible name character (no URLs / markup / injection payloads),
  // take the first token, cap length, and fall back to a generic greeting.
  const raw = String(intent.first_name || '').trim().split(/\s+/)[0] || '';
  const clean = raw.replace(/[^\p{L}\p{M}'’-]/gu, '').slice(0, 40);
  return clean || 'there';
}

// SECURITY: the recovery SMS/email interpolates this label, and an attacker
// controls both the captured recipient AND the posted service_type, so NEVER put
// the raw client string into the message — that would let them craft arbitrary
// copy sent from the Waves sender. Derive the label server-side from the
// validated service_id allowlist; unknown/absent → a generic phrase.
const SERVICE_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito Control',
  tree_shrub: 'Tree & Shrub',
  termite: 'Termite Inspection',
  rodent: 'Rodent Control',
  bora_care: 'Bora-Care Wood Treatment',
};
function serviceLabelOf(intent) {
  return SERVICE_LABELS[String(intent.service_id || '').trim()] || 'your service';
}

async function bookingUrlFor(intent) {
  // Carry the abandoned service so the recovery link preselects it — without
  // ?service=, /book defaults to pest_control, which would mis-route a lawn /
  // mosquito / tree-shrub abandoner into the wrong service flow + recurrence.
  let url = BOOKING_URL;
  const sid = String(intent.service_id || '').trim();
  if (/^[a-z_]{1,40}$/.test(sid)) url += `&service=${encodeURIComponent(sid)}`;
  // Quote→book handoff: re-carry the pricing estimate reference captured with
  // the intent (HMAC-verified at capture), so a booking made from the recovery
  // link still prices from that exact quote (pay-at-visit) instead of landing
  // unpriced. Re-check the token is STILL valid before sending — an expired one
  // would just be ignored at confirm, but the link shouldn't carry a dead
  // promise. /booking/confirm re-verifies everything fail-closed (token, draft
  // status, eligibility, customer match) — this only restores the reference.
  const { verifyEstimateHandoffToken } = require('../utils/estimate-handoff-token');
  if (intent.pricing_estimate_id && intent.pricing_estimate_token
      && verifyEstimateHandoffToken(intent.pricing_estimate_id, intent.pricing_estimate_token)) {
    url += `&estimate_id=${encodeURIComponent(intent.pricing_estimate_id)}`
      + `&estimate_token=${encodeURIComponent(intent.pricing_estimate_token)}`;
  }
  return shortenOrPassthrough(url, {
    kind: 'booking', entityType: 'booking_intents', entityId: intent.id, customerId: intent.customer_id || null,
  }).catch(() => url);
}

// ── SMS stage (touch 1) ────────────────────────────────────────────────────
async function runSmsStage(now, sentPhones) {
  const nowMs = now.getTime();
  const candidates = await db('booking_intents')
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((q) => q.where('followup_sms_sent', false).orWhereNull('followup_sms_sent'))
    // Window on last_activity_at (last funnel touch), not captured_at, so we
    // never text someone who is still actively filling out the booking form.
    .where('last_activity_at', '<', new Date(nowMs - SMS_MIN_AGE_H * 3600000))
    .where('last_activity_at', '>', new Date(nowMs - SMS_MAX_AGE_H * 3600000))
    .whereNotNull('phone')
    .orderBy('last_activity_at', 'desc')
    .select('*');

  if (!candidates.length) return 0;
  if (!isEnabled('bookingAbandonRecovery')) {
    logger.info(`[booking-recovery] SMS shadow: ${candidates.length} candidate(s), gate off — no sends`);
    return 0;
  }

  let sent = 0;
  for (const intent of candidates) {
    const ten = last10(intent.phone);
    if (ten && sentPhones.has(ten)) continue; // one touch per phone per run
    if (await heldBackByExperiment(intent, new Date(nowMs - SMS_MIN_AGE_H * 3600000))) continue;
    let claimed = false;
    try {
      if (isQuietHours(now)) continue;
      if (await hasRepliedRecently(intent.phone)) {
        logger.info(`[booking-recovery] SMS skip ${intent.id}: customer-replied-recently`);
        continue;
      }
      const body = await renderSms({
        first_name: firstNameOf(intent),
        service_type: serviceLabelOf(intent),
        booking_url: await bookingUrlFor(intent),
      });
      if (!body) continue; // missing template — don't claim, retry next tick

      if (!(await claimStage(intent.id, 'followup_sms_sent', new Date(nowMs - SMS_MIN_AGE_H * 3600000)))) continue;
      claimed = true;
      // Re-check AFTER claiming: a booking landing between the candidate SELECT and
      // the claim — esp. a CSR-created scheduled_services row that doesn't set the
      // intent's converted_at — must not be texted. `continue` releases the claim.
      if (await hasActiveBooking(intent)) {
        logger.info(`[booking-recovery] SMS skip ${intent.id}: booked after select (pre-send recheck)`);
        continue;
      }

      const result = await sendCustomerMessage({
        to: intent.phone,
        body,
        channel: 'sms',
        audience: intent.customer_id ? 'customer' : 'lead',
        purpose: 'booking_abandonment_followup',
        customerId: intent.customer_id || undefined,
        identityTrustLevel: intent.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
        consentBasis: intent.customer_id ? undefined : {
          status: 'transactional_allowed',
          source: 'booking_abandon_recovery',
          capturedAt: intent.captured_at || new Date().toISOString(),
        },
        entryPoint: 'booking_abandon_recovery_cron',
        metadata: { original_message_type: 'booking_abandon_recovery', booking_intent_id: intent.id },
      });

      if (result && result.sent !== false && !result.blocked) {
        sent++;
        claimed = false;
        if (ten) sentPhones.add(ten);
        // Stamp when the SMS actually went out so the 24h email is held to ~23h
        // AFTER it, even if the SMS itself fired late (gate/quiet-hours/outage).
        await db('booking_intents').where({ id: intent.id })
          .update({ followup_sms_sent_at: db.fn.now() }).catch(() => {});
        await markSiblingsSent(intent.phone, 'followup_sms_sent', intent.id);
      } else {
        logger.warn(`[booking-recovery] SMS blocked for intent ${intent.id}: ${result?.code || 'unknown'} ${result?.reason || ''}`);
        // Keep the claim ONLY for a genuine TERMINAL suppression (opt-out /
        // landline / DNC), so we never re-attempt a dead number. Operational
        // blocks (CONSENT_LOOKUP_FAILED, CONTRACT_VIOLATION, …) and any retryable
        // hold sent nothing → leave the claim set → released in `finally` →
        // retried next tick. A provider-terminal failure also keeps the claim.
        if (result && ((result.code && TERMINAL_SMS_CODES.has(result.code)) || result.terminal === true)) {
          claimed = false;
        }
      }
    } catch (e) {
      logger.error(`[booking-recovery] SMS send failed for intent ${intent.id}: ${e.message}`);
    } finally {
      if (claimed) await releaseStage(intent.id, 'followup_sms_sent').catch(() => {});
    }
  }
  return sent;
}

// ── Email stage (touch 2) ──────────────────────────────────────────────────
async function runEmailStage(now, sentPhones) {
  const nowMs = now.getTime();
  const candidates = await db('booking_intents')
    .whereNull('converted_at')
    .where('suppressed', false)
    .where((q) => q.where('followup_email_sent', false).orWhereNull('followup_email_sent'))
    .where('last_activity_at', '<', new Date(nowMs - EMAIL_MIN_AGE_H * 3600000))
    .where('last_activity_at', '>', new Date(nowMs - EMAIL_MAX_AGE_H * 3600000))
    // Hold the email to ~23h AFTER the SMS actually went out, so a late first
    // touch (gate/quiet-hours/outage delayed the SMS past 24h) doesn't trigger
    // SMS-then-email back-to-back in consecutive ticks.
    .where((q) => q.whereNull('followup_sms_sent_at').orWhere('followup_sms_sent_at', '<', new Date(nowMs - 23 * 3600000)))
    .whereNotNull('email')
    .orderBy('last_activity_at', 'desc')
    .select('*');

  if (!candidates.length) return 0;
  if (!isEnabled('bookingAbandonRecovery')) {
    logger.info(`[booking-recovery] email shadow: ${candidates.length} candidate(s), gate off — no sends`);
    return 0;
  }

  let sent = 0;
  for (const intent of candidates) {
    // If we already SMS'd this phone THIS run (e.g. an intent that aged past 24h
    // while still unsent, so both stages fire in one tick), don't also email — that
    // would collapse the intended 1h SMS / 24h email cadence into a double nudge.
    const ten = last10(intent.phone);
    if (ten && sentPhones.has(ten)) continue;
    const emailKey = String(intent.email || '').trim().toLowerCase();
    if (emailKey && sentPhones.has(`email:${emailKey}`)) continue;
    // Email-stage holdback check too: an intent can reach this stage without
    // ever passing through the SMS loop (e.g. SMS window already aged out at
    // gate-flip time), and sticky replay keeps the arm consistent either way.
    if (await heldBackByExperiment(intent, new Date(nowMs - EMAIL_MIN_AGE_H * 3600000))) continue;
    let claimed = false;
    try {
      if (await customerEmailDisabled(intent.customer_id)) {
        logger.info(`[booking-recovery] email skip ${intent.id}: customer email opt-out`);
        continue;
      }
      // Reply-pause applies to the email touch too — if they're already in an SMS
      // conversation with us after abandoning, let staff handle it live.
      if (await hasRepliedRecently(intent.phone)) {
        logger.info(`[booking-recovery] email skip ${intent.id}: customer-replied-recently`);
        continue;
      }
      if (!(await claimStage(intent.id, 'followup_email_sent', new Date(nowMs - EMAIL_MIN_AGE_H * 3600000)))) continue;
      claimed = true;
      // Re-check active booking AFTER claiming (race-safe; see SMS stage).
      if (await hasActiveBooking(intent)) {
        logger.info(`[booking-recovery] email skip ${intent.id}: booked after select (pre-send recheck)`);
        continue;
      }
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'booking.abandonment_recovery',
        to: intent.email,
        payload: {
          first_name: firstNameOf(intent),
          service_type: serviceLabelOf(intent),
          booking_url: await bookingUrlFor(intent),
        },
        recipientType: intent.customer_id ? 'customer' : 'lead',
        recipientId: intent.customer_id || null,
        triggerEventId: `booking_recovery:${intent.id}`,
        idempotencyKey: `booking_recovery_email:${intent.id}`,
        categories: ['booking_recovery'],
      });
      if (result && result.blocked) {
        logger.warn(`[booking-recovery] email suppressed for intent ${intent.id}: ${result.reason || 'blocked'}`);
        // suppressed is terminal for this address — keep the claim (no retry).
        claimed = false;
      } else {
        sent++;
        claimed = false;
        if (emailKey) sentPhones.add(`email:${emailKey}`);
        await markSiblingsSent(intent.phone, 'followup_email_sent', intent.id);
      }
    } catch (e) {
      logger.error(`[booking-recovery] email send failed for intent ${intent.id}: ${e.message}`);
    } finally {
      if (claimed) await releaseStage(intent.id, 'followup_email_sent').catch(() => {});
    }
  }
  return sent;
}

async function checkAbandoned(now = new Date()) {
  const sentPhones = new Set();
  const sms = await runSmsStage(now, sentPhones);
  const email = await runEmailStage(now, sentPhones);
  return { sms, email, sent: sms + email };
}

module.exports = {
  checkAbandoned,
  _internals: { isQuietHours, hasRepliedRecently, claimStage, runSmsStage, runEmailStage, last10, bookingUrlFor },
};
