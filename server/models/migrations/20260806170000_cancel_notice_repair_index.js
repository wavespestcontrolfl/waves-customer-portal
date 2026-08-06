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
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_live');
};
