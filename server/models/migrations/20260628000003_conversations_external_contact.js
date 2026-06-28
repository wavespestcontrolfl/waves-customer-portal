/**
 * Social inbox (Phase 1) — let the unified conversations model thread
 * contacts that have no phone or email.
 *
 * Facebook Messenger / Instagram users are identified by a page-scoped id
 * (PSID), not a phone or email, so the existing contact_phone / contact_email
 * threading can't key them. Add contact_external_id (the full `messenger:<id>`
 * / `instagram:<id>` address) + a partial unique dedup index mirroring the
 * existing phone/email dedup indexes, so an unknown social contact gets exactly
 * one thread per (external id, channel, our_endpoint_id).
 *
 * Idempotent.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('conversations'))) return;

  if (!(await knex.schema.hasColumn('conversations', 'contact_external_id'))) {
    await knex.schema.alterTable('conversations', (t) => {
      // Full channel address, e.g. 'messenger:1103364...' / 'instagram:...'.
      t.string('contact_external_id', 191);
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_dedup
      ON conversations (contact_external_id, channel, our_endpoint_id)
      WHERE customer_id IS NULL AND contact_external_id IS NOT NULL
  `);

  // The dedup index above is partial to unknown threads (customer_id IS NULL).
  // Once a social contact is linked to a customer, the webhook's prior-link
  // lookup queries customer_id IS NOT NULL, which that index can't serve — so
  // index linked external contacts too (non-unique; a customer may have
  // several threads).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS conversations_external_linked
      ON conversations (contact_external_id, channel, our_endpoint_id)
      WHERE customer_id IS NOT NULL AND contact_external_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS conversations_external_linked');
  await knex.raw('DROP INDEX IF EXISTS conversations_external_dedup');
  if (await knex.schema.hasColumn('conversations', 'contact_external_id')) {
    await knex.schema.alterTable('conversations', (t) => {
      t.dropColumn('contact_external_id');
    });
  }
};
