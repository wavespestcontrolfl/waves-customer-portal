/**
 * sms_offers.waves_line — the Waves number the offer was texted FROM (its
 * canonical identity). A customer can hold offers sent from two Waves lines;
 * a reply reaches one line, so the decide step matches it only against
 * offers (and thread rows) on that line. Null on offers recorded before this
 * column existed; the decide step does not use those.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_offers'))) return;
  if (await knex.schema.hasColumn('sms_offers', 'waves_line')) return;
  await knex.schema.alterTable('sms_offers', (t) => { t.string('waves_line', 20); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_offers'))) return;
  if (!(await knex.schema.hasColumn('sms_offers', 'waves_line'))) return;
  await knex.schema.alterTable('sms_offers', (t) => { t.dropColumn('waves_line'); });
};
