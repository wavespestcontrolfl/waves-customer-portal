/**
 * GATE_MULTI_TECH_TEXT_TIMES, text drafter half (multi-technician booking PR 4,
 * owner "go PR 4" 2026-10-06). The drafter's CITY-based OPEN TIMES fallback (used
 * when GATE_SMS_OFFERS_SCHEDULER has no picker for the text) and its send-time
 * recheck ask the website booking engine through text-offer-times.js instead of
 * the old by-city zone finder. Gate off = the old finder, unchanged.
 *
 * No DB, no network: both engines are mocked. Synthetic ids only.
 */
const REAL_ANSWERS = 'GATE_SMS_REAL_ANSWERS';
const SCHEDULER = 'GATE_SMS_OFFERS_SCHEDULER';
const TEXT_TIMES = 'GATE_MULTI_TECH_TEXT_TIMES';
const ALL = [REAL_ANSWERS, SCHEDULER, TEXT_TIMES];
const prior = Object.fromEntries(ALL.map((g) => [g, process.env[g]]));

// The website engine lists every feasible start, often 15 minutes apart.
const BOOK_DAYS = [
  { date: '2026-10-08', fullDate: 'Thursday, October 8', slots: [{ startTime24: '09:00' }, { startTime24: '09:15' }, { startTime24: '09:30' }, { startTime24: '11:00' }, { startTime24: '13:00' }, { startTime24: '15:00' }] },
  { date: '2026-10-09', fullDate: 'Friday, October 9', slots: [{ startTime24: '08:00' }] },
  { date: '2026-10-10', fullDate: 'Saturday, October 10', slots: [] },
  { date: '2026-10-12', fullDate: 'Monday, October 12', slots: [{ startTime24: '10:00' }] },
  { date: '2026-10-13', fullDate: 'Tuesday, October 13', slots: [{ startTime24: '10:00' }] },
];
const OLD_DAYS = [{ date: '2026-10-07', fullDate: 'Wednesday, October 7', slots: [{ startTime24: '09:00' }, { startTime24: '10:00' }, { startTime24: '11:00' }, { startTime24: '14:00' }] }];

let oldFinder;
let textOfferDays;
let drafter;

function load() {
  jest.resetModules();
  oldFinder = jest.fn().mockResolvedValue({ zone: 'Old Zone', days: OLD_DAYS });
  textOfferDays = jest.fn().mockResolvedValue({ days: BOOK_DAYS, pinSource: 'city_table' });
  jest.doMock('../services/availability', () => ({ getAvailableSlots: oldFinder }));
  jest.doMock('../services/scheduling/text-offer-times', () => ({ textOfferDays }));
  // No catalog rows: a name the explicit funnel table does not know stays unmapped.
  jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
  drafter = require('../services/sms-shadow-drafter');
}

beforeEach(() => {
  ALL.forEach((g) => delete process.env[g]);
  process.env[REAL_ANSWERS] = 'true';
  load();
});
afterEach(() => {
  jest.dontMock('../services/availability');
  jest.dontMock('../services/scheduling/text-offer-times');
  jest.dontMock('../services/call-booking-catalog');
  jest.resetModules();
});
afterAll(() => ALL.forEach((g) => { if (prior[g] === undefined) delete process.env[g]; else process.env[g] = prior[g]; }));

describe('fetchOpenTimesData — city fallback', () => {
  test('gate off: the old finder answers, the website engine is never asked', async () => {
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-1' });
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(out.days).toEqual([{ date: 'Wednesday, October 7', windows: expect.any(Array) }]);
  });

  test('gate on: the website engine answers from the customer\'s pin or the city centre; the old finder is never called', async () => {
    process.env[TEXT_TIMES] = 'true';
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(textOfferDays).toHaveBeenCalledWith({ city: 'Venice', customerId: 'cust-1', estimateId: null, serviceKey: 'pest_control' });
    expect(out.block).toContain('Thursday, October 8');
  });

  test('gate on: quotes non-overlapping 2-hour windows (not 9:00, 9:15 and 9:30), at most three a day, three days', async () => {
    process.env[TEXT_TIMES] = 'true';
    const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
    const w = (hhmm) => formatSmsTimeRange(arrivalWindowRange(hhmm));
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-1', schedulingIntent: true });
    expect(out.days).toEqual([
      { date: 'Thursday, October 8', windows: [w('09:00'), w('11:00'), w('13:00')] },
      { date: 'Friday, October 9', windows: [w('08:00')] },
      { date: 'Monday, October 12', windows: [w('10:00')] },
    ]);
    // Saturday had no starts; the fourth day is past the three-day cap.
    expect(out.block.split('\n')).toHaveLength(3);
  });

  test('gate on: a named service the website funnel books is passed on; one it does not book gets no times', async () => {
    process.env[TEXT_TIMES] = 'true';
    await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, serviceType: 'Lawn Care' });
    expect(textOfferDays).toHaveBeenLastCalledWith(expect.objectContaining({ serviceKey: 'lawn_care' }));
    textOfferDays.mockClear();
    const out = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, serviceType: 'Actual Bait Station Visit' });
    expect(out).toEqual({ block: null, days: [] });
    expect(textOfferDays).not.toHaveBeenCalled();
  });

  test('gate on: the engine offering nothing, or throwing, leaves OPEN TIMES out and never throws', async () => {
    process.env[TEXT_TIMES] = 'true';
    textOfferDays.mockResolvedValueOnce(null);
    await expect(drafter.fetchOpenTimesData({ city: 'Tampa', customerId: 'c1', schedulingIntent: true })).resolves.toEqual({ block: null, days: [] });
    textOfferDays.mockRejectedValueOnce(new Error('engine down'));
    await expect(drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true })).resolves.toEqual({ block: null, days: [] });
  });

  test('no scheduling intent or no city: nothing asked on either engine (unchanged)', async () => {
    process.env[TEXT_TIMES] = 'true';
    await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: false });
    await drafter.fetchOpenTimesData({ city: '', customerId: 'c1', schedulingIntent: true });
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });
});

describe('openTimesStillOffered — send-time recheck', () => {
  const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
  const w = (hhmm) => formatSmsTimeRange(arrivalWindowRange(hhmm));

  test('gate on: a quoted window the website engine still offers is fine; one it dropped is gone', async () => {
    process.env[TEXT_TIMES] = 'true';
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'c1', quotedWindows: [{ date: 'Thursday, October 8', window: w('11:00') }],
    })).resolves.toEqual({ ok: true });
    expect(oldFinder).not.toHaveBeenCalled();
    const gone = { date: 'Thursday, October 8', window: w('16:00') };
    await expect(drafter.openTimesStillOffered({ city: 'Venice', customerId: 'c1', quotedWindows: [gone] }))
      .resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: [gone] });
  });

  test('gate on: an engine failure fails CLOSED', async () => {
    process.env[TEXT_TIMES] = 'true';
    textOfferDays.mockRejectedValue(new Error('engine down'));
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'c1', quotedWindows: [{ date: 'Thursday, October 8', window: w('09:00') }],
    })).resolves.toMatchObject({ ok: false, reason: 'open_times_recheck_failed' });
  });

  test('gate off: the old finder is rechecked, as before', async () => {
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'c1', quotedWindows: [{ date: 'Wednesday, October 7', window: w('09:00') }],
    })).resolves.toEqual({ ok: true });
    expect(oldFinder).toHaveBeenCalled();
    expect(textOfferDays).not.toHaveBeenCalled();
  });
});
