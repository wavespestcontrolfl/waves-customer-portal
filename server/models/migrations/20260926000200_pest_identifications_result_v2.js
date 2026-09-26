/**
 * pest_identifications.result_v2 — the Photo ID v2 pest engine's customer-
 * facing answer object (PR-2b, `GATE_PHOTO_ID_V2`), stored alongside the v1
 * columns the row keeps writing (`species_slug`, `category`, `service_line`,
 * `urgency`, `report_contract`) so admin pages, history, and issues keep
 * working unchanged. See `~/photo-id-v2-build-20260926/V2-CONTRACT.md`.
 *
 * Nullable jsonb, additive only — every existing row reads `null` here
 * (customer app rows written before this PR, and any row written while
 * `GATE_PHOTO_ID_V2` is off). No backfill: v1 rows have no v2 answer to
 * backfill from.
 *
 * Idempotent (hasTable + hasColumn) per the waves-db migration house style.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('pest_identifications');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('pest_identifications', 'result_v2');
  if (!hasColumn) {
    await knex.schema.alterTable('pest_identifications', (t) => {
      t.jsonb('result_v2').nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('pest_identifications');
  if (!hasTable) return;

  if (await knex.schema.hasColumn('pest_identifications', 'result_v2')) {
    await knex.schema.alterTable('pest_identifications', (t) => { t.dropColumn('result_v2'); });
  }
};
