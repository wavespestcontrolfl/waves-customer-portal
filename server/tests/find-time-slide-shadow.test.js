/**
 * find-time slide shadow (GATE_SLOT_SLIDE_OFFER phase 1): with the gate on,
 * a customer-facing (packEnds) call logs what a slide could offer on each
 * tech-day; the offered slots stay exactly what they were. Gate off, the
 * scheduled_services read selects no extra columns and nothing is logged.
 * Synthetic coordinates (real ones are PII), shaped like the 10-24 day.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { findAvailableSlots, _resetSlideShadowSample } = require('../services/scheduling/find-time');
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const ENV_KEYS = ['GATE_SLOT_SLIDE_OFFER', 'GATE_DRIVE_TIME_CALIBRATION', 'GATE_SLOT_TRAVEL_GAP'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  jest.clearAllMocks();
  clearExpectedServiceMinutesCache();
  _resetSlideShadowSample();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
// The shadow pass stops at a 50 ms wall-clock ceiling (find-time.js
// SLIDE_SHADOW_MAX_MS, checked against Date.now in slide-offer.js). A loaded
// CI runner can use that up before the pass finds its slide, and then nothing
// is logged, so every test holds the clock still; the ceiling's own test moves it.
let clock;
let nowSpy;
beforeEach(() => {
  clock = Date.now();
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => nowSpy.mockRestore());

const selects = [];
function chain(result, table) {
  const c = {};
  ['whereNotNull', 'whereNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first', 'orWhereRaw'].forEach((m) => { c[m] = () => c; });
  c.select = async (...cols) => { selects.push({ table, cols: cols.map(String) }); return result; };
  return c;
}

function nextSaturday(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() !== 6);
  return date.toISOString().slice(0, 10);
}
const DATE = nextSaturday(Date.now()); // within the 14-day shadow bound
const LNG = -82.45;
const row = (id, lat, hour) => ({
  id, scheduled_date: DATE, technician_id: 't1',
  window_start: `${String(hour).padStart(2, '0')}:00`, window_end: `${String(hour + 1).padStart(2, '0')}:00`,
  service_type: 'pest_control', service_key_snapshot: null, estimated_duration_minutes: null,
  svc_lat: lat, svc_lng: LNG, cust_lat: null, cust_lng: null,
  first_name: 'Existing', last_name: 'Stop', city: 'Sarasota',
  status: 'confirmed', customer_id: `c-${id}`, reservation_expires_at: null,
  auto_dispatch_locked: false, auto_dispatch_excluded: false,
});
const STOPS = [
  row('a', 27.05, 8), row('b', 27.06, 9), row('c', 27.14, 10),
  row('d', 27.42, 11), row('e', 27.32, 12), row('f', 27.41, 15),
];

function wireDb() {
  selects.length = 0;
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(STOPS, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
}

// A 30-minute expected visit inside each 60-minute window (catalog min=max=30):
// the slack absorbs the 15-minute buffer, so a leg only needs its drive.
const CATALOG = [{
  service_key: 'quarterly_pest', name: 'pest_control',
  min_duration_minutes: 30, max_duration_minutes: 30, default_duration_minutes: null,
}];

const CALL = {
  lat: 27.18, lng: LNG, durationMinutes: 60, dateFrom: DATE, dateTo: DATE,
  topN: 200, includeWeekends: false, packEnds: true, includeBlackoutDates: true,
  serviceType: 'pest_control', bufferMinutes: 15, customerFacing: true,
  slideNewStartAllowed: () => true,
};

const shadowLines = () => logger.info.mock.calls.map(([m]) => m).filter((m) => String(m).startsWith('[slot-slide] shadow'));

test('gate on: logs the 11 AM slide and leaves the offered slots untouched', async () => {
  wireDb();
  const off = await findAvailableSlots(CALL);
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  _resetSlideShadowSample();
  const on = await findAvailableSlots(CALL);

  expect(on.slots).toEqual(off.slots);
  const lines = shadowLines();
  expect(lines).toHaveLength(1);
  const payload = JSON.parse(lines[0].replace('[slot-slide] shadow ', ''));
  expect(payload).toMatchObject({ date: DATE, techId: 't1', slideStart: '11:00' });
  expect(payload.slides).toEqual([{ id: 'd', from: '11:00', to: '13:00' }]);
  expect(lines[0]).not.toMatch(/Existing|Stop|Sarasota/);
});

const svcSelects = () => selects.filter((x) => x.table === 'scheduled_services');

test('the main find-time read is identical with the gate on; movability comes from its own read', async () => {
  wireDb();
  await findAvailableSlots(CALL);
  const offReads = svcSelects().map((x) => x.cols);
  expect(offReads).toHaveLength(1);
  expect(shadowLines()).toHaveLength(0);

  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  const onReads = svcSelects().map((x) => x.cols);
  expect(onReads[0]).toEqual(offReads[0]);
  expect(onReads[1]).toEqual(expect.arrayContaining(['status', 'track_state', 'visit_id', 'auto_dispatch_locked']));
});

test('a failed movability read only switches the shadow off — real slots are unchanged', async () => {
  wireDb();
  const baseline = await findAvailableSlots(CALL);
  let svcCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'services') return chain(CATALOG, table);
    if (table === 'scheduled_services') {
      svcCalls += 1;
      if (svcCalls === 1) return chain(STOPS, table);
      const c = chain([], table);
      c.select = async () => { throw new Error('column "track_sms_sent_at" does not exist'); };
      return c;
    }
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  const result = await findAvailableSlots(CALL);
  expect(result.slots).toEqual(baseline.slots);
  expect(shadowLines()).toHaveLength(0);
  expect(logger.warn.mock.calls.map(([m]) => m).join('\n')).toMatch(/\[slot-slide\] shadow off/);
});

test('gate on but a staff (non-packEnds) caller: no shadow pass', async () => {
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots({ ...CALL, packEnds: false });
  expect(shadowLines()).toHaveLength(0);
});

test('a staff-locked 11 AM stop is never named as a slide', async () => {
  wireDb();
  const locked = STOPS.map((s) => (s.id === 'd' ? { ...s, auto_dispatch_locked: true } : s));
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(locked, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  for (const line of shadowLines()) {
    const payload = JSON.parse(line.replace('[slot-slide] shadow ', ''));
    expect(payload.slides.map((s) => s.id)).not.toContain('d');
  }
});

test('days past the 14-day shadow bound are not searched', async () => {
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  const far = nextSaturday(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const farStops = STOPS.map((s) => ({ ...s, scheduled_date: far }));
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(farStops, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  await findAvailableSlots({ ...CALL, dateFrom: far, dateTo: far });
  expect(shadowLines()).toHaveLength(0);
});

test('a member of a version-2 combined allocation is never named as a slide', async () => {
  const mix = { version: 2, allocatedServiceIds: ['d', 'd2'] };
  const grouped = [...STOPS.map((s) => (s.id === 'd' ? { ...s, reservation_service_mix: mix } : s)),
    { ...row('d2', 27.42, 11), customer_id: 'c-d', reservation_service_mix: mix }];
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(grouped, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  for (const line of shadowLines()) {
    const ids = JSON.parse(line.replace('[slot-slide] shadow ', '')).slides.map((s) => s.id);
    expect(ids).not.toContain('d');
    expect(ids).not.toContain('d2');
  }
});

test('a plain single-service reservation_service_mix (estimate-booked visit) can still slide', async () => {
  const single = STOPS.map((s) => (s.id === 'd' ? { ...s, reservation_service_mix: { version: 1, services: ['quarterly_pest'] } } : s));
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(single, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  const payload = JSON.parse(shadowLines()[0].replace('[slot-slide] shadow ', ''));
  expect(payload.slides).toEqual([{ id: 'd', from: '11:00', to: '13:00' }]);
});

test('members of a grouped visit (shared visit_id) are never slid', async () => {
  const grouped = [...STOPS.map((s) => (s.id === 'd' ? { ...s, visit_id: 'v1' } : s)),
    { ...row('d2', 27.42, 11), visit_id: 'v1' }];
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(grouped, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  expect(svcSelects()[1].cols).toContain('visit_id');
  for (const line of shadowLines()) {
    const ids = JSON.parse(line.replace('[slot-slide] shadow ', '')).slides.map((s) => s.id);
    expect(ids).not.toContain('d');
    expect(ids).not.toContain('d2');
  }
});

test('a single-row visit_id does not block a slide', async () => {
  const single = STOPS.map((s) => (s.id === 'd' ? { ...s, visit_id: 'v-solo' } : s));
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(single, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  const payload = JSON.parse(shadowLines()[0].replace('[slot-slide] shadow ', ''));
  expect(payload.slides).toEqual([{ id: 'd', from: '11:00', to: '13:00' }]);
});

test('a packEnds caller that is not explicitly customerFacing (voice agent) gets no shadow pass', async () => {
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots({ ...CALL, customerFacing: false });
  expect(shadowLines()).toHaveLength(0);
  expect(svcSelects()).toHaveLength(1);
});

test('sampled: a second request inside the interval runs no shadow pass', async () => {
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  wireDb();
  await findAvailableSlots(CALL);
  wireDb();
  await findAvailableSlots(CALL);
  expect(shadowLines()).toHaveLength(1);
});

test('the 50 ms ceiling: a pass that runs out of time logs nothing and the offered slots are unchanged', async () => {
  wireDb();
  const off = await findAvailableSlots(CALL);
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  _resetSlideShadowSample();
  // Each clock read lands 60 ms after the last, so the pass is past its ceiling at its first check.
  nowSpy.mockImplementation(() => (clock += 60));
  const on = await findAvailableSlots(CALL);

  expect(on.slots).toEqual(off.slots);
  expect(svcSelects()).toHaveLength(2); // the pass ran (its movability read) and ran out of time
  expect(shadowLines()).toHaveLength(0);
});

const runWith = async (rows) => {
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(rows, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  return shadowLines().map((l) => JSON.parse(l.replace('[slot-slide] shadow ', '')).slides.map((x) => x.id));
};

test('tracker evidence of a visit under way blocks a slide even when status still says confirmed', async () => {
  selects.length = 0;
  for (const evidence of [{ track_state: 'en_route' }, { en_route_at: new Date() }, { track_sms_sent_at: new Date() }]) {
    _resetSlideShadowSample();
    logger.info.mockClear();
    const ids = await runWith(STOPS.map((x) => (x.id === 'd' ? { ...x, ...evidence } : x)));
    for (const slid of ids) expect(slid).not.toContain('d');
  }
  expect(svcSelects().some((x) => x.cols.includes('track_state') && x.cols.includes('en_route_at'))).toBe(true);
});

test('a committed visit with a stray reservation_expires_at can still slide', async () => {
  const ids = await runWith(STOPS.map((x) => (x.id === 'd'
    ? { ...x, reservation_expires_at: new Date(Date.now() + 3600000) } : x)));
  expect(ids[0]).toEqual(['d']);
});

test('the caller\'s own start rule (daypart / notice / funnel) binds the logged slide start', async () => {
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  const startsFor = async (slideNewStartAllowed) => {
    _resetSlideShadowSample();
    logger.info.mockClear();
    wireDb();
    await findAvailableSlots({ ...CALL, slideNewStartAllowed });
    return shadowLines().map((l) => JSON.parse(l.replace('[slot-slide] shadow ', '')).slideStart);
  };
  // Positive control: a rule that allows everything → the 11 AM slide.
  expect(await startsFor(() => true)).toEqual(['11:00']);
  // An afternoon-only (or notice-window) rule: the morning slide is never logged.
  for (const start of await startsFor((d, m) => m >= 12 * 60)) expect(Number(start.slice(0, 2))).toBeGreaterThanOrEqual(12);
  // A rule that hides the whole date (zone-day funnel): nothing is logged.
  expect(await startsFor(() => false)).toEqual([]);
});


test('a day another technician also works is not scored (one-technician days only)', async () => {
  const rows = [...STOPS, { ...row('t2stop', 27.30, 14), technician_id: 't2' }];
  db.mockImplementation((table) => {
    if (table === 'technicians') return chain([{ id: 't1', name: 'Tech' }], table);
    if (table === 'scheduled_services') return chain(rows, table);
    if (table === 'services') return chain(CATALOG, table);
    return chain([], table);
  });
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  await findAvailableSlots(CALL);
  expect(shadowLines()).toHaveLength(0);
});

test('a customerFacing caller that passes no start rule (admin slot debug) never claims the sample', async () => {
  wireDb();
  process.env.GATE_SLOT_SLIDE_OFFER = 'true';
  const { slideNewStartAllowed, ...debugCall } = CALL;
  await findAvailableSlots(debugCall);
  expect(shadowLines()).toHaveLength(0);
  expect(svcSelects()).toHaveLength(1);
  // ...and the sample is still free for the next real customer request.
  wireDb();
  await findAvailableSlots(CALL);
  expect(shadowLines()).toHaveLength(1);
});
