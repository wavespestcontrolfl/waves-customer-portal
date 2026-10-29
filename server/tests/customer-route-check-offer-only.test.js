/**
 * GATE_CUSTOMER_ROUTE_CHECK is OFFER-ONLY. Only the list endpoints opt in (an
 * `offer: true` flag on the page builders, a `surface` on the /book funnel);
 * every confirmation, commit, reserve or recheck rebuild omits it, so with the
 * gate 'true' a confirm that rebuilds still accepts the slot it offered.
 *
 * Behavior: the real buildBookingAvailability runs with the gate on and a
 * helper that would drop the 14:00 slot. A rebuild without `offer` keeps
 * 14:00 and never calls the helper; an offer list drops it.
 * Source: every call site of each page builder is classified below, so a new
 * caller has to be added to a list on purpose.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/scheduling/customer-route-check', () => ({
  customerRouteCheckMode: jest.fn(() => 'on'),
  filterOfferedSlots: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const routeCheck = require('../services/scheduling/customer-route-check');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const D = etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), 10));
const CONFIG = { advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00', max_self_books_per_day: 3 };
const slot = (startTime, rank) => ({
  date: D, start_time: startTime, end_time: null, technician: { id: 'tech-1' },
  detour_minutes: 3, stops_that_day: 2, rank, score: 100 - rank, insertion: { after_stop_id: 'stop-1' },
});
const startsOf = (result) => result.days.flatMap((d) => d.slots.map((s) => s.start_time)).sort();

beforeEach(() => {
  jest.clearAllMocks();
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
  listOccupiedWindows.mockResolvedValue([]);
  routeCheck.customerRouteCheckMode.mockReturnValue('on');
  routeCheck.filterOfferedSlots.mockImplementation(async ({ slots }) => ({
    slots: slots.filter((s) => s.start_time !== '14:00'), report: {},
  }));
  findAvailableSlots.mockResolvedValue({ slots: [slot('09:00', 1), slot('14:00', 2)], total_feasible: 2 });
});

describe('gate "true": a confirmation rebuild still accepts what the list offered', () => {
  const SVC = { id: 'svc-1', latitude: '27.4', longitude: '-82.4', estimated_duration_minutes: 60, service_type: 'Pest Control' };
  const CUSTOMER = { latitude: 27.4, longitude: -82.4 };
  const COORDS = { lat: 27.4, lng: -82.4 };
  const range = { rangeFrom: D, rangeTo: D, config: CONFIG };

  const builders = {
    reschedule: (extra) => require('../routes/reschedule-public')._test.buildAvailabilityForService(SVC, { ...range, ...extra }),
    reservice: (extra) => require('../routes/reservice-public')._test.buildAvailabilityForCustomer(CUSTOMER, { ...range, duration: 60, lanes: ['pest'], ...extra }),
    inspection: (extra) => require('../routes/inspection-public')._test.buildAvailabilityForLead(COORDS, { ...range, duration: 60, ...extra }),
  };

  test.each(Object.keys(builders))('%s: no offer flag = unfiltered list and the helper is never called', async (name) => {
    const confirmRebuild = await builders[name]({});
    expect(startsOf(confirmRebuild)).toEqual(['09:00', '14:00']);
    expect(routeCheck.filterOfferedSlots).not.toHaveBeenCalled();
  });

  test.each(Object.keys(builders))('%s: the offer list is filtered and names its surface', async (name) => {
    const offered = await builders[name]({ offer: true });
    expect(startsOf(offered)).toEqual(['09:00']);
    expect(routeCheck.filterOfferedSlots).toHaveBeenCalledTimes(1);
    expect(routeCheck.filterOfferedSlots.mock.calls[0][0].surface).toBe(name);
  });
});

// Every call of a page builder, with the handler it sits in, must match one list.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

function callsOf(source, callee) {
  const calls = [];
  const re = new RegExp(`(?<![\\w.])(?:[\\w.]*\\.)?${callee}\\(`, 'g');
  let match;
  while ((match = re.exec(source))) {
    const before = source.slice(0, match.index);
    if (/function\s+$/.test(before)) continue; // the definition
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    const enclosing = [...before.matchAll(/(?:^router\.(get|post|put)\(\s*'([^']*)'|^(?:async )?function (\w+))/gm)].pop();
    const handler = !enclosing ? 'top' : enclosing[3] ? `fn ${enclosing[3]}` : `${enclosing[1].toUpperCase()} ${enclosing[2]}`;
    calls.push({ line: before.split('\n').length, handler, text: source.slice(open, end + 1) });
  }
  return calls;
}

describe('every call site of a page builder is classified (offer lists opt in, confirmations omit)', () => {
  // [file, builder, handlers that are OFFER lists]. Every other call must omit the flag.
  const SITES = [
    ['../routes/reschedule-public.js', 'buildAvailabilityForService', ['GET /:token', 'POST /:token/find-slots']],
    ['../routes/reservice-public.js', 'buildAvailabilityForCustomer', ['GET /:token', 'POST /:token/find-slots']],
    ['../routes/inspection-public.js', 'buildAvailabilityForLead', ['GET /:token', 'POST /:token/availability', 'POST /:token/find-slots']],
    ['../routes/estimate-assessment-public.js', 'buildAvailabilityForLead', ['GET /:token', 'POST /:token/find-slots']],
    ['../services/commercial-first-visit.js', 'availabilityFor', ['fn firstVisitAvailability']],
  ];

  test.each(SITES)('%s %s', (file, callee, offerHandlers) => {
    const calls = callsOf(read(file), callee);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect({ line: call.line, handler: call.handler, offer: call.text.includes('offer: true') })
        .toEqual({ line: call.line, handler: call.handler, offer: offerHandlers.includes(call.handler) });
    }
    // Each file also has at least one confirmation or recheck call, and it omits the flag.
    expect(calls.some((c) => !offerHandlers.includes(c.handler))).toBe(true);
  });

  test('the commit and recheck callers named in the audit all omit the flag', () => {
    for (const [file, needle] of [
      ['../services/sms-scheduling-act.js', 'buildAvailabilityForService(svc, { rangeFrom: slot.date'],
      ['../services/sms-shadow-drafter.js', 'buildAvailabilityForService(svc, { ...range, config })'],
      ['../routes/reservice-public.js', 'buildAvailabilityForCustomer(customer, { ...bookingRange(config), config, duration, lanes: browseLanes })'],
      ['../routes/inspection-public.js', 'buildAvailabilityForLead(location, { ...range, config, duration: catalog.durationMinutes })'],
      ['../services/commercial-first-visit.js', 'availabilityFor(context, { rangeFrom: date, rangeTo: date, config })'],
    ]) {
      expect(read(file)).toContain(needle);
    }
  });

  test('the move-limit full-range build and the voice recheck omit it', () => {
    const resched = read('../routes/reschedule-public.js');
    expect(resched).toContain('full = await buildAvailabilityForService(svc, { ...range, config });');
    expect(read('../services/voice-agent/relay-booking.js')).not.toContain("surface: 'voice'");
    expect(read('../services/voice-agent/relay-tools.js').match(/surface: 'voice'/g)).toHaveLength(2);
  });

  test('/book: only /availability and /find-slots pass a surface; the capture-intent revalidation and the staff pick do not', () => {
    const source = read('../routes/booking.js');
    const builds = callsOf(source, 'buildFunnelAvailability').filter((c) => c.text.startsWith('({'));
    const surfaced = builds.filter((c) => /surface: 'book'|\.\.\.\(internal \? \{\} : \{ surface: 'book' \}\)/.test(c.text));
    // /availability, /find-slots, availabilityForPin (customer text offers only; internal = staff pick)
    expect(surfaced).toHaveLength(3);
    expect(builds).toHaveLength(4);
    const revalidation = builds.find((c) => !surfaced.includes(c));
    expect(revalidation.text).toContain('rangeFrom: row.slot_date');
    expect(source).toContain('return buildBookingAvailability({ ...args, selfServeNotice: true');
  });

  test('the estimate page: only the available-slots list and find-slots opt in; reserve refresh, one-tap and text rechecks do not', () => {
    const slots = read('../routes/estimate-slots-public.js');
    expect(slots).toContain('getAvailableSlots(estimate.id, { ...opts, offer: true })');
    expect(slots).toContain('serviceCadences: findServiceCadences, offer: true');
    expect(slots).toContain('fresh = await getAvailableSlots(estimate.id, slotOpts);');
    expect(slots).not.toMatch(/slotOpts[^\n]*offer/);
    expect(read('../services/one-tap-purchase.js')).toContain('getAvailableSlots(estimateId, {})');
    const builder = read('../services/estimate-slot-availability.js');
    expect(builder).toContain("if (userOpts.offer !== true) return 'off';");
    // slot-reservation (reserve / commit) never builds a list through the estimate builder
    expect(read('../services/slot-reservation.js')).not.toMatch(/getAvailableSlots\(/);
  });
});
