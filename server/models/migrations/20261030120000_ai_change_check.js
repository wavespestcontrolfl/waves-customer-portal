/**
 * Before-and-after AI citation check for every content change.
 *
 * Adds nullable columns to content_optimization_impact. The daily impact
 * tracker (checkAiChange, GATE_AI_CHANGE_CHECK) compares how often AI answers
 * cited the page in the 14 days before deploy vs the 14 days after, adjusted
 * for site-wide Waves citations, and writes one verdict per row. Reads the
 * seo_llm_mentions rows the daily prober already stores: no new probes.
 */

const TABLE = 'content_optimization_impact';
const INDEX = 'idx_coi_ai_change_pending';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const add = async (col, build) => {
    if (await knex.schema.hasColumn(TABLE, col)) return;
    await knex.schema.alterTable(TABLE, (t) => build(t));
  };
  await add('ai_change_pre', (t) => t.jsonb('ai_change_pre'));
  await add('ai_change_post', (t) => t.jsonb('ai_change_post'));
  await add('ai_change_verdict', (t) => t.string('ai_change_verdict', 20)); // gained | lost | flat | no_data
  await add('ai_change_checked_at', (t) => t.timestamp('ai_change_checked_at', { useTz: true }));
  await add('ai_change_alerted_at', (t) => t.timestamp('ai_change_alerted_at', { useTz: true }));
  // Pending scan: unchecked rows that have a deploy date, oldest first.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (deployed_at) WHERE ai_change_checked_at IS NULL AND deployed_at IS NOT NULL`,
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  for (const col of ['ai_change_pre', 'ai_change_post', 'ai_change_verdict', 'ai_change_checked_at', 'ai_change_alerted_at']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(col));
    }
  }
};
