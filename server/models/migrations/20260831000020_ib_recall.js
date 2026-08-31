/**
 * Intelligence Bar recall (W-RECALL, owner-ratified 2026-08-31: RAW —
 * search the stored verbatim turns, no summaries).
 *
 *   ib_thread_turns  — GIN full-text index over content so search_ib_history
 *                      can rank matches without scanning every turn.
 *   ib_pending_actions.thread_id + thread_turn_seq — the thread AND the
 *                      exact exchange (assistant turn seq) that proposed the
 *                      action, stamped when /query persists the exchange.
 *                      Lets recall join a matched exchange to the receipts
 *                      of what was actually approved/executed,
 *                      deterministically (no time-window guessing, no
 *                      thread-wide attribution).
 *
 * Both idempotent; down removes both.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ib_thread_turns')) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_ib_thread_turns_content_fts
        ON ib_thread_turns USING GIN (to_tsvector('english', content))
    `);
  }

  if (await knex.schema.hasTable('ib_pending_actions')
    && !(await knex.schema.hasColumn('ib_pending_actions', 'thread_id'))) {
    await knex.schema.alterTable('ib_pending_actions', (t) => {
      t.uuid('thread_id').nullable();
      t.integer('thread_turn_seq').nullable();
      t.index(['thread_id', 'thread_turn_seq'], 'idx_ib_pending_actions_thread');
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_ib_thread_turns_content_fts');
  if (await knex.schema.hasTable('ib_pending_actions')
    && (await knex.schema.hasColumn('ib_pending_actions', 'thread_id'))) {
    await knex.schema.alterTable('ib_pending_actions', (t) => {
      t.dropIndex(['thread_id', 'thread_turn_seq'], 'idx_ib_pending_actions_thread');
      t.dropColumn('thread_turn_seq');
      t.dropColumn('thread_id');
    });
  }
};
