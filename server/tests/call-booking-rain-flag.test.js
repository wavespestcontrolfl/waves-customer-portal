/**
 * Rain flag for phone bookings (owner 2026-10-08, GATE_CALL_BOOKING_RAIN_FLAG,
 * dark). One admin notice when a fresh phone-booked visit is outdoor work in
 * a rain window; nothing for rain-OK work, a dry window, a date past the 3
 * days, a point outside the service area, the gate off, or any failure.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(async ({ service_key_snapshot: key }) => ({ serviceKey: key || null, findingsType: null })),
}));

const { flagCallBookingRain, _test } = require('../services/call-booking-rain-flag');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const D1 = dayOffset(1);
// D1: 14:00-16:00 read 85%, 88%, 70%; every other hour 10%.
const HOURLY = Array.from({ length: 14 }, (_, i) => {
  const h = 7 + i;
  const wet = { 14: 85, 15: 88, 16: 70 }[h];
  return { startTime: `${D1}T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: wet ?? 10 };
});
const visit = (extra = {}) => ({ id: 'visit-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control Service', ...extra });
const pest = { service_key: 'pest_general_quarterly' };

function run(extra = {}, depExtra = {}) {
  const notifyAdmin = jest.fn(async () => {});
  const hourlyRain = jest.fn(async () => HOURLY);
  const customerPoint = jest.fn(async () => ({ lat: 27.4, lng: -82.4 }));
  const result = flagCallBookingRain({
    visit: visit(), scheduledDate: D1, windowStart: '14:00', windowEnd: '15:00', catalogRow: pest, callSid: 'CA-test', db: {},
    deps: { notifyAdmin, hourlyRain, customerPoint, ...depExtra }, ...extra,
  });
  return { result, notifyAdmin, hourlyRain, customerPoint };
}

describe('flagCallBookingRain', () => {
  afterEach(() => { delete process.env.GATE_CALL_BOOKING_RAIN_FLAG; });

  test('gate off: nothing is read and nothing is sent', async () => {
    const { result, notifyAdmin, hourlyRain, customerPoint } = run();
    expect(await result).toEqual({ flagged: false, reason: 'gate_off' });
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(hourlyRain).not.toHaveBeenCalled();
    expect(customerPoint).not.toHaveBeenCalled();
  });

  test('outdoor work in a rain window: one notice on the schedule channel, with the peak chance', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    const { result, notifyAdmin } = run();
    expect(await result).toEqual({ flagged: true, reason: 'wet', peak: 88 });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('schedule');
    expect(title).toBe('Call booking in a rain window');
    expect(body).toBe(`Phone-booked Quarterly Pest Control Service on ${D1} at 14:00 has a 88% chance of rain — review it on the dispatch board.`);
    expect(opts).toMatchObject({ link: '/admin/dispatch', dedupeKey: 'call-booking-rain:visit-1', metadata: { scheduledServiceId: 'visit-1', callSid: 'CA-test', rain_chance_pct: 88 } });
  });

  test('rain within 2 h after the visit counts (drying time)', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    const { result } = run({ windowStart: '12:00', windowEnd: '13:00' });
    expect((await result).flagged).toBe(true);
  });

  test.each([
    ['a dry window', { windowStart: '08:00', windowEnd: '09:00' }, {}, 'not_wet'],
    ['rain-OK work (WDO inspection)', { visit: visit({ service_type: 'WDO Inspection Service' }), catalogRow: { service_key: 'wdo_inspection' } }, {}, 'not_outdoor'],
    ['a date past the 3 days', { scheduledDate: dayOffset(6) }, {}, 'past_horizon'],
    ['no stored point / outside the service area', {}, { customerPoint: async () => null }, 'no_point'],
    ['no forecast', {}, { hourlyRain: async () => null }, 'not_wet'],
    ['no visit id', { visit: visit({ id: null }) }, {}, 'no_window'],
  ])('no notice for %s', async (_label, extra, depExtra, reason) => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    const { result, notifyAdmin } = run(extra, depExtra);
    expect(await result).toEqual({ flagged: false, reason });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('the catalog key decides outdoor vs rain-OK, not the label', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    // Labeled like an inspection, but the catalog row is a spray service.
    const spray = run({ visit: visit({ service_type: 'Home Inspection Visit' }) });
    expect((await spray.result).flagged).toBe(true);
    // Labeled like a treatment, but the catalog row is bed bug (interior).
    const indoor = run({ visit: visit({ service_type: 'Treatment' }), catalogRow: { service_key: 'bed_bug_treatment' } });
    expect((await indoor.result).reason).toBe('not_outdoor');
  });

  test('the pipeline\'s defaults: no window uses 09:00, and the row\'s own fields are a fallback', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    const { result } = run({ visit: visit({ scheduled_date: D1, window_start: '15:00:00', window_end: '16:00:00' }), scheduledDate: undefined, windowStart: undefined, windowEnd: undefined });
    expect(await result).toMatchObject({ flagged: true, peak: 88 });
    const none = run({ windowStart: null, windowEnd: null });
    expect((await none.result).reason).toBe('not_wet'); // 09:00-10:00 (+2 h) is dry
  });

  test('the forecast is read at the booked property, not the customer\'s primary home', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    // The visit carries the property's stamped point: used, the customer row is not read.
    const stamped = run({ visit: visit({ property_id: 'prop-2', lat: 27.05, lng: -82.25 }) });
    await stamped.result;
    expect(stamped.hourlyRain).toHaveBeenCalledWith(27.05, -82.25, true);
    expect(stamped.customerPoint).not.toHaveBeenCalled();
    // A specific property with no stamped point: no trustworthy point, no notice.
    const unknown = run({ visit: visit({ property_id: 'prop-2' }) });
    expect(await unknown.result).toEqual({ flagged: false, reason: 'no_point' });
    expect(unknown.customerPoint).not.toHaveBeenCalled();
    // No property at all (legacy row): the customer's point.
    const legacy = run();
    await legacy.result;
    expect(legacy.customerPoint).toHaveBeenCalled();
    // A stamped point outside the service area reads nothing.
    const far = run({ visit: visit({ property_id: 'prop-3', lat: 47.6, lng: -122.3 }) });
    expect((await far.result).reason).toBe('no_point');
  });

  test('a long visit is checked through its real length, not the one-hour window', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    // 10:00-11:00 window + 2 h tail ends at 13:00: dry. Rain starts at 14:00.
    const oneHour = run({ windowStart: '10:00', windowEnd: '11:00' });
    expect((await oneHour.result).reason).toBe('not_wet');
    // The same window on a 3-hour treatment: work to 13:00, tail to 15:00: wet.
    const long = run({ visit: visit({ estimated_duration_minutes: 180 }), windowStart: '10:00', windowEnd: '11:00' });
    expect(await long.result).toMatchObject({ flagged: true, peak: 85 });
  });

  test('never throws: a failing notify or lookup is "no flag"', async () => {
    process.env.GATE_CALL_BOOKING_RAIN_FLAG = 'true';
    const failed = run({}, { notifyAdmin: async () => { throw new Error('bell down'); } });
    expect(await failed.result).toEqual({ flagged: false, reason: 'error' });
    const lookup = run({}, { customerPoint: async () => { throw new Error('db down'); } });
    expect(await lookup.result).toEqual({ flagged: false, reason: 'error' });
  });

  test('peakChance reads the visit hours plus the drying tail', () => {
    expect(_test.peakChance(HOURLY, { date: D1, start: '12:00', end: '13:00' })).toBe(85);
    expect(_test.peakChance(HOURLY, { date: D1, start: '08:00', end: '09:00' })).toBe(10);
    expect(_test.peakChance([], { date: D1, start: '08:00', end: '09:00' })).toBeNull();
  });
});
