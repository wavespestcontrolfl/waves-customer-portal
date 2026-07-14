'use strict';

/**
 * Payment-step checkout events + follow-up send ledger.
 *
 * estimate_checkout_events: one row per (estimate, kind) stamped when a
 * customer reaches the save-a-card step. /recurring-card-intent and
 * /card-hold-intent mint a Stripe SetupIntent but persist nothing locally,
 * so "reached the payment step and bailed" — the highest-intent drop-off in
 * the card-on-file accept flow — was invisible until now. updated_at bumps
 * on every re-reach, mirroring the retired deposit-intent reuse pattern, so
 * it reads as "last time the customer touched the payment step".
 *
 * estimate_followup_sends: per-(estimate, rule) send ledger for the
 * engagement follow-up lane. The unique (estimate_id, rule_key) index
 * doubles as the atomic send claim (INSERT ... ON CONFLICT DO NOTHING);
 * rows carry a trigger snapshot for touch attribution. New follow-up rules
 * use this ledger instead of adding another boolean column on estimates.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_checkout_events'))) {
    await knex.schema.createTable('estimate_checkout_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
      // 'recurring_card' (Auto Pay card on a recurring accept) or
      // 'card_hold' (one-time no-show hold). String, not enum: the
      // engagement engine will add kinds and a CHECK would need a
      // migration per addition.
      t.string('kind', 32).notNullable();
      t.string('setup_intent_id', 100);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['estimate_id', 'kind']);
      // The follow-up cron scans a bounded updated_at window every tick.
      t.index('updated_at');
    });
  }

  if (!(await knex.schema.hasTable('estimate_followup_sends'))) {
    await knex.schema.createTable('estimate_followup_sends', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
      t.string('rule_key', 64).notNullable();
      t.string('template_key', 128);
      t.jsonb('trigger');
      t.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      // Doubles as the atomic claim: whoever wins the insert sends.
      t.unique(['estimate_id', 'rule_key']);
      t.index(['rule_key', 'sent_at']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_followup_sends');
  await knex.schema.dropTableIfExists('estimate_checkout_events');
};
