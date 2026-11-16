/**
 * GATE_DAY_ONLY_PROMISE part C1: the token appointment page, its calendar file and its confirm POST
 * (routes/appointment-public.js). loadTimeDisplay (part B1) is mocked: it is the one decision.
 */
const mockLoadTimeDisplay = jest.fn();
jest.mock('../services/time-promise', () => ({ loadTimeDisplay: (...args) => mockLoadTimeDisplay(...args) }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  buildServiceLabel: jest.fn(async (_id, name) => name || 'service'),
}));

const mockState = { svc: null, updated: 1 };
function chain(table) {
  const api = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNot', 'orderBy', 'leftJoin', 'forUpdate']) api[m] = () => api;
  api.first = async () => (table.startsWith('scheduled_services') ? mockState.svc : null);
  api.select = async () => [];
  api.update = async () => mockState.updated;
  api.insert = async () => [];
  return api;
}
const mockDb = jest.fn((table) => chain(table));
mockDb.raw = (sql) => sql;
mockDb.fn = { now: () => 'now()' };
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);

const express = require('express');
const router = require('../routes/appointment-public');

const TOKEN = 'a'.repeat(64);
const NOTE = 'Arrival window texted the day before';
const svcRow = (overrides = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', status: 'pending', visit_id: null, customer_active: true, customer_deleted_at: null,
  scheduled_date: '2099-01-12', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Pest Control',
  reschedule_token: 'r'.repeat(64), is_recurring: false, source_action: null, customer_confirmed: false,
  customer_pick_by: null, technician_id: null,
  ...overrides,
});

// The live members of one grouped stop, read through db('scheduled_services').select().
const memberRow = (id, start, end) => ({
  id, status: 'pending', source_action: null, customer_confirmed: false, scheduled_date: '2099-01-12',
  window_start: start, window_end: end, technician_id: null,
});
const CHAINED = [memberRow('svc-1', '09:00:00', '11:00:00'), memberRow('svc-2', '11:00:00', '13:00:00')];
async function withMembers(members, fn) {
  mockDb.mockImplementation((table) => {
    const api = chain(table);
    if (table === 'scheduled_services') api.select = async () => members;
    return api;
  });
  try {
    return await fn();
  } finally {
    mockDb.mockImplementation((table) => chain(table));
  }
}

function dayOnly(...ids) {
  mockLoadTimeDisplay.mockImplementation(async (_conn, rows) => new Map(rows.map((r) => [
    r.id, { showHour: !ids.includes(r.id), level: 'none', eligible: ids.includes(r.id) },
  ])));
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/public/appointment', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/public/appointment`); } finally { await new Promise((r) => server.close(r)); }
}

const prevGate = process.env.GATE_APPOINTMENT_PAGE;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_APPOINTMENT_PAGE = 'true';
  mockState.svc = svcRow();
  mockState.updated = 1;
});
afterAll(() => {
  if (prevGate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevGate;
});

describe('GET /:token (the appointment page payload)', () => {
  const getPage = () => withServer(async (base) => (await fetch(`${base}/${TOKEN}`)).json());

  test('day-only: no hour field, day_only + note on the appointment, one call', async () => {
    dayOnly('svc-1');
    const body = await getPage();
    expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(body.state).toBe('upcoming');
    expect(body.appointment).toEqual({
      date: '2099-01-12', windowStart: null, arrivalWindow: null, day_only: true, arrival_note: NOTE,
    });
    expect(JSON.stringify(body)).not.toMatch(/9:00|09:00|11:00/);
  });

  test('customer-picked, inside the cutoff or gate off: today\'s payload, no new key', async () => {
    dayOnly();
    const body = await getPage();
    expect(body.appointment).toEqual({ date: '2099-01-12', windowStart: '09:00', arrivalWindow: '9:00 AM - 11:00 AM' });
  });

  test('a loadTimeDisplay failure shows the hour', async () => {
    mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
    const body = await getPage();
    expect(body.appointment).toEqual({ date: '2099-01-12', windowStart: '09:00', arrivalWindow: '9:00 AM - 11:00 AM' });
  });

  test('a grouped stop blanks the stop\'s start too', async () => {
    dayOnly('svc-1', 'svc-2');
    mockState.svc = svcRow({ visit_id: 'visit-1' });
    // The stop has two live members; the page reads them through db('scheduled_services').select().
    const members = [
      { id: 'svc-1', status: 'pending', source_action: null, customer_confirmed: false, scheduled_date: '2099-01-12', window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
      { id: 'svc-2', status: 'pending', source_action: null, customer_confirmed: false, scheduled_date: '2099-01-12', window_start: '09:00:00', window_end: '11:00:00', technician_id: null },
    ];
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'scheduled_services') api.select = async () => members;
      return api;
    });
    const body = await getPage();
    mockDb.mockImplementation((table) => chain(table));
    expect(body.service.visit).toBeTruthy();
    expect(body.service.visit.windowStart).toBeNull();
    expect(body.appointment.windowStart).toBeNull();
    expect(body.appointment.arrivalWindow).toBeNull();
  });

  // Chained members of one stop (local codex audit on C1, P1): 09:00-11:00 then 11:00-13:00. The page promises the
  // stop's 09:00 arrival, so the stop is judged at 09:00 and as a whole: every link to it must agree.
  test('a grouped stop is judged as a whole: every member, at the stop\'s earliest start, in one read', async () => {
    dayOnly('svc-1', 'svc-2');
    mockState.svc = svcRow({ id: 'svc-2', visit_id: 'visit-1', window_start: '11:00:00', window_end: '13:00:00' });
    mockLoadTimeDisplay.mockClear();
    const body = await withMembers(CHAINED, getPage);
    expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(mockLoadTimeDisplay.mock.calls[0][1].map((r) => [r.id, r.window_start])).toEqual([['svc-2', '09:00'], ['svc-1', '09:00']]);
    expect(body.appointment.windowStart).toBeNull();
    expect(body.appointment.day_only).toBe(true);
  });

  test('one member that still shows its hour makes the whole stop show it, on every member\'s link', async () => {
    dayOnly('svc-2'); // the 09:00 member is inside the cutoff (or was told an hour)
    for (const [id, start, end] of [['svc-1', '09:00:00', '11:00:00'], ['svc-2', '11:00:00', '13:00:00']]) {
      mockState.svc = svcRow({ id, visit_id: 'visit-1', window_start: start, window_end: end });
      const body = await withMembers(CHAINED, getPage);
      expect(body.appointment.day_only).toBeUndefined();
      expect(body.appointment.arrivalWindow).toBe('9:00 AM - 11:00 AM');
      expect(body.service.visit.windowStart).toBe('09:00');
    }
  });
});

describe('GET /:token/calendar.ics', () => {
  const getIcs = () => withServer(async (base) => {
    const res = await fetch(`${base}/${TOKEN}/calendar.ics`);
    return { status: res.status, text: await res.text() };
  });
  const uidOf = (text) => /^UID:(.*)$/m.exec(text)[1];

  test('day-only: an all-day event with the day-before description, and the SAME uid as the timed event', async () => {
    dayOnly('svc-1');
    const dayOnlyFile = await getIcs();
    expect(dayOnlyFile.status).toBe(200);
    expect(dayOnlyFile.text).toContain('DTSTART;VALUE=DATE:20990112');
    expect(dayOnlyFile.text).toContain('DTEND;VALUE=DATE:20990113');
    expect(dayOnlyFile.text).not.toMatch(/^DTSTART:/m);
    expect(dayOnlyFile.text).toContain("DESCRIPTION:We'll text your arrival window the day before.");
    expect(dayOnlyFile.text).not.toMatch(/2-hour window|T\d{6}Z\r?\nDTEND/);

    dayOnly();
    const timed = await getIcs();
    expect(timed.status).toBe(200);
    expect(timed.text).toMatch(/^DTSTART:20990112T140000Z$/m);
    expect(timed.text).toMatch(/^DTEND:20990112T160000Z$/m);
    expect(timed.text).toContain('Your technician arrives any time inside this 2-hour window');
    expect(uidOf(timed.text)).toBe(uidOf(dayOnlyFile.text));
    expect(uidOf(timed.text)).toBe('visit-svc-1@wavespestcontrol.com');
  });

  test('an all-day event on the last day of a month ends on the first of the next', async () => {
    dayOnly('svc-1');
    mockState.svc = svcRow({ scheduled_date: '2099-01-31' });
    const { text } = await getIcs();
    expect(text).toContain('DTSTART;VALUE=DATE:20990131');
    expect(text).toContain('DTEND;VALUE=DATE:20990201');
  });
});

describe('POST /:token/confirm', () => {
  const confirm = (body) => withServer(async (base) => {
    const res = await fetch(`${base}/${TOKEN}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  });

  test('the blank hour a day-only page echoes still confirms the visit\'s current slot', async () => {
    dayOnly('svc-1');
    const out = await confirm({ date: '2099-01-12', windowStart: null, membershipKey: null });
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
  });

  test('a blank hour on the wrong day is refused CHANGED', async () => {
    dayOnly('svc-1');
    const out = await confirm({ date: '2099-01-13', windowStart: null, membershipKey: null });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('CHANGED');
  });

  test('a blank hour for a visit that now shows its hour is refused CHANGED (the page reloads)', async () => {
    dayOnly();
    const out = await confirm({ date: '2099-01-12', windowStart: null, membershipKey: null });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('CHANGED');
  });

  test('a page that echoed an hour is compared as before', async () => {
    dayOnly();
    expect((await confirm({ date: '2099-01-12', windowStart: '09:00', membershipKey: null })).status).toBe(200);
    expect((await confirm({ date: '2099-01-12', windowStart: '10:00', membershipKey: null })).status).toBe(409);
  });
});
