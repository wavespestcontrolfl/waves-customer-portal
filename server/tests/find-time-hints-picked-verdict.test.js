/**
 * Codex r4 P2 on #4663: pickedUnscorable (scheduling/find-time-hints.js) —
 * the admin "best times" picker's own verdict on the hour already in the
 * form — still required `pickedMin + SHIFT.arrivalMinutes (120) <=
 * SHIFT.endMinutes` in capacity mode, a stale copy of the 2-hour headroom
 * margin Codex r1 P1 removed from policy.js's placementFitsShift (and from
 * the recommendation list itself) because it disagreed with the shared
 * customer grid's 17:00 offer. The recommendation list could recommend
 * 17:00 for a 60-minute job (ending exactly at the 18:00 close), but the
 * moment the operator picked that exact hour, scorePickedHour returned
 * undefined (no verdict) instead of a fit — an offer/verdict break parallel
 * to the one r1 fixed for offer/commit.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/rain-out', () => ({
  loadOccupancy: jest.fn(async () => ({})),
  conflictsForTarget: jest.fn(() => []),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  checkArrivalPlacement: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  DAY_START_HOUR: 8,
  DAY_END_HOUR: 17,
}));
jest.mock('../services/scheduling/window-rules', () => ({
  ADMIN_DAY_END_MINUTES: 20 * 60,
}));

const { scorePickedHour } = require('../services/scheduling/find-time-hints');

const FUTURE_DATE = '2099-06-15'; // never "today" — same-day floor never applies
const TODAY = '2026-09-23';

function gapSlot(startTime, latestStartMin) {
  return { date: FUTURE_DATE, start_time: startTime, technician: { id: 'tech-1', name: 'A' },
    detour_minutes: 3, latest_start_min: latestStartMin, insertion: {} };
}

describe('scorePickedHour — capacity-mode picked-hour verdict matches the offered grid', () => {
  const GATE = 'GATE_SCHEDULING_CAPACITY';
  let previous;
  beforeEach(() => { previous = process.env[GATE]; });
  afterEach(() => {
    if (previous === undefined) delete process.env[GATE];
    else process.env[GATE] = previous;
  });

  test('capacity on: a 17:00 pick for a 60-minute job (ending exactly at the 18:00 close) gets a real verdict, not undefined', async () => {
    process.env[GATE] = 'true';
    const rawSlots = [gapSlot('09:00', 17 * 60)]; // gap covers 09:00 through 17:00
    const result = await scorePickedHour({
      rawSlots, from: FUTURE_DATE, today: TODAY, sameDayFloorMin: undefined, useArrivalWindows: false,
      pickedStart: '17:00', pickedEnd: undefined, spanMin: 60,
      serviceId: 'svc-1', technicianId: 'tech-1', excludeServiceIds: [], excluded: [], changes: {},
    });
    expect(result).toBeDefined();
    expect(result).toMatchObject({ start: '17:00', fits: true });
  });

  test('capacity off: the same 17:00 pick still gets a real verdict (legacy 17:00 close, unaffected either way)', async () => {
    delete process.env[GATE];
    const rawSlots = [gapSlot('09:00', 17 * 60)];
    const result = await scorePickedHour({
      rawSlots, from: FUTURE_DATE, today: TODAY, sameDayFloorMin: undefined, useArrivalWindows: false,
      pickedStart: '16:00', pickedEnd: undefined, spanMin: 60,
      serviceId: 'svc-1', technicianId: 'tech-1', excludeServiceIds: [], excluded: [], changes: {},
    });
    expect(result).toBeDefined();
    expect(result).toMatchObject({ start: '16:00', fits: true });
  });

  test('capacity on: a pick whose END runs past the 18:00 close still gets no verdict (the real close bound is unaffected by removing the stale margin)', async () => {
    process.env[GATE] = 'true';
    const rawSlots = [gapSlot('09:00', 17 * 60 + 30)];
    const result = await scorePickedHour({
      rawSlots, from: FUTURE_DATE, today: TODAY, sameDayFloorMin: undefined, useArrivalWindows: false,
      pickedStart: '17:30', pickedEnd: undefined, spanMin: 60, // ends 18:30 — past the 18:00 close
      serviceId: 'svc-1', technicianId: 'tech-1', excludeServiceIds: [], excluded: [], changes: {},
    });
    expect(result).toBeUndefined();
  });
});
