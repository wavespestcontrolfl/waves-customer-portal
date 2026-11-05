/**
 * Territory cover on the night run (GATE_TERRITORY_NIGHT_RUN, owner 2026-10-30 plus the cover rule):
 * an UNASSIGNED territory visit goes to its ZIP's territory technician; only when that technician
 * has no candidate at all (his day off, an absence, full days) may the line's cover technician take
 * it. Anyone else is always dropped. The apply fence (assertInOwnTerritory) accepts the cover too.
 * No database: find-time, the territory read and the line read are mocked. Synthetic ids only.
 */
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/territory', () => ({
  ...jest.requireActual('../services/territory'),
  territoryTechnicianFor: jest.fn(),
  territoryCoverFor: jest.fn(),
}));
jest.mock('../services/scheduling/line-technician', () => ({ liveServiceLine: jest.fn() }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const territory = require('../services/territory');
const lineTech = require('../services/scheduling/line-technician');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');

const { findValidCandidateSlots, territoryCoverForVisit, _internals } = candidateSlots;
const GATE = 'GATE_TERRITORY_NIGHT_RUN';
const ENV = { gate: process.env[GATE], drive: process.env.GATE_DRIVE_TIME_CALIBRATION };

beforeEach(() => {
  process.env[GATE] = 'true';
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  jest.clearAllMocks();
  lineTech.liveServiceLine.mockReset().mockResolvedValue('general');
  territory.territoryTechnicianFor.mockReset().mockResolvedValue('t-south');
  territory.territoryCoverFor.mockReset().mockResolvedValue('t-owner');
});
afterAll(() => {
  for (const [key, value] of [[GATE, ENV.gate], ['GATE_DRIVE_TIME_CALIBRATION', ENV.drive]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const slot = (techId, date = '2026-08-05', start = '08:00') => ({
  date, technician: { id: techId, name: `Tech ${techId}` }, start_time: start, end_time: '09:00', detour_minutes: 5, total_drive_minutes: 20, stops_that_day: 3, score: 5,
});
const VISIT = {
  id: 'v1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: null, window_start: '09:00', estimated_duration_minutes: 60,
  lat: 27.4, lng: -82.5, service_id: 'svc', service_type: 'Quarterly Pest Control', service_address_zip: '34293',
};
const PREFS = { blackout: null, service_category: 'general' };

// A knex stub: the three technicians are assignable, every other read is empty.
function dbStub() {
  return (table) => {
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'whereNull', 'whereNotNull', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => (table === 'technicians' ? [{ id: 't-south' }, { id: 't-owner' }, { id: 't-third' }] : []);
    return c;
  };
}
const ctx = () => ({
  db: dbStub(), nowDate: new Date('2026-06-19T16:00:00Z'), lockWindowDays: 14, lookaheadDays: 90, topN: 60, capabilityFor: () => 'qualified',
});
const find = async (slots) => {
  findAvailableSlots.mockResolvedValue({ slots });
  return findValidCandidateSlots(VISIT, PREFS, ctx());
};
const techsOf = (result) => result.candidates.map((c) => c.technician_id).sort();

describe('night run: territory technician first, cover second', () => {
  const ALL = [slot('t-south'), slot('t-owner', '2026-08-05', '10:00'), slot('t-third', '2026-08-06')];

  test('the territory technician has a slot: only his slots stay; the cover and the third technician are counted as other_territory', async () => {
    const out = await find(ALL);
    expect(techsOf(out)).toEqual(['t-south']);
    expect(out.drops.other_territory).toBe(2);
  });

  test('the territory technician has no slot (his day off): the cover\'s slots stay, the third technician\'s do not', async () => {
    const out = await find([slot('t-owner'), slot('t-owner', '2026-08-06'), slot('t-third')]);
    expect(techsOf(out)).toEqual(['t-owner', 't-owner']);
    expect(out.drops.other_territory).toBe(1);
  });

  test('neither the territory technician nor the cover has a slot: no candidate, the visit keeps its place', async () => {
    const out = await find([slot('t-third'), slot('t-third', '2026-08-06')]);
    expect(out.candidates).toEqual([]);
    expect(out.drops.other_territory).toBe(2);
  });

  test('the line has no cover: the territory technician alone, as before', async () => {
    territory.territoryCoverFor.mockResolvedValue(null);
    expect(techsOf(await find(ALL))).toEqual(['t-south']);
    const dayOff = await find([slot('t-owner'), slot('t-third')]);
    expect(dayOff.candidates).toEqual([]);
    expect(dayOff.drops.other_territory).toBe(2);
  });

  test('an unreadable card reads as no cover (never a wider admission)', async () => {
    territory.territoryCoverFor.mockRejectedValue(new Error('db down'));
    expect((await find([slot('t-owner')])).candidates).toEqual([]);
  });

  test('gate off: no territory rule, every technician stays a candidate, no cover read', async () => {
    delete process.env[GATE];
    expect(techsOf(await find(ALL))).toEqual(['t-owner', 't-south', 't-third']);
    expect(territory.territoryCoverFor).not.toHaveBeenCalled();
  });

  test('a ZIP with no territory technician: no rule and no cover read', async () => {
    territory.territoryTechnicianFor.mockResolvedValue(null);
    expect(techsOf(await find(ALL))).toEqual(['t-owner', 't-south', 't-third']);
    expect(territory.territoryCoverFor).not.toHaveBeenCalled();
  });

  test('the cover is read for the visit\'s own line and the territory technician', async () => {
    lineTech.liveServiceLine.mockResolvedValue('termite');
    await find([slot('t-south')]);
    expect(territory.territoryCoverFor).toHaveBeenCalledWith(expect.anything(), 'termite', 't-south');
  });
});

describe('unitTerritory (the cover of a whole moving unit)', () => {
  const { unitTerritory } = _internals;
  const geo = { lat: 27.05, lng: -82.4 };
  const pest = { id: 'a', technician_id: null, customer_id: 'c1', service_type: 'Quarterly Pest Control', service_address_zip: '34293' };
  const termite = { ...pest, id: 'b', service_type: 'Termite Inspection' };
  const group = (rows) => ({ groupContext: { siblings: rows.map((r) => ({ id: r.id })) }, db: jest.fn(() => ({ whereIn: () => ({ select: async () => rows }) })) });

  test('one visit: its territory technician and the line\'s cover', async () => {
    await expect(unitTerritory(pest, geo, { db: jest.fn() })).resolves.toEqual({ techId: 't-south', coverId: 't-owner' });
  });

  test('members whose lines name the same cover keep it; different covers (or a member with none) leave the territory technician alone', async () => {
    lineTech.liveServiceLine.mockImplementation(async (_db, { serviceType }) => (/termite/i.test(serviceType) ? 'termite' : 'general'));
    await expect(unitTerritory(pest, geo, group([termite]))).resolves.toEqual({ techId: 't-south', coverId: 't-owner' });
    territory.territoryCoverFor.mockImplementation(async (_db, line) => (line === 'termite' ? 't-third' : 't-owner'));
    await expect(unitTerritory(pest, geo, group([termite]))).resolves.toEqual({ techId: 't-south', coverId: null });
    territory.territoryCoverFor.mockImplementation(async (_db, line) => (line === 'termite' ? null : 't-owner'));
    await expect(unitTerritory(pest, geo, group([termite]))).resolves.toEqual({ techId: 't-south', coverId: null });
  });

  test('two territories in one unit: no single technician and no cover', async () => {
    territory.territoryTechnicianFor.mockImplementation(async (_db, place) => (place.zip === '34219' ? 't-north' : 't-south'));
    const north = { ...pest, id: 'c', service_address_zip: '34219' };
    await expect(unitTerritory(pest, geo, group([north]))).resolves.toEqual({ techId: _internals.NO_SINGLE_TERRITORY, coverId: null });
  });

  test('no territory visit in the unit: nothing, and no cover read', async () => {
    territory.territoryTechnicianFor.mockResolvedValue(null);
    await expect(unitTerritory(pest, geo, { db: jest.fn() })).resolves.toEqual({ techId: null, coverId: null });
    expect(territory.territoryCoverFor).not.toHaveBeenCalled();
  });
});

describe('territoryCoverForVisit (the apply fence reads it)', () => {
  const geo = { lat: 27.05, lng: -82.4 };

  test('the cover of an unassigned territory visit\'s line; null for an assigned visit, a lawn visit, no cover or the gate off', async () => {
    await expect(territoryCoverForVisit(VISIT, geo)).resolves.toBe('t-owner');
    await expect(territoryCoverForVisit({ ...VISIT, technician_id: 't-third' }, geo)).resolves.toBeNull();
    lineTech.liveServiceLine.mockResolvedValue('lawn');
    await expect(territoryCoverForVisit(VISIT, geo)).resolves.toBeNull();
    lineTech.liveServiceLine.mockResolvedValue('general');
    territory.territoryCoverFor.mockResolvedValue(null);
    await expect(territoryCoverForVisit(VISIT, geo)).resolves.toBeNull();
    delete process.env[GATE];
    territory.territoryCoverFor.mockResolvedValue('t-owner');
    await expect(territoryCoverForVisit(VISIT, geo)).resolves.toBeNull();
  });
});

describe('dropCoverWhenOwnerHas', () => {
  const { dropCoverWhenOwnerHas } = _internals;
  const cand = (techId) => ({ technician_id: techId });
  const hard = (extra = {}) => ({ territoryTechId: 't-south', territoryCoverId: 't-owner', drops: { other_territory: 0 }, ...extra });

  test('the territory technician has a candidate: the cover\'s are dropped and counted', () => {
    const h = hard();
    expect(dropCoverWhenOwnerHas([cand('t-owner'), cand('t-south'), cand('t-owner')], h)).toEqual([cand('t-south')]);
    expect(h.drops.other_territory).toBe(2);
  });

  test('no territory candidate, no cover on the unit, or no territory technician: nothing dropped', () => {
    const list = [cand('t-owner')];
    expect(dropCoverWhenOwnerHas(list, hard())).toBe(list);
    expect(dropCoverWhenOwnerHas([cand('t-south'), cand('t-owner')], hard({ territoryCoverId: null }))).toHaveLength(2);
    expect(dropCoverWhenOwnerHas([cand('t-south'), cand('t-owner')], hard({ territoryTechId: null }))).toHaveLength(2);
  });
});
