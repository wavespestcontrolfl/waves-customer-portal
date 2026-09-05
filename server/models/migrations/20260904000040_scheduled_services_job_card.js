/**
 * Job card paragraph cache (Tech Resource Drawer PR 2, GATE_JOB_CARD).
 *
 * The Service Protocol drawer's Job card tab shows a 1–3 sentence customer
 * paragraph written by a FAST-tier model from deterministic portal facts.
 * The text is cached per visit here, keyed by the grounding hash stored
 * inside the jsonb (same mechanics as pre_service_brief, separate column so
 * the two lanes never clobber each other). Additive, nullable, reversible.
 */

exports.up = async function up(knex) {
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'job_card');
  if (hasCol) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.jsonb('job_card').nullable();
    t.timestamp('job_card_generated_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'job_card');
  if (!hasCol) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('job_card');
    t.dropColumn('job_card_generated_at');
  });
};
