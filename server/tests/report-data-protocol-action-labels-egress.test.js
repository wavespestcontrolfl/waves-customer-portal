// Raw completed protocol-action labels (completedProtocolActionLabels,
// report-data.js) are internal tech/protocol vocabulary — they feed the
// Pest V2 spider expectation (GATE_PEST_REPORT_EXPECTATIONS) SERVER-SIDE
// ONLY (reports-public.js calls completedProtocolActionLabels(service)
// directly). This pins the v1 public payload buildReportV1Data returns:
// no protocolActionLabels field, and no label text anywhere in the JSON a
// token holder can fetch — with the gate exactly `'true'` or unset, since
// buildReportV1Data itself never reads the gate at all (codex P0 2026-09-28).

const { buildReportV1Data } = require('../services/service-report/report-data');

function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        }
        return q;
      },
      andWhere: () => q,
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(criteria) {
        rows = rows.filter((r) => !Object.entries(criteria).every(([k, v]) => r[k] === v));
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy: () => q,
      first: () => Promise.resolve(rows[0] || null),
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

// A distinctive, easy-to-grep label that would ONLY appear in the payload
// if the internal field leaked.
const INTERNAL_LABEL = 'Swept eaves, window frames, door frames, and lanai';

const SERVICE = {
  id: 'svc-actionlabels-1',
  scheduled_service_id: 'ss-actionlabels',
  customer_id: 'cust-actionlabels',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-07-16',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: JSON.stringify({
    protocolActionScopesCompleted: [
      { label: INTERNAL_LABEL, scope: 'exterior', treatmentApplied: false },
    ],
  }),
  service_data: '{}',
  pressure_index: 0,
};

const FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  scheduled_services: [],
};

describe('protocolActionLabels never reaches the public v1 payload', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  test('gate OFF: no protocolActionLabels key, no label text anywhere in the JSON', async () => {
    delete process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const data = await buildReportV1Data(SERVICE, 'token-actionlabels-off', makeKnex(FIXTURES));
    expect(data.protocolActionLabels).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('Swept eaves');
  });

  test('gate ON: STILL no protocolActionLabels key, no label text anywhere in the JSON', async () => {
    // buildReportV1Data never reads this gate — the field must be absent
    // regardless, but this pins it explicitly so a future change that
    // conditions the field on the gate is caught here too.
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-actionlabels-on', makeKnex(FIXTURES));
    expect(data.protocolActionLabels).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('Swept eaves');
  });
});

// moa_group / rainfast_minutes (codex P0 2026-09-28): these classify the
// Pest V2 "what to expect" / rain-fast copy (pest-report-expectations.js)
// but are server-internal facts, never part of the public
// /api/reports/:token/data payload — report-data.js hands them to the
// caller ONLY through the expectationFactsOut out-param, the same
// "server-internal, never on `data`" contract completedProtocolActionLabels
// uses above.
function deepHasKey(value, key, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => deepHasKey(v, key, seen));
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((v) => deepHasKey(v, key, seen));
}

const MOA_MARKER = 'INTERNAL-MOA-MARKER-7f3a9c';
const RAINFAST_MINUTES = 474747;

const PRODUCT_FIXTURES = {
  ...FIXTURES,
  service_products: [
    {
      id: 'sp-actionlabels-1',
      service_record_id: SERVICE.id,
      product_id: 'cat-actionlabels-1',
      product_name: 'Distinctive Egress Test Product',
      product_category: 'insecticide',
      active_ingredient: 'Test Active',
      application_rate: '1',
      rate_unit: 'oz',
      total_amount: 1,
      amount_unit: 'oz',
      application_area: 'Perimeter',
      targets: JSON.stringify(['ants']),
      created_at: '2026-07-16T00:00:00Z',
    },
  ],
  products_catalog: [
    {
      id: 'cat-actionlabels-1',
      name: 'Distinctive Egress Test Product',
      category: 'insecticide',
      product_type: 'pesticide',
      epa_reg_number: 'EPA-99999-1',
      approved_for_service_report: true,
      moa_group: MOA_MARKER,
      rainfast_minutes: RAINFAST_MINUTES,
      active_ingredient: 'Test Active',
    },
  ],
};

describe('moa_group / rainfast_minutes never reach the public v1 payload (codex P0 2026-09-28)', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  test('gate OFF: applications[].product carries no moa_group/rainfast_minutes key anywhere', async () => {
    delete process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const data = await buildReportV1Data(SERVICE, 'token-moa-off', makeKnex(PRODUCT_FIXTURES));
    expect(data.applications).toHaveLength(1);
    expect(data.applications[0].product.name).toBe('Distinctive Egress Test Product');
    expect(deepHasKey(data, 'moa_group')).toBe(false);
    expect(deepHasKey(data, 'rainfast_minutes')).toBe(false);
    expect(deepHasKey(data, 'moaGroup')).toBe(false);
    expect(deepHasKey(data, 'rainfastMinutes')).toBe(false);
    expect(JSON.stringify(data)).not.toContain(MOA_MARKER);
  });

  test('gate ON: STILL no moa_group/rainfast_minutes key anywhere (buildReportV1Data never reads this gate)', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-moa-on', makeKnex(PRODUCT_FIXTURES));
    expect(deepHasKey(data, 'moa_group')).toBe(false);
    expect(deepHasKey(data, 'rainfast_minutes')).toBe(false);
    expect(deepHasKey(data, 'moaGroup')).toBe(false);
    expect(deepHasKey(data, 'rainfastMinutes')).toBe(false);
    expect(JSON.stringify(data)).not.toContain(MOA_MARKER);
  });

  test('expectationFactsOut out-param carries the facts the public payload withholds', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const expectationFactsOut = {};
    const data = await buildReportV1Data(SERVICE, 'token-moa-outparam', makeKnex(PRODUCT_FIXTURES), { expectationFactsOut });
    expect(expectationFactsOut.applications).toHaveLength(1);
    expect(expectationFactsOut.applications[0].product.moa_group).toBe(MOA_MARKER);
    expect(expectationFactsOut.applications[0].product.rainfast_minutes).toBe(RAINFAST_MINUTES);
    // The out-param is never attached to the returned object itself.
    expect(deepHasKey(data, 'moa_group')).toBe(false);
    expect(deepHasKey(data, 'rainfast_minutes')).toBe(false);
  });
});
