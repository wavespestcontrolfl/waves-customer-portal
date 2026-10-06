/**
 * Geofence auto clock-in at the first stop (GATE_GEOFENCE_AUTO_CLOCK_IN,
 * owner 2026-10-06). The eligibility rules live here ONCE and run twice:
 * as a cheap pre-check in the geofence handler (so a tech who is already
 * clocked in costs no locks) and again inside the payroll transaction in
 * time-tracking.startJob, on the scheduled_services row it has locked
 * FOR UPDATE, so a visit that was cancelled, reassigned or moved after the
 * handler read it never gets a shift.
 */
const matcher = require('./geofence-matcher');
const featureGates = require('../config/feature-gates');
const { etDateString, etCalendarDayOf } = require('../utils/datetime-et');

const SOURCE = 'geofence_auto';
const NOTES = 'Auto clock-in on arrival at first stop';

// A Bouncie ENTER older than this no longer says where the tech is NOW:
// the shift is stamped with the current time, so a delayed webhook would
// start paid time late. Older events fall back to the reminder.
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

// A visit in one of these statuses is not work the tech is arriving to do.
const NOT_LIVE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

/** True for a visit row that is still live (not closed, cancelled or moved). */
function isLiveVisit(job) {
  return !!job && !NOT_LIVE_STATUSES.includes(String(job.status)) && job.track_state !== 'complete';
}

/**
 * The tech's own live visit for today (ET). The matcher's any-tech crew-switch
 * fallback never qualifies: the visit must be assigned to THIS tech.
 */
function isAutoClockInJobEligible(job, technicianId, now = new Date()) {
  if (!isLiveVisit(job) || job.technician_id == null) return false;
  if (String(job.technician_id) !== String(technicianId)) return false;
  return !!job.scheduled_date && etCalendarDayOf(job.scheduled_date) === etDateString(now);
}

function isFreshEvent(eventTime, now = Date.now()) {
  const age = now - new Date(eventTime).getTime();
  return Number.isFinite(age) && age <= MAX_EVENT_AGE_MS;
}

/**
 * Pre-check (no locks): the auto clock-in request to hand to startJob, or null.
 * The tech must also have NO shift today: an open shift of any day, or a shift
 * already worked today, means they run their own clock (a stop at the shop
 * first, clocked in by hand, lands here and does nothing). An unreadable shift
 * state is a "no": never clock anyone in on a guess.
 */
async function requestAutoClockIn({ tech, job, eventTime }) {
  if (!tech || !isAutoClockInJobEligible(job, tech.id) || !isFreshEvent(eventTime)) return null;
  const state = await matcher.getShiftStateToday(tech.id, new Date());
  if (!state || state.active || state.anyToday) return null;
  return { source: SOURCE, notes: NOTES };
}

/**
 * Options for timeTracking.startJob on a geofence arrival. Gate off = {} (the
 * call is exactly today's). Gate on = same-job idempotency + live-visit check
 * for every arrival, plus the auto clock-in request when eligible.
 */
async function arrivalStartOptions({ tech, job, eventTime }) {
  if (!featureGates.geofenceAutoClockInLive()) return {};
  const autoClockIn = await requestAutoClockIn({ tech, job, eventTime });
  return autoClockIn ? { geofenceArrival: true, autoClockIn } : { geofenceArrival: true };
}

module.exports = {
  SOURCE,
  NOTES,
  MAX_EVENT_AGE_MS,
  NOT_LIVE_STATUSES,
  isLiveVisit,
  isAutoClockInJobEligible,
  isFreshEvent,
  requestAutoClockIn,
  arrivalStartOptions,
};
