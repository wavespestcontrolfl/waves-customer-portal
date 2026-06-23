/**
 * Seed the SWFL lawn water areas (Manatee / Sarasota / Charlotte). Center-point
 * areas (no polygons yet) so assignment falls back to nearest-center; polygons +
 * calibration factors can be tuned later from real rain-vs-observed data. Idempotent.
 */

const AREAS = [
  { slug: 'bradenton', name: 'Bradenton', area_type: 'coastal', center_lat: 27.4989, center_lng: -82.5748 },
  { slug: 'palmetto', name: 'Palmetto', area_type: 'coastal', center_lat: 27.5214, center_lng: -82.5721 },
  { slug: 'parrish', name: 'Parrish', area_type: 'inland', center_lat: 27.5950, center_lng: -82.4243 },
  { slug: 'lakewood-ranch', name: 'Lakewood Ranch', area_type: 'inland', center_lat: 27.4189, center_lng: -82.4015 },
  { slug: 'sarasota', name: 'Sarasota', area_type: 'coastal', center_lat: 27.3364, center_lng: -82.5307 },
  { slug: 'venice', name: 'Venice', area_type: 'coastal', center_lat: 27.0998, center_lng: -82.4543 },
  { slug: 'wellen-park', name: 'Wellen Park', area_type: 'inland', center_lat: 27.0530, center_lng: -82.3540 },
  { slug: 'north-port', name: 'North Port', area_type: 'inland', center_lat: 27.0442, center_lng: -82.2359 },
  { slug: 'port-charlotte', name: 'Port Charlotte', area_type: 'coastal', center_lat: 26.9762, center_lng: -82.0906 },
  { slug: 'punta-gorda', name: 'Punta Gorda', area_type: 'coastal', center_lat: 26.9298, center_lng: -82.0454 },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_water_areas'))) return;
  for (const a of AREAS) {
    await knex('lawn_water_areas')
      .insert({
        ...a,
        weather_provider: 'radar',
        rain_adjustment_factor: 1.0,
        water_demand_factor: 1.0,
        confidence: 'medium',
        active: true,
      })
      .onConflict('slug')
      .ignore();
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_water_areas'))) return;
  await knex('lawn_water_areas').whereIn('slug', AREAS.map((a) => a.slug)).del();
};
