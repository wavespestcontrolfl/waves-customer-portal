'use strict';

/**
 * call_log expression indexes for the visit text recipient's veto read (GATE_CALL_GIVEN_VISIT_TEXTS).
 *
 * The recipient's tracker link re-reads, on every request and poll, whether any call with the person's number recorded a
 * do-not-contact request or an explicit "no texts" (services/messaging/auto-text-holds.js callVetoesForNumber: ONE query).
 * It matches the number by its last 10 digits in every place it can live, so each place needs an index on exactly that
 * expression, or the read scans the whole call log on every poll while keeping revocation immediate:
 *   from_phone, to_phone                    the call legs (from_phone already has call_log_from_phone_last10_index)
 *   ai_extraction_enriched caller.phone_e164       the number the caller SPOKE as their callback (V2 extraction)
 *   ai_extraction_enriched caller.text_phone_e164  the number the caller said to TEXT (V2 extraction)
 *   ai_extraction "phone"                   the legacy V1 extraction's phone (the first "phone" key of its JSON text)
 * The expressions must stay byte-for-byte what auto-text-holds.js SPOKEN_NUMBER_EXPRS and indexedMatch say. Plain CREATE INDEX
 * (not CONCURRENTLY: migrations run inside a transaction); the call log is small, so each holds its lock for milliseconds.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw("CREATE INDEX IF NOT EXISTS call_log_from_phone_last10_index ON call_log ((right(regexp_replace(from_phone, '\\D', '', 'g'), 10)))");
  await knex.raw("CREATE INDEX IF NOT EXISTS call_log_to_phone_last10_index ON call_log ((right(regexp_replace(to_phone, '\\D', '', 'g'), 10)))");
  await knex.raw("CREATE INDEX IF NOT EXISTS call_log_spoken_phone_last10_index ON call_log ((right(regexp_replace((ai_extraction_enriched->'caller'->>'phone_e164'), '\\D', '', 'g'), 10)))");
  await knex.raw("CREATE INDEX IF NOT EXISTS call_log_spoken_text_phone_last10_index ON call_log ((right(regexp_replace((ai_extraction_enriched->'caller'->>'text_phone_e164'), '\\D', '', 'g'), 10)))");
  await knex.raw(`CREATE INDEX IF NOT EXISTS call_log_v1_phone_last10_index ON call_log ((right(regexp_replace(substring(ai_extraction from '"phone"\\s*:\\s*"([^"]*)"'), '\\D', '', 'g'), 10)))`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_v1_phone_last10_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_spoken_text_phone_last10_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_spoken_phone_last10_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_to_phone_last10_index');
  // call_log_from_phone_last10_index belongs to 20260927000006: left in place.
};
