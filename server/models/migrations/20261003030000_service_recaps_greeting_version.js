// The greeting rule a recap video was rendered under. The intro bakes the customer's
// greeting into the MP4, so a recap rendered before the blank-first-name rule
// (null here) for a customer with no first name greets them by their SURNAME; approve
// and send re-render it instead of delivering the stale video (codex #5674 r1).
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'greeting_version');
  if (!hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.integer('greeting_version').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_recaps');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_recaps', 'greeting_version');
  if (hasCol) {
    await knex.schema.alterTable('service_recaps', (t) => {
      t.dropColumn('greeting_version');
    });
  }
};
