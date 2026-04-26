/**
 * Add 'scheduled' to the estimates.status CHECK constraint.
 *
 * The initial admin_layer migration (20260401000013) created `status` via
 * `t.enu('status', ['draft','sent','viewed','accepted','declined','expired'])`,
 * which Postgres backs with a CHECK constraint. The scheduled-send feature
 * (frontend EstimatePage / EstimateToolViewV2 + cron in services/scheduler.js)
 * writes `status='scheduled'` and the cron later flips it back to 'sent', but
 * the constraint never allowed 'scheduled' — so the UPDATE in
 * /api/admin/estimates/:id/send blew up before this fix.
 *
 * Mirrors the pattern in 20260426000004_relax_scheduled_services_status_enum.
 */
exports.up = async function (knex) {
  await knex.raw(
    'ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check'
  );
  await knex.raw(`
    ALTER TABLE estimates
      ADD CONSTRAINT estimates_status_check
      CHECK (status IN (
        'draft',
        'scheduled',
        'sent',
        'viewed',
        'accepted',
        'declined',
        'expired'
      ))
  `);
};

exports.down = async function (knex) {
  await knex.raw(
    'ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check'
  );
  await knex.raw(`
    ALTER TABLE estimates
      ADD CONSTRAINT estimates_status_check
      CHECK (status IN ('draft','sent','viewed','accepted','declined','expired'))
  `);
};
