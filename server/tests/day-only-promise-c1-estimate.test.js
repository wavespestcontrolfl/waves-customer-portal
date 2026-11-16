/**
 * GATE_DAY_ONLY_PROMISE part C1: the estimate page's linked ("existing") appointment. A customer-picked slot keeps its
 * hour (loadTimeDisplay says so); a visit the office booked and told only the day shows the date and the note.
 */
const mockLoadTimeDisplay = jest.fn();
jest.mock('../services/time-promise', () => ({
  ...jest.requireActual('../services/time-promise'),
  loadTimeDisplay: (...args) => mockLoadTimeDisplay(...args),
}));
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildEstimateAcceptanceContract, withDayOnlyDisplay } = require('../routes/estimate-public');

const NOTE = 'Arrival window texted the day before';
const linked = {
  id: 'svc-1', scheduled_date: '2099-01-12', window_start: '09:00:00', window_end: '11:00:00', window_display: '9:00 AM',
  service_type: 'Pest Control', status: 'confirmed', customer_id: 'cust-1',
};
const shaped = async (row) => buildEstimateAcceptanceContract({ existingAppointment: await withDayOnlyDisplay(row) }).appointment;

function answer(showHour) {
  mockLoadTimeDisplay.mockImplementation(async (_conn, rows) => new Map(rows.map((r) => [r.id, { showHour, level: 'none', eligible: !showHour }])));
}

beforeEach(() => jest.clearAllMocks());

test('day-only: no hour field, the note, one call', async () => {
  answer(false);
  const appt = await shaped(linked);
  expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
  expect(appt).toMatchObject({
    scheduledDate: '2099-01-12', windowStart: null, windowEnd: null, windowDisplay: null, day_only: true, arrival_note: NOTE,
  });
  expect(JSON.stringify(appt)).not.toMatch(/9:00|09:00|11:00/);
});

test('a customer-picked slot, inside the cutoff or gate off: today\'s shape, no new key', async () => {
  answer(true);
  const appt = await shaped(linked);
  expect(appt).toMatchObject({ windowStart: '09:00', windowEnd: '11:00', windowDisplay: '9:00 AM - 11:00 AM' });
  expect(appt).not.toHaveProperty('day_only');
  expect(appt).not.toHaveProperty('arrival_note');
});

test('a loadTimeDisplay failure shows the hour', async () => {
  mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
  expect((await shaped(linked)).windowStart).toBe('09:00');
});

test('no linked appointment: nothing to read', async () => {
  expect(await withDayOnlyDisplay(null)).toBeNull();
  expect(mockLoadTimeDisplay).not.toHaveBeenCalled();
});
