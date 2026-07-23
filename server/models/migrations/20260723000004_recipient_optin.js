// Recipient double opt-in state (#2948 follow-up): one row per third-party
// phone the portal contact flow has asked to confirm. Absence of a row =
// legacy/grandfathered recipient (allowed). Also seeds the confirmation SMS
// template DARK (is_active=false) — the owner approves the copy and
// activates it in /admin before anything can send.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('recipient_optin'))) {
    await knex.schema.createTable('recipient_optin', (t) => {
      // Scoped per property (customers row): the same phone can be a
      // recipient for two different properties/accounts, and a YES for one
      // property's ask must not silently authorize another property's
      // texts without its own ask. Last-10-digit phone convention matches
      // the webhook lookup.
      t.uuid('customer_id').notNullable();
      t.string('phone_key', 10).notNullable();
      t.primary(['customer_id', 'phone_key']);
      t.index('phone_key'); // webhook YES/STOP resolves by phone alone
      t.string('phone_e164', 20);
      // 16 chars fits every state: pending / confirmed / declined / ask_failed.
      t.string('status', 16).notNullable().defaultTo('pending');
      t.string('requested_by', 40).notNullable().defaultTo('portal_contact_save');
      t.string('template_version', 40);
      t.timestamp('requested_at', { useTz: true });
      // Durable ask marker: set when Twilio actually accepted the ask.
      // NULL + stale requested_at = claim whose dispatch died → re-claimable.
      t.timestamp('dispatched_at', { useTz: true }).nullable();
      t.timestamp('confirmed_at', { useTz: true }).nullable();
      t.timestamp('declined_at', { useTz: true }).nullable();
      t.timestamps(true, true);
    });
  }
  if (await knex.schema.hasTable('sms_templates')) {
    const existing = await knex('sms_templates').where({ template_key: 'recipient_optin_request' }).first();
    if (!existing) {
      await knex('sms_templates').insert({
        template_key: 'recipient_optin_request',
        name: 'Recipient opt-in request',
        category: 'notifications',
        body: 'Hi {recipient_first_name} — {account_first_name} added you to receive appointment and service texts from Waves Pest Control for {property_address}. Reply YES to confirm, STOP to opt out, HELP for help. Msg frequency varies. Msg & data rates may apply.',
        description: 'One-time confirmation text sent to a third-party on-location contact after the account holder adds them in the portal. DARK until owner approves the copy and activates.',
        variables: JSON.stringify(['recipient_first_name', 'account_first_name', 'property_address']),
        is_active: false,
        is_internal: false,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('recipient_optin')) {
    await knex.schema.dropTable('recipient_optin');
  }
  // Template rows are never deleted (admin may have edited/activated it);
  // deactivate instead so callers silently skip.
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'recipient_optin_request' }).update({ is_active: false });
  }
};
