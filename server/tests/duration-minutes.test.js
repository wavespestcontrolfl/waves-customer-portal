const { minutesFromElapsed } = require('../utils/duration-minutes');
const {
  buildOnSiteLifecycleUpdates,
  buildCompletionLifecycleUpdates,
} = require('../utils/service-duration-capture');

describe('duration minute parsing', () => {
  test('parses timer strings, numeric strings, and minute labels', () => {
    expect(minutesFromElapsed('10:05')).toBe(10);
    expect(minutesFromElapsed('10:35')).toBe(11);
    expect(minutesFromElapsed('1:02:30')).toBe(63);
    expect(minutesFromElapsed('25')).toBe(25);
    expect(minutesFromElapsed('42 min')).toBe(42);
  });

  test('ignores empty and invalid elapsed values', () => {
    expect(minutesFromElapsed(null)).toBeNull();
    expect(minutesFromElapsed('')).toBeNull();
    expect(minutesFromElapsed('not a duration')).toBeNull();
  });
});

describe('service duration lifecycle updates', () => {
  test('sets all service start aliases when a job reaches on site', () => {
    const at = new Date('2026-05-15T14:00:00.000Z');
    expect(buildOnSiteLifecycleUpdates({}, at)).toEqual({
      actual_start_time: at,
      check_in_time: at,
      arrived_at: at,
    });
  });

  test('writes both duration aliases on completion from timestamps', () => {
    const at = new Date('2026-05-15T14:45:00.000Z');
    const updates = buildCompletionLifecycleUpdates({
      actual_start_time: '2026-05-15T14:00:00.000Z',
    }, at);

    expect(updates).toMatchObject({
      actual_end_time: at,
      check_out_time: at,
      service_time_minutes: 45,
      actual_duration_minutes: 45,
    });
  });

  test('infers start aliases from explicit elapsed completion input', () => {
    const at = new Date('2026-05-15T14:45:00.000Z');
    const updates = buildCompletionLifecycleUpdates({}, at, { elapsed: '35 min' });

    expect(updates.service_time_minutes).toBe(35);
    expect(updates.actual_duration_minutes).toBe(35);
    expect(updates.actual_start_time.toISOString()).toBe('2026-05-15T14:10:00.000Z');
    expect(updates.check_in_time.toISOString()).toBe('2026-05-15T14:10:00.000Z');
    expect(updates.arrived_at.toISOString()).toBe('2026-05-15T14:10:00.000Z');
  });

  test('keeps persisted completion duration when filling tracker aliases later', () => {
    const updates = buildCompletionLifecycleUpdates({
      actual_start_time: '2026-05-15T14:10:00.000Z',
      actual_end_time: '2026-05-15T14:45:00.000Z',
      service_time_minutes: 35,
    }, new Date('2026-05-15T14:48:00.000Z'));

    expect(updates).toMatchObject({
      actual_end_time: new Date('2026-05-15T14:45:00.000Z'),
      check_out_time: new Date('2026-05-15T14:45:00.000Z'),
      service_time_minutes: 35,
      actual_duration_minutes: 35,
    });
  });
});
