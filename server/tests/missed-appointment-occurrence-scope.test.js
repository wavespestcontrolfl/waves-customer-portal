/** onSkip freezes the missed occurrence's own scope (service + catalog id + property) on its reschedule_log row. Synthetic data. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const mockRaiseCard = jest.fn(async () => ({ raised: true }));
jest.mock('../services/not-closed-out', () => ({ raiseCard: (...a) => mockRaiseCard(...a) }));

const MissedAppointment = require('../services/workflows/missed-appointment');

function fakeConn(service) {
  const inserts = [];
  const conn = (table) => {
    const chain = {
      where() { return chain; },
      select() { return chain; },
      first: async () => {
        if (table === 'scheduled_services') return service;
        if (table === 'customers') return { id: 'c1', first_name: 'Sam' };
        return { count: '0' };
      },
      insert: (row) => {
        inserts.push({ table, row });
        const done = Promise.resolve([{ id: 'log-new' }]);
        return { returning: () => done, then: (res, rej) => done.then(res, rej) };
      },
    };
    return chain;
  };
  conn.raw = (sql) => sql;
  return { conn, inserts };
}

test('the log row carries the occurrence scope as it was at the miss', async () => {
  const { conn, inserts } = fakeConn({
    id: 'visit-1', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:30:00',
    service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1',
  });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-1', 'no_show', conn);
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({
    reason_code: 'customer_noshow', original_date: '2026-09-29', original_window: '09:00:00-10:30:00',
    occurrence_service_type: 'Pest Control', occurrence_service_id: 'svc-pest', occurrence_property_id: 'prop-1',
  });
});

test('an unlinked visit stores null scope, never a guess', async () => {
  const { conn, inserts } = fakeConn({ id: 'visit-2', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: null, service_type: null, service_id: null, property_id: null });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-2', 'no_show', conn);
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({ occurrence_service_type: null, occurrence_service_id: null, occurrence_property_id: null });
});

test('a caller snapshot (dispatch no-show) wins over a later edit of the live row (Codex #5669 r1)', async () => {
  const { conn, inserts } = fakeConn({
    id: 'visit-3', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '13:00:00', window_end: '14:00:00',
    service_type: 'Lawn Care', service_id: 'svc-lawn', property_id: 'prop-2', // edited after the no-show was marked
  });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-3', 'manual_no_show', conn, { occurrence: {
    id: 'visit-3', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00',
    service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1',
  } });
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({
    customer_id: 'c1', original_window: '09:00:00-10:00:00',
    occurrence_service_type: 'Pest Control', occurrence_service_id: 'svc-pest', occurrence_property_id: 'prop-1',
  });
});

describe('the office card for a flagged visit (not-closed-out.js)', () => {
  const visit = { id: 'visit-4', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1' };
  beforeEach(() => mockRaiseCard.mockClear());

  test('the nightly check raises an unconfirmed card: it only knows the visit was still open', async () => {
    const { conn, inserts } = fakeConn(visit);
    jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
    await MissedAppointment.onSkip('visit-4', 'no_show', conn);
    expect(inserts.find((i) => i.table === 'reschedule_log').row.miss_confirmed_at).toBeUndefined();
    expect(mockRaiseCard).toHaveBeenCalledWith(expect.objectContaining({ logId: 'log-new', confirmed: false, service: expect.objectContaining({ id: 'visit-4' }) }));
  });

  test('a person marking the no-show in dispatch is a confirmed miss from the start', async () => {
    const { conn, inserts } = fakeConn(visit);
    jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
    await MissedAppointment.onSkip('visit-4', 'manual_no_show', conn);
    expect(inserts.find((i) => i.table === 'reschedule_log').row).toMatchObject({ miss_confirmed_by: 'dispatch' });
    expect(inserts.find((i) => i.table === 'reschedule_log').row.miss_confirmed_at).toBeInstanceOf(Date);
    expect(mockRaiseCard).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
  });
});
