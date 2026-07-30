// Discriminate HOW a treatment-zone trace was captured (codex P1 #3038):
// 'lawn' = turf-boundary outline (lawn mapper mode), 'perimeter' = the
// building-perimeter spray workflow. Legacy rows stay NULL (captured before
// the mode existed — the report treats them as unlabeled and avoids claiming
// "treated lawn area" for what may be a building footprint).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('treatment_zone_maps'))) return;
  if (await knex.schema.hasColumn('treatment_zone_maps', 'capture_mode')) return;
  await knex.schema.alterTable('treatment_zone_maps', (table) => {
    table.string('capture_mode', 20).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('treatment_zone_maps'))) return;
  if (!(await knex.schema.hasColumn('treatment_zone_maps', 'capture_mode'))) return;
  await knex.schema.alterTable('treatment_zone_maps', (table) => {
    table.dropColumn('capture_mode');
  });
};
