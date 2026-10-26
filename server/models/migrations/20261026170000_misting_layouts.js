/**
 * Saved layouts from the staff misting layout designer (GATE_MISTING_LAYOUT_DESIGNER, step 3).
 *
 * One CURRENT layout per estimate (estimate_id is unique; a re-save replaces the row). The designer
 * works in the Static Maps physical pixel space the Treatment Zone Mapper uses (1280 x 960 at
 * scale 2), so the geometry is stored in that space with the map's center and zoom; feet and the
 * counts are derived from it. nozzles holds the FINAL positions after staff edits, so a reopened
 * layout comes back exactly as saved.
 *
 *   lines    [{ id, kind: 'eave'|'fence', points: [{ x, y }] }]
 *   nozzles  [{ x, y, kind, lineIndex }]   in walking order (the sketch numbers them 1..N)
 *   risers   [{ x, y }]
 *   pump     { x, y } | null
 *   zones    [{ kind, x, y, radiusFt }]    no-mist circles; the radius is kept in feet
 *
 * The composited sketch PNG lives in S3 under service-photos/misting-layouts/ (the prefix the
 * deployed IAM policy already grants, as for treatment zone maps); snapshot_s3_key points at it.
 *
 * A layout is a concept sketch for the estimate document. It is never read by pricing.
 *
 * down() drops the table: the rows are derived sketches the designer can redraw, and nothing else
 * references them. The S3 objects are not touched.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('misting_layouts')) return;
  await knex.schema.createTable('misting_layouts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('estimate_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('estimates')
      .onDelete('CASCADE');
    table.string('address', 300).nullable();
    table.double('center_lat').notNullable();
    table.double('center_lng').notNullable();
    table.integer('zoom').notNullable();
    table.integer('map_width').notNullable();
    table.integer('map_height').notNullable();
    table.jsonb('lines').notNullable().defaultTo('[]');
    table.jsonb('nozzles').notNullable().defaultTo('[]');
    table.jsonb('risers').notNullable().defaultTo('[]');
    table.jsonb('pump').nullable();
    table.jsonb('zones').notNullable().defaultTo('[]');
    table.integer('nozzle_count').notNullable().defaultTo(0);
    table.integer('eave_count').notNullable().defaultTo(0);
    table.integer('fence_count').notNullable().defaultTo(0);
    table.integer('riser_count').notNullable().defaultTo(0);
    table.double('linear_ft').notNullable().defaultTo(0);
    table.string('snapshot_s3_key', 300).nullable();
    table.uuid('created_by').nullable();
    table.uuid('updated_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('misting_layouts');
};
