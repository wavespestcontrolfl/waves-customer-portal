// The customer activity timeline matches unclaimed mail by address
// (LOWER(TRIM(recipient_email_snapshot)) IN (...)) because the snapshot can be
// mixed-case (email-template-library). Its mail query is an OR of three arms
// (owner pair, lead ids, address); Postgres can only BitmapOr the arms when
// every one is indexable, and the plain recipient_email_snapshot index does not
// serve a LOWER(TRIM(..)) predicate, so without this expression index the
// address arm would drag the whole lookup back to a sequential scan of the mail
// log (the problem migration 20260929140000 fixed for the owner arm). Plain
// CREATE INDEX like its sibling: migrations run inside a transaction pre-deploy.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_messages'))) return;
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS email_messages_recipient_email_lower_idx ON email_messages (LOWER(TRIM(recipient_email_snapshot)))',
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_recipient_email_lower_idx');
};
