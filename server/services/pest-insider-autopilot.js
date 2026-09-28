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
 * it quietly unless the draft was edited since the last daily tick.
 *
 * A draft that cannot be written at all (the fact register empty, the
 * writer down) is reported to the owner through the same
 * newsletter_proof_blocked notification instead of only a log line: the
 * month's issue is otherwise silently missing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts, etDateString } = require('../utils/datetime-et');

const PEST_INSIDER_TYPE = 'pest-insider-monthly';
// Last ET day of the month the catch-up still proofs a draft. The issue is
// drafted on the first Tuesday (day 1–7); three more days covers an outage
// without proofing a stale draft late in the month.
const PROOF_RETRY_LAST_DAY = 10;
// A blocked draft edited within this window gets a fresh proof attempt (and
// the owner a fresh blocked notice if it still fails); older ones are skipped
// quietly — the daily tick is 24h, so this catches an edit since the last one.
const RECENT_EDIT_MS = 25 * 60 * 60 * 1000;

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
  try {
    const { sendNewsletterProof } = require('./newsletter-proof');
    const result = await sendNewsletterProof(sendId);
    if (result?.sent === true) return { sent: true, reason: null };
    const reason = result?.reason || 'unknown';
    logger.warn(`[pest-insider-autopilot] proof not sent for ${sendId}: ${reason}`);
    return { sent: false, reason };
  } catch (e) {
    logger.warn(`[pest-insider-autopilot] proof send failed: ${e.message}`);
    return { sent: false, reason: 'threw' };
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
    logger.error(`[pest-insider-autopilot] draft failed: ${err.message}`);
    await notifyDraftFailed(month, err);
    return { skipped: true, reason: 'draft_failed', error: err.message };
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
  if (etParts(now).day > PROOF_RETRY_LAST_DAY) {
    return { skipped: true, reason: `past day ${PROOF_RETRY_LAST_DAY} of the month (ET)` };
  }

  const { start, end } = etMonthBounds(now);
  const draft = await db('newsletter_sends')
    .where('newsletter_type', PEST_INSIDER_TYPE)
    .where('status', 'draft')
    .whereNull('proof_sent_at')
    .where('created_at', '>=', start)
    .where('created_at', '<', end)
    .first();
  if (!draft) return { skipped: true, reason: 'no unproofed draft this month' };

  // Deterministic failure: the validator blocks this draft, nobody has
  // edited it since the last tick, and the owner was notified when the
  // proof was first attempted — retrying would only re-send that notice.
  if (!editedRecently(draft, now) && await draftFailsValidation(draft)) {
    logger.info(`[pest-insider-autopilot] proof catch-up skipped for ${draft.id}: draft still fails validation and has not been edited`);
    return { skipped: true, reason: 'validation_failed', sendId: draft.id };
  }

  const proof = await sendProofFor(draft.id);
  return { skipped: false, sendId: draft.id, proofSent: proof.sent, reason: proof.reason };
}

function editedRecently(draft, now) {
  const at = draft?.updated_at ? new Date(draft.updated_at).getTime() : NaN;
  return Number.isFinite(at) && (new Date(now).getTime() - at) < RECENT_EDIT_MS;
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
