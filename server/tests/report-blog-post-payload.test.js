// The Waves blog post a completion froze (structured_notes.blogPost) reaches
// the public report payload only through its gated top-level field
// (GATE_REPORT_BLOG_POST). With the switch off, no part of the JSON a token
// holder can fetch carries its title or URL (pre-push P0 on #5547: the
// protocol object the payload also returns once carried it ungated).

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

const POST = {
  title: 'Ghost ants in the kitchen: why they keep coming back',
  url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

const SERVICE = {
  id: 'svc-blog-1',
  scheduled_service_id: 'ss-blog',
  customer_id: 'cust-blog',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-10-01',
  first_name: 'Test',
  last_name: 'Customer',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: JSON.stringify({ blogPost: { id: 'post-1', ...POST } }),
  service_data: '{}',
  technician_notes: '',
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

describe('the frozen blog post in the public report payload', () => {
  const saved = process.env.GATE_REPORT_BLOG_POST;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_REPORT_BLOG_POST;
    else process.env.GATE_REPORT_BLOG_POST = saved;
  });

  test('gate off: no part of the payload carries its title or URL', async () => {
    delete process.env.GATE_REPORT_BLOG_POST;
    const data = await buildReportV1Data(SERVICE, 'token-blog-off', makeKnex(FIXTURES));
    expect(data.blogPost).toBeNull();
    const json = JSON.stringify(data);
    expect(json).not.toContain(POST.url);
    expect(json).not.toContain('Ghost ants in the kitchen');
  });

  test('gate on: the gated field carries it, and only that field', async () => {
    process.env.GATE_REPORT_BLOG_POST = 'true';
    const data = await buildReportV1Data(SERVICE, 'token-blog-on', makeKnex(FIXTURES));
    expect(data.blogPost).toEqual(POST);
    expect(data.protocol.blogPost).toBeUndefined();
    expect(JSON.stringify(data).split(POST.url)).toHaveLength(2);
  });
});
