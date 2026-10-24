/**
 * find_available_slots explains itself (owner report 2026-10-23: the bar
 * offered "Tue Oct 28" for a Wednesday, guessed the visit length, and
 * answered a full weekend with "nothing feasible" and no reason).
 *  - every slot and searched day carries a server-computed day_label;
 *  - a named service takes its visit length from the catalog, not the model;
 *  - each searched day reports its booked stops and, with no slot, why;
 *  - per-day counts include slots past the operator's top N.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/service-library', () => ({
  serviceDurationMinutes: (row, fallback) => row.default_duration_minutes || fallback,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const CUSTOMER = '10000000-0000-4000-8000-000000000001';
const TECH = { id: '20000000-0000-4000-8000-000000000002', name: 'Test Tech' };
let tables;

function chain(rows) {
  const q = {};
  for (const m of ['where', 'whereILike', 'whereIn', 'whereNotIn', 'whereBetween', 'select', 'orderBy']) q[m] = () => q;
  q.first = async () => rows[0];
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

beforeEach(() => {
  tables = {
    customers: [{ latitude: '27.35', longitude: '-82.55' }],
    technicians: [TECH],
    services: [
      { id: 's1', service_key: 'rodent_trapping', name: 'Rodent Trapping', short_name: null, default_duration_minutes: 45 },
      { id: 's2', service_key: 'pest_control', name: 'General Pest Control', short_name: 'Pest', default_duration_minutes: 60 },
      { id: 's3', service_key: 'lawn_fert', name: 'Lawn Fertilization', short_name: null, default_duration_minutes: 30 },
      { id: 's4', service_key: 'lawn_weed', name: 'Lawn Weed Control', short_name: null, default_duration_minutes: 30 },
    ],
    scheduled_services: [
      { scheduled_date: '2026-10-24', technician_id: TECH.id, window_start: '08:00:00', window_end: '10:00:00' },
      { scheduled_date: '2026-10-24', technician_id: TECH.id, window_start: '15:00:00', window_end: '17:00:00' },
      { scheduled_date: '2026-10-28', technician_id: TECH.id, window_start: '10:00:00', window_end: '11:00:00' },
    ],
  };
  db.mockReset().mockImplementation((table) => chain(tables[table] || []));
  findAvailableSlots.mockReset().mockResolvedValue({
    slots: [
      { rank: 1, date: '2026-10-28', start_time: '08:28', detour_minutes: 42 },
      { rank: 2, date: '2026-10-28', start_time: '13:00', detour_minutes: 50 },
    ],
    searched_dates: ['2026-10-24', '2026-10-28'],
    total_feasible: 2,
  });
});

const search = (input) => executeScheduleTool('find_available_slots', { customer_id: CUSTOMER, ...input });

test('slots and days carry the real weekday; Oct 28 2026 is a Wednesday', async () => {
  const out = await search({ date_from: '2026-10-24', date_to: '2026-10-28' });
  expect(out.slots[0].day_label).toBe('Wed Oct 28');
  expect(out.days.map((d) => d.day_label)).toEqual(['Sat Oct 24', 'Wed Oct 28']);
  expect(out.searched).toMatchObject({ date_from_label: 'Sat Oct 24', date_to_label: 'Wed Oct 28' });
});

test('a named service takes its catalog length over a model-guessed one', async () => {
  const out = await search({ service_name: 'rodent trapping', duration_minutes: 120 });
  expect(findAvailableSlots.mock.calls[0][0]).toMatchObject({ durationMinutes: 45, serviceType: 'Rodent Trapping' });
  expect(out.searched).toMatchObject({ duration_minutes: 45, duration_source: 'catalog', service: 'Rodent Trapping', technicians: ['Test Tech'] });
});

test('an ambiguous service refuses with the choices instead of guessing a length', async () => {
  const out = await search({ service_name: 'lawn' });
  expect(out).toMatchObject({ code: 'service_ambiguous' });
  expect(out.choices.map((c) => c.name)).toEqual(['Lawn Fertilization', 'Lawn Weed Control']);
  expect(findAvailableSlots).not.toHaveBeenCalled();
});

test('no service: a stated length is used and labeled, else the 60-minute default', async () => {
  expect((await search({ duration_minutes: 90 })).searched).toMatchObject({ duration_minutes: 90, duration_source: 'operator' });
  expect((await search({})).searched).toMatchObject({ duration_minutes: 60, duration_source: 'default' });
});

test('a day with no slot says why, from the engine reasons or the booked stops', async () => {
  const out = await search({ date_from: '2026-10-24', date_to: '2026-10-28' });
  const [sat, wed] = out.days;
  expect(sat).toMatchObject({ stops_booked: 2, first_start: '08:00', last_end: '17:00', feasible_slots: 0 });
  expect(sat.no_slot_reason).toContain('2 booked stops (08:00 to 17:00)');
  expect(wed).toMatchObject({ feasible_slots: 2 });
  expect(wed.no_slot_reason).toBeUndefined();

  findAvailableSlots.mockResolvedValueOnce({ slots: [], searched_dates: ['2026-10-24'], rejections_by_date: { '2026-10-24': { detour_cap: 3 } } });
  const engine = await search({ date_from: '2026-10-24', date_to: '2026-10-24' });
  expect(engine.days[0].no_slot_reason).toContain('detour_cap x3');
});

test('per-day counts include slots past the top N the operator sees', async () => {
  const out = await search({ top_n: 1 });
  expect(findAvailableSlots.mock.calls[0][0].topN).toBeGreaterThan(1000);
  expect(out.slots).toHaveLength(1);
  expect(out.days.find((d) => d.date === '2026-10-28').feasible_slots).toBe(2);
});

test('a failed day-count read keeps the labeled slots', async () => {
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') throw new Error('boom');
    return chain(tables[table] || []);
  });
  const out = await search({});
  expect(out.slots[0].day_label).toBe('Wed Oct 28');
  expect(out.days[0].stops_booked).toBe(0);
});
