/**
 * Migration: vendor_order_emails (owner ruling 2026-10-26, "OK DO OPTION B").
 *
 * SiteOne's website blocks the order bot, so an admin can instead preview and
 * send ONE pickup-order email to SiteOne for an open restock request. This
 * table is that email's ledger and its send claim, one row per restock
 * request: UNIQUE(restock_request_id) is what makes a request email at most
 * once, the same way vendor_orders is the bot's claim.
 *
 * Lifecycle (server/services/procurement/vendor-order-email.js):
 *   sending   claimed by one admin click; claim_token ties the finalize write
 *             to that claim. send_attempted_at is stamped right BEFORE the
 *             provider call, and once it is set the row is never reopened by
 *             itself: the email may already be with SiteOne.
 *   sent      the provider accepted it (provider_message_id, sent_at, sent_by).
 *   failed    the provider definitely rejected it (HTTP 4xx), so a retry is safe.
 *   pending   reserved for a staged-but-unclaimed row; a claim may take it.
 *   dismissed set by hand to release a stuck 'sending' row after the admin
 *             checked the provider; a claim may take it.
 *
 * ON DELETE RESTRICT on the request: catalog cleanup cannot erase the record
 * of an email that went to a vendor.
 *
 * down(): drops the table. It holds only email copies; the requests it points
 * at are untouched.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('vendor_order_emails')) return;
  await knex.schema.createTable('vendor_order_emails', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('restock_request_id').notNullable().unique('vendor_order_emails_restock_request_id_key')
      .references('id').inTable('product_restock_requests').onDelete('RESTRICT');
    t.uuid('vendor_id').references('id').inTable('vendors').onDelete('SET NULL');
    t.string('recipient', 255).notNullable();
    t.string('cc', 500);
    t.text('subject').notNullable();
    t.text('text_body').notNullable();
    t.text('html').notNullable();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('claim_token', 64);
    t.timestamp('claimed_at', { useTz: true });
    t.timestamp('send_attempted_at', { useTz: true });
    t.timestamp('sent_at', { useTz: true });
    t.string('provider_message_id', 255);
    t.string('sent_by', 255);
    t.string('po', 40).notNullable();
    t.integer('packages').notNullable();
    t.string('item_number', 50).notNullable();
    t.integer('estimate_cents');
    // What the packages hold, in the request's own unit (301 lb asked of a 50 lb
    // pack is 7 packages = 350 lb): the Receive default, as vendor_orders'
    // request_payload.orderedQuantity is for the bot's orders.
    t.decimal('ordered_quantity', 14, 4);
    t.timestamps(true, true);
    t.index(['status', 'created_at'], 'idx_vendor_order_emails_status_created');
  });
  await knex.raw(`
    ALTER TABLE vendor_order_emails
      ADD CONSTRAINT vendor_order_emails_status_check
      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dismissed'))
  `);
  await knex.raw(`
    ALTER TABLE vendor_order_emails
      ADD CONSTRAINT vendor_order_emails_packages_check
      CHECK (packages >= 1)
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vendor_order_emails');
};
