'use strict';

/**
 * Card-on-file spec §3.2 (auto-satisfy): an existing customer's saved,
 * consented card can back a one-time HOLD directly — no SetupIntent is
 * minted, so estimate_card_holds.stripe_setup_intent_id must accept NULL
 * (it was created notNullable().unique() by 20260624000010; without this
 * relax, saved-method accepts would fail inside the accept transaction and
 * roll the booking back — Codex #2680). The UNIQUE constraint stays:
 * Postgres treats NULLs as distinct, and recordCardHoldHeld dedupes SI-less
 * holds per estimate itself.
 *
 * down() restores NOT NULL, which requires removing SI-less rows first —
 * those are saved-method holds only; rolling back the feature forfeits
 * their hold records (documented data loss, matching a feature rollback).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_card_holds'))) return;
  await knex.schema.alterTable('estimate_card_holds', (t) => {
    t.string('stripe_setup_intent_id', 100).nullable().alter();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimate_card_holds'))) return;
  await knex('estimate_card_holds').whereNull('stripe_setup_intent_id').del();
  await knex.schema.alterTable('estimate_card_holds', (t) => {
    t.string('stripe_setup_intent_id', 100).notNullable().alter();
  });
};
