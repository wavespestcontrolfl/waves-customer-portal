'use strict';

/**
 * Annual rate review — the owner's cost block (comms lane).
 *
 * The letter (billing.rate_review_notice) prints rate_review_config.cost_block
 * under "What changed on our side this year", and the comms sender refuses
 * every send while it is blank. The admin screen lane (#5492, migration
 * 20260930220000_rate_review_review_columns) adds the same column with its
 * set_at / set_by stamps; this branch can merge before it, so the column the
 * sender reads is added here too. Both migrations guard on hasColumn, so
 * whichever runs second is a no-op.
 *
 * down() is a documented NO-OP: the column carries the owner's hand-written
 * paragraph and is shared with the admin screen lane, whose own down()
 * removes it.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('rate_review_config'))) return;
  if (await knex.schema.hasColumn('rate_review_config', 'cost_block')) return;
  await knex.schema.alterTable('rate_review_config', (t) => t.text('cost_block'));
};

// Documented no-op — see the header.
exports.down = async function down() {};
