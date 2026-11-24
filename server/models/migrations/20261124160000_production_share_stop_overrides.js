/**
 * Production share, stop credit override (owner 2026-11-24 review rule): a stop the rules cannot credit by themselves (a review row
 * of the production share preview) gets the credit the OWNER sets for it, with a reason. One row per visit and pay week.
 *   technician_id   the technician the stop belongs to that week
 *   visit_id        the completed route stop (scheduled_services.id; no foreign key: a visit that is deleted later must not be
 *                   blocked by payroll evidence, and the audit event keeps the id)
 *   week_start      the pay week (a Monday) whose run uses the credit
 *   credit_cents    the credit the run uses for the stop in that week, instead of the computed or review row (>= 0)
 *   reason          why, in the owner's words (required)
 * A run reads a week's overrides with the rest of the credit (kind 'owner_set'); the service refuses a change once a finalized check of
 * that technician covers the week. A change or a removal is a critical audit event. Rows are never deleted by a migration.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE IF NOT EXISTS production_share_stop_overrides (
    id bigserial PRIMARY KEY,
    technician_id uuid NOT NULL REFERENCES technicians(id),
    visit_id uuid NOT NULL,
    week_start date NOT NULL CONSTRAINT production_share_stop_overrides_monday_check CHECK (EXTRACT(ISODOW FROM week_start) = 1),
    credit_cents bigint NOT NULL CONSTRAINT production_share_stop_overrides_credit_check CHECK (credit_cents >= 0),
    reason text NOT NULL CONSTRAINT production_share_stop_overrides_reason_check CHECK (length(btrim(reason)) > 0),
    created_by uuid NULL REFERENCES technicians(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT production_share_stop_overrides_visit_week_unique UNIQUE (visit_id, week_start)
  )`);
  await knex.raw('CREATE INDEX IF NOT EXISTS production_share_stop_overrides_week_idx ON production_share_stop_overrides (week_start)');
};

exports.down = async function down(knex) {
  // A credit the owner set is a pay decision on file: rolling back would lose it without a word.
  if (await knex.schema.hasTable('production_share_stop_overrides') && await knex('production_share_stop_overrides').first('id')) {
    throw new Error('production_share_stop_overrides holds credits the owner set for stops. Roll forward; do not drop it.');
  }
  await knex.raw('DROP TABLE IF EXISTS production_share_stop_overrides');
};
