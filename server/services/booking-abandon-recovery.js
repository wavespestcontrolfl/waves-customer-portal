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
 * per-stage atomic claim flags, reply-pause, transactional consent,
 * release-on-failure so a blocked send retries next tick. Runs from scheduler.js.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const { shortenOrPassthrough } = require('./short-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { gsmSafeName, normalizeGsmPunctuation } = require('./messaging/gsm-normalize');
const { countSegments } = require('./messaging/segment-counter');
const { isEnabled } = require('../config/feature-gates');
const { establishedContactLinkedDraft } = require('./booking-contact-linked-handoff');
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
// (CONSENT_LOOKUP_FAILED / CONTRACT_VIOLATION / UNKNOWN_POLICY / PROVIDER_FAILURE)
// sent nothing operationally → release the claim and retry.
const TERMINAL_SMS_CODES = new Set([
  'SMS_OPTED_OUT', 'PURPOSE_OPTED_OUT', 'NO_MARKETING_CONSENT', 'NO_CONSENT_RECORD',
  'SUPPRESSED_OPT_OUT', 'SUPPRESSED_NON_MOBILE', 'SUPPRESSED_MANUAL_DNC',
  'SUPPRESSED_WRONG_NUMBER', 'SUPPRESSED_OTHER', 'NON_MOBILE_SMS_RECIPIENT',
]);

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
      // Recruiting replies (job_*, PR #4623) are never customer context.
      .where((q) => { q.whereNull('messages.message_type').orWhere('messages.message_type', 'not like', 'job\\_%'); })
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

// Structural backstop for the B11 contact-linked quote-wizard handoff. With
// the customers-only booking gate on, a draft linked to an ESTABLISHED
// customer (by the unverified contact an anonymous quoter typed) can never
// book without the portal OTP, so it must never message that customer about
// "almost booking". capture-intent and the refused confirm already retire
// such intents, but those writes are best effort — this re-checks at SEND
// time, so a failed suppression write can never lead to a message. A hit is
// marked suppressed (best effort) and skipped; a LOOKUP ERROR fails closed
// (skip this tick, retry next). Gate off → the flow still books, so nothing
// here applies.
async function blockedByContactLinkedHandoff(intent) {
  if (!intent.pricing_estimate_id || !isEnabled('bookingCustomersOnly')) return false;
  try {
    if (!(await establishedContactLinkedDraft(db, intent.pricing_estimate_id))) return false;
  } catch (e) {
    logger.warn(`[booking-recovery] contact-link check failed for intent ${intent.id} — skipping (fail closed): ${e.message}`);
    return true;
  }
  logger.info(`[booking-recovery] skip ${intent.id}: handoff draft is contact-linked to an established customer`);
  await db('booking_intents').where({ id: intent.id }).update({ suppressed: true, updated_at: db.fn.now() }).catch(() => {});
  return true;
}

// A visitor who filed a /book "Can't find a time?" request asked the office to
// reach out by hand — never send them an automated recovery text or email
// afterwards (GATE_BOOK_PREFERRED_TIME). The submit suppresses their open
// intents and capture-intent skips them, but both are best effort / racy, so
// this re-checks at SEND time whatever the gate currently reads (a request
// already filed still blocks). A hit is marked suppressed (best effort); a
// LOOKUP ERROR fails closed (skip this tick, retry next).
async function blockedByPreferredTimeRequest(intent, conn = db) {
  try {
    const { hasRecentPreferredTimeRequest } = require('./booking-preferred-time');
    const hit = await hasRecentPreferredTimeRequest(conn, last10(intent.phone), {
      sessionId: intent.session_id || null,
      since: intent.captured_at || null,
    });
    if (!hit) return false;
  } catch (e) {
    logger.warn(`[booking-recovery] preferred-time check failed for intent ${intent.id} — skipping (fail closed): ${e.message}`);
    return true;
  }
  logger.info(`[booking-recovery] skip ${intent.id}: visitor asked the office for a preferred time`);
  // On `conn`: inside withLockedRecoveryIntent the row is locked by that
  // transaction, and a write on any other connection would wait on it forever.
  await conn('booking_intents').where({ id: intent.id }).update({ suppressed: true, updated_at: conn.fn.now() }).catch(() => {});
  return true;
}

// The ONE serialization point with a preferred-time submit
// (booking-preferred-time.js): the FINAL check and the dispatch run holding a
// row lock (SELECT ... FOR UPDATE) on the intent row itself. A submit suppresses
// the same row in its own transaction before it commits the lead, so
//   - submit first: this SELECT waits for its commit, re-reads the row as
//     suppressed (or sees the committed lead) and sends nothing;
//   - worker first: the submit's UPDATE waits until the send is done, so the
//     send counts as already happened.
// It keys on the ROW, not the phone: a visitor who corrects their phone
// mid-session (one intent row per session) cannot slip past a lock keyed on the
// old number. Fail closed — a lock/lookup/transaction error propagates (caller:
// nothing sent, claim released, retried next tick). `fn` runs INSIDE the
// transaction and must not write booking_intents on another connection; do the
// post-send bookkeeping after this returns. Returns { skipped: <reason> } when
// nothing may be sent, else { skipped: null, value: fn()'s result }.
async function withLockedRecoveryIntent(database, intent, fn) {
  let dispatched = null;
  try {
    return await database.transaction(async (trx) => {
      const row = await trx('booking_intents').where({ id: intent.id }).forUpdate()
        .first('id', 'phone', 'session_id', 'captured_at', 'suppressed', 'converted_at');
      if (!row || row.suppressed || row.converted_at) return { skipped: 'closed' };
      // Contact edited since the candidate read: the message would go to a number
      // the visitor already replaced. Skip; the next tick reads the fresh row.
      if (last10(row.phone) !== last10(intent.phone)) return { skipped: 'contact_changed' };
      if (await blockedByPreferredTimeRequest({ ...intent, ...row }, trx)) return { skipped: 'preferred_time' };
      dispatched = { skipped: null, value: await fn() };
      return dispatched;
    });
  } catch (err) {
    // The send already happened and only the COMMIT failed (nothing was written
    // in the transaction that matters): report it as sent, or the released
    // claim would double-send next tick.
    if (dispatched) {
      logger.warn(`[booking-recovery] intent ${intent.id}: send done but the row-lock transaction failed to close: ${err.message}`);
      return dispatched;
    }
    throw err;
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
      // noVariants: the one-segment guard below pre-renders and may re-render
      // with a generic greeting — both must be the SAME body (the rain-out
      // custom rung pins the base row for the same reason).
      const body = await smsTemplatesRouter.getTemplate('booking_abandonment_recovery', vars, {
        workflow: 'booking_abandon_recovery', entity_type: 'booking_intent',
      }, { noVariants: true });
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
// PERSON (phone last-10 — the same key the send-dedup uses), before the
// reply-pause filter so both arms are measured from the same point. A
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
  bora_care: 'Bora-Care Wood Treatment Service',
};
function serviceLabelOf(intent) {
  return SERVICE_LABELS[String(intent.service_id || '').trim()] || 'your service';
}
// The recovery TEXT only (owner, 2026-09-07): the one label that cannot fit a
// single segment. The email keeps the canonical name.
const SMS_SERVICE_LABELS = { bora_care: 'Bora-Care' };
function smsServiceLabelOf(intent) {
  const key = String(intent.service_id || '').trim();
  // Owner report 2026-09-28: an unknown/bundle service id fell back to the
  // email path's 'your service', rendering "Your your service spot…" — the
  // template already says "Your". The SMS path's own fallback is just
  // 'service'; the email path's serviceLabelOf/'your service' is untouched.
  return SMS_SERVICE_LABELS[key] || SERVICE_LABELS[key] || 'service';
}

async function bookingUrlFor(intent) {
  // Carry the abandoned service so the recovery link preselects it — without
  // ?service=, /book defaults to pest_control, which would mis-route a lawn /
  // mosquito / tree-shrub abandoner into the wrong service flow + recurrence.
  let url = BOOKING_URL;
  const sid = String(intent.service_id || '').trim();
  // '+' admits composite multi-service ids (a+b+c) so a bundle abandoner
  // recovers into the same bundle, not the default pest flow (#2957).
  if (/^[a-z_+]{1,60}$/.test(sid)) url += `&service=${encodeURIComponent(sid)}`;
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

// One segment (owner, 2026-09-07 — multi-segment texts have failed to
// deliver): the name is GSM-folded first (one non-GSM character would flip
// the whole text to UCS-2 and three segments); if the render still spills
// past a single segment the only variable part worth dropping is the name,
// so it is re-rendered with the generic greeting. A body that still exceeds
// one segment (the shortener down → full-length link; an /admin edit that
// outgrew the budget) is NOT sent: null here means no claim, so the intent is
// retried next tick — a recovered shortener fixes the first case by itself,
// and the warning names the second for /admin.
// Counts are taken on the body as it will leave (sendCustomerMessage
// normalizes typographic punctuation first), so a curly quote in an /admin
// edit does not make every candidate look like three UCS-2 segments.
const segmentsOf = (body) => countSegments(normalizeGsmPunctuation(body)).segmentCount;
async function renderOneSegmentSms(intent) {
  const vars = {
    first_name: gsmSafeName(firstNameOf(intent)),
    service_type: smsServiceLabelOf(intent),
    booking_url: await bookingUrlFor(intent),
  };
  let body = await renderSms(vars);
  if (!body) return body;
  let segments = segmentsOf(body);
  if (segments > 1 && vars.first_name !== 'there') {
    const generic = await renderSms({ ...vars, first_name: 'there' });
    if (generic && segmentsOf(generic) < segments) {
      body = generic;
      segments = segmentsOf(body);
    }
  }
  if (segments > 1) {
    logger.warn(`[booking-recovery] SMS for intent ${intent.id} would be ${segments} segments (${countSegments(normalizeGsmPunctuation(body)).encoding}) — not sent; retried next tick (shortener down, or the template in /admin outgrew one segment)`);
    return null;
  }
  return body;
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
      if (await hasRepliedRecently(intent.phone)) {
        logger.info(`[booking-recovery] SMS skip ${intent.id}: customer-replied-recently`);
        continue;
      }
      if (await blockedByContactLinkedHandoff(intent)) continue;
      if (await blockedByPreferredTimeRequest(intent)) continue;
      const body = await renderOneSegmentSms(intent);
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
      // B11 last look, AFTER the claim and immediately before the send: the
      // pre-claim check above is a cheap filter, but a promotion to
      // established (or a new established sibling) can land between it and
      // here. Blocked or lookup error → nothing is sent; `continue` releases
      // the claim and a hit is already marked suppressed.
      if (await blockedByContactLinkedHandoff(intent)) continue;

      // The preferred-time last look AND the send run holding the intent row's
      // lock (withLockedRecoveryIntent): a preferred-time submit cannot land
      // between the check and the send. A lock or lookup failure throws/blocks
      // → nothing sent, claim released, retried next tick.
      const dispatch = await withLockedRecoveryIntent(db, intent, () => sendCustomerMessage({
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
      }));
      if (dispatch.skipped) {
        logger.info(`[booking-recovery] SMS skip ${intent.id}: ${dispatch.skipped} (final check under the row lock)`);
        continue;
      }
      const result = dispatch.value;

      if (result && result.sent !== false && !result.blocked) {
        sent++;
        claimed = false;
        if (ten) sentPhones.add(ten);
        // Stamp when the SMS actually went out so the 24h email is held to ~23h
        // AFTER it, even if the SMS itself fired late (gate/outage).
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
    // touch (gate/outage delayed the SMS past 24h) doesn't trigger
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
      if (await blockedByContactLinkedHandoff(intent)) continue;
      if (await blockedByPreferredTimeRequest(intent)) continue;
      if (!(await claimStage(intent.id, 'followup_email_sent', new Date(nowMs - EMAIL_MIN_AGE_H * 3600000)))) continue;
      claimed = true;
      // Re-check active booking AFTER claiming (race-safe; see SMS stage).
      if (await hasActiveBooking(intent)) {
        logger.info(`[booking-recovery] email skip ${intent.id}: booked after select (pre-send recheck)`);
        continue;
      }
      const bookingUrl = await bookingUrlFor(intent);
      // B11 last look, AFTER the claim and right before dispatch (see the SMS
      // stage): blocked or lookup error → no send, claim released.
      if (await blockedByContactLinkedHandoff(intent)) continue;
      // Preferred-time last look + send under the intent row's lock (see the
      // SMS stage): a submit cannot land between the check and the send.
      const dispatch = await withLockedRecoveryIntent(db, intent, () => EmailTemplateLibrary.sendTemplate({
        templateKey: 'booking.abandonment_recovery',
        to: intent.email,
        payload: {
          first_name: firstNameOf(intent),
          service_type: serviceLabelOf(intent),
          booking_url: bookingUrl,
        },
        recipientType: intent.customer_id ? 'customer' : 'lead',
        recipientId: intent.customer_id || null,
        triggerEventId: `booking_recovery:${intent.id}`,
        idempotencyKey: `booking_recovery_email:${intent.id}`,
        // Provenance only: the quote the caller was pricing, so a later customer sees this mail.
        linkEstimateId: intent.pricing_estimate_id || null,
        categories: ['booking_recovery'],
      }));
      if (dispatch.skipped) {
        logger.info(`[booking-recovery] email skip ${intent.id}: ${dispatch.skipped} (final check under the row lock)`);
        continue;
      }
      const result = dispatch.value;
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
  _internals: { blockedByContactLinkedHandoff, blockedByPreferredTimeRequest, withLockedRecoveryIntent, hasRepliedRecently, claimStage, runSmsStage, runEmailStage, last10, bookingUrlFor, SERVICE_LABELS, SMS_SERVICE_LABELS, renderOneSegmentSms },
};
