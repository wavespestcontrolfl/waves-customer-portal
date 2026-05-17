const { minutesFromElapsed } = require('./duration-minutes');

function finiteDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstFiniteDate(...values) {
  for (const value of values) {
    const date = finiteDate(value);
    if (date) return date;
  }
  return null;
}

function positiveMinutesBetween(start, end) {
  const a = finiteDate(start);
  const b = finiteDate(end);
  if (!a || !b) return null;
  const minutes = Math.round((b.getTime() - a.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
}

function positiveNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildOnSiteLifecycleUpdates(service = {}, at = new Date()) {
  const existingStart = firstFiniteDate(
    service.actual_start_time,
    service.check_in_time,
    service.arrived_at,
  );
  const startAt = existingStart || finiteDate(at) || new Date();
  const updates = {};

  if (!service.actual_start_time) updates.actual_start_time = startAt;
  if (!service.check_in_time) updates.check_in_time = startAt;
  if (!service.arrived_at) updates.arrived_at = startAt;

  return updates;
}

function buildCompletionLifecycleUpdates(service = {}, at = new Date(), { elapsed } = {}) {
  const completedAt = firstFiniteDate(
    service.actual_end_time,
    service.check_out_time,
    service.completed_at,
    at,
  ) || new Date();
  const explicitMinutes = minutesFromElapsed(elapsed);
  const persistedMinutes = positiveNumber(service.service_time_minutes)
    || positiveNumber(service.actual_duration_minutes);
  const existingStart = firstFiniteDate(
    service.actual_start_time,
    service.check_in_time,
    service.arrived_at,
  );
  const timestampMinutes = existingStart ? positiveMinutesBetween(existingStart, completedAt) : null;
  const durationMinutes = explicitMinutes || persistedMinutes || timestampMinutes;
  const inferredStart = !existingStart && explicitMinutes
    ? new Date(completedAt.getTime() - explicitMinutes * 60000)
    : null;

  const updates = {
    actual_end_time: completedAt,
    check_out_time: completedAt,
  };

  if (durationMinutes) {
    updates.service_time_minutes = durationMinutes;
    updates.actual_duration_minutes = durationMinutes;
  }

  if (inferredStart) {
    updates.actual_start_time = inferredStart;
    updates.check_in_time = inferredStart;
    updates.arrived_at = inferredStart;
  }

  return updates;
}

module.exports = {
  finiteDate,
  firstFiniteDate,
  positiveMinutesBetween,
  positiveNumber,
  buildOnSiteLifecycleUpdates,
  buildCompletionLifecycleUpdates,
};
