/**
 * Entity-accuracy cohort: a fact score on each answer-engine observation plus
 * the owner-approved brand/person questions (decision 6, 2026-09-07).
 * Existing query text, metadata and active toggles are preserved.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('seo_llm_mentions')
    && !await knex.schema.hasColumn('seo_llm_mentions', 'entity_facts')) {
    await knex.schema.alterTable('seo_llm_mentions', t => t.jsonb('entity_facts'));
  }
  if (!await knex.schema.hasTable('seo_llm_mention_queries')) return;
  const cohort = require('../../data/aeo-entity-cohort-v1.json');
  const inserted = await knex('seo_llm_mention_queries')
    .insert(cohort.questions.map(({ query }) => ({ query, city: null, service: 'brand', active: true })))
    .onConflict('query').ignore().returning('id');
  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'seo.aeo_entity_cohort.seed',
      resource_type: 'seo_llm_mention_queries',
      metadata: { cohort: cohort.version, inserted: inserted.length },
      critical: true, trx: knex,
    });
  }
};

// Query rows may carry admin edits and linked observations; rolling code back
// must not remove them or undo an owner's toggle. Only the score column goes.
exports.down = async function down(knex) {
  if (await knex.schema.hasTable('seo_llm_mentions')
    && await knex.schema.hasColumn('seo_llm_mentions', 'entity_facts')) {
    await knex.schema.alterTable('seo_llm_mentions', t => t.dropColumn('entity_facts'));
  }
};
