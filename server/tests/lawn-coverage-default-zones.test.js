// GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES (owner 2026-10-06): a lawn report whose
// coverage zones are only the schematic defaults shows no coverage section; a
// property with technician-marked zones keeps it; gate off changes nothing.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signed-map-images';
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');

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
const ZONE = { id: 'z-a', customer_id: 'customer-1', letter: 'A', label: 'Front perimeter', category: 'lawn', geometry: { x: 64, y: 42, w: 512, h: 46 }, service_lines: ['lawn'], is_active: true };
// A technician satellite mark (pre-drift-era shape: no ref, passes through resolution untouched).
const MARK = { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.15 };
const MARKED = [{ ...ZONE, geometry_image: MARK }];
// Rows exist but carry only the stock schematic geometry (marks cleared, or rows added later).
const UNMARKED_ROWS = [{ ...ZONE, geometry_image: null }, { ...ZONE, id: 'z-b', letter: 'B', label: 'Rear perimeter', geometry_image: {} }];
// An untrusted mark (zoom changed since capture): drift resolution clears it, so the row is a default again.
const STALE_MARK_ROWS = [{ ...ZONE, geometry_image: { ...MARK, ref: { lat: 27.3, lng: -82.5, zoom: 18, width: 640, height: 340 } } }];
const build = (zones, { geometries = [], service = {} } = {}) => buildReportV1Data({ ...LAWN_SERVICE, ...service }, 'token-lawn-coverage', makeKnex({
  property_geometries: geometries, property_zones: zones, service_findings: [], service_photos: [], service_products: [], scheduled_services: [],
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

test('gate on: zone rows with no technician mark are still defaults, so the section is hidden', async () => {
  process.env[KEY] = 'true';
  const data = await build(UNMARKED_ROWS);
  expect(data.serviceCoverage).toEqual({ enabled: false });
});

test('gate on: a mark that drift resolution drops as untrusted leaves defaults, so the section is hidden', async () => {
  process.env[KEY] = 'true';
  const data = await build(STALE_MARK_ROWS, {
    geometries: [{ customer_id: 'customer-1', version: 1, zoom: 20 }],
    service: { customer_latitude: 27.3, customer_longitude: -82.5 },
  });
  expect(data.serviceCoverage).toEqual({ enabled: false });
});

test('gate on: a technician mark keeps the section (the marked row is not a default)', async () => {
  process.env[KEY] = 'true';
  const data = await build(MARKED);
  expect(data.serviceCoverage.enabled).toBe(true);
  expect((data.serviceCoverage.items || []).length).toBeGreaterThan(0);
  expect(data.lawnCoverageHidden).toBeUndefined();
});

test('PDF: gate on + defaults flags lawnCoverageHidden so the PDF prints no generated map or legend', async () => {
  process.env[KEY] = 'true';
  expect((await build([])).lawnCoverageHidden).toBe(true);
  expect((await build(UNMARKED_ROWS)).lawnCoverageHidden).toBe(true);
});

test('PDF: gate off adds no lawnCoverageHidden key (payload unchanged)', async () => {
  const data = await build([]);
  expect(Object.prototype.hasOwnProperty.call(data, 'lawnCoverageHidden')).toBe(false);
});

test('PDF cache key: the lawn signature moves only while the gate is live (re-render on flip and on rollback)', async () => {
  const svc = { id: 'svc-cur', customer_id: 'customer-1', service_line: 'lawn', service_date: '2026-10-06' };
  const sig = async () => (await resolveCanonicalLawnRender(svc, makeKnex({}))).signature;
  const off = await sig();
  expect(await sig()).toBe(off);
  process.env[KEY] = 'true';
  const on = await sig();
  expect(on).not.toBe(off);
  delete process.env[KEY];
  expect(await sig()).toBe(off);
});

test('PDF cache key: a non-lawn service gets no stamp', async () => {
  process.env[KEY] = 'true';
  const svc = { id: 'svc-pest', customer_id: 'customer-1', service_line: 'pest', service_date: '2026-10-06' };
  expect((await resolveCanonicalLawnRender(svc, makeKnex({}))).signature).toBe('');
});

test('PDF cache key: a zone write (count or newest updated_at) re-keys the lawn PDF while the gate is live (codex #6089 r3)', async () => {
  process.env[KEY] = 'true';
  const svc = { id: 'svc-cur', customer_id: 'customer-1', service_line: 'lawn', service_date: '2026-10-06' };
  // makeKnex has no count/max, so wrap it: property_zones answers the aggregate.
  const withZones = (agg) => {
    const base = makeKnex({});
    return (table) => {
      if (table !== 'property_zones') return base(table);
      const q = { where: () => q, count: () => q, max: () => q, first: () => Promise.resolve(agg) };
      return q;
    };
  };
  const sig = async (agg) => (await resolveCanonicalLawnRender(svc, withZones(agg))).signature;
  const none = await sig({ n: 0, newest: null });
  const marked = await sig({ n: 1, newest: '2026-10-07T12:00:00Z' });
  const remarked = await sig({ n: 1, newest: '2026-10-07T13:00:00Z' });
  expect(marked).not.toBe(none);
  expect(remarked).not.toBe(marked);
  expect(await sig({ n: 1, newest: '2026-10-07T13:00:00Z' })).toBe(remarked);
});

test('PDF cache key: a re-geocode or a geometry zoom change re-keys the lawn PDF (drift inputs, codex #6089 r4)', async () => {
  process.env[KEY] = 'true';
  const knexWith = (zoom) => {
    const base = makeKnex({});
    return (table) => {
      if (table === 'property_zones') { const q = { where: () => q, count: () => q, max: () => q, first: () => Promise.resolve({ n: 1, newest: '2026-10-07T12:00:00Z' }) }; return q; }
      if (table === 'property_geometries') { const q = { where: () => q, orderBy: () => q, first: () => Promise.resolve({ zoom }) }; return q; }
      return base(table);
    };
  };
  const svc = (lat) => ({ id: 'svc-cur', customer_id: 'customer-1', service_line: 'lawn', service_date: '2026-10-06', customer_latitude: lat, customer_longitude: -82.5 });
  const sig = async (lat, zoom) => (await resolveCanonicalLawnRender(svc(lat), knexWith(zoom))).signature;
  const base = await sig(27.4, 20);
  expect(await sig(27.4, 20)).toBe(base);
  expect(await sig(27.41, 20)).not.toBe(base);
  expect(await sig(27.4, 19)).not.toBe(base);
});
