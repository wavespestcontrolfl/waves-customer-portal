// "Near you" line on the LIVE lawn report (owner ask 2026-09-28, "lawn only",
// GATE_REPORT_NEAR_YOU): buildReportV1Data adds nearYou { city, pest } — the
// lawn pest most often found among OTHER lawn customers in this report's city
// over the last 30 ET days, only at NEAR_YOU_MIN_CUSTOMERS (3) distinct
// customers. The SQL filters (city, window, performed/visible, own customer
// excluded) are proven against real Postgres in report-near-you-postgres.test.js;
// this suite pins the conditions and the counting.
const lawnCatalog = require('../../shared/lawn-condition-findings.json');
const { stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');

function requireWithGateOn() {
  jest.resetModules();
  process.env.GATE_REPORT_NEAR_YOU = 'true';
  return require('../services/service-report/report-data').buildReportV1Data;
}

const statementFor = (label) => lawnCatalog.groups
  .flatMap(({ findings }) => findings)
  .find((finding) => finding.label === label).statement;
const title = (label, location = 'Front yard') => `${statementFor(label)} Location: ${location}.`;
const CHINCH = 'Chinch bugs — observed';
const ARMY = 'Armyworms';

// The same builder fake as report-plan-summary.test.js, plus knex.raw: the
// near-you read answers with `nearYouRows`, every other raw query with none.
function makeKnex(fixtures, nearYouRows, rawCalls) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria).every(([key, val]) => row[key] === val));
        } else if (typeof criteria === 'string' && arguments.length === 2) {
          const column = String(criteria).split('.').pop();
          rows = rows.filter((row) => row[column] === value);
        }
        return query;
      },
      andWhere: () => query,
      whereIn: () => query,
      whereNot: () => query,
      whereRaw: () => query,
      modify(fn) { fn(query); return query; },
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
  knex.schema = { hasTable: async () => true };
  knex.raw = (sql, bindings) => {
    const isNearYou = /FROM service_findings f/.test(String(sql));
    if (isNearYou) rawCalls.push({ sql, bindings });
    return Promise.resolve({ rows: isNearYou ? nearYouRows : [] });
  };
  return knex;
}

const BASE_FIXTURES = {
  customers: [{ id: 'customer-ny', active: true }],
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
};

const LAWN_SERVICE = {
  id: 'service-near-you',
  customer_id: 'customer-ny',
  service_line: 'lawn',
  service_type: 'Lawn Care Visit',
  service_date: '2026-09-20',
  city: ' Parrish ',
  first_name: 'Robin',
  last_name: 'Ashcroft',
  areas_serviced: '[]',
  structured_notes: '{}',
  service_data: '{}',
};
const LIVE_PAGE = { mode: 'live', nearYou: true };

async function buildWith(rows, { service = LAWN_SERVICE, opts = LIVE_PAGE } = {}) {
  const build = requireWithGateOn();
  const rawCalls = [];
  const data = await build(service, 'token-near-you', makeKnex(BASE_FIXTURES, rows, rawCalls), opts);
  return { data, rawCalls };
}

afterEach(() => {
  delete process.env.GATE_REPORT_NEAR_YOU;
  jest.resetModules();
});

test('gate off: no nearYou and no near-you read', async () => {
  jest.resetModules();
  const { buildReportV1Data } = require('../services/service-report/report-data');
  const rawCalls = [];
  const data = await buildReportV1Data(LAWN_SERVICE, 'token-off', makeKnex(BASE_FIXTURES, [], rawCalls), LIVE_PAGE);
  expect(data).not.toHaveProperty('nearYou');
  expect(rawCalls).toHaveLength(0);
});

test('names the top pest at the 3-customer floor, with the trimmed report city, and excludes the viewer', async () => {
  const { data, rawCalls } = await buildWith([
    { title: title(CHINCH), customer_id: 'c1' },
    { title: title(CHINCH, 'Back yard'), customer_id: 'c2' },
    { title: title(CHINCH), customer_id: 'c3' },
    { title: title(ARMY), customer_id: 'c1' },
  ]);
  expect(data.nearYou).toEqual({ city: 'Parrish', pest: 'chinch bugs' });
  const [call] = rawCalls;
  // own customer excluded, then the ET window, then the city
  expect(call.bindings[0]).toBe('customer-ny');
  expect(call.bindings[3]).toBe('Parrish');
  expect(call.sql).toMatch(/sr\.customer_id <> \?/);
  expect(call.sql).toMatch(/sr\.service_line = 'lawn'/);
});

test('below the floor, or one customer counted many times, names nothing', async () => {
  const twoCustomers = await buildWith([
    { title: title(CHINCH), customer_id: 'c1' },
    { title: title(CHINCH), customer_id: 'c2' },
  ]);
  expect(twoCustomers.data).not.toHaveProperty('nearYou');
  const oneCustomerMany = await buildWith([
    { title: title(CHINCH), customer_id: 'c1' },
    { title: title(CHINCH, 'Back yard'), customer_id: 'c1' },
    { title: title(CHINCH, 'Left side yard'), customer_id: 'c2' },
  ]);
  expect(oneCustomerMany.data).not.toHaveProperty('nearYou');
});

test('a tie goes to the label that sorts first', async () => {
  const { data } = await buildWith(['c1', 'c2', 'c3'].flatMap((customer) => [
    { title: title(CHINCH), customer_id: customer },
    { title: title(ARMY), customer_id: customer },
  ]));
  expect(data.nearYou).toEqual({ city: 'Parrish', pest: 'armyworms' });
});

test('absence findings and unrelated findings never name a pest', async () => {
  const { data } = await buildWith(['c1', 'c2', 'c3'].flatMap((customer) => [
    { title: title('No live pests detected'), customer_id: customer },
    { title: 'Mulch piled against the foundation.', customer_id: customer },
  ]));
  expect(data).not.toHaveProperty('nearYou');
});

test.each([
  ['a pest report', { service: { ...LAWN_SERVICE, service_line: 'pest', service_type: 'Quarterly Pest Control' } }],
  ['a PDF build', { opts: { mode: 'pdf', nearYou: true } }],
  ['a live build without the opt-in (the Q&A endpoint)', { opts: { mode: 'live' } }],
  ['a report with no city', { service: { ...LAWN_SERVICE, city: '  ' } }],
])('%s gets no nearYou and makes no near-you read', async (_label, overrides) => {
  const rows = ['c1', 'c2', 'c3'].map((customer) => ({ title: title(CHINCH), customer_id: customer }));
  const { data, rawCalls } = await buildWith(rows, overrides);
  expect(data).not.toHaveProperty('nearYou');
  expect(rawCalls).toHaveLength(0);
});

test('stripLiveOnlyScheduleFields removes nearYou like the other live-only fields', () => {
  const data = { nearYou: { city: 'Parrish', pest: 'chinch bugs' }, planSummary: { year: 2026 } };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('nearYou');
});
