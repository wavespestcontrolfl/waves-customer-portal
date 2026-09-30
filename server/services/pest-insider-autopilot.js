/**
 * Pest Insider autopilot — monthly auto-draft of the pest deep-dive.
 *
 * Called by the Tuesday 7AM ET cron in scheduler.js; runs only on the
 * FIRST Tuesday of the month (owner decision 2026-06-11). The weekly
 * Waves Newsletter has its own Tuesday 6:00 AM lane. Never auto-sends: creates a
 * draft in newsletter_sends for admin review + manual send, exactly
 * like the weekly autopilot.
 *
 * Format: the humor-sandwich from the shipped Beehiiv "Pest Watch"
 * issues — edutainment facts → one sincere featured-service section →
 * voice-y close. The featured service auto-rotates by month
 * (PEST_INSIDER_ROTATION in newsletter-draft.js); the operator can
 * override by editing the draft or re-drafting from Compose.
 *
 * Idempotent per ET month: skips when a pest-insider-monthly send
 * already exists for the current month (any status — a deleted draft
 * does NOT resurrect, matching the weekly's deleted-draft rule).
 *
 * Proof-approval (GATE_PEST_INSIDER_PROOF, dark by default): once the
 * draft is created, sendNewsletterProof runs exactly as it does for the
 * weekly flagship — same GATE_NEWSLETTER_PROOF_APPROVAL gate underneath,
 * same idempotency on proof_sent_at, same fail-open error handling. Kill
 * switch: unset GATE_PEST_INSIDER_PROOF — draft + notification only,
 * today's behavior.
 *
 * Proof catch-up (retryPestInsiderProof, daily cron): the draft survives a
 * failed proof send, and every later autopilot call stops at the
 * already-drafted check, so without a retry one SendGrid outage would
 * silently cost the month's issue. The catch-up re-sends the proof for
 * this month's draft while it is still an unproofed draft, through the
 * 10th of the ET month. A draft the validator blocks fails the same way
 * every day until someone edits it, and the owner was told the first time
 * (sendNewsletterProof notifies on a blocked draft), so the catch-up skips
 * it quietly unless the draft was edited since the LAST PROOF ATTEMPT that
 * ended in an owner-notified, deterministic block (the validator, or a
 * segment matching nobody) — every attempt is stamped in audit_log with its
 * outcome and the block is re-checked live; the creation-time proof on the
 * first Tuesday counts, so the same-day catch-up never repeats its notice,
 * while an attempt that never reached those checks (gate off, SendGrid
 * unconfigured) suppresses nothing.
 *
 * A draft that cannot be written at all (the fact register empty, the
 * writer down) is reported to the owner through the same
 * newsletter_proof_blocked notification and then rethrown, so the
 * scheduler's exclusive job records a failure: the month's issue is
 * otherwise silently missing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts, etDateString } = require('../utils/datetime-et');

const PEST_INSIDER_TYPE = 'pest-insider-monthly';
// Last ET day of the month the catch-up still proofs a draft. The issue is
// drafted on the first Tuesday (day 1–7); three more days covers an outage
// without proofing a stale draft late in the month.
const PROOF_RETRY_LAST_DAY = 10;
// Every proof attempt this module makes is recorded here (audit_log), so the
// catch-up can tell "edited since the last attempt" from "same blocked
// draft as yesterday" without guessing from timestamps.
const PROOF_ATTEMPT_ACTION = 'newsletter.pest_insider_proof_attempted';
// sendNewsletterProof outcomes that come from the locked event lineup (live
// official-page recheck, eligibility) rather than the validator or audience.
const LIVE_RECHECK_REASONS = new Set(['live_reverify_failed', 'event_selection_invalid']);

function proofGateOn() {
  return require('../config/feature-gates').pestInsiderProofLive();
}

// sendNewsletterProof is itself gated behind GATE_NEWSLETTER_PROOF_APPROVAL
// and idempotent on proof_sent_at. It reports most failures as a RESULT
// ({ skipped: true, reason }: a SendGrid failure is 'proof_send_failed', a
// blocked draft 'validation_failed', the shared gate off 'gate_off'), not
// by throwing — so "no exception" is not "proof sent". Only { sent: true }
// counts. Nothing here throws: the draft is already saved and the catch-up
// tries again.
async function sendProofFor(sendId) {
  let outcome;
  try {
    const { sendNewsletterProof } = require('./newsletter-proof');
    const result = await sendNewsletterProof(sendId);
    if (result?.sent === true) outcome = { sent: true, reason: null, notified: false };
    else {
      const reason = result?.reason || 'unknown';
      logger.warn(`[pest-insider-autopilot] proof not sent for ${sendId}: ${reason}`);
      // `notified` is sendNewsletterProof's word that the owner's blocked
      // notice was DELIVERED — a swallowed notification failure is not one.
      outcome = { sent: false, reason, notified: result?.notified === true };
    }
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] proof send failed: ${e.message}`);
    outcome = { sent: false, reason: 'threw', notified: false };
  }
  await recordProofAttempt(sendId, outcome);
  return outcome;
}

// Non-critical: a missing stamp only means the next catch-up tries again.
async function recordProofAttempt(sendId, outcome) {
  try {
    await require('./audit-log').recordAuditEvent({
      actor_type: 'system',
      action: PROOF_ATTEMPT_ACTION,
      resource_type: 'newsletter_sends',
      resource_id: sendId,
      metadata: { sent: outcome.sent, reason: outcome.reason, notified: outcome.notified === true },
    });
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] could not record the proof attempt: ${e.message}`);
  }
}

// The latest recorded attempt: when it ran and how it ended.
async function lastProofAttempt(sendId) {
  try {
    const last = await db('audit_log')
      .where({ action: PROOF_ATTEMPT_ACTION, resource_type: 'newsletter_sends', resource_id: sendId })
      .orderBy('created_at', 'desc')
      .first('created_at', 'metadata');
    if (!last?.created_at) return null;
    const meta = typeof last.metadata === 'string' ? JSON.parse(last.metadata || '{}') : (last.metadata || {});
    return { at: new Date(last.created_at), reason: meta.reason || null, notified: meta.notified === true };
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] could not read the last proof attempt: ${e.message}`);
    return null;
  }
}

/**
 * First-Tuesday gate. node-cron's day-of-month × day-of-week semantics
 * are not portable, so the cron fires every Tuesday and this guard
 * keeps only the first one (ET day-of-month 1-7).
 */
function isFirstTuesdayET(now = new Date()) {
  const parts = etParts(now);
  return parts.dayOfWeek === 2 && parts.day >= 1 && parts.day <= 7;
}

/**
 * ET month window [start, nextStart) as Date bounds for the
 * already-drafted-this-month idempotency check.
 */
function etMonthBounds(now = new Date()) {
  const { parseETDateTime } = require('../utils/datetime-et');
  const parts = etParts(now);
  const mm = String(parts.month).padStart(2, '0');
  const start = parseETDateTime(`${parts.year}-${mm}-01T00:00:00`);
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const nm = String(nextMonth).padStart(2, '0');
  const end = parseETDateTime(`${nextYear}-${nm}-01T00:00:00`);
  return { start, end };
}

async function runPestInsiderAutopilot({ now = new Date() } = {}) {
  if (!isFirstTuesdayET(now)) {
    return { skipped: true, reason: 'not the first Tuesday (ET)' };
  }

  const { start, end } = etMonthBounds(now);
  const existing = await db('newsletter_sends')
    .where('newsletter_type', PEST_INSIDER_TYPE)
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .first();
  if (existing) {
    return { skipped: true, reason: `already drafted this month (send ${existing.id})` };
  }

  const month = new Date(now).toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const { createNewsletterDraft } = require('./newsletter-draft');
  let created;
  try {
    created = await createNewsletterDraft({
      prompt: `Monthly Pest Insider for ${month} (${etDateString(now)}). Use this month's featured service from the rotation.`,
      newsletterType: PEST_INSIDER_TYPE,
    });
  } catch (err) {
    // Tell the owner, then FAIL the job: runExclusive records the outcome
    // in job health, and a month with no draft must not read as a success
    // there (codex round 6 P2) — especially if the notice also failed.
    logger.error(`[pest-insider-autopilot] draft failed: ${err.message}`);
    await notifyDraftFailed(month, err);
    throw err;
  }
  const { send, draft } = created;

  logger.info(`[pest-insider-autopilot] drafted send ${send.id}: ${send.subject}`);

  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('pest_insider_draft', {
      sendId: send.id,
      subject: send.subject,
      month,
    });
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] draft notification failed: ${e.message}`);
  }

  // Proof-approval flow (GATE_PEST_INSIDER_PROOF, dark by default — kill =
  // unset, today's behavior: draft + notification only). Read at call time,
  // same as its neighbour gates; mirrors the flagship autopilot's call.
  if (proofGateOn()) await sendProofFor(send.id);

  return { skipped: false, sendId: send.id, subject: send.subject, voiceWarnings: draft.voiceWarnings };
}

/**
 * Proof catch-up: re-send the proof for this ET month's Pest Insider draft
 * when it is still a draft with no proof on record. A deleted or sent issue
 * is not status 'draft' and is never touched; a proof already on record
 * (proof_sent_at set) is never re-sent.
 */
async function retryPestInsiderProof({ now = new Date() } = {}) {
  if (!proofGateOn()) return { skipped: true, reason: 'proof gate off' };
  // The day-10 cutoff keeps a stale, never-proofed draft from being proofed
  // late in the month. It does not apply to a CORRECTED draft: one whose
  // proof was sent and then released by a refused approval (proof_sent_at
  // cleared, proof_refused_at stamped) and that passes
  // validation now — without this it could never be
  // re-proofed after day 10 (codex #5187 follow-up). That draft is checked
  // below, once it is loaded.
  const pastCutoff = etParts(now).day > PROOF_RETRY_LAST_DAY;
  const pastCutoffSkip = { skipped: true, reason: `past day ${PROOF_RETRY_LAST_DAY} of the month (ET)` };

  const { start, end } = etMonthBounds(now);
  const draft = await db('newsletter_sends')
    .where('newsletter_type', PEST_INSIDER_TYPE)
    .where('status', 'draft')
    .whereNull('proof_sent_at')
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .first();
  if (!draft) return pastCutoff ? pastCutoffSkip : { skipped: true, reason: 'no unproofed draft this month' };
  if (pastCutoff && !(approvalWasRefused(draft) && !(await draftFailsValidation(draft)))) {
    return pastCutoffSkip;
  }

  // Deterministic failure: the validator blocks this draft, nobody has
  // edited it since the last proof attempt, and that attempt ended in
  // 'validation_failed' — the one outcome where sendNewsletterProof already
  // notified the owner — so retrying would only re-send that notice. An
  // attempt that ended earlier in the flow (gate off, no approver, SendGrid
  // not configured, a throw) told the owner nothing, and no attempt on
  // record (the gate was off when the issue was drafted) means the same:
  // attempt, so the owner is told once.
  const lastAttempt = await lastProofAttempt(draft.id);
  if (lastAttempt?.notified && !editedSince(draft, lastAttempt.at)) {
    // Only an attempt whose blocked notice was DELIVERED counts as "the owner
    // was told" (a swallowed notification failure suppresses nothing). Each
    // reason below stays true until something changes: the draft
    // (validation) or the audience (zero recipients). Re-checked live, so a
    // fixed draft or a grown segment is proofed on the next tick.
    if (lastAttempt.reason === 'validation_failed' && await draftFailsValidation(draft)) {
      logger.info(`[pest-insider-autopilot] proof catch-up skipped for ${draft.id}: draft still fails validation and has not been edited since the last attempt`);
      return { skipped: true, reason: 'validation_failed', sendId: draft.id };
    }
    // A blocked live event recheck / event selection is deterministic for an
    // unedited draft too: the notice already told the owner to swap the
    // event, and only an edit (a new lineup) changes the answer. Without this
    // a refusal after the day-10 cutoff (proof_refused_at set, validator
    // passing) would be re-proofed — and re-notified — on every tick for the
    // rest of the month (codex #5414 round 3 P2). The edit check above is the
    // whole test: a corrected draft has updated_at after the last attempt and
    // is re-proofed once.
    if (LIVE_RECHECK_REASONS.has(lastAttempt.reason)) {
      logger.info(`[pest-insider-autopilot] proof catch-up skipped for ${draft.id}: ${lastAttempt.reason} and the draft has not been edited since the last attempt`);
      return { skipped: true, reason: lastAttempt.reason, sendId: draft.id };
    }
    if (lastAttempt.reason === 'zero_recipients' && await audienceStillEmpty(draft)) {
      logger.info(`[pest-insider-autopilot] proof catch-up skipped for ${draft.id}: segment still matches 0 subscribers since the last attempt`);
      return { skipped: true, reason: 'zero_recipients', sendId: draft.id };
    }
  }

  const proof = await sendProofFor(draft.id);
  return { skipped: false, sendId: draft.id, proofSent: proof.sent, reason: proof.reason };
}

// True when an approval reply was refused for this draft: the releases in
// newsletter-proof.js that clear proof_sent_at after a refused approval stamp
// proof_refused_at. It is its own column — not proof_approval_email_id, which
// survives a cancelled schedule — and cancel-schedule, the PATCH invalidation
// and every scheduler/sender revert-to-draft clear it, so an approval the
// owner cancelled can never look like a refusal.
function approvalWasRefused(draft) {
  return Boolean(draft?.proof_refused_at) && !draft.proof_approved_at;
}

function editedSince(draft, at) {
  const edited = draft?.updated_at ? new Date(draft.updated_at).getTime() : NaN;
  return Number.isFinite(edited) && edited > at.getTime();
}

// Fail OPEN to the proof path: if the pre-check itself breaks, the proof
// send runs the same validator and reports the outcome as before.
async function draftFailsValidation(draft) {
  try {
    const { validateNewsletterDraft, lockedPricesForSend } = require('./newsletter-validator');
    const lockedPrices = await lockedPricesForSend(draft, db);
    const { errors } = validateNewsletterDraft(draft, { lockedPrices });
    return Array.isArray(errors) && errors.length > 0;
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] validation pre-check failed: ${e.message}`);
    return false;
  }
}

// Fail OPEN to the proof path, same as the validation pre-check.
async function audienceStillEmpty(draft) {
  try {
    const { countSegmentRecipients } = require('./newsletter-sender');
    return (await countSegmentRecipients(draft.segment_filter)) === 0;
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] audience pre-check failed: ${e.message}`);
    return false;
  }
}

async function notifyDraftFailed(month, err) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('newsletter_proof_blocked', {
      subject: `Pest Insider — ${month}`,
      errors: [`The draft was not written: ${err.message}`],
    });
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] draft-failure notification failed: ${e.message}`);
  }
}

module.exports = {
  runPestInsiderAutopilot,
  retryPestInsiderProof,
  isFirstTuesdayET,
  etMonthBounds,
  PEST_INSIDER_TYPE,
};
