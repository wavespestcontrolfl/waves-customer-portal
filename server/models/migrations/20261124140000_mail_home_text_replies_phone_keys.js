/**
 * Text-to-book claims (mail_home_text_replies, 20261124130000): the sender and line keys are phoneIdentityKey values now (10
 * digits for a NANP number, "+<digits>" for any other: utils/phone.js), so two international senders that share their last ten
 * digits no longer share a claim. "+<digits>" is up to 16 characters; the first migration's 10-character columns are widened.
 * That file is already pushed and frozen, so this one alters it. Existing rows hold 10-digit keys, which are the same
 * phoneIdentityKey values for a NANP number. down() narrows back only when no wider key exists.
 */
const TABLE = 'mail_home_text_replies';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN phone_digits TYPE varchar(20), ALTER COLUMN line_digits TYPE varchar(20)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex(TABLE).whereRaw('length(phone_digits) > 10 OR length(line_digits) > 10').del();
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN phone_digits TYPE varchar(10), ALTER COLUMN line_digits TYPE varchar(10)`);
};
