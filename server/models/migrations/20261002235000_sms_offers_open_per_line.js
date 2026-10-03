/**
 * One open offer per phone, kind AND Waves line (was: per phone and kind).
 * A customer can hold offers sent from two Waves lines, and a reply reaches
 * one of them; a same-kind offer from line B must not supersede line A's.
 * Offers recorded before waves_line existed (null) share one chain.
 */

const TABLE = 'sms_offers';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('DROP INDEX IF EXISTS sms_offers_one_open_per_phone_kind');
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS sms_offers_one_open_per_phone_kind_line
    ON ${TABLE} (phone_last10, kind, COALESCE(waves_line, '')) WHERE status = 'open'`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('DROP INDEX IF EXISTS sms_offers_one_open_per_phone_kind_line');
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS sms_offers_one_open_per_phone_kind
    ON ${TABLE} (phone_last10, kind) WHERE status = 'open'`);
};
