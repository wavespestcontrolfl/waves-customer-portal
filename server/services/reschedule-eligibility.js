'use strict';

// The ONE customer-facing verdict on whether an appointment can still be
// self-rescheduled. It lived inside routes/reschedule-public.js, where only
// that page could reach it; the promised-link worker has to reach exactly the
// same answer before it texts a customer a link to that page, and a second
// copy of the missed-appointment rule would drift (codex #4293 r3 P2).
// Grouped-visit membership needs a query and stays with each caller.

const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

// Customer-quoted arrival window: 2 hours from window_start (owner rule —
// the same promise the page, reminders, and the late detector all quote).
const ARRIVAL_PROMISE_MINUTES = 120;

function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(t) {
  return t ? String(t).slice(0, 5) : null;
}

// True when this row's own scheduled_date/window_start/window_end is
// already behind `now` — the ONE "has this visit's time passed" rule every
// caller must share (codex + independent-reviewer finding on PR #5308:
// appointment-public.js's pageState used to compute this on its own,
// window_start+2h only, and could disagree with THIS function for a long
// job — calling a visit "past" and offering a "Pick a new time" link while
// this verdict still said "not missed, just inside the move-notice
// window", which reschedule-public.js then refuses: a dead end). A past
// CALENDAR DATE is always elapsed; today's own date is elapsed only once
// BOTH the internal job block (window_end) AND the quoted arrival promise
// (window_start + 2h) have passed — window_end alone is often just the
// job-duration block: a 9:00 visit with window_end 10:00 is still
// legitimately "on the way" at 10:05, inside the quoted 9–11 arrival
// window, and must not read as elapsed.
// The ET calendar date after `dateStr` ('YYYY-MM-DD').
function nextEtDate(dateStr) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), 1));
}

// The instant of wall clock `hhmmStr` + `addMinutes` on ET date `dateStr`,
// rolling onto following ET dates in wall-clock terms (DST-safe).
function etWallClockInstant(dateStr, hhmmStr, addMinutes) {
  const [h, m] = hhmmStr.split(':').map(Number);
  let total = h * 60 + m + addMinutes;
  let day = dateStr;
  while (total >= 1440) {
    total -= 1440;
    day = nextEtDate(day);
  }
  const wall = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return parseETDateTime(`${day}T${wall}`);
}

function visitTimeElapsed(svc, now = new Date()) {
  const dateStr = apptDateStr(svc.scheduled_date);
  if (!dateStr) return false;
  const start = hhmm(svc.window_start);
  if (!start) {
    // Windowless: no instant to reason about — a past calendar date is
    // elapsed, today's or a future date never is. Unchanged from before
    // (codex round-5 P2 only touches the windowed, instant-based path
    // below).
    return dateStr < etDateString(now);
  }
  // A real window exists: compare real INSTANTS end to end, never a
  // calendar-date shortcut, so a window that crosses midnight (e.g.
  // 23:00-00:30) reads correctly from ANY viewing instant. The old
  // "elapsed the moment the calendar flips to the next day" rule said a
  // visit was missed one minute past midnight, well before its quoted
  // arrival promise — or even its own job block — had actually ended
  // (codex round-5 P2 on PR #5308).
  const startInstant = parseETDateTime(`${dateStr}T${start}`);
  if (Number.isNaN(startInstant.getTime())) return false;
  // Every cutoff is an ET WALL CLOCK on its own ET calendar date, parsed
  // with parseETDateTime — never elapsed milliseconds, which drift an hour
  // across a DST change and disagree with the displayed window (codex
  // round-6/7 P2 on PR #5308).
  const candidates = [etWallClockInstant(dateStr, start, ARRIVAL_PROMISE_MINUTES)];
  const end = hhmm(svc.window_end);
  if (end) {
    // window_end's clock time before window_start's means the job block
    // crosses midnight: parse it as a wall clock on the NEXT ET calendar
    // date (never +24h of elapsed time, which drifts an hour across a DST
    // change — codex round-6 P2 on PR #5308).
    const endInstant = etWallClockInstant(end < start ? nextEtDate(dateStr) : dateStr, end, 0);
    if (!Number.isNaN(endInstant.getTime())) candidates.push(endInstant);
  }
  const worstInstant = candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
  return now.getTime() >= worstInstant.getTime();
}

// Customer-facing eligibility for the appointment behind the token.
// Returns { ok: true } or { ok: false, reason } with a customer-safe reason:
//   completed | cancelled | in_progress | past | not_available
function eligibility(svc, now = new Date()) {
  const status = String(svc.status || '').toLowerCase();
  if (status === 'completed') return { ok: false, reason: 'completed' };
  if (status === 'cancelled' || status === 'canceled') return { ok: false, reason: 'cancelled' };
  if (status === 'en_route' || status === 'on_site') return { ok: false, reason: 'in_progress' };
  if (!RESCHEDULABLE_STATUSES.has(status)) return { ok: false, reason: 'not_available' };
  // Same dispatch-owned guard as the authenticated schedule routes (codex
  // #3429 r2 P1): a call-created booking the office hasn't reviewed is
  // hidden from the customer's list/confirm/reschedule, so the bearer-token
  // page must refuse it too — reminder rows now arm before office confirm,
  // and reschedule tokens never expire.
  if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action)
    && status === 'pending'
    && !svc.customer_confirmed) {
    return { ok: false, reason: 'not_available' };
  }

  // A pending/confirmed visit whose time already passed was MISSED, not
  // served — the customer may rebook it from the same link (owner ruling
  // 2026-07-13: "we missed each other — pick a new time"). Terminal and
  // live states were already rejected above; the rebooker only validates
  // the TARGET date, so a future target on a past visit commits cleanly.
  // Only pending/confirmed rows qualify: a past 'rescheduled' row is a
  // pending-rebook PLACEHOLDER other code treats as non-live — reviving it
  // to confirmed would resurrect a phantom visit.
  const missable = status === 'pending' || status === 'confirmed';
  if (visitTimeElapsed(svc, now)) {
    return missable ? { ok: true, missed: true } : { ok: false, reason: 'past' };
  }
  return { ok: true };
}

module.exports = { eligibility, visitTimeElapsed, apptDateStr, hhmm, RESCHEDULABLE_STATUSES, ARRIVAL_PROMISE_MINUTES };
