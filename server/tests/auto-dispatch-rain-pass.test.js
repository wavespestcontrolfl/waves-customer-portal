/**
 * Auto-dispatch rain pass (owner 2026-10-08, GATE_AUTO_DISPATCH_RAIN_PASS,
 * dark). A booked outdoor visit whose hourly chance of rain reaches 70% gets
 * one admin notice naming a dry, open hour on the same date. Nothing for
 * rain-OK work, a chance under 70%, a visit about to start, a date past the
 * 3 days, or the gate off. The pass never moves a visit.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { runRainPass, planRainPass, _test } = require('../services/auto-dispatch/rain-pass');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const TODAY = etDateString();
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${TODAY}T12:00`), n));
const D1 = dayOffset(1);
const NOW = parseETDateTime(`${TODAY}T04:30`);
// Every date: 13:00-17:00 read 80%; every other hour 10%.
const hourlyFor = (wetHours = [13, 14, 15, 16, 17]) => [0, 1, 2, 3].flatMap((d) => Array.from({ length: 24 }, (_, h) => ({
  startTime: `${dayOffset(d)}T${String(h).padStart(2, '0')}:00:00-04:00`, rainChance: wetHours.includes(h) ? 80 : 10,
})));
const stop = (extra = {}) => ({
  id: 'visit-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control Service', service_key_snapshot: 'pest_general_quarterly',
  technician_id: 'tech-1', status: 'confirmed', scheduled_date: D1, window_start: '14:00:00', window_end: '15:00:00',
  ...extra,
});

function deps(rows, extra = {}) {
  return {
    loadStops: jest.fn(async () => _test.groupStops(rows, extra.addOns || [])),
    withCatalogKeys: jest.fn(async (items) => items.map((item) => ({ name: item.name, serviceKey: item.serviceKey, findingsType: null }))),
    visitPoint: jest.fn(async () => ({ lat: 27.4, lng: -82.4 })),
    hourlyRain: jest.fn(async () => hourlyFor()),
    rainOut: { loadOccupancy: jest.fn(async () => ({ rows: [] })), conflictsForTarget: jest.fn(() => []) },
    dayHours: { DAY_START_HOUR: 8, DAY_END_HOUR: 17 },
    customerName: jest.fn(async () => 'Test Person'),
    raiseAdminAlert: jest.fn(async () => ({ notification: { id: 'n1' } })),
    episodes: { openAdminAlertMetadata: jest.fn(async () => []), closeAdminAlertKeys: jest.fn(async () => 1) },
    noticesRaisedToday: jest.fn(async () => 0),
    ...extra,
  };
}

describe('auto-dispatch rain pass', () => {
  afterEach(() => { delete process.env.GATE_AUTO_DISPATCH_RAIN_PASS; });

  test('gate off: nothing is read and nothing is sent', async () => {
    const d = deps([stop()]);
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toEqual({ ran: false, reason: 'gate_off' });
    expect(d.loadStops).not.toHaveBeenCalled();
    expect(d.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('an outdoor visit in rain gets one notice that names the nearest dry open hour and passes the admin-alert rule', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([stop()]);
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toEqual({ ran: true, checked: 1, wet: 1, noticed: 1, deferred: 0, closed: 0 });
    expect(d.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = d.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('schedule');
    const composed = require('../services/admin-alert-compose').composeAdminAlert(spec);
    expect(composed.headline).toBe("Schedule — move Test Person's visit out of rain");
    // 10:00 is the last start whose work hour and two drying hours end before the 13:00 rain.
    expect(composed.why).toMatch(/2:00 PM has 80% rain; 10:00 AM is dry and open\.$/);
    expect(spec.link).toBe(`/admin/dispatch?tab=schedule&date=${D1}&appointment=visit-1`);
    expect(opts.dedupeKey).toBe(`rain-pass:visit-1:${D1}:14:00`);
    // A later run rewrites the standing notice (a new chance, a new dry hour) and never rings it again.
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts.ringOnRefresh({}, { autoCleared: false })).toBe(false);
    // The one refresh that rings: the pass closed the notice as dry and the rain is back.
    expect(opts.ringOnRefresh({}, { autoCleared: true })).toBe(true);
    expect(opts.ringOnRefresh({}, { retired: { by: 'relevance' } })).toBe(true);
    expect(opts.dedupeVersion).toBe(`run:${NOW.toISOString()}`);
    // The relevance sweep reads these to close the notice when the visit moves.
    expect(opts.metadata).toMatchObject({ scheduledServiceId: 'visit-1', scheduled_date: D1, window_start: '14:00', proposed_start: '10:00' });
  });

  test('the proposed hour skips one another stop of the technician holds', async () => {
    const d = deps([stop()]);
    d.rainOut.conflictsForTarget = jest.fn((_snapshot, _id, _date, window) => (window.start === '10:00' ? [{ id: 'other' }] : []));
    const [row] = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(row).toMatchObject({ wet: true, peak: 80, proposal: '09:00' });
    expect(d.rainOut.conflictsForTarget.mock.calls[0][4]).toEqual({ excludeServiceIds: ['visit-1'], technicianId: 'tech-1' });
  });

  test('rain all day: the notice says there is no dry open hour', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([stop()], { hourlyRain: jest.fn(async () => hourlyFor(Array.from({ length: 24 }, (_, h) => h))) });
    await runRainPass({ now: NOW, db: {}, deps: d });
    const [, spec, opts] = d.raiseAdminAlert.mock.calls[0];
    expect(require('../services/admin-alert-compose').composeAdminAlert(spec).why).toMatch(/has 80% rain; no dry open hour that day\.$/);
    expect(opts.metadata.proposed_start).toBeNull();
  });

  test.each([
    ['rain-OK work', stop({ service_type: 'WDO Inspection', service_key_snapshot: 'wdo_inspection' }), {}, 'not_outdoor'],
    ['a chance under 70%', stop(), { hourlyRain: jest.fn(async () => hourlyFor().map((h) => ({ ...h, rainChance: Math.min(h.rainChance, 65) }))) }, 'not_wet'],
    ['a dry morning visit', stop({ window_start: '09:00:00', window_end: '10:00:00' }), {}, 'not_wet'],
    ['a date past the 3 days', stop({ scheduled_date: dayOffset(3) }), {}, 'past_horizon'],
    ['no forecast', stop(), { hourlyRain: jest.fn(async () => null) }, 'no_forecast'],
    ['no point for the visit', stop(), { visitPoint: jest.fn(async () => null) }, 'no_point'],
  ])('no notice for %s', async (_label, visit, extra, reason) => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([visit], extra);
    const [row] = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(row).toMatchObject({ wet: false, reason });
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toMatchObject({ wet: 0, noticed: 0 });
    expect(d.raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a visit that starts within two hours today is left to storm watch', async () => {
    const d = deps([stop({ scheduled_date: TODAY })]);
    const [row] = await planRainPass({ now: parseETDateTime(`${TODAY}T12:30`), db: {}, deps: d });
    expect(row).toMatchObject({ wet: false, reason: 'too_soon' });
  });

  test('a shared stop is judged across every service on it, each at its real length', async () => {
    // Pest 11:00-12:00, then lawn stored 12:00-13:00 but two hours long.
    const d = deps([
      stop({ window_start: '11:00:00', window_end: '12:00:00', visit_id: 'stop-1' }),
      stop({ id: 'visit-2', service_type: 'Lawn Care', service_key_snapshot: 'lawn_care_monthly', window_start: '12:00:00', window_end: '13:00:00', estimated_duration_minutes: 120, visit_id: 'stop-1' }),
    ]);
    const rows = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(rows).toHaveLength(1);
    // 11:00-14:00 of work is in the 13:00 rain. Three hours of work and two
    // of drying fit before 13:00 only from 08:00.
    expect(rows[0]).toMatchObject({ wet: true, peak: 80, proposal: '08:00' });
    expect(d.rainOut.conflictsForTarget.mock.calls[0][4]).toEqual({ excludeServiceIds: ['visit-1', 'visit-2'], technicianId: 'tech-1' });
  });

  test('two services stored in the same hour on one stop are done one after the other', async () => {
    // Both stored 10:00-11:00 with a 30-minute estimate: the stored hour is the
    // work (the route's own duration rule), so two hours, drying through
    // 14:00, in the 13:00 rain.
    const d = deps([
      stop({ window_start: '10:00:00', window_end: '11:00:00', estimated_duration_minutes: 30, visit_id: 'stop-1' }),
      stop({ id: 'visit-2', window_start: '10:00:00', window_end: '11:00:00', estimated_duration_minutes: 30, visit_id: 'stop-1' }),
    ]);
    const [row] = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(row).toMatchObject({ wet: true, peak: 80, proposal: '09:00' });
  });

  test('the budget is for the whole day: a run after six notices today rings four more', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps(Array.from({ length: 7 }, (_, i) => stop({ id: `visit-${i}` })), { noticesRaisedToday: jest.fn(async () => 6) });
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toMatchObject({ wet: 7, noticed: 4, deferred: 3 });
  });

  test('a reorder of the day does not change which row stands for a stop', () => {
    const pair = (order1, order2) => _test.groupStops([
      stop({ id: 'visit-b', visit_id: 'stop-1', route_order: order1 }), stop({ id: 'visit-a', visit_id: 'stop-1', route_order: order2 }),
    ])[0];
    expect(pair(1, 2).id).toBe('visit-a');
    expect(pair(2, 1).id).toBe('visit-a');
  });

  test('a storm rings at most ten new notices a day; a standing notice is rewritten outside the budget', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const rows = Array.from({ length: 13 }, (_, i) => stop({ id: `visit-${i}` }));
    const d = deps(rows);
    d.episodes.openAdminAlertMetadata = jest.fn(async () => [{ dedupeKey: `rain-pass:visit-12:${D1}:14:00` }]);
    d.raiseAdminAlert = jest.fn(async (_category, _spec, opts) => (opts.dedupeKey.includes('visit-12:')
      ? { notification: { id: 'old' }, deduped: true, refreshed: true, rung: false } : { notification: { id: 'new' } }));
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toEqual({ ran: true, checked: 13, wet: 13, noticed: 10, deferred: 2, closed: 0 });
    // The standing notice is rewritten with no version: only its content can change it.
    expect(d.raiseAdminAlert.mock.calls.find(([, , opts]) => opts.dedupeKey.includes('visit-12:'))[2].dedupeVersion).toBeUndefined();
    expect(d.raiseAdminAlert).toHaveBeenCalledTimes(11);
  });

  test('a standing notice is closed when every hour of its visit reads dry, and kept when an hour has no reading', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const key = (id) => `rain-pass:${id}:${D1}:14:00`;
    const allDry = hourlyFor([]);
    const d = deps([stop(), stop({ id: 'visit-2' })], {
      // visit-2's point has no reading for 15:00.
      hourlyRain: jest.fn(async (lat) => (lat === 2 ? allDry.filter((h) => !h.startTime.startsWith(`${D1}T15`)) : allDry)),
      visitPoint: jest.fn(async (visit) => ({ lat: visit.id === 'visit-2' ? 2 : 1, lng: -82.4 })),
    });
    d.episodes.openAdminAlertMetadata = jest.fn(async () => [{ dedupeKey: key('visit-1') }, { dedupeKey: key('visit-2') }]);
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toMatchObject({ wet: 0, noticed: 0, closed: 1 });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0].slice(1, 3)).toEqual([[key('visit-1')], 'no_longer_in_rain']);
  });

  test('an add-on that is outdoor work makes a rain-OK visit outdoor', async () => {
    const wdo = stop({ service_type: 'WDO Inspection', service_key_snapshot: 'wdo_inspection' });
    const addOns = [{ scheduled_service_id: 'visit-1', service_name: 'Mosquito Treatment', service_key_snapshot: 'mosquito_one_time' }];
    expect((await planRainPass({ now: NOW, db: {}, deps: deps([wdo]) }))[0]).toMatchObject({ wet: false, reason: 'not_outdoor' });
    expect((await planRainPass({ now: NOW, db: {}, deps: deps([wdo], { addOns }) }))[0]).toMatchObject({ wet: true });
  });

  test('a standing notice is closed when its visit becomes rain-OK work', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([stop({ service_type: 'WDO Inspection', service_key_snapshot: 'wdo_inspection' })]);
    d.episodes.openAdminAlertMetadata = jest.fn(async () => [{ dedupeKey: `rain-pass:visit-1:${D1}:14:00` }]);
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toMatchObject({ wet: 0, closed: 1 });
  });

  test('a notice the relevance sweep retired is not standing: the visit back in rain on that slot rings it again', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([stop()]);
    d.episodes.openAdminAlertMetadata = jest.fn(async () => [{ dedupeKey: `rain-pass:visit-1:${D1}:14:00`, retired: { by: 'relevance' } }]);
    d.raiseAdminAlert = jest.fn(async () => ({ notification: { id: 'old' }, deduped: true, refreshed: true, rung: true }));
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toMatchObject({ wet: 1, noticed: 1 });
    const [, , opts] = d.raiseAdminAlert.mock.calls[0];
    expect(opts.dedupeVersion).toBe(`run:${NOW.toISOString()}`);
    expect(opts.metadata.retired).toBeNull();
  });

  test('two rows of one customer at the same premise, point and window with no visit id are one stop, with no phantom hour', async () => {
    const premise = { visit_id: null, lat: '27.4', lng: '-82.4', service_address_line1: '1 Test St', service_address_zip: '34201', service_address_city: 'Bradenton', window_start: '09:00:00', window_end: '10:00:00' };
    const d = deps([stop(premise), stop({ ...premise, id: 'visit-2', service_type: 'Lawn Care', service_key_snapshot: 'lawn_care_monthly' })]);
    const rows = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(rows).toHaveLength(1);
    // One hour of work from 09:00, drying to 12:00: dry. Two separate hours would have reached the 13:00 rain.
    expect(rows[0]).toMatchObject({ wet: false, reason: 'not_wet' });
    expect(rows[0].visit.memberIds).toEqual(['visit-1', 'visit-2']);
  });

  test('two co-visits of one customer at two properties in the same hour stay two stops with their own rows', () => {
    const at = (line1, lat) => ({ visit_id: null, lat, lng: '-82.4', service_address_line1: line1, service_address_zip: '34201', service_address_city: 'Bradenton', window_start: '09:00:00', window_end: '10:00:00' });
    const stops = _test.groupStops([
      stop({ ...at('1 Test St', '27.4'), id: 'a1' }), stop({ ...at('1 Test St', '27.4'), id: 'a2' }),
      stop({ ...at('9 Other Ave', '27.5'), id: 'b1' }), stop({ ...at('9 Other Ave', '27.5'), id: 'b2' }),
    ]);
    expect(stops.map((s) => s.memberIds)).toEqual([['a1', 'a2'], ['b1', 'b2']]);
  });

  test('a failed run resolves as an error, which the scheduler turns into a failed job', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const d = deps([stop()], { loadStops: jest.fn(async () => { throw new Error('db down'); }) });
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toEqual({ ran: false, reason: 'error', error: 'db down' });
  });

  test('the visit read selects what the route model needs for a stop and its minutes', () => {
    expect(_test.VISIT_COLUMNS).toEqual(expect.arrayContaining(['visit_id', 'route_order', 'created_at', 'is_recurring', 'is_callback', 'service_address_line1', 'lat', 'lng']));
  });

  test('a date column value (a Date at UTC midnight) keeps its calendar date', async () => {
    const d = deps([stop({ scheduled_date: new Date(`${D1}T00:00:00Z`) })]);
    const [row] = await planRainPass({ now: NOW, db: {}, deps: d });
    expect(row).toMatchObject({ wet: true, date: D1 });
  });

  test('an hour with no reading is never taken for a dry hour', () => {
    const hourly = hourlyFor().filter((h) => !h.startTime.startsWith(`${D1}T11`));
    expect(_test.spanRain(hourly, D1, 9 * 60, 10 * 60)).toEqual({ peak: 10, complete: false });
    expect(_test.spanRain(hourly, D1, 8 * 60, 9 * 60)).toEqual({ peak: 10, complete: true });
  });

  test('a failed notice does not stop the next one, and a repeat of a standing notice is not counted', async () => {
    process.env.GATE_AUTO_DISPATCH_RAIN_PASS = 'true';
    const raiseAdminAlert = jest.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ notification: { id: 'n1' }, deduped: true });
    const d = deps([stop(), stop({ id: 'visit-2' })], { raiseAdminAlert });
    expect(await runRainPass({ now: NOW, db: {}, deps: d })).toEqual({ ran: true, checked: 2, wet: 2, noticed: 0, deferred: 0, closed: 0 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
  });
});
