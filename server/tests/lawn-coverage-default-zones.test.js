// GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES (owner 2026-10-06): the coverage verdict
// is FROZEN at completion (structured_notes.lawnCoverageVerdict). A render hides
// a lawn report's coverage section only when that frozen verdict says defaults
// only; a visit with no verdict renders exactly as with the gate off; the PDF
// key reads the same frozen value. Nothing here reads zones live to decide.
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
const build = (zones, { geometries = [], service = {}, options } = {}) => buildReportV1Data({ ...LAWN_SERVICE, ...service }, 'token-lawn-coverage', makeKnex({
  property_geometries: geometries, property_zones: zones, service_findings: [], service_photos: [], service_products: [], scheduled_services: [],
}), options);
const verdict = (defaultsOnly) => JSON.stringify({ lawnCoverageVerdict: { v: 1, defaultsOnly, frozenAt: '2026-10-06T20:00:00.000Z' } });
const frozen = (defaultsOnly) => ({ structured_notes: verdict(defaultsOnly) });

const KEY = 'GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES';
afterEach(() => { delete process.env[KEY]; });

describe('render reads only the frozen verdict', () => {
  test('gate off: a frozen defaultsOnly verdict changes nothing (coverage kept, no hidden key)', async () => {
    const data = await build([], { service: frozen(true) });
    expect(data.serviceCoverage.enabled).toBe(true);
    expect((data.serviceCoverage.items || []).length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(data, 'lawnCoverageHidden')).toBe(false);
  });

  test('gate on + frozen defaultsOnly true: no coverage section, lawnCoverageHidden set', async () => {
    process.env[KEY] = 'true';
    const data = await build([], { service: frozen(true) });
    expect(data.serviceCoverage).toEqual({ enabled: false });
    expect(data.lawnCoverageHidden).toBe(true);
  });

  test('gate on + frozen defaultsOnly false: coverage kept', async () => {
    process.env[KEY] = 'true';
    const data = await build([], { service: frozen(false) });
    expect(data.serviceCoverage.enabled).toBe(true);
    expect(data).not.toHaveProperty('lawnCoverageHidden');
  });

  test('gate on + NO frozen verdict (older visit or failed freeze): renders exactly as gate off', async () => {
    const off = await build([]);
    process.env[KEY] = 'true';
    const on = await build([]);
    expect(on.serviceCoverage.enabled).toBe(true);
    expect(on).not.toHaveProperty('lawnCoverageHidden');
    expect(JSON.stringify(on.serviceCoverage)).toBe(JSON.stringify(off.serviceCoverage));
  });

  test('a verdict of an unknown version or shape is no verdict', async () => {
    process.env[KEY] = 'true';
    for (const bad of [
      { lawnCoverageVerdict: { v: 2, defaultsOnly: true } },
      { lawnCoverageVerdict: { v: 1, defaultsOnly: 'yes' } },
      { lawnCoverageVerdict: 'defaults' },
    ]) {
      const data = await build([], { service: { structured_notes: JSON.stringify(bad) } });
      expect(data.serviceCoverage.enabled).toBe(true);
    }
  });

  test('the live zone rows do NOT decide: marked zones + frozen true still hide; default zones + frozen false still show', async () => {
    process.env[KEY] = 'true';
    expect((await build(MARKED, { service: frozen(true) })).serviceCoverage).toEqual({ enabled: false });
    expect((await build(UNMARKED_ROWS, { service: frozen(false) })).serviceCoverage.enabled).toBe(true);
  });

  test('a failed zone read after the freeze changes nothing (no live read decides)', async () => {
    process.env[KEY] = 'true';
    const base = makeKnex({ property_geometries: [], service_findings: [], service_photos: [], service_products: [], scheduled_services: [] });
    const knex = (table) => {
      if (table === 'property_zones') { const q = { where: () => q, orderBy: () => q, catch: (fn) => Promise.resolve(fn(new Error('read failed'))), then: (r, j) => Promise.reject(new Error('read failed')).then(r, j) }; return q; }
      return base(table);
    };
    const data = await buildReportV1Data({ ...LAWN_SERVICE, ...frozen(true) }, 'token-lawn-coverage', knex);
    expect(data.serviceCoverage).toEqual({ enabled: false });
    expect(data).not.toHaveProperty('coverageTransientlyUnavailable');
  });

  test('non-lawn lines ignore the verdict', async () => {
    process.env[KEY] = 'true';
    const data = await build([], { service: { ...frozen(true), service_line: 'pest', service_type: 'Pest Control' } });
    expect(data).not.toHaveProperty('lawnCoverageHidden');
  });
});

describe('completion freeze input (opts.lawnCoverageOut)', () => {
  const out = async (zones, extra = {}) => { const o = {}; await build(zones, { options: { lawnCoverageOut: o }, ...extra }); return o; };

  test('technician-marked zone: defaultsOnly false', async () => {
    expect(await out(MARKED)).toEqual({ readOk: true, defaultsOnly: false });
  });
  test('no rows, or rows with no mark: defaultsOnly true', async () => {
    expect(await out([])).toEqual({ readOk: true, defaultsOnly: true });
    expect(await out(UNMARKED_ROWS)).toEqual({ readOk: true, defaultsOnly: true });
  });
  test('a mark that drift resolution drops as untrusted leaves defaults', async () => {
    expect(await out(STALE_MARK_ROWS, {
      geometries: [{ customer_id: 'customer-1', version: 1, zoom: 20 }],
      service: { customer_latitude: 27.3, customer_longitude: -82.5 },
    })).toEqual({ readOk: true, defaultsOnly: true });
  });
  test('a failed zone read reports readOk false so nothing is frozen', async () => {
    const base = makeKnex({ property_geometries: [], service_findings: [], service_photos: [], service_products: [], scheduled_services: [] });
    const knex = (table) => {
      if (table === 'property_zones') { const q = { where: () => q, orderBy: () => q, catch: (fn) => Promise.resolve(fn(new Error('read failed'))), then: (r, j) => Promise.reject(new Error('read failed')).then(r, j) }; return q; }
      return base(table);
    };
    const o = {};
    await buildReportV1Data({ ...LAWN_SERVICE }, 'token-lawn-coverage', knex, { lawnCoverageOut: o });
    expect(o.readOk).toBe(false);
  });
  test('not filled for a non-lawn line', async () => {
    const o = {};
    await build([], { options: { lawnCoverageOut: o }, service: { service_line: 'pest', service_type: 'Pest Control' } });
    expect(o).toEqual({});
  });
});

describe('PDF cache key reads the frozen verdict', () => {
  const svc = { id: 'svc-cur', customer_id: 'customer-1', service_line: 'lawn', service_date: '2026-10-06' };
  const rowsKnex = (notes) => makeKnex({ service_records: [{ id: 'svc-cur', ...(notes === undefined ? {} : { structured_notes: notes }) }] });
  const sig = async (service, notes) => (await resolveCanonicalLawnRender(service, rowsKnex(notes))).signature;

  test('gate off: the signature is byte-identical whatever the verdict says', async () => {
    const none = await sig(svc);
    expect(await sig(svc, verdict(true))).toBe(none);
    expect(await sig(svc, verdict(false))).toBe(none);
  });

  test('gate on: ":covhide=1" only for a frozen defaultsOnly true; no verdict or false keeps the gate-off key', async () => {
    const off = await sig(svc);
    process.env[KEY] = 'true';
    expect(await sig(svc)).toBe(off);
    expect(await sig(svc, '{}')).toBe(off);
    expect(await sig(svc, verdict(false))).toBe(off);
    const hidden = await sig(svc, verdict(true));
    expect(hidden).not.toBe(off);
    // The stamp is hashed into the signature; only the frozen verdict moves it.
    expect(await sig(svc, verdict(true))).toBe(hidden);
  });

  test('a partial lookup row and a full render row compute the same key', async () => {
    process.env[KEY] = 'true';
    const full = (notes) => ({ ...svc, customer_latitude: 27.4, customer_longitude: -82.5, structured_notes: notes });
    expect(await sig(svc, verdict(true))).toBe(await sig(full(verdict(true)), verdict(true)));
    expect(await sig(svc, verdict(false))).toBe(await sig(full(verdict(false)), verdict(false)));
  });

  test('the key uses the render row\'s own notes snapshot, not a fresher record read (codex #6089)', async () => {
    process.env[KEY] = 'true';
    const noVerdictKey = await sig(svc, '{}');
    // Row loaded before the freeze committed; the record now holds defaultsOnly true.
    const staleRow = { ...svc, structured_notes: '{}' };
    expect(await sig(staleRow, verdict(true))).toBe(noVerdictKey);
  });

  test('turning the gate off re-keys back (rollback)', async () => {
    const off = await sig(svc, verdict(true));
    process.env[KEY] = 'true';
    const on = await sig(svc, verdict(true));
    delete process.env[KEY];
    expect(on).not.toBe(off);
    expect(await sig(svc, verdict(true))).toBe(off);
  });

  test('a failed record read stamps a one-off key that never matches a stored PDF', async () => {
    process.env[KEY] = 'true';
    const failing = () => {
      const base = makeKnex({});
      return (table) => {
        if (table === 'service_records') { const q = { where: () => q, first: () => Promise.reject(new Error('read failed')) }; return q; }
        return base(table);
      };
    };
    const a = (await resolveCanonicalLawnRender(svc, failing())).signature;
    const b = (await resolveCanonicalLawnRender(svc, failing())).signature;
    expect(a).not.toBe(b);
  });

  test('a non-lawn service gets no stamp', async () => {
    process.env[KEY] = 'true';
    expect((await resolveCanonicalLawnRender({ ...svc, service_line: 'pest' }, rowsKnex(verdict(true)))).signature).toBe('');
  });
});
