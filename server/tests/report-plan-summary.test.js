// "Your plan" section payload (owner ask 2026-09-28, GATE_REPORT_PLAN_SUMMARY):
// buildReportV1Data adds planSummary { year, visitsThisYear,
// reservicesThisYear, upcoming } on live views only, when the gate is on and
// there's something to show. Counts are COUNTS, never a price (owner rule:
// prices only ever appear on estimate pages). stripLiveOnlyScheduleFields
// removes it for every non-live render, same staleness rule as
// nextAppointment.

// gates.reportPlanSummary reads process.env.GATE_REPORT_PLAN_SUMMARY once at
// require time (same static-gate convention as reportCrossSell), so a test
// that flips the env var mid-run must jest.resetModules() and re-require
// report-data (and its feature-gates dependency) to pick up the new value —
// requiring it fresh at file scope would only ever see whatever the env var
// happened to be at THIS file's first require.
const { buildReportV1Data, stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');
const { etDateString } = require('../utils/datetime-et');

function requireWithGateOn() {
  jest.resetModules();
  process.env.GATE_REPORT_PLAN_SUMMARY = 'true';
  return require('../services/service-report/report-data').buildReportV1Data;
}

// Same fake knex shape as report-next-appointment.test.js: supports the
// where/andWhere/whereIn/whereNot(modify)/orderBy/limit/select chain the
// next-appointment AND plan-summary lookups use, plus the object-criteria
// `where` the rest of the builder calls.
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria)
            .every(([key, val]) => row[key] === val));
        } else if (typeof criteria === 'string' && arguments.length === 2) {
          rows = rows.filter((row) => row[criteria] === value);
        }
        return query;
      },
      andWhere(column, op, value) {
        if (op === '>=') rows = rows.filter((row) => String(row[column]) >= String(value));
        if (op === '<') rows = rows.filter((row) => String(row[column]) < String(value));
        if (op === '>') rows = rows.filter((row) => String(row[column]) > String(value));
        return query;
      },
      whereIn(column, values) {
        rows = rows.filter((row) => values.includes(row[column]));
        return query;
      },
      whereNot(column, value) {
        rows = rows.filter((row) => row[column] !== value);
        return query;
      },
      whereRaw(sql, bindings) {
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(String(sql));
        if (m) {
          const wanted = String(bindings?.[0] ?? '').toLowerCase();
          rows = rows.filter((row) => String(row[m[1]] || '').toLowerCase() === wanted);
        }
        return query;
      },
      modify(fn) { fn(query); return query; },
      limit: () => query,
      orderBy(column) {
        sortKeys.push(column);
        rows = [...rows].sort((a, b) => {
          for (const key of sortKeys) {
            const cmp = String(a[key] || '').localeCompare(String(b[key] || ''));
            if (cmp !== 0) return cmp;
          }
          return 0;
        });
        return query;
      },
      leftJoin: () => query,
      select: () => query,
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

const BASE_FIXTURES = {
  // An active plan member by default (isActivePlanCustomer reads the tier).
  customers: [{ id: 'customer-plan', waveguard_tier: 'Gold', active: true }],
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
};

const todayIso = etDateString();
const YEAR = Number(todayIso.slice(0, 4));

const BASE_SERVICE = {
  id: 'service-plan-summary',
  scheduled_service_id: 'scheduled-current',
  customer_id: 'customer-plan',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: `${YEAR}-01-16`,
  first_name: 'Robin',
  last_name: 'Ashcroft',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};

afterEach(() => {
  delete process.env.GATE_REPORT_PLAN_SUMMARY;
  jest.resetModules();
});

test('gate off: payload carries no planSummary key at all', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-plan', scheduled_date: `${YEAR}-01-16`, status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-next', customer_id: 'customer-plan', scheduled_date: `${YEAR}-06-01`, status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-plan-off', knex, { mode: 'live' });
  expect(data).not.toHaveProperty('planSummary');
});

test('gate on: counts only COMPLETED visits in the current ET calendar year, and counts re-services by service_key_snapshot', async () => {
  const build = requireWithGateOn();
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // this year, completed — counts
      { id: 'scheduled-current', customer_id: 'customer-plan', scheduled_date: `${YEAR}-01-16`, status: 'completed', service_type: 'Quarterly Pest Control Service' },
      // this year, completed, a re-service — counts toward both totals
      { id: 'scheduled-reservice', customer_id: 'customer-plan', scheduled_date: `${YEAR}-03-01`, status: 'completed', service_type: 'Pest Re-Service', service_key_snapshot: 'pest_re_service' },
      // this year, completed, an included trapping follow-up — a visit, but
      // not a re-service to the customer
      { id: 'scheduled-trap-followup', customer_id: 'customer-plan', scheduled_date: `${YEAR}-03-08`, status: 'completed', service_type: 'Rodent Trapping Follow-Up', service_key_snapshot: 'rodent_trapping_followup' },
      // this year, completed, a free-text re-service booking with no key —
      // the name fallback counts it
      { id: 'scheduled-freetext-reservice', customer_id: 'customer-plan', scheduled_date: `${YEAR}-03-15`, status: 'completed', service_type: 'Pest Re-Service', service_key_snapshot: null },
      // this year, completed, an unkeyed trapping follow-up — still not a
      // re-service by name
      { id: 'scheduled-freetext-trap', customer_id: 'customer-plan', scheduled_date: `${YEAR}-03-22`, status: 'completed', service_type: 'Rodent Trapping Follow-Up', service_key_snapshot: null },
      // this year, completed, a persisted callback whose key and name no
      // longer say re-service — the flag counts it
      { id: 'scheduled-flagged-callback', customer_id: 'customer-plan', scheduled_date: `${YEAR}-04-05`, status: 'completed', service_type: 'Pest Control Service', service_key_snapshot: 'pest_general_quarterly', is_callback: true },
      // this year, completed, a flagged trapping follow-up — never a re-service
      { id: 'scheduled-flagged-trap', customer_id: 'customer-plan', scheduled_date: `${YEAR}-04-12`, status: 'completed', service_type: 'Rodent Trapping Follow-Up', service_key_snapshot: 'rodent_trapping_followup', is_callback: true },
      // this year, but NOT completed — excluded
      { id: 'scheduled-pending', customer_id: 'customer-plan', scheduled_date: `${YEAR}-04-01`, status: 'pending', service_type: 'Quarterly Pest Control Service' },
      // last calendar year — excluded even though completed
      { id: 'scheduled-last-year', customer_id: 'customer-plan', scheduled_date: `${YEAR - 1}-12-31`, status: 'completed', service_type: 'Quarterly Pest Control Service' },
      // next calendar year — excluded
      { id: 'scheduled-next-year', customer_id: 'customer-plan', scheduled_date: `${YEAR + 1}-01-01`, status: 'completed', service_type: 'Quarterly Pest Control Service' },
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-counts', knex, { mode: 'live' });
  expect(data.planSummary).toMatchObject({ member: true, year: YEAR, visitsThisYear: 7, reservicesThisYear: 3 });
});

test('gate on: upcoming visits span every service line, exclude cancelled/rescheduled/completed/skipped, order by date, cap at 4, and drop anything past 120 days', async () => {
  const build = requireWithGateOn();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addDays = (n) => { const d = new Date(`${todayIso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // this report's own visit — excluded by id even though it's "today"
      { id: 'scheduled-current', customer_id: 'customer-plan', scheduled_date: todayIso, status: 'completed', service_type: 'Quarterly Pest Control Service' },
      // excluded by status
      { id: 'scheduled-cancelled', customer_id: 'customer-plan', scheduled_date: addDays(5), status: 'cancelled', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-rescheduled', customer_id: 'customer-plan', scheduled_date: addDays(6), status: 'rescheduled', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-skipped', customer_id: 'customer-plan', scheduled_date: addDays(7), status: 'skipped', service_type: 'Quarterly Pest Control Service' },
      // beyond the 120-day horizon — excluded
      { id: 'scheduled-far', customer_id: 'customer-plan', scheduled_date: addDays(130), status: 'confirmed', service_type: 'Quarterly Pest Control Service' },
      // eligible, ANY service line, ordered by date ascending
      { id: 'scheduled-lawn', customer_id: 'customer-plan', scheduled_date: addDays(10), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00', window_end: '10:00:00' },
      { id: 'scheduled-pest-1', customer_id: 'customer-plan', scheduled_date: addDays(20), status: 'pending', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
      { id: 'scheduled-pest-2', customer_id: 'customer-plan', scheduled_date: addDays(40), status: 'confirmed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-pest-3', customer_id: 'customer-plan', scheduled_date: addDays(60), status: 'en_route', service_type: 'Quarterly Pest Control Service' },
      // 5th eligible candidate — beyond the 4-item cap
      { id: 'scheduled-pest-4', customer_id: 'customer-plan', scheduled_date: addDays(80), status: 'on_site', service_type: 'Quarterly Pest Control Service' },
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-upcoming', knex, { mode: 'live' });
  expect(data.planSummary.upcoming).toEqual([
    { serviceName: 'Lawn Care Treatment', scheduledDate: addDays(10), windowStart: '08:00:00', windowEnd: '10:00:00' },
    { serviceName: 'Quarterly Pest Control Service', scheduledDate: addDays(20), windowStart: '09:00:00', windowEnd: null },
    { serviceName: 'Quarterly Pest Control Service', scheduledDate: addDays(40), windowStart: null, windowEnd: null },
    { serviceName: 'Quarterly Pest Control Service', scheduledDate: addDays(60), windowStart: null, windowEnd: null },
  ]);
});

test('a non-member gets only their upcoming visits: member false, no year counts', async () => {
  const build = requireWithGateOn();
  const addDays = (n) => { const d = new Date(`${todayIso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const knex = makeKnex({
    ...BASE_FIXTURES,
    // One-time customer: no tier, no monthly rate.
    customers: [{ id: 'customer-plan', waveguard_tier: null, monthly_rate: 0, active: true }],
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-plan', scheduled_date: `${YEAR}-01-16`, status: 'completed', service_type: 'One-Time Pest Control' },
      { id: 'scheduled-next', customer_id: 'customer-plan', scheduled_date: addDays(10), status: 'confirmed', service_type: 'Mosquito Event Spray' },
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-nonmember', knex, { mode: 'live' });
  expect(data.planSummary).toEqual({
    member: false,
    upcoming: [{ serviceName: 'Mosquito Event Spray', scheduledDate: addDays(10), windowStart: null, windowEnd: null }],
  });
});

test('a non-member with nothing upcoming gets no planSummary at all', async () => {
  const build = requireWithGateOn();
  const knex = makeKnex({
    ...BASE_FIXTURES,
    customers: [{ id: 'customer-plan', waveguard_tier: null, monthly_rate: 0, active: true }],
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-plan', scheduled_date: `${YEAR}-01-16`, status: 'completed', service_type: 'One-Time Pest Control' },
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-nonmember-empty', knex, { mode: 'live' });
  expect(data).not.toHaveProperty('planSummary');
});

test('omitted when there is no customer, or when visitsThisYear is 0 and upcoming is empty', async () => {
  const build = requireWithGateOn();
  const noCustomer = await build({ ...BASE_SERVICE, customer_id: null }, 'token-plan-no-customer', makeKnex({ ...BASE_FIXTURES, scheduled_services: [] }), { mode: 'live' });
  expect(noCustomer).not.toHaveProperty('planSummary');

  const nothingToShow = await build(BASE_SERVICE, 'token-plan-empty', makeKnex({ ...BASE_FIXTURES, scheduled_services: [] }), { mode: 'live' });
  expect(nothingToShow).not.toHaveProperty('planSummary');
});

test('stripLiveOnlyScheduleFields removes planSummary the same way it removes nextAppointment', () => {
  const data = { nextAppointment: { scheduledDate: '2026-01-01' }, planSummary: { year: 2026, visitsThisYear: 1, reservicesThisYear: 0, upcoming: [] } };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('planSummary');
  expect(data).not.toHaveProperty('nextAppointment');
});
