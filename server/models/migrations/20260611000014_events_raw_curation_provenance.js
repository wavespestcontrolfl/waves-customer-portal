/**
 * Auto-curation provenance for events_raw.
 *
 * The auto-curation cron (event-curation.js) classifies pending events
 * and approves real consumer events for the weekly digest. These
 * columns make its work auditable and idempotent:
 *
 *   approved_via  — 'auto_curation' when the cron approved the row;
 *                   NULL for manual/tier-1 approvals (existing flows
 *                   unchanged).
 *   curated_at    — when the cron examined the row (set whether or not
 *                   it approved). The candidate query excludes rows
 *                   with curated_at so each event is classified once,
 *                   not on every run.
 *   curation_note — short model-provided reason, shown in the inbox so
 *                   an operator can audit auto-approvals at a glance.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  if (!(await knex.schema.hasColumn('events_raw', 'approved_via'))) {
    await knex.schema.alterTable('events_raw', (t) => {
      t.string('approved_via', 20).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('events_raw', 'curated_at'))) {
    await knex.schema.alterTable('events_raw', (t) => {
      t.timestamp('curated_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('events_raw', 'curation_note'))) {
    await knex.schema.alterTable('events_raw', (t) => {
      t.string('curation_note', 200).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  for (const col of ['curation_note', 'curated_at', 'approved_via']) {
    if (await knex.schema.hasColumn('events_raw', col)) {
      await knex.schema.alterTable('events_raw', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
