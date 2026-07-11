/**
 * Extension-request stamps as REAL columns.
 *
 * The public "Request an extension" flow (PR #2577) first stored its 24h
 * dedupe stamp and lifetime auto-grant burn as top-level keys inside
 * estimates.estimate_data. Codex P1 (2026-07-11): estimate_data has
 * full-blob read-modify-write writers (e.g. the membership-snapshot
 * reconciler), so a concurrent blob write could silently erase both stamps
 * — un-burning the one-per-estimate auto-grant cap. Dedicated columns are
 * immune to blob races, need no jsonb shape/format guards, and make the
 * claim UPDATEs plain indexed-column compares.
 *
 * Both nullable; NULL = never requested / never auto-granted. No backfill:
 * the feature is dark (GATE_ESTIMATE_EXTENSION_REQUEST off in prod) and no
 * jsonb stamps exist outside dev.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (!(await knex.schema.hasColumn('estimates', 'extension_requested_at'))) {
    await knex.schema.alterTable('estimates', (t) => {
      t.timestamp('extension_requested_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('estimates', 'extension_auto_granted_at'))) {
    await knex.schema.alterTable('estimates', (t) => {
      t.timestamp('extension_auto_granted_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;
  if (await knex.schema.hasColumn('estimates', 'extension_auto_granted_at')) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropColumn('extension_auto_granted_at');
    });
  }
  if (await knex.schema.hasColumn('estimates', 'extension_requested_at')) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropColumn('extension_requested_at');
    });
  }
};
