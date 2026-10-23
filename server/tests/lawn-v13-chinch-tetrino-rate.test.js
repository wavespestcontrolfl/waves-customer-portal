// GATE_LAWN_CHINCH_TETRINO_RATE (owner 2026-10-22): the gate reader, the rule's config, chinchTetrinoRate / visitNutrientTargets (the
// one place the plan and the tank sheet read the May Tetrino rate from), the rows and notes helpers, the archived-recipe match and
// the trouble-area read. Synthetic knex and trouble-area store; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockHasArea = jest.fn();
const mockPropertyOf = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: (...args) => mockPropertyOf(...args),
  loadActive: jest.fn(async () => []),
  hasAreaOfType: (...args) => mockHasArea(...args),
}));

const featureGates = require('../config/feature-gates');
const { V13_CHINCH_TETRINO, CHINCH_TETRINO_NOTE_KEY, CHINCH_TETRINO_NOTE } = require('../config/lawn-v13-chinch-rate');
const engine = require('../services/waveguard-plan-engine');
const { archivedLawnRecipeMatches } = require('../services/lawn-completion-defaults');
const v13 = require('../config/lawn-protocol-v13.json');

const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_CHINCH_TETRINO_RATE'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
const allOn = () => { for (const name of GATES) process.env[name] = 'true'; };
beforeEach(() => {
  jest.clearAllMocks();
  allOn();
  mockPropertyOf.mockReset().mockImplementation(async (knex, svc) => svc?.property_id || null);
  mockHasArea.mockReset().mockResolvedValue(true);
});
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const service = { id: 'svc-1', property_id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' };
const TRACKS = Object.keys(v13);
const visitOf = (track, month) => v13[track].visits.find((visit) => visit.month === month);
const run = (args = {}) => engine.visitNutrientTargets({}, service, { visit: visitOf('st_augustine', 'May'), month: 'May', v13Active: true, ...args });

describe('lawnChinchTetrinoRateLive', () => {
  test.each([[undefined, false], ['', false], ['1', false], ['TRUE', false], ['false', false], ['true', true]])('the variable %j gives %s, read at call time', (value, expected) => {
    if (value === undefined) delete process.env.GATE_LAWN_CHINCH_TETRINO_RATE; else process.env.GATE_LAWN_CHINCH_TETRINO_RATE = value;
    expect(featureGates.lawnChinchTetrinoRateLive()).toBe(expected);
  });

  test.each(GATES.slice(0, 4))('is off when %s is off (fail closed: the rule reads the mapped areas)', (name) => {
    delete process.env[name];
    expect(featureGates.lawnChinchTetrinoRateLive()).toBe(false);
  });
});

describe('the rule', () => {
  test('May, Tetrino, chinch, 0.367 to 0.735 fl oz per 1,000 sq ft (16 to 32 fl oz an acre), 365 days after resolved; frozen', () => {
    expect(V13_CHINCH_TETRINO).toEqual({ month: 5, productName: 'Tetrino Insecticide', troubleType: 'chinch', resolvedWithinDays: 365, normalRate: 0.367, ratePer1000: 0.735, rateUnit: 'fl oz' });
    expect(Math.round(V13_CHINCH_TETRINO.ratePer1000 * 43.56)).toBe(32);
    expect(Math.round(V13_CHINCH_TETRINO.normalRate * 43.56)).toBe(16);
    expect(Object.isFrozen(V13_CHINCH_TETRINO)).toBe(true);
    expect(CHINCH_TETRINO_NOTE).toBe("Chinch bugs mapped here: Tetrino at the label's high rate, 0.735 fl oz per 1,000 sq ft.");
  });

  test.each(TRACKS)('%s: the recipe May line states the rule\'s normal rate in the shape the text rewrite reads', (track) => {
    expect(visitOf(track, 'May').primary).toMatch(/^Tetrino Insecticide — 0\.367 fl oz per 1,000 sq ft, /);
  });

  test('one May pass at the raised rate is half the label\'s 64 fl oz per acre a year (1.469 fl oz per 1,000 sq ft)', () => {
    expect(V13_CHINCH_TETRINO.ratePer1000 / (64 / 43.56)).toBeCloseTo(0.5, 2);
  });
});

describe('visitNutrientTargets for the May visit', () => {
  test.each(TRACKS)('%s: a chinch-mapped lawn gets the raised rate, the adjusted line text, and unchanged nutrient targets', async (track) => {
    const found = await run({ visit: visitOf(track, 'May') });
    expect(found.chinchRate).toBe(0.735);
    expect(found.nitrogenCut).toBeNull();
    expect(found.targets).toEqual(engine.parseVisitNutrientTargets(visitOf(track, 'May').notes));
    expect(found.visit.primary).toMatch(/^Tetrino Insecticide — 0\.735 fl oz per 1,000 sq ft, sunny turf only.*, chinch bugs mapped$/);
    expect(found.visit.secondary).toBe(visitOf(track, 'May').secondary);
    expect(mockHasArea).toHaveBeenCalledWith({}, service.property_id, 'chinch', { withinDays: 365 });
  });

  test('not mapped: the very same visit and targets come back, with no chinchRate key', async () => {
    mockHasArea.mockResolvedValue(false);
    const visit = visitOf('st_augustine', 'May');
    const found = await run({ visit });
    expect(found.visit).toBe(visit);
    expect(found).toEqual({ visit, targets: engine.parseVisitNutrientTargets(visit.notes), nitrogenCut: null });
    expect('chinchRate' in found).toBe(false);
  });

  test('no read and no change when the gate, the v13 program, the month or the visit rules it out', async () => {
    const visit = visitOf('st_augustine', 'May');
    delete process.env.GATE_LAWN_CHINCH_TETRINO_RATE;
    expect((await run()).visit).toBe(visit);
    allOn();
    expect((await run({ v13Active: false })).visit).toBe(visit);
    expect((await run({ month: 'Jun', visit: visitOf('st_augustine', 'Jun') })).chinchRate).toBeUndefined();
    expect((await run({ visit: null })).visit).toBeNull();
    expect(mockHasArea).not.toHaveBeenCalled();
  });

  test('no property = no read and no raise; a failed read is logged and keeps the normal rate, or throws when strict', async () => {
    mockPropertyOf.mockResolvedValue(null);
    expect((await run()).chinchRate).toBeUndefined();
    expect(mockHasArea).not.toHaveBeenCalled();
    mockPropertyOf.mockImplementation(async (knex, svc) => svc.property_id);
    mockHasArea.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    expect((await run()).chinchRate).toBeUndefined();
    await expect(run({ strict: true })).rejects.toThrow('db down');
  });

  test('a rate already at the raised one is never touched', async () => {
    const decision = await engine.chinchTetrinoRate({}, service, { monthNumber: 5, statedRate: 0.735, v13Active: true });
    expect(decision).toBeNull();
    expect(await engine.chinchTetrinoRate({}, service, { monthNumber: 5, statedRate: 0.9, v13Active: true })).toBeNull();
    expect(await engine.chinchTetrinoRate({}, service, { monthNumber: 5, statedRate: 0.367, v13Active: true })).toBe(0.735);
  });

  test('a November fungus cut still returns the old shape (no chinchRate key) and the cut text', async () => {
    mockHasArea.mockResolvedValue(true);
    const found = await engine.visitNutrientTargets({}, service, { visit: visitOf('st_augustine', 'Nov'), month: 'Nov', v13Active: true });
    expect('chinchRate' in found).toBe(false);
  });
});

describe('chinchRateRows', () => {
  const tet = { productId: 'tet', productName: 'Tetrino Insecticide', ratePer1000: 0.367, rateUnit: 'fl oz', gates: { sunnyTurfOnly: true } };
  const arena = { productId: 'are', productName: 'Arena 50 WDG', ratePer1000: 0.147, rateUnit: 'oz' };
  const rows = () => new Map([['tet', tet], ['are', arena]]);

  test('null rate gives the same Map back', () => {
    const map = rows();
    expect(engine.chinchRateRows(map, null)).toBe(map);
  });

  test('raises only the Tetrino row; every other row is the same object; the input Map is not changed', () => {
    const map = rows();
    const raised = engine.chinchRateRows(map, 0.735);
    expect(raised.get('tet')).toEqual({ ...tet, ratePer1000: 0.735 });
    expect(raised.get('are')).toBe(arena);
    expect(map.get('tet')).toBe(tet);
  });

  test('never lowers a row, never touches a row with no stated rate or a bermuda-removal step row', () => {
    const high = { ...tet, ratePer1000: 0.9 };
    expect(engine.chinchRateRows(new Map([['tet', high]]), 0.735).get('tet')).toBe(high);
    const none = { ...tet, ratePer1000: null };
    expect(engine.chinchRateRows(new Map([['tet', none]]), 0.735).get('tet')).toBe(none);
  });
});

describe('the line note and the archived recipe', () => {
  const row = { productName: 'Tetrino Insecticide' };

  test('the note rides only the Tetrino line the raise sized', () => {
    const mix = { rateSource: 'protocol_rate', ratePer1000: 0.735 };
    expect(engine.chinchTetrinoNotes(row, mix, 0.735)).toEqual([{ key: CHINCH_TETRINO_NOTE_KEY, severity: 'note', text: CHINCH_TETRINO_NOTE }]);
    expect(engine.chinchTetrinoNotes(row, mix, null)).toEqual([]);
    expect(engine.chinchTetrinoNotes({ productName: 'Arena 50 WDG' }, mix, 0.735)).toEqual([]);
    expect(engine.chinchTetrinoNotes(row, { ...mix, ratePer1000: 0.367 }, 0.735)).toEqual([]);
    expect(engine.chinchTetrinoNotes(null, mix, 0.735)).toEqual([]);
  });

  const archived = { status: 'archived', products: [{ productId: 'tet', productName: 'Tetrino Insecticide', defaultInPlan: true, applicationMode: 'broadcast', ratePer1000: 0.367, rateUnit: 'fl oz' }] };
  const item = (ratePer1000) => [{ selected: true, product: { id: 'tet' }, mix: { ratePer1000, rateUnit: 'fl oz', rateSource: 'protocol_rate' } }];
  const raise = { from: 0.367, to: 0.735, productName: 'Tetrino Insecticide' };

  test('an archived recipe admits the raised Tetrino rate only when the plan raised it, and only that rate', () => {
    expect(archivedLawnRecipeMatches(archived, item(0.735), null, raise)).toBe(true);
    expect(archivedLawnRecipeMatches(archived, item(0.367), null, raise)).toBe(true);
    expect(archivedLawnRecipeMatches(archived, item(0.735))).toBe(false);
    expect(archivedLawnRecipeMatches(archived, item(0.6), null, raise)).toBe(false);
    expect(archivedLawnRecipeMatches(archived, item(0.735), null, { ...raise, productName: 'Arena 50 WDG' })).toBe(false);
    expect(archivedLawnRecipeMatches(archived, item(0.735), null, { ...raise, from: 0.3 })).toBe(false);
  });
});

describe('hasAreaOfType (the real store)', () => {
  const { hasAreaOfType } = jest.requireActual('../services/lawn-trouble-areas');
  const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  function fakeKnex(found) {
    const calls = { where: [], raw: [] };
    const group = { where: jest.fn((...args) => { calls.where.push(args); return group; }), orWhere: jest.fn((fn) => { fn(group); return group; }), whereRaw: jest.fn((...args) => { calls.raw.push(args); return group; }) };
    const query = {
      where: jest.fn((arg) => { if (typeof arg === 'function') arg(group); else calls.where.push([arg]); return query; }),
      first: jest.fn(async () => (found ? { id: 'a' } : undefined)),
    };
    const knex = jest.fn(() => query);
    return { knex, calls, query };
  }

  test('reads active areas and areas cleared within the window, of the one type, on the one property', async () => {
    const { knex, calls } = fakeKnex(true);
    expect(await hasAreaOfType(knex, PROPERTY, 'chinch', { withinDays: 365 })).toBe(true);
    expect(knex).toHaveBeenCalledWith('lawn_trouble_areas');
    expect(calls.where).toEqual(expect.arrayContaining([[{ property_id: PROPERTY, type: 'chinch' }], ['status', 'active'], ['status', 'cleared']]));
    expect(calls.raw[0][0]).toMatch(/COALESCE\(cleared_at, updated_at\) >= now\(\) - \(\?::int \* interval '1 day'\)/);
    expect(calls.raw[0][1]).toEqual([365]);
  });

  test('false for no row, and for a missing or malformed property (no query)', async () => {
    expect(await hasAreaOfType(fakeKnex(false).knex, PROPERTY, 'chinch')).toBe(false);
    const { knex } = fakeKnex(true);
    expect(await hasAreaOfType(knex, null, 'chinch')).toBe(false);
    expect(await hasAreaOfType(knex, 'not-a-uuid', 'chinch')).toBe(false);
    expect(knex).not.toHaveBeenCalled();
  });
});
