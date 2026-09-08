/** Frozen public questions. Existing query text, metadata and toggles are preserved. */
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('seo_llm_mention_queries')) return;
  const benchmark = require('../../data/aeo-benchmark-v1.json');
  const inserted = await knex('seo_llm_mention_queries')
    .insert(benchmark.questions.map(({ query, city, service }) => ({ query, city, service, active: true })))
    .onConflict('query').ignore().returning('id');
  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'seo.aeo_benchmark.seed',
      resource_type: 'seo_llm_mention_queries',
      metadata: { benchmark: benchmark.version, inserted: inserted.length },
      critical: true, trx: knex,
    });
  }
};

// Query records may have admin edits and linked observations after deployment.
// Rolling back code must not remove them or undo an owner's active toggle.
exports.down = async function down() {};
