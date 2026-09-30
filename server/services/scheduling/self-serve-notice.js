/**
 * Self-serve notice window (owner ruling 2026-09-23; split into separate
 * book/move windows 2026-09-28).
 *
 * Replaces the old "max 3 self-bookings per calendar day" cap
 * (GATE_SELF_BOOK_DAY_CAP, server/config/feature-gates.js) with a simpler
 * rule: through any SELF-SERVE customer surface, a customer cannot BOOK a
 * visit that starts within the next SELF_SERVE_NOTICE_HOURS hours (default
 * 24), and cannot MOVE (reschedule) a visit that currently starts within
 * the next SELF_SERVE_MOVE_NOTICE_HOURS hours (default 24, independent of
 * the book variable — no fallback to it). Cancels are explicitly OUT OF
 * SCOPE — the existing cancel-fee window policy (GATE_STICKY_CANCEL_WINDOW
 * etc.) is unaffected by this module.
 *
 * `visitInsideNoticeWindow` is the BOOK check on an existing
 * scheduled_services row (is this held/committed slot's own start still far
 * enough out to count as a fresh self-serve booking — used where a row IS
 * the thing being booked/held, e.g. a reservation hold's own start).
 * `visitInsideMoveNoticeWindow` is the MOVE check (is the visit currently
 * being rescheduled too close to its own start to move it online). The
 * DESTINATION of a move — the new slot the customer is moving TO — is a
 * BOOK decision and always uses the book window/helpers, never the move
 * ones: a customer may move a future visit onto a slot that itself starts
 * inside the move window, as long as that slot clears the book window.
 *
 * SELF-SERVE ONLY. Staff/admin, the call agent (voice relay), and other
 * office-side writers never read this module — they keep booking/moving
 * visits with no notice restriction. Every caller of this helper is a
 * customer-facing picker or its commit gate (estimate picker, /book,
 * reschedule-public.js, reservice-public.js, the AI assistant's booking
 * tools in services/availability.js).
 *
 * All comparisons are ET wall-clock, via server/utils/datetime-et.js —
 * never hand-rolled timezone math — so a `date` + `startTime` pair means
 * exactly what the customer sees on the picker, DST-safe.
 */

const { parseETDateTime, etCalendarDayOf } = require('../../utils/datetime-et');

const DEFAULT_NOTICE_HOURS = 24;
const DEFAULT_MOVE_NOTICE_HOURS = 24;

// A blank/whitespace env value (a template placeholder) is UNSET, not
// zero: Number('') is 0 and would silently disable the window. Only an
// explicit numeric zero disables it. Shared parsing for both the book and
// move notice env vars.
function parseNoticeHoursEnv(value, defaultHours) {
  const text = String(value ?? '').trim();
  const raw = text === '' ? NaN : Number(text);
  return Number.isFinite(raw) && raw >= 0 ? raw : defaultHours;
}

// Minutes of notice required to BOOK, from SELF_SERVE_NOTICE_HOURS (default
// 24h). Read at call time (not cached) so a flip needs no redeploy, same
// convention as every other GATE_*/env-tunable this codebase reads live.
function selfServeNoticeMinutes() {
  return parseNoticeHoursEnv(process.env.SELF_SERVE_NOTICE_HOURS, DEFAULT_NOTICE_HOURS) * 60;
}

// Minutes of notice required to MOVE an existing visit, from
// SELF_SERVE_MOVE_NOTICE_HOURS (default 24h). Deliberately independent of
// SELF_SERVE_NOTICE_HOURS — no fallback to it — so a book-only env change
// never touches the move window. Read at call time for the same reason as
// selfServeNoticeMinutes().
function selfServeMoveNoticeMinutes() {
  return parseNoticeHoursEnv(process.env.SELF_SERVE_MOVE_NOTICE_HOURS, DEFAULT_MOVE_NOTICE_HOURS) * 60;
}

// The earliest instant a self-serve surface may offer or accept a start,
// given `now`. A slot/visit starting before this instant is inside the
// notice window and must be refused.
function earliestSelfServeStart(now = new Date()) {
  return new Date(now.getTime() + selfServeNoticeMinutes() * 60000);
}

function windowStartHHMM(value) {
  const m = /^(\d{2}:\d{2})/.exec(String(value == null ? '' : value));
  return m ? m[1] : null;
}

// True when the ET calendar `date` (YYYY-MM-DD) + `startTime` (HH:MM[:SS])
// pair starts before the notice floor — i.e. this slot/visit may NOT be
// booked or moved through a self-serve surface right now. An unparsable
// date/time fails CLOSED (treated as inside the window): a self-serve
// surface must never offer or accept a start it can't actually place in
// time.
function violatesSelfServeNotice({ date, startTime }, now = new Date()) {
  const hhmm = windowStartHHMM(startTime);
  if (!date || !hhmm) return true;
  const startsAt = parseETDateTime(`${date}T${hhmm}`);
  if (Number.isNaN(startsAt.getTime())) return true;
  return startsAt.getTime() < earliestSelfServeStart(now).getTime();
}

// BOOK check for an EXISTING scheduled_services row (scheduled_date +
// window_start) — used where the row itself IS the thing being booked/held
// (e.g. a reservation hold's own start in slot-reservation.js). etCalendarDayOf
// reads scheduled_date as its ET calendar day whether the driver hands it
// back as a 'YYYY-MM-DD' string or a UTC-midnight Date (pg DATE column
// convention — see datetime-et.js).
function visitInsideNoticeWindow(row, now = new Date()) {
  if (!row) return true;
  const date = etCalendarDayOf(row.scheduled_date);
  return violatesSelfServeNotice({ date, startTime: row.window_start }, now);
}

// The earliest instant a self-serve surface may leave a visit's own start
// alone without it counting as "too soon to move" — i.e. the MOVE-notice
// floor, from selfServeMoveNoticeMinutes() (independent of the book floor).
function earliestSelfServeMoveStart(now = new Date()) {
  return new Date(now.getTime() + selfServeMoveNoticeMinutes() * 60000);
}

// MOVE check: true when an EXISTING scheduled_services row's own
// scheduled_date + window_start starts before the MOVE-notice floor — i.e.
// this visit may NOT be moved (rescheduled) through a self-serve surface
// right now. Mirrors visitInsideNoticeWindow exactly, but against
// SELF_SERVE_MOVE_NOTICE_HOURS instead of SELF_SERVE_NOTICE_HOURS. The
// DESTINATION slot of a move is never checked with this helper — it stays
// on visitInsideNoticeWindow / violatesSelfServeNotice (the book window).
function visitInsideMoveNoticeWindow(row, now = new Date()) {
  if (!row) return true;
  const hhmm = windowStartHHMM(row.window_start);
  if (!hhmm) return true;
  const date = etCalendarDayOf(row.scheduled_date);
  if (!date) return true;
  const startsAt = parseETDateTime(`${date}T${hhmm}`);
  if (Number.isNaN(startsAt.getTime())) return true;
  return startsAt.getTime() < earliestSelfServeMoveStart(now).getTime();
}

module.exports = {
  DEFAULT_NOTICE_HOURS,
  DEFAULT_MOVE_NOTICE_HOURS,
  selfServeNoticeMinutes,
  selfServeMoveNoticeMinutes,
  earliestSelfServeStart,
  earliestSelfServeMoveStart,
  violatesSelfServeNotice,
  visitInsideNoticeWindow,
  visitInsideMoveNoticeWindow,
};
