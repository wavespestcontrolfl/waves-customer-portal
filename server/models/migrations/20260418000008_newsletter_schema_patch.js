/**
 * PR 5 — Newsletter infra. Patches the minimal `newsletter_subscribers` table
 * from 20260416000001 with the columns an in-house sender actually needs
 * (unsubscribe_token, customer link, bounce tracking), and adds two new
 * tables that model the send itself + per-recipient deliveries. Deliveries
 * are the row Resend event webhooks update when a message bounces or the
 * recipient complains.
 */

exports.up = async function (knex) {
  // 1. Patch newsletter_subscribers with fields we need for one-click
  //    unsubscribe, customer linking, and bounce suppression.
  const hasUnsubToken = await knex.schema.hasColumn('newsletter_subscribers', 'unsubscribe_token');
  if (!hasUnsubToken) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.uuid('unsubscribe_token').defaultTo(knex.raw('gen_random_uuid()')).unique();
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.integer('bounce_count').defaultTo(0);
      t.timestamp('last_bounced_at');
      t.string('resend_contact_id');
      t.string('first_name');
      t.string('last_name');
      t.jsonb('tags').defaultTo('[]');
      t.index(['customer_id']);
      t.index(['status']);
    });

    // Backfill tokens for rows inserted before the default kicked in.
    await knex.raw(`
      UPDATE newsletter_subscribers
      SET unsubscribe_token = gen_random_uuid()
      WHERE unsubscribe_token IS NULL
    `);
  }

  // 2. newsletter_sends — one row per campaign the operator composes + fires.
  const hasSends = await knex.schema.hasTable('newsletter_sends');
  if (!hasSends) {
    await knex.schema.createTable('newsletter_sends', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('subject').notNullable();
      t.text('html_body');
      t.text('text_body');
      t.string('preview_text');
      t.string('from_name').defaultTo('Waves Pest Control');
      t.string('from_email').defaultTo('newsletter@wavespestcontrol.com');
      t.string('reply_to').defaultTo('contact@wavespestcontrol.com');
      t.string('status').defaultTo('draft');  // draft | sending | sent | failed
      t.integer('recipient_count').defaultTo(0);
      t.integer('delivered_count').defaultTo(0);
      t.integer('bounced_count').defaultTo(0);
      t.integer('complained_count').defaultTo(0);
      t.integer('unsubscribed_count').defaultTo(0);
      t.integer('opened_count').defaultTo(0);  // Resend tracks opens
      t.integer('clicked_count').defaultTo(0);
      t.jsonb('segment_filter');  // null = all active subscribers
      t.timestamp('sent_at');
      t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.string('resend_broadcast_id');
      t.timestamps(true, true);
      t.index(['status']);
      t.index(['sent_at']);
    });
  }

  // 3. newsletter_send_deliveries — per-recipient ledger, updated by Resend
  //    event webhooks. Keeps open/click/bounce attribution granular.
  const hasDeliveries = await knex.schema.hasTable('newsletter_send_deliveries');
  if (!hasDeliveries) {
    await knex.schema.createTable('newsletter_send_deliveries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('send_id').references('id').inTable('newsletter_sends').onDelete('CASCADE').notNullable();
      t.integer('subscriber_id').references('id').inTable('newsletter_subscribers').onDelete('SET NULL');
      t.string('email').notNullable();
      t.string('status').defaultTo('queued');  // queued | sent | delivered | bounced | complained | opened | clicked
      t.string('resend_message_id');
      t.timestamp('sent_at');
      t.timestamp('delivered_at');
      t.timestamp('bounced_at');
      t.timestamp('complained_at');
      t.timestamp('opened_at');
      t.timestamp('clicked_at');
      t.text('bounce_reason');
      t.timestamps(true, true);
      t.unique(['send_id', 'subscriber_id']);
      t.index(['send_id', 'status']);
      t.index(['resend_message_id']);
      t.index(['email']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('newsletter_send_deliveries');
  await knex.schema.dropTableIfExists('newsletter_sends');

  const hasUnsubToken = await knex.schema.hasColumn('newsletter_subscribers', 'unsubscribe_token');
  if (hasUnsubToken) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.dropColumn('unsubscribe_token');
      t.dropColumn('customer_id');
      t.dropColumn('bounce_count');
      t.dropColumn('last_bounced_at');
      t.dropColumn('resend_contact_id');
      t.dropColumn('first_name');
      t.dropColumn('last_name');
      t.dropColumn('tags');
    });
  }
};
