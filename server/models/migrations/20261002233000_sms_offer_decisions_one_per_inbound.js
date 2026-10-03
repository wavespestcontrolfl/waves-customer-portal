/**
 * One sms_offer_decisions row per inbound text, whatever offer it was judged
 * against: the webhook call and the reply sweep can race on the same text, and
 * with several offers standing, two model calls could pick different offers
 * and both insert under the (offer, text) key. The decide step's insert
 * ignores any conflict, so the loser records nothing.
 */

const TABLE = 'sms_offer_decisions';
const INDEX = 'sms_offer_decisions_one_per_inbound';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (inbound_sms_log_id)`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
