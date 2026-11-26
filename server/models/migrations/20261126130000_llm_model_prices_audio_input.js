/**
 * llm_model_prices.audio_input_per_mtok — what a model bills for a million
 * tokens of AUDIO input, from the same weekly feed as the other rates
 * (services/llm-cost.js). Several models bill audio above their text input
 * rate, so a lane that sends audio cannot be priced from input_per_mtok
 * alone. Null = the feed lists no audio price for the model, or the row was
 * last pulled before this column existed. A long-prompt tier keeps its own
 * audio rate inside pricing_tiers (no schema change there).
 */

const TABLE = 'llm_model_prices';
const COLUMN = 'audio_input_per_mtok';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.decimal(COLUMN, 14, 6);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn(COLUMN);
  });
};
