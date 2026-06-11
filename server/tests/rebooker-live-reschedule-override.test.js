jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { clearTechCurrentJob } = require('../services/tech-status');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

function rawFactory(label) {
  return jest.fn((sql, bindings) => ({ label, sql, bindings }));
}

function liveService(status) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    scheduled_date: '2026-06-10',
    window_start: '09:00:00',
    window_end: '11:00:00',
    status,
  };
}

// Wire db/trx mocks for a full single-job reschedule pass.
function wireRescheduleMocks(service) {
  const serviceLookup = chain({ first: jest.fn().mockResolvedValue(service) });
  const updateQuery = chain({ update: jest.fn().mockResolvedValue(1) });
  const historyInsert = chain();
  const logInsert = chain();
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return updateQuery;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));

  const dbQueries = [serviceLookup, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { updateQuery, historyInsert };
}

describe('live-status reschedule override (allowLive)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    db.transaction = undefined;
  });

  test.each(['en_route', 'on_site'])(
    'without allowLive a %s job still 409s',
    async (status) => {
      const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService(status)) });
      db.mockImplementation(() => serviceLookup);

      await expect(SmartRebooker.reschedule(
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      )).rejects.toMatchObject({
        message: `Cannot reschedule a ${status} job`,
        statusCode: 409,
      });
      expect(db.transaction).toBeUndefined();
    },
  );

  test.each(['en_route', 'on_site'])(
    'with allowLive a %s job reschedules, rewinds the tracker lifecycle, and frees the tech',
    async (status) => {
      const { updateQuery, historyInsert } = wireRescheduleMocks(liveService(status));

      await expect(SmartRebooker.reschedule(
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
        { allowLive: true },
      )).resolves.toEqual({
        success: true,
        originalDate: '2026-06-10',
        newDate: '2026-06-12',
      });

      // Atomic guard widened to include the live statuses.
      expect(updateQuery.whereIn).toHaveBeenCalledWith(
        'status',
        expect.arrayContaining(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']),
      );

      const payload = updateQuery.update.mock.calls[0][0];
      expect(payload).toMatchObject({
        scheduled_date: '2026-06-12',
        status: 'confirmed',
        track_state: 'scheduled',
        en_route_at: null,
        arrived_at: null,
        actual_start_time: null,
        check_in_time: null,
        track_sms_sent_at: null,
      });

      // Live → confirmed is audited.
      expect(historyInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        job_id: 'svc-1',
        from_status: status,
        to_status: 'confirmed',
      }));

      // tech_status pointer released so the tech goes idle.
      expect(clearTechCurrentJob).toHaveBeenCalledWith({
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        status: 'idle',
      });
    },
  );

  test('a non-live reschedule does not touch tracker lifecycle or tech_status', async () => {
    const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));

    await SmartRebooker.reschedule(
      'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
      { allowLive: true },
    );

    const payload = updateQuery.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty('track_state');
    expect(payload).not.toHaveProperty('track_sms_sent_at');
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
  });

  test.each(['completed', 'cancelled', 'skipped'])(
    'allowLive never permits rescheduling a %s job',
    async (status) => {
      const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService(status)) });
      db.mockImplementation(() => serviceLookup);

      await expect(SmartRebooker.reschedule(
        'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
        { allowLive: true },
      )).rejects.toMatchObject({
        message: `Cannot reschedule a ${status} job`,
        statusCode: 409,
      });
    },
  );

  test('rescheduleSeries on a live job 409s with a single-occurrence hint', async () => {
    const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService('on_site')) });
    db.mockImplementation(() => serviceLookup);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', '2026-06-12', { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('reschedule this appointment only'),
    });
  });
});
