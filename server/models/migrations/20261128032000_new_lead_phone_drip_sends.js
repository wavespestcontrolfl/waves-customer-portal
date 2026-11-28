'use strict';

/**
 * Durable per-lead, per-step send claim table for the phone-only residential lead SMS drip
 * (GATE_NEW_LEAD_DRIP_EXTENDED, owner 2026-11-27, Decision 2).
 *
 * Guarantees at-most-once SMS delivery per (lead_id, step) across overlapping ticks, crashes
 * between Twilio acceptance and activity logging, and uncertain provider outcomes.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('new_lead_phone_drip_sends')) return;
  await knex.schema.createTable('new_lead_phone_drip_sends', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('lead_id').notNullable().references('id').inTable('leads').onDelete('CASCADE');
    t.smallint('step').notNullable();
    t.string('status', 20).notNullable().defaultTo('claimed');
    t.text('destination_phone').notNullable();
    t.text('delivery_key').notNullable();
    t.text('provider_message_id').nullable();
    t.timestamp('claimed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.unique(['lead_id', 'step'], { indexName: 'new_lead_phone_drip_sends_lead_step_uniq' });
    t.index(['status', 'claimed_at'], 'new_lead_phone_drip_sends_status_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('new_lead_phone_drip_sends');
};
