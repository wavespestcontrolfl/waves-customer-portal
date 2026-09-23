/**
 * Self-serve notice window (owner ruling 2026-09-23).
 *
 * Replaces the old "max 3 self-bookings per calendar day" cap
 * (GATE_SELF_BOOK_DAY_CAP, server/config/feature-gates.js) with a simpler
 * rule: through any SELF-SERVE customer surface, a customer cannot BOOK a
 * visit that starts within the next SELF_SERVE_NOTICE_HOURS hours (default
 * 24), and cannot MOVE (reschedule) a visit that currently starts within
 * that same window. Cancels are explicitly OUT OF SCOPE — the existing
 * cancel-fee window policy (GATE_STICKY_CANCEL_WINDOW etc.) is unaffected
 * by this module.
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

// Minutes of notice required, from SELF_SERVE_NOTICE_HOURS (default 24h).
// Read at call time (not cached) so a flip needs no redeploy, same
// convention as every other GATE_*/env-tunable this codebase reads live.
function selfServeNoticeMinutes() {
  // A blank/whitespace value (an env template placeholder) is UNSET, not
  // zero: Number('') is 0 and would silently disable the window (Codex r1
  // P2). Only an explicit numeric zero disables it.
  const text = String(process.env.SELF_SERVE_NOTICE_HOURS ?? '').trim();
  const raw = text === '' ? NaN : Number(text);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NOTICE_HOURS;
  return hours * 60;
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

// Same check for an EXISTING scheduled_services row (scheduled_date +
// window_start) — used by reschedule-public.js to refuse moving a visit
// that already starts within the notice window. etCalendarDayOf reads
// scheduled_date as its ET calendar day whether the driver hands it back
// as a 'YYYY-MM-DD' string or a UTC-midnight Date (pg DATE column
// convention — see datetime-et.js).
function visitInsideNoticeWindow(row, now = new Date()) {
  if (!row) return true;
  const date = etCalendarDayOf(row.scheduled_date);
  return violatesSelfServeNotice({ date, startTime: row.window_start }, now);
}

module.exports = {
  DEFAULT_NOTICE_HOURS,
  selfServeNoticeMinutes,
  earliestSelfServeStart,
  violatesSelfServeNotice,
  visitInsideNoticeWindow,
};
