'use strict';

/**
 * customer_cards — one digital business card per customer, minted on their
 * first COMPLETED visit and fronted by the tech on record for that service
 * (services/customer-card.js). The card page is /card/:share_token; the QR
 * on it points at review_short_url (a /l short code targeting the Google
 * review URL of the GBP nearest the customer — locations.js routing).
 *
 * One card per customer for life (unique customer_id): repeat visits reuse
 * the same token, so links/QRs already saved to a phone never go stale.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customer_cards');
  if (!hasTable) {
    await knex.schema.createTable('customer_cards', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');
      // 64-hex public token, same mint pattern as customer_documents.share_token.
      t.string('share_token', 64).notNullable().unique();
      // Tech on record at mint time; the card page re-reads the technicians row
      // so a later photo upload shows up without touching this row.
      t.uuid('technician_id').references('id').inTable('technicians');
      t.uuid('service_record_id').references('id').inTable('service_records');
      // Office key from config/locations.js ('bradenton' | 'parrish' | ...) —
      // drives the review target and the card's call/text phone number.
      t.string('location_id', 30);
      // /l short code + full short URL for the review QR (createTrackedShortLink
      // kind='card'); review_target_url keeps the long g.page URL as the
      // never-block fallback when the shortener was unavailable at mint.
      t.string('review_short_code', 80);
      t.text('review_short_url');
      t.text('review_target_url');
      t.timestamp('first_visit_completed_at');
      // Stamped when the card.issued email actually sent (gate-controlled);
      // doubles as the idempotency backstop alongside the send-layer key.
      t.timestamp('email_sent_at');
      t.timestamps(true, true);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customer_cards');
  if (hasTable) {
    await knex.schema.dropTable('customer_cards');
  }
};
