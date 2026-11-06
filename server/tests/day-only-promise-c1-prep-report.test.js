/**
 * GATE_DAY_ONLY_PROMISE part C1: the prep page's upcoming-visits band, the project report's follow-up appointment
 * and the service report's next-visit fields. loadTimeDisplay (part B1) is mocked: it is the one decision.
 */
const mockLoadTimeDisplay = jest.fn();
jest.mock('../services/time-promise', () => ({ loadTimeDisplay: (...args) => mockLoadTimeDisplay(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockRows = { current: [] };
const mockDb = jest.fn(() => {
  const q = {};
  for (const m of ['where', 'whereNotIn', 'orderBy', 'limit']) q[m] = () => q;
  q.select = async () => mockRows.current;
  return q;
});
jest.mock('../models/db', () => mockDb);

const prep = require('../routes/prep-public');
const { _test: narrative } = require('../services/service-report/visit-summary-narrative');
const { buildReportV1Data } = require('../services/service-report/report-data');

const { fetchUpcomingFamilyVisits } = prep._test;
const NOTE = 'Arrival window texted the day before';

function dayOnly(...ids) {
  mockLoadTimeDisplay.mockImplementation(async (_conn, rows) => new Map(rows.map((r) => [
    r.id, { showHour: !ids.includes(r.id), level: 'none', eligible: ids.includes(r.id) },
  ])));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.current = [
    { id: 'v-day', scheduled_date: '2099-01-12', window_start: '09:00:00', service_type: 'Pest Control' },
    { id: 'v-picked', scheduled_date: '2099-02-12', window_start: '13:00:00', service_type: 'Pest Control' },
  ];
});

describe('prep page upcoming visits', () => {
  test('day-only: the date, no window, the day_only fields; a customer-picked visit keeps its window; ONE call', async () => {
    dayOnly('v-day');
    const visits = await fetchUpcomingFamilyVisits('cust-1', 'pest_inspection');
    expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(visits[0]).toMatchObject({ windowLabel: null, day_only: true, arrival_note: NOTE });
    expect(visits[0].dateLabel).toBeTruthy();
    expect(JSON.stringify(visits[0])).not.toMatch(/9:00|11:00/);
    expect(visits[1].windowLabel).toBe('1:00–3:00 PM');
    expect(visits[1]).not.toHaveProperty('day_only');
  });

  test('gate off or inside the cutoff: byte-for-byte today (same keys, hour shown)', async () => {
    dayOnly();
    const visits = await fetchUpcomingFamilyVisits('cust-1', 'pest_inspection');
    for (const v of visits) expect(Object.keys(v).sort()).toEqual(['dateLabel', 'serviceLabel', 'windowLabel']);
    expect(visits[0].windowLabel).toBe('9:00–11:00 AM');
  });

  test('a loadTimeDisplay failure shows the hour', async () => {
    mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
    const visits = await fetchUpcomingFamilyVisits('cust-1', 'pest_inspection');
    expect(visits[0].windowLabel).toBe('9:00–11:00 AM');
  });
});

describe('service report next-visit line', () => {
  const near = (window) => ({ scheduledDate: '2099-01-12', windowStart: window });

  test('a blank windowStart (the day-only server blanking) makes the narrative facts and the fallback sentence date-only', () => {
    const facts = narrative.groundingFacts({ recap: 'Treated the exterior.', serviceTypeDisplay: 'Pest Control', nextAppointment: near(null) });
    expect(facts.nextVisit.window).toBeNull();
    const line = narrative.deterministicSummary(facts);
    expect(line).toMatch(/Your next visit is scheduled for .*2099|Jan/);
    expect(line).not.toMatch(/arriving/);
  });

  test('an hour (customer-picked or inside the cutoff) still prints the window', () => {
    const facts = narrative.groundingFacts({ recap: 'Treated the exterior.', serviceTypeDisplay: 'Pest Control', nextAppointment: near('09:00:00') });
    expect(narrative.deterministicSummary(facts)).toMatch(/arriving/);
  });

  // Fake knex for the next-appointment lookup (same chain report-next-appointment.test.js uses).
  function makeKnex(fixtures) {
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') rows = rows.filter((row) => Object.entries(criteria).every(([key, val]) => row[key] === val));
          return query;
        },
        andWhere(column, op, value) {
          if (op === '>=') rows = rows.filter((row) => String(row[column]) >= String(value));
          return query;
        },
        whereIn(column, values) { rows = rows.filter((row) => values.includes(row[column])); return query; },
        whereNot(column, value) { rows = rows.filter((row) => row[column] !== value); return query; },
        whereRaw() { return query; },
        modify(fn) { fn(query); return query; },
        limit: () => query,
        orderBy(column) { rows = [...rows].sort((a, b) => String(a[column] || '').localeCompare(String(b[column] || ''))); return query; },
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
  const SERVICE = {
    id: 'service-1', scheduled_service_id: 'scheduled-current', customer_id: 'customer-1', service_line: 'pest',
    service_type: 'Quarterly Pest Control Service', service_date: '2026-05-16', first_name: 'Van', last_name: 'Lee',
    areas_serviced: JSON.stringify(['Perimeter']), structured_notes: '{}', service_data: '{}', pressure_index: 0,
  };
  const fixtures = () => makeKnex({
    service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
    scheduled_services: [
      { id: 'scheduled-next', customer_id: 'customer-1', scheduled_date: '2999-01-03', status: 'confirmed', service_type: 'Quarterly Pest Control Service', window_start: '09:00:00', window_end: '13:00:00' },
    ],
  });

  test('day-only: the next appointment carries the date, no hour, and the note; ONE bulk call', async () => {
    dayOnly('scheduled-next');
    const data = await buildReportV1Data(SERVICE, 'tok-1', fixtures(), { mode: 'live' });
    expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(data.nextAppointment).toEqual({
      serviceType: 'Quarterly Pest Control Service', scheduledDate: '2999-01-03', windowStart: null,
      day_only: true, arrival_note: NOTE,
    });
  });

  test('customer-picked, inside the cutoff or gate off: byte-for-byte today', async () => {
    dayOnly();
    const data = await buildReportV1Data(SERVICE, 'tok-2', fixtures(), { mode: 'live' });
    expect(data.nextAppointment).toEqual({ serviceType: 'Quarterly Pest Control Service', scheduledDate: '2999-01-03', windowStart: '09:00:00' });
  });

  test('a loadTimeDisplay failure shows the hour and the report still builds', async () => {
    mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
    const data = await buildReportV1Data(SERVICE, 'tok-3', fixtures(), { mode: 'live' });
    expect(data.nextAppointment.windowStart).toBe('09:00:00');
  });
});
