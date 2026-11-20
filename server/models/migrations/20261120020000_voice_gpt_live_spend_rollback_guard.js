/**
 * Rollback guard for voice_gpt_live_spend (20261120010000, frozen once pushed). The ledger is the GPT-Live trial's
 * spend record against the owner's $5 cap (2026-11-19): dropping it would give back spend OpenAI already billed, and a
 * re-run would start an empty ledger with the full $5 free again.
 *
 * The ledger is permanent: roll forward, not back. knex rolls back newest first, so this down() runs before the frozen
 * down() and always refuses; the frozen drop is never reached. Refusing always (not only while rows exist) leaves no
 * window where a call reserves between a check and the drop. up() changes nothing.
 */
exports.up = async function up() {};

exports.down = async function down() {
  throw new Error('voice_gpt_live_spend is the GPT-Live trial budget ledger and is permanent: roll forward, not back');
};
