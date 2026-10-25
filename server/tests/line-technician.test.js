/**
 * Service-line map resolver + shadow recorder (GATE_SERVICE_LINE_MAP=shadow,
 * owner 2026-10-25). In-memory fake of the few tables it reads; synthetic names only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const defaultDb = require('../models/db');
const {
  serviceLineFor, resolveLineTechnician, recordLinePickShadow,
} = require('../services/scheduling/line-technician');

const OWNER = { id: 'tech-owner', name: 'Owner Tech', employment_status: 'active', field_dispatchable: true, work_days: null };
const HIRE = { id: 'tech-hire', name: 'New Hire', employment_status: 'active', field_dispatchable: true, work_days: [1, 2, 3, 4] };
// 2099-07-06 is a Monday; 2099-07-10 is a Friday.
const MONDAY = '2099-07-06';
const FRIDAY = '2099-07-10';

function fakeDb(state = {}) {
  const data = {
    services: state.services || [],
    service_line_techs: state.lines || [],
    technicians: state.techs || [OWNER, HIRE],
    technician_capabilities: state.caps || [],
    technician_absences: state.absences || [],
    scheduled_services: state.visits || [{ id: 'visit-1' }],
  };
  const inserts = [];
  const queries = [];
  const db = jest.fn((table) => {
    queries.push(table);
    let filters = [];
    const c = {
      where(arg, val) { filters.push(typeof arg === 'object' ? (r) => Object.entries(arg).every(([k, v]) => r[k] === v) : (r) => r[arg] === val); return c; },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return c; },
      whereBetween(col, [a, b]) { filters.push((r) => r[col] >= a && r[col] <= b); return c; },
      whereNull(col) { filters.push((r) => r[col] == null); return c; },
      select() { return Promise.resolve((data[table] || []).filter((r) => filters.every((f) => f(r)))); },
      first() { return Promise.resolve((data[table] || []).filter((r) => filters.every((f) => f(r)))[0]); },
      insert(row) {
        if (state.failInsert) return Promise.reject(new Error('insert failed'));
        inserts.push({ table, row });
        return Promise.resolve([row]);
      },
      then(res, rej) { return c.select().then(res, rej); },
    };
    return c;
  });
  db.inserts = inserts;
  db.queries = queries;
  return db;
}

const LINES = [
  { service_category: 'general', home_technician_id: HIRE.id, gap_technician_id: OWNER.id },
  { service_category: 'lawn', home_technician_id: OWNER.id, gap_technician_id: null },
];

beforeEach(() => {
  defaultDb.mockReset();
  delete process.env.GATE_TECH_WORK_DAYS;
  delete process.env.GATE_SERVICE_LINE_MAP;
});
afterAll(() => {
  delete process.env.GATE_TECH_WORK_DAYS;
  delete process.env.GATE_SERVICE_LINE_MAP;
});

describe('serviceLineFor', () => {
  test('the catalog category wins over the name: a tree_shrub palm row and a lawn_care top-dress row read lawn', async () => {
    const db = fakeDb({ services: [
      { id: 'svc-palm', service_key: 'palm_x', category: 'tree_shrub' },
      { id: 'svc-top', service_key: 'top_dress_x', category: 'lawn_care' },
    ] });
    expect(await serviceLineFor(db, { serviceId: 'svc-palm', serviceType: 'Palm Tree Nutritional Treatment' }))
      .toEqual({ line: 'lawn', lineFrom: 'catalog' });
    expect(await serviceLineFor(db, { serviceKey: 'top_dress_x', serviceType: 'Top Dress' }))
      .toEqual({ line: 'lawn', lineFrom: 'catalog' });
  });

  test('without the catalog, the name decides; the palm / top-dress names alone still read general (auto-dispatch classifier, unchanged)', async () => {
    const db = fakeDb();
    expect(await serviceLineFor(db, { serviceType: 'Palm Tree Nutritional Treatment' })).toEqual({ line: 'general', lineFrom: 'name' });
    expect(await serviceLineFor(db, { serviceType: 'Lawn Care Visit' })).toEqual({ line: 'lawn', lineFrom: 'name' });
  });

  test.each([
    ['pest_control', 'general'], ['mosquito', 'mosquito'], ['lawn_care', 'lawn'],
    ['tree_shrub', 'lawn'], ['rodent', 'rodent'], ['termite', 'termite'],
  ])('catalog category %s reads %s', async (category, line) => {
    const db = fakeDb({ services: [{ id: 's1', service_key: 'k1', category }] });
    expect(await serviceLineFor(db, { serviceId: 's1', serviceType: 'Unrelated Name' })).toEqual({ line, lineFrom: 'catalog' });
  });

  test('inspection / specialty / other catalog rows fall back to the name', async () => {
    const db = fakeDb({ services: [
      { id: 'i1', service_key: 'wdo_inspection', category: 'inspection' },
      { id: 'i2', service_key: 'lawn_inspection', category: 'specialty' },
      { id: 'i3', service_key: 'misc', category: 'other' },
    ] });
    expect(await serviceLineFor(db, { serviceId: 'i1', serviceType: 'WDO Inspection' })).toEqual({ line: 'termite', lineFrom: 'name' });
    expect(await serviceLineFor(db, { serviceId: 'i2', serviceType: 'Lawn Inspection' })).toEqual({ line: 'lawn', lineFrom: 'name' });
    expect(await serviceLineFor(db, { serviceId: 'i3', serviceType: 'Rodent Exclusion' })).toEqual({ line: 'rodent', lineFrom: 'name' });
  });

  test('service id first, then service key; no id, key, or name = no line', async () => {
    const db = fakeDb({ services: [{ id: 'a', service_key: 'ka', category: 'mosquito' }] });
    expect(await serviceLineFor(db, { serviceId: 'missing', serviceKey: 'ka' })).toEqual({ line: 'mosquito', lineFrom: 'catalog' });
    expect(await serviceLineFor(db, {})).toEqual({ line: null, lineFrom: null });
  });

  test('an unreadable catalog falls to the name instead of throwing', async () => {
    const db = jest.fn(() => { throw new Error('boom'); });
    expect(await serviceLineFor(db, { serviceId: 'x', serviceType: 'Mosquito Control' })).toEqual({ line: 'mosquito', lineFrom: 'name' });
  });
});

describe('resolveLineTechnician', () => {
  const ask = (db, extra = {}) => resolveLineTechnician(db, { serviceType: 'General Pest Control', date: MONDAY, ...extra });

  test('the home tech takes the line when assignable, present, working and capable', async () => {
    const out = await ask(fakeDb({ lines: LINES }));
    expect(out).toMatchObject({ line: 'general', lineFrom: 'name', homeId: HIRE.id, gapId: OWNER.id, technicianId: HIRE.id, reason: 'home' });
  });

  test('home off day (gate on) -> the gap tech, gap_off_day', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const out = await ask(fakeDb({ lines: LINES }), { date: FRIDAY });
    expect(out).toMatchObject({ technicianId: OWNER.id, homeId: HIRE.id, reason: 'gap_off_day' });
  });

  test('home off day with the work-days gate off is not an off day (the existing rule is reused, not re-invented)', async () => {
    const out = await ask(fakeDb({ lines: LINES }), { date: FRIDAY });
    expect(out).toMatchObject({ technicianId: HIRE.id, reason: 'home' });
  });

  test('home marked out that date -> gap_absent; a cleared absence does not count', async () => {
    const absent = fakeDb({ lines: LINES, absences: [{ technician_id: HIRE.id, absence_date: MONDAY, cleared_at: null }] });
    expect(await ask(absent)).toMatchObject({ technicianId: OWNER.id, reason: 'gap_absent' });
    const cleared = fakeDb({ lines: LINES, absences: [{ technician_id: HIRE.id, absence_date: MONDAY, cleared_at: new Date() }] });
    expect(await ask(cleared)).toMatchObject({ technicianId: HIRE.id, reason: 'home' });
  });

  test('home capability Off for the line -> gap_capability_off; review_required and unset still count as capable', async () => {
    const off = fakeDb({ lines: LINES, caps: [{ technician_id: HIRE.id, service_category: 'general', capability_level: 'qualified', active: false }] });
    expect(await ask(off)).toMatchObject({ technicianId: OWNER.id, reason: 'gap_capability_off' });
    const review = fakeDb({ lines: LINES, caps: [{ technician_id: HIRE.id, service_category: 'general', capability_level: 'review_required', active: true }] });
    expect(await ask(review)).toMatchObject({ technicianId: HIRE.id, reason: 'home' });
  });

  test('home not assignable (prospective) -> gap_not_assignable', async () => {
    const db = fakeDb({ lines: LINES, techs: [{ ...HIRE, employment_status: 'prospective' }, OWNER] });
    expect(await ask(db)).toMatchObject({ technicianId: OWNER.id, reason: 'gap_not_assignable' });
  });

  test('home missing from the map but a gap set -> the gap tech, gap_not_assignable', async () => {
    const db = fakeDb({ lines: [{ service_category: 'general', home_technician_id: null, gap_technician_id: OWNER.id }] });
    expect(await ask(db)).toMatchObject({ technicianId: OWNER.id, reason: 'gap_not_assignable' });
  });

  test('neither can take it -> no technician, reason none', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const db = fakeDb({ lines: LINES, absences: [{ technician_id: OWNER.id, absence_date: FRIDAY, cleared_at: null }] });
    expect(await ask(db, { date: FRIDAY })).toMatchObject({ technicianId: null, homeId: HIRE.id, reason: 'none' });
  });

  test('no row for the line, empty row, or no line at all -> no_map', async () => {
    expect(await ask(fakeDb({ lines: [] }))).toMatchObject({ technicianId: null, reason: 'no_map', line: 'general' });
    const empty = fakeDb({ lines: [{ service_category: 'general', home_technician_id: null, gap_technician_id: null }] });
    expect(await ask(empty)).toMatchObject({ technicianId: null, reason: 'no_map' });
    expect(await resolveLineTechnician(fakeDb({ lines: LINES }), { date: MONDAY })).toMatchObject({ line: null, reason: 'no_map' });
  });

  test('reads only', async () => {
    const db = fakeDb({ lines: LINES });
    await ask(db);
    expect(db.inserts).toEqual([]);
  });
});

describe('recordLinePickShadow', () => {
  const base = {
    source: 'book', scheduledServiceId: 'visit-1', customerId: 'cust-1', date: MONDAY, windowStart: '09:00',
    serviceType: 'General Pest Control', actualTechnicianId: OWNER.id,
  };

  test('gate off: returns at once, no resolver call, no query', async () => {
    defaultDb.mockImplementation(() => { throw new Error('must not query'); });
    expect(await recordLinePickShadow(base)).toBeNull();
    expect(defaultDb).not.toHaveBeenCalled();
  });

  test('"true" is not a value yet: still off', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'true';
    await recordLinePickShadow(base);
    expect(defaultDb).not.toHaveBeenCalled();
  });

  test('shadow: one row with the actual and the would-be technician and the reason', async () => {
    process.env.GATE_SERVICE_LINE_MAP = ' Shadow ';
    const db = fakeDb({ lines: LINES });
    defaultDb.mockImplementation(db);
    await recordLinePickShadow({ ...base, runId: 'run-9' });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ table: 'service_line_pick_shadow', row: {
      source: 'book', scheduled_service_id: 'visit-1', customer_id: 'cust-1', visit_date: MONDAY, window_start: '09:00',
      run_id: 'run-9', service_type: 'General Pest Control', service_line: 'general', line_from: 'name',
      actual_technician_id: OWNER.id, would_technician_id: HIRE.id, would_reason: 'home', home_technician_id: HIRE.id,
    } });
    // The multi-tech occupancy scope is off here, so "free" cannot be told: left null.
    expect(db.inserts[0].row.would_free).toBeNull();
  });

  test('a Date value for the visit date is written as the calendar date', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    const db = fakeDb({ lines: LINES });
    defaultDb.mockImplementation(db);
    await recordLinePickShadow({ ...base, date: new Date(`${MONDAY}T12:00:00-04:00`) });
    expect(db.inserts[0].row.visit_date).toBe(MONDAY);
  });

  test('an unknown source writes nothing', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    await recordLinePickShadow({ ...base, source: 'somewhere_else' });
    expect(defaultDb).not.toHaveBeenCalled();
  });

  test('an insert failure is swallowed: it never throws and never rejects', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    defaultDb.mockImplementation(fakeDb({ lines: LINES, failInsert: true }));
    await expect(recordLinePickShadow(base)).resolves.toBeNull();
  });

  test('a resolver failure still logs the row, with reason error', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    const good = fakeDb({ lines: LINES });
    defaultDb.mockImplementation((table) => {
      if (table === 'service_line_techs') throw new Error('read failed');
      return good(table);
    });
    await recordLinePickShadow({ ...base, serviceType: 'x' });
    expect(good.inserts[0].row).toMatchObject({ would_reason: 'error', would_technician_id: null });
  });

  test('inside a caller transaction the write waits for the OUTERMOST commit, and a rollback writes nothing', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    const db = fakeDb({ lines: LINES });
    defaultDb.mockImplementation(db);
    let commit;
    const committed = new Promise((resolve) => { commit = resolve; });
    const outer = { executionPromise: committed };
    const savepoint = { parentTransaction: outer, executionPromise: Promise.resolve() };
    await recordLinePickShadow({ ...base, trx: savepoint });
    await new Promise((r) => setImmediate(r));
    expect(db.inserts).toHaveLength(0);
    commit();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(db.inserts).toHaveLength(1);

    const rolled = fakeDb({ lines: LINES });
    defaultDb.mockImplementation(rolled);
    const failed = { executionPromise: Promise.reject(new Error('rolled back')) };
    await recordLinePickShadow({ ...base, trx: failed });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(rolled.inserts).toHaveLength(0);
  });

  test('a bare trx.rollback() resolves the commit promise: the visit is then unreadable, so nothing is written', async () => {
    process.env.GATE_SERVICE_LINE_MAP = 'shadow';
    const db = fakeDb({ lines: LINES, visits: [] });
    defaultDb.mockImplementation(db);
    await recordLinePickShadow({ ...base, trx: { executionPromise: Promise.resolve() } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(db.inserts).toHaveLength(0);
  });
});
