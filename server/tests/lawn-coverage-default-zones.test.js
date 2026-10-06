// GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES (owner 2026-10-06): a lawn report whose
// coverage zones are only the schematic defaults shows no coverage section; a
// property with technician-marked zones keeps it; gate off changes nothing.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signed-map-images';
const { buildReportV1Data } = require('../services/service-report/report-data');

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


const LAWN_SERVICE = {
  id: 'service-lawn',
  customer_id: 'customer-1',
  service_line: 'lawn',
  service_type: 'Every 6 Weeks Lawn Care Service',
  service_date: '2026-10-06',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Front perimeter', 'Rear perimeter', 'Left perimeter', 'Right perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};
const MARKED = [{ id: 'z-a', customer_id: 'customer-1', letter: 'A', label: 'Front perimeter', category: 'lawn', geometry: { x: 64, y: 42, w: 512, h: 46 }, service_lines: ['lawn'], is_active: true }];
const build = (zones) => buildReportV1Data({ ...LAWN_SERVICE }, 'token-lawn-coverage', makeKnex({
  property_geometries: [], property_zones: zones, service_findings: [], service_photos: [], service_products: [], scheduled_services: [],
}));

const KEY = 'GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES';
afterEach(() => { delete process.env[KEY]; });

test('gate off: a lawn report with default zones keeps its coverage section (unchanged)', async () => {
  const data = await build([]);
  expect(data.serviceCoverage.enabled).toBe(true);
  expect((data.serviceCoverage.items || []).length).toBeGreaterThan(0);
});

test('gate on: a lawn report built only from schematic default zones shows no coverage section', async () => {
  process.env[KEY] = 'true';
  const data = await build([]);
  expect(data.serviceCoverage).toEqual({ enabled: false });
});

test('gate on: technician-marked lawn zones keep the coverage section', async () => {
  process.env[KEY] = 'true';
  const data = await build(MARKED);
  expect(data.serviceCoverage.enabled).toBe(true);
});
