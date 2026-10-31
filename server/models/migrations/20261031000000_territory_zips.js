/**
 * Territories by ZIP, build 1 (owner 2026-10-30 "go" on question 4 of the
 * "Waves Territory Map" scope page).
 *
 * One row per service ZIP: its area (config/territory-areas.js) and the
 * technician whose territory it is. technician_id starts NULL on every row: a
 * ZIP with no technician adds no routing rule, so nothing routes differently
 * until a territory is assigned (the handover run sets it, build 6).
 *
 * The 52 ZIPs and their areas are the scope page's map (Census ZIP areas, hard
 * edges at the Manatee River, I-75, University Parkway and the county line).
 * The list is frozen here on purpose: a later re-cut moves technician_id, never
 * this seed.
 */
const AREA_ZIPS = {
  north_river: ['34219', '34221', '34222', '34250'],
  ranch: ['34202', '34211', '34212', '34251'],
  bradenton_west: ['34203', '34205', '34207', '34208', '34209', '34210', '34215', '34216', '34217'],
  university: ['34201', '34234', '34235', '34240', '34243'],
  sarasota: ['34228', '34231', '34232', '34233', '34236', '34237', '34238', '34239', '34241', '34242'],
  venice: ['34223', '34229', '34275', '34285', '34286', '34287', '34288', '34289', '34291', '34292', '34293'],
  charlotte: ['33947', '33948', '33950', '33952', '33953', '33954', '33980', '33983', '34224'],
};

const seedRows = () => Object.entries(AREA_ZIPS)
  .flatMap(([area, zips]) => zips.map((zip) => ({ zip, area })));

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('territory_zips'))) {
    await knex.schema.createTable('territory_zips', (t) => {
      t.string('zip', 5).primary();
      t.string('area', 32).notNullable();
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['area'], 'territory_zips_area_idx');
      t.index(['technician_id'], 'territory_zips_technician_idx');
    });
  }
  await knex('territory_zips').insert(seedRows()).onConflict('zip').ignore();
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('territory_zips');
};

exports._private = { AREA_ZIPS, seedRows };
