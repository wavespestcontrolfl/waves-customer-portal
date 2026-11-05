/**
 * An UNASSIGNED pest visit's current placement under GATE_TERRITORY_NIGHT_RUN
 * uses the same technicians candidate admission does: with a territory
 * technician, only that technician's slots become candidates
 * (drops.other_territory), so the shared-model baseline is read on that
 * technician's day too. A closer route the visit may not take would set a
 * bar no legal move can beat, and the night run would keep the visit where
 * it is.
 *
 * Gate off, a visit with a technician, or a ZIP with no territory
 * technician: the baseline keeps the closest assignable route, as before.
 *
 * Real drive estimates (no route-optimizer mock). Synthetic coordinates only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));
jest.mock('../services/scheduling/line-technician', () => ({ liveServiceLine: jest.fn() }));
jest.mock('../services/territory', () => ({
  ...jest.requireActual('../services/territory'),
  territoryTechnicianFor: jest.fn(),
}));

const { computeCurrentPlacement, territoryTechnicianForVisit, _internals } = require('../services/auto-dispatch/candidate-slots');
const { liveServiceLine } = require('../services/scheduling/line-technician');
const territory = require('../services/territory');

const ENV_KEYS = ['GATE_AUTO_DISPATCH_SHARED_MODEL', 'GATE_TERRITORY_NIGHT_RUN', 'GATE_TECH_WORK_DAYS', 'GATE_TECH_START_POINTS', 'GATE_DRIVE_TIME_CALIBRATION'];
const PRIOR_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const DATE = '2026-08-07';
const VISIT_GEO = { lat: 27.3, lng: -82.5 };
const NEAR = { lat: 27.301, lng: -82.501 };
const FAR = { lat: 27.65, lng: -82.15 };
const UNASSIGNED = {
  id: 's1', customer_id: 'c1', scheduled_date: DATE, technician_id: null,
  window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
  lat: VISIT_GEO.lat, lng: VISIT_GEO.lng, service_type: 'Quarterly Pest Control',
  service_id: 'svc-pest', service_key_snapshot: 'pest_quarterly', service_address_zip: '34293',
};
const PREFS = { service_category: 'general' };
const CTX = () => ({ db: fakeDb(), capabilityFor: () => 'qualified' });

const dayRow = (id, technicianId, geo) => ({
  id, customer_id: `c-${id}`, technician_id: technicianId, scheduled_date: DATE,
  window_start: '11:00', window_end: '12:00', estimated_duration_minutes: 60,
  status: 'confirmed', svc_lat: geo.lat, svc_lng: geo.lng,
});

// t1 (the territory technician) runs far from the visit; t2 passes next door.
function fakeDb({ absent = [], techs = ['t1', 't2'] } = {}) {
  const dayRows = [dayRow('far', 't1', FAR), dayRow('near', 't2', NEAR)];
  const db = (table) => {
    let techIds = null;
    const q = {};
    ['whereNot', 'whereNotIn', 'whereNotNull', 'whereBetween', 'whereNull', 'orWhereNull', 'leftJoin', 'orderBy']
      .forEach((method) => { q[method] = () => q; });
    q.where = (arg) => { if (typeof arg === 'function') arg(q); return q; };
    q.whereIn = (column, ids) => { if (/technician_id$/.test(column)) techIds = ids.map(String); return q; };
    q.select = async () => {
      if (table === 'technicians') return techs.map((id) => ({ id }));
      if (table === 'technician_absences') return absent.map((technician_id) => ({ technician_id, absence_date: DATE }));
      if (table === 'scheduled_services') return dayRows.filter((row) => row.technician_id == null || (techIds || []).includes(row.technician_id));
      return [];
    };
    return q;
  };
  return db;
}

beforeEach(() => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  process.env.GATE_TERRITORY_NIGHT_RUN = 'true';
  delete process.env.GATE_TECH_WORK_DAYS;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  liveServiceLine.mockReset().mockResolvedValue('general');
  territory.territoryTechnicianFor.mockReset().mockResolvedValue('t1');
});

afterAll(() => {
  for (const [key, value] of Object.entries(PRIOR_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('an unassigned visit with a territory technician is measured on that technician\'s day, the only one candidates may use', async () => {
  const owner = await territoryTechnicianForVisit(UNASSIGNED, VISIT_GEO);
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, CTX());
  const onOwnersDay = await computeCurrentPlacement({ ...UNASSIGNED, technician_id: 't1' }, PREFS, CTX());
  const drops = { other_territory: 0 };
  const hard = {
    service: UNASSIGNED,
    prefs: { blackout: null },
    ctx: { keepTech: false, capabilityFor: () => 'qualified' },
    category: 'general', siblingDates: new Set(), drops, territoryTechId: owner,
  };
  const slot = (techId) => ({ date: DATE, start_time: '09:00', end_time: '10:00', technician: { id: techId } });

  expect(owner).toBe('t1');
  expect(_internals.candidateFromSlot(slot('t2'), hard)).toBeNull();
  expect(_internals.candidateFromSlot(slot('t1'), hard)).toMatchObject({ technician_id: 't1' });
  expect(drops.other_territory).toBe(1);
  expect(current.day_technician_id).toBe('t1');
  expect(current.detour_minutes).toBe(onOwnersDay.detour_minutes);
});

test('a territory technician handed in on ctx is used without a second territory read', async () => {
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, { ...CTX(), territoryTechId: 't1' });

  expect(current.day_technician_id).toBe('t1');
  expect(territory.territoryTechnicianFor).not.toHaveBeenCalled();
});

test('gate off: the unassigned visit keeps the closest assignable route', async () => {
  delete process.env.GATE_TERRITORY_NIGHT_RUN;

  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, CTX());

  expect(current.day_technician_id).toBe('t2');
  expect(territory.territoryTechnicianFor).not.toHaveBeenCalled();
});

test('a ZIP with no territory technician keeps the closest assignable route', async () => {
  territory.territoryTechnicianFor.mockResolvedValue(null);

  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, CTX());

  expect(current.day_technician_id).toBe('t2');
});

test('a territory technician who is not assignable keeps the closest assignable route', async () => {
  territory.territoryTechnicianFor.mockResolvedValue('t9');

  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, CTX());

  expect(current.day_technician_id).toBe('t2');
});

test('a visit with a technician is measured on its own technician\'s day, no territory read', async () => {
  const current = await computeCurrentPlacement({ ...UNASSIGNED, technician_id: 't2' }, PREFS, CTX());

  expect(current.day_technician_id).toBeUndefined();
  expect(current.technician_id).toBe('t2');
  expect(territory.territoryTechnicianFor).not.toHaveBeenCalled();
});

test('the territory technician is absent that day: the bar is the cover technician\'s day (the only other technician candidates may use)', async () => {
  const away = { db: fakeDb({ absent: ['t1'] }), capabilityFor: () => 'qualified', territoryTechId: 't1', territoryCoverId: 't2' };
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, away);

  expect(current.day_technician_id).toBe('t2');
});

test('the territory technician works that day: his day stays the bar even with a cover', async () => {
  const here = { db: fakeDb(), capabilityFor: () => 'qualified', territoryTechId: 't1', territoryCoverId: 't2' };
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, here);

  expect(current.day_technician_id).toBe('t1');
});

test('absent with no cover on the unit: still his day alone, as before the cover rule', async () => {
  const noCover = { db: fakeDb({ absent: ['t1'] }), capabilityFor: () => 'qualified', territoryTechId: 't1', territoryCoverId: null };
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, noCover);

  expect(current.day_technician_id).toBe('t1');
});

test('the territory technician can no longer take work: the bar is the cover\'s day, never a closer route it may not use', async () => {
  // t9 owns the ZIP but is not assignable; t1 (the cover) runs far, t2 next door may not take the visit.
  const gone = { db: fakeDb(), capabilityFor: () => 'qualified', territoryTechId: 't9', territoryCoverId: 't1' };
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, gone);

  expect(current.day_technician_id).toBe('t1');
});

test('the territory technician can no longer take work and the line has no cover: every technician\'s day, as before', async () => {
  const gone = { db: fakeDb(), capabilityFor: () => 'qualified', territoryTechId: 't9', territoryCoverId: null };
  const current = await computeCurrentPlacement(UNASSIGNED, PREFS, gone);

  expect(current.day_technician_id).toBe('t2');
});
