// Give customer lawn outlines the City of North Port overlay instead of the surrounding Sarasota
// County June 1 rule. The plan engine already layers North Port through municipality_ordinances;
// this row is the outline/card source read by lawn-service-outline.js.
//
// Source verified 2026-11-18: City of North Port fertilizer fact sheet (flyer revised May 10, 2023).
// https://www.northportfl.gov/files/assets/main/v/1/city-services-amp-safety/public-works/fertilizer-fact-sheet-updated.pdf

const NORTH_PORT_RULE = Object.freeze({
  jurisdiction_id: 'north_port_fl',
  jurisdiction_name: 'City of North Port, FL',
  state: 'FL',
  county: 'Sarasota',
  municipality: 'North Port',
  restricted_start_month: 4,
  restricted_start_day: 1,
  restricted_end_month: 9,
  restricted_end_day: 30,
  nitrogen_restricted: true,
  phosphorus_restricted: true,
  phosphorus_soil_test_required: false,
  minimum_slow_release_nitrogen_percent: 50,
  waterway_buffer_rule: 'Keep fertilizer at least 10 ft from a pond, stream, canal or top of a seawall; do not apply in a wetland, within its 25 ft buffer, or in a swale flow channel.',
  professional_certification_note: 'Commercial and institutional fertilizer applicators must complete a City-approved training and certification program.',
  public_summary: 'No nitrogen or phosphorus fertilizer may be applied to turf from April 1 through September 30; landscape plants remain outside this seasonal turf restriction.',
  admin_summary: 'North Port city overlay: April 1-September 30 N/P turf restriction; 10 ft water setback; no fertilizer in wetlands, their 25 ft buffers, or swale flow channels.',
  source_url: 'https://www.northportfl.gov/files/assets/main/v/1/city-services-amp-safety/public-works/fertilizer-fact-sheet-updated.pdf',
  source_verified_at: '2026-11-18T00:00:00.000Z',
  status: 'approved',
  version: '2026-11-18',
});

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('jurisdiction_fertilizer_rules'))) return;
  await knex('jurisdiction_fertilizer_rules')
    .insert(NORTH_PORT_RULE)
    .onConflict(['jurisdiction_id', 'version'])
    .merge({ ...NORTH_PORT_RULE, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('jurisdiction_fertilizer_rules'))) return;
  await knex('jurisdiction_fertilizer_rules')
    .where({ jurisdiction_id: NORTH_PORT_RULE.jurisdiction_id, version: NORTH_PORT_RULE.version })
    .del();
};

exports.NORTH_PORT_RULE = NORTH_PORT_RULE;
