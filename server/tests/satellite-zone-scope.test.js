// Guards for how persisted property_zones interact with report rendering
// (satellite coverage PR 1, Codex round-1 P2s):
//  - an UNSCOPED product (no zone_ids, no application_area) fans out to the
//    visit's chipped areas only — never to every persisted zone on the
//    property (a later multi-area visit must not mark historical zones as
//    serviced);
//  - the satellite overlay never mixes technician-marked image shapes with
//    schematic house-diagram rects: once any zone is marked, unmarked zones
//    drop from the photo overlay.

const { buildReportV1Data } = require('../services/service-report/report-data');
const { buildSatelliteTreatmentMapContext } = require('../services/service-report/satellite-treatment-map');

function makeKnex(fixtures) {
  return (table) => {
    let rows = [...(fixtures[table] || [])];
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria)
            .every(([key, val]) => key === 'is_active' ? row[key] !== false : row[key] === val));
        } else if (typeof criteria === 'string' && arguments.length === 2) {
          rows = rows.filter((row) => row[criteria] === value);
        }
        return query;
      },
      andWhere: () => query,
      whereIn: () => query,
      whereNot: () => query,
      modify: () => query,
      limit: () => query,
      orderBy: () => query,
      leftJoin: () => query,
      select: () => query,
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
}

const ZONES = [
  { id: 'z-a', customer_id: 'customer-1', letter: 'A', label: 'Perimeter', category: 'perimeter', geometry: { x: 64, y: 42, w: 512, h: 46 }, service_lines: ['pest'], is_active: true },
  { id: 'z-b', customer_id: 'customer-1', letter: 'B', label: 'Entry points', category: 'entry_points', geometry: { x: 64, y: 250, w: 512, h: 46 }, service_lines: ['pest'], is_active: true },
  { id: 'z-c', customer_id: 'customer-1', letter: 'C', label: 'Yard', category: 'lawn', geometry: { x: 64, y: 88, w: 48, h: 162 }, service_lines: ['pest'], is_active: true },
];

test('unscoped product fans out to chipped areas only, not every persisted zone', async () => {
  const knex = makeKnex({
    property_geometries: [],
    property_zones: ZONES,
    service_findings: [],
    service_photos: [],
    service_products: [{
      id: 'prod-1',
      service_record_id: 'service-scope',
      product_name: 'Taurus SC',
      // no zone_ids, no application_area — the unscoped default
      created_at: '2026-07-05T10:00:00Z',
    }],
    scheduled_services: [],
  });

  const data = await buildReportV1Data({
    id: 'service-scope',
    customer_id: 'customer-1',
    service_line: 'pest',
    service_type: 'Quarterly Pest Control Service',
    service_date: '2026-07-05',
    first_name: 'Van',
    last_name: 'Lee',
    // this visit only chipped Perimeter — z-b / z-c belong to other visits
    areas_serviced: JSON.stringify(['Perimeter']),
    structured_notes: '{}',
    service_data: '{}',
    pressure_index: 0,
  }, 'token-zone-scope', knex);

  const app = data.applications.find((a) => a.productName === 'Taurus SC' || a.product_name === 'Taurus SC') || data.applications[0];
  expect(app.zone_ids).toEqual(['z-a']);

  // and the coverage list shows only the chipped zone as serviced
  const coverageIds = (data.serviceCoverage?.items || []).map((item) => item.zoneId || item.zone_id || item.geometryId);
  expect(coverageIds).not.toContain('z-b');
  expect(coverageIds).not.toContain('z-c');
});

test('satellite overlay drops schematic-only zones once any zone is marked', async () => {
  process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED = 'true';
  process.env.GOOGLE_STATIC_MAPS_API_KEY = 'test-key';
  try {
    const marked = { ...ZONES[0], geometry_image: { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.15 } };
    const context = await buildSatelliteTreatmentMapContext({
      service: { customer_latitude: 27.36709, customer_longitude: -82.387077 },
      zones: [marked, ZONES[1], ZONES[2]],
      applications: [],
      mode: 'live',
    });
    expect(context.available).toBe(true);
    expect(context.overlay.zones.map((zone) => zone.id)).toEqual(['z-a']);
    expect(context.overlay.zones[0].overlaySource).toBe('image_normalized');

    // with no marks at all, the legacy approximate projection keeps all zones
    const legacy = await buildSatelliteTreatmentMapContext({
      service: { customer_latitude: 27.36709, customer_longitude: -82.387077 },
      zones: ZONES,
      applications: [],
      mode: 'live',
    });
    expect(legacy.available).toBe(true);
    expect(legacy.overlay.zones).toHaveLength(3);
  } finally {
    delete process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED;
    delete process.env.GOOGLE_STATIC_MAPS_API_KEY;
  }
});
