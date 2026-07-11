/**
 * Customer duplicate-merge tooling — two tables:
 *
 * customer_merge_journal — one row per executed merge (auto or manual). Stores
 * a FULL jsonb snapshot of the losing customer row plus per-table repoint
 * counts, so any merge can be audited and hand-reversed. The losing row itself
 * is soft-deleted (deleted_at) with its phone/email nulled so intake lookups
 * (which match on raw phone and do NOT all filter deleted_at) can never
 * resolve a merged-away row again — the journal keeps the original values.
 *
 * customer_duplicate_dismissals — "not a duplicate" verdicts from the review
 * queue. Pair is stored ordered (a < b by uuid text) with a unique constraint
 * so detection can exclude adjudicated pairs and a re-dismiss is idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_merge_journal'))) {
    await knex.schema.createTable('customer_merge_journal', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('winner_customer_id').notNullable().references('id').inTable('customers');
      // No FK on the loser — the row is soft-deleted and could in principle be
      // hard-purged later; the snapshot is the durable record.
      t.uuid('loser_customer_id').notNullable();
      t.jsonb('loser_snapshot').notNullable();
      t.jsonb('repointed').notNullable().defaultTo('{}'); // { "<table>.<column>": rowCount }
      t.jsonb('winner_backfills').notNullable().defaultTo('{}'); // fields filled onto the winner
      t.string('tier', 20).notNullable(); // 'green' (auto) | 'manual'
      t.jsonb('evidence').notNullable().defaultTo('{}'); // phone/name/address match detail
      t.string('performed_by', 100).notNullable(); // 'auto:dedupe-cron' or admin identifier
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('undone_at').nullable();
      t.index('winner_customer_id');
      t.index('loser_customer_id');
    });
  }

  if (!(await knex.schema.hasTable('customer_duplicate_dismissals'))) {
    await knex.schema.createTable('customer_duplicate_dismissals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id_a').notNullable();
      t.uuid('customer_id_b').notNullable();
      t.string('reason', 500).nullable();
      t.string('created_by', 100).notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['customer_id_a', 'customer_id_b']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_duplicate_dismissals');
  await knex.schema.dropTableIfExists('customer_merge_journal');
};
