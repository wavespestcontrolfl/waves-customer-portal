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
