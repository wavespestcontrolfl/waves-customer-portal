/** Owner-selected scheduling policy. The release gate is read per operation. */
const { gateEnvValue } = require('../../config/feature-gates');
const { CUSTOMER_DAY_END_MINUTES } = require('./customer-windows');

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

module.exports = { SHIFT, capacityEnabled, applySchedulingPolicy, placementFitsShift, schedulingPolicyForDisplay };
