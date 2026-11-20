/**
 * Rollback guard for voice_gpt_live_spend (20261120010000, frozen once pushed). The ledger is the GPT-Live trial's
 * spend record against the owner's $5 cap (2026-11-19): dropping it would give back spend OpenAI already billed, and a
 * re-run would start an empty ledger with the full $5 free again.
 *
 * knex rolls back newest first, so this down() runs before the frozen down(). While the ledger holds any row it refuses,
 * and the frozen drop is never reached. With an empty or missing ledger it does nothing, and the frozen down() drops
 * the table as before. up() changes nothing.
 */
exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('voice_gpt_live_spend'))) return;
  const row = await knex('voice_gpt_live_spend').first('call_sid');
  if (row) {
    throw new Error('voice_gpt_live_spend holds GPT-Live trial spend: refusing to roll back the budget ledger');
  }
};
