/**
 * Allow reply training examples to represent "no reply needed" outcomes.
 * Those examples have a reviewed verdict but no customer-facing final reply.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('reply_training_examples');
  if (!exists) return;

  const hasOutboundBody = await knex.schema.hasColumn('reply_training_examples', 'outbound_body');
  if (hasOutboundBody) {
    await knex.schema.alterTable('reply_training_examples', (t) => {
      t.text('outbound_body').nullable().alter();
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS reply_training_examples_review_verdict_idx
      ON reply_training_examples (review_verdict, captured_at DESC)
  `);
};

exports.down = async function (knex) {
  const exists = await knex.schema.hasTable('reply_training_examples');
  if (!exists) return;

  await knex.raw('DROP INDEX IF EXISTS reply_training_examples_review_verdict_idx');
  await knex('reply_training_examples')
    .whereNull('outbound_body')
    .update({ outbound_body: '' });

  const hasOutboundBody = await knex.schema.hasColumn('reply_training_examples', 'outbound_body');
  if (hasOutboundBody) {
    await knex.schema.alterTable('reply_training_examples', (t) => {
      t.text('outbound_body').notNullable().alter();
    });
  }
};
