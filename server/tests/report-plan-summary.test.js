// "Your plan" section payload (owner ask 2026-09-28, GATE_REPORT_PLAN_SUMMARY):
// buildReportV1Data adds planSummary { year, visitsThisYear,
// reservicesThisYear } for an active plan member, on live builds only, when
// the gate is on and the member has a PERFORMED visit this year (a completed,
// customer-visible service record whose outcome counts as performed). Counts
// are COUNTS, never a price (owner rule: prices only ever appear on estimate
// pages), and no upcoming visits.
// stripLiveOnlyScheduleFields removes it for every non-live render, same
// staleness rule as nextAppointment.

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
// "service_records.customer_id" -> "customer_id": fixture rows use bare keys.
const bare = (column) => String(column).split('.').pop();

function makeKnex(fixtures, reads = []) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const query = {
      where(criteria, value) {
        if (criteria && typeof criteria === 'object') {
          reads.push([table, 'where', criteria]);
          rows = rows.filter((row) => Object.entries(criteria)
            .every(([key, val]) => row[key] === val));
        } else if (typeof criteria === 'string' && arguments.length === 2) {
          const column = bare(criteria);
          rows = rows.filter((row) => row[column] === value);
        }
        return query;
      },
      andWhere(qualified, op, value) {
        const column = bare(qualified);
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
      // Joins are not modelled: a fixture row carries the joined columns
      // itself, under the select's alias names.
      leftJoin: () => query,
      select: (...args) => { reads.push([table, 'select', args]); return query; },
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

// What the /data render path passes (reports-public.js): live mode plus the
// explicit plan-summary opt-in.
const LIVE_PAGE = { mode: 'live', planSummary: true };

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
  const data = await buildReportV1Data(BASE_SERVICE, 'token-plan-off', knex, LIVE_PAGE);
  expect(data).not.toHaveProperty('planSummary');
});

// A completed, performed, customer-visible service record for the plan
// customer, carrying the joined booking columns under the select's aliases.
const record = (id, overrides = {}) => ({
  id,
  customer_id: 'customer-plan',
  status: 'completed',
  service_date: `${YEAR}-01-16`,
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  structured_notes: '{}',
  service_data: '{}',
  record_is_callback: false,
  scheduled_service_id: null,
  visit_id: null,
  ...overrides,
});
// The completion-time catalog identity the record freezes.
const frozen = (completedServiceKey) => JSON.stringify({ completedServiceKey });

test('gate on: counts PERFORMED visits in the current ET calendar year, and which of them were re-services', async () => {
  const build = requireWithGateOn();
  const knex = makeKnex({
    ...BASE_FIXTURES,
    service_records: [
      // a performed visit — counts
      record('record-current'),
      // a re-service by its frozen catalog key — counts toward both totals
      record('record-reservice', { service_date: `${YEAR}-03-01`, service_type: 'Pest Re-Service', service_data: frozen('pest_re_service') }),
      // an included trapping follow-up — a visit, never a re-service
      record('record-trap-followup', { service_date: `${YEAR}-03-08`, service_line: 'rodent', service_type: 'Rodent Trapping Follow-Up', service_data: frozen('rodent_trapping_followup') }),
      // named "Re-Service" but with no frozen callback evidence — a name can
      // belong to a non-callback, so it is a visit only
      record('record-name-only', { service_date: `${YEAR}-03-15`, service_type: 'Pest Re-Service' }),
      // an unkeyed trapping follow-up with no stamped line — a visit only
      record('record-freetext-trap', { service_date: `${YEAR}-03-22`, service_line: null, service_type: 'Rodent Trapping Follow-Up' }),
      // a callback frozen on its record whose booking was reclassified since —
      // the record counts it (the booking fields are ignored)
      record('record-flagged-callback', { service_date: `${YEAR}-04-05`, service_type: 'Pest Control Service', record_is_callback: true, service_key_snapshot: 'pest_general_quarterly', scheduled_is_callback: false }),
      // the reverse: the booking was repointed to a re-service after closeout,
      // the record froze a regular visit — a visit only
      record('record-repointed-booking', { service_date: `${YEAR}-04-06`, service_type: 'Pest Control Service', service_data: frozen('pest_general_quarterly'), service_key_snapshot: 'pest_re_service', scheduled_is_callback: true }),
      // a flagged trapping follow-up — never a re-service
      record('record-flagged-trap', { service_date: `${YEAR}-04-12`, service_line: 'rodent', service_type: 'Rodent Trapping Follow-Up', service_data: frozen('rodent_trapping_followup'), record_is_callback: true }),
      // a flagged trapping follow-up with NO key and no stamped line — the
      // rodent-line name excludes it
      record('record-flagged-unkeyed-trap', { service_date: `${YEAR}-04-19`, service_line: null, service_type: 'Rodent Trapping Follow-Up', record_is_callback: true }),
      // ONE physical stop, two services (grouped under one visit_id), both
      // re-services: one visit, one re-service
      record('record-stop-pest', { service_date: `${YEAR}-04-28`, visit_id: 'visit-stop-1', service_type: 'Pest Re-Service', service_data: frozen('pest_re_service') }),
      record('record-stop-lawn', { service_date: `${YEAR}-04-28`, visit_id: 'visit-stop-1', service_line: 'lawn', service_type: 'Lawn Re-Service', service_data: frozen('lawn_re_service') }),
      // NOT performed — each excluded from both totals, even when flagged
      record('record-incomplete-status', { service_date: `${YEAR}-05-01`, status: 'incomplete' }),
      record('record-outcome-incomplete', { service_date: `${YEAR}-05-02`, structured_notes: JSON.stringify({ visitOutcome: 'incomplete' }) }),
      record('record-declined-callback', { service_date: `${YEAR}-05-03`, structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }), record_is_callback: true }),
      record('record-inspection-only', { service_date: `${YEAR}-05-04`, structured_notes: JSON.stringify({ visitOutcome: 'inspection_only' }) }),
      // an internal-only record the customer never sees — excluded
      record('record-internal', { service_date: `${YEAR}-05-05`, structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) }),
      // another customer — excluded
      record('record-other-customer', { customer_id: 'customer-other' }),
      // last and next calendar year — excluded
      record('record-last-year', { service_date: `${YEAR - 1}-12-31` }),
      record('record-next-year', { service_date: `${YEAR + 1}-01-01` }),
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-counts', knex, LIVE_PAGE);
  expect(data.planSummary).toEqual({ year: YEAR, visitsThisYear: 10, reservicesThisYear: 3 });
});

test('one booking with several completion records (detailed form + recap rail) is one visit', async () => {
  const build = requireWithGateOn();
  const knex = makeKnex({
    ...BASE_FIXTURES,
    service_records: [
      // two sibling records of one booking — one visit, not two
      record('record-form', { service_date: `${YEAR}-02-10`, scheduled_service_id: 'booking-feb' }),
      record('record-recap', { service_date: `${YEAR}-02-10`, scheduled_service_id: 'booking-feb' }),
      // a callback booking whose siblings disagree on the flag — one visit,
      // one re-service
      record('record-cb-form', { service_date: `${YEAR}-03-10`, scheduled_service_id: 'booking-mar', record_is_callback: true }),
      record('record-cb-recap', { service_date: `${YEAR}-03-10`, scheduled_service_id: 'booking-mar' }),
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-siblings', knex, LIVE_PAGE);
  expect(data.planSummary).toEqual({ year: YEAR, visitsThisYear: 2, reservicesThisYear: 1 });
});

test('only the frozen record decides a re-service; a booking repointed after closeout never does', async () => {
  const build = requireWithGateOn();
  const countFor = async (row) => {
    const data = await build(BASE_SERVICE, `token-plan-${row.id}`, makeKnex({ ...BASE_FIXTURES, service_records: [row] }), LIVE_PAGE);
    return data.planSummary;
  };
  // Frozen callback flag, booking since flipped to a regular visit: counts.
  expect(await countFor(record('record-frozen-flag', { service_type: 'Pest Control Service', record_is_callback: true, service_key_snapshot: 'pest_general_quarterly', scheduled_is_callback: false })))
    .toEqual({ year: YEAR, visitsThisYear: 1, reservicesThisYear: 1 });
  // Frozen re-service key alone (flag never stamped, e.g. the recap rail): counts.
  expect(await countFor(record('record-frozen-key', { service_type: 'Pest Control Service', service_data: frozen('lawn_re_service') })))
    .toEqual({ year: YEAR, visitsThisYear: 1, reservicesThisYear: 1 });
  // Frozen regular visit, booking since repointed to a re-service: does not.
  expect(await countFor(record('record-frozen-regular', { service_type: 'Pest Re-Service', service_data: frozen('pest_general_quarterly'), service_key_snapshot: 'pest_re_service', scheduled_is_callback: true })))
    .toEqual({ year: YEAR, visitsThisYear: 1, reservicesThisYear: 0 });
});

test('a non-member gets no planSummary, even with completed visits and visits coming up', async () => {
  const build = requireWithGateOn();
  const addDays = (n) => { const d = new Date(`${todayIso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const knex = makeKnex({
    ...BASE_FIXTURES,
    // One-time customer: no tier, no monthly rate.
    customers: [{ id: 'customer-plan', waveguard_tier: null, monthly_rate: 0, active: true }],
    service_records: [record('record-current', { service_type: 'One-Time Pest Control' })],
    scheduled_services: [
      { id: 'scheduled-next', customer_id: 'customer-plan', scheduled_date: addDays(10), status: 'confirmed', service_type: 'Mosquito Event Spray' },
    ],
  });
  const data = await build(BASE_SERVICE, 'token-plan-nonmember', knex, LIVE_PAGE);
  expect(data).not.toHaveProperty('planSummary');
});

test.each(['pdf', 'static', undefined])('a non-live build (mode %s) skips the completed-history read and carries no planSummary', async (mode) => {
  const build = requireWithGateOn();
  const reads = [];
  const knex = makeKnex({
    ...BASE_FIXTURES,
    service_records: [record('record-current')],
  }, reads);
  // Opted in, so this proves the live-mode check on its own.
  const data = await build(BASE_SERVICE, `token-plan-${mode || 'default'}`, knex, { ...(mode ? { mode } : {}), planSummary: true });
  expect(data).not.toHaveProperty('planSummary');
  // The plan-summary history read is the only select carrying these aliases.
  const planHistoryRead = ([table, kind, args]) => table === 'service_records' && kind === 'select'
    && JSON.stringify(args).includes('record_is_callback');
  expect(reads.some(planHistoryRead)).toBe(false);
});

test('a live build WITHOUT the plan-summary opt-in (the Q&A endpoint) skips the reads and carries no planSummary', async () => {
  const build = requireWithGateOn();
  const reads = [];
  const knex = makeKnex({ ...BASE_FIXTURES, service_records: [record('record-current')] }, reads);
  const data = await build(BASE_SERVICE, 'token-plan-qa', knex, { mode: 'live' });
  expect(data).not.toHaveProperty('planSummary');
  expect(reads.some(([table, kind, args]) => table === 'service_records' && kind === 'select'
    && JSON.stringify(args).includes('record_is_callback'))).toBe(false);
});

test('omitted when there is no customer, or when the member has no performed visit this year', async () => {
  const build = requireWithGateOn();
  const noCustomer = await build({ ...BASE_SERVICE, customer_id: null }, 'token-plan-no-customer', makeKnex({ ...BASE_FIXTURES, scheduled_services: [] }), LIVE_PAGE);
  expect(noCustomer).not.toHaveProperty('planSummary');

  const nothingToShow = await build(BASE_SERVICE, 'token-plan-empty', makeKnex({ ...BASE_FIXTURES, service_records: [] }), LIVE_PAGE);
  expect(nothingToShow).not.toHaveProperty('planSummary');

  // Completed on the schedule but declined at the door: not a performed visit.
  const onlyDeclined = await build(BASE_SERVICE, 'token-plan-declined', makeKnex({
    ...BASE_FIXTURES,
    service_records: [record('record-declined', { structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }) })],
  }), LIVE_PAGE);
  expect(onlyDeclined).not.toHaveProperty('planSummary');
});

test('stripLiveOnlyScheduleFields removes planSummary the same way it removes nextAppointment', () => {
  const data = { nextAppointment: { scheduledDate: '2026-01-01' }, planSummary: { year: 2026, visitsThisYear: 1, reservicesThisYear: 0 } };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('planSummary');
  expect(data).not.toHaveProperty('nextAppointment');
});
