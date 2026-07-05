// Next-appointment payload on the customer service report (owner ask
// 2026-07-05): buildReportV1Data surfaces the customer's next upcoming
// scheduled_services row as nextAppointment { serviceType, scheduledDate,
// windowStart } — window_end deliberately never rides the payload (the
// customer-facing arrival window is always window_start + 2 hours; window_end
// is the internal job block). The visit the report covers is excluded by id.

const { buildReportV1Data } = require('../services/service-report/report-data');

// Fake knex that supports the chain the next-appointment lookup uses
// (where/andWhere/whereIn/whereNot via modify/orderBy/first) on top of the
// object-criteria `where` the rest of the builder calls.
function makeKnex(fixtures) {
  return (table) => {
    let rows = [...(fixtures[table] || [])];
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
      orderBy(column) {
        rows = [...rows].sort((a, b) => String(a[column] || '').localeCompare(String(b[column] || '')));
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

test('payload surfaces the next upcoming appointment without window_end', async () => {
  const farFuture = '2999-01-02';
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      // the visit this report covers — must never be reported as "next"
      { id: 'scheduled-current', customer_id: 'customer-1', scheduled_date: farFuture, status: 'pending', service_type: 'Quarterly Pest Control Service', window_start: '08:00:00', window_end: '12:00:00' },
      { id: 'scheduled-cancelled', customer_id: 'customer-1', scheduled_date: farFuture, status: 'cancelled', service_type: 'Mosquito Service', window_start: '09:00:00' },
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

test('payload nextAppointment is null when nothing upcoming is scheduled', async () => {
  const knex = makeKnex({
    ...BASE_FIXTURES,
    scheduled_services: [
      { id: 'scheduled-past', customer_id: 'customer-1', scheduled_date: '2020-01-01', status: 'pending', service_type: 'Quarterly Pest Control Service' },
      { id: 'scheduled-done', customer_id: 'customer-1', scheduled_date: '2999-01-05', status: 'completed', service_type: 'Quarterly Pest Control Service' },
    ],
  });

  const data = await buildReportV1Data(BASE_SERVICE, 'token-next-appt-none', knex);

  expect(data.nextAppointment).toBeNull();
});
