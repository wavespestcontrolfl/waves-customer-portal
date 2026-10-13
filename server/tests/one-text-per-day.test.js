/**
 * The pure rule and the fail-open edges of one-text-per-day.js
 * (GATE_ONE_TEXT_PER_CUSTOMER_DAY). The SQL paths are covered against a real
 * schema in one-text-per-customer-day-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db down'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  sameTextDay, dayOf, closeCoveredReminderTiers, sendTrackTextOnce, earliestArrivalMs, dayArrivalCandidates,
} = require('../services/one-text-per-day');

const base = { customer_id: 'c1', property_id: 'p1', technician_id: 't1', day: '2026-10-14' };

describe('sameTextDay', () => {
  test('same customer, address and ET day', () => {
    expect(sameTextDay(base, { ...base })).toBe(true);
  });

  test('different address is a different text', () => {
    expect(sameTextDay(base, { ...base, property_id: 'p2' })).toBe(false);
  });

  test('different customer is a different text', () => {
    expect(sameTextDay(base, { ...base, customer_id: 'c2' })).toBe(false);
  });

  test('an unknown address never matches, even another unknown one', () => {
    expect(sameTextDay({ ...base, property_id: null }, { ...base, property_id: null })).toBe(false);
    expect(sameTextDay(base, { ...base, property_id: null })).toBe(false);
  });

  test('different day is a different text', () => {
    expect(sameTextDay(base, { ...base, day: '2026-10-15' })).toBe(false);
  });

  test('the ET midnight boundary, not UTC, decides the day', () => {
    // 23:30 ET on 10-14 is 03:30Z on 10-15; 00:30 ET on 10-15 is 04:30Z on 10-15.
    const late = { ...base, day: undefined, appointment_time: new Date('2026-10-15T03:30:00Z') };
    const early = { ...base, day: undefined, appointment_time: new Date('2026-10-15T04:30:00Z') };
    expect(dayOf(late)).toBe('2026-10-14');
    expect(dayOf(early)).toBe('2026-10-15');
    expect(sameTextDay(late, early)).toBe(false);
    // 09:00 ET and 10:00 ET the same day are one text
    const nine = { ...base, day: undefined, appointment_time: new Date('2026-10-14T13:00:00Z') };
    const ten = { ...base, day: undefined, appointment_time: new Date('2026-10-14T14:00:00Z') };
    expect(sameTextDay(nine, ten)).toBe(true);
  });

  test('technician only matters when asked (tracker texts name the technician)', () => {
    const other = { ...base, technician_id: 't2' };
    expect(sameTextDay(base, other)).toBe(true);
    expect(sameTextDay(base, other, { sameTechnician: true })).toBe(false);
    expect(sameTextDay(base, { ...base }, { sameTechnician: true })).toBe(true);
  });

  test('two unassigned visits count as the same technician', () => {
    const none = { ...base, technician_id: null };
    expect(sameTextDay(none, { ...none }, { sameTechnician: true })).toBe(true);
  });
});

const snapshot = [{ scheduled_service_id: 's2', reminder_id: 'r2', appointment_time: new Date('2026-10-14T14:00:00Z'), day: '2026-10-14' }];

describe('fail open and gate off', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY;
  });
  afterEach(() => { delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY; });

  test('gate off: no query, nothing closed, the sender just runs', async () => {
    const send = jest.fn(async () => ({ success: true }));
    expect(await closeCoveredReminderTiers({ scheduled_service_id: 's1', customer_id: 'c1' }, '24h', true, snapshot)).toBe(0);
    expect(await sendTrackTextOnce({ id: 's1', property_id: 'p1' }, 'en_route', send)).toEqual({ success: true });
    expect(await dayArrivalCandidates('s1')).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on, database error: siblings stay armed, the tracker text goes out exactly once', async () => {
    process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true';
    const send = jest.fn(async () => ({ success: true }));
    expect(await closeCoveredReminderTiers({ scheduled_service_id: 's1', customer_id: 'c1' }, '24h', true, snapshot)).toBe(0);
    expect(await sendTrackTextOnce({ id: 's1', property_id: 'p1' }, 'arrived', send)).toEqual({ success: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await dayArrivalCandidates('s1')).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  test('a sender that throws is not run twice', async () => {
    process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true';
    db.mockImplementationOnce(() => ({ where: () => ({ first: async () => ({ id: 's1', customer_id: 'c1', property_id: 'p1', day: '2026-10-14' }) }) }));
    db.transaction = jest.fn(async (fn) => fn(Object.assign(() => { throw new Error('unused'); }, { raw: async () => {} })));
    const send = jest.fn(async () => { throw new Error('twilio down'); });
    await expect(sendTrackTextOnce({ id: 's1', property_id: 'p1' }, 'en_route', send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a delivery that did not happen, no snapshot, or a visit with no saved address closes or covers nothing', async () => {
    process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true';
    expect(await closeCoveredReminderTiers({ scheduled_service_id: 's1', customer_id: 'c1' }, '24h', false, snapshot)).toBe(0);
    expect(await closeCoveredReminderTiers({ scheduled_service_id: 's1', customer_id: 'c1' }, '24h', true, null)).toBe(0);
    const send = jest.fn(async () => ({ success: true }));
    await sendTrackTextOnce({ id: 's1', property_id: null }, 'en_route', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('earliestArrivalMs', () => {
  test('the earliest quoted arrival of the day; a pre-closed placeholder never counts', () => {
    const rows = [
      { appointment_time: new Date('2026-10-14T14:00:00Z') },
      { day: '2026-10-14', window_start: '09:00:00' },
      { appointment_time: new Date('2026-10-14T12:00:00Z'), windows_preclosed: true },
    ];
    expect(earliestArrivalMs(rows)).toBe(new Date('2026-10-14T13:00:00Z').getTime());
    expect(earliestArrivalMs([])).toBeNull();
  });
});

describe('gate reader', () => {
  const { oneTextPerCustomerDayLive } = require('../config/feature-gates');
  afterEach(() => { delete process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY; });

  test('on only for exactly "true", read at call time', () => {
    expect(oneTextPerCustomerDayLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', '']) {
      process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = v;
      expect(oneTextPerCustomerDayLive()).toBe(false);
    }
    process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY = 'true';
    expect(oneTextPerCustomerDayLive()).toBe(true);
  });
});
