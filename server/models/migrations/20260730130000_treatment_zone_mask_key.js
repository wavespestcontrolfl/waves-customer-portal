// Lawn report pulse (owner 2026-07-30 "can we make the render pulse — the
// goal is to show where we sprayed"): the grass-highlight layer is saved as
// its own transparent PNG alongside the composited snapshot, so the customer
// report can ANIMATE the green breathing over the photo. Nullable — spray/
// outline saves and legacy rows have no mask.
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('treatment_zone_maps', 'mask_s3_key')) return;
  await knex.schema.alterTable('treatment_zone_maps', (table) => {
    table.string('mask_s3_key', 255).nullable();
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('treatment_zone_maps', 'mask_s3_key'))) return;
  await knex.schema.alterTable('treatment_zone_maps', (table) => {
    table.dropColumn('mask_s3_key');
  });
};
