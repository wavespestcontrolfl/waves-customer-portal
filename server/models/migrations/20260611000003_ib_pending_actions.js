/**
 * Pending-action store for UI-backed Intelligence Bar write confirmation
 * (issue #1568). A write proposed in the conversational /query loop is
 * persisted here; the model never sees the row id. Only the operator's
 * Confirm click (POST /confirm-action from the client) can consume a row
 * and execute the write.
 *
 * Replay protection = single-statement claim on status='pending'.
 * params_hash pins the exact payload the operator approved.
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('ib_pending_actions')) return;

  await knex.schema.createTable('ib_pending_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('tool_name', 100).notNullable();
    t.jsonb('params').notNullable();
    t.string('params_hash', 64).notNullable();
    t.text('summary');
    t.string('requested_by', 100).notNullable(); // admin actor id (technicianId) bound at proposal time
    t.string('context', 50); // IB context the proposal came from
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | confirmed | cancelled | expired
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consumed_at', { useTz: true });
    t.jsonb('result');
    t.timestamps(true, true);

    t.index(['status', 'expires_at']);
    t.index(['requested_by', 'status']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ib_pending_actions');
};
