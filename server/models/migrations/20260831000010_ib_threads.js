/**
 * Intelligence Bar server-persisted conversations (operating-terminal scope,
 * owner-ratified 2026-08-31 "I want both").
 *
 * Today the IB thread lives only in the browser — the client round-trips the
 * trimmed history and a refresh/route change wipes it. These tables move the
 * thread server-side, keyed to the admin actor:
 *
 *   ib_threads       — one row per conversation (actor-bound, titled from the
 *                      first prompt, last_active_at drives resume + retention)
 *   ib_thread_turns  — the persisted turns, exactly the marker-tainted
 *                      user/assistant strings the client already round-trips
 *                      (images are never persisted; their text markers are)
 *
 * Retention: threads are hard-deleted after IB_THREAD_RETENTION_DAYS
 * (default 365) by the daily purge cron — turns ride the FK cascade.
 * Technician sessions never persist (admin actors only, enforced in code).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_threads'))) {
    await knex.schema.createTable('ib_threads', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('admin_actor_id', 64).notNullable();
      t.string('title', 120);
      t.string('context', 40);
      t.timestamp('last_active_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.index(['admin_actor_id', 'last_active_at'], 'idx_ib_threads_actor_active');
    });
  }

  if (!(await knex.schema.hasTable('ib_thread_turns'))) {
    await knex.schema.createTable('ib_thread_turns', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('thread_id').notNullable()
        .references('id').inTable('ib_threads').onDelete('CASCADE');
      t.integer('seq').notNullable();
      t.string('role', 16).notNullable();
      t.text('content').notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['thread_id', 'seq'], 'uq_ib_thread_turns_thread_seq');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ib_thread_turns');
  await knex.schema.dropTableIfExists('ib_threads');
};
