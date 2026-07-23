// Recipient double opt-in state (#2948 follow-up): one row per third-party
// phone the portal contact flow has asked to confirm. Absence of a row =
// legacy/grandfathered recipient (allowed). Also seeds the confirmation SMS
// template DARK (is_active=false) — the owner approves the copy and
// activates it in /admin before anything can send.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('recipient_optin'))) {
    await knex.schema.createTable('recipient_optin', (t) => {
      // Last-10-digit key, matching the webhook's phone lookup convention.
      t.string('phone_key', 10).primary();
      t.string('phone_e164', 20);
      // 16 chars fits every state: pending / confirmed / declined / ask_failed.
      t.string('status', 16).notNullable().defaultTo('pending');
      t.uuid('customer_id').nullable();
      t.string('requested_by', 40).notNullable().defaultTo('portal_contact_save');
      t.string('template_version', 40);
      t.timestamp('requested_at', { useTz: true });
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
