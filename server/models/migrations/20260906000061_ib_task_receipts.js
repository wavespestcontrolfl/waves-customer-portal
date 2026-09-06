/** Extend existing IB conversations/confirmation receipts with request identity.
 * Tasks are a recovery ledger; writes still execute only through pending actions.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_tasks'))) {
    await knex.schema.createTable('ib_tasks', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('actor_id', 100).notNullable();
      t.uuid('session_id').notNullable();
      t.string('request_key', 120).notNullable();
      t.string('request_hash', 64).notNullable();
      t.string('state', 32).notNullable().defaultTo('running');
      t.uuid('runner_token').notNullable();
      t.timestamp('lease_expires_at', { useTz: true }).notNullable();
      t.jsonb('page_context').notNullable().defaultTo('{}');
      t.jsonb('target').notNullable().defaultTo('{}');
      t.jsonb('request').notNullable();
      t.jsonb('checkpoint');
      t.jsonb('response');
      t.timestamp('expires_at', { useTz: true }).notNullable();
      t.timestamps(true, true);
      t.unique(['actor_id', 'session_id', 'request_key'], 'ib_tasks_request_unique');
      t.index(['actor_id', 'session_id', 'created_at'], 'ib_tasks_actor_session');
    });
  }
  if (await knex.schema.hasTable('ib_pending_actions')) {
    if (!(await knex.schema.hasColumn('ib_pending_actions', 'task_id'))) {
      await knex.schema.alterTable('ib_pending_actions', t => {
        t.uuid('task_id').references('id').inTable('ib_tasks').onDelete('SET NULL');
        t.string('step_key', 64);
        t.unique(['task_id', 'step_key'], 'ib_pending_actions_task_step_unique');
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('ib_pending_actions') && await knex.schema.hasColumn('ib_pending_actions', 'task_id')) {
    await knex.schema.alterTable('ib_pending_actions', t => {
      t.dropUnique(['task_id', 'step_key'], 'ib_pending_actions_task_step_unique');
      t.dropColumn('task_id');
      t.dropColumn('step_key');
    });
  }
  if (await knex.schema.hasTable('ib_tasks')) await knex.schema.dropTable('ib_tasks');
};
