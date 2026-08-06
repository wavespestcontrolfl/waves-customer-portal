// Access path for the cancellation-marker repair pass (codex #3238 r1):
// the sweep drives from LIVE scheduled_services rows, and without an
// index on the live-status subset every 15-minute tick would seq-scan
// the full service history. Partial index keeps it bounded to the small
// live population. (appointment_reminders.scheduled_service_id is
// already unique-indexed for the inner lookup.)
exports.up = async (knex) => {
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_scheduled_services_live ON scheduled_services (id) WHERE status IN ('pending', 'confirmed', 'rescheduled', 'en_route', 'on_site')",
  );
  // Environments that migrated with #3233 created the now-superseded
  // restoration-history index (the repair no longer drives from history);
  // editing that applied migration cannot remove it, so drop it here
  // (codex #3238 r2).
  await knex.raw('DROP INDEX IF EXISTS idx_job_status_history_restored_at');
};

exports.down = async (knex) => {
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_job_status_history_restored_at ON job_status_history (transitioned_at) WHERE from_status = 'cancelled'",
  );
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_live');
};
