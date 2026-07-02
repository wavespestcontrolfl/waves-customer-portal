jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

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

describe('track token expiry on reschedule paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    db.transaction = undefined;
  });

  test('SmartRebooker.reschedule refreshes expiry from the new date and window end', async () => {
    const serviceLookup = chain({
      first: jest.fn().mockResolvedValue({
        id: 'svc-1',
        customer_id: 'cust-1',
        scheduled_date: '2026-05-20',
        window_start: '09:00:00',
        window_end: '11:00:00',
        status: 'confirmed',
      }),
    });
    const updateQuery = chain({
      update: jest.fn().mockResolvedValue(1),
    });
    const logInsert = chain();
    // Post-commit best-effort shift of a call-created follow-up child.
    const followupShift = chain({ update: jest.fn().mockResolvedValue(0) });
    const logCount = chain({
      first: jest.fn().mockResolvedValue({ count: '1' }),
    });

    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return updateQuery;
      if (table === 'reschedule_log') return logInsert;
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    db.transaction = jest.fn(async (callback) => callback(trx));
    db.fn = { now: jest.fn(() => 'now()') };

    const dbQueries = [serviceLookup, followupShift, logCount];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'reschedule_log') return dbQueries.shift();
      throw new Error(`Unexpected db table ${table}`);
    });

    await expect(SmartRebooker.reschedule(
      'svc-1',
      '2027-06-03',
      { start: '10:00:00', end: '12:30:00' },
      'weather',
      'admin',
    )).resolves.toEqual({
      success: true,
      originalDate: '2026-05-20',
      newDate: '2027-06-03',
    });

    const payload = updateQuery.update.mock.calls[0][0];
    expect(payload).toMatchObject({
      scheduled_date: '2027-06-03',
      window_start: '10:00:00',
      window_end: '12:30:00',
      status: 'confirmed',
    });
    expect(payload.track_token_expires_at).toMatchObject({
      bindings: ['2027-06-03', '12:30:00'],
    });
    expect(payload.track_token_expires_at.sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(payload.track_token_expires_at.sql).toContain("COALESCE(?::time, TIME '23:59:59')");
  });

  test('SmartRebooker.rescheduleSeries refreshes expiry for each shifted occurrence', async () => {
    const anchor = {
      id: 'svc-parent',
      customer_id: 'cust-1',
      scheduled_date: '2026-05-20',
      window_start: '09:00:00',
      window_end: '11:00:00',
      status: 'confirmed',
      is_recurring: true,
      recurring_pattern: 'weekly',
    };
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });

    const siblingsQuery = chain({
      select: jest.fn().mockResolvedValue([
        {
          id: 'svc-parent',
          status: 'confirmed',
          scheduled_date: '2026-05-20',
          window_start: '09:00:00',
          window_end: '11:00:00',
        },
        {
          id: 'svc-child',
          status: 'confirmed',
          scheduled_date: '2026-05-27',
          window_start: '09:00:00',
          window_end: '11:00:00',
        },
      ]),
    });
    const firstUpdate = chain();
    const secondUpdate = chain();
    const logInsert = chain();

    const scheduledQueries = [siblingsQuery, firstUpdate, secondUpdate];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledQueries.shift();
      if (table === 'reschedule_log') return logInsert;
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'now()') };
    db.transaction = jest.fn(async (callback) => callback(trx));

    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      throw new Error(`Unexpected db table ${table}`);
    });

    const result = await SmartRebooker.rescheduleSeries(
      'svc-parent',
      '2027-06-03',
      { start: '10:00:00', end: '12:30:00' },
      'weather',
      'admin',
    );

    expect(result).toMatchObject({
      success: true,
      occurrencesRescheduled: 2,
      originalDate: '2026-05-20',
      newDate: '2027-06-03',
    });
    expect(firstUpdate.update.mock.calls[0][0].track_token_expires_at).toMatchObject({
      bindings: ['2027-06-03', '12:30:00'],
    });
    expect(secondUpdate.update.mock.calls[0][0].track_token_expires_at).toMatchObject({
      bindings: ['2027-06-10', '12:30:00'],
    });
  });

  test('move_stops_to_day refreshes expiry for each moved service', async () => {
    const servicesQuery = chain({
      select: jest.fn().mockResolvedValue([
        {
          id: 'svc-1',
          first_name: 'Ada',
          last_name: 'Lovelace',
          city: 'Bradenton',
          service_type: 'Pest Control',
          scheduled_date: '2026-05-20',
          window_end: '11:00:00',
          notes: 'Gate code',
        },
      ]),
    });
    const updateQuery = chain();

    const scheduledQueries = [servicesQuery, updateQuery];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return scheduledQueries.shift();
      throw new Error(`Unexpected db table ${table}`);
    });

    await expect(executeScheduleTool('move_stops_to_day', {
      service_ids: ['svc-1'],
      new_date: '2027-06-03',
      reason: 'rain delay',
      confirmed: true,
    })).resolves.toMatchObject({
      success: true,
      moved_count: 1,
      new_date: '2027-06-03',
    });

    const payload = updateQuery.update.mock.calls[0][0];
    expect(payload).toMatchObject({
      scheduled_date: '2027-06-03',
      notes: 'Gate code\nMoved from 2026-05-20: rain delay',
    });
    expect(payload.track_token_expires_at).toMatchObject({
      bindings: ['2027-06-03', '11:00:00'],
    });
    expect(payload.track_token_expires_at.sql).toContain("AT TIME ZONE 'America/New_York'");
  });
});
