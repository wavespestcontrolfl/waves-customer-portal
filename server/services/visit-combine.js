/**
 * Office Combine (Visit Groups Unblock scope, Lane 2 — owner ruling
 * 2026-09-03). The office route used to call createOrJoinVisit directly,
 * whose connected-window rule refused nearly every real pair (pairs are
 * booked hours apart). Combine now groups the rows and, when the window
 * rule is the ONLY refusal, moves the later unattached rows to abut the
 * earlier ones through the rebooker — a plain same-day move that keeps
 * each row's status, no customer text — and groups once more. Composes
 * visit-groups + rebooker; owns no state of its own.
 */
const db = require('../models/db');
const VisitGroups = require('./visit-groups');

const { dateOnly, toMinutes } = VisitGroups;
const WINDOW_REFUSAL = 'rows not mutually groupable: window';
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Plan the moves that make one stop: walk the WINDOWED rows by start; a
 * row that starts after the running union end moves onto it, keeping its
 * own span. The landing is the union end rounded DOWN to the hour (admin
 * windows start on the hour, scheduling/window-rules.js): an off-hour
 * union end (09:00–10:30) lands the row at 10:00, overlapping by the
 * fraction, never rounded up past it — a 30-minute gap would fail the
 * connected-window rule the retry re-runs (GH codex #3843 r1 P1). The
 * union counts a missing end as the start, exactly as
 * windowedMembersConnected does (r1 P1): planning past a duration the
 * predicate never sees produced a gap it then refused. Rows already
 * attached to a visit are anchors and never move (moving one moves its
 * whole visit); windowless rows join anything and are skipped. Pure —
 * returns [{ id, scheduledDate, start, end, from }] where `from` is the
 * row's observed date/window/membership: the move pins it (a concurrent
 * edit makes the move miss instead of clobbering it) and the revert
 * restores it.
 */
function abutPlan(rows) {
  const windowed = (rows || [])
    .filter((r) => r && r.window_start)
    .map((r) => ({
      id: r.id,
      scheduledDate: dateOnly(r.scheduled_date),
      attached: !!r.visit_id,
      from: { scheduled_date: dateOnly(r.scheduled_date), window_start: r.window_start, window_end: r.window_end ?? null, visit_id: null },
      start: toMinutes(r.window_start),
      // Union contribution: the grouping predicate's own semantics.
      end: toMinutes(r.window_end) ?? toMinutes(r.window_start),
      // The span a MOVED row keeps: its window, else its duration.
      span: toMinutes(r.window_end) != null
        ? Math.max(toMinutes(r.window_end) - toMinutes(r.window_start), 0)
        : (Number(r.estimated_duration_minutes) || 60),
    }))
    .sort((a, b) => a.start - b.start);
  const moves = [];
  let unionEnd = -1;
  for (const r of windowed) {
    if (unionEnd >= 0 && r.start > unionEnd && !r.attached) {
      const start = Math.floor(unionEnd / 60) * 60;
      const end = start + r.span;
      moves.push({ id: r.id, scheduledDate: r.scheduledDate, start: hhmm(start), end: hhmm(end), from: r.from });
      unionEnd = Math.max(unionEnd, end);
    } else {
      unionEnd = Math.max(unionEnd, r.end);
    }
  }
  return moves;
}

/**
 * Group the rows; on a window-only refusal, abut and retry once. Every
 * other refusal (autopay, technician, terminal, office review, artifact)
 * surfaces untouched, before anything moves. Returns { visit, moved }.
 *
 * Before the first move (GH codex #3843 r1, four P1s):
 *  - a selected row's attached visit is preflighted for the membership
 *    freeze the join would apply AFTER the window rule
 *    (frozenVisitVerdict) — a frozen target refuses here, not after a row
 *    has already been rescheduled;
 *  - that visit's every open member joins the planning set as an anchor,
 *    so the plan abuts the whole stop, not the one child selected;
 *  - the cohort's reminder rows take the unit mover's durable SEND HOLD
 *    (claimReminderHoldInTx): each move commits on its own, and a
 *    reminder/confirmation worker between commits would otherwise text a
 *    temporary time. Released after grouping or a complete compensation;
 *    a compensation that could not put a row back keeps it (it expires on
 *    its own), same as a partial unit move.
 *
 * The moves and the grouping are separate commits (the rebooker owns its
 * transaction), so a later move or the final grouping can still fail
 * after earlier rows moved (pre-push codex P1). Two layers keep that
 * from stranding a silently rescheduled row: every move pins the row's
 * observed date/window/membership (`expect`), so a concurrent edit makes
 * the move miss rather than land on stale state; and on any failure the
 * rows already moved are put back to their observed windows in reverse
 * order before the error surfaces. A row that cannot be put back is named
 * in the error so the office fixes it by hand instead of never learning.
 * The move keeps each row's status (rebooker keepStatus), so a pending
 * row that fails to combine is never left 'confirmed'.
 */
async function combineRows({ serviceIds, createdBy, actorId = null }) {
  const ids = (serviceIds || []).map(String);
  const tryGroup = () => VisitGroups.createOrJoinVisit({ rows: ids.map((id) => ({ id })), createdBy });
  try {
    return { visit: await tryGroup(), moved: [] };
  } catch (err) {
    if (String(err && err.message) !== WINDOW_REFUSAL) throw err;
  }
  const selected = await db('scheduled_services')
    .whereIn('id', ids)
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'visit_id', 'estimated_duration_minutes');
  const attachedVisitIds = [...new Set(selected.map((r) => r.visit_id).filter(Boolean).map(String))];
  const rows = [...selected];
  for (const visitId of attachedVisitIds) {
    const verdict = await VisitGroups.frozenVisitVerdict(db, visitId);
    if (verdict.frozen) throw new Error(`visit membership conflict: target frozen (${verdict.reason})`);
    const known = new Set(rows.map((r) => String(r.id)));
    for (const m of await VisitGroups.openMembers(db, visitId)) {
      if (!known.has(String(m.id))) rows.push({ ...m, visit_id: visitId });
    }
  }
  const moves = abutPlan(rows);
  if (!moves.length) throw new Error(WINDOW_REFUSAL);

  const holdUntil = new Date(Date.now() + VisitGroups.MOVE_HOLD_TTL_MS);
  const holdToken = require('crypto').randomBytes(16).toString('hex');
  const cohortIds = rows.map((r) => String(r.id));
  try {
    await db.transaction(async (t) => {
      await VisitGroups.lockStopForRow(t, ids[0]);
      await VisitGroups.claimReminderHoldInTx(t, cohortIds, { holdUntil, holdToken });
    });
  } catch (err) {
    if (err && err.code === 'VISIT_MOVE_HOLD_ACTIVE') {
      throw Object.assign(new Error('Cannot combine right now — another move of this stop is still in progress; try again shortly'), { statusCode: 409, code: 'VISIT_MOVE_HOLD_ACTIVE', isOperational: true });
    }
    throw Object.assign(new Error(`Cannot combine right now — the reminder hold could not be secured (${err.message}); try again`), { statusCode: 503, code: 'VISIT_MOVE_HOLD_FAILED', isOperational: true });
  }
  const releaseHold = async () => {
    try {
      await VisitGroups.releaseReminderHoldByToken(holdToken);
    } catch (err) {
      require('./logger').warn(`[visit-combine] reminder hold release failed (rows stay quiet until it expires): ${err.message}`);
    }
  };

  const rebooker = require('./rebooker');
  // Same reason/actor/options as the dispatch board's silent move:
  // staff-advisory overlaps, admin window rules, no customer
  // notification. initiated_by is a varchar(20) on reschedule_log, so
  // the actor is the surface ('admin'), not the createdBy stamp — the
  // visit row carries who combined it. suppressTechNotice: every move
  // here is tentative until the grouping stands (a later move or
  // tryGroup can fail and put the rows back, silently), so the techs
  // hear once, below, and never about a move that was reverted.
  const move = (id, date, start, end, expect, extra = {}) => rebooker.reschedule(id, date, { start, end }, 'admin', 'admin', {
    adminWindowRules: true,
    overlapAdvisory: true,
    sourceSurface: 'dispatch_board',
    notifyRequested: false,
    keepStatus: true,
    suppressTechNotice: true,
    expect,
    ...extra,
  });
  const done = [];
  const movedTechIds = new Map();
  try {
    for (const m of moves) {
      const result = await move(m.id, m.scheduledDate, m.start, m.end, m.from);
      done.push(m);
      movedTechIds.set(String(m.id), result?.technicianId || null);
    }
    const visit = await tryGroup();
    await releaseHold();
    // The stop is grouped and nothing reverts the moves now: each moved
    // row's holder (the COMMITTED holder, off the rebooker result) hears
    // (tech-visit-notifications.js: post-commit, best-effort, never
    // awaited, gate-dark). The combining staff member is the actor, so
    // their own moves stay silent.
    const techNotices = require('./tech-visit-notifications');
    for (const m of moves) {
      const technicianId = movedTechIds.get(String(m.id));
      if (!technicianId) continue;
      void techNotices.notifyVisitRescheduled({
        visitId: m.id, technicianId, actorId,
        previous: { date: m.from.scheduled_date, windowStart: m.from.window_start, windowEnd: m.from.window_end },
        snapshot: { date: m.scheduledDate, windowStart: m.start, windowEnd: m.end },
      });
    }
    return { visit, moved: moves };
  } catch (err) {
    const stuck = [];
    for (const m of done.reverse()) {
      try {
        // An open-ended row goes back open-ended: the move materialized an
        // end from its duration, and `end: null` alone would keep it
        // (rebooker clearWindowEnd; pre-push codex P1).
        await move(m.id, m.from.scheduled_date, String(m.from.window_start).slice(0, 5), m.from.window_end ? String(m.from.window_end).slice(0, 5) : null,
          { scheduled_date: m.scheduledDate, window_start: m.start, window_end: m.end, visit_id: null },
          m.from.window_end ? {} : { clearWindowEnd: true });
      } catch {
        stuck.push(`${m.id} (now ${m.start}–${m.end}, was ${String(m.from.window_start).slice(0, 5)}${m.from.window_end ? `–${String(m.from.window_end).slice(0, 5)}` : ''})`);
      }
    }
    if (stuck.length) {
      err.message = `${err.message} — ${stuck.length} moved appointment(s) could not be put back, fix by hand: ${stuck.join('; ')}`;
    } else {
      await releaseHold();
    }
    throw err;
  }
}

module.exports = { combineRows, abutPlan };
