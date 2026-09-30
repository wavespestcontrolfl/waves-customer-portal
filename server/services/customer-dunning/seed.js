'use strict';

/**
 * Promotion seed (pure) — where a customer schedule starts when it takes over
 * a customer's live per-invoice sequences (dunning consolidation §4). PR 1:
 * only the read-only dry-run script calls it; the engine's `promote` (later
 * PR) imports the same function so the dry run shows exactly what promotion
 * would do.
 *
 * Rules (each one exists because a review round found the alternative):
 *  - `oldest` = the ACTIVE member with the minimum sequenceAnchor. Quiet
 *    members (completed / no row) never drive the cadence.
 *  - step_index = the first index >= oldest.step_index whose date on oldest's
 *    anchor is not stale (isStaleTouch), capped at the final step — the final
 *    notice is never skipped while it is still sendable. Seeding from the MIN
 *    step instead would resend a stage already delivered.
 *  - past the final step (even the final step's date on the oldest anchor is
 *    stale) => NO seed (null, reason 'past_final_step'). adoptionLanding
 *    leaves such an invoice for a person and the per-invoice ladder
 *    stale-completes it, so promotion must never schedule a final notice
 *    nobody else would send.
 *  - next_touch_at = that date, or — when it is already due — the next run's
 *    anchor (adoption's rule): promotion NEVER sends in its own run.
 *  - last_touch_at / touches_sent = the max across active members.
 */

const config = require('../../config/invoice-followups');
const Followups = require('../invoice-followups');

const maxDate = (dates) => {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

const maxInt = (values) => values.reduce((m, v) => Math.max(m, Number(v) || 0), 0);

/** The oldest active member by cadence anchor, or null when none is active. */
function oldestActive(activeRows) {
  let best = null;
  for (const row of activeRows) {
    const at = new Date(Followups.sequenceAnchor(row)).getTime();
    if (!best || at < best.at) best = { row, at };
  }
  return best ? best.row : null;
}

/** First non-stale step at/after `fromIndex` on `anchor`; final step is never passed over. */
function firstLiveStep(anchor, fromIndex, now) {
  const steps = Followups.followupSteps();
  const finalIndex = steps.length - 1;
  let index = Math.min(Math.max(Number(fromIndex) || 0, 0), finalIndex);
  let dueAt = Followups.computeNextTouchAt(anchor, index);
  while (index < finalIndex && dueAt && Followups.isStaleTouch(dueAt, now)) {
    index += 1;
    dueAt = Followups.computeNextTouchAt(anchor, index);
  }
  const pastFinal = index === finalIndex && !!dueAt && Followups.isStaleTouch(dueAt, now);
  return { index, dueAt, stepId: steps[index].id, pastFinal };
}

const PAST_FINAL_STEP = 'past_final_step';

/**
 * @param {Array} activeRows sequence rows joined with their invoice's
 *   sent_at / sms_sent_at / created_at aliases (invoice_sent_at,
 *   invoice_sms_sent_at, invoice_created_at) — the runPending row shape.
 * @param {Date} now
 * @returns {{ step_index, step_id, next_touch_at, last_touch_at, touches_sent,
 *   oldest_seq_id, oldest_invoice_id } | null} null = no promotion (no active
 *   member, or past the final step — see seedRefusal for which).
 */
function promotionSeed(activeRows, now = new Date()) {
  const oldest = oldestActive(activeRows);
  if (!oldest) return null;
  const anchor = Followups.sequenceAnchor(oldest);
  const { index, dueAt, stepId, pastFinal } = firstLiveStep(anchor, oldest.step_index, now);
  if (pastFinal) return null;
  const nextAt = !dueAt || dueAt.getTime() <= now.getTime()
    ? Followups.firstEligibleFireAt(Followups.anchorTo10amNY(now, 1, config.sendWindow.hour))
    : dueAt;
  return {
    step_index: index,
    step_id: stepId,
    next_touch_at: nextAt,
    last_touch_at: maxDate(activeRows.map((r) => r.last_touch_at)),
    touches_sent: maxInt(activeRows.map((r) => r.touches_sent)),
    oldest_seq_id: oldest.id || null,
    oldest_invoice_id: oldest.invoice_id ? String(oldest.invoice_id) : null,
  };
}

/** Why promotionSeed returned null for these rows: 'no_active_member' | 'past_final_step' | null (a seed exists). */
function seedRefusal(activeRows, now = new Date()) {
  const oldest = oldestActive(activeRows);
  if (!oldest) return 'no_active_member';
  const { pastFinal } = firstLiveStep(Followups.sequenceAnchor(oldest), oldest.step_index, now);
  return pastFinal ? PAST_FINAL_STEP : null;
}

module.exports = { promotionSeed, seedRefusal, oldestActive, firstLiveStep, PAST_FINAL_STEP };
