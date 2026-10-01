/**
 * seo_llm_mentions.sentiment_status — whether a mentioned answer's sentiment
 * was actually classified ('classified') or the pass returned no label
 * ('unclassified': no key/SDK, provider error, off-contract reply). NULL on
 * rows written before this column and on answers that do not mention Waves.
 *
 * The prober used to store 'neutral' on every sentiment failure, so an old
 * 'neutral' cannot be told apart from a real verdict; the recommended-rate
 * denominator (aeo-measurement.js) trusts a sentiment only when this says
 * 'classified', or — on older rows — when the label is positive/negative
 * (Codex r5 on #5123).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('seo_llm_mentions', 'sentiment_status'))) {
    await knex.schema.alterTable('seo_llm_mentions', (t) => {
      t.text('sentiment_status');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('seo_llm_mentions', 'sentiment_status')) {
    await knex.schema.alterTable('seo_llm_mentions', (t) => {
      t.dropColumn('sentiment_status');
    });
  }
};
