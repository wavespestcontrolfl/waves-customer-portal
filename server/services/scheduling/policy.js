/** Owner-selected scheduling policy. The release gate is read per operation. */
const { gateEnvValue } = require('../../config/feature-gates');
const { CUSTOMER_DAY_END_MINUTES } = require('./customer-windows');
const { etDateString, etCalendarDayOf } = require('../../utils/datetime-et');

// endMinutes reuses the one customer day-end constant (picker-windows PR 2,
// owner ruling 2026-09-23) rather than a second 18:00 literal — it already
// equalled 18*60 before that PR; this only removes the duplicate.
// arrivalMinutes is kept for callers that still want a coarse pre-filter
// (none currently do) but no longer bounds admission itself — see
// placementFitsShift below (Codex r1 P1 on #4663).
const SHIFT = Object.freeze({ startMinutes: 8 * 60, endMinutes: CUSTOMER_DAY_END_MINUTES, arrivalMinutes: 120 });

function capacityEnabled() {
  return gateEnvValue('GATE_SCHEDULING_CAPACITY');
}

// Extend the existing booking_config singleton without rewriting an owner's
// stored settings when this release is disabled. Closures and lunch exclusions
// remain the existing configuration's responsibility.
function applySchedulingPolicy(config = {}) {
  return capacityEnabled()
    ? { ...config, day_start: '08:00', day_end: '18:00', scheduling_capacity: true }
    : config;
}

// Admission is the literal shift bounds only: an on-the-hour start at or
// after SHIFT.startMinutes whose actual (caller-supplied) end fits by
// SHIFT.endMinutes. Previously also required start + SHIFT.arrivalMinutes
// (120) <= SHIFT.endMinutes — a flat 2-hour headroom floor that rejected a
// 17:00 start even for a 60-minute job ending exactly at the 18:00 close,
// even though the shared customer grid (customer-windows.js) offers 17:00
// on every other surface. That extra floor made findCapacitySlots's own
// generator (find-time.js) and this same commit-side check disagree with
// the offered grid in capacity mode — an offer/commit parity break, not a
// deliberate limit (nothing reads the old margin as a promise: the
// customer-facing arrival-window text is always start+2h regardless of this
// admission check, computed separately by arrivalWindowRange()). Codex r1
// P1 on #4663.
function placementFitsShift(start, end) {
  return Number.isFinite(start) && Number.isFinite(end)
    && start >= SHIFT.startMinutes && start % 60 === 0
    && end > start && end <= SHIFT.endMinutes;
}

function schedulingPolicyForDisplay() {
  return capacityEnabled() ? { startMinutes: SHIFT.startMinutes, endMinutes: SHIFT.endMinutes } : null;
}

// Owner ruling 2026-09-25: self-serve surfaces hide a capacity slot that adds
// more than this many round-trip drive minutes to the technician's route
// (staff and phone booking still see every fit). SCHEDULING_MAX_DETOUR_MINUTES
// overrides the default; an empty day counts the whole trip from HQ.
const DEFAULT_MAX_DETOUR_MINUTES = 30;

function customerMaxDetourMinutes() {
  const configured = Number.parseInt(process.env.SCHEDULING_MAX_DETOUR_MINUTES, 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_DETOUR_MINUTES;
}

// Owner ruling 2026-09-28 ("I'd rather be more lenient than strict"): a
// self-serve (customer-picked) time names an ARRIVAL window, not a promised
// start — accept it when the technician can arrive within this many minutes
// of the window's start. Capacity-mode-only (the leniency this buys is the
// route simulation's own arrival-delay number, which only exists under
// capacity) and never for a same-day pick (etDateString(new Date()) —
// today's route is already live/committed, so "lenient" there is a real
// technician promise, not a scheduling grid decision). SELF_SERVE_ARRIVAL_
// GRACE_MINUTES overrides the 0 (byte-identical-to-legacy) default;
// unset/blank/garbage/negative all fall back to 0 rather than reaching a
// caller as a live grace. Clamped to the existing 120-minute arrival
// promise (ARRIVAL_WINDOW_MINUTES, utils/sms-time-format.js) — grace can
// only narrow that promise, never widen it.
const DEFAULT_ARRIVAL_GRACE_MINUTES = 0;
const MAX_ARRIVAL_GRACE_MINUTES = 120;

function selfServeArrivalGraceMinutes({ date } = {}) {
  if (!capacityEnabled()) return DEFAULT_ARRIVAL_GRACE_MINUTES;
  // etCalendarDayOf (not a raw String()/etDateString conversion — Codex
  // pre-push fallback P1): a pg DATE column can deserialize as a
  // UTC-midnight JS Date, and reading that through etDateString or a bare
  // String() shifts or garbles it. Every caller today already hands this a
  // plain 'YYYY-MM-DD' string (find-time.js's slot.date, slot-reservation.js's
  // parsed slotId date, and commitReservation's dateOnly()-normalized
  // scheduledDate), but the same-day exclusion must stay correct even if a
  // future caller passes the raw column value straight through — a silently
  // skipped exclusion here is an offer/commit mismatch (a same-day slot
  // offered at grace 0 that commit then reads a live grace for).
  if (date != null && etCalendarDayOf(date) === etDateString(new Date())) return DEFAULT_ARRIVAL_GRACE_MINUTES;
  const configured = Number(process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_ARRIVAL_GRACE_MINUTES;
  return Math.min(Math.round(configured), MAX_ARRIVAL_GRACE_MINUTES);
}

module.exports = {
  SHIFT, capacityEnabled, applySchedulingPolicy, placementFitsShift, schedulingPolicyForDisplay, customerMaxDetourMinutes,
  selfServeArrivalGraceMinutes,
};
