/**
 * Pay after the first visit (GATE_PAF_PREPAY, owner ruling 2026-10-02,
 * "stamp + narrow"): completion records, at closeout, that a visit was held
 * by an annual prepay year whose charge waits for the first visit. The
 * release, the cancelled-year office alert, the first-visit text and a
 * completion resumed after the year is paid read this stamp instead of
 * re-deciding coverage from live state.
 *
 * Nullable, no default: every existing row reads "not held", exactly as
 * before. ON DELETE SET NULL follows the term row.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('scheduled_services', 'paf_held_term_id')) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.uuid('paf_held_term_id').nullable().references('id').inTable('annual_prepay_terms').onDelete('SET NULL');
    t.index(['paf_held_term_id'], 'scheduled_services_paf_held_term_id_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('scheduled_services', 'paf_held_term_id'))) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropIndex(['paf_held_term_id'], 'scheduled_services_paf_held_term_id_idx');
    t.dropForeign(['paf_held_term_id']);
    t.dropColumn('paf_held_term_id');
  });
};
