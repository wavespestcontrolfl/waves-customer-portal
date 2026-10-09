// GATE_LAWN_REPORT_FACTS: the report payload and the PDF key read the block frozen at completion
// (structured_notes.lawnReportFacts) and never a gate. A spot product row carries its frozen "where it was
// used" text; every other row, and every record without the block, is unchanged. Synthetic data only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-signed-map-images';
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');

function makeKnex(fixtures) {
  return (table) => {
    let rows = [...(fixtures[table] || [])];
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria).every(([key, val]) => (key === 'is_active' ? row[key] !== false : row[key] === val)));
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
  service_date: '2026-10-08',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Front perimeter', 'Rear perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};
const PRODUCTS = [
  { id: 'sp-spot', service_record_id: 'service-lawn', product_name: 'Spot Herbicide', product_category: 'herbicide', application_method: 'spot_treatment', area_value: 250, area_unit: 'sqft', created_at: '2026-10-08T15:00:00Z' },
  { id: 'sp-spot-bare', service_record_id: 'service-lawn', product_name: 'Spot Fungicide', product_category: 'fungicide', application_method: 'spot_treatment', created_at: '2026-10-08T15:01:00Z' },
  { id: 'sp-whole', service_record_id: 'service-lawn', product_name: 'Feeding', product_category: 'fertilizer', application_method: 'granular_broadcast', area_value: 5000, area_unit: 'sqft', created_at: '2026-10-08T15:02:00Z' },
];
const BLOCK = {
  v: 1,
  frozenAt: '2026-10-08T20:00:00.000Z',
  reentry: { rule: 'dry', source: 'facts', products: [{ id: 'sp-spot', rule: 'dry', source: 'facts' }] },
  productUse: { 'sp-spot': { sqft: 250 }, 'sp-spot-bare': { sqft: null } },
  ties: { assessmentId: null, items: [] },
};
const notesWith = (block) => JSON.stringify(block ? { lawnReportFacts: block } : {});
const build = (notes, products = PRODUCTS, service = {}) => buildReportV1Data({ ...LAWN_SERVICE, structured_notes: notes, ...service }, 'token-lawn-facts', makeKnex({
  property_geometries: [], property_zones: [], service_findings: [], service_photos: [], service_products: products, scheduled_services: [],
}));

const KEY = 'GATE_LAWN_REPORT_FACTS';
afterEach(() => { delete process.env[KEY]; });

describe('applications[].areaUse', () => {
  const useOf = (data) => Object.fromEntries(data.applications.map((app) => [app.id, app.areaUse]));

  test('a spot row with a recorded area says where; a spot row with none says "Spot treatment"; whole-lawn rows are unchanged (no key)', async () => {
    const data = await build(notesWith(BLOCK));
    expect(useOf(data)).toEqual({
      'sp-spot': 'Spot treatment, about 250 sq ft',
      'sp-spot-bare': 'Spot treatment',
      'sp-whole': undefined,
    });
    const whole = data.applications.find((app) => app.id === 'sp-whole');
    expect(Object.prototype.hasOwnProperty.call(whole, 'areaUse')).toBe(false);
  });

  test('the payload reads the record, not the gate: gate off and gate on give the same payload', async () => {
    const off = await build(notesWith(BLOCK));
    process.env[KEY] = 'true';
    const on = await build(notesWith(BLOCK));
    expect(JSON.stringify(on.applications)).toBe(JSON.stringify(off.applications));
  });

  test('a record without the block is unchanged, gate on or off: no areaUse key anywhere', async () => {
    const off = await build(notesWith(null));
    process.env[KEY] = 'true';
    const on = await build(notesWith(null));
    for (const data of [off, on]) {
      expect(data.applications.some((app) => Object.prototype.hasOwnProperty.call(app, 'areaUse'))).toBe(false);
    }
    expect(JSON.stringify(on.applications)).toBe(JSON.stringify(off.applications));
  });

  test('a row the freeze never saw (added later) keeps its zone text', async () => {
    const data = await build(notesWith({ ...BLOCK, productUse: { 'sp-spot': { sqft: 250 } } }));
    expect(useOf(data)['sp-spot-bare']).toBeUndefined();
  });

  test('another line ignores the block', async () => {
    const data = await build(notesWith(BLOCK), PRODUCTS, { service_line: 'pest', service_type: 'Pest Control' });
    expect(data.applications.some((app) => Object.prototype.hasOwnProperty.call(app, 'areaUse'))).toBe(false);
  });
});

describe('the PDF key follows the frozen decision', () => {
  const svc = { id: 'svc-cur', customer_id: 'customer-1', service_line: 'lawn', service_date: '2026-10-08' };
  const rowsKnex = (notes) => makeKnex({ service_records: [{ id: 'svc-cur', ...(notes === undefined ? {} : { structured_notes: notes }) }] });
  const sig = async (service, notes) => (await resolveCanonicalLawnRender(service, rowsKnex(notes))).signature;

  test('a frozen decision moves the key; a record without one keeps it; the gate changes nothing', async () => {
    const none = await sig(svc);
    expect(await sig(svc, '{}')).toBe(none);
    const frozen = await sig(svc, notesWith(BLOCK));
    expect(frozen).not.toBe(none);
    process.env[KEY] = 'true';
    expect(await sig(svc)).toBe(none);
    expect(await sig(svc, notesWith(BLOCK))).toBe(frozen);
  });

  test('each frozen decision moves it', async () => {
    const base = await sig(svc, notesWith(BLOCK));
    const wet = { ...BLOCK, reentry: { rule: 'watered_in_and_dry', source: 'facts', products: [{ id: 'a', rule: 'watered_in_and_dry', source: 'facts' }] } };
    expect(await sig(svc, notesWith(wet))).not.toBe(base);
    expect(await sig(svc, notesWith({ ...BLOCK, productUse: { 'sp-spot': { sqft: 300 } } }))).not.toBe(base);
    const tie = { assessmentId: '77', items: [{ source: 'technician', kind: 'chinch', product: 'insecticide' }] };
    expect(await sig(svc, notesWith({ ...BLOCK, ties: tie }))).not.toBe(base);
  });

  test('a partial lookup row and a full render row compute the same key', async () => {
    const full = { ...svc, customer_latitude: 27.4, customer_longitude: -82.5, structured_notes: notesWith(BLOCK) };
    expect(await sig(svc, notesWith(BLOCK))).toBe(await sig(full, notesWith(BLOCK)));
  });

  test('an unreadable record stamps a key nothing can match (re-render, never a stale hit)', async () => {
    const base = makeKnex({});
    const failing = () => (table) => {
      if (table === 'service_records') { const q = { where: () => q, first: () => Promise.reject(new Error('down')), then: (r, j) => Promise.reject(new Error('down')).then(r, j) }; return q; }
      return base(table);
    };
    const a = (await resolveCanonicalLawnRender(svc, failing())).signature;
    const b = (await resolveCanonicalLawnRender(svc, failing())).signature;
    expect(a).not.toBe(b);
  });

  test('a non-lawn service gets no stamp', async () => {
    expect((await resolveCanonicalLawnRender({ ...svc, service_line: 'pest' }, rowsKnex(notesWith(BLOCK)))).signature).toBe('');
  });
});
