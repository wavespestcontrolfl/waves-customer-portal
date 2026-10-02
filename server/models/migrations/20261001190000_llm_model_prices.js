/**
 * llm_model_prices — per-token model prices, pulled weekly from OpenRouter's
 * public model list (services/llm-cost.js). Never hand-typed (owner ruling
 * 2026-09-03, config/models.js). One row per normalised model id; a pull
 * upserts every row the feed still lists and leaves the rest at their last
 * price (fetched_at says how old). Prices are USD per million tokens;
 * pricing_tiers holds the higher rates the feed lists for long prompts.
 * Read by the agent-control hub's estimated-cost numbers and the daily
 * spend check, both behind GATE_LLM_COST_TRACKING.
 */

const TABLE = 'llm_model_prices';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    // normalised id the ledger's served_model is matched against (llm-cost.js normalizeModelId)
    t.string('model_key', 160).notNullable().unique();
    t.string('provider', 40).notNullable();
    t.string('source', 40).notNullable();
    t.string('source_model_id', 200).notNullable();
    t.decimal('input_per_mtok', 14, 6).notNullable();
    t.decimal('output_per_mtok', 14, 6).notNullable();
    t.decimal('cache_read_per_mtok', 14, 6);
    t.decimal('cache_write_per_mtok', 14, 6);
    t.decimal('reasoning_per_mtok', 14, 6);
    // long-prompt tiers: [{ min_prompt_tokens, input_per_mtok, … }] ascending, null = none
    t.jsonb('pricing_tiers');
    t.timestamp('fetched_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
