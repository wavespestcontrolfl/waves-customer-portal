'use strict';

/**
 * When a gap last rang the admin bell (server/services/agent-gap-reports.js).
 * The recorder rings on a gap's first sighting and when a `fixed` gap comes
 * back. Gaps recorded before the per-gap bell existed (still new/building)
 * have never rung, so a NULL here on an open gap makes its next sighting
 * ring once; the recorder then stamps it. No backfill: existing rows stay
 * NULL on purpose.
 */
const TABLE = 'agent_gap_reports';
const COLUMN = 'belled_at';

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.timestamp(COLUMN, { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN);
  });
};
