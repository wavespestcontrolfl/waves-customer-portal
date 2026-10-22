/**
 * Contact refresh families (contact login, GATE_CONTACT_LOGIN).
 *
 * `customer_refresh_tokens.contact_key` — the last-10 phone key a CONTACT
 * session's family was minted for; NULL for the account holder's own
 * families. The holder's contact save revokes every family on the row whose
 * phone no longer occupies a slot, so a removed device's refresh token can
 * never be revived by re-adding the same number later. The key is the same
 * identity the session claim and `service_contact_notification_prefs` use.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('customer_refresh_tokens', (t) => {
    t.string('contact_key', 10).nullable();
    t.index(['customer_id', 'contact_key'], 'customer_refresh_tokens_contact_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('customer_refresh_tokens', (t) => {
    t.dropIndex(['customer_id', 'contact_key'], 'customer_refresh_tokens_contact_idx');
    t.dropColumn('contact_key');
  });
};
