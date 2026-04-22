/**
 * Drop all Square payment-processor columns now that Stripe is the sole
 * processor, and rename scheduled_services.square_booking_id →
 * external_booking_id (the column has been repurposed for Google Calendar
 * event IDs by server/services/calendar-sync.js).
 *
 * All column drops are hasColumn-guarded so the migration is safe to re-run
 * and tolerant of partial earlier states.
 *
 * Also deletes the "Why We Moved From Square to Stripe" knowledge_base
 * article seeded by 20260415000013_seed_founder_knowledge.js — the
 * accompanying seed entry is removed in the same change so fresh DB
 * setups do not re-insert it.
 */

const SQUARE_COLUMN_DROPS = [
  ['customers', ['square_customer_id', 'square_notes', 'square_groups', 'square_created_at']],
  ['payment_methods', ['square_card_id']],
  ['payments', ['square_payment_id', 'square_invoice_id', 'square_order_id']],
  ['invoices', ['square_payment_id']],
  ['services', ['square_service_id', 'square_variation_id']],
  ['technicians', ['square_team_member_id']],
  ['customer_subscriptions', ['square_subscription_id', 'square_customer_id']],
];

exports.up = async (knex) => {
  // Rename scheduled_services.square_booking_id → external_booking_id
  if (await knex.schema.hasTable('scheduled_services')) {
    const hasOld = await knex.schema.hasColumn('scheduled_services', 'square_booking_id');
    const hasNew = await knex.schema.hasColumn('scheduled_services', 'external_booking_id');
    if (hasOld && !hasNew) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.renameColumn('square_booking_id', 'external_booking_id');
      });
    } else if (hasOld && hasNew) {
      // Both exist: copy any non-null old values into new, then drop old.
      await knex.raw(`
        UPDATE scheduled_services
           SET external_booking_id = square_booking_id
         WHERE external_booking_id IS NULL
           AND square_booking_id IS NOT NULL
      `);
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.dropColumn('square_booking_id');
      });
    }
  }

  for (const [table, cols] of SQUARE_COLUMN_DROPS) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  }

  if (await knex.schema.hasTable('knowledge_base')) {
    await knex('knowledge_base')
      .where('path', 'wiki/business-strategy/stripe-discount-model.md')
      .del();
  }
};

exports.down = async () => {
  // Irreversible: Square is fully phased out and the column data has been
  // cleared by earlier migrations. Re-adding empty columns would restore
  // nothing useful. Roll forward, not back.
};
