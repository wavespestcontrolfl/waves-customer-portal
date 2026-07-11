'use strict';

/**
 * customer_cards.email_blocked_count — retryable idempotency for the
 * card.issued email (Codex P2 on PR #2588 round 2).
 *
 * sendTemplate persists blocked attempts under their idempotency key and
 * treats 'blocked' as a terminal dedupe status, so a fixed key would freeze
 * a suppressed customer's card email forever, even after the suppression is
 * corrected. The sender includes this counter in the key
 * (card.issued:customer:<id>:b<count>) and bumps it on a blocked result:
 * the NEXT completion attempt gets a fresh key, while concurrent attempts
 * in the same generation still collapse onto one send.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('customer_cards');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('customer_cards', 'email_blocked_count');
  if (!hasColumn) {
    await knex.schema.alterTable('customer_cards', (t) => {
      t.integer('email_blocked_count').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('customer_cards');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('customer_cards', 'email_blocked_count');
  if (hasColumn) {
    await knex.schema.alterTable('customer_cards', (t) => {
      t.dropColumn('email_blocked_count');
    });
  }
};
