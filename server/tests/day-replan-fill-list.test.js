/**
 * The 07:05 notice's fill list (services/day-replan/fill-list.js, owner 2026-11-20 *b*, then *1a 2a*): the open
 * estimates, the leads that asked for a look and the booked plan visits that could move up, whose visit fits a listed
 * block, by the schedule gap tool's own check (the real analyzeGapCandidate and arrival search). Each block lists each
 * kind's best fit, then the next best, least added drive first. The reads are faked; synthetic ids and names only.
 */
// The module database: the fill list is built on it only. Each test's fake knex answers through it (fakeConn).
jest.mock('../models/db', () => {
  const db = (...args) => db.current(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => {
  const actual = jest.requireActual('../services/estimate-slot-availability');
  return {
    resolveEstimateCoords: jest.fn(), resolveCatalogSlotProfile: jest.fn(), appointmentServicesFor: jest.fn((profile) => profile.services),
    estimateMoveInDate: jest.fn(async () => null),
    // The booking page's own season rule and its name for a set of services.
    seasonalSelectionProfile: actual.seasonalSelectionProfile, inMosquitoSeason: actual.inMosquitoSeason,
    formatServiceProfileLabel: actual.formatServiceProfileLabel,
  };
});
jest.mock('../services/auto-dispatch/preferences', () => {
  const actual = jest.requireActual('../services/auto-dispatch/preferences');
  return { ...actual, getCustomerSchedulingPreferences: jest.fn(async (_id, type) => ({ ...actual.normalizePreferences(null, type), service_category: 'pest_control' })) };
});
jest.mock('../services/scheduling/day-stops', () => ({ ...jest.requireActual('../services/scheduling/day-stops'), dayStopsQuery: jest.fn() }));
jest.mock('../services/scheduling/day-quality', () => ({ QUALITY_EXCLUDED_STATUSES: ['cancelled', 'completed'], dayStopSelect: () => ['stop columns'] }));
jest.mock('../services/scheduling/tech-start-point', () => ({
  ...jest.requireActual('../services/scheduling/tech-start-point'), loadTechStartPoints: jest.fn(async () => new Map()),
}));
jest.mock('../services/scheduling/departure-time', () => ({ dayDepartureMinutes: jest.fn(async () => 480) }));
jest.mock('../services/day-replan/route-check', () => ({ DISPATCH_DAY_END: 18 * 60 }));
// The estimate page's own answer (estimate-slots-public.js): whether it offers times, and its slot picker.
const PICKER = { serviceMode: 'recurring', selection: {} };
jest.mock('../routes/estimate-slots-public', () => ({
  _internals: { slotBrowseRefusal: jest.fn(async () => null), pageSlotPicker: jest.fn(async () => ({ serviceMode: 'recurring', selection: {} })) },
}));
// The real check, watched: the list must yield to the event loop between checks. A plan visit's own read is the gap
// tool's (loadGapCandidate, its suite): here each test says what it loads.
jest.mock('../services/scheduling/gap-candidates', () => {
  const actual = jest.requireActual('../services/scheduling/gap-candidates');
  return { ...actual, analyzeGapCandidate: jest.fn(actual.analyzeGapCandidate), loadGapCandidate: jest.fn() };
});
// The Leads screen's service list (its Schedule button), and the 24-hour reminder lock (owner 2026-11-07).
jest.mock('../services/service-library', () => ({ getServices: jest.fn() }));
jest.mock('../services/auto-dispatch/reminder-off', () => ({ loadReminderOffIds: jest.fn(async () => new Set()) }));

const logger = require('../services/logger');
const page = require('../routes/estimate-slots-public')._internals;
const slots = require('../services/estimate-slot-availability');
const { getCustomerSchedulingPreferences, normalizePreferences } = require('../services/auto-dispatch/preferences');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { loadTechStartPoints } = require('../services/scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../services/scheduling/departure-time');
const { HQ } = require('../services/route-optimizer');
const { analyzeGapCandidate, loadGapCandidate } = require('../services/scheduling/gap-candidates');
const { getServices } = require('../services/service-library');
const { bookedVisitOrLiveHold } = require('../services/scheduling/reservation-occupancy');
const { loadReminderOffIds } = require('../services/auto-dispatch/reminder-off');
const { fillList, MAX_PER_BLOCK, MOVE_UP_DAYS, _internals } = require('../services/day-replan/fill-list');

const NOW = new Date('2040-09-09T12:00:00Z');
const DAY = '2040-09-10';
const TECH = '00000000-0000-4000-8000-000000000001';
const PROFILE = { durationMinutes: 60, serviceLabel: 'Pest Control', services: [{ service: 'pest_control', label: 'Pest Control' }] };

const stop = (id, start, extra = {}) => ({ id, technician_id: TECH, status: 'confirmed', window_start: start,
  estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng, ...extra });
const estimate = (id, extra = {}) => ({ id, customer_id: `c-${id}`, customer_name: `Pat ${id}`, status: 'sent', ...extra });
// The Leads screen's service list: the look visits, and a plan service.
const CATALOG = [
  { id: 'svc-assess', service_key: 'lawn_inspection', name: 'Waves Assessment', category: 'inspection', default_duration_minutes: 30 },
  { id: 'svc-wdo', service_key: 'wdo_inspection', name: 'WDO Inspection Service', category: 'inspection', default_duration_minutes: 60 },
  { id: 'svc-rodent', service_key: 'rodent_inspection', name: 'Rodent Inspection Service', category: 'inspection', default_duration_minutes: 60 },
  { id: 'svc-pest', service_key: 'pest_control', name: 'Pest Control Service', category: 'pest_control', default_duration_minutes: 60 },
];
// A lead row as the fill list reads it, with its customer's stored location.
const lead = (id, extra = {}) => ({ id, customer_id: `c-${id}`, first_name: 'Dana', last_name: id, email: null, phone: null,
  service_interest: 'Waves Assessment + Lawn Care Service', created_at: new Date('2040-09-05T15:00:00Z'),
  latitude: HQ.lat + 0.01, longitude: HQ.lng, ...extra });
// A booked plan visit as the fill list reads it, and the gap tool's load of it (loadGapCandidate).
const planVisit = (id, day, extra = {}) => ({ id, customer_id: `c-${id}`, property_id: null, scheduled_date: day, window_start: '14:00:00',
  recurring_dispatch_due_date: null, service_type: 'Quarterly Pest Control Service', first_name: 'Sam', last_name: id, email: null, phone: null, ...extra });
const loaded = (row, extra = {}) => ({
  service: { id: row.id, customer_id: row.customer_id, status: 'confirmed', technician_id: TECH, scheduled_date: row.scheduled_date,
    window_start: '14:00', window_end: '15:00', estimated_duration_minutes: 60, service_type: row.service_type, is_recurring: true,
    recurring_parent_id: 'series-root', lat: HQ.lat + 0.01, lng: HQ.lng, ...extra },
  preferences: { ...normalizePreferences(null, row.service_type), service_category: 'pest_control' }, holds: [], siblingDates: [], deactivated: [],
  families: ['pest_control'],
});
const ZERO_LEADS = { checked: 0, fitted: 0, noLocation: 0, unread: 0 };
// The scheduler's own rule for a booked visit or live hold (reservation-occupancy.js), as the fake records it.
const BOOKED_OR_LIVE_HOLD = (() => {
  const recorded = [];
  const q = new Proxy({}, { get: (_target, m) => (...args) => { recorded.push(['scheduled_services', m, args]); return q; } });
  bookedVisitOrLiveHold(q);
  return recorded;
})();
const ZERO_VISITS = { checked: 0, fitted: 0, remindersOff: 0, sharedDay: 0, unread: 0 };

// A fake knex: each table's chain records its calls; a where(fn) runs fn on a recorder of its own. `inactive` maps a
// capability category to the technicians set to off for it; `scheduleBlocks` are the tech_schedule_blocks rows; `leads`
// are the lead rows, `leadEstimates` and `customerVisits` their customers' estimates and visits; `plan` are the booked
// plan visits, and `sameDay` the visits of their customers in the range (each plan visit alone on its day by default);
// `addOns` are the plan visits' add-on services (scheduled_service_addons), and `planHolds` the plan_holds rows (read by
// customer and family).
function fakeConn({ estimates = [], taken = [], inactive = {}, scheduleBlocks = [], leads = [], leadEstimates = [], customerVisits = [],
  plan = [], sameDay = null, addOns = [], planHolds = [] } = {}) {
  const calls = [];
  // The plan visits' own read (the one joined to customers), apart: other reads use some of the same clauses.
  const planCalls = [];
  const conn = (table) => {
    const q = { categories: [], families: [], match: {}, joined: false };
    const record = (m, args) => {
      calls.push([table, m, args]);
      if (q.joined) planCalls.push([table, m, args]);
    };
    for (const m of ['whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'whereBetween', 'orWhere', 'orWhereNotIn', 'orWhereRaw', 'orderBy', 'limit']) {
      q[m] = (...args) => {
        record(m, args);
        if (m === 'whereIn' && args[0] === 'service_category') q.categories = args[1];
        if (m === 'whereIn' && args[0] === 'family_key') q.families = args[1];
        return q;
      };
    }
    q.join = (...args) => {
      q.joined = true;
      record('join', args);
      return q;
    };
    q.where = (...args) => {
      if (typeof args[0] === 'function') args[0](q);
      else record('where', args);
      if (args[0] && typeof args[0] === 'object') Object.assign(q.match, args[0]);
      return q;
    };
    q.select = async (first) => {
      if (table === 'estimates') return first === '*' ? estimates : leadEstimates;
      if (table === 'leads') {
        if (leads instanceof Error) throw leads;
        return leads;
      }
      if (table === 'tech_schedule_blocks') return scheduleBlocks;
      if (table === 'scheduled_service_addons') return addOns;
      if (table === 'plan_holds') {
        return planHolds.filter((h) => h.customer_id === q.match.customer_id && q.match.status === 'active' && q.families.includes(h.family_key));
      }
      if (table === 'scheduled_services') {
        if (q.joined) return plan;
        if (first === 'id') return sameDay || plan.map((row) => ({ id: row.id, customer_id: row.customer_id, scheduled_date: row.scheduled_date }));
        return customerVisits;
      }
      return [];
    };
    q.pluck = async () => (table === 'scheduled_services' ? taken : q.categories.flatMap((category) => inactive[category] || []));
    return q;
  };
  const db = require('../models/db');
  db.current = conn;
  return { conn: db, calls, planCalls };
}

// Every listed day's stops (the gap tool's read): by date, numbered in route order as dispatch saves them.
function dayStops(byDay) {
  dayStopsQuery.mockImplementation((_conn, { dateStr }) => ({
    whereRaw: async () => (byDay[dateStr] || []).map((row, i) => ({ route_order: i + 1, ...row })),
  }));
}

// Each estimate's stored location (absent: none can stand in; an Error: the read failed).
function locations(byId) {
  slots.resolveEstimateCoords.mockImplementation(async (row) => {
    if (byId[row.id] instanceof Error) throw byId[row.id];
    if (!byId[row.id]) throw Object.assign(new Error('estimate coordinates need a geocode'), { code: 'COORDS_NEED_GEOCODE' });
    return byId[row.id];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
  getServices.mockResolvedValue({ services: CATALOG });
  loadReminderOffIds.mockResolvedValue(new Set());
  loadGapCandidate.mockReset();
});

describe('open estimates', () => {
  test('sent or viewed, live and with a customer; internal test contacts and estimates a visit or live hold came from are left out', async () => {
    const { conn, calls } = fakeConn({
      estimates: [estimate('e1'), estimate('e2', { customer_name: 'Shakedown Test' }), estimate('e3'),
        estimate('e4', { customer_id: '3274944a-f509-413c-9dee-a8b0cdb16493' })],
      taken: ['e3'],
    });
    expect((await _internals.openEstimates(conn, NOW)).estimates.map((e) => e.estimate.id)).toEqual(['e1']);
    expect(calls).toEqual(expect.arrayContaining([
      ['estimates', 'whereIn', ['status', ['sent', 'viewed']]], ['estimates', 'whereNull', ['archived_at']],
      ['estimates', 'whereNotNull', ['customer_id']], ['estimates', 'whereNull', ['expires_at']], ['estimates', 'orWhere', ['expires_at', '>', NOW]],
      ['estimates', 'orderBy', ['created_at', 'desc']],
      ['scheduled_services', 'whereIn', ['source_estimate_id', ['e1', 'e3']]], ['scheduled_services', 'whereNot', ['status', 'cancelled']],
      ['scheduled_services', 'whereNull', ['reservation_expires_at']], ['scheduled_services', 'orWhere', ['reservation_expires_at', '>', NOW]],
    ]));
  });

  test('the cap counts open estimates only: newer test contacts and taken estimates never take a place', async () => {
    const tests = Array.from({ length: 45 }, (_, i) => estimate(`t${i}`, { customer_name: 'Shakedown Test' }));
    const older = Array.from({ length: 45 }, (_, i) => estimate(`o${i}`));
    const { conn, calls } = fakeConn({ estimates: [...tests, ...older], taken: ['o0'] });
    const { estimates: open } = await _internals.openEstimates(conn, NOW);
    expect(open).toHaveLength(_internals.MAX_ESTIMATES);
    expect(open[0].estimate.id).toBe('o1');
    expect(calls.some(([table, m]) => table === 'estimates' && m === 'limit')).toBe(false);
    // The page's lookup runs for the estimates it keeps, and stops at the cap.
    expect(page.pageSlotPicker).toHaveBeenCalledTimes(_internals.MAX_ESTIMATES);
  });

  test('an estimate whose page offers no times, or shows no slot picker, is left out; the rest carry the page\'s picker', async () => {
    // A guarantee-only renewal: the page answers with no times. An appointment already scheduled: no picker.
    page.slotBrowseRefusal.mockImplementation(async (row) => (row.id === 'renewal' ? { status: 200, body: { invoiceOnlyAcceptance: true } } : null));
    page.pageSlotPicker.mockImplementation(async (id) => (id === 'booked' ? null : { serviceMode: 'one_time', selection: {} }));
    try {
      const { conn } = fakeConn({ estimates: [estimate('renewal'), estimate('booked'), estimate('open')] });
      page.pageSlotPicker.mockClear();
      const result = await _internals.openEstimates(conn, NOW);
      expect(result).toEqual({
        estimates: [{ estimate: expect.objectContaining({ id: 'open' }), picker: { serviceMode: 'one_time', selection: {} } }], unread: 0 });
      // The page's two checks, in its order: a refused estimate never reaches the picker.
      expect(page.slotBrowseRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: 'open' }));
      expect(page.pageSlotPicker.mock.calls.map(([id]) => id)).toEqual(['booked', 'open']);
      // One revision: the picker reads the row the refusal read and the visit is sized from, never its own.
      expect(page.pageSlotPicker.mock.calls[1][1].row).toBe(result.estimates[0].estimate);
    } finally {
      page.slotBrowseRefusal.mockImplementation(async () => null);
      page.pageSlotPicker.mockImplementation(async () => PICKER);
    }
  });

  test('an estimate whose page lookup fails is left off, counted as unread and logged; the rest are still checked', async () => {
    page.slotBrowseRefusal.mockImplementation(async (row) => {
      if (row.id === 'refusal-down') throw new Error('park lookup failed');
      return null;
    });
    page.pageSlotPicker.mockImplementation(async (id) => {
      if (id === 'down') throw new Error('lookup timeout');
      return PICKER;
    });
    try {
      const { conn } = fakeConn({ estimates: [estimate('down'), estimate('refusal-down'), estimate('ok')] });
      expect(await _internals.openEstimates(conn, NOW)).toEqual({ estimates: [{ estimate: expect.objectContaining({ id: 'ok' }), picker: PICKER }], unread: 2 });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate down unread (lookup timeout)'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate refusal-down unread (park lookup failed)'));
      // The notice's count: the estimates were checked, and could not be read.
      expect(await fillList(conn, [], NOW)).toEqual({ checked: 3, fitted: 0, noLocation: 0, unread: 2, leads: ZERO_LEADS, visits: ZERO_VISITS, byBlock: [] });
    } finally {
      page.slotBrowseRefusal.mockImplementation(async () => null);
      page.pageSlotPicker.mockImplementation(async () => PICKER);
    }
  });

  test('none open: the visits are not read, and with no block nothing else is read', async () => {
    const { conn, calls } = fakeConn();
    expect(await _internals.openEstimates(conn, NOW)).toEqual({ estimates: [], unread: 0 });
    expect(calls.some(([table]) => table === 'scheduled_services')).toBe(false);
    const open = fakeConn({ estimates: [estimate('e1')] });
    expect(await fillList(open.conn, [], NOW)).toEqual({ checked: 1, fitted: 0, noLocation: 0, unread: 0, leads: ZERO_LEADS, visits: ZERO_VISITS, byBlock: [] });
    expect(slots.resolveEstimateCoords).not.toHaveBeenCalled();
    expect(dayStopsQuery).not.toHaveBeenCalled();
    // With no block, no lead and no plan visit is read either.
    expect(open.calls.some(([table]) => table === 'leads')).toBe(false);
    expect(open.calls.some(([table, m]) => table === 'scheduled_services' && m === 'join')).toBe(false);
  });
});

describe('leads that asked for a look (owner *1a*)', () => {
  test('the visit is the look the lead asked for: a Waves Assessment, or an inspection on the Leads screen\'s list', () => {
    const id = (ask, catalog = CATALOG) => (_internals.leadVisit(ask, catalog) || {}).id || null;
    expect(id('Waves Assessment')).toBe('svc-assess');
    expect(id('waves assessment + Lawn Care Service')).toBe('svc-assess');
    // A bare "Inspection" is the assessment, as the Leads screen names it.
    expect(id('Inspection')).toBe('svc-assess');
    // An inspection, named with or without its " Service" ending; the first part that names a look wins.
    expect(id('WDO Inspection')).toBe('svc-wdo');
    expect(id('Lawn Care Service + Rodent Inspection Service + WDO Inspection')).toBe('svc-rodent');
    // Any other ask needs a price first: a plan service, a one-time job, a treatment, or no ask.
    for (const ask of ['Pest Control Service', 'One-Time Pest Control', 'Termite Treatment', '', null]) expect(id(ask)).toBeNull();
    // Only what the Schedule button offers: an inspection off the list is not booked from here.
    expect(id('WDO Inspection', CATALOG.filter((row) => row.id !== 'svc-wdo'))).toBeNull();
    // No assessment on the list: the next part of the ask is still read.
    expect(id('Waves Assessment + WDO Inspection', CATALOG.filter((row) => row.id !== 'svc-assess'))).toBe('svc-wdo');
    expect(id('Inspection', CATALOG.filter((row) => row.id !== 'svc-assess'))).toBeNull();
  });

  test('open leads from the last 30 days, live and not commercial, with no estimate on the lead; the Schedule button\'s list', async () => {
    const { conn, calls } = fakeConn({ leads: [lead('l1')] });
    expect((await _internals.openLeads(conn, NOW)).leads).toEqual([{ lead: expect.objectContaining({ id: 'l1' }), visit: CATALOG[0] }]);
    expect(calls).toEqual(expect.arrayContaining([
      ['leads', 'join', ['customers', 'customers.id', 'leads.customer_id']],
      ['leads', 'whereNull', ['leads.deleted_at']], ['leads', 'whereNull', ['customers.deleted_at']],
      ['leads', 'whereIn', ['leads.status', ['new', 'contacted']]],
      ['leads', 'where', ['leads.created_at', '>=', new Date('2040-08-10T12:00:00Z')]],
      ['leads', 'whereNull', ['leads.estimate_id']], ['leads', 'whereNull', ['leads.is_commercial']], ['leads', 'orWhere', ['leads.is_commercial', false]],
      ['leads', 'orderBy', ['leads.created_at', 'desc']],
    ]));
    expect(getServices).toHaveBeenCalledWith({ isActive: true, sellable: true, limit: 500 });
  });

  test('each customer once, by its newest lead that asked for a look; test contacts never take a place', async () => {
    const { conn } = fakeConn({ leads: [
      lead('newer-other', { customer_id: 'c-1', service_interest: 'Pest Control Service' }),
      lead('newer-look', { customer_id: 'c-1', service_interest: 'WDO Inspection' }),
      lead('older-look', { customer_id: 'c-1' }),
      lead('shakedown', { first_name: 'Shakedown', last_name: 'Test' }),
      lead('l2'),
    ] });
    const { leads } = await _internals.openLeads(conn, NOW);
    expect(leads.map(({ lead: row, visit }) => [row.id, visit.id])).toEqual([['newer-look', 'svc-wdo'], ['l2', 'svc-assess']]);
  });

  test('a customer already quoted or booked is left out: an open estimate, an estimate since the lead, a live visit since its ET day', async () => {
    const cameIn = new Date('2040-09-05T03:00:00Z'); // Sep 4, 11 PM ET
    const ids = ['quoted', 'requoted', 'archived-requote', 'old-decline', 'old-job', 'lapsed-quote', 'archived-quote', 'booked', 'served-before', 'open'];
    const quote = (id, status, created, expires = null, archived = null) => ({ customer_id: `c-${id}`, status, created_at: new Date(created),
      expires_at: expires && new Date(expires), archived_at: archived && new Date(archived) });
    const { conn, calls } = fakeConn({
      leads: ids.map((id) => lead(id, { created_at: cameIn })),
      leadEstimates: [
        // Open (sent or viewed, not expired): it is on the estimate list.
        quote('quoted', 'sent', '2040-08-01T12:00:00Z', '2040-10-01T12:00:00Z'),
        // A quote since the lead came in, archived or not: the quote happened.
        quote('requoted', 'declined', '2040-09-06T12:00:00Z'),
        quote('archived-requote', 'sent', '2040-09-06T12:00:00Z', null, '2040-09-07T12:00:00Z'),
        // An earlier job's quote, closed, lapsed or archived, never hides a new ask.
        quote('old-decline', 'declined', '2040-08-01T12:00:00Z'),
        quote('old-job', 'accepted', '2038-03-01T12:00:00Z'),
        quote('lapsed-quote', 'viewed', '2040-08-01T12:00:00Z', '2040-08-31T12:00:00Z'),
        quote('archived-quote', 'sent', '2040-08-01T12:00:00Z', null, '2040-08-15T12:00:00Z'),
      ],
      // The lead came in on Sep 4 (ET): a visit that day counts, the day before does not.
      customerVisits: [{ customer_id: 'c-booked', scheduled_date: '2040-09-04' }, { customer_id: 'c-served-before', scheduled_date: '2040-09-03' }],
    });
    expect((await _internals.openLeads(conn, NOW)).leads.map(({ lead: row }) => row.id))
      .toEqual(['old-decline', 'old-job', 'lapsed-quote', 'archived-quote', 'served-before', 'open']);
    const customers = ids.map((id) => `c-${id}`);
    // Live visits only: a cancelled, skipped, no-show or rescheduled visit never hides the ask (a NULL status is a live
    // row); a completed one does. A booked visit or live hold counts as the scheduler counts it (a booked hold keeps its
    // expiry).
    expect(calls).toEqual(expect.arrayContaining([
      ['estimates', 'whereIn', ['customer_id', customers]],
      ['scheduled_services', 'whereIn', ['customer_id', customers]], ['scheduled_services', 'whereNull', ['status']],
      ['scheduled_services', 'orWhereNotIn', ['status', ['cancelled', 'skipped', 'no_show', 'rescheduled']]], ...BOOKED_OR_LIVE_HOLD,
    ]));
    expect(calls).not.toContainEqual(['scheduled_services', 'orWhere', ['reservation_expires_at', '>', NOW]]);
    expect(calls).not.toContainEqual(['scheduled_services', 'whereNot', ['status', 'cancelled']]);
    expect(calls).not.toContainEqual(['estimates', 'whereNull', ['archived_at']]);
  });

  test('at most 40, newest first; with no lead that asked for a look nothing else is read; a failed read throws', async () => {
    const { conn } = fakeConn({ leads: Array.from({ length: 45 }, (_, i) => lead(`l${i}`)) });
    const { leads } = await _internals.openLeads(conn, NOW);
    expect(leads).toHaveLength(_internals.MAX_LEADS);
    expect(leads[0].lead.id).toBe('l0');
    getServices.mockClear();
    const none = fakeConn();
    expect(await _internals.openLeads(none.conn, NOW)).toEqual({ leads: [] });
    expect(getServices).not.toHaveBeenCalled();
    const other = fakeConn({ leads: [lead('l1', { service_interest: 'Pest Control Service' })] });
    expect(await _internals.openLeads(other.conn, NOW)).toEqual({ leads: [] });
    expect(other.calls.some(([table]) => table === 'estimates' || table === 'scheduled_services')).toBe(false);
    const down = fakeConn({ leads: new Error('leads down') });
    await expect(_internals.openLeads(down.conn, NOW)).rejects.toThrow('leads down');
  });
});

describe('booked plan visits that could move up (owner *2a*)', () => {
  // Listed out of order: the range runs from the day after the first to 7 days after the last.
  const blocks = [{ day: '2040-09-12', techId: TECH, start: 540, min: 240 }, { day: DAY, techId: TECH, start: 540, min: 240 }];

  test('recurring, not a re-service, pending or confirmed, not a hold, booked in the range, placed; test contacts left out', async () => {
    const row = planVisit('v1', '2040-09-13');
    // A visit kept by date alone is booked; a due date with no time yet is the night dispatch's to place (isUnplacedDueDate).
    const dateOnly = planVisit('date-only', '2040-09-14', { window_start: null });
    const unplaced = planVisit('unplaced', '2040-09-13', { window_start: null, recurring_dispatch_due_date: '2040-09-13' });
    loadGapCandidate.mockResolvedValue(loaded(row));
    const { conn, calls, planCalls } = fakeConn({ plan: [row, unplaced, dateOnly, planVisit('shakedown', '2040-09-13', { first_name: 'Shakedown', last_name: 'Test' })] });
    const { visits, counts } = await _internals.movableVisits(conn, blocks);
    expect(visits.map((v) => v.row.id)).toEqual(['v1', 'date-only']);
    expect(counts).toEqual({ ...ZERO_VISITS, checked: 2 });
    expect(loadReminderOffIds).toHaveBeenCalledWith(conn, [row, dateOnly]);
    expect(calls).toContainEqual(['scheduled_service_addons', 'whereIn', ['scheduled_service_id', ['v1', 'date-only']]]);
    expect(planCalls).toEqual(expect.arrayContaining([
      ['scheduled_services', 'join', ['customers', 'customers.id', 'scheduled_services.customer_id']],
      ['scheduled_services', 'where', ['scheduled_services.is_recurring', true]],
      ['scheduled_services', 'whereNull', ['scheduled_services.is_callback']], ['scheduled_services', 'orWhere', ['scheduled_services.is_callback', false]],
      ['scheduled_services', 'whereIn', ['scheduled_services.status', ['pending', 'confirmed']]],
      ['scheduled_services', 'whereNull', ['scheduled_services.reservation_expires_at']],
      ['scheduled_services', 'whereBetween', ['scheduled_services.scheduled_date', ['2040-09-11', '2040-09-19']]],
      ['scheduled_services', 'orderBy', ['scheduled_services.scheduled_date']], ['scheduled_services', 'orderBy', ['scheduled_services.window_start']],
    ]));
    // The gap tool's own load of the saved visit: its rules, its series and its plan.
    expect(loadGapCandidate.mock.calls).toEqual([['v1', conn], ['date-only', conn]]);
  });

  test('a visit whose 24-hour reminder will not go out, or that shares its day with another visit of the customer, is left out and counted', async () => {
    const rows = [planVisit('quiet', '2040-09-13'), planVisit('pair', '2040-09-14'), planVisit('ok', '2040-09-15')];
    loadReminderOffIds.mockResolvedValue(new Set(['quiet']));
    loadGapCandidate.mockImplementation(async (id) => loaded(rows.find((row) => row.id === id)));
    const { conn, calls } = fakeConn({ plan: rows, sameDay: [
      { id: 'quiet', customer_id: 'c-quiet', scheduled_date: '2040-09-13' },
      { id: 'pair', customer_id: 'c-pair', scheduled_date: '2040-09-14' }, { id: 'pair-lawn', customer_id: 'c-pair', scheduled_date: '2040-09-14' },
      // Another visit of the customer on another day splits nothing.
      { id: 'ok', customer_id: 'c-ok', scheduled_date: '2040-09-15' }, { id: 'ok-next', customer_id: 'c-ok', scheduled_date: '2040-09-16' },
    ] });
    const { visits, counts } = await _internals.movableVisits(conn, blocks);
    expect(visits.map((v) => v.row.id)).toEqual(['ok']);
    expect(counts).toEqual({ ...ZERO_VISITS, checked: 1, remindersOff: 1, sharedDay: 1 });
    // The senders' own rule reads the visits; neither left-out visit is loaded.
    expect(loadReminderOffIds).toHaveBeenCalledWith(conn, rows);
    expect(loadGapCandidate.mock.calls.map(([id]) => id)).toEqual(['ok']);
    // The customer's live stops in the range: not cancelled, skipped, no-show or rescheduled (a NULL status is live), and
    // a booked visit or live hold as the scheduler counts it.
    expect(calls).toEqual(expect.arrayContaining([
      ['scheduled_services', 'whereIn', ['customer_id', ['c-quiet', 'c-pair', 'c-ok']]],
      ['scheduled_services', 'whereBetween', ['scheduled_date', ['2040-09-11', '2040-09-19']]],
      ['scheduled_services', 'whereNull', ['status']], ['scheduled_services', 'orWhereNotIn', ['status', ['cancelled', 'skipped', 'no_show', 'rescheduled']]],
      ...BOOKED_OR_LIVE_HOLD,
    ]));
  });

  test('a visit the gap tool refuses is checked and never listed; one whose reads fail is counted as unread and logged', async () => {
    const rows = [planVisit('locked', '2040-09-13'), planVisit('down', '2040-09-13'), planVisit('ok', '2040-09-14')];
    loadGapCandidate.mockImplementation(async (id) => {
      if (id === 'locked') return { unavailable: 'candidate_locked_or_excluded' };
      if (id === 'down') throw new Error('read timeout');
      return loaded(rows[2]);
    });
    const { conn } = fakeConn({ plan: rows });
    const { visits, counts } = await _internals.movableVisits(conn, blocks);
    expect(visits.map((v) => v.row.id)).toEqual(['ok']);
    expect(counts).toEqual({ ...ZERO_VISITS, checked: 3, unread: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('plan visit down unread (read timeout)'));
  });

  test('open only on the 7 days before its own day: never its own day or later, never 8 days before', async () => {
    const row = planVisit('v1', '2040-09-17');
    loadGapCandidate.mockResolvedValue(loaded(row));
    const { conn } = fakeConn({ plan: [row] });
    const [{ day, candidate }] = (await _internals.movableVisits(conn, blocks)).visits;
    expect(day).toBe('2040-09-17');
    expect(MOVE_UP_DAYS).toBe(7);
    expect(candidate).toMatchObject({ prospective: true, label: 'Quarterly Pest Control Service' });
    expect(['2040-09-09', '2040-09-10', '2040-09-16', '2040-09-17', '2040-09-18'].map(candidate.dayOpen)).toEqual([false, true, true, false, false]);
  });

  test('a combined catalog row needs the technician\'s capability for each of its families (pest + termite bait)', async () => {
    const rows = [planVisit('combo', '2040-09-13'), planVisit('pest', '2040-09-13')];
    // The gap tool loads the combined row with its plan families (gap-candidates.js planFamilies).
    loadGapCandidate.mockImplementation(async (id) => (id === 'combo' ? { ...loaded(rows[0]), families: ['pest_control', 'termite_bait'] } : loaded(rows[1])));
    const { conn } = fakeConn({ plan: rows, inactive: { termite: [TECH] } });
    const byId = Object.fromEntries((await _internals.movableVisits(conn, blocks)).visits.map((v) => [v.row.id, v.candidate]));
    expect([byId.combo.deactivated, byId.pest.deactivated]).toEqual([[TECH], []]);
  });

  test('a lawn round visit moves only where the move stays a one-off: inside its round, at most 7 days from its regular date', async () => {
    // A round runs Aug 22 to Sep 30, 2040; the next starts Oct 1.
    const roundBlocks = [{ day: '2040-09-28', techId: TECH, start: 540, min: 240 }];
    const rows = [planVisit('rounds', '2040-10-02'), planVisit('excepted', '2040-10-02'), planVisit('pest', '2040-10-02')];
    const extra = {
      rounds: { recurring_pattern: 'lawn_rounds_9' },
      // Moved off its regular date (Oct 9) once: the window is measured from Oct 9.
      excepted: { recurring_pattern: 'lawn_rounds_9', date_exception: true, date_exception_cadence_date: '2040-10-09' },
      pest: { recurring_pattern: 'quarterly' },
    };
    loadGapCandidate.mockImplementation(async (id) => loaded(rows.find((row) => row.id === id), extra[id]));
    const { conn } = fakeConn({ plan: rows });
    const byId = Object.fromEntries((await _internals.movableVisits(conn, roundBlocks)).visits.map((v) => [v.row.id, v.candidate]));
    expect(['2040-09-28', '2040-10-01'].map(byId.rounds.dayOpen)).toEqual([false, true]);
    expect(['2040-09-28', '2040-10-01'].map(byId.excepted.dayOpen)).toEqual([false, false]);
    expect(['2040-09-28', '2040-10-01'].map(byId.pest.dayOpen)).toEqual([true, true]);
  });

  test('its add-on services count: the capability for each, the plan holds of their families, and the mowing-day rule', async () => {
    const rows = [planVisit('mosquito', '2040-09-13'), planVisit('lawn', '2040-09-13'), planVisit('plain', '2040-09-13')];
    // The customer's mowing rule blocks Mondays: DAY (2040-09-10) is one.
    loadGapCandidate.mockImplementation(async (id) => {
      const base = loaded(rows.find((row) => row.id === id));
      return { ...base, preferences: { ...base.preferences, mowing: { mode: 'true', blocked_weekdays: [1], days: [] } } };
    });
    const addOn = (id, name) => ({ scheduled_service_id: id, service_id: null, service_name: name, service_key_snapshot: null });
    // The customer's lawn plan is paused to Sep 12: a visit with a lawn add-on cannot move into the pause.
    const pause = { family_key: 'lawn_care', starts_on: '2040-09-01', resume_on: '2040-09-12' };
    const { conn, calls } = fakeConn({ plan: rows, inactive: { mosquito: [TECH] },
      addOns: [addOn('mosquito', 'Mosquito Control Service'), addOn('lawn', 'Lawn Care Service')],
      planHolds: [{ ...pause, customer_id: 'c-lawn' }, { ...pause, customer_id: 'c-mosquito' }] });
    const byId = Object.fromEntries((await _internals.movableVisits(conn, blocks)).visits.map((v) => [v.row.id, v.candidate]));
    expect([byId.mosquito, byId.lawn, byId.plain].map((c) => c.deactivated)).toEqual([[TECH], [], []]);
    expect(byId.lawn.holds).toEqual([expect.objectContaining({ starts_on: '2040-09-01', resume_on: '2040-09-12' })]);
    expect([byId.mosquito.holds, byId.plain.holds]).toEqual([[], []]);
    expect(calls).toEqual(expect.arrayContaining([['plan_holds', 'whereIn', ['family_key', ['mosquito']]], ['plan_holds', 'whereIn', ['family_key', ['lawn_care']]]]));
    expect([byId.mosquito, byId.lawn, byId.plain].map((c) => c.dayOpen(DAY))).toEqual([true, false, true]);
    expect(byId.lawn.dayOpen('2040-09-11')).toBe(true);
    expect(calls).toContainEqual(['scheduled_service_addons', 'whereIn', ['scheduled_service_id', ['mosquito', 'lawn', 'plain']]]);
  });

  test('at most 60 are loaded, nearest first, a refused one too; none booked: nothing else is read; a failed reminder read throws', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => planVisit(`v${String(i).padStart(2, '0')}`, '2040-09-13'));
    loadGapCandidate.mockImplementation(async (id) => loaded(rows.find((row) => row.id === id)));
    const { conn } = fakeConn({ plan: rows });
    const { visits } = await _internals.movableVisits(conn, blocks);
    expect(visits.map((v) => v.row.id)).toEqual(rows.slice(0, _internals.MAX_VISITS).map((row) => row.id));
    expect(loadGapCandidate).toHaveBeenCalledTimes(_internals.MAX_VISITS);
    // A backlog of visits the gap tool refuses (locked, a stopped plan) is read no further than the cap.
    loadGapCandidate.mockReset();
    loadGapCandidate.mockResolvedValue({ unavailable: 'candidate_locked_or_excluded' });
    expect(await _internals.movableVisits(fakeConn({ plan: rows }).conn, blocks))
      .toEqual({ visits: [], counts: { ...ZERO_VISITS, checked: _internals.MAX_VISITS } });
    expect(loadGapCandidate).toHaveBeenCalledTimes(_internals.MAX_VISITS);
    loadReminderOffIds.mockClear();
    const none = fakeConn();
    expect(await _internals.movableVisits(none.conn, blocks)).toEqual({ visits: [], counts: ZERO_VISITS });
    expect(loadReminderOffIds).not.toHaveBeenCalled();
    expect(none.calls.filter(([table, m]) => table === 'scheduled_services' && m === 'join')).toHaveLength(1);
    loadReminderOffIds.mockRejectedValueOnce(new Error('reminders down'));
    await expect(_internals.movableVisits(fakeConn({ plan: rows }).conn, blocks)).rejects.toThrow('reminders down');
  });
});

describe('a block\'s lines', () => {
  const line = (kind, id, addedDriveMin, startMin = 540) => ({ kind, id, addedDriveMin, startMin });
  const ids = (lines) => _internals.pickLines(lines).map((l) => l.id);

  test('the best fit of each kind, then the next best of any kind; least added drive first', () => {
    const estimates = [line('estimate', 'e-near', 2), line('estimate', 'e-mid', 4), line('estimate', 'e-far', 20)];
    // Nearer open estimates never push out a far lead or the plan visit.
    expect(ids([...estimates, line('lead', 'l-far', 40), line('visit', 'v-1', 9), line('visit', 'v-2', 3)])).toEqual(['e-near', 'v-2', 'l-far']);
    // No lead fits: the third place goes to the next best fit, whatever its kind.
    expect(ids([...estimates, line('visit', 'v-1', 9), line('visit', 'v-2', 3)])).toEqual(['e-near', 'v-2', 'e-mid']);
    expect(ids([...estimates, line('visit', 'v-1', 1), line('visit', 'v-2', 3)])).toEqual(['v-1', 'e-near', 'v-2']);
    // One kind only: its three best.
    expect(ids(estimates.slice().reverse())).toEqual(['e-near', 'e-mid', 'e-far']);
    expect(ids([])).toEqual([]);
    // A tie on drive: the earlier start, then the id.
    expect(ids([line('estimate', 'b', 4, 600), line('estimate', 'a', 4, 600), line('estimate', 'c', 4, 560)])).toEqual(['c', 'a', 'b']);
  });
});

describe('a fit inside the block', () => {
  test('the visit runs from the van\'s arrival, or the window\'s start when the van is early, to its end', () => {
    const block = { start: 9 * 60, min: 90 };
    const late = { windowStart: '09:00', windowEnd: '10:00', estimatedArrival: '09:40', addedDriveMinutes: 3 };
    const early = { windowStart: '09:00', windowEnd: '10:00', estimatedArrival: '08:50', addedDriveMinutes: 5.5 };
    // Arriving at 9:40, the visit ends at 10:40, past the block: the next fit is taken.
    expect(_internals.fitInside(block, [late, early])).toEqual({ windowStart: '09:00', startMin: 540, endMin: 600, length: 60, onSiteMin: 60, addedDriveMin: 6 });
    // The offered window stays 9:00 when the van comes at 9:40.
    expect(_internals.fitInside({ start: 9 * 60, min: 100 }, [late])).toEqual({ windowStart: '09:00', startMin: 580, endMin: 640, length: 60, onSiteMin: 60, addedDriveMin: 3 });
    // The modeled end: 45 minutes on site in a 60-minute visit (owner planning minutes) fits a 50-minute block. The visit
    // as booked stays 60 minutes.
    const planned = { ...early, estimatedArrival: '09:00', estimatedDeparture: '09:45', addedDriveMinutes: 2 };
    expect(_internals.fitInside({ start: 9 * 60, min: 50 }, [planned])).toEqual({ windowStart: '09:00', startMin: 540, endMin: 585, length: 60, onSiteMin: 45, addedDriveMin: 2 });
    expect(_internals.fitInside({ start: 9 * 60, min: 44 }, [planned])).toBeNull();
    expect(_internals.fitInside({ start: 9 * 60 + 1, min: 120 }, [early])).toBeNull();
    expect(_internals.fitInside(block, [{ ...early, addedDriveMinutes: -0.4 }]).addedDriveMin).toBe(0);
  });
});

describe('fillList', () => {
  const morning = { day: DAY, techId: TECH, start: 9 * 60, min: 4 * 60 };

  test('each block lists its best three, least added drive first: the length, the drive it adds and the finish', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.04, lng: HQ.lng },
      far: { lat: HQ.lat + 0.08, lng: HQ.lng }, farthest: { lat: HQ.lat + 0.15, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: ['mid', 'farthest', 'near', 'far'].map((id) => estimate(id)) });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 4, fitted: 4, noLocation: 0, unread: 0 });
    const [lines] = out.byBlock;
    expect(lines.map((l) => l.id)).toEqual(['near', 'mid', 'far']);
    expect(lines).toHaveLength(MAX_PER_BLOCK);
    expect(lines[0].addedDriveMin).toBeLessThan(lines[1].addedDriveMin);
    expect(lines[1].addedDriveMin).toBeLessThan(lines[2].addedDriveMin);
    for (const line of lines) {
      expect(line).toMatchObject({ kind: 'estimate', name: `Pat ${line.id}`, label: 'Pest Control', length: 60, onSiteMin: 60, endMin: line.startMin + 60 });
      expect(line.startMin).toBeGreaterThanOrEqual(9 * 60);
      expect(line.endMin).toBeLessThanOrEqual(13 * 60);
    }
    // Never geocoded: each location is the stored one or none.
    expect(slots.resolveEstimateCoords).toHaveBeenCalledTimes(4);
    for (const [, opts] of slots.resolveEstimateCoords.mock.calls) expect(opts).toEqual({ paidCalls: false, strictReads: true });
    // Sized as the page sizes it: the page picker's service mode and default selection.
    expect(slots.resolveCatalogSlotProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }), { serviceMode: 'recurring' }, conn);
    expect(getCustomerSchedulingPreferences).toHaveBeenCalledWith('c-near', 'Pest Control', conn, { serviceKey: 'pest_control' });
    // The gap tool's read of the day, with its statuses and columns.
    expect(dayStopsQuery).toHaveBeenCalledWith(conn, { dateStr: DAY, excludeStatuses: ['cancelled', 'completed'], select: ['stop columns'] });
    expect(loadTechStartPoints).toHaveBeenCalledWith(conn, [TECH]);
  });

  test('built on the main database only: the page\'s checks read it, so another connection is refused', async () => {
    const other = (table) => { throw new Error(`read ${table}`); };
    await expect(fillList(other, [morning], NOW)).rejects.toThrow('the fill list reads the main database only');
  });

  test('a combined visit keeps its full length on the modeled route: the planned minutes of one service never shrink it', async () => {
    const before = process.env.GATE_SCHEDULING_CAPACITY;
    const fake = slots.appointmentServicesFor.getMockImplementation();
    // Plan-only mode: the route plans the owner's minutes on site, and nothing else changes. The page's own rule for
    // the services this visit performs.
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    slots.appointmentServicesFor.mockImplementation(jest.requireActual('../services/estimate-slot-availability').appointmentServicesFor);
    try {
      dayStops({ [DAY]: [stop('first', '08:00')] });
      locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
      const { conn } = fakeConn({ estimates: [estimate('near')] });
      // One service: a one-time pest visit plans 45 minutes on site.
      slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, serviceLabel: 'One-Time Pest Control',
        services: [{ service: 'pest_control', label: 'One-Time Pest Control' }] });
      expect((await fillList(conn, [morning], NOW)).byBlock[0][0]).toMatchObject({ length: 60, onSiteMin: 45 });
      // The same pest service with lawn care on one visit: the whole 60 minutes.
      slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, reservationServiceMix: true, serviceLabel: 'Pest Control + Lawn Care',
        services: [{ service: 'pest_control', label: 'One-Time Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }] });
      expect((await fillList(conn, [morning], NOW)).byBlock[0][0]).toMatchObject({ label: 'One-Time Pest Control + Lawn Care', length: 60, onSiteMin: 60 });
      // A recurring estimate whose lawn program books its own visits: plan-only mode keeps lawn care in the profile,
      // but this visit performs pest control alone, so it plans the recurring pest row.
      slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, serviceMode: 'recurring', serviceLabel: 'Quarterly Pest Control + Lawn Care',
        services: [{ service: 'pest_control', label: 'Quarterly Pest Control' }, { service: 'lawn_care', label: 'Lawn Care (Every 6 weeks)' }] });
      // The line names that visit's own service.
      expect((await fillList(conn, [morning], NOW)).byBlock[0][0]).toMatchObject({ label: 'Quarterly Pest Control', length: 60, onSiteMin: 35 });
    } finally {
      slots.appointmentServicesFor.mockImplementation(fake);
      if (before === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = before;
    }
  });

  test('the visit is sized as the page sizes it: the picker\'s service mode and default selection', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    const selection = { selectedFrequency: 'monthly', serviceCadences: { mosquito: 'seasonal9' } };
    page.pageSlotPicker.mockResolvedValueOnce({ serviceMode: 'recurring', selection });
    await fillList(conn, [morning], NOW);
    expect(slots.resolveCatalogSlotProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'near' }), { serviceMode: 'recurring', ...selection }, conn);
    page.pageSlotPicker.mockResolvedValueOnce({ serviceMode: 'one_time', selection: {} });
    await fillList(conn, [morning], NOW);
    expect(slots.resolveCatalogSlotProfile).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'near' }), { serviceMode: 'one_time' }, conn);
  });

  test('least added drive comes first, even when it starts later (a customer who asked for late morning)', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.05, lng: HQ.lng } });
    getCustomerSchedulingPreferences.mockImplementationOnce(async (_id, type) => ({ ...normalizePreferences(null, type),
      service_category: 'pest_control', preferred_time_window: { startMin: 11 * 60, endMin: 13 * 60 } }));
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('mid')] });
    const [lines] = (await fillList(conn, [morning], NOW)).byBlock;
    expect(lines.map((l) => l.id)).toEqual(['near', 'mid']);
    expect(lines[0].startMin).toBe(11 * 60);
    expect(lines[1].startMin).toBeLessThan(11 * 60);
    expect(lines[0].addedDriveMin).toBeLessThan(lines[1].addedDriveMin);
  });

  test('a new visit goes where the staff finder puts it: before the first stop, between stops and after the last', async () => {
    dayStops({ [DAY]: [stop('midday', '11:00', { window_end: '12:00' }), stop('afternoon', '14:00', { window_end: '15:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    const blocks = [{ day: DAY, techId: TECH, start: 8 * 60, min: 3 * 60 }, { day: DAY, techId: TECH, start: 12 * 60 + 30, min: 90 },
      { day: DAY, techId: TECH, start: 15 * 60 + 30, min: 90 }];
    const out = await fillList(conn, blocks, NOW);
    for (const [i, lines] of out.byBlock.entries()) {
      expect(lines).toEqual([expect.objectContaining({ id: 'near' })]);
      expect(lines[0].startMin).toBeGreaterThanOrEqual(blocks[i].start);
      expect(lines[0].endMin).toBeLessThanOrEqual(blocks[i].start + blocks[i].min);
    }
  });

  test('a visit that cannot run inside a block is not listed there; each block takes its own best fit', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('midday', '10:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near', { customer_name: '' })] });
    const blocks = [{ day: DAY, techId: TECH, start: 9 * 60, min: 60 }, { day: DAY, techId: TECH, start: 14 * 60, min: 120 },
      { day: DAY, techId: TECH, start: 11 * 60, min: 60 }];
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, durationMinutes: 90 });
    const long = await fillList(conn, blocks, NOW);
    // 90 minutes do not fit an hour's block; the afternoon block holds it.
    expect(long.byBlock[0]).toEqual([]);
    expect(long.byBlock[1]).toEqual([expect.objectContaining({ id: 'near', name: null, length: 90 })]);
    expect(long.byBlock[1][0].startMin).toBeGreaterThanOrEqual(14 * 60);
    expect(long.fitted).toBe(1);
    // The midday stop holds 10:00 to 2:00: nothing runs inside the 11:00 block.
    expect(long.byBlock[2]).toEqual([]);
    // One read of the day for its three blocks.
    expect(dayStopsQuery).toHaveBeenCalledTimes(1);
  });

  test('the van is home by the route check\'s day end: a far visit fits an early block, not the last hour', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ far: { lat: HQ.lat + 0.6, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('far')] });
    const out = await fillList(conn, [{ day: DAY, techId: TECH, start: 16 * 60, min: 60 }, { day: DAY, techId: TECH, start: 13 * 60, min: 60 }], NOW);
    expect(out.byBlock[0]).toEqual([]);
    expect(out.byBlock[1]).toEqual([expect.objectContaining({ id: 'far', startMin: 13 * 60 })]);
  });

  test('the van starts and ends at the technician\'s start point, and leaves at the departure time', async () => {
    dayStops({ [DAY]: [] });
    const farAway = { lat: HQ.lat + 0.6, lng: HQ.lng };
    locations({ far: farAway });
    const { conn } = fakeConn({ estimates: [estimate('far')] });
    const late = [{ day: DAY, techId: TECH, start: 16 * 60, min: 60 }];
    // From the office the van is not home by 6 PM; from a start point next door it is.
    expect((await fillList(conn, late, NOW)).byBlock[0]).toEqual([]);
    loadTechStartPoints.mockResolvedValueOnce(new Map([[TECH.toLowerCase(), { lat: farAway.lat + 0.005, lng: farAway.lng }]]));
    expect((await fillList(conn, late, NOW)).byBlock[0]).toEqual([expect.objectContaining({ id: 'far', startMin: 16 * 60 })]);
    // A 10:00 AM departure: no visit runs in the 9:00 block.
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const near = fakeConn({ estimates: [estimate('near')] });
    const nine = [{ day: DAY, techId: TECH, start: 9 * 60, min: 60 }];
    expect((await fillList(near.conn, nine, NOW)).byBlock[0]).toHaveLength(1);
    dayDepartureMinutes.mockResolvedValueOnce(10 * 60);
    expect((await fillList(near.conn, nine, NOW)).byBlock[0]).toEqual([]);
  });

  test('no stored location is counted, a failed read is counted and logged (never as no location), and the rest still fit', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, broken: { lat: HQ.lat, lng: HQ.lng }, dbdown: new Error('connection reset') });
    slots.resolveCatalogSlotProfile.mockImplementation(async (row) => {
      if (row.id === 'broken') throw new Error('catalog down');
      return PROFILE;
    });
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('nowhere'), estimate('broken'), estimate('dbdown')] });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 4, fitted: 1, noLocation: 1, unread: 2 });
    expect(out.byBlock[0].map((l) => l.id)).toEqual(['near']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate broken unread (catalog down)'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate dbdown unread (connection reset)'));
  });

  test('a technician without the service\'s capability gets no line', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn, calls } = fakeConn({ estimates: [estimate('near')], inactive: { general: [TECH] } });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 1, fitted: 0, byBlock: [[]] });
    expect(calls).toContainEqual(['technician_capabilities', 'whereIn', ['service_category', ['general']]]);
  });

  test('a combined visit needs the capability for each service it performs', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, reservationServiceMix: true, serviceLabel: 'Pest Control + Lawn Care',
      services: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }] });
    const offForLawn = fakeConn({ estimates: [estimate('near')], inactive: { lawn: [TECH] } });
    expect((await fillList(offForLawn.conn, [morning], NOW)).byBlock[0]).toEqual([]);
    expect(offForLawn.calls).toContainEqual(['technician_capabilities', 'whereIn', ['service_category', ['general', 'lawn']]]);
    const offForMosquito = fakeConn({ estimates: [estimate('near')], inactive: { mosquito: [TECH] } });
    expect((await fillList(offForMosquito.conn, [morning], NOW)).byBlock[0]).toEqual([expect.objectContaining({ label: 'Pest Control + Lawn Care' })]);
  });

  test('the mowing-day rule covers every service the visit performs: a pest-first visit with lawn care', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    // DAY is a Monday (weekday 1): the customer's mowing rule blocks it.
    const mowingPrefs = async (_id, type) => ({ ...normalizePreferences(null, type), service_category: 'pest_control',
      mowing: { mode: 'true', blocked_weekdays: [1], days: [] } });
    const combined = { ...PROFILE, reservationServiceMix: true, serviceLabel: 'Pest Control + Lawn Care',
      services: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }] };
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    slots.resolveCatalogSlotProfile.mockResolvedValue(combined);
    getCustomerSchedulingPreferences.mockImplementationOnce(mowingPrefs);
    expect((await fillList(conn, [morning], NOW)).byBlock[0]).toEqual([]);
    // Pest alone: the mowing day does not hold it.
    slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
    getCustomerSchedulingPreferences.mockImplementationOnce(mowingPrefs);
    expect((await fillList(conn, [morning], NOW)).byBlock[0]).toHaveLength(1);
  });

  test('the day\'s schedule blocks hold the technician: the technician\'s own and everyone\'s, not another technician\'s', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const block = (technicianId) => ({ id: 'b1', technician_id: technicianId, start_time: '09:00:00', end_time: '12:00:00' });
    const linesWith = async (scheduleBlocks) => {
      const { conn, calls } = fakeConn({ estimates: [estimate('near')], scheduleBlocks });
      const [lines] = (await fillList(conn, [morning], NOW)).byBlock;
      expect(calls).toEqual(expect.arrayContaining([['tech_schedule_blocks', 'where', [{ date: DAY }]],
        ['tech_schedule_blocks', 'whereNot', ['block_type', 'available']]]));
      return lines;
    };
    expect(await linesWith([])).toEqual([expect.objectContaining({ id: 'near', startMin: expect.any(Number) })]);
    expect((await linesWith([]))[0].startMin).toBeLessThan(10 * 60);
    // A 9:00 to noon block holds the van too: it reaches the customer after noon, and the visit runs past the 1:00 PM
    // end of the opening.
    expect(await linesWith([block(TECH)])).toEqual([]);
    expect(await linesWith([block(null)])).toEqual([]);
    expect((await linesWith([block('00000000-0000-4000-8000-000000000002')]))[0].startMin).toBeLessThan(10 * 60);
  });

  test('only on a day the booking page allows a first visit: a seasonal mosquito program in season, a new home from its move-in date', async () => {
    const NOV = '2040-11-13';
    dayStops({ [DAY]: [stop('first', '08:00')], [NOV]: [stop('first-nov', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    const blocks = [morning, { ...morning, day: NOV }];
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, serviceLabel: 'Seasonal Mosquito Control',
      services: [{ service: 'mosquito', label: 'Mosquito', visitsPerYear: 9 }] });
    expect((await fillList(conn, blocks, NOW)).byBlock.map((lines) => lines.length)).toEqual([1, 0]);
    slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
    slots.estimateMoveInDate.mockResolvedValueOnce('2040-09-11');
    expect((await fillList(conn, blocks, NOW)).byBlock.map((lines) => lines.length)).toEqual([0, 1]);
    expect(slots.estimateMoveInDate).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }));
  });

  test('the server keeps answering while the list is built: the checks yield to the event loop between them', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.05, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('mid')] });
    const events = [];
    analyzeGapCandidate.mockImplementation((...args) => {
      events.push('check');
      return jest.requireActual('../services/scheduling/gap-candidates').analyzeGapCandidate(...args);
    });
    setImmediate(() => events.push('other work'));
    try {
      await fillList(conn, [morning], NOW);
    } finally {
      analyzeGapCandidate.mockImplementation(jest.requireActual('../services/scheduling/gap-candidates').analyzeGapCandidate);
    }
    expect(events).toEqual(['check', 'other work', 'check']);
  });

  test('a lead\'s look and a plan visit moved up are listed with the open estimate; each kind is counted', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    // Farther each: the open estimate, the lead, then the plan visit; each kind's best is listed, least added drive first.
    const row = planVisit('v1', '2040-09-12', { window_start: '14:00:00' });
    loadGapCandidate.mockResolvedValue(loaded(row, { lat: HQ.lat + 0.05 }));
    const { conn } = fakeConn({ estimates: [estimate('near')], leads: [lead('l1', { latitude: HQ.lat + 0.03 }), lead('nowhere', { latitude: null })],
      plan: [row] });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 1, fitted: 1, noLocation: 0, unread: 0 });
    expect(out.leads).toEqual({ checked: 2, fitted: 1, noLocation: 1, unread: 0 });
    expect(out.visits).toEqual({ ...ZERO_VISITS, checked: 1, fitted: 1 });
    const [lines] = out.byBlock;
    expect(lines.map((l) => [l.kind, l.id])).toEqual([['estimate', 'near'], ['lead', 'l1'], ['visit', 'v1']]);
    expect(lines[0].addedDriveMin).toBeLessThan(lines[1].addedDriveMin);
    expect(lines[1].addedDriveMin).toBeLessThan(lines[2].addedDriveMin);
    // The lead's look at the length the Schedule button books (the catalog's), at the customer's stored location.
    expect(lines[1]).toMatchObject({ name: 'Dana l1', label: 'Waves Assessment', length: 30 });
    expect(lines[1]).not.toHaveProperty('from');
    // The plan visit as booked, and the day and hour the move leaves open.
    expect(lines[2]).toMatchObject({ name: 'Sam v1', label: 'Quarterly Pest Control Service', length: 60, from: { day: '2040-09-12', start: 840 } });
    for (const line of lines) {
      expect(line.startMin).toBeGreaterThanOrEqual(9 * 60);
      expect(line.endMin).toBeLessThanOrEqual(13 * 60);
    }
  });

  test('a lead\'s look is sized by the catalog (1 hour when it names none) and needs the technician\'s capability for it', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    getServices.mockResolvedValue({ services: CATALOG.map((row) => (row.id === 'svc-wdo' ? { ...row, default_duration_minutes: null } : row)) });
    const wdo = () => [lead('wdo', { service_interest: 'WDO Inspection' })];
    const { conn } = fakeConn({ leads: wdo() });
    expect((await fillList(conn, [morning], NOW)).byBlock).toEqual([[expect.objectContaining({ kind: 'lead', id: 'wdo', label: 'WDO Inspection Service', length: 60 })]]);
    // The customer's rules for the service the lead asked for.
    expect(getCustomerSchedulingPreferences).toHaveBeenCalledWith('c-wdo', 'WDO Inspection Service', conn, { serviceId: 'svc-wdo', serviceKey: 'wdo_inspection' });
    // A technician set off for the inspection's category (termite) gets no line.
    expect((await fillList(fakeConn({ leads: wdo(), inactive: { termite: [TECH] } }).conn, [morning], NOW)).byBlock).toEqual([[]]);
  });

  test('a plan visit is tried only on the days it may move to; a lead whose own reads fail is counted as unread and logged', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    // Booked 8 days after the block: too far to move up into it.
    const row = planVisit('v-far', '2040-09-18');
    loadGapCandidate.mockResolvedValue(loaded(row));
    getCustomerSchedulingPreferences.mockImplementationOnce(async () => { throw new Error('rules timeout'); });
    const { conn } = fakeConn({ leads: [lead('l-down')], plan: [row] });
    const out = await fillList(conn, [morning], NOW);
    expect(out.visits).toEqual({ ...ZERO_VISITS, checked: 1 });
    expect(out.leads).toEqual({ checked: 1, fitted: 0, noLocation: 0, unread: 1 });
    expect(out.byBlock).toEqual([[]]);
    expect(analyzeGapCandidate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lead l-down unread (rules timeout)'));
  });

  test('a failed read of the day throws: the notice says the fill list was not built', async () => {
    dayStopsQuery.mockImplementation(() => ({ whereRaw: async () => { throw new Error('db down'); } }));
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    await expect(fillList(conn, [morning], NOW)).rejects.toThrow('db down');
  });
});
