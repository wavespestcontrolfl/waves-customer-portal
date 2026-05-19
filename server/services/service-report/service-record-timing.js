function firstPresentValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function buildServiceRecordCompletionTimingFields({
  scheduledService = {},
  lifecycleUpdates = {},
  completedAt = new Date(),
  serviceRecordCols = {},
} = {}) {
  const fields = {};
  const arrivedAt = firstPresentValue(
    scheduledService.arrived_at,
    scheduledService.actual_start_time,
    scheduledService.check_in_time,
    lifecycleUpdates.arrived_at,
    lifecycleUpdates.actual_start_time,
    lifecycleUpdates.check_in_time,
  ) || null;
  const actualStartTime = firstPresentValue(
    scheduledService.actual_start_time,
    scheduledService.arrived_at,
    scheduledService.check_in_time,
    lifecycleUpdates.actual_start_time,
    lifecycleUpdates.arrived_at,
    lifecycleUpdates.check_in_time,
  ) || null;
  const checkInTime = firstPresentValue(
    scheduledService.check_in_time,
    scheduledService.arrived_at,
    scheduledService.actual_start_time,
    lifecycleUpdates.check_in_time,
    lifecycleUpdates.arrived_at,
    lifecycleUpdates.actual_start_time,
  ) || null;

  if (serviceRecordCols.started_at) {
    fields.started_at = actualStartTime || arrivedAt || checkInTime || null;
  }
  if (serviceRecordCols.arrived_at) fields.arrived_at = arrivedAt;
  if (serviceRecordCols.actual_start_time) fields.actual_start_time = actualStartTime;
  if (serviceRecordCols.check_in_time) fields.check_in_time = checkInTime;

  if (serviceRecordCols.ended_at) fields.ended_at = completedAt;
  if (serviceRecordCols.completed_at) fields.completed_at = completedAt;
  if (serviceRecordCols.actual_end_time) fields.actual_end_time = completedAt;
  if (serviceRecordCols.check_out_time) fields.check_out_time = completedAt;

  return fields;
}

module.exports = {
  firstPresentValue,
  buildServiceRecordCompletionTimingFields,
};
