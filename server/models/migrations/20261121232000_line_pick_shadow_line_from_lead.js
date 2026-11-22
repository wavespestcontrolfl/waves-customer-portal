'use strict';

/**
 * A Waves Assessment goes by the line its lead asked for (owner 2026-11-21, choice 4 = A;
 * services/scheduling/line-technician.js assessmentLineFor), so the shadow log's `line_from`
 * gains a third source, 'lead', next to 'catalog' and 'name'.
 *
 * Replaces service_line_pick_shadow_line_from_check (20261025220000_service_line_map_shadow.js).
 * The down sets 'lead' rows to NULL first, so restoring the old CHECK cannot fail on them.
 * Values are inlined on purpose: a migration must not change meaning when application code
 * changes later. Idempotent.
 */
const TABLE = 'service_line_pick_shadow';
const CHECK = 'service_line_pick_shadow_line_from_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK}
    CHECK (line_from IS NULL OR line_from IN ('catalog', 'name', 'lead'))`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex(TABLE).where({ line_from: 'lead' }).update({ line_from: null });
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK}
    CHECK (line_from IS NULL OR line_from IN ('catalog', 'name'))`);
};
