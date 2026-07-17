// technician_notes is internal (owner ruling 2026-07-16): access codes,
// billing notes, and candid remarks live there. The ONLY sanctioned path to
// customer copy is technicianReportCustomerCopy's reviewed WHAT WE DID /
// WHAT WE FOUND parse. This pins the v1 public payload: no raw notes field,
// and no notes content anywhere in the JSON a token holder can fetch.

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

const INTERNAL_NOTE = 'Gate code 4471. Bill extra bait station to office acct.';

const SERVICE = {
  id: 'svc-notes-1',
  scheduled_service_id: 'ss-notes',
  customer_id: 'cust-notes',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-05-16',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  technician_notes: INTERNAL_NOTE,
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

test('raw technician_notes never rides the v1 public payload', async () => {
  const data = await buildReportV1Data(SERVICE, 'token-notes', makeKnex(FIXTURES));

  expect(data.legacy).toBeDefined();
  expect(data.legacy.notes).toBeUndefined();
  // the strong form: no fragment of the internal note anywhere in the JSON
  expect(JSON.stringify(data)).not.toContain('4471');
  expect(JSON.stringify(data)).not.toContain('Gate code');
});

test('a reviewed WHAT WE DID / WHAT WE FOUND draft still reaches the summary slot', async () => {
  const reviewed = [
    'WHAT WE DID',
    '',
    'We treated the exterior perimeter and refreshed bait placements.',
    '',
    'WHAT WE FOUND',
    '',
    'Ant activity along the garage slab edge is fading after treatment.',
  ].join('\n');
  const data = await buildReportV1Data(
    { ...SERVICE, technician_notes: reviewed },
    'token-notes-reviewed',
    makeKnex(FIXTURES),
  );

  expect(data.legacy.notes).toBeUndefined();
  expect(data.summary).toContain('We treated the exterior perimeter');
});
