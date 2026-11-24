/**
 * Production share, settings (Technician Terms v3, "Production share"; owner 2026-11-23). PR 1 of the share: the
 * weekly credit, its dated settings and an admin preview. NO pay line and NO money on any check here.
 *
 * production_share_settings: the numbers the share is computed with, by the pay week they apply from. The owner has not
 * set them yet, so there is no seed row: with no row on or before a week the share is $0 and the preview says so.
 *   technician_id              NULL = the default for every technician; a row with an id applies to that technician only
 *   from_week                  a Monday: the first pay week the row applies to
 *   rate_bps                   the share of the amount above the bar, in basis points (1500 = 15%)
 *   bar_type                   'per_shift' (bar_cents for each shift worked in the week) or 'weekly' (one bar_cents)
 *   bar_cents                  the bar, in cents
 *   callback_stop_value_cents  the route's average value for one stop: the credit of a callback on another
 *                              technician's work (a yearly setting)
 * A run reads the newest row on or before its own week; a row for the technician wins over the default. A week paid
 * under a row keeps it: rows are replaced only in their own from_week, never deleted (payroll_week_minimum_changes
 * does the same). Nothing reads this table until the share is computed (PR 1: the preview only).
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE production_share_settings (
    id bigserial PRIMARY KEY,
    technician_id uuid NULL REFERENCES technicians(id),
    from_week date NOT NULL CONSTRAINT production_share_settings_monday_check CHECK (EXTRACT(ISODOW FROM from_week) = 1),
    rate_bps integer NOT NULL CONSTRAINT production_share_settings_rate_check CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    bar_type text NOT NULL CONSTRAINT production_share_settings_bar_type_check CHECK (bar_type IN ('per_shift', 'weekly')),
    bar_cents bigint NOT NULL CONSTRAINT production_share_settings_bar_check CHECK (bar_cents >= 0),
    callback_stop_value_cents bigint NOT NULL DEFAULT 0 CONSTRAINT production_share_settings_callback_check CHECK (callback_stop_value_cents >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NULL REFERENCES technicians(id)
  )`);
  // One row per technician and week; NULLs are distinct in a plain unique constraint, so the default has its own index.
  await knex.raw(`CREATE UNIQUE INDEX production_share_settings_technician_week_unique
    ON production_share_settings (technician_id, from_week) WHERE technician_id IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX production_share_settings_default_week_unique
    ON production_share_settings (from_week) WHERE technician_id IS NULL`);
};

exports.down = async function down(knex) {
  // A setting the owner saved is a pay promise on file: rolling back would lose it without a word.
  if (await knex('production_share_settings').first('id')) {
    throw new Error('production_share_settings holds the production share numbers by pay week. Roll forward; do not drop it.');
  }
  await knex.raw('DROP TABLE IF EXISTS production_share_settings');
};
