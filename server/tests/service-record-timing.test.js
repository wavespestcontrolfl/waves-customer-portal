const { buildServiceRecordCompletionTimingFields } = require('../services/service-report/service-record-timing');

describe('service record completion timing fields', () => {
  test('copies scheduled service arrival aliases into matching service_records columns', () => {
    const completedAt = new Date('2026-05-19T14:28:00.000Z');
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: {
        arrived_at: '2026-05-19T13:42:00.000Z',
        actual_start_time: '2026-05-19T13:43:00.000Z',
        check_in_time: '2026-05-19T13:44:00.000Z',
      },
      completedAt,
      serviceRecordCols: {
        arrived_at: {},
        actual_start_time: {},
        check_in_time: {},
        completed_at: {},
        actual_end_time: {},
        check_out_time: {},
      },
    });

    expect(fields).toMatchObject({
      arrived_at: '2026-05-19T13:42:00.000Z',
      actual_start_time: '2026-05-19T13:43:00.000Z',
      check_in_time: '2026-05-19T13:44:00.000Z',
      completed_at: completedAt,
      actual_end_time: completedAt,
      check_out_time: completedAt,
    });
  });

  test('uses legacy started_at and ended_at when exact service_records columns are absent', () => {
    const completedAt = new Date('2026-05-19T14:28:00.000Z');
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: {
        arrived_at: '2026-05-19T13:42:00.000Z',
        actual_start_time: '2026-05-19T13:42:00.000Z',
        check_in_time: '2026-05-19T13:42:00.000Z',
      },
      completedAt,
      serviceRecordCols: {
        started_at: {},
        ended_at: {},
      },
    });

    expect(fields).toEqual({
      started_at: '2026-05-19T13:42:00.000Z',
      ended_at: completedAt,
    });
  });

  test('falls back across arrival aliases without using completion time as arrival', () => {
    const completedAt = new Date('2026-05-19T14:28:00.000Z');
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: {
        actual_start_time: '2026-05-19T13:42:00.000Z',
      },
      completedAt,
      serviceRecordCols: {
        arrived_at: {},
        actual_start_time: {},
        check_in_time: {},
      },
    });

    expect(fields).toEqual({
      arrived_at: '2026-05-19T13:42:00.000Z',
      actual_start_time: '2026-05-19T13:42:00.000Z',
      check_in_time: '2026-05-19T13:42:00.000Z',
    });
  });

  test('leaves arrival null when the scheduled service has no arrival timestamp', () => {
    const completedAt = new Date('2026-05-19T14:28:00.000Z');
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: {},
      completedAt,
      serviceRecordCols: {
        arrived_at: {},
        actual_start_time: {},
        check_in_time: {},
        started_at: {},
        completed_at: {},
      },
    });

    expect(fields).toEqual({
      arrived_at: null,
      actual_start_time: null,
      check_in_time: null,
      started_at: null,
      completed_at: completedAt,
    });
  });

  test('preserves inferred lifecycle start when completion derives it from elapsed time', () => {
    const completedAt = new Date('2026-05-19T14:28:00.000Z');
    const inferredStart = new Date('2026-05-19T13:42:00.000Z');
    const fields = buildServiceRecordCompletionTimingFields({
      scheduledService: {},
      lifecycleUpdates: {
        arrived_at: inferredStart,
        actual_start_time: inferredStart,
        check_in_time: inferredStart,
      },
      completedAt,
      serviceRecordCols: {
        arrived_at: {},
        actual_start_time: {},
        check_in_time: {},
        started_at: {},
        completed_at: {},
        actual_end_time: {},
        check_out_time: {},
      },
    });

    expect(fields).toEqual({
      arrived_at: inferredStart,
      actual_start_time: inferredStart,
      check_in_time: inferredStart,
      started_at: inferredStart,
      completed_at: completedAt,
      actual_end_time: completedAt,
      check_out_time: completedAt,
    });
  });
});
