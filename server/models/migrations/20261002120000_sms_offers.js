/**
 * sms_offers — the appointment times a Waves text actually offered a customer
 * (GATE_SMS_OFFER_LEDGER, dark). One row per SENT agent decision whose reply
 * quoted times from OPEN TIMES: which job the offer was for (an upcoming visit,
 * an estimate, or a new /book visit), the exact slots that survived into the
 * sent text, and when the offer lapses.
 *
 * Written after the provider accepts the send (services/sms-offers.js, called
 * from messaging/send-customer-message.js). Nothing reads it to act yet: this
 * slice only records, so "the customer accepted a time we offered" has a durable
 * record to match against, and the scheduling funnel report has offers to count.
 *
 * One OPEN offer per phone and kind: a newer offer supersedes the older one
 * (sms_offers_one_open_per_phone_kind). expires_at is checked by readers; an
 * expired row keeps status 'open' until a newer offer or a later slice closes it.
 */

const TABLE = 'sms_offers';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // The decision whose sent reply made the offer. One offer per decision: a
    // retried or deduped send records nothing new.
    t.uuid('agent_decision_id').notNullable().unique()
      .references('id').inTable('agent_decisions').onDelete('CASCADE');
    // The provider's id for the outbound text (sms_log.twilio_sid).
    t.string('provider_message_id', 64);
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('phone_last10', 10).notNullable();
    // move_visit | book_estimate | book_new | unknown (a pre-scheduler snapshot)
    t.string('kind', 20).notNullable();
    t.uuid('scheduled_service_id');
    t.uuid('estimate_id');
    t.string('service_key', 80);
    // [{ date_label, window_label, date: 'YYYY-MM-DD'|null, start: 'HH:MM'|null, end: 'HH:MM'|null }]
    t.jsonb('slots').notNullable();
    t.timestamp('sent_at', { useTz: true }).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    // open | superseded (later slices add accepted / declined / failed)
    t.string('status', 20).notNullable().defaultTo('open');
    t.uuid('superseded_by');
    t.timestamp('closed_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['customer_id', 'status']);
    t.index(['scheduled_service_id', 'status']);
    t.index('sent_at');
  });
  await knex.raw(
    `CREATE UNIQUE INDEX sms_offers_one_open_per_phone_kind ON ${TABLE} (phone_last10, kind) WHERE status = 'open'`,
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
