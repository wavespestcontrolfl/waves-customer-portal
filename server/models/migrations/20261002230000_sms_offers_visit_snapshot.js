/**
 * sms_offers.visit_snapshot — for a move_visit offer, the visit as it stood
 * when the offer was recorded: { date, start, end, status, taken_at }.
 *
 * The decide step (sms-scheduling-decide.js) compares the visit now against
 * it: any change to its date, window or status after the offer went out
 * (a rebooker move, the admin Edit appointment form, which writes no
 * reschedule_log row, a cancel) means the offer no longer describes the
 * visit, and an accept is refused to staff. Null for other kinds, and for
 * offers recorded before this column existed (the decide step refuses those).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_offers'))) return;
  if (await knex.schema.hasColumn('sms_offers', 'visit_snapshot')) return;
  await knex.schema.alterTable('sms_offers', (t) => { t.jsonb('visit_snapshot'); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_offers'))) return;
  if (!(await knex.schema.hasColumn('sms_offers', 'visit_snapshot'))) return;
  await knex.schema.alterTable('sms_offers', (t) => { t.dropColumn('visit_snapshot'); });
};
