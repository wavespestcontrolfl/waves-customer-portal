// Next-appointment payload on the customer service report (owner ask
// 2026-07-05): buildReportV1Data surfaces the customer's next upcoming
// scheduled_services row OF THE REPORT'S SERVICE LINE (a pest report shows
// the next pest visit — candidates are classified via detectServiceLine) as
// nextAppointment { serviceType, scheduledDate, windowStart } — window_end
// deliberately never rides the payload (the customer-facing arrival window is
// always window_start + 2 hours; window_end is the internal job block). The
// visit the report covers is excluded by id.

const { buildReportV1Data } = require('../services/service-report/report-data');

// Fake knex that supports the chain the next-appointment lookup uses
// (where/andWhere/whereIn/whereNot via modify/orderBy/first) on top of the
// object-criteria `where` the rest of the builder calls.
function makeKnex(fixtures) {
  return (table) => {
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
      modify(fn) { fn(query); return query; },
      limit: () => query,
      orderBy(column) {
        // real knex chains orderBy calls as primary-then-tiebreak keys; a
        // per-call re-sort would let the LAST key win instead
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
}

const BASE_SERVICE = {
  id: 'service-next-appt',
  scheduled_service_id: 'scheduled-current',
  customer_id: 'customer-1',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-05-16',
  first_name: 'Van',
  last_name: 'Lee',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: '{}',
  service_data: '{}',
  pressure_index: 0,
};

const BASE_FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
};

test('payload surfaces the next same-line appointment without window_end', async () => {
  const farFuture = '2999-01-02';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the visit this report covers — must never be reported as "next"
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: farFuture, status: 'pending', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00', window_end: '12:00:00' },
      { id: 'scheduled-cancelled', customer_id: 'customer-1', scheduled_date: farFuture, status: 'cancelled', service_type: 'Mosquito Service', window_start: '09:00:00' },
      // earlier than the pest row, but a different service line — a pest
      // report must skip it (owner 2026-07-05: next visit of THIS line)
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: farFuture, status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00' },
      // 'rescheduled' phantom placeholder holding the OLD date/window until
      // the office rebooks — must never publish as the next appointment
      { id: 'scheduled-phantom', customer_id: 'customer-1', scheduled_date: farFuture, status: 'rescheduled', service_type: 'Quarterly Pest Control Service', window_start: '07:00:00' },
      { id: 'scheduled-next', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00', window_end: '13:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Quarterly Pest Control Service',
    scheduledDate: '2999-01-03',
    windowStart: '09:00:00',
  });
  expect(data.nextAppointment.windowEnd).toBeUndefined();
});

test('an in-progress (en_route) same-line visit publishes as the next appointment', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the customer opens an older report while today's visit is in progress —
      // the active visit IS the next appointment (same disclosable statuses as
      // findReportFollowupAppointment)
      { id: 'scheduled-active', customer_id: 'customer-1', scheduled_date: '2999-01-01', status: 'en_route', service_type: 'Pest Control', window_start: '10:00:00' },
      { id: 'scheduled-later', customer_id: 'customer-1', scheduled_date: '2999-03-01', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-active', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Pest Control',
    scheduledDate: '2999-01-01',
    windowStart: '10:00:00',
  });
});

test('payload nextAppointment is null when nothing upcoming matches the service line', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-past', customer_id: 'customer-1', scheduled_date: '2020-01-01', status: 'pending', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-done', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      // upcoming, open — but a lawn visit on a pest report: no match
      { id: 'scheduled-otherline', customer_id: 'customer-1', scheduled_date: '2999-01-06', status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-none', knex);

  expect(data.nextAppointment).toBeNull();
});

// Rodent reports under GATE_RODENT_REPORT_REFRESH widen the match to the
// whole rodent program (owner 2026-07-27: next service date if and only if
// it is rodent-related) — exclusion/sanitation/trapping names carry no
// rodent token and fall to the 'pest' default line, so the strict same-line
// match missed them. The widening is part of the gated refresh: with the
// gate dark, behavior is exactly the pre-refresh strict match (codex
// round-3 P2).
const RODENT_SERVICE = {
  ...BASE_SERVICE,
  id: 'service-rodent-next',
  service_line: 'rodent',
  service_type: 'Rodent Trapping Service',
};

afterEach(() => { delete process.env.GATE_RODENT_REPORT_REFRESH; });

const RODENT_PROGRAM_FIXTURES = {
  ...BASE_FIXTURES,
  // the catalog is the rodent evidence: a widened candidate must be a
  // services row with category 'rodent' — name shape alone is not enough
  // (codex round-4 P2)
  services: [
    { id: 'svc-exclusion', name: 'Exclusion Service', category: 'rodent' },
    { id: 'svc-sanitation', name: 'Sanitation & Cleanup', category: 'rodent' },
  ],
  scheduled_services: [
    // no rodent token, detects as pest — but it IS the rodent program
    { id: 'scheduled-exclusion', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Exclusion Service', window_start: '08:00:00' },
    { id: 'scheduled-rodent-later', customer_id: 'customer-1', scheduled_date: '2999-02-01', status: 'confirmed', service_type: 'Rodent Trap Check', window_start: '09:00:00' },
  ],
};

test('gated: a rodent report discloses a rodent-adjacent visit (Exclusion Service) as next', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-excl', makeKnex(RODENT_PROGRAM_FIXTURES));

  expect(data.nextAppointment).toEqual({
    serviceType: 'Exclusion Service',
    scheduledDate: '2999-01-03',
    windowStart: '08:00:00',
  });
});

test('gate dark: the strict same-line pick is unchanged (kill switch restores old behavior)', async () => {
  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-dark', makeKnex(RODENT_PROGRAM_FIXTURES));

  expect(data.nextAppointment).toEqual({
    serviceType: 'Rodent Trap Check',
    scheduledDate: '2999-02-01',
    windowStart: '09:00:00',
  });
});

test('a rodent report never claims trap-named visits of OTHER detectable lines or outside the rodent catalog', async () => {
  process.env.GATE_RODENT_REPORT_REFRESH = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    // only Sanitation & Cleanup is a rodent-category catalog service here
    services: [
      { id: 'svc-sanitation', name: 'Sanitation & Cleanup', category: 'rodent' },
      { id: 'svc-wildlife', name: 'Wildlife Trapping', category: 'specialty' },
    ],
    scheduled_services: [
      // "trap" token but detectably mosquito — stays off the rodent report
      { id: 'scheduled-mosq-trap', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Mosquito Trap Service', window_start: '08:00:00' },
      // trapping token, pest-default line, but wildlife work — the negative
      // guard AND the catalog keep non-rodent trapping out (codex P1)
      { id: 'scheduled-wildlife', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Wildlife Trapping', window_start: '09:00:00' },
      { id: 'scheduled-fly-trap', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Fly Trap Service', window_start: '11:00:00' },
      // adjacent-shaped name with NO rodent catalog row — name shape alone
      // is not rodent evidence (codex round-4 P2)
      { id: 'scheduled-postcon', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Post-Construction Exclusion', window_start: '12:00:00' },
      // quarterly pest visit: not rodent-related, also skipped
      { id: 'scheduled-pest', customer_id: 'customer-1', scheduled_date: '2999-01-04', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00' },
      { id: 'scheduled-sanitation', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'confirmed', service_type: 'Sanitation & Cleanup', window_start: '10:00:00' },
    ],
  });

  const data = await buildReportV1Data(RODENT_SERVICE, 'token-rodent-mosq', knex);

  expect(data.nextAppointment).toEqual({
    serviceType: 'Sanitation & Cleanup',
    scheduledDate: '2999-01-05',
    windowStart: '10:00:00',
  });
});

test('non-rodent reports keep the strict same-line match', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // pest report + rodent-adjacent name that detects pest: still matches
      // (unchanged pest behavior), so assert with a LAWN report instead
      { id: 'scheduled-exclusion', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Exclusion Service', window_start: '08:00:00' },
    ],
  });

  const data = await buildReportV1Data(
    { ...BASE_SERVICE, id: 'service-lawn-next', service_line: 'lawn', service_type: 'Lawn Care Treatment' },
    'token-lawn-none',
    knex,
  );

  expect(data.nextAppointment).toBeNull();
});
