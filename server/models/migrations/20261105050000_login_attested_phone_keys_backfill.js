// Contact login (GATE_CONTACT_LOGIN_HOLDER_ONLY, dark): a slot phone signs in
// only when the account holder's own portal save listed it in
// service_preferences.login_attested_phone_keys. Rows the holder already
// attested in the portal (service_contacts_consent_source =
// 'portal_account_holder') predate that list, so it is seeded once from the
// phones they store today, minus any still on the unconsented hold. Rows
// stamped by the call pipeline, the grandfather backfill or a recipient YES
// get no list: those numbers never had the holder's own approval.
// Inert while the gate is dark. Idempotent: rows that already have the key
// are left alone.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  for (const col of ['service_preferences', 'service_contacts_consent_source', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone']) {
    if (!(await knex.schema.hasColumn('customers', col))) return;
  }
  await knex.raw(`
    UPDATE customers c
       SET service_preferences = jsonb_set(
         COALESCE(c.service_preferences, '{}'::jsonb),
         '{login_attested_phone_keys}',
         COALESCE((
           SELECT jsonb_agg(k.key)
             FROM (
               SELECT DISTINCT right(regexp_replace(p, '\\D', '', 'g'), 10) AS key
                 FROM unnest(ARRAY[c.service_contact_phone, c.service_contact2_phone, c.service_contact3_phone]) AS p
                WHERE COALESCE(p, '') <> ''
             ) k
            WHERE length(k.key) = 10
              AND NOT jsonb_exists(COALESCE(c.service_preferences -> 'unconsented_slot_phone_keys', '[]'::jsonb), k.key)
         ), '[]'::jsonb)
       )
     WHERE c.service_contacts_consent_source = 'portal_account_holder'
       AND c.service_contacts_consent_at IS NOT NULL
       AND (c.service_preferences IS NULL OR NOT jsonb_exists(c.service_preferences, 'login_attested_phone_keys'))
  `);
};

exports.down = async function down() {
  // The seeded list is inert while the gate is dark and is rewritten by every
  // holder save; there is no safe way to tell a seeded entry from a saved one.
};
