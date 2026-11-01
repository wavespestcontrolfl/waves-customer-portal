// GATE_RECAP_GLASSES_CLIPS (owner 2026-11-01): counts recap clips that became ready, on the recap row itself.
// A late clip adds 1 in the same UPDATE that re-queues the recap; a render keeps the value it claimed and
// publishes 'ready' only if the row still has it, in the UPDATE that publishes the video. A clip, an
// approval and a send claim so all order on one row, with no clock compared. 0 = no late clip (always,
// with the gate off).
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'clip_revision');
  if (!hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.integer('clip_revision').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'clip_revision');
  if (hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.dropColumn('clip_revision');
    });
  }
};
