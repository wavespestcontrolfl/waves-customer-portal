/**
 * Office Combine (Visit Groups Unblock scope, Lane 2 — owner ruling
 * 2026-09-03). The office route used to call createOrJoinVisit directly,
 * whose connected-window rule refused nearly every real pair (pairs are
 * booked hours apart). Combine now groups the rows and, when the window
 * rule is the ONLY refusal, moves the later unattached rows to abut the
 * earlier ones through the rebooker — a plain same-day move, no customer
 * text; the standing reminders re-arm for the new time — and groups once
 * more. Composes visit-groups + rebooker; owns no state of its own.
 */
const db = require('../models/db');
const { createOrJoinVisit, dateOnly, toMinutes } = require('./visit-groups');

const WINDOW_REFUSAL = 'rows not mutually groupable: window';
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Plan the moves that make one stop: walk the WINDOWED rows by start; a
 * row that starts after the running union end moves to start there
 * (rounded UP to the hour — admin windows start on the hour,
 * scheduling/window-rules.js), keeping its own span. Rows already
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
      end: toMinutes(r.window_end) ?? (toMinutes(r.window_start) + (Number(r.estimated_duration_minutes) || 60)),
    }))
    .sort((a, b) => a.start - b.start);
  const moves = [];
  let unionEnd = -1;
  for (const r of windowed) {
    if (unionEnd >= 0 && r.start > unionEnd && !r.attached) {
      const start = Math.ceil(unionEnd / 60) * 60;
      const end = start + Math.max(r.end - r.start, 0);
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
 * The moves and the grouping are separate commits (the rebooker owns its
 * transaction), so a later move or the final grouping can still fail
 * after earlier rows moved (pre-push codex P1). Two layers keep that
 * from stranding a silently rescheduled row: every move pins the row's
 * observed date/window/membership (`expect`), so a concurrent edit makes
 * the move miss rather than land on stale state; and on any failure the
 * rows already moved are put back to their observed windows in reverse
 * order before the error surfaces. A row that cannot be put back is named
 * in the error so the office fixes it by hand instead of never learning.
 */
async function combineRows({ serviceIds, createdBy }) {
  const ids = (serviceIds || []).map(String);
  const tryGroup = () => createOrJoinVisit({ rows: ids.map((id) => ({ id })), createdBy });
  try {
    return { visit: await tryGroup(), moved: [] };
  } catch (err) {
    if (String(err && err.message) !== WINDOW_REFUSAL) throw err;
  }
  const rows = await db('scheduled_services')
    .whereIn('id', ids)
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'visit_id', 'estimated_duration_minutes');
  const moves = abutPlan(rows);
  if (!moves.length) throw new Error(WINDOW_REFUSAL);
  const rebooker = require('./rebooker');
  // Same reason/actor/options as the dispatch board's silent move:
  // staff-advisory overlaps, admin window rules, no customer
  // notification. initiated_by is a varchar(20) on reschedule_log, so
  // the actor is the surface ('admin'), not the createdBy stamp — the
  // visit row carries who combined it.
  const move = (id, date, start, end, expect) => rebooker.reschedule(id, date, { start, end }, 'admin', 'admin', {
    adminWindowRules: true,
    overlapAdvisory: true,
    sourceSurface: 'dispatch_board',
    notifyRequested: false,
    expect,
  });
  const done = [];
  try {
    for (const m of moves) {
      await move(m.id, m.scheduledDate, m.start, m.end, m.from);
      done.push(m);
    }
    return { visit: await tryGroup(), moved: moves };
  } catch (err) {
    const stuck = [];
    for (const m of done.reverse()) {
      try {
        await move(m.id, m.from.scheduled_date, String(m.from.window_start).slice(0, 5), m.from.window_end ? String(m.from.window_end).slice(0, 5) : null,
          { scheduled_date: m.scheduledDate, window_start: m.start, window_end: m.end, visit_id: null });
      } catch {
        stuck.push(`${m.id} (now ${m.start}–${m.end}, was ${String(m.from.window_start).slice(0, 5)}${m.from.window_end ? `–${String(m.from.window_end).slice(0, 5)}` : ''})`);
      }
    }
    if (stuck.length) {
      err.message = `${err.message} — ${stuck.length} moved appointment(s) could not be put back, fix by hand: ${stuck.join('; ')}`;
    }
    throw err;
  }
}

module.exports = { combineRows, abutPlan };
