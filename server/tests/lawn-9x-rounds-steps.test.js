// 9x rounds visits take the program step of their ROUND (owner 2026-10-29), PR 4a of the lawn 9x rounds build.
// Synthetic catalog and a synthetic knex that routes each table to fixture rows: no database.
//
// Pins: the round -> step map and its helper (only a lawn_rounds_9 row has a step); the recipe's rounds-only February variant on all
// three tracks (and the 12x / legacy 9x steps untouched); the engine picks each round's step, nitrogen target and bag; the window
// read takes the program rows from the round's step window and the weed rows from the REAL date's window (with the St. Augustine
// green-up exception for all of round 2); North Port holds the round-3 nitrogen bag from Apr 1; the tank sheet, brief, report
// context, completion actions and closeout pin read the round's step; a 12x or legacy 9x visit plans exactly as before.
const v13 = require('../config/lawn-protocol-v13.json');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The cap metadata reader and the limit checker read the customer's history from the database; the fixture lawn has none.
jest.mock('../config/lawn-v13-count-caps', () => ({
  ...jest.requireActual('../config/lawn-v13-count-caps'),
  v13CapEntryFor: jest.fn(async () => null),
  capIdMap: jest.fn(async () => new Map()),
}));
jest.mock('../services/application-limits', () => ({
  ...jest.requireActual('../services/application-limits'),
  checkLimits: jest.fn(async () => ({ blocks: [], warnings: [] })),
}));

const rounds = require('../services/lawn-rounds');
const program = require('../services/lawn-program');
const engine = require('../services/waveguard-plan-engine');
const { getProtocolWindowContext, summarizeProtocolContext } = require('../services/lawn-protocol-operating-layer');
const migration = require('../models/migrations/20261029180000_lawn_v13_rounds_round3_target_n');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACKS = ['st_augustine', 'bermuda', 'zoysia'];
const stepOf = (track, month) => v13[track].visits.find((v) => v.month === MONTH_ABBR[month - 1]);
// The step as every reader sees it (the shared view leaves the gated addOns block out, so its objects are not the raw file's).
const liveStep = (track, month) => program.lawnProtocols()[track].visits.find((v) => v.month === MONTH_ABBR[month - 1]);
const lineNames = (text) => String(text || '').split('\n').filter(Boolean).map((line) => line.split(' — ')[0].trim());
const ROUNDS_ROW = (date) => ({ recurring_pattern: 'lawn_rounds_9', scheduled_date: date });

const saved = {};
const GATE_ENV = ['GATE_LAWN_V13', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
beforeAll(() => { for (const name of GATE_ENV) saved[name] = process.env[name]; });
beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; delete process.env.GATE_LAWN_COMPLETION_DEFAULTS; delete process.env.GATE_LAWN_PROPERTY_HISTORY; });
afterAll(() => { for (const name of GATE_ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

// ── The map ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the round -> step map', () => {
  const SAMPLES = { 1: '2027-01-12', 2: '2027-02-10', 3: '2027-03-20', 4: '2027-05-01', 5: '2027-06-10', 6: '2027-07-20', 7: '2027-09-05', 8: '2027-10-20', 9: '2027-12-01' };
  const MAP = { 1: 1, 2: 4, 3: 2, 4: 5, 5: 6, 6: 8, 7: 9, 8: 10, 9: 12 };

  test.each(Object.entries(MAP))('round %s takes the step of month %s', (round, month) => {
    expect(rounds.ROUND_STEPS[round].month).toBe(month);
    expect(rounds.roundStepForVisit(ROUNDS_ROW(SAMPLES[round]))).toMatchObject({ round: Number(round), month });
  });

  test('round 2 takes the 9x April bag and round 3 the rounds-only February bag; the others take the step as written', () => {
    expect(rounds.ROUND_STEPS[2].variant).toBe('cadence9');
    expect(rounds.ROUND_STEPS[3].variant).toBe('rounds');
    for (const round of [1, 4, 5, 6, 7, 8, 9]) expect(rounds.ROUND_STEPS[round].variant).toBeNull();
  });

  test('every round-date boundary lands in its own round', () => {
    const edges = { '2027-02-02': 1, '2027-02-03': 2, '2027-03-14': 2, '2027-03-15': 3, '2027-04-23': 3, '2027-04-24': 4, '2027-12-24': 9, '2027-12-25': 1 };
    for (const [date, round] of Object.entries(edges)) expect(rounds.roundStepForVisit(ROUNDS_ROW(date)).round).toBe(round);
  });

  test('only a visit whose own row says lawn_rounds_9 has a step', () => {
    for (const row of [
      { recurring_pattern: 'every_6_weeks', scheduled_date: '2027-03-20' },
      { recurring_pattern: 'custom', recurring_interval_days: 42, scheduled_date: '2027-03-20' },
      { recurring_pattern: 'monthly', scheduled_date: '2027-03-20' },
      { recurring_pattern: null, scheduled_date: '2027-03-20' },
      { scheduled_date: '2027-03-20' }, null, undefined,
      { recurring_pattern: 'lawn_rounds_9', scheduled_date: 'not a date' },
    ]) expect(rounds.roundStepForVisit(row)).toBeNull();
  });

  test('the plan reads the step only while v13 is live (the map names v13 steps)', () => {
    expect(program.roundStepForPlan(ROUNDS_ROW('2027-03-20'))).toMatchObject({ round: 3, month: 2 });
    delete process.env.GATE_LAWN_V13;
    expect(program.roundStepForPlan(ROUNDS_ROW('2027-03-20'))).toBeNull();
  });

  test('the spot month is the real month, and March reads February only for a St. Augustine round-2 visit', () => {
    expect(rounds.roundSpotMonth({ round: 2, realMonth: 3, grassTrack: 'st_augustine' })).toBe(2);
    expect(rounds.roundSpotMonth({ round: 2, realMonth: 3, grassTrack: 'bermuda' })).toBe(3);
    expect(rounds.roundSpotMonth({ round: 2, realMonth: 3, grassTrack: 'zoysia' })).toBe(3);
    expect(rounds.roundSpotMonth({ round: 2, realMonth: 2, grassTrack: 'st_augustine' })).toBe(2);
    expect(rounds.roundSpotMonth({ round: 3, realMonth: 3, grassTrack: 'st_augustine' })).toBe(3);
    expect(rounds.roundSpotMonth({ round: 3, realMonth: 4, grassTrack: 'st_augustine' })).toBe(4);
    expect(rounds.roundSpotMonth({ round: 8, realMonth: 11, grassTrack: 'st_augustine' })).toBe(11);
  });
});

// ── The recipe ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the v13 recipe carries the rounds-only February variant', () => {
  const VARIANT_PRIMARY = 'LESCO 24-0-11 with PolyPlus OPTI — 4.17 lb per 1,000 sq ft (1.0 lb N), spreader';

  test.each(TRACKS)('%s: the February step has roundVariants.lawn_rounds_9 (24-0-11, 4.17 lb, 1.0 lb N)', (track) => {
    const feb = stepOf(track, 2);
    const variant = feb.roundVariants.lawn_rounds_9;
    expect(variant.primary).toBe(VARIANT_PRIMARY);
    expect(variant.notes.startsWith('N rate: 1.0 lb N.')).toBe(true);
    // The step's other notes ride along (spreader visit, green-up spots, fertilizer safety).
    expect(variant.notes).toContain('Spreader visit. Weed spots stay light while the lawn greens up. Fertilizer safety:');
    expect(engine.parseVisitNutrientTargets(variant.notes).targetNPer1000).toBe(1);
  });

  test.each(TRACKS)('%s: the February step itself and April\'s 9x variant are unchanged (12x and legacy 9x keep 0.75 lb N)', (track) => {
    const feb = stepOf(track, 2);
    expect(feb.primary).toBe('LESCO 24-0-11 with PolyPlus OPTI — 3.1 lb per 1,000 sq ft (0.75 lb N), spreader');
    expect(engine.parseVisitNutrientTargets(feb.notes).targetNPer1000).toBe(0.75);
    expect(Object.keys(stepOf(track, 4).cadenceVariants)).toEqual(['9']);
    expect(stepOf(track, 4).cadenceVariants['9'].primary).toContain('2.78 lb per 1,000 sq ft (0.5 lb N)');
    // No other step carries a rounds variant, and August and September are untouched by this change.
    expect(v13[track].visits.filter((v) => v.roundVariants).map((v) => v.month)).toEqual(['Feb']);
  });

  test('the three tracks carry the same variant', () => {
    expect(stepOf('bermuda', 2).roundVariants).toEqual(stepOf('st_augustine', 2).roundVariants);
    expect(stepOf('zoysia', 2).roundVariants).toEqual(stepOf('st_augustine', 2).roundVariants);
  });
});

// ── The step a rounds visit takes ────────────────────────────────────────────────────────────────────────────────────────────────
describe('visitForPlan gives each round its step', () => {
  const forRound = async (date, track = 'st_augustine', pattern = 'lawn_rounds_9', extra = {}) => {
    const service = { recurring_pattern: pattern, scheduled_date: date, ...extra };
    const dateObj = new Date(`${date}T16:00:00Z`);
    const roundStep = program.roundStepForPlan(service);
    const selected = engine.selectProtocolVisit({ track_key: track }, dateObj, null, roundStep ? { month: roundStep.month } : {});
    const found = await engine.visitForPlan({}, selected.visit, service, null, { track: selected.track, trackKey: selected.trackKey });
    return { selected, ...found };
  };
  const SAMPLES = { 1: '2027-01-12', 2: '2027-02-10', 3: '2027-03-20', 4: '2027-05-01', 5: '2027-06-10', 6: '2027-07-20', 7: '2027-09-05', 8: '2027-10-20', 9: '2027-12-01' };
  const MAP = { 1: 1, 2: 4, 3: 2, 4: 5, 5: 6, 6: 8, 7: 9, 8: 10, 9: 12 };

  test.each(Object.keys(MAP))('round %s: the plan reads the step of its round', async (round) => {
    const { selected, visit } = await forRound(SAMPLES[round]);
    expect(selected.month).toBe(MONTH_ABBR[MAP[round] - 1]);
    expect(visit.month).toBe(MONTH_ABBR[MAP[round] - 1]);
    // The program products (the primary lines) are the mapped step's own, except where a variant replaces the bag.
    if (!['2', '3'].includes(round)) expect(visit.primary).toBe(stepOf('st_augustine', MAP[round]).primary);
  });

  test('round 2 is the 9x April bag: Dimension 18-0-10, 2.78 lb, 0.5 lb N', async () => {
    const { visit } = await forRound('2027-02-10');
    expect(visit.primary).toContain('LESCO Dimension 0.21% 18-0-10');
    expect(visit.primary).toContain('2.78 lb per 1,000 sq ft (0.5 lb N)');
    expect(engine.parseVisitNutrientTargets(visit.notes).targetNPer1000).toBe(0.5);
  });

  test('round 3 is February\'s 24-0-11 at the rounds rate: 4.17 lb, 1.0 lb N', async () => {
    const { visit, branch } = await forRound('2027-03-20');
    expect(branch).toBe('lawn_rounds_9');
    expect(visit.primary).toBe('LESCO 24-0-11 with PolyPlus OPTI — 4.17 lb per 1,000 sq ft (1.0 lb N), spreader');
    expect(visit.notes.startsWith('N rate: 1.0 lb N.')).toBe(true);
    expect(engine.parseVisitNutrientTargets(visit.notes).targetNPer1000).toBe(1);
  });

  test('rounds 6 and 7 are the August and September steps as written (potassium included); a July visit has July\'s as-needed lines', async () => {
    const july = (await forRound('2027-07-20')).visit;
    expect(july.primary).toBe(liveStep('st_augustine', 8).primary);
    expect(july.notes).toBe(liveStep('st_augustine', 8).notes);
    expect(july.secondary).toBe(liveStep('st_augustine', 7).secondary);
    expect((await forRound('2027-09-05')).visit).toBe(liveStep('st_augustine', 9));
  });

  // The approved plan: the round sets the planned treatment, the real date sets the spot treatments (weed, disease and insect alike).
  test('the as-needed lines follow the real date: round 3 on Mar 20 has March\'s take-all line, round 2 on Feb 10 none of April\'s', async () => {
    const three = (await forRound('2027-03-20')).visit;
    expect(three.secondary).toBe(liveStep('st_augustine', 3).secondary);
    expect(lineNames(three.secondary)).toContain('Artavia 2 SC (Azoxy)');
    const two = (await forRound('2027-02-10')).visit;
    expect(two.secondary).toBe(liveStep('st_augustine', 2).secondary);
    expect(lineNames(two.secondary)).not.toEqual(expect.arrayContaining(['Headway Fungicide']));
    expect(lineNames(two.secondary)).not.toContain('Arena 50 WDG');
    // Round 4 in late April: May's Tetrino is the planned treatment; the chinch, take-all and dry-spot lines are April's own (April holds a dry-spot line since owner 2026-11-01).
    const four = (await forRound('2027-04-28')).visit;
    expect(four.primary).toBe(liveStep('st_augustine', 5).primary);
    expect(four.secondary).toBe(liveStep('st_augustine', 4).secondary);
    expect(lineNames(four.secondary)).toEqual(expect.arrayContaining(['Headway Fungicide', 'Arena 50 WDG']));
    expect(lineNames(four.secondary)).toContain('Dispatch Sprayable Wetting Agent');
  });

  test('round 2 is round 2 whatever the track: the 9x April bag on all three', async () => {
    for (const track of TRACKS) expect((await forRound('2027-03-01', track)).visit.primary).toContain('2.78 lb per 1,000 sq ft (0.5 lb N)');
  });

  test('a 12x visit and a legacy 9x visit (every_6_weeks, custom 42 days) keep the calendar month, the 0.75 lb N February bag and the April variant rules', async () => {
    for (const [pattern, extra] of [['monthly', {}], ['every_6_weeks', {}], ['custom', { recurring_interval_days: 42 }], [null, {}]]) {
      const feb = await forRound('2027-02-10', 'st_augustine', pattern, extra);
      expect(feb.selected.month).toBe('Feb');
      expect(feb.visit).toBe(liveStep('st_augustine', 2));
      expect(feb.visit.primary).toContain('3.1 lb per 1,000 sq ft (0.75 lb N)');
      const mar = await forRound('2027-03-20', 'st_augustine', pattern, extra);
      expect(mar.visit).toBe(liveStep('st_augustine', 3));
    }
    // An April visit with no plan on file keeps the 12x bag, as before.
    expect((await forRound('2027-04-09', 'st_augustine', 'monthly')).visit).toBe(liveStep('st_augustine', 4));
  });

  test('v13 off: even a rounds row plans the calendar month of the old program', async () => {
    delete process.env.GATE_LAWN_V13;
    const service = ROUNDS_ROW('2027-03-20');
    expect(program.roundStepForPlan(service)).toBeNull();
    expect(engine.roundRouting(service, 'st_augustine')).toBeNull();
  });
});

// ── The window read: program rows from the round's window, weed rows from the real date's ────────────────────────────────────────
// A fake knex over the protocol tables (lawn_protocols, lawn_protocol_windows, lawn_protocol_products). `where` with an object or a
// (column, value) pair filters on equality; every other builder method is a pass-through.
function chainFor(tableSpec, db, data) {
  const table = String(tableSpec).split(/\s+as\s+/i)[0].trim();
  const filters = [];
  const strip = (column) => String(column).split('.').pop();
  const chain = {};
  for (const name of ['select', 'leftJoin', 'join', 'orderBy', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'limit', 'andWhere', 'orWhere', 'orWhereNull', 'whereILike', 'groupBy', 'distinct', 'modify', 'forUpdate', 'whereExists']) {
    chain[name] = () => chain;
  }
  chain.where = (a, b) => {
    if (a && typeof a === 'object') for (const [key, value] of Object.entries(a)) filters.push([strip(key), value]);
    else if (typeof a === 'string' && b !== undefined) filters.push([strip(a), b]);
    return chain;
  };
  chain.whereIn = (column, values) => { filters.push([strip(column), values]); return chain; };
  const rows = () => {
    const source = data[table];
    const list = typeof source === 'function' ? source(filters) : (source || []);
    return list.filter((row) => filters.every(([key, value]) => !(key in row) || (Array.isArray(value) ? value.map(String).includes(String(row[key])) : String(row[key]) === String(value))));
  };
  chain.forShare = () => chain;
  chain.del = async () => 0;
  // A completion upsert answers its returning row; an actual insert just records. Both are kept on db.inserts.
  chain.insert = (row) => {
    (db.inserts[table] = db.inserts[table] || []).push(row);
    const done = Promise.resolve([row]);
    done.onConflict = () => ({ merge: () => ({ returning: async () => [{ id: 'completion-1', ...row }] }) });
    return done;
  };
  chain.first = async () => rows()[0] ?? null;
  chain.pluck = async (column) => rows().map((row) => row[column]);
  chain.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  chain.catch = (reject) => chain.then(undefined, reject);
  return chain;
}
function fakeDb(data) {
  const db = (tableSpec) => chainFor(tableSpec, db, data);
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.raw = async () => ({ rows: [] });
  db.fn = { now: () => new Date() };
  db.isTransaction = false;
  db.inserts = {};
  return db;
}

const WINDOW_KEYS = {
  1: 'jan_v13_pre_m_hose', 2: 'feb_v13_spreader_green_up', 3: 'mar_v13_pre_m_hose', 4: 'apr_v13_spreader_feeding', 5: 'may_v13_tetrino_hose',
  6: 'jun_v13_hose_blackout', 8: 'aug_v13_hose_blackout', 9: 'sep_v13_hose_blackout', 10: 'oct_v13_spreader_fall', 11: 'nov_v13_spreader_feeding', 12: 'dec_v13_spreader_feeding',
};
const NAMES = {
  F24: 'LESCO 24-0-11 with PolyPlus OPTI',
  DIM: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer',
  CEL: 'Celsius WG', CER: 'Certainty Turf Herbicide', NIS: 'LESCO 90/10 Nonionic Surfactant', BLI: 'Blindside Herbicide',
  ART: 'Artavia 2 SC (Azoxy)', NT: 'LESCO Nutra-TECH T&O Micronutrient Package', K20: 'LESCO Nutra-TECH 0-0-20 K-Acetate Turfgrass Liquid Fertilizer',
  VEL: 'Velista', DYL: 'Dylox 6.2 G Granular Insecticide', K24: 'LESCO Black Out 0-0-24 AM Spar-TECH',
};
const CATALOG = [
  { id: 'p-f24', name: NAMES.F24, category: 'fertilizer', analysis_n: 24, analysis_p: 0, analysis_k: 11, formulation: 'Granular', default_rate_per_1000: 4.17, rate_unit: 'lb', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 1000, inventory_unit: 'lb' },
  { id: 'p-dim', name: NAMES.DIM, category: 'fertilizer', analysis_n: 18, analysis_p: 0, analysis_k: 10, formulation: 'Granular', default_rate_per_1000: 2.78, rate_unit: 'lb', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 1000, inventory_unit: 'lb' },
  { id: 'p-cel', name: NAMES.CEL, category: 'herbicide', default_rate_per_1000: 0.085, rate_unit: 'oz', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-cer', name: NAMES.CER, category: 'herbicide', default_rate_per_1000: 0.028, rate_unit: 'oz', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-nis', name: NAMES.NIS, category: 'adjuvant', default_rate_per_1000: null, rate_unit: 'label_rate', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'fl oz' },
  { id: 'p-bli', name: NAMES.BLI, category: 'herbicide', default_rate_per_1000: 0.149, rate_unit: 'oz', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-art', name: NAMES.ART, category: 'fungicide', default_rate_per_1000: null, rate_unit: 'label_rate', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'fl oz' },
  { id: 'p-nt', name: NAMES.NT, category: 'fertilizer', analysis_n: 0, analysis_p: 0, analysis_k: 0, default_rate_per_1000: 6, rate_unit: 'fl oz', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 1000, inventory_unit: 'fl oz' },
  { id: 'p-vel', name: NAMES.VEL, category: 'fungicide', default_rate_per_1000: null, rate_unit: 'label_rate', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-dyl', name: NAMES.DYL, category: 'insecticide', default_rate_per_1000: null, rate_unit: 'label_rate', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 100, inventory_unit: 'lb' },
  { id: 'p-k24', name: NAMES.K24, category: 'fertilizer', analysis_n: 0, analysis_p: 0, analysis_k: 24, default_rate_per_1000: 4.125, rate_unit: 'lb', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 1000, inventory_unit: 'lb' },
  { id: 'p-k20', name: NAMES.K20, category: 'fertilizer', analysis_n: 0, analysis_p: 0, analysis_k: 20, default_rate_per_1000: 5, rate_unit: 'fl oz', active: true, label_verified_at: new Date('2026-10-01'), inventory_on_hand: 1000, inventory_unit: 'fl oz' },
];
const CAT = Object.fromEntries(CATALOG.map((p) => [p.name, p]));

// One staged v13 protocol: a window per step that matters, and per window the rows the plan reads.
function protocolTables(track = 'st_augustine') {
  const windows = Object.entries(WINDOW_KEYS).map(([month, key]) => ({ id: `w-${key}`, lawn_protocol_id: 'proto', month: Number(month), window_key: key, title: key, visit_type: 'fixture', production_mode: Number(month) === 2 || Number(month) === 4 ? 'spreader_plus_spot_backpack' : 'main_reel_plus_spot_backpack', default_carrier_gal_per_1000: 1, sort_order: Number(month) }));
  const row = (month, name, extra = {}) => ({
    id: `row-${month}-${name}`, lawn_protocol_window_id: `w-${WINDOW_KEYS[month]}`, product_id: CAT[name].id, product_name: name, role: 'x', application_mode: 'broadcast',
    rate_per_1000: null, rate_unit: null, carrier_gal_per_1000: null, default_in_plan: false, gates: {}, annual_counter: {}, mixing: {}, report_copy: {}, sort_order: 1, ...extra,
  });
  const spot = (month, name, gates = {}) => row(month, name, { role: 'post_emergent_spot', application_mode: 'spot', rate_unit: 'label_rate', gates, sort_order: 20 });
  const weedMix = (month) => [
    spot(month, NAMES.CEL, { annualCounter: 'celsius_oz_per_1000' }),
    spot(month, NAMES.CER, { tankMixWith: 'Celsius WG' }),
    spot(month, NAMES.NIS, { tankMixWith: 'Celsius WG', concentration: '0.25% v/v' }),
    spot(month, NAMES.BLI, { trigger: 'celsius_annual_cap_reached' }),
  ];
  const products = [
    row(1, NAMES.NT, { default_in_plan: true, rate_per_1000: 6, rate_unit: 'fl oz', carrier_gal_per_1000: 1 }),
    // February: the 24-0-11 (rate derived from the visit's N target) and Celsius ALONE (green-up: no Certainty, no surfactant, no Blindside).
    row(2, NAMES.F24, { role: 'nutrition', default_in_plan: true, rate_unit: 'lb_n', gates: { targetN: '0.75 lb N/1000', blackoutSensitive: true } }),
    spot(2, NAMES.CEL, { annualCounter: 'celsius_oz_per_1000' }),
    // March: the full weed mix.
    row(3, NAMES.NT, { default_in_plan: true, rate_per_1000: 6, rate_unit: 'fl oz', carrier_gal_per_1000: 1 }),
    ...weedMix(3),
    // April: the 12x polymer bag is not in the fixture; the 9x Dimension row and spots are.
    // The stored gate is the April month's (North Port bans N and P Apr 1 to Sep 30), copied onto the 9x Dimension row.
    row(4, NAMES.DIM, { role: 'nutrition', default_in_plan: true, rate_unit: 'lb_n', gates: { targetN: '0.5 lb N/1000', planVisitsPerYear: 9, northPortBlocked: true } }),
    row(4, NAMES.ART, { role: 'fungicide_spot', application_mode: 'spot', rate_unit: 'label_rate', gates: { trigger: 'mapped_take_all_spring_2' }, sort_order: 20 }),
    row(8, NAMES.NT, { default_in_plan: true, rate_per_1000: 12, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { requiresZeroNP: true } }),
    row(8, NAMES.K20, { role: 'potassium', default_in_plan: true, rate_per_1000: 5, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { requiresZeroNP: true, northPortProductWindow: true } }),
    row(9, NAMES.NT, { default_in_plan: true, rate_per_1000: 12, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { requiresZeroNP: true } }),
    row(9, NAMES.K20, { role: 'potassium', default_in_plan: true, rate_per_1000: 5, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { requiresZeroNP: true, northPortProductWindow: true } }),
    // October: the fall weed mix without Blindside.
    row(10, NAMES.DIM, { role: 'nutrition', default_in_plan: true, rate_unit: 'lb_n', gates: { targetN: '0.73 lb N/1000' } }),
    spot(10, NAMES.CEL, { annualCounter: 'celsius_oz_per_1000' }),
    // November: the weed mix with Blindside (the Nov-Mar rule).
    row(11, NAMES.F24, { role: 'nutrition', default_in_plan: true, rate_unit: 'lb_n', gates: { targetN: '0.75 lb N/1000' } }),
    ...weedMix(11),
    row(12, NAMES.NT, { default_in_plan: true, rate_per_1000: 6, rate_unit: 'fl oz', carrier_gal_per_1000: 1 }),
    ...weedMix(12),
  ];
  return {
    lawn_protocols: [{ id: 'proto', protocol_key: 'fixture_v13', version: program.LAWN_V13_VERSION, name: 'Fixture v13', status: 'staged', grass_track: track, region: 'swfl', effective_from: '2000-01-01' }],
    lawn_protocol_windows: windows,
    lawn_protocol_products: products,
    lawn_protocol_gates: [],
  };
}
const productNames = (context) => context.products.map((p) => p.product_name);

describe('getProtocolWindowContext with a rounds step', () => {
  const read = (data, options) => getProtocolWindowContext(fakeDb(data), { protocolId: 'proto', serviceDate: new Date(`${options.date}T16:00:00Z`), strict: true, planning: true, ...options.rest });
  const data = (track) => protocolTables(track);

  test('no roundStep: one window, the month of the date, exactly as before', async () => {
    const context = await read(data(), { date: '2027-03-20', rest: {} });
    expect(context.window.window_key).toBe(WINDOW_KEYS[3]);
    expect(productNames(context)).toEqual([NAMES.NT, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
    expect(context.spotWindow).toBeUndefined();
  });

  test('round 3 on Mar 20: program rows from February\'s window, weed rows from March\'s', async () => {
    const context = await read(data(), { date: '2027-03-20', rest: { roundStep: { round: 3, month: 2 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[2]);
    expect(context.spotWindow.window_key).toBe(WINDOW_KEYS[3]);
    expect(productNames(context)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
    expect(context.products.find((p) => p.product_name === NAMES.F24).gates.targetN).toBe('0.75 lb N/1000');
  });

  test('round 2 on Mar 10, St. Augustine: April\'s program rows with FEBRUARY\'s as-needed rows (Celsius alone; April\'s take-all row leaves)', async () => {
    const context = await read(data('st_augustine'), { date: '2027-03-10', rest: { roundStep: { round: 2, month: 4 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[4]);
    expect(context.spotWindow.window_key).toBe(WINDOW_KEYS[2]);
    expect(productNames(context)).toEqual([NAMES.DIM, NAMES.CEL]);
  });

  test('round 2 on Mar 10, bermuda or zoysia: the exception is St. Augustine\'s, so March\'s weed rows', async () => {
    for (const track of ['bermuda', 'zoysia']) {
      const context = await read(data(track), { date: '2027-03-10', rest: { roundStep: { round: 2, month: 4 } } });
      expect(context.spotWindow.window_key).toBe(WINDOW_KEYS[3]);
      expect(productNames(context)).toEqual([NAMES.DIM, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
    }
  });

  test('round 2 on Feb 10: February\'s as-needed rows by the plain real-date rule', async () => {
    const context = await read(data(), { date: '2027-02-10', rest: { roundStep: { round: 2, month: 4 } } });
    expect(productNames(context)).toEqual([NAMES.DIM, NAMES.CEL]);
  });

  // The disease and insect spots follow the real date like the weed spots; the planned rows (a trouble swap's bag included) stay the round's.
  // The fake database returns rows as listed, so the fixture lists them in sort_order as the real read does.
  const withRows = (track, extra) => {
    const tables = protocolTables(track);
    return { ...tables, lawn_protocol_products: [...tables.lawn_protocol_products, ...extra].sort((a, b) => a.sort_order - b.sort_order) };
  };
  const asNeeded = (month, name, role, gates = {}) => ({
    id: `row-${month}-${name}`, lawn_protocol_window_id: `w-${WINDOW_KEYS[month]}`, product_id: CAT[name].id, product_name: name, role, application_mode: 'spot',
    rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2, default_in_plan: false, gates, annual_counter: {}, mixing: {}, report_copy: {}, sort_order: 10,
  });
  const marchTakeAll = asNeeded(3, NAMES.ART, 'fungicide_spot', { trigger: 'mapped_take_all_spring_1' });

  test('round 3 on Mar 20: March\'s take-all row joins February\'s bag (the round\'s step window has no spot rows of its own)', async () => {
    const context = await read(withRows('st_augustine', [marchTakeAll]), { date: '2027-03-20', rest: { roundStep: { round: 3, month: 2 } } });
    expect(productNames(context)).toEqual([NAMES.F24, NAMES.ART, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
    expect(context.products.find((p) => p.product_name === NAMES.ART).gates.trigger).toBe('mapped_take_all_spring_1');
  });

  test('round 8 on Nov 5: October\'s grub granule leaves and November\'s large patch spot comes; October\'s bag stays', async () => {
    const tables = withRows('st_augustine', [
      { ...asNeeded(10, NAMES.DYL, 'insect_curative', { trigger: 'grubs_or_mole_crickets', spreaderVisitOnly: true }), application_mode: 'broadcast' },
      asNeeded(11, NAMES.VEL, 'fungicide_spot', { trigger: 'mapped_large_patch' }),
    ]);
    expect(productNames(await read(tables, { date: '2027-10-20', rest: { roundStep: { round: 8, month: 10 } } }))).toEqual([NAMES.DIM, NAMES.DYL, NAMES.CEL]);
    expect(productNames(await read(tables, { date: '2027-11-05', rest: { roundStep: { round: 8, month: 10 } } }))).toEqual([NAMES.DIM, NAMES.VEL, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('round 9 on Nov 20: December\'s micronutrients and its large patch potassium bag stay; the spots are November\'s', async () => {
    const swapBag = { ...asNeeded(12, NAMES.K24, 'nutrition', { trigger: 'active_large_patch_mapped' }), application_mode: 'broadcast', sort_order: 2 };
    const tables = withRows('st_augustine', [swapBag, asNeeded(11, NAMES.VEL, 'fungicide_spot', { trigger: 'mapped_large_patch' })]);
    const context = await read(tables, { date: '2027-11-20', rest: { roundStep: { round: 9, month: 12 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[12]);
    expect(productNames(context)).toEqual([NAMES.NT, NAMES.K24, NAMES.VEL, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('round 8 on Nov 5: October\'s program rows with November\'s weed rows (Blindside joins)', async () => {
    const context = await read(data(), { date: '2027-11-05', rest: { roundStep: { round: 8, month: 10 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[10]);
    expect(productNames(context)).toEqual([NAMES.DIM, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('a round whose step window is the real window reads one window (no spot window)', async () => {
    const context = await read(data(), { date: '2027-12-01', rest: { roundStep: { round: 9, month: 12 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[12]);
    expect(context.spotWindow).toBeUndefined();
    expect(productNames(context)).toEqual([NAMES.NT, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('a pinned window still names the program window; the weed rows still follow the date', async () => {
    const context = await read(data(), { date: '2027-03-20', rest: { windowKey: WINDOW_KEYS[2], roundStep: { round: 3, month: 2 } } });
    expect(context.window.window_key).toBe(WINDOW_KEYS[2]);
    expect(productNames(context)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('a caller that names the spot month reads that window (the tank sheet)', async () => {
    const context = await read(data(), { date: '2027-03-20', rest: { roundStep: { month: 2, spotMonth: 3 } } });
    expect(productNames(context)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('summarizeProtocolContext reports the program window and the merged products', async () => {
    const summary = summarizeProtocolContext(await read(data(), { date: '2027-03-20', rest: { roundStep: { round: 3, month: 2 } } }));
    expect(summary.window.key).toBe(WINDOW_KEYS[2]);
    expect(summary.products.map((p) => p.protocolProductName)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('weed rows are classified by product name, and a bermuda removal row is not a weed row', () => {
    for (const name of [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI, 'Dismiss 64 oz']) expect(program.isWeedSpotRow({ product_name: name })).toBe(true);
    for (const name of [NAMES.F24, NAMES.DIM, NAMES.ART, 'Velista', 'Tetrino Insecticide', 'Recognition Post Emergent Herbicide']) expect(program.isWeedSpotRow({ product_name: name })).toBe(false);
    expect(program.isWeedSpotRow({ product_name: NAMES.NIS, gates: { bermudaRemoval: true } })).toBe(false);
  });

  test('as-needed rows are classified by role: every spot, the curative granule and the fire ant add-on; never a planned row', () => {
    for (const role of ['fungicide_spot', 'insecticide_spot', 'wetting_agent_spot', 'post_emergent_spot', 'adjuvant_spot', 'insect_curative', 'insecticide_optional_addon']) {
      expect(program.isAsNeededRow({ product_name: 'Any', role })).toBe(true);
    }
    for (const role of ['nutrition', 'pre_emergent', 'fall_pre_emergent_nutrition', 'micronutrients', 'insecticide', 'potassium', 'potassium_nutrition', 'area_addon']) {
      expect(program.isAsNeededRow({ product_name: 'Any', role, default_in_plan: false })).toBe(false);
    }
    expect(program.isAsNeededRow({ product_name: NAMES.CEL, role: 'x' })).toBe(true);
    expect(program.isAsNeededRow({ product_name: NAMES.ART, role: 'fungicide_spot', gates: { bermudaRemoval: true } })).toBe(false);
  });
});

// ── The weed lines ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('visitWithSpotLines', () => {
  const apr = stepOf('st_augustine', 4);
  test('every as-needed line (weed, disease, insect) is the spot month\'s; the planned treatment stays the round step\'s', () => {
    const mar = stepOf('st_augustine', 3);
    const merged = program.visitWithSpotLines(apr, mar);
    expect(lineNames(merged.secondary)).toEqual(lineNames(mar.secondary));
    expect(lineNames(merged.secondary)).toContain('Artavia 2 SC (Azoxy)');
    expect(lineNames(merged.secondary)).not.toEqual(expect.arrayContaining(['Headway Fungicide']));
    expect(lineNames(merged.secondary)).not.toContain('Arena 50 WDG');
    expect(merged.primary).toBe(apr.primary);
    expect(merged.notes).toBe(apr.notes);
  });
  test('February\'s weed lines are Celsius alone (the green-up rule)', () => {
    const merged = program.visitWithSpotLines(apr, stepOf('st_augustine', 2));
    expect(lineNames(merged.secondary).filter((n) => ['Celsius WG', 'Certainty Turf Herbicide', 'Blindside Herbicide'].includes(n))).toEqual(['Celsius WG']);
    expect(merged.secondary).toContain('alone: no Certainty');
  });
  test('the same step, or no spot step, returns the visit itself', () => {
    expect(program.visitWithSpotLines(apr, apr)).toBe(apr);
    expect(program.visitWithSpotLines(apr, null)).toBe(apr);
    expect(program.visitWithSpotLines(null, apr)).toBeNull();
  });
});

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function planDb({ date, pattern = 'lawn_rounds_9', city = 'Lakewood Ranch', track = 'st_augustine', interval = null, pin = {}, lawnSqft = 10000 }) {
  const service = {
    id: 'visit-1', customer_id: 'cust-1', property_id: null, scheduled_date: date, service_type: 'Lawn Care', recurring_pattern: pattern, recurring_interval_days: interval,
    first_name: 'Test', last_name: 'Customer', city, state: 'FL', zip: '34202', waveguard_tier: 'Gold', lawn_type: 'St. Augustine', property_type: 'residential', status: 'scheduled',
    lawn_protocol_key: null, lawn_protocol_version: null, lawn_protocol_window_key: null, ...pin,
  };
  const profile = { id: 'profile-1', customer_id: 'cust-1', active: true, track_key: track, grass_type: track, lawn_sqft: lawnSqft, municipality: city, sun_exposure: 'full_sun', updated_at: new Date('2026-10-01') };
  return fakeDb({
    scheduled_services: [service],
    customer_turf_profiles: [profile],
    products_catalog: CATALOG,
    // A pre-emergent is on the ledger this year, so these visits carry no spring catch-up (lawn-9x-rounds-catchup.test.js pins that line).
    property_application_history: [{ id: 'history-1', customer_id: 'cust-1' }],
    ...protocolTables(track),
  });
}
const planFor = (options) => engine.buildPlanForService('visit-1', { db: planDb(options), billingModeColumnExists: false, now: new Date('2026-10-29T16:00:00Z') });
const selectedNames = (plan) => plan.mixCalculator.items.map((item) => item.product?.name);
const lineNamesOf = (plan) => [...plan.protocol.base, ...plan.protocol.conditional].map((item) => item.product?.name || item.raw.split(' — ')[0]);
const itemFor = (plan, name) => [...plan.protocol.base, ...plan.protocol.conditional].find((item) => (item.product?.name || '') === name);

describe('buildPlanForService on a rounds visit', () => {
  test('round 3 (Mar 20): the 24-0-11 at 4.17 lb per 1,000 (1.0 lb N); the plan\'s window is February\'s', async () => {
    const plan = await planFor({ date: '2027-03-20' });
    expect(plan.propertyGate.blocks).toEqual([]);
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[2]);
    expect(plan.protocol.objective.startsWith('N rate: 1.0 lb N.')).toBe(true);
    const bag = plan.mixCalculator.items.find((item) => item.product?.name === NAMES.F24);
    expect(bag.mix.ratePer1000).toBeCloseTo(4.17, 2);
    expect(bag.mix.targetNPer1000).toBe(1);
    expect(bag.mix.amount).toBeCloseTo(41.7, 1);
  });

  test('round 2 (Feb 10): Dimension 18-0-10 at 2.78 lb (0.5 lb N) from the April window', async () => {
    const plan = await planFor({ date: '2027-02-10' });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[4]);
    const bag = plan.mixCalculator.items.find((item) => item.product?.name === NAMES.DIM);
    expect(bag.mix.ratePer1000).toBeCloseTo(2.78, 2);
    expect(bag.mix.targetNPer1000).toBe(0.5);
  });

  test('round 6 (Jul 20) and round 7 (Sep 5): the August and September steps (Nutra-TECH and the potassium)', async () => {
    const six = await planFor({ date: '2027-07-20' });
    expect(six.protocol.structured.window.key).toBe(WINDOW_KEYS[8]);
    expect(selectedNames(six)).toEqual([NAMES.NT, NAMES.K20]);
    const seven = await planFor({ date: '2027-09-05' });
    expect(seven.protocol.structured.window.key).toBe(WINDOW_KEYS[9]);
    expect(selectedNames(seven)).toEqual([NAMES.NT, NAMES.K20]);
  });

  test('round 3 on Mar 20 carries March\'s weed lines, round 2 on Mar 10 February\'s green-up Celsius alone', async () => {
    const march = await planFor({ date: '2027-03-20' });
    const weedMarch = lineNamesOf(march).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n));
    expect(weedMarch).toEqual([NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);

    const greenUp = await planFor({ date: '2027-03-10' });
    expect(greenUp.protocol.structured.window.key).toBe(WINDOW_KEYS[4]);
    const weedGreenUp = lineNamesOf(greenUp).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n));
    expect(weedGreenUp).toEqual([NAMES.CEL]);
    // The Celsius row is the February window's own; no Certainty or Blindside row is offered, and April's take-all row is not either.
    expect(greenUp.protocol.structured.products.map((p) => p.protocolProductName)).toEqual([NAMES.DIM, NAMES.CEL]);
  });

  test('round 2 on Mar 10 for a bermuda lawn: March\'s weed mix (the green-up exception is St. Augustine\'s)', async () => {
    const plan = await planFor({ date: '2027-03-10', track: 'bermuda' });
    expect(lineNamesOf(plan).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n))).toEqual([NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('round 8 on Nov 5 takes October\'s Dimension bag and November\'s weed mix with Blindside', async () => {
    const plan = await planFor({ date: '2027-11-05' });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[10]);
    expect(selectedNames(plan)).toContain(NAMES.DIM);
    expect(lineNamesOf(plan).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n))).toEqual([NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('the recap names the round', async () => {
    expect((await planFor({ date: '2027-03-20' })).closeout.customerRecapPreview).toMatch(/^Round 3 WaveGuard visit/);
  });
});

describe('the closeout pin writes the round\'s window', () => {
  // complete-scheduled-service.js stamps lawn_protocol_window_key / _title from the plan's structured window. The plan resolves the
  // round's step window for a rounds visit, so the pin is the round step's window and no write path needs one.
  const SAMPLES = { 1: '2027-01-12', 2: '2027-02-10', 3: '2027-03-20', 4: '2027-05-01', 5: '2027-06-10', 6: '2027-07-20', 7: '2027-09-05', 8: '2027-10-20', 9: '2027-12-01' };
  const MAP = { 1: 1, 2: 4, 3: 2, 4: 5, 5: 6, 6: 8, 7: 9, 8: 10, 9: 12 };

  test.each(Object.keys(MAP))('round %s: the window the closeout would pin is the mapped step\'s', async (round) => {
    const plan = await planFor({ date: SAMPLES[round] });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[MAP[round]]);
    expect(plan.closeout.protocolWindowKey).toBe(WINDOW_KEYS[MAP[round]]);
    expect(plan.propertyGate.month).toBe(MONTH_ABBR[MAP[round] - 1]);
  });

  test('a re-plan of the pinned visit keeps the pinned window (the pin names the round\'s window; the weed rows still follow the date)', async () => {
    const plan = await planFor({ date: '2027-03-20', pin: { lawn_protocol_key: 'fixture_v13', lawn_protocol_version: program.LAWN_V13_VERSION, lawn_protocol_window_key: WINDOW_KEYS[2] } });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[2]);
    expect(plan.propertyGate.blocks).toEqual([]);
    expect(lineNamesOf(plan).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n))).toEqual([NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });

  test('the closeout stamps the plan\'s structured window (source pin, so the chain plan -> pin stays one line)', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(source).toMatch(/const structured = waveguardPlan\.protocol\.structured;\s+const window = structured\.window \|\| \{\};\s+scheduledServiceUpdate\.lawn_protocol_key = structured\.protocolKey \|\| null;\s+scheduledServiceUpdate\.lawn_protocol_version = structured\.version \|\| null;\s+scheduledServiceUpdate\.lawn_protocol_window_key = window\.key \|\| null;/);
  });
});

// ── Completion attribution ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The completion maps each applied product back to a protocol row (lawn-protocol-completion loadProtocolRows). For a rounds visit it must
// resolve the SAME row set the plan read: the round window's program rows plus the real date's weed and spot rows.
describe('completion attribution on a rounds visit', () => {
  const { recordLawnProtocolCompletion } = require('../services/lawn-protocol-completion');
  const rowId = (month, name) => `row-${month}-${name}`;
  const applied = (name) => ({ id: `sp-${name}`, product_id: CAT[name].id, product_name: name, application_rate: 1, rate_unit: 'oz', total_amount: 1, amount_unit: 'oz' });
  async function attribute(options, names) {
    const db = planDb(options);
    const plan = await engine.buildPlanForService('visit-1', { db, billingModeColumnExists: false, now: new Date('2026-10-29T16:00:00Z') });
    await recordLawnProtocolCompletion(db, {
      service: { id: 'visit-1', customer_id: 'cust-1' }, serviceRecord: { id: 'record-1' }, plan, serviceProducts: names.map(applied), completionInput: { inventoryDeductions: [] },
    });
    return Object.fromEntries((db.inserts.lawn_protocol_product_actuals || []).map((row) => [row.product_name, row]));
  }

  test.each(['2027-02-20', '2027-03-10'])('St. Augustine round 2 on %s: Celsius attributes to FEBRUARY\'s spot row; the April program bag still attributes', async (date) => {
    const actuals = await attribute({ date }, [NAMES.CEL, NAMES.DIM]);
    expect(actuals[NAMES.CEL]).toMatchObject({ protocol_product_id: rowId(2, NAMES.CEL), status: 'applied' });
    expect(actuals[NAMES.DIM]).toMatchObject({ protocol_product_id: rowId(4, NAMES.DIM), status: 'applied' });
  });

  test('bermuda round 2 on Mar 10: the weed rows are March\'s (Certainty is a protocol row), Celsius is March\'s', async () => {
    const actuals = await attribute({ date: '2027-03-10', track: 'bermuda' }, [NAMES.CER, NAMES.CEL]);
    expect(actuals[NAMES.CER]).toMatchObject({ protocol_product_id: rowId(3, NAMES.CER), status: 'applied' });
    expect(actuals[NAMES.CEL]).toMatchObject({ protocol_product_id: rowId(3, NAMES.CEL), status: 'applied' });
  });

  test('St. Augustine round 2 on Mar 10: Certainty is NOT a February row, so it is off protocol (the green-up rule)', async () => {
    expect((await attribute({ date: '2027-03-10' }, [NAMES.CER]))[NAMES.CER].status).toBe('off_protocol_applied');
  });

  test('round 3 on Mar 20: a March spot product attributes to March\'s row, the bag to February\'s', async () => {
    const actuals = await attribute({ date: '2027-03-20' }, [NAMES.CER, NAMES.F24]);
    expect(actuals[NAMES.CER]).toMatchObject({ protocol_product_id: rowId(3, NAMES.CER), status: 'applied' });
    expect(actuals[NAMES.F24]).toMatchObject({ protocol_product_id: rowId(2, NAMES.F24), status: 'applied' });
  });

  test('a non-rounds visit is attributed to its own window only, as before (an April Celsius is off protocol; February\'s is February\'s)', async () => {
    expect((await attribute({ date: '2027-04-09', pattern: 'monthly' }, [NAMES.CEL]))[NAMES.CEL]).toMatchObject({ protocol_product_id: null, status: 'off_protocol_applied' });
    expect((await attribute({ date: '2027-02-10', pattern: 'monthly' }, [NAMES.CEL, NAMES.F24]))[NAMES.CEL]).toMatchObject({ protocol_product_id: rowId(2, NAMES.CEL), status: 'applied' });
    expect((await attribute({ date: '2027-03-10', pattern: 'custom', interval: 42 }, [NAMES.CER]))[NAMES.CER]).toMatchObject({ protocol_product_id: rowId(3, NAMES.CER), status: 'applied' });
  });

  test('the plan carries the round it read only on a rounds visit', async () => {
    expect((await planFor({ date: '2027-02-20' })).roundStep).toEqual({ round: 2, month: 4, spotMonth: 2 });
    expect(await planFor({ date: '2027-02-20', pattern: 'monthly' })).not.toHaveProperty('roundStep');
  });
});

describe('a 12x or legacy 9x visit is planned exactly as before', () => {
  test.each([
    ['12x monthly', 'monthly', null],
    ['legacy 9x every_6_weeks', 'every_6_weeks', null],
    ['legacy 9x custom 42 days', 'custom', 42],
  ])('%s, Feb 10: the February window and the 0.75 lb N bag at 3.1 lb', async (_label, pattern, interval) => {
    const plan = await planFor({ date: '2027-02-10', pattern, interval });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[2]);
    expect(plan.protocol.objective.startsWith('N rate: 0.75 lb N.')).toBe(true);
    const bag = plan.mixCalculator.items.find((item) => item.product?.name === NAMES.F24);
    expect(bag.mix.ratePer1000).toBeCloseTo(3.13, 2);
    expect(bag.mix.targetNPer1000).toBe(0.75);
    // February's weed lines: Celsius alone, from the same window.
    expect(lineNamesOf(plan).filter((n) => [NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI].includes(n))).toEqual([NAMES.CEL]);
    expect(plan.closeout.customerRecapPreview).toMatch(/^Feb WaveGuard visit/);
  });

  test('legacy 9x (custom 42 days) on Apr 9: the 9x April bag by the plan count, as before', async () => {
    const plan = await planFor({ date: '2027-04-09', pattern: 'custom', interval: 42 });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[4]);
    // The plan count is read from the series (custom 42 days is 9 visits a year): the Dimension step, unchanged by the rounds work.
    expect(plan.protocol.objective).toBe(stepOf('st_augustine', 4).cadenceVariants['9'].notes);
  });

  test('a 12x Mar 20 visit reads March\'s window with the weed mix and no rounds routing', async () => {
    const plan = await planFor({ date: '2027-03-20', pattern: 'monthly' });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[3]);
    expect(plan.protocol.structured.products.map((p) => p.protocolProductName)).toEqual([NAMES.NT, NAMES.CEL, NAMES.CER, NAMES.NIS, NAMES.BLI]);
  });
});

describe('North Port holds the round-3 nitrogen bag from April 1', () => {
  test('Apr 5, North Port: the 24-0-11 is held, with a warning that names the ban', async () => {
    const plan = await planFor({ date: '2027-04-05', city: 'North Port' });
    expect(plan.protocol.structured.window.key).toBe(WINDOW_KEYS[2]);
    const bag = itemFor(plan, NAMES.F24);
    expect(bag.selected).toBe(false);
    expect(bag.selectionReason).toBe('north_port_rounds_nitrogen');
    expect(bag.unavailable).toMatchObject({ kind: 'city_hold' });
    expect(bag.mix).toBeNull();
    expect(selectedNames(plan)).not.toContain(NAMES.F24);
    const warning = plan.propertyGate.warnings.find((w) => w.code === 'lawn_rounds_north_port_nitrogen');
    expect(warning.productName).toBe(NAMES.F24);
    expect(warning.message).toMatch(/North Port bans nitrogen and phosphorus from April 1 to September 30/);
  });

  test('Mar 25, North Port: before the ban the bag is planned', async () => {
    const plan = await planFor({ date: '2027-03-25', city: 'North Port' });
    expect(itemFor(plan, NAMES.F24).selected).toBe(true);
    expect(selectedNames(plan)).toContain(NAMES.F24);
    expect(plan.propertyGate.warnings.find((w) => w.code === 'lawn_rounds_north_port_nitrogen')).toBeUndefined();
  });

  test('Apr 5 in another city: planned', async () => {
    const plan = await planFor({ date: '2027-04-05', city: 'Lakewood Ranch' });
    expect(itemFor(plan, NAMES.F24).selected).toBe(true);
  });

  test('a 12x visit in North Port on Apr 5 is not touched by the rounds hold (April is its own step)', async () => {
    const plan = await planFor({ date: '2027-04-05', city: 'North Port', pattern: 'monthly' });
    expect(plan.propertyGate.warnings.find((w) => w.code === 'lawn_rounds_north_port_nitrogen')).toBeUndefined();
  });

  const notesOf = (plan, name) => (itemFor(plan, name).gateNotes || []).map((note) => note.key);

  test.each(['2027-02-20', '2027-03-10'])('North Port, round 2 on %s: the Dimension bag is planned with NO North Port note (the ban starts Apr 1)', async (date) => {
    const plan = await planFor({ date, city: 'North Port' });
    const bag = itemFor(plan, NAMES.DIM);
    expect(bag.selected).toBe(true);
    expect(bag.mix.ratePer1000).toBeCloseTo(2.78, 2);
    expect(notesOf(plan, NAMES.DIM)).not.toContain('northPortBlocked');
    expect(plan.propertyGate.warnings.map((w) => w.code)).not.toContain('lawn_rounds_north_port_nitrogen');
    expect(JSON.stringify(plan.propertyGate.warnings)).not.toMatch(/Not allowed in North Port/);
  });

  test('a legacy 9x (custom 42 days) North Port visit on Apr 9 keeps the stored gate note, as before', async () => {
    const plan = await planFor({ date: '2027-04-09', city: 'North Port', pattern: 'custom', interval: 42 });
    expect(notesOf(plan, NAMES.DIM)).toContain('northPortBlocked');
  });

  test('the ban test is one helper: the stored-gate note and the round-3 hold read the same months', () => {
    for (let month = 1; month <= 12; month += 1) {
      const inBan = month >= 4 && month <= 9;
      expect(engine.northPortNpBanMonth(month)).toBe(inBan);
      expect(engine.v13GateNotes({ northPortBlocked: true }, { municipality: 'North Port', monthNumber: 4, realMonthNumber: month }).length).toBe(inBan ? 1 : 0);
      expect(engine.roundsNitrogenHold({ round: 3, realMonth: month }, 'North Port')).toBe(inBan);
    }
    // No real month (not a rounds visit): the stored gate fires for North Port in any month, and never elsewhere.
    expect(engine.v13GateNotes({ northPortBlocked: true }, { municipality: 'North Port', monthNumber: 2 })).toHaveLength(1);
    expect(engine.v13GateNotes({ northPortBlocked: true }, { municipality: 'Sarasota', monthNumber: 5, realMonthNumber: 5 })).toEqual([]);
    expect(engine.roundsNitrogenHold({ round: 2, realMonth: 5 }, 'North Port')).toBe(false);
  });

  test('Dismiss novToMarOnly follows the REAL date on a rounds visit', () => {
    const gates = { novToMarOnly: true };
    // The note fires OUTSIDE November to March. Round 8 (October step, month 10) dated Nov 5 is inside the season: no note, though the
    // step month alone would have warned. Round 9 (December step) dated Apr 2 is outside it: the note, though the step month alone would not.
    expect(engine.v13GateNotes(gates, { monthNumber: 10, spotMonthNumber: 11 })).toEqual([]);
    expect(engine.v13GateNotes(gates, { monthNumber: 12, spotMonthNumber: 4 }).map((n) => n.key)).toEqual(['novToMarOnly']);
    expect(engine.v13GateNotes(gates, { monthNumber: 2, spotMonthNumber: 3 })).toEqual([]);
    // No spot month: the service month, as before.
    expect(engine.v13GateNotes(gates, { monthNumber: 6 }).map((n) => n.key)).toEqual(['novToMarOnly']);
    expect(engine.v13GateNotes(gates, { monthNumber: 12 })).toEqual([]);
  });
});

// ── The migration ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the round-3 target migration', () => {
  function migrationDb(rows) {
    const updates = [];
    const knex = (tableSpec) => {
      const state = { table: String(tableSpec).split(' as ')[0] };
      const chain = {
        join: () => chain, where: () => chain, select: async () => rows.map((row) => ({ id: row.id, gates: row.gates })),
        update: async (changes) => { updates.push({ table: state.table, id: state.id, changes }); const row = rows.find((r) => r.id === state.id); if (row) row.gates = changes.gates; return 1; },
      };
      const whereCalls = chain.where;
      chain.where = (arg, ...rest) => { if (arg && typeof arg === 'object' && arg.id !== undefined) state.id = arg.id; return whereCalls(arg, ...rest); };
      return chain;
    };
    knex.schema = { hasTable: async () => true, hasColumn: async () => true };
    knex.fn = { now: () => 'now' };
    return { knex, updates };
  }

  test('adds roundsTargetN beside targetN on the February nitrogen row, once, and never touches targetN', async () => {
    const rows = [{ id: 1, gates: { targetN: '0.75 lb N/1000', blackoutSensitive: true } }, { id: 2, gates: JSON.stringify({ targetN: '0.75 lb N/1000' }) }];
    const { knex } = migrationDb(rows);
    await migration.up(knex);
    for (const row of rows) {
      const gates = typeof row.gates === 'string' ? JSON.parse(row.gates) : row.gates;
      expect(gates.targetN).toBe('0.75 lb N/1000');
      expect(gates.roundsTargetN).toBe('1.0 lb N/1000');
    }
    const { knex: again, updates } = migrationDb(rows);
    await migration.up(again);
    expect(updates).toEqual([]);
  });

  test('skips a row that states no target and leaves a key it finds alone', async () => {
    const rows = [{ id: 1, gates: {} }, { id: 2, gates: { targetN: '0.75 lb N/1000', roundsTargetN: '2.0 lb N/1000' } }];
    const { knex, updates } = migrationDb(rows);
    await migration.up(knex);
    expect(updates).toEqual([]);
  });

  test('down removes only the key it wrote', async () => {
    const rows = [{ id: 1, gates: { targetN: '0.75 lb N/1000', roundsTargetN: '1.0 lb N/1000' } }, { id: 2, gates: { targetN: '0.75 lb N/1000', roundsTargetN: '1.25 lb N/1000' } }];
    const { knex } = migrationDb(rows);
    await migration.down(knex);
    expect(rows[0].gates ? (typeof rows[0].gates === 'string' ? JSON.parse(rows[0].gates) : rows[0].gates) : null).toEqual({ targetN: '0.75 lb N/1000' });
    expect(rows[1].gates).toEqual({ targetN: '0.75 lb N/1000', roundsTargetN: '1.25 lb N/1000' });
  });

  test('a database without the tables is left alone', async () => {
    const knex = () => { throw new Error('should not read'); };
    knex.schema = { hasTable: async () => false, hasColumn: async () => false };
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});

// ── Readers that follow the plan without their own month ──────────────────────────────────────────────────────────────────────────
describe('readers that build their own query still reach the round', () => {
  test('the service report record read carries the visit\'s series and date', async () => {
    const { loadServiceRecordForDynamicContext } = require('../services/service-report/dynamic-context');
    const selects = [];
    const knex = (table) => {
      const chain = {};
      for (const name of ['where', 'leftJoin']) chain[name] = () => chain;
      chain.select = (...columns) => { selects.push(columns); return chain; };
      chain.first = async () => ({ id: 'rec' });
      chain.columnInfo = async () => ({});
      chain.catch = () => Promise.resolve({});
      chain.then = (resolve) => Promise.resolve({}).then(resolve);
      return chain;
    };
    knex.raw = (sql) => sql;
    await loadServiceRecordForDynamicContext('rec', knex);
    expect(selects.flat()).toEqual(expect.arrayContaining(['ss.recurring_pattern as scheduled_recurring_pattern', 'ss.scheduled_date as scheduled_visit_date']));
  });

  test('the assessment context passes a rounds visit\'s round to the window read; any other visit passes none', () => {
    const query = program.visitProtocolQuery({ serviceDate: new Date(), grassTrack: 'st_augustine', scheduledService: { recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-03-20' } });
    expect(query.roundStep).toEqual({ round: 3, month: 2 });
    for (const scheduledService of [{ recurring_pattern: 'monthly', scheduled_date: '2027-03-20' }, null, undefined]) {
      expect(program.visitProtocolQuery({ serviceDate: new Date(), grassTrack: 'st_augustine', scheduledService })).not.toHaveProperty('roundStep');
    }
  });

  test('the inventory forecast sizes demand from the plan, so it follows the round\'s step', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/waveguard-inventory-forecast.js'), 'utf8');
    expect(source).toMatch(/await buildPlanForService\(service\.id,/);
  });
});
