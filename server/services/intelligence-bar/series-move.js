/**
 * Intelligence Bar: move a recurring-plan visit with its later visits (gap #22, GATE_IB_SERIES_MOVE).
 *
 * With collective moves on (GATE_ADMIN_COLLECTIVE_MOVE, owner rulings 2026-07-30 + 2026-08-28) a staff
 * date move of a cadence visit shifts its later visits too. reschedule_appointment writes one row, so it
 * refused every such move (collective_move_unsupported). This path copies no move logic:
 *   - the card is the rebooker's own read-only preview (previewSeriesMove): every visit that moves, with
 *     its old and new date and window, the visits that stay put, and the landing dates that overlap
 *     another appointment;
 *   - Confirm runs the Dispatch board's staff move (admin-dispatch planVisitMoveForStaff +
 *     runPlannedVisitMove), acknowledged against exactly the previewed visit set (seriesAckIds, the
 *     board's own ack) and bound to every disclosed date and window (expectOccurrences, checked again
 *     under the series locks: a difference is SERIES_CHANGED and nothing moves).
 * The customer is not texted (notifyCustomer false, like the bar's single move); reminders follow the
 * new dates.
 *
 * Narrow on purpose (a card over a big writer must show every effect): a plan whose visits share a stop
 * with another service, carry a linked second treatment (package visit 2) or a call-booked follow-up that
 * would shift with them is refused up front, never carried undisclosed.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

// The options the board's staff move runs with (planVisitMoveForStaff), so the preview projects and
// validates every landing window exactly as the move will.
const PREVIEW_OPTIONS = Object.freeze({ adminWindowRules: true, overlapAdvisory: true });

const CHANGED = Object.freeze({
  error: 'The recurring plan changed after the card was shown (its visits, dates, windows or overlaps), so nothing was moved. Ask again for a fresh card.',
  preview_changed: true,
});

const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

function slotText(date, start, end) {
  const window = start ? ` ${hhmm(start)}${end ? `-${hhmm(end)}` : ''}` : '';
  return `${date || '?'}${window}`;
}

// The rebooker's preview, or the refusal for a landing window the admin rules refuse (a legacy 07:00
// later visit, a window past day end): the move fails inside its transaction on the same rule.
async function readPreview(appointmentId, newDate, window) {
  try {
    return { preview: await require('../rebooker').previewSeriesMove(appointmentId, newDate, window || {}, PREVIEW_OPTIONS) };
  } catch (err) {
    const status = err?.statusCode || err?.status;
    if (status >= 400 && status < 500) return { refusal: { error: `${err.message} Nothing was proposed.` } };
    throw err;
  }
}

const cannotMove = (tail) => `The bar can't move that plan from here yet. ${tail}`;

// A linked visit the card does not list (a package visit 2, a call-booked follow-up that would shift): checked
// at the card and again inside the move's transaction (linkedVisitGuard).
async function linkedVisitRefusal(conn, ids, occurrences, tail) {
  if (await require('../package-followup-booking').hasLivePackageChild(conn, ids)) {
    return { error: `A visit in this recurring plan has a linked second treatment (a two-treatment package visit 2) that would move with it. ${cannotMove(tail)}`, code: 'package_visit_two_linked' };
  }
  const { planCallFollowUpShift } = require('../call-booking-catalog');
  for (const occ of occurrences) {
    if ((await planCallFollowUpShift({ conn, parentServiceId: occ.id, fromDate: occ.from_date, toDate: occ.to_date })).length) {
      return { error: `A visit in this recurring plan has a call-booked follow-up visit that would shift with it. ${cannotMove(tail)}`, code: 'linked_follow_up_move_unsupported' };
    }
  }
  return null;
}

// A plan visit with an effect the card does not list: refused up front, never carried.
async function unlistedEffectRefusal(rows, ids, occurrences) {
  if (rows.some((r) => r.visit_id)) {
    return { error: `A visit in this recurring plan shares its stop with another service. ${cannotMove('Nothing was proposed.')}`, code: 'grouped_visit_move_unsupported' };
  }
  return linkedVisitRefusal(db, ids, occurrences, 'Nothing was proposed.');
}

// The rebooker's moveGuard: runs on the locked series before its first write. The plan's rows are locked
// FOR UPDATE first, so a linked visit inserted since the card (its parent key check takes FOR KEY SHARE on
// the parent) either is visible here or waits until this move commits; the follow-up shift would otherwise
// move it without the card showing it.
function linkedVisitGuard(approved) {
  return async ({ trx }) => {
    await trx('scheduled_services').whereIn('id', approved.occurrence_ids).orderBy('id').forUpdate().select('id');
    const refusal = await linkedVisitRefusal(trx, approved.occurrence_ids, approved.occurrences, 'Nothing was moved.');
    if (refusal) throw Object.assign(new Error(refusal.error), { statusCode: 409, isOperational: true, code: refusal.code, guardRefusal: true });
  };
}

// The plan the card shows, or the refusal that stops the card. `window` is the anchor's landing window
// ({ start, end }), or null to keep each visit's own. Read-only.
async function planSeriesMove({ appointmentId, newDate, window }) {
  const { preview, refusal } = await readPreview(appointmentId, newDate, window);
  if (refusal) return { refusal };
  if (!preview?.collective || !Array.isArray(preview.occurrenceIds) || !preview.occurrenceIds.length) {
    return { refusal: { error: 'The recurring plan for this visit could not be read just now, so nothing was proposed. Try again in a moment.' } };
  }
  const ids = preview.occurrenceIds.map(String);
  const rows = await db('scheduled_services').whereIn('id', ids).select('*');
  if (rows.length !== ids.length) return { refusal: { ...CHANGED, error: 'The recurring plan changed while the card was being built, so nothing was proposed. Ask again.' } };
  const unlisted = await unlistedEffectRefusal(rows, ids, preview.occurrences || []);
  if (unlisted) return { refusal: unlisted };
  const { needsLifecycleRewind } = require('../rebooker');
  return {
    plan: {
      anchor_id: String(appointmentId),
      new_date: dateOnly(newDate),
      window: window ? { start: window.start, end: window.end } : null,
      // The acknowledged set and each visit's disclosed move, exactly as the rebooker returned them
      // (sorted by id): the commit binds both (seriesAckIds, expectOccurrences).
      occurrence_ids: [...ids].sort(),
      occurrences: preview.occurrences,
      skipped_count: Number(preview.skippedCount) || 0,
      conflict_dates: [...new Set((preview.conflicts || []).map((c) => dateOnly(c.date)).filter(Boolean))].sort(),
      // Every appointment a landing window overlaps, as the rebooker probed it: the commit re-probes under
      // its occupancy locks and refuses on any difference (expectConflictSnapshot).
      conflict_snapshot: Array.isArray(preview.conflictSnapshot) ? preview.conflictSnapshot : [],
      rewound_ids: rows.filter((r) => String(r.id) !== String(appointmentId) && needsLifecycleRewind(r)).map((r) => String(r.id)).sort(),
    },
  };
}

// Stable digest of a plan: what the card showed, compared again at Confirm.
function seriesPlanFingerprint(plan) {
  const pick = {
    anchor_id: plan?.anchor_id, new_date: plan?.new_date, window: plan?.window || null,
    occurrence_ids: plan?.occurrence_ids, occurrences: plan?.occurrences,
    skipped_count: plan?.skipped_count, conflict_dates: plan?.conflict_dates, conflict_snapshot: plan?.conflict_snapshot,
    rewound_ids: plan?.rewound_ids,
  };
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The plan facts beside the per-visit lines: what stays put, overlaps, tracker cleanup, texts, audit.
function planFactLines(plan, reason) {
  const lines = [];
  const skipped = Number(plan?.skipped_count) || 0;
  if (skipped) lines.push(`${plural(skipped, 'visit', 'visits')} in progress or skipped ${skipped === 1 ? 'stays on its date' : 'stay on their dates'}`);
  if (plan?.conflict_dates?.length) {
    lines.push(`Lands on a booked window on ${plan.conflict_dates.join(', ')}: those visits keep their new time and the result warns, as on the Dispatch board`);
  }
  if (plan?.rewound_ids?.length) lines.push(`Clears stale tracker state on ${plural(plan.rewound_ids.length, 'later visit', 'later visits')} (no status change)`);
  lines.push('No customer text is sent. Each visit\'s reminders move to its new date and time');
  lines.push('One reschedule audit entry is written for the plan move; the plan move record keeps every visit\'s old and new slot');
  if (reason) lines.push('The reason is kept on this bar action only; a plan move does not write it to the visit notes');
  return lines.map((text) => ({ text }));
}

// The card's series lines (authorization-contract pushes them under the anchor's own move line).
function seriesCardLines(plan, { reason } = {}) {
  const occurrences = [...(plan?.occurrences || [])]
    .sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)) || String(a.id).localeCompare(String(b.id)));
  const later = Math.max(occurrences.length - 1, 0);
  const last = occurrences.map((o) => o.to_date).sort().pop();
  const head = later === 0
    ? 'Recurring plan: this is the last visit in the plan, so no later visit moves with it'
    : `Recurring plan: ${plural(later, 'later visit moves', 'later visits move')} with this one (through ${last}), as on the Dispatch board`;
  const visits = occurrences.map((o) => {
    const from = slotText(o.from_date, o.from_start, o.from_end);
    const to = slotText(o.to_date, o.to_start, o.to_end);
    return { text: `Visit ${from} → ${to}`, before: from, after: to };
  });
  return [{ text: head }, ...visits, ...planFactLines(plan, reason)];
}

// A refusal answer from planVisitMoveForStaff ({ status, body }) as a tool result.
function refusalFromReply(reply) {
  const body = reply?.body || {};
  if (body.code === 'COLLECTIVE_MOVE_ACK_REQUIRED') return { ...CHANGED };
  return { error: body.error || 'The move was refused. Nothing was moved.', ...(body.code ? { code: body.code } : {}) };
}

// A thrown rebooker or route refusal as a tool result; anything else is a real fault and rethrows.
const CHANGED_CODES = new Set(['SERIES_CHANGED', 'SCOPE_CHANGED', 'SLOT_TAKEN', 'VISIT_CHANGED_RETRY', 'COLLECTIVE_MOVE_ACK_REQUIRED', 'CONFLICTS_CHANGED']);
function refusalFromThrown(err) {
  const status = err?.statusCode || err?.status;
  if (!(status >= 400 && status < 500)) return null;
  if (CHANGED_CODES.has(err.code)) return { ...CHANGED, error: `${err.message} Nothing was moved. Ask again for a fresh card.` };
  if (err.code === 'VISIT_SERIES_MOVE_UNSUPPORTED') return { error: `${err.message} Nothing was moved.`, code: 'grouped_visit_move_unsupported' };
  if (err.guardRefusal) return { error: err.message, code: err.code };
  return { error: `${err.message} Nothing was moved.`, ...(err.code ? { code: err.code } : {}) };
}

// The warning line for a committed plan move: accepted overlaps, rows left without a time, effects
// still finishing.
function moveWarning(body) {
  const parts = [];
  for (const w of Array.isArray(body.warnings) ? body.warnings : []) if (w) parts.push(String(w));
  const untimed = Array.isArray(body.unassignedConflicts) ? body.unassignedConflicts : [];
  if (untimed.length) parts.push(`${untimed.length} later visit(s) landed on a booked window and have no time now (${untimed.map((c) => c.date).join(', ')}); set a time from Dispatch.`);
  if (body.notificationError === 'effects_in_progress' || body.notificationError === 'lease_unavailable') {
    parts.push('The plan moved; its reminder update is finishing in the background.');
  }
  return parts.length ? parts.join(' ') : null;
}

// The board's staff move, acknowledged on the card's visit set and bound to every disclosed slot:
// { reply } or { refusal }.
async function runBoardMove({ input, actionContext, appt, dateStr, window, approved }) {
  const { planVisitMoveForStaff, runPlannedVisitMove } = require('../../routes/admin-dispatch');
  const actor = { techRole: 'admin', technicianId: actionContext.technicianId || null };
  try {
    const planned = await planVisitMoveForStaff({
      serviceId: appt.id, newDate: dateStr, newWindow: window, notifyCustomer: false,
      body: { seriesAck: true, seriesAckIds: approved.occurrence_ids }, actor, sourceSurface: 'intelligence_bar',
    });
    if (!planned.plan) return { refusal: refusalFromReply(planned) };
    // Bound to the card under the series locks: every visit's disclosed date and window, every overlap the
    // card counted, and no linked visit it did not list. A later visit grouped since is refused, never carried.
    Object.assign(planned.plan.rescheduleOptions, {
      expectOccurrences: approved.occurrences,
      expectConflictSnapshot: approved.conflict_snapshot,
      moveGuard: linkedVisitGuard(approved),
      carryVisit: false,
    });
    return {
      reply: await runPlannedVisitMove({
        plan: planned.plan, serviceId: appt.id, newDate: dateStr, reasonCode: 'admin', reasonText: input.reason || null,
        notifyCustomer: false, actor,
      }),
    };
  } catch (err) {
    const refusal = refusalFromThrown(err);
    if (refusal) return { refusal };
    throw err;
  }
}

// A confirmed plan move needs the card's own plan; a call without it never saw the later visits.
const validPin = (approved) => Boolean(approved) && typeof approved === 'object'
  && Array.isArray(approved.occurrences) && Array.isArray(approved.occurrence_ids) && Array.isArray(approved.conflict_snapshot);

// Confirm: re-plan, compare with the card, then run the board's staff move bound to the card.
async function runSeriesMove({ input, actionContext = {}, appt, dateStr, window, customerName }) {
  if (actionContext.isAdmin !== true) {
    return { error: 'Only an admin can move a recurring plan from the bar. Nothing was moved.', code: 'permission_denied' };
  }
  const approved = input._series_move;
  if (!validPin(approved)) return { ...CHANGED };
  const fresh = await planSeriesMove({ appointmentId: appt.id, newDate: dateStr, window });
  if (fresh.refusal) return fresh.refusal;
  if (seriesPlanFingerprint(fresh.plan) !== seriesPlanFingerprint(approved)) return { ...CHANGED };
  const { reply, refusal } = await runBoardMove({ input, actionContext, appt, dateStr, window, approved });
  if (refusal) return refusal;
  const body = reply?.body || {};
  if (!(reply?.status >= 200 && reply.status < 300) || body.success === false) return refusalFromReply(reply);
  logger.info(`[intelligence-bar] Moved recurring plan from ${appt.id}: ${body.occurrencesRescheduled ?? '?'} visit(s) to start ${dateStr}`);
  const warning = moveWarning(body);
  return {
    success: true,
    appointment_id: appt.id,
    customer_name: customerName || 'Unknown',
    old_date: appt.scheduled_date,
    new_date: dateStr,
    service_type: appt.service_type,
    plan_move: true,
    visits_moved: Number(body.occurrencesRescheduled) || 0,
    ...(body.skippedCount ? { visits_kept: Number(body.skippedCount) } : {}),
    ...(warning ? { warning } : {}),
  };
}

module.exports = { planSeriesMove, seriesPlanFingerprint, seriesCardLines, runSeriesMove, PREVIEW_OPTIONS, _test: { refusalFromThrown, refusalFromReply, moveWarning } };
