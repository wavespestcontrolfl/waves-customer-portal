/**
 * scorePickedHourByTech (scheduling/find-time-hints.js): New appointment's
 * "who adds the least drive at this hour" list (owner 2026-10-05). One
 * gap-mode verdict per technician, fits only, least added drive first, and
 * the occupancy check is asked per technician.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/rain-out', () => ({
  loadOccupancy: jest.fn(async () => ({ rows: [] })),
  conflictsForTarget: jest.fn(() => []),
}));
jest.mock('../services/scheduling/arrival-route', () => ({ checkArrivalPlacement: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ DAY_START_HOUR: 8, DAY_END_HOUR: 17 }));
jest.mock('../services/scheduling/window-rules', () => ({ ADMIN_DAY_END_MINUTES: 20 * 60 }));

const rainOut = require('../services/rain-out');
const { scorePickedHourByTech } = require('../services/scheduling/find-time-hints');

const DATE = '2099-06-15';
const TODAY = '2026-10-05';

function gap(techId, name, startTime, latestStartMin, detour, extra = {}) {
  return { date: DATE, start_time: startTime, latest_start_min: latestStartMin, detour_minutes: detour,
    technician: { id: techId, name }, insertion: {}, ...extra };
}

function score(rawSlots, pickedStart = '13:00') {
  return scorePickedHourByTech({
    rawSlots, from: DATE, today: TODAY, sameDayFloorMin: undefined, pickedStart, pickedEnd: undefined, spanMin: 60, excluded: [],
  });
}

afterEach(() => { rainOut.conflictsForTarget.mockReset(); rainOut.conflictsForTarget.mockImplementation(() => []); });

test('lists every technician whose route fits the hour, least added drive first', async () => {
  const result = await score([
    gap('t-a', 'Tech A', '09:00', 15 * 60, 34),
    gap('t-b', 'Tech B', '12:00', 14 * 60, 12),
    gap('t-c', 'Tech C', '08:00', 10 * 60, 5), // gap ends before 13:00: does not fit
  ]);
  expect(result.map((v) => v.technician.id)).toEqual(['t-b', 't-a']);
  expect(result[0]).toMatchObject({ start: '13:00', fits: true, detour_minutes: 12 });
});

test('asks the occupancy check per technician and drops one it refuses', async () => {
  rainOut.conflictsForTarget.mockImplementation((_occ, _id, _date, _win, opts) => (opts.technicianId === 't-a' ? [{ id: 'x' }] : []));
  const result = await score([gap('t-a', 'Tech A', '09:00', 15 * 60, 3), gap('t-b', 'Tech B', '09:00', 15 * 60, 20)]);
  expect(result.map((v) => v.technician.id)).toEqual(['t-b']);
  expect(rainOut.conflictsForTarget).toHaveBeenCalledWith(expect.anything(), null, DATE, { start: '13:00', end: '14:00' },
    expect.objectContaining({ technicianId: 't-a' }));
});

test('puts an unknown detour last and ignores other dates', async () => {
  const result = await score([
    gap('t-a', 'Tech A', '09:00', 15 * 60, null),
    gap('t-b', 'Tech B', '09:00', 15 * 60, 40),
    { ...gap('t-c', 'Tech C', '09:00', 15 * 60, 1), date: '2099-06-16' },
  ]);
  expect(result.map((v) => v.technician.id)).toEqual(['t-b', 't-a']);
});

test('answers nothing for an inverted or past-close pick', async () => {
  expect(await scorePickedHourByTech({
    rawSlots: [gap('t-a', 'Tech A', '09:00', 15 * 60, 3)], from: DATE, today: TODAY,
    pickedStart: '13:00', pickedEnd: '12:00', spanMin: 60, excluded: [],
  })).toEqual([]);
});
