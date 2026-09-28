// "Near you" line on the LIVE lawn report (owner ask 2026-09-28, "lawn only",
// GATE_REPORT_NEAR_YOU): buildReportV1Data adds nearYou { city, pest } — the
// lawn pest most often recorded among OTHER lawn customers in this report's
// city over the last 30 ET days, only at NEAR_YOU_MIN_CUSTOMERS (3) distinct
// customers, read from each visit's completion-form snapshot
// (structured_notes.formObservations) only. The SQL filters (city, window,
// performed/visible, own customer excluded) are proven against real Postgres
// in report-near-you-postgres.test.js; this suite pins the conditions and the
// counting.
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
// An allowlisted lawn pest observation, exactly as the closeout form stores it.
const observation = (label, location = 'Front yard') => `${statementFor(label)} Location: ${location}.`;
const CHINCH = 'Chinch bugs — observed';
const ARMY = 'Armyworms';

// The same builder fake as report-plan-summary.test.js, plus knex.raw: the
// near-you read (one row per visit: customer_id + form_observations, plus the
// visit's live_city and identity_snapshot) answers with `nearYouRows`, every
// other raw query with none. A row's live_city defaults to the report's own
// city (Parrish); the city tests set it, and the snapshot, explicitly.
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
    const isNearYou = /AS form_observations/.test(String(sql));
    if (isNearYou) rawCalls.push({ sql, bindings });
    return Promise.resolve({ rows: isNearYou ? nearYouRows.map((row) => ({ live_city: 'Parrish', ...row })) : [] });
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
    { customer_id: 'c1', form_observations: [observation(CHINCH), observation(ARMY)] },
    { customer_id: 'c2', form_observations: [observation(CHINCH, 'Back yard')] },
    { customer_id: 'c3', form_observations: [observation(CHINCH)] },
  ]);
  expect(data.nearYou).toEqual({ city: 'Parrish', pest: 'chinch bugs' });
  const [call] = rawCalls;
  // own customer excluded, then the ET window, then the city (live, then frozen)
  expect(call.bindings[0]).toBe('customer-ny');
  expect(call.bindings[3]).toBe('Parrish');
  expect(call.bindings[4]).toBe('Parrish');
  expect(call.sql).toMatch(/sr\.customer_id <> \?/);
  expect(call.sql).toMatch(/sr\.service_line = 'lawn'/);
  // The closeout form snapshot is the only pest source (codex P0 on #5177).
  expect(call.sql).not.toMatch(/service_findings/);
});

test('below the floor, or one customer counted many times, names nothing', async () => {
  const twoCustomers = await buildWith([
    { customer_id: 'c1', form_observations: [observation(CHINCH)] },
    { customer_id: 'c2', form_observations: [observation(CHINCH)] },
  ]);
  expect(twoCustomers.data).not.toHaveProperty('nearYou');
  const oneCustomerMany = await buildWith([
    { customer_id: 'c1', form_observations: [observation(CHINCH), observation(CHINCH, 'Back yard')] },
    { customer_id: 'c1', form_observations: [observation(CHINCH)] },
    { customer_id: 'c2', form_observations: [observation(CHINCH, 'Left side yard')] },
  ]);
  expect(oneCustomerMany.data).not.toHaveProperty('nearYou');
});

test('a tie goes to the label that sorts first', async () => {
  const { data } = await buildWith(['c1', 'c2', 'c3'].map((customer) => (
    { customer_id: customer, form_observations: [observation(CHINCH), observation(ARMY)] }
  )));
  expect(data.nearYou).toEqual({ city: 'Parrish', pest: 'armyworms' });
});

test('absence and unrelated observations never name a pest', async () => {
  const { data } = await buildWith(['c1', 'c2', 'c3'].map((customer) => (
    { customer_id: customer, form_observations: [observation('No live pests detected'), 'Mulch piled against the foundation.'] }
  )));
  expect(data).not.toHaveProperty('nearYou');
});

test('only an exact allowlisted observation counts, never text that merely starts like one (codex P0 on #5177)', async () => {
  const { data } = await buildWith(['c1', 'c2', 'c3'].map((customer) => ({
    customer_id: customer,
    form_observations: [
      `${observation(CHINCH)} Also saw some in the neighbor's yard.`,
      `${statementFor(CHINCH)} Location: Somewhere else.`,
    ],
  })));
  expect(data).not.toHaveProperty('nearYou');
});

test("a visit counts in the city its own report shows: the frozen report city beats the customer's current address (codex P2 on #5177)", async () => {
  const snapshotCity = (city) => ({ version: 1, address: { city } });
  // c3 has since moved to Sarasota, but the visit happened in Parrish.
  const movedAway = await buildWith([
    { customer_id: 'c1', form_observations: [observation(CHINCH)] },
    { customer_id: 'c2', form_observations: [observation(CHINCH)] },
    { customer_id: 'c3', form_observations: [observation(CHINCH)], live_city: 'Sarasota', identity_snapshot: snapshotCity('Parrish') },
  ]);
  expect(movedAway.data.nearYou).toEqual({ city: 'Parrish', pest: 'chinch bugs' });
  // c3 lives in Parrish now, but the visit happened in Bradenton.
  const movedIn = await buildWith([
    { customer_id: 'c1', form_observations: [observation(CHINCH)] },
    { customer_id: 'c2', form_observations: [observation(CHINCH)] },
    { customer_id: 'c3', form_observations: [observation(CHINCH)], identity_snapshot: snapshotCity('Bradenton') },
  ]);
  expect(movedIn.data).not.toHaveProperty('nearYou');
});

test.each([
  ['a pest report', { service: { ...LAWN_SERVICE, service_line: 'pest', service_type: 'Quarterly Pest Control' } }],
  ['a PDF build', { opts: { mode: 'pdf', nearYou: true } }],
  ['a live build without the opt-in (the Q&A endpoint)', { opts: { mode: 'live' } }],
  ['a report with no city', { service: { ...LAWN_SERVICE, city: '  ' } }],
])('%s gets no nearYou and makes no near-you read', async (_label, overrides) => {
  const rows = ['c1', 'c2', 'c3'].map((customer) => ({ customer_id: customer, form_observations: [observation(CHINCH)] }));
  const { data, rawCalls } = await buildWith(rows, overrides);
  expect(data).not.toHaveProperty('nearYou');
  expect(rawCalls).toHaveLength(0);
});

test('stripLiveOnlyScheduleFields removes nearYou like the other live-only fields', () => {
  const data = { nearYou: { city: 'Parrish', pest: 'chinch bugs' }, planSummary: { year: 2026 } };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('nearYou');
});
