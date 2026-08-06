/**
 * Persist series-final provenance on the cadence row (codex #3235 r5 P1).
 *
 * The multi-treatment cap/cooldown exemption is scoped to the final visit of
 * the ask's own series. Enrollment knows that (resolveSequencePlanForEnrollment
 * stamps seriesFinal), but the step runner's in-flight cap check needs the
 * same answer per touch — an unconditional exemption there let an unrelated
 * cadence starting 31-179 days after a first-treatment ask deliver a 4th ask
 * inside the rolling 180-day cap. Persisting the flag at enrollment keeps the
 * runner deterministic with zero per-touch re-derivation.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (!(await knex.schema.hasColumn('review_sequences', 'series_final'))) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.boolean('series_final').notNullable().defaultTo(false);
    });
  }
  // The visit identity backing the series lineage walk — the admin-schedule
  // completion path can enroll before a service_records row exists, so the
  // record id alone can't always reach the visit (codex #3235 r7 P1).
  if (!(await knex.schema.hasColumn('review_sequences', 'scheduled_service_id'))) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.uuid('scheduled_service_id').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (await knex.schema.hasColumn('review_sequences', 'series_final')) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.dropColumn('series_final');
    });
  }
  if (await knex.schema.hasColumn('review_sequences', 'scheduled_service_id')) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.dropColumn('scheduled_service_id');
    });
  }
};
