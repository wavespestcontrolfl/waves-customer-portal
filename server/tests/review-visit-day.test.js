// The day a drafted review text speaks about (owner 2026-10-27, "FIX"): the day the
// technician was at the visit, not the close day a late completion stamps on the record.
jest.mock('../models/db', () => jest.fn());
const { draftServiceDate, draftVisitDate, visitWorkedOn } = require('../services/review-visit-day');
const { etCalendarDayOf } = require('../utils/datetime-et');

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const dayString = (n) => etCalendarDayOf(daysAgo(n));

// A two-table fake: where({ id }).first(...) returns the row with that id.
function fakeDb(tables, { throwOn = null } = {}) {
  return jest.fn((table) => ({
    where: ({ id }) => ({
      first: async () => {
        if (throwOn === table) throw new Error('pg blip');
        return (tables[table] || []).find((row) => row.id === id) || null;
      },
    }),
  }));
}

describe('visitWorkedOn: the service report\'s staleness rule', () => {
  test('a kept arrival stamp is the day worked', () => {
    const arrived = daysAgo(5);
    expect(visitWorkedOn({ arrivedAt: arrived, scheduledDate: dayString(5), completedAt: new Date() })).toBe(arrived.toISOString());
  });

  test('an arrival before the scheduled day is an earlier, aborted attempt: the scheduled day wins', () => {
    expect(visitWorkedOn({ arrivedAt: daysAgo(3), scheduledDate: dayString(0), completedAt: new Date() })).toBe(dayString(0));
  });

  test('no arrival: the scheduled day, when the close is on or after it', () => {
    expect(visitWorkedOn({ scheduledDate: dayString(4), completedAt: new Date() })).toBe(dayString(4));
  });

  test('an early close of a future visit has no scheduled day: its arrival, else nothing', () => {
    const arrived = new Date();
    expect(visitWorkedOn({ arrivedAt: arrived, scheduledDate: etCalendarDayOf(new Date(Date.now() + 3 * DAY)), completedAt: new Date() })).toBe(arrived.toISOString());
    expect(visitWorkedOn({ scheduledDate: etCalendarDayOf(new Date(Date.now() + 3 * DAY)), completedAt: new Date() })).toBeNull();
  });

  test('nothing known: null', () => {
    expect(visitWorkedOn({})).toBeNull();
  });
});

describe('draftVisitDate: the earlier ET day wins', () => {
  test('a visit worked on an earlier day than the record\'s date', () => {
    const record = new Date();
    const worked = daysAgo(22).toISOString();
    expect(draftVisitDate(record, worked)).toBe(worked);
    expect(draftVisitDate(record, dayString(3))).toBe(dayString(3));
  });

  test('the same day (or a later one) keeps the record\'s date', () => {
    const record = new Date();
    expect(draftVisitDate(record, record.toISOString())).toBe(record);
    expect(draftVisitDate(daysAgo(2), dayString(0))).toEqual(expect.any(Date));
  });

  test('either alone when the other is missing', () => {
    const record = new Date();
    expect(draftVisitDate(record, null)).toBe(record);
    expect(draftVisitDate(null, dayString(1))).toBe(dayString(1));
    expect(draftVisitDate(null, null)).toBeNull();
  });
});

describe('draftServiceDate: record first, then the cadence\'s visit', () => {
  test('a late close: the record\'s visit arrival', async () => {
    const arrived = daysAgo(10);
    const database = fakeDb({
      service_records: [{ id: 'sr-1', scheduled_service_id: 'ss-1', created_at: new Date() }],
      scheduled_services: [{ id: 'ss-1', arrived_at: arrived, scheduled_date: dayString(10), completed_at: new Date() }],
    });
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-1', scheduledServiceId: 'ss-other' }, database)).toBe(arrived.toISOString());
  });

  test('a record with no visit link falls back to the cadence\'s visit', async () => {
    const database = fakeDb({
      service_records: [{ id: 'sr-2', scheduled_service_id: null, created_at: new Date() }],
      scheduled_services: [{ id: 'ss-2', arrived_at: null, scheduled_date: dayString(6), completed_at: new Date() }],
    });
    expect(await draftServiceDate({ recordDate: new Date(), serviceRecordId: 'sr-2', scheduledServiceId: 'ss-2' }, database)).toBe(dayString(6));
  });

  test('a same-day close keeps the record\'s date', async () => {
    const database = fakeDb({
      service_records: [{ id: 'sr-3', scheduled_service_id: 'ss-3', created_at: new Date() }],
      scheduled_services: [{ id: 'ss-3', arrived_at: new Date(), scheduled_date: dayString(0), completed_at: new Date() }],
    });
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-3' }, database)).toBe(recordDate);
  });

  test('no visit, a missing visit row or a failed read keeps the record\'s date', async () => {
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate }, fakeDb({}))).toBe(recordDate);
    expect(await draftServiceDate({ recordDate, scheduledServiceId: 'ss-gone' }, fakeDb({ scheduled_services: [] }))).toBe(recordDate);
    const failing = fakeDb({ service_records: [{ id: 'sr-4', scheduled_service_id: 'ss-4' }] }, { throwOn: 'scheduled_services' });
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-4' }, failing)).toBe(recordDate);
  });
});
