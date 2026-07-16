// Lawn Report V2 snapshot.nextVisit — honest-precision rule. A 'rescheduled'
// scheduled_services row is a phantom placeholder holding the OLD date/window
// until the office rebooks; publishing it presents a stale time as still real.
// The nextAppointment and tree-shrub queries have always excluded it — this
// pins the lawn query to the same rule (2026-07-16 audit P1).

const { buildReportV1Data } = require('../services/service-report/report-data');

function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          // the lawn/turf service-type scope: whereRaw('LOWER(service_type) LIKE ?')
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) {
            rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          }
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const LAWN_SERVICE = {
  id: 'svc-lawn-1',
  scheduled_service_id: 'ss-current',
  customer_id: 'cust-lawn',
  service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program',
  service_date: '2026-05-16',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: '{}',
  service_data: '{}',
};

const FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  lawn_assessments: [{
    id: 'la-1',
    customer_id: 'cust-lawn',
    service_record_id: 'svc-lawn-1',
    confirmed_by_tech: true,
    service_date: '2026-05-16',
    created_at: '2026-05-16T14:00:00Z',
    turf_density: 78,
    weed_suppression: 82,
    color_health: 75,
    stress_damage: 30,
  }],
};

test('a rescheduled phantom row never publishes as the lawn nextVisit — the real confirmed row wins', async () => {
  const knex = makeKnex({
    ...FIXTURES,
    scheduled_services: [
      { id: 'ss-current', customer_id: 'cust-lawn', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Lawn Care Treatment Program' },
      // phantom holding the OLD date — sorts first, must be skipped
      { id: 'ss-phantom', customer_id: 'cust-lawn', scheduled_date: '2999-01-02', status: 'rescheduled', service_type: 'Lawn Care Treatment Program' },
      { id: 'ss-real', customer_id: 'cust-lawn', scheduled_date: '2999-02-03', status: 'confirmed', service_type: 'Lawn Care Treatment Program' },
    ],
  });

  const data = await buildReportV1Data(LAWN_SERVICE, 'token-lawn-next', knex);

  expect(data.reportV2).toBeTruthy();
  const nextVisit = data.reportV2.snapshot?.nextVisit;
  expect(nextVisit).toBeTruthy();
  expect(nextVisit.source).toBe('scheduled');
  const expectedLabel = new Date('2999-02-03T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const phantomLabel = new Date('2999-01-02T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  expect(nextVisit.label).toBe(expectedLabel);
  expect(nextVisit.label).not.toBe(phantomLabel);
});

test('with only a rescheduled row upcoming, no confident scheduled date publishes', async () => {
  const knex = makeKnex({
    ...FIXTURES,
    scheduled_services: [
      { id: 'ss-current', customer_id: 'cust-lawn', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Lawn Care Treatment Program' },
      { id: 'ss-phantom', customer_id: 'cust-lawn', scheduled_date: '2999-01-02', status: 'rescheduled', service_type: 'Lawn Care Treatment Program' },
    ],
  });

  const data = await buildReportV1Data(LAWN_SERVICE, 'token-lawn-next-none', knex);

  expect(data.reportV2).toBeTruthy();
  const nextVisit = data.reportV2.snapshot?.nextVisit;
  // either omitted entirely or a clearly-labeled cadence estimate — never
  // the phantom's date presented as a real scheduled visit
  if (nextVisit) {
    expect(nextVisit.source).not.toBe('scheduled');
  }
});
