'use strict';

/**
 * live_activity_sessions: one row per Lock Screen visit card the server started (GATE_VISIT_LIVE_ACTIVITY,
 * owner 2026-11-11; services/visit-live-activity.js).
 *
 * A card belongs to one STOP: a customer, a saved address, an ET day and a technician (the rule the
 * on-the-way text uses), or one visit when the visit has no saved address. The row is the card's memory:
 *   stop_key      the stop. At most ONE row per stop has no ended_at (the partial unique index), so two
 *                 processes can never start two cards for one stop.
 *   channel_id    the Apple broadcast channel the card listens on. NULL while a start is in progress.
 *   member_ids    the visits this card has shown (a finished visit counts toward "Service complete" only
 *                 when the card showed it).
 *   seq, push_ts  the order of the card's updates. Each sender takes the next seq and a strictly later
 *                 Apple timestamp in one conditional UPDATE, so an older update can never land on top of a
 *                 newer one.
 *   state, sent_sig  what the phones were last told (the card's content, and its signature). A sweep sends
 *                 again when the signature differs from the visit.
 *   start_results Apple's answer for each iPhone the start went to: [{ device: push_subscriptions.id, ok, reason }].
 *                 Apple accepting a start is not proof the card showed; this is what a first test reads.
 *   ended_at      the card was ended (end_reason says why). channel_deleted_at: its channel was removed.
 *
 * Ids, times and the card's own two lines (the technician's first name with a last initial, the service
 * name): no customer name, address or phone number. No foreign keys on purpose: this is the card's log, and
 * a customer or visit row must never be blocked by it. Additive; down drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('live_activity_sessions')) return;
  await knex.schema.createTable('live_activity_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('stop_key').notNullable();
    t.uuid('customer_id').notNullable();
    t.uuid('property_id').nullable();
    t.uuid('technician_id').nullable();
    t.text('service_day').notNullable();
    t.uuid('scheduled_service_id').notNullable();
    t.jsonb('member_ids').notNullable().defaultTo('[]');
    t.text('channel_id').nullable();
    t.text('phase').nullable();
    t.timestamp('phase_since', { useTz: true }).nullable();
    t.jsonb('state').nullable();
    t.text('sent_sig').nullable();
    t.integer('seq').notNullable().defaultTo(0);
    t.bigInteger('push_ts').notNullable().defaultTo(0);
    t.integer('devices_started').notNullable().defaultTo(0);
    t.jsonb('start_results').nullable();
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('last_sent_at', { useTz: true }).nullable();
    t.timestamp('ended_at', { useTz: true }).nullable();
    t.text('end_reason').nullable();
    t.timestamp('channel_deleted_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['stop_key', 'ended_at'], 'live_activity_sessions_stop_ended_idx');
  });
  // One live card per stop.
  await knex.raw('CREATE UNIQUE INDEX live_activity_sessions_live_stop_uidx ON live_activity_sessions (stop_key) WHERE ended_at IS NULL');
  // The sweep's channel clean-up: ended cards whose channel still exists.
  await knex.raw('CREATE INDEX live_activity_sessions_channel_cleanup_idx ON live_activity_sessions (ended_at) WHERE channel_id IS NOT NULL AND channel_deleted_at IS NULL');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('live_activity_sessions');
};
