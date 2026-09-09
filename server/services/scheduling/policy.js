/** Owner-selected scheduling policy. The release gate is read per operation. */
const { gateEnvValue } = require('../../config/feature-gates');

const SHIFT = Object.freeze({ startMinutes: 8 * 60, endMinutes: 18 * 60, arrivalMinutes: 120 });

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

function placementFitsShift(start, end) {
  return Number.isFinite(start) && Number.isFinite(end)
    && start >= SHIFT.startMinutes && start % 60 === 0
    && start + SHIFT.arrivalMinutes <= SHIFT.endMinutes
    && end > start && end <= SHIFT.endMinutes;
}

function schedulingPolicyForDisplay() {
  return capacityEnabled() ? { startMinutes: SHIFT.startMinutes, endMinutes: SHIFT.endMinutes,
    lastStartMinutes: SHIFT.endMinutes - SHIFT.arrivalMinutes } : null;
}

module.exports = { SHIFT, capacityEnabled, applySchedulingPolicy, placementFitsShift, schedulingPolicyForDisplay };
