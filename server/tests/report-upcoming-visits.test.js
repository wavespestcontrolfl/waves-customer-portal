// "Your upcoming visits" card (owner-approved 2026-09-27,
// GATE_REPORT_UPCOMING_VISITS): buildReportV1Data surfaces ALL of the
// customer's upcoming scheduled visits across every program, for THIS
// report's property, for the next 90 days, capped at 6, as
// upcomingVisitsCard.visits[]: { serviceType, scheduledDate, windowStart }.
// Distinct from nextAppointment (report's own service line only, unchanged).
// Live-view only; stripped from pdf/static by stripLiveOnlyScheduleFields.

const { buildReportV1Data, stripLiveOnlyScheduleFields } = require('../services/service-report/report-data');

// Relative to the real clock (the implementation's 90-day window is
// Date.now()-based, not injectable) — never a hardcoded calendar date, which
// ages past "today" the moment the test suite outlives it. '2999-*' is used
// instead wherever a date only needs to be UNAMBIGUOUSLY beyond the 90-day
// window (same convention report-next-appointment.test.js uses).
function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Fake knex supporting the chain the upcoming-visits lookup uses, extending
// report-next-appointment.test.js's pattern with '<=' (the 90-day cutoff)
// and object-criteria where() on customer_properties / customers.
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
        if (op === '<=') rows = rows.filter((row) => String(row[column]) <= String(value));
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
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  knex.schema = { hasTable: async () => true };
  return knex;
}

const BASE_SERVICE = {
  id: 'service-upcoming',
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
  // Already-COALESCEd mirror address, as the reports-public.js SELECT
  // resolves it — matches the customers row below for the unlinked-report
  // fallback tests.
  address_line1: '100 Sample Trail',
  city: 'Bradenton',
  zip: '34211',
};

const BASE_FIXTURES = {
  service_products: [],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  customers: [{ id: 'customer-1', address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' }],
  customer_properties: [],
};

const LIVE = { mode: 'live' };

afterEach(() => { delete process.env.GATE_REPORT_UPCOMING_VISITS; });

test('gate off: upcomingVisitsCard is absent (null), even with matching upcoming visits', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-off', knex, LIVE);
  expect(data.upcomingVisitsCard).toBeNull();
});

test('gate on but not live mode: upcomingVisitsCard stays null (pdf/static builds)', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-static', knex, { mode: 'static' });
  expect(data.upcomingVisitsCard).toBeNull();
});

test('gated + live: lists multi-program upcoming visits (pest, lawn, termite) for the unlinked report\'s mirror property, sorted, excluding cancelled/completed/rescheduled', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-cancelled', customer_id: 'customer-1', scheduled_date: todayPlus(3), status: 'cancelled', service_type: 'Mosquito Service', window_start: '09:00:00' },
      { id: 'scheduled-lawn', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00' },
      { id: 'scheduled-termite', customer_id: 'customer-1', scheduled_date: todayPlus(10), status: 'pending', service_type: 'Termite Bait Station Service', window_start: '10:00:00' },
      { id: 'scheduled-pest', customer_id: 'customer-1', scheduled_date: todayPlus(30), status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00' },
      // rescheduled phantom placeholder — never disclosed
      { id: 'scheduled-phantom', customer_id: 'customer-1', scheduled_date: todayPlus(1), status: 'rescheduled', service_type: 'Should never appear', window_start: '07:00:00' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-multi', knex, LIVE);

  expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual([
    'Lawn Care Treatment',
    'Termite Bait Station Service',
    'Quarterly Pest Control Service',
  ]);
  expect(data.upcomingVisitsCard.visits[0]).toEqual({
    serviceType: 'Lawn Care Treatment',
    scheduledDate: todayPlus(5),
    windowStart: '08:00:00',
  });
});

test('excludes visits more than 90 days out', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-far', customer_id: 'customer-1', scheduled_date: '2999-01-01', status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '09:00:00' },
    ],
  });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-far', knex, LIVE);
  expect(data.upcomingVisitsCard).toBeNull();
});

test('caps at 6 visits', async () => {
  process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `scheduled-${i}`,
    customer_id: 'customer-1',
    scheduled_date: todayPlus(2 + i),
    status: 'confirmed',
    service_type: `Visit ${i}`,
    window_start: '09:00:00',
  }));
  const knex = makeKnex({ ...BASE_FIXTURES, scheduled_services: rows });
  const data = await buildReportV1Data(BASE_SERVICE, 'token-cap', knex, LIVE);
  expect(data.upcomingVisitsCard.visits).toHaveLength(6);
  expect(data.upcomingVisitsCard.visits[0].serviceType).toBe('Visit 0');
});

describe('multi-property scoping', () => {
  const PROP_A = { id: 'prop-a', address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
  const PROP_B = { id: 'prop-b', address_line1: '20 Duplicate Way', address_line2: null, city: 'Nokomis', zip: '34275' };

  test('linked report: property_id match includes a same-property visit and excludes a different property\'s and a different customer\'s', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Quarterly Pest Control Service', property_id: 'prop-a' },
        // same property (prop-a) — included
        { id: 'scheduled-same-prop', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Lawn Care Treatment', window_start: '08:00:00', property_id: 'prop-a' },
        // OTHER property on the SAME customer (prop-b, a rental) — excluded
        { id: 'scheduled-other-prop', customer_id: 'customer-1', scheduled_date: todayPlus(6), status: 'confirmed', service_type: 'Should never appear (other property)', window_start: '09:00:00', property_id: 'prop-b' },
        // OTHER CUSTOMER entirely, even same property id by coincidence — excluded (customer_id scoping)
        { id: 'scheduled-other-customer', customer_id: 'customer-2', scheduled_date: todayPlus(7), status: 'confirmed', service_type: 'Should never appear (other customer)', window_start: '09:00:00', property_id: 'prop-a' },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-scope',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Lawn Care Treatment']);
  });

  test('linked report for a SECONDARY property (no stamp on the report row): an unstamped candidate falls back to the primary mirror, not the secondary property, and is excluded', async () => {
    process.env.GATE_REPORT_UPCOMING_VISITS = 'true';
    const knex = makeKnex({
      ...BASE_FIXTURES,
      customer_properties: [PROP_A, PROP_B],
      scheduled_services: [
        // the report's own visit is linked to the SECONDARY property (prop-b), no stamp text
        { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: '2026-05-16', status: 'completed', service_type: 'Pest Control at rental', property_id: 'prop-b' },
        // unstamped, unlinked candidate — COALESCEs to the customer mirror (prop-a's address) everywhere else, so it is NOT prop-b's visit
        { id: 'scheduled-unstamped', customer_id: 'customer-1', scheduled_date: todayPlus(5), status: 'confirmed', service_type: 'Should never appear (belongs to the primary, not this rental)', window_start: '09:00:00' },
        // a stamped visit at the SAME secondary address as the report — included
        { id: 'scheduled-same-secondary', customer_id: 'customer-1', scheduled_date: todayPlus(9), status: 'confirmed', service_type: 'Pest Control at rental follow-up', window_start: '10:00:00', service_address_line1: PROP_B.address_line1, service_address_city: PROP_B.city, service_address_zip: PROP_B.zip },
      ],
    });
    const data = await buildReportV1Data(
      { ...BASE_SERVICE, service_date: '2026-05-16' },
      'token-secondary',
      knex,
      LIVE,
    );
    expect(data.upcomingVisitsCard.visits.map((v) => v.serviceType)).toEqual(['Pest Control at rental follow-up']);
  });
});

test('stripLiveOnlyScheduleFields removes upcomingVisitsCard for pdf/static renders', () => {
  const data = { upcomingVisitsCard: { visits: [{ serviceType: 'Lawn Care Treatment', scheduledDate: todayPlus(5), windowStart: '08:00:00' }] }, other: 1 };
  stripLiveOnlyScheduleFields(data);
  expect(data).not.toHaveProperty('upcomingVisitsCard');
  expect(data.other).toBe(1);
});
