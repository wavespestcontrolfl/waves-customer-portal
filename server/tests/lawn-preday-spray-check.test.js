/**
 * Lawn pre-day spray check (P32): the 5:41 AM sweep runs the job card's own
 * spray check on today's lawn visits' planned primary products against the
 * property forecast and writes ONE quiet dispatch card per visit per day.
 * Forecast and database are faked; no real weather or provider is called.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const Sweep = require('../services/lawn-preday-spray-check');
const NotificationService = require('../services/notification-service');

const DAY = '2026-10-03';
// 5:41 AM ET; the visit's window opens at 9:00 AM ET (13:00Z).
const NOW = new Date('2026-10-03T09:41:00Z');
const ARRIVAL = new Date('2026-10-03T13:00:00Z');
const HOUR = 3600000;

const label = '2026-09-01T00:00:00Z';
const herbicide = { id: 'p-herb', name: 'Sample Herbicide', label_verified_at: label, min_temp_f: 50, max_temp_f: 90, max_wind_mph: 15, rainfast_minutes: 360, application_method: 'liquid' };
const altGranular = { id: 'p-gran', name: 'Sample Granular', label_verified_at: label, max_wind_mph: 25, rainfast_minutes: 0, application_method: 'granular', category: 'granular herbicide' };
const fertilizer = { id: 'p-fert', name: 'Sample Fertilizer', label_verified_at: label, max_wind_mph: 15, application_method: 'granular' };
const addonProduct = { id: 'p-addon', name: 'Sample Add-on', label_verified_at: label, max_wind_mph: 5, application_method: 'liquid' };

function forecast({ rain = {}, wind = 6, temp = 78, prob = 0, base = ARRIVAL } = {}) {
  const rows = [];
  for (let i = 0; i < 36; i += 1) {
    const at = new Date(base.getTime() + i * HOUR);
    rows.push({
      time: at.toISOString(), at: at.toISOString(),
      precipitation_in: rain[i] ?? 0,
      precipitation_probability_pct: typeof prob === 'function' ? prob(i) : prob,
      temperature_f: typeof temp === 'function' ? temp(i) : temp,
      humidity_pct: 60, wind_mph: typeof wind === 'function' ? wind(i) : wind, wind_gust_mph: 10,
    });
  }
  return { status: 'ok', source: 'open_meteo', hourly: rows, precipitationInTotal: 0 };
}

const ctxFor = (lines, over = {}) => ({
  serviceId: 'visit-1', isLawn: true, scheduledDate: DAY, windowStart: '09:00:00',
  coords: { lat: 27.5, lng: -82.5, source: 'property' }, arrival: ARRIVAL, lines, labelSources: {}, ...over,
});
const baseLine = (product, over = {}) => ({ raw: 'Broadleaf step', role: 'base', selected: true, product, ...over });

// A tiny knex stand-in: the visits query, the dedupe read, and a transaction.
function fakeDb({ visits = [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '09:00:00' }], alerts = [], visitState = {} } = {}) {
  const store = alerts;
  // The visit table: explicit visitState wins, else a live visit as the sweep query found it.
  const stateOf = (id) => visitState[id] ?? (visits.find((v) => v.id === id)
    ? { id, status: 'confirmed', scheduled_date: DAY, window_start: visits.find((v) => v.id === id).window_start } : undefined);
  const openCards = () => store.filter((a) => a.type === 'lawn_spray_hold' && !a.resolved_at).map((a) => {
    const v = stateOf(a.job_id);
    return { id: a.id, payload: a.payload, visit_id: v ? a.job_id : null, visit_status: v?.status, visit_date: v?.scheduled_date, visit_window: v?.window_start };
  });
  const chain = (table) => {
    const state = { where: {}, bindings: [] };
    const c = {
      join: () => c, whereNull: () => c, orderBy: () => c,
      whereIn: (col, vals) => { dbh.whereInCalls.push([col, vals]); return c; },
      where: (arg) => { if (arg && typeof arg === 'object') Object.assign(state.where, arg); return c; },
      whereRaw: (sql, b) => { state.bindings = b; return c; },
      // leftJoin/limit/orderBy are the stale-card read: read-only, no forUpdate on the fake.
      leftJoin: () => c, limit: () => c,
      select: async () => (String(table).startsWith('dispatch_alerts') ? openCards() : visits),
      first: async () => (table === 'scheduled_services' ? stateOf(state.where.id) : store.find((a) => a.job_id === state.where.job_id && a.type === state.where.type
        && a.payload.for_date === state.bindings[0] && (a.payload.window_start ?? null) === state.bindings[1])),
    };
    return c;
  };
  const dbh = (table) => chain(table);
  dbh.whereInCalls = [];
  dbh.raw = jest.fn(async () => ({}));
  dbh.transaction = async (fn) => { const trx = (t) => chain(t); trx.raw = dbh.raw; return fn(trx); };
  return dbh;
}

function deps({ ctx, fc, alerts }) {
  return {
    loadCatalog: jest.fn(async () => []),
    loadContext: jest.fn(async () => ctx),
    fetchForecast: jest.fn(async () => fc),
    createAlert: jest.fn(async ({ type, severity, jobId, payload }) => { const row = { id: `alert-${alerts.length + 1}`, type, severity, job_id: jobId, payload, resolved_at: null }; alerts.push(row); return row; }),
    resolveAlert: jest.fn(async ({ id }) => { const a = alerts.find((x) => x.id === id); a.resolved_at = 'NOW'; a.auto = true; return a; }),
  };
}

describe('lawn pre-day spray check', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  test('rain hold: one quiet card with measured inches, never a percent, and a neutral pointer when no alternative is known', async () => {
    const alerts = [];
    // 0.42 in falls inside the 6 h rain-free interval after the 9 AM arrival.
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ rain: { 3: 0.3, 5: 0.12 }, prob: 80 }), alerts });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: d });
    expect(out).toMatchObject({ considered: 1, checked: 1, held: 1, carded: 1, duplicate: 0 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'lawn_spray_hold', severity: 'warn', job_id: 'visit-1' });
    expect(alerts[0].payload.for_date).toBe(DAY);
    expect(alerts[0].payload.lines).toEqual([
      'Sample Herbicide: hold. 0.42 in of rain forecast in the 6 h after the 9:00 AM arrival. Check the protocol for an alternative, or move the visit.',
    ]);
    expect(JSON.stringify(alerts[0].payload)).not.toMatch(/%|percent|chance|probab/i);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // The forecast is the shared property forecast, asked once, for the arrival hour onward.
    expect(d.fetchForecast).toHaveBeenCalledTimes(1);
    expect(d.fetchForecast.mock.calls[0][0]).toMatchObject({ latitude: 27.5, longitude: -82.5, from: ARRIVAL.getTime() });
  });

  test('wind hold and temperature hold state the forecast number beside the label limit', async () => {
    const alerts = [];
    const windy = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: (i) => (i === 2 ? 21.4 : 8) }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: windy });
    expect(alerts[0].payload.lines[0]).toBe('Sample Herbicide: hold. Wind forecast up to 21.4 mph in the 4 h after the 9:00 AM arrival (label limit 15 mph). Check the protocol for an alternative, or move the visit.');

    const cold = [];
    const chilly = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ temp: (i) => (i === 1 ? 44 : 60) }), alerts: cold });
    await Sweep.runSweep({ dbh: fakeDb({ alerts: cold }), now: NOW, deps: chilly });
    expect(cold[0].payload.lines[0]).toBe('Sample Herbicide: hold. Forecast low 44°F in the 4 h after the 9:00 AM arrival (label minimum 50°F). Check the protocol for an alternative, or move the visit.');
  });

  test('the plan\'s alternative for the same step is named (granular when it is a dry product)', async () => {
    const alerts = [];
    const lines = [baseLine(herbicide), baseLine(altGranular, { selected: false, role: 'conditional' })];
    const d = deps({ ctx: ctxFor(lines), fc: forecast({ rain: { 2: 0.5 }, prob: 70 }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: d });
    expect(alerts[0].payload.lines[0]).toMatch(/The plan lists granular Sample Granular for the same step, and its check is clear\.$/);
    expect(alerts[0].payload.holds[0].alternative).toMatchObject({ productName: 'Sample Granular', granular: true });
  });

  test('a fallback on a SEPARATE protocol line is never guessed from text: the card points at the protocol instead of claiming there is none', async () => {
    const alerts = [];
    const celsius = { id: 'p-cel', name: 'Sample Fallback WG', label_verified_at: label, max_wind_mph: 25, application_method: 'granular' };
    const lines = [baseLine(herbicide), baseLine(celsius, { raw: 'IF forecast >85F use the fallback instead', selected: false, role: 'conditional' })];
    const d = deps({ ctx: ctxFor(lines), fc: forecast({ wind: 21 }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: d });
    expect(alerts[0].payload.lines[0]).toMatch(/Check the protocol for an alternative, or move the visit\.$/);
    expect(alerts[0].payload.lines[0]).not.toMatch(/Sample Fallback|clearer window/);
    expect(alerts[0].payload.holds[0].alternative).toBeNull();
  });

  test('no hold: no card. A probability with no measured rain, an add-on line and an "if needed" line never make one', async () => {
    const alerts = [];
    const clear = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast(), alerts });
    expect(await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: clear })).toMatchObject({ checked: 1, held: 0, carded: 0 });

    // Likely-rain probability but 0.00 in measured: the card needs inches.
    const dry = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ prob: 90 }), alerts });
    expect(await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: dry })).toMatchObject({ checked: 1, held: 0, carded: 0 });

    // The add-on's product breaks its wind limit and the conditional one too; the primary line is clear.
    const lines = [baseLine(herbicide), baseLine(addonProduct, { source: 'Sample Add-on Service' }), baseLine({ ...fertilizer, max_wind_mph: 5 }, { selected: false, role: 'conditional' })];
    const noisy = deps({ ctx: ctxFor(lines), fc: forecast({ wind: 10 }), alerts });
    expect(await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: noisy })).toMatchObject({ checked: 1, held: 0, carded: 0 });
    expect(alerts).toHaveLength(0);
  });

  test('forecast unavailable: no card, no throw, the sweep goes on to the next visit', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: { status: 'unavailable', reason: 'timeout' }, alerts });
    const visits = [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '09:00:00' }, { id: 'visit-2', service_type: 'Lawn Care Visit', window_start: '09:00:00' }];
    const out = await Sweep.runSweep({ dbh: fakeDb({ visits, alerts }), now: NOW, deps: d });
    expect(out).toMatchObject({ considered: 2, unavailable: 2, carded: 0, failed: 0 });
    expect(alerts).toHaveLength(0);

    const thrower = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    thrower.fetchForecast = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(forecast({ wind: 30 }));
    const out2 = await Sweep.runSweep({ dbh: fakeDb({ visits, alerts }), now: NOW, deps: thrower });
    expect(out2).toMatchObject({ failed: 1, carded: 1 });
  });

  test('no property pin: no forecast call and no card', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)], { coords: null }), fc: forecast({ wind: 30 }), alerts });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: d });
    expect(out).toMatchObject({ unavailable: 1, carded: 0 });
    expect(d.fetchForecast).not.toHaveBeenCalled();
  });

  test('re-run does not duplicate the card, even one a dispatcher already resolved', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    const dbh = fakeDb({ alerts });
    expect(await Sweep.runSweep({ dbh, now: NOW, deps: d })).toMatchObject({ carded: 1 });
    const again = await Sweep.runSweep({ dbh, now: NOW, deps: d });
    expect(again).toMatchObject({ carded: 0, duplicate: 1 });
    expect(alerts).toHaveLength(1);
    expect(d.fetchForecast).toHaveBeenCalledTimes(1); // the second pass skipped before any forecast read
    // Advisory lock only: never a lock on the visit row.
    expect(dbh.raw.mock.calls.every(([sql]) => /pg_advisory_xact_lock/.test(sql) && !/FOR UPDATE/i.test(sql))).toBe(true);
  });

  test('gate off: nothing is read, fetched or written', async () => {
    delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK;
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    const dbh = jest.fn(() => { throw new Error('db must not be read'); });
    expect(await Sweep.runSweep({ dbh, now: NOW, deps: d })).toEqual({ skipped: true, reason: 'gate_off' });
    for (const fn of [d.loadCatalog, d.loadContext, d.fetchForecast, d.createAlert, dbh]) expect(fn).not.toHaveBeenCalled();
  });

  test('non-lawn visits are untouched', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    const visits = [{ id: 'visit-9', service_type: 'Quarterly Pest Control' }, { id: 'visit-8', service_type: 'Mosquito Treatment' }];
    const out = await Sweep.runSweep({ dbh: fakeDb({ visits, alerts }), now: NOW, deps: d });
    expect(out).toMatchObject({ considered: 0, carded: 0 });
    expect(d.loadContext).not.toHaveBeenCalled();
    expect(d.fetchForecast).not.toHaveBeenCalled();
  });

  test('a visit whose date is not today (moved after the query) is skipped', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)], { scheduledDate: '2026-10-04' }), fc: forecast({ wind: 30 }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: NOW, deps: d });
    expect(d.fetchForecast).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });
});

describe('rain over a label interval that is not a whole number of hours', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  // Slot i is stamped ARRIVAL + i h and holds the rain of the hour ENDING there.
  const withInterval = (minutes) => ({ ...herbicide, rainfast_minutes: minutes, max_wind_mph: null, min_temp_f: null, max_temp_f: null });
  async function run({ minutes, slot, windowStart = '09:00:00', arrival = ARRIVAL }) {
    const alerts = [];
    const d = deps({
      ctx: ctxFor([baseLine(withInterval(minutes))], { windowStart, arrival }),
      fc: forecast({ rain: slot == null ? {} : { [slot]: 0.2 }, prob: 80 }),
      alerts,
    });
    await Sweep.runSweep({ dbh: fakeDb({ alerts, visits: [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: windowStart }] }), now: NOW, deps: d });
    return alerts.map((a) => a.payload.lines[0]);
  }
  const text = (inches, interval, time = '9:00 AM') => `Sample Herbicide: hold. ${inches} in of rain forecast in the ${interval} after the ${time} arrival. Check the protocol for an alternative, or move the visit.`;

  test('30 minutes: the slot containing the arrival counts, the next one does not', async () => {
    expect(await run({ minutes: 30, slot: 1 })).toEqual([text('0.2', '30 min')]);
    expect(await run({ minutes: 30, slot: 2 })).toEqual([]);
  });

  test('1.5 hours: the partly covered second slot counts, the third does not', async () => {
    expect(await run({ minutes: 90, slot: 2 })).toEqual([text('0.2', '1.5 h')]);
    expect(await run({ minutes: 90, slot: 3 })).toEqual([]);
  });

  test('6 hours: the last slot counts, the one after does not', async () => {
    expect(await run({ minutes: 360, slot: 6 })).toEqual([text('0.2', '6 h')]);
    expect(await run({ minutes: 360, slot: 7 })).toEqual([]);
  });

  test('arrival not on the hour: the end rounds up to the next slot', async () => {
    const half = new Date(ARRIVAL.getTime() + HOUR / 2); // 9:30 AM ET
    // 30 min from 9:30 ends at 10:00: the 10:00 slot (index 1) counts, 11:00 does not.
    expect(await run({ minutes: 30, slot: 1, windowStart: '09:30:00', arrival: half })).toEqual([text('0.2', '30 min', '9:30 AM')]);
    expect(await run({ minutes: 30, slot: 2, windowStart: '09:30:00', arrival: half })).toEqual([]);
    // 1.5 h from 9:30 ends at 11:00: index 2 counts, index 3 does not.
    expect(await run({ minutes: 90, slot: 2, windowStart: '09:30:00', arrival: half })).toEqual([text('0.2', '1.5 h', '9:30 AM')]);
    expect(await run({ minutes: 90, slot: 3, windowStart: '09:30:00', arrival: half })).toEqual([]);
  });

  test('no measured rain: no card whatever the interval', async () => {
    for (const minutes of [30, 90, 360]) expect(await run({ minutes, slot: null })).toEqual([]);
  });

  test('wind in the hour containing an off-the-hour arrival still holds', async () => {
    const alerts = [];
    const half = new Date(ARRIVAL.getTime() + HOUR / 2);
    const d = deps({ ctx: ctxFor([baseLine(herbicide)], { windowStart: '09:30:00', arrival: half }), fc: forecast({ wind: (i) => (i === 0 ? 22 : 6) }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts, visits: [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '09:30:00' }] }), now: NOW, deps: d });
    expect(alerts[0].payload.lines[0]).toMatch(/^Sample Herbicide: hold\. Wind forecast up to 22 mph in the 4 h after the 9:30 AM arrival/);
  });
});

describe('a card never outlives the visit it was written for', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  const card = (over = {}) => ({ id: 'old-card', type: 'lawn_spray_hold', job_id: 'visit-1', resolved_at: null,
    payload: { for_date: DAY, window_start: '09:00:00', ...over } });
  const sweepWith = async ({ cards, visitState, visits = [], fc = forecast({ wind: 30 }), ctx = ctxFor([baseLine(herbicide)]) }) => {
    const alerts = [...cards];
    const d = deps({ ctx, fc, alerts });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts, visits, visitState }), now: NOW, deps: d });
    return { out, alerts, d };
  };

  test('visit moved to another day: card superseded, nothing written for the old date, no forecast read', async () => {
    const { out, alerts, d } = await sweepWith({ cards: [card()], visitState: { 'visit-1': { scheduled_date: '2026-10-05', status: 'confirmed', window_start: '09:00:00' } } });
    expect(out.superseded).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: 'old-card', resolved_at: 'NOW', auto: true });
    expect(d.resolveAlert).toHaveBeenCalledWith({ id: 'old-card', auto: true });
    expect(d.fetchForecast).not.toHaveBeenCalled();
  });

  test('time moved on the same day: old card superseded, the new arrival gets its own check and card', async () => {
    const visits = [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '13:00:00' }];
    const ctx = ctxFor([baseLine(herbicide)], { windowStart: '13:00:00', arrival: new Date('2026-10-03T17:00:00Z') });
    const { out, alerts } = await sweepWith({ cards: [card()], visits, ctx,
      visitState: { 'visit-1': { scheduled_date: DAY, status: 'confirmed', window_start: '13:00:00' } } });
    expect(out).toMatchObject({ superseded: 1, carded: 1 });
    expect(alerts.filter((a) => !a.resolved_at).map((a) => a.payload.window_start)).toEqual(['13:00:00']);
    expect(alerts.find((a) => a.id === 'old-card').resolved_at).toBe('NOW');
  });

  test('an unchanged visit keeps its open card (no churn)', async () => {
    const visits = [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '09:00:00' }];
    const { out, alerts } = await sweepWith({ cards: [card()], visits,
      visitState: { 'visit-1': { scheduled_date: DAY, status: 'confirmed', window_start: '09:00:00' } } });
    expect(out).toMatchObject({ superseded: 0, carded: 0, duplicate: 1 });
    expect(alerts[0].resolved_at).toBeNull();
  });

  test('past-day, cancelled and deleted-visit cards are all superseded', async () => {
    const cards = [card({ for_date: '2026-10-02' }), { ...card(), id: 'c2', job_id: 'visit-2' }, { ...card(), id: 'c3', job_id: 'visit-3' }];
    const { out, alerts } = await sweepWith({ cards, visitState: {
      'visit-1': { scheduled_date: '2026-10-02', status: 'confirmed', window_start: '09:00:00' },
      'visit-2': { scheduled_date: DAY, status: 'cancelled', window_start: '09:00:00' },
    } });
    expect(out.superseded).toBe(3);
    expect(alerts.every((a) => a.resolved_at === 'NOW')).toBe(true);
  });

  test('a cleanup failure never stops the sweep', async () => {
    const alerts = [card({ window_start: '08:00:00' })];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    d.resolveAlert = jest.fn(async () => { throw new Error('boom'); });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts, visitState: {} }), now: NOW, deps: d });
    expect(out).toMatchObject({ superseded: 0, carded: 1 });
  });
});

describe('a transition that lands while the forecast loads leaves no card', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  const live = () => ({ id: 'visit-1', status: 'confirmed', scheduled_date: DAY, window_start: '09:00:00' });
  const transitions = {
    cancelled: { status: 'cancelled' },
    started: { status: 'on_site' },
    rescheduled: { status: 'rescheduled' },
    'moved to another day': { scheduled_date: '2026-10-06' },
    'time moved': { window_start: '14:00:00' },
  };

  test.each(Object.entries(transitions))('%s during the forecast read: nothing is published', async (name, change) => {
    const alerts = [];
    const visitState = { 'visit-1': live() };
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    d.fetchForecast = jest.fn(async () => { Object.assign(visitState['visit-1'], change); return forecast({ wind: 30 }); });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts, visitState }), now: NOW, deps: d });
    expect(out).toMatchObject({ held: 1, stale: 1, carded: 0 });
    expect(d.createAlert).not.toHaveBeenCalled();
    expect(alerts.filter((a) => !a.resolved_at)).toHaveLength(0);
  });

  test('a transition that commits after the pre-insert read is caught by the post-commit re-check', async () => {
    const alerts = [];
    const visitState = { 'visit-1': live() };
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    const insert = d.createAlert;
    d.createAlert = jest.fn(async (args) => { const row = await insert(args); visitState['visit-1'].status = 'cancelled'; return row; });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts, visitState }), now: NOW, deps: d });
    expect(out).toMatchObject({ stale: 1, carded: 0 });
    expect(d.resolveAlert).toHaveBeenCalledWith({ id: 'alert-1', auto: true });
    expect(alerts.filter((a) => !a.resolved_at)).toHaveLength(0);
  });

  test('on_site and every closed status are never queried', async () => {
    const alerts = [];
    const dbh = fakeDb({ alerts });
    await Sweep.runSweep({ dbh, now: NOW, deps: deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast(), alerts }) });
    const [col, statuses] = dbh.whereInCalls.find(([c]) => c === 's.status');
    expect(statuses).toEqual(['pending', 'confirmed', 'en_route']);
    expect(statuses).toBe(Sweep.OPEN_PRE_ARRIVAL_STATUSES);
    expect(col).toBe('s.status');
  });
});

describe('cardStillValid', () => {
  const fs = require('fs');
  const path = require('path');
  const { TERMINAL_SCHEDULED_SERVICE_STATUSES: T, NONTERMINAL_SCHEDULED_SERVICE_STATUSES: N } = require('../services/scheduled-service-statuses');
  // The status list comes from the code: the shared vocabulary, cross-checked against the CHECK constraint migration.
  const migration = fs.readFileSync(path.join(__dirname, '../models/migrations/20260615000005_scheduled_services_no_show_status.js'), 'utf8');
  const checkList = [...migration.slice(migration.indexOf('STATUS_VALUES')).split(']')[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const ALL = [...new Set([...N, ...T])];
  const card = { for_date: DAY, window_start: '09:00:00' };
  const visit = (over = {}) => ({ status: 'confirmed', scheduled_date: DAY, window_start: '09:00:00', ...over });

  test('the status list used here is the system\'s: shared vocabulary equals the CHECK constraint', () => {
    expect([...ALL].sort()).toEqual([...checkList].sort());
    expect(ALL.length).toBeGreaterThanOrEqual(9);
  });

  test.each(ALL)('status %s', (status) => {
    expect(Sweep.cardStillValid(visit({ status }), card)).toBe(['pending', 'confirmed', 'en_route'].includes(status));
  });

  test('missing visit, unknown or null status, another day, another window, a past day', () => {
    expect(Sweep.cardStillValid(null, card)).toBe(false);
    expect(Sweep.cardStillValid(visit({ status: null }), card)).toBe(false);
    expect(Sweep.cardStillValid(visit({ status: 'mystery' }), card)).toBe(false);
    expect(Sweep.cardStillValid(visit({ scheduled_date: '2026-10-04' }), card)).toBe(false);
    expect(Sweep.cardStillValid(visit({ window_start: '10:00:00' }), card)).toBe(false);
    expect(Sweep.cardStillValid(visit(), card, '2026-10-04')).toBe(false);
    expect(Sweep.cardStillValid(visit(), card, DAY)).toBe(true);
  });

  test('a date column returned as a Date, and a no-window visit, compare by calendar day and wall time', () => {
    expect(Sweep.cardStillValid(visit({ scheduled_date: new Date('2026-10-03T00:00:00Z') }), card)).toBe(true);
    expect(Sweep.cardStillValid(visit({ window_start: null }), { for_date: DAY, window_start: null })).toBe(true);
    expect(Sweep.cardStillValid(visit({ window_start: null }), card)).toBe(false);
  });
});

describe('hourly backstop runs: only upcoming visits, never a re-card', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  const at = (hhmmEt) => new Date(`2026-10-03T${String(Number(hhmmEt.slice(0, 2)) + 4).padStart(2, '0')}:${hhmmEt.slice(3)}:00Z`); // EDT = UTC-4
  const visitRow = (over = {}) => ({ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '09:00:00', window_end: null, estimated_duration_minutes: null, ...over });

  test('the "still upcoming" rule: the arrival window [start, start + its own length) has not ended', () => {
    const up = (visit, hhmm) => Sweep.visitStillUpcoming(visit, DAY, at(hhmm));
    expect(up(visitRow(), '05:41')).toBe(true);
    expect(up(visitRow(), '09:59')).toBe(true);          // no end booked: 60 min default
    expect(up(visitRow(), '10:00')).toBe(false);
    expect(up(visitRow(), '15:41')).toBe(false);         // the 3:41 PM run never cards a 9 AM visit
    expect(up(visitRow({ window_end: '11:00:00' }), '10:41')).toBe(true);   // a stored 2 h window
    expect(up(visitRow({ window_end: '11:00:00' }), '11:00')).toBe(false);
    expect(up(visitRow({ estimated_duration_minutes: 150 }), '11:00')).toBe(true); // else the visit's duration
    expect(up(visitRow({ window_start: null }), '12:41')).toBe(true);       // no window: noon + 60
    expect(up(visitRow({ window_start: null }), '13:00')).toBe(false);
    expect(up(visitRow({ window_start: '15:00:00' }), '15:41')).toBe(true);
  });

  test('a late run skips a morning visit that never started: no context read, no forecast read, no card', async () => {
    const alerts = [];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: at('15:41'), deps: d });
    expect(out).toMatchObject({ considered: 1, checked: 0, carded: 0 });
    expect(d.loadContext).not.toHaveBeenCalled();
    expect(d.fetchForecast).not.toHaveBeenCalled();
  });

  test('a visit moved onto today later is carded by a later run', async () => {
    const alerts = [];
    const visits = [visitRow({ window_start: '15:00:00' })];
    const ctx = ctxFor([baseLine(herbicide)], { windowStart: '15:00:00', arrival: new Date('2026-10-03T19:00:00Z') });
    const d = deps({ ctx, fc: forecast({ wind: 30 }), alerts });
    const out = await Sweep.runSweep({ dbh: fakeDb({ alerts, visits }), now: at('11:41'), deps: d });
    expect(out).toMatchObject({ carded: 1 });
  });

  test('a card a dispatcher RESOLVED by hand for the same date and window is never rewritten by a later run', async () => {
    const alerts = [{ id: 'hand-resolved', type: 'lawn_spray_hold', job_id: 'visit-1', resolved_at: '2026-10-03T12:00:00Z', resolved_by: 'tech-1',
      payload: { for_date: DAY, window_start: '09:00:00' } }];
    const d = deps({ ctx: ctxFor([baseLine(herbicide)]), fc: forecast({ wind: 30 }), alerts });
    for (const hhmm of ['07:41', '08:41']) {
      const out = await Sweep.runSweep({ dbh: fakeDb({ alerts }), now: at(hhmm), deps: d });
      expect(out).toMatchObject({ duplicate: 1, carded: 0 });
    }
    expect(alerts).toHaveLength(1);
    expect(d.fetchForecast).not.toHaveBeenCalled();
  });

  test('the cron is hourly at :41 from 5:41 to 15:41 ET, under the same lock and gate check', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    const i = src.indexOf("cron.schedule('41 5-15 * * *'");
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf("timezone: 'America/New_York'", i) + 40);
    expect(body).toMatch(/LawnPredaySprayCheck\.enabled\(\)\) return/);
    expect(body).toMatch(/runExclusive\('lawn-preday-spray-check'/);
    expect(body).toMatch(/timezone: 'America\/New_York'/);
  });
});

describe('one arrival drives the check, the forecast request, the card text and the schedule test', () => {
  beforeEach(() => { process.env.GATE_LAWN_PREDAY_SPRAY_CHECK = 'true'; jest.clearAllMocks(); });
  afterEach(() => { delete process.env.GATE_LAWN_PREDAY_SPRAY_CHECK; });

  const { sprayArrival } = require('../services/job-card');
  const etInstant = (hhmm) => new Date(`2026-10-03T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);

  test('sprayArrival: an upcoming visit starts at its window (or noon when none), never now; a window already begun starts now', () => {
    expect(sprayArrival(DAY, etInstant('05:41'), '14:00:00')).toEqual({ arrival: etInstant('14:00'), arrivalSource: 'window' });
    expect(sprayArrival(DAY, etInstant('05:41'), null)).toEqual({ arrival: etInstant('12:00'), arrivalSource: 'noon' });
    const now = etInstant('13:41');
    expect(sprayArrival(DAY, now, '13:00:00')).toEqual({ arrival: now, arrivalSource: 'now' });
    expect(sprayArrival(DAY, now, null)).toEqual({ arrival: now, arrivalSource: 'now' });
  });

  async function run({ hhmm, windowStart, windowEnd = null, wind = 30 }) {
    const now = etInstant(hhmm);
    const { arrival, arrivalSource } = sprayArrival(DAY, now, windowStart);
    const alerts = [];
    const d = deps({
      ctx: ctxFor([baseLine(herbicide)], { windowStart, arrival, arrivalSource }),
      fc: forecast({ wind, base: new Date(Math.floor(arrival.getTime() / HOUR) * HOUR) }),
      alerts,
    });
    const visits = [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: windowStart, window_end: windowEnd }];
    await Sweep.runSweep({ dbh: fakeDb({ alerts, visits }), now, deps: d });
    return { alerts, d, arrival };
  }

  test('morning run for a 2 PM visit: the interval starts at 2:00 PM, and the card and the forecast request say the same', async () => {
    const { alerts, d, arrival } = await run({ hhmm: '05:41', windowStart: '14:00:00' });
    expect(alerts[0].payload.lines[0]).toMatch(/^Sample Herbicide: hold\. Wind forecast up to 30 mph in the 4 h after the 2:00 PM arrival /);
    expect(d.fetchForecast.mock.calls[0][0].from).toBe(etInstant('14:00').getTime());
    expect(arrival).toEqual(etInstant('14:00'));
    expect(alerts[0].payload).toMatchObject({ window_start: '14:00:00', interval_from: 'window', interval_start: etInstant('14:00').toISOString() });
  });

  test('a 1:41 PM run for a 1-3 PM window (already begun): the interval starts now and the card says so, never naming 1:00 PM', async () => {
    const { alerts, d } = await run({ hhmm: '13:41', windowStart: '13:00:00', windowEnd: '15:00:00' });
    expect(alerts[0].payload.lines[0]).toMatch(/^Sample Herbicide: hold\. Wind forecast up to 30 mph in the 4 h from now /);
    expect(alerts[0].payload.lines[0]).not.toMatch(/1:00 PM|arrival/);
    // Hourly rows: the request starts at the top of the hour holding "now"; the booked window stays the card's identity.
    expect(d.fetchForecast.mock.calls[0][0].from).toBe(etInstant('13:00').getTime());
    expect(alerts[0].payload).toMatchObject({ window_start: '13:00:00', interval_from: 'now', interval_start: etInstant('13:41').toISOString() });
  });

  test('a visit with no window: noon is used for the weather AND named on the card', async () => {
    const { alerts, d } = await run({ hhmm: '05:41', windowStart: null });
    expect(alerts[0].payload.lines[0]).toMatch(/^Sample Herbicide: hold\. Wind forecast up to 30 mph in the 4 h after 12:00 PM \(no arrival window booked\) /);
    expect(d.fetchForecast.mock.calls[0][0].from).toBe(etInstant('12:00').getTime());
    expect(alerts[0].payload).toMatchObject({ window_start: null, interval_from: 'noon' });
  });

  test('rain inches are summed from the same start the card names', async () => {
    const now = etInstant('13:41');
    const alerts = [];
    const base = etInstant('13:00');
    // Rain lands in the slot stamped 15:00 (the hour 14-15): inside the 6 h from now.
    const d = deps({ ctx: ctxFor([baseLine(herbicide)], { windowStart: '13:00:00', arrival: now, arrivalSource: 'now' }), fc: forecast({ rain: { 2: 0.3 }, prob: 80, base }), alerts });
    await Sweep.runSweep({ dbh: fakeDb({ alerts, visits: [{ id: 'visit-1', service_type: 'Lawn Care Visit', window_start: '13:00:00' }] }), now, deps: d });
    expect(alerts[0].payload.lines[0]).toMatch(/0\.3 in of rain forecast in the 6 h from now/);
  });
});

