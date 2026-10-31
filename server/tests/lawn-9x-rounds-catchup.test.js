// 9x rounds: the spring pre-emergent catch-up for a NEW customer (owner 2026-10-29), PR 4b part A of the rounds build.
// Synthetic catalog and a synthetic knex that routes each table to fixture rows: no database.
//
// Pins: a rounds visit that is the FIRST of its series, dated in round 3 (Mar 15 to Apr 23), on a lawn with no dithiopyr or prodiamine on the
// ledger this year, gets ONE extra selected line, Dimension 2EW 0.5 fl oz per 1,000 sq ft, hose, 1 gal carrier (the March window's row, 0 N,
// so round 3 stays 1.0 lb N); every other visit is planned exactly as before; a capped or unusable line is dropped with a warning and never
// blocks the plan; the completion attributes a recorded 2EW to the catch-up's row; the tank sheet reads the same decision.
const v13 = require('../config/lawn-protocol-v13.json');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/lawn-v13-count-caps', () => ({
  ...jest.requireActual('../config/lawn-v13-count-caps'),
  v13CapEntryFor: jest.fn(async () => null),
  capIdMap: jest.fn(async () => new Map()),
}));
jest.mock('../services/application-limits', () => ({
  ...jest.requireActual('../services/application-limits'),
  checkLimits: jest.fn(async () => ({ blocks: [], warnings: [] })),
}));

const limits = require('../services/application-limits');
const program = require('../services/lawn-program');
const engine = require('../services/waveguard-plan-engine');
const catchUp = require('../services/lawn-rounds-catchup');
const { getProtocolWindowContext } = require('../services/lawn-protocol-operating-layer');

const saved = {};
const GATE_ENV = ['GATE_LAWN_V13', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
beforeAll(() => { for (const name of GATE_ENV) saved[name] = process.env[name]; });
beforeEach(() => {
  process.env.GATE_LAWN_V13 = 'true'; delete process.env.GATE_LAWN_COMPLETION_DEFAULTS; delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  limits.checkLimits.mockReset();
  limits.checkLimits.mockImplementation(async () => ({ blocks: [], warnings: [] }));
});
afterAll(() => { for (const name of GATE_ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

// ── A fake knex over the tables the plan, the decision and the completion read ───────────────────────────────────────────────────
// Equality filters, the comparison form where(column, op, value), grouped where(function) with orWhere, whereNot, whereNotIn (a list or a
// sub-query), whereNull and the ILIKE raw of the ingredient check. A row that lacks a filtered column passes it (a fixture states only the
// columns that matter). Every other builder method is a pass-through.
const strip = (column) => String(column).split('.').pop();
function makeChain(table, db, data) {
  const state = { preds: [] };
  const chain = {};
  const compare = (key, op, value) => (row) => {
    if (!(key in row)) return true;
    const a = row[key] instanceof Date ? row[key].toISOString().slice(0, 10) : row[key];
    switch (op) {
      case '<': return String(a) < String(value);
      case '<=': return String(a) <= String(value);
      case '>': return String(a) > String(value);
      case '>=': return String(a) >= String(value);
      case '!=': return String(a) !== String(value);
      default: return Array.isArray(value) ? value.map(String).includes(String(a)) : String(a) === String(value);
    }
  };
  const add = (type, pred) => { state.preds.push({ type, pred }); return chain; };
  const group = (fn) => {
    const inner = makeChain(table, db, data);
    fn.call(inner);
    return (row) => inner.test(row);
  };
  const whereLike = (type) => (a, b, c) => {
    if (typeof a === 'function') return add(type, group(a));
    if (a && typeof a === 'object') { const checks = Object.entries(a).map(([k, v]) => compare(strip(k), '=', v)); return add(type, (row) => checks.every((check) => check(row))); }
    if (c !== undefined) return add(type, compare(strip(a), b, c));
    if (b === undefined) return chain;
    return add(type, compare(strip(a), '=', b));
  };
  chain.where = whereLike('and');
  chain.orWhere = whereLike('or');
  chain.andWhere = chain.where;
  chain.whereNot = (column, value) => add('and', (row) => !compare(strip(column), '=', value)(row) || !(strip(column) in row));
  const notIn = (type) => (column, values) => {
    const list = values && values.rows ? values.rows().map((row) => row.id) : values;
    return add(type, (row) => !(strip(column) in row) || row[strip(column)] == null || !list.map(String).includes(String(row[strip(column)])));
  };
  chain.whereNotIn = notIn('and');
  chain.orWhereNotIn = notIn('or');
  chain.whereIn = (column, values) => add('and', compare(strip(column), '=', values));
  chain.whereNull = (column) => add('and', (row) => !(strip(column) in row) || row[strip(column)] == null);
  chain.orWhereNull = (column) => add('or', (row) => !(strip(column) in row) || row[strip(column)] == null);
  chain.whereNotNull = () => chain;
  // `pc.active_ingredient ILIKE ?` reads the catalog's column (fixture key catalog_active_ingredient), `pah.active_ingredient` the ledger's own.
  const raw = (type) => (sql, bindings = []) => {
    const m = String(sql).match(/^(\w+)\.active_ingredient ILIKE \?$/);
    if (!m) return chain;
    const key = m[1] === 'pc' ? 'catalog_active_ingredient' : 'active_ingredient';
    const re = new RegExp(String(bindings[0]).replace(/%/g, '.*'), 'i');
    return add(type, (row) => re.test(String(row[key] || '')));
  };
  chain.whereRaw = raw('and');
  chain.orWhereRaw = raw('or');
  for (const name of ['select', 'leftJoin', 'join', 'orderBy', 'limit', 'groupBy', 'distinct', 'modify', 'forUpdate', 'forShare', 'whereExists', 'whereNotExists', 'whereILike']) chain[name] = () => chain;
  chain.test = (row) => state.preds.reduce((ok, { type, pred }, index) => (index === 0 ? pred(row) : (type === 'or' ? ok || pred(row) : ok && pred(row))), true);
  chain.rows = () => {
    const source = data[table];
    const list = typeof source === 'function' ? source() : (source || []);
    return list.filter((row) => chain.test(row));
  };
  chain.del = async () => 0;
  chain.insert = (row) => {
    (db.inserts[table] = db.inserts[table] || []).push(row);
    const done = Promise.resolve([row]);
    done.onConflict = () => ({ merge: () => ({ returning: async () => [{ id: 'completion-1', ...row }] }) });
    return done;
  };
  chain.first = async () => chain.rows()[0] ?? null;
  chain.pluck = async (column) => chain.rows().map((row) => row[column]);
  chain.then = (resolve, reject) => Promise.resolve(chain.rows()).then(resolve, reject);
  chain.catch = (reject) => chain.then(undefined, reject);
  return chain;
}
function fakeDb(data) {
  const db = (tableSpec) => makeChain(String(tableSpec).split(/\s+as\s+/i)[0].trim(), db, data);
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.raw = async () => ({ rows: [] });
  db.fn = { now: () => new Date() };
  db.isTransaction = false;
  db.inserts = {};
  return db;
}

// ── The fixture: a staged v13 protocol with the rows round 3, round 4 and a 12x March visit read ─────────────────────────────────
const WINDOW_KEYS = { 2: 'feb_v13_spreader_green_up', 3: 'mar_v13_pre_m_hose', 5: 'may_v13_tetrino_hose' };
const NAMES = {
  F24: 'LESCO 24-0-11 with PolyPlus OPTI',
  DIM2: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
  CEL: 'Celsius WG', CER: 'Certainty Turf Herbicide',
  NT: 'LESCO Nutra-TECH T&O Micronutrient Package',
  TET: 'Tetrino Insecticide',
};
const fresh = new Date('2026-10-01');
const CATALOG = [
  { id: 'p-f24', name: NAMES.F24, category: 'fertilizer', analysis_n: 24, analysis_p: 0, analysis_k: 11, formulation: 'Granular', default_rate_per_1000: 4.17, rate_unit: 'lb', active: true, label_verified_at: fresh, inventory_on_hand: 1000, inventory_unit: 'lb' },
  { id: 'p-2ew', name: NAMES.DIM2, category: 'herbicide', active_ingredient: 'Dithiopyr', formulation: 'Liquid', default_rate_per_1000: 0.5, rate_unit: 'fl oz', active: true, label_verified_at: fresh, inventory_on_hand: 1000, inventory_unit: 'fl oz' },
  { id: 'p-cel', name: NAMES.CEL, category: 'herbicide', default_rate_per_1000: 0.085, rate_unit: 'oz', active: true, label_verified_at: fresh, inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-cer', name: NAMES.CER, category: 'herbicide', default_rate_per_1000: 0.028, rate_unit: 'oz', active: true, label_verified_at: fresh, inventory_on_hand: 100, inventory_unit: 'oz' },
  { id: 'p-nt', name: NAMES.NT, category: 'fertilizer', analysis_n: 0, analysis_p: 0, analysis_k: 0, default_rate_per_1000: 6, rate_unit: 'fl oz', active: true, label_verified_at: fresh, inventory_on_hand: 1000, inventory_unit: 'fl oz' },
  { id: 'p-tet', name: NAMES.TET, category: 'insecticide', default_rate_per_1000: 0.367, rate_unit: 'fl oz', active: true, label_verified_at: fresh, inventory_on_hand: 100, inventory_unit: 'fl oz' },
];
const CAT = Object.fromEntries(CATALOG.map((p) => [p.name, p]));

function protocolTables(track = 'st_augustine', { rows2ew = true } = {}) {
  const windows = Object.entries(WINDOW_KEYS).map(([month, key]) => ({ id: `w-${key}`, lawn_protocol_id: 'proto', month: Number(month), window_key: key, title: key, visit_type: 'fixture', production_mode: Number(month) === 2 ? 'spreader_plus_spot_backpack' : 'main_reel_plus_spot_backpack', default_carrier_gal_per_1000: Number(month) === 2 ? null : 1, sort_order: Number(month) }));
  const row = (month, name, extra = {}) => ({
    id: `row-${month}-${name}`, lawn_protocol_window_id: `w-${WINDOW_KEYS[month]}`, product_id: CAT[name].id, product_name: name, role: 'x', application_mode: 'broadcast',
    rate_per_1000: null, rate_unit: null, carrier_gal_per_1000: null, default_in_plan: false, gates: {}, annual_counter: {}, mixing: {}, report_copy: {}, sort_order: 1, ...extra,
  });
  const spot = (month, name, gates = {}) => row(month, name, { role: 'post_emergent_spot', application_mode: 'spot', rate_unit: 'label_rate', gates, sort_order: 20 });
  const products = [
    row(2, NAMES.F24, { role: 'nutrition', default_in_plan: true, rate_unit: 'lb_n', gates: { targetN: '0.75 lb N/1000', blackoutSensitive: true } }),
    spot(2, NAMES.CEL, { annualCounter: 'celsius_oz_per_1000' }),
    // March: the pre-emergent is the 2EW (0.5 fl oz, hose, 1 gal) with the micronutrients and the weed mix.
    ...(rows2ew ? [row(3, NAMES.DIM2, { role: 'pre_emergent', default_in_plan: true, rate_per_1000: 0.5, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { annualCounter: 'prodiamine_oz_per_1000' } })] : []),
    row(3, NAMES.NT, { default_in_plan: true, rate_per_1000: 6, rate_unit: 'fl oz', carrier_gal_per_1000: 1 }),
    spot(3, NAMES.CEL, { annualCounter: 'celsius_oz_per_1000' }),
    spot(3, NAMES.CER, { tankMixWith: 'Celsius WG' }),
    // May: Tetrino alone.
    row(5, NAMES.TET, { role: 'insecticide', default_in_plan: true, rate_per_1000: 0.367, rate_unit: 'fl oz', carrier_gal_per_1000: 1, gates: { sunnyTurfOnly: true, applyAlone: true } }),
  ];
  return {
    lawn_protocols: [{ id: 'proto', protocol_key: 'fixture_v13', version: program.LAWN_V13_VERSION, name: 'Fixture v13', status: 'staged', grass_track: track, region: 'swfl', effective_from: '2000-01-01' }],
    lawn_protocol_windows: windows,
    lawn_protocol_products: products,
    lawn_protocol_gates: [],
  };
}

// The visit under test is 'visit-1'. `series` are the other visits of its series; `history` the ledger rows of the customer.
function planDb({ date, pattern = 'lawn_rounds_9', series = [], history = [], parent = null, rows2ew = true, track = 'st_augustine', city = 'Lakewood Ranch' }) {
  const service = {
    id: 'visit-1', customer_id: 'cust-1', property_id: null, recurring_parent_id: parent, scheduled_date: date, service_type: 'Lawn Care', recurring_pattern: pattern, recurring_interval_days: null,
    first_name: 'Test', last_name: 'Customer', city, state: 'FL', zip: '34202', waveguard_tier: 'Gold', lawn_type: 'St. Augustine', property_type: 'residential', status: 'scheduled',
    lawn_protocol_key: null, lawn_protocol_version: null, lawn_protocol_window_key: null,
  };
  const profile = { id: 'profile-1', customer_id: 'cust-1', active: true, track_key: track, grass_type: track, lawn_sqft: 10000, municipality: city, sun_exposure: 'full_sun', updated_at: new Date('2026-10-01') };
  return fakeDb({
    scheduled_services: [service, ...series],
    customer_turf_profiles: [profile],
    products_catalog: CATALOG,
    property_application_history: history,
    ...protocolTables(track, { rows2ew }),
  });
}
const NOW = new Date('2026-10-29T16:00:00Z');
const planWith = (options) => engine.buildPlanForService('visit-1', { db: planDb(options), billingModeColumnExists: false, now: NOW });
const itemsOf = (plan) => [...plan.protocol.base, ...plan.protocol.conditional];
const selectedNames = (plan) => plan.mixCalculator.items.map((item) => item.product?.name);
const DITHIOPYR_FEB = { id: 'h1', customer_id: 'cust-1', application_date: '2027-02-10', retracted_at: null, property_id: null, service_record_id: 'r-old', catalog_active_ingredient: 'dithiopyr', active_ingredient: 'dithiopyr' };
const PRODIAMINE_JAN = { ...DITHIOPYR_FEB, id: 'h2', application_date: '2027-01-12', catalog_active_ingredient: 'prodiamine', active_ingredient: 'Prodiamine' };
const earlierVisit = (extra = {}) => ({ id: 'visit-0', customer_id: 'cust-1', recurring_parent_id: null, scheduled_date: '2027-02-10', status: 'completed', ...extra });

// ── The decision ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the catch-up on a new customer\'s first round-3 visit', () => {
  test('first visit Mar 20, no pre-emergent on the ledger: Dimension 2EW 0.5 fl oz per 1,000, hose, 1 gal carrier, selected', async () => {
    const plan = await planWith({ date: '2027-03-20' });
    expect(plan.propertyGate.blocks).toEqual([]);
    const line = plan.mixCalculator.items.find((item) => item.product?.name === NAMES.DIM2);
    expect(line).toMatchObject({ selected: true, selectionReason: 'rounds_catchup', roundsCatchUp: true, roundsCatchUpLabel: 'Spring pre-emergent catch-up for a new customer' });
    expect(line.mix.ratePer1000).toBe(0.5);
    expect(line.mix.rateUnit).toBe('fl oz');
    expect(line.mix.amount).toBe(5);
    // The row's own carrier (1 gal per 1,000 sq ft over 10,000 sq ft), though the round's step window states no carrier.
    expect(line.mix.carrierGallons).toBe(10);
    expect(line.spot).toBeNull();
    expect(line.unavailable).toBeNull();
    expect(line.gateNotes.map((note) => note.key)).toContain('roundsCatchUp');
    expect(line.gateNotes.find((note) => note.key === 'roundsCatchUp').text).toMatch(/^Spring pre-emergent catch-up for a new customer\./);
    // The plan says so too, and names it for the completion.
    expect(plan.roundsCatchUp).toMatchObject({ active: true, label: 'Spring pre-emergent catch-up for a new customer' });
    expect(plan.roundStep).toEqual({ round: 3, month: 2, spotMonth: 3, catchUp: true });
    expect(plan.protocol.structured.products.map((p) => p.protocolProductName)).toEqual(expect.arrayContaining([NAMES.F24, NAMES.DIM2]));
  });

  test('round 3 stays at 1.0 lb N: the bag is the 4.17 lb rounds bag and the visit projects 1.0 lb N (the 2EW adds none)', async () => {
    const plan = await planWith({ date: '2027-03-20' });
    const bag = plan.mixCalculator.items.find((item) => item.product?.name === NAMES.F24);
    expect(bag.mix.ratePer1000).toBeCloseTo(4.17, 2);
    expect(bag.mix.targetNPer1000).toBe(1);
    expect(plan.mixCalculator.nutrientProjection.nPer1000).toBeCloseTo(1, 1);
    expect(plan.mixCalculator.items.find((item) => item.product?.name === NAMES.DIM2).product.analysis_n ?? 0).toBe(0);
  });

  test('the visit\'s own lines are as they were: the bag first, the weed lines after, the catch-up only added', async () => {
    const withCatchUp = await planWith({ date: '2027-03-20' });
    const without = await planWith({ date: '2027-03-20', history: [DITHIOPYR_FEB] });
    expect(selectedNames(withCatchUp)).toEqual([...selectedNames(without), NAMES.DIM2]);
    expect(itemsOf(without).map((item) => item.product?.name)).toEqual(itemsOf(withCatchUp).filter((item) => !item.roundsCatchUp).map((item) => item.product?.name));
  });

  test('the catch-up applies on any round-3 date, Apr 20 included', async () => {
    expect(selectedNames(await planWith({ date: '2027-04-20' }))).toContain(NAMES.DIM2);
    expect(selectedNames(await planWith({ date: '2027-03-15' }))).toContain(NAMES.DIM2);
  });

  test('a dithiopyr application on Feb 10 of the same year: no catch-up, and the plan carries no trace of it', async () => {
    const plan = await planWith({ date: '2027-03-20', history: [DITHIOPYR_FEB] });
    expect(selectedNames(plan)).not.toContain(NAMES.DIM2);
    expect(itemsOf(plan).some((item) => item.roundsCatchUp)).toBe(false);
    expect(plan).not.toHaveProperty('roundsCatchUp');
    expect(plan.roundStep).toEqual({ round: 3, month: 2, spotMonth: 3 });
    expect(plan.protocol.structured.products.map((p) => p.protocolProductName)).not.toContain(NAMES.DIM2);
    expect(plan.propertyGate.warnings.map((w) => w.code)).not.toContain('lawn_rounds_catchup_unavailable');
  });

  test('a prodiamine application earlier this year also counts', async () => {
    expect(selectedNames(await planWith({ date: '2027-03-20', history: [PRODIAMINE_JAN] }))).not.toContain(NAMES.DIM2);
  });

  test('last year\'s application, a retracted one and another customer\'s do not count', async () => {
    for (const history of [
      [{ ...DITHIOPYR_FEB, application_date: '2026-10-01' }],
      [{ ...DITHIOPYR_FEB, retracted_at: new Date('2027-02-11') }],
      [{ ...DITHIOPYR_FEB, customer_id: 'cust-2' }],
      [{ ...DITHIOPYR_FEB, catalog_active_ingredient: 'tetraniliprole', active_ingredient: 'tetraniliprole' }],
    ]) expect(selectedNames(await planWith({ date: '2027-03-20', history }))).toContain(NAMES.DIM2);
  });

  test('a second visit of the series in round 3 (an earlier visit exists): no catch-up', async () => {
    const plan = await planWith({ date: '2027-03-20', parent: 'visit-0', series: [earlierVisit()] });
    expect(selectedNames(plan)).not.toContain(NAMES.DIM2);
    expect(plan).not.toHaveProperty('roundsCatchUp');
  });

  test('an earlier CANCELLED visit does not make it a second visit; a later visit does not either', async () => {
    const cancelled = await planWith({ date: '2027-03-20', parent: 'visit-0', series: [earlierVisit({ status: 'cancelled' })] });
    expect(selectedNames(cancelled)).toContain(NAMES.DIM2);
    const later = await planWith({ date: '2027-03-20', parent: 'visit-0', series: [earlierVisit({ scheduled_date: '2027-05-05', status: 'scheduled' })] });
    expect(selectedNames(later)).toContain(NAMES.DIM2);
    // Another series (another root) never counts.
    const other = await planWith({ date: '2027-03-20', series: [earlierVisit({ id: 'visit-x', recurring_parent_id: 'other-root' })] });
    expect(selectedNames(other)).toContain(NAMES.DIM2);
  });

  test('a first visit in round 4 (May 5): no catch-up, and Tetrino still applies alone', async () => {
    const plan = await planWith({ date: '2027-05-05' });
    expect(plan.propertyGate.blocks).toEqual([]);
    expect(selectedNames(plan)).toEqual([NAMES.TET]);
    expect(plan.roundStep).toEqual({ round: 4, month: 5, spotMonth: 5 });
    expect(plan).not.toHaveProperty('roundsCatchUp');
    expect(plan.protocol.structured.products.map((p) => p.protocolProductName)).not.toContain(NAMES.DIM2);
  });

  test('a first visit in round 2 (Feb 10) or round 5 (Jun 10): no catch-up either', async () => {
    for (const date of ['2027-02-10', '2027-03-10', '2027-06-10']) {
      expect((await planWith({ date })).roundStep.catchUp).toBeUndefined();
    }
  });

  test('a non-rounds first lawn visit in March is planned exactly as before (no rounds fields, the same plan with or without history)', async () => {
    const noHistory = await planWith({ date: '2027-03-20', pattern: 'monthly' });
    const withHistory = await planWith({ date: '2027-03-20', pattern: 'monthly', history: [DITHIOPYR_FEB] });
    const stable = (plan) => JSON.parse(JSON.stringify({ ...plan, generatedAt: null }));
    expect(stable(noHistory)).toEqual(stable(withHistory));
    expect(noHistory).not.toHaveProperty('roundStep');
    expect(noHistory).not.toHaveProperty('roundsCatchUp');
    expect(itemsOf(noHistory).some((item) => 'roundsCatchUp' in item)).toBe(false);
    // The 12x March window's own 2EW is the visit's own base line, not the catch-up.
    expect(noHistory.protocol.structured.window.key).toBe(WINDOW_KEYS[3]);
  });

  test.each(['every_6_weeks', 'custom'])('a legacy 9x (%s) first March visit: unchanged', async (pattern) => {
    const plan = await planWith({ date: '2027-03-20', pattern });
    expect(plan).not.toHaveProperty('roundsCatchUp');
    expect(plan).not.toHaveProperty('roundStep');
  });

  test('v13 off: no catch-up (the round map names v13 steps)', async () => {
    delete process.env.GATE_LAWN_V13;
    const db = planDb({ date: '2027-03-20' });
    await expect(catchUp.catchUpWanted(db, { id: 'visit-1', customer_id: 'cust-1', recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-03-20' })).resolves.toBe(false);
  });

  test('the decision reads nothing for a visit that is not a round-3 rounds visit', async () => {
    const knex = () => { throw new Error('should not read'); };
    for (const service of [
      { id: 'v', customer_id: 'c', recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-05-05' },
      { id: 'v', customer_id: 'c', recurring_pattern: 'monthly', scheduled_date: '2027-03-20' },
      { id: 'v', customer_id: 'c', recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-04-24' },
      { id: 'v', customer_id: 'c', recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-03-14' },
    ]) await expect(catchUp.catchUpWanted(knex, service)).resolves.toBe(false);
  });

  test('a failed read is "no catch-up", and a strict caller gets the error', async () => {
    const knex = () => { throw new Error('db down'); };
    const service = { id: 'v', customer_id: 'c', recurring_pattern: 'lawn_rounds_9', scheduled_date: '2027-03-20', recurring_parent_id: null };
    await expect(catchUp.catchUpWanted(knex, service)).resolves.toBe(false);
    await expect(catchUp.catchUpWanted(knex, service, { strict: true })).rejects.toThrow('db down');
  });
});

// ── The cap ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('a catch-up that cannot be applied is dropped with a warning and never blocks the plan', () => {
  const cappedFor = (id) => limits.checkLimits.mockImplementation(async (_customer, productId) => (String(productId) === id
    ? { blocks: [{ type: 'annual_max_rate', message: 'Dimension 2EW: dithiopyr across all products this year is 91% of the yearly label cap; this application brings it to 114% — THIS APPLICATION WOULD EXCEED IT.' }], warnings: [] }
    : { blocks: [], warnings: [] }));

  test('capped (history near the cap): the line leaves with a warning, the plan is not blocked, the bag is untouched', async () => {
    cappedFor('p-2ew');
    const plan = await planWith({ date: '2027-03-20' });
    expect(selectedNames(plan)).toEqual([NAMES.F24]);
    expect(itemsOf(plan).some((item) => item.roundsCatchUp)).toBe(false);
    expect(plan.propertyGate.blocks).toEqual([]);
    expect(plan.status).toBe('warning');
    const warning = plan.propertyGate.warnings.find((w) => w.code === 'lawn_rounds_catchup_unavailable');
    expect(warning.message).toMatch(/Spring pre-emergent catch-up for a new customer: not planned on this visit \(a yearly application limit is reached\)/);
    // No annual-limit block for the dropped line, and it leaves the output.
    expect(plan.propertyGate.blocks.map((b) => b.code)).not.toContain('lawn_v13_annual_limit');
    expect(plan).not.toHaveProperty('roundsCatchUp');
    expect(plan.roundStep).toEqual({ round: 3, month: 2, spotMonth: 3 });
    expect(plan.protocol.structured.products.map((p) => p.protocolProductName)).not.toContain(NAMES.DIM2);
    expect(plan.mixingOrder.map((step) => step.productName || step.raw)).not.toContain(NAMES.DIM2);
  });

  test('the limit read went through the existing path (checkLimits for the 2EW product, as a proposal at 0.5 fl oz)', async () => {
    await planWith({ date: '2027-03-20' });
    const call = limits.checkLimits.mock.calls.find(([, productId]) => productId === 'p-2ew');
    expect(call).toBeTruthy();
    expect(call[4]).toMatchObject({ proposal: true, proposed: { ratePer1000: 0.5, unit: 'fl oz' } });
  });

  test('a blocked 2EW that is not the catch-up still blocks the plan as before (a 12x March visit)', async () => {
    cappedFor('p-2ew');
    const plan = await planWith({ date: '2027-03-20', pattern: 'monthly' });
    expect(plan.propertyGate.blocks.map((b) => b.code)).toContain('lawn_v13_annual_limit');
  });

  test('a warning-level limit keeps the line and the warning', async () => {
    limits.checkLimits.mockImplementation(async (_c, productId) => ({ blocks: [], warnings: String(productId) === 'p-2ew' ? [{ type: 'annual_max_rate', message: 'Dimension 2EW: 90% of the yearly label cap.' }] : [] }));
    const plan = await planWith({ date: '2027-03-20' });
    expect(selectedNames(plan)).toContain(NAMES.DIM2);
    expect(plan.propertyGate.warnings.map((w) => w.message)).toContain('Dimension 2EW: 90% of the yearly label cap.');
  });

  test('no staged March 2EW row: the line leaves with a warning (no block, the bag stays)', async () => {
    const plan = await planWith({ date: '2027-03-20', rows2ew: false });
    expect(selectedNames(plan)).toEqual([NAMES.F24]);
    expect(plan.propertyGate.blocks).toEqual([]);
    expect(plan.propertyGate.warnings.find((w) => w.code === 'lawn_rounds_catchup_unavailable').message).toMatch(/protocol row is not linked/);
  });

  test('an inactive 2EW product: warning, not a block', async () => {
    const db = planDb({ date: '2027-03-20' });
    const index = CATALOG.findIndex((p) => p.id === 'p-2ew');
    const original = CATALOG[index];
    CATALOG[index] = { ...original, active: false };
    try {
      const plan = await engine.buildPlanForService('visit-1', { db, billingModeColumnExists: false, now: NOW });
      expect(selectedNames(plan)).not.toContain(NAMES.DIM2);
      expect(plan.propertyGate.blocks).toEqual([]);
      expect(plan.propertyGate.warnings.map((w) => w.code)).toContain('lawn_rounds_catchup_unavailable');
    } finally {
      CATALOG[index] = original;
    }
  });

  test('North Port: the catch-up has no N or P, so it stays on the visit while the April nitrogen bag is held', async () => {
    const plan = await planWith({ date: '2027-04-05', city: 'North Port' });
    expect(selectedNames(plan)).toEqual([NAMES.DIM2]);
    expect(plan.propertyGate.blocks).toEqual([]);
  });
});

// ── The window read ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('getProtocolWindowContext with roundStep.catchUp', () => {
  const read = (roundStep, date = '2027-03-20') => getProtocolWindowContext(fakeDb(protocolTables()), { protocolId: 'proto', serviceDate: new Date(`${date}T16:00:00Z`), strict: true, planning: true, roundStep });
  const names = (context) => context.products.map((p) => p.product_name);

  test('adds the March window\'s 2EW row once, after the round\'s own rows', async () => {
    const context = await read({ round: 3, month: 2, catchUp: true });
    expect(context.window.window_key).toBe(WINDOW_KEYS[2]);
    expect(names(context)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER, NAMES.DIM2]);
    expect(context.products.find((p) => p.product_name === NAMES.DIM2)).toMatchObject({ role: 'pre_emergent', carrier_gal_per_1000: 1 });
  });

  test('without catchUp the rows are the round\'s, as 4a read them', async () => {
    expect(names(await read({ round: 3, month: 2 }))).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER]);
    expect(names(await read({ round: 3, month: 2, catchUp: false }))).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER]);
  });

  test('a March window with no 2EW row adds nothing; the March window itself is not doubled', async () => {
    const context = await getProtocolWindowContext(fakeDb(protocolTables('st_augustine', { rows2ew: false })), { protocolId: 'proto', serviceDate: new Date('2027-03-20T16:00:00Z'), strict: true, planning: true, roundStep: { round: 3, month: 2, catchUp: true } });
    expect(names(context)).toEqual([NAMES.F24, NAMES.CEL, NAMES.CER]);
    const march = await read({ round: 3, month: 3, catchUp: true });
    expect(names(march).filter((n) => n === NAMES.DIM2)).toHaveLength(1);
  });

  test('loadV13RowsForMonth passes the catch-up to the read (the tank sheet\'s rows)', async () => {
    const db = fakeDb(protocolTables());
    const rows = await engine.loadV13RowsForMonth(db, 'st_augustine', 'Feb', { spotMonth: 3, catchUp: true });
    expect(rows.has('p-2ew')).toBe(true);
    expect((await engine.loadV13RowsForMonth(db, 'st_augustine', 'Feb', { spotMonth: 3 })).has('p-2ew')).toBe(false);
  });
});

// ── Completion attribution ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe('completion attribution of the catch-up', () => {
  const { recordLawnProtocolCompletion } = require('../services/lawn-protocol-completion');
  const applied = (name) => ({ id: `sp-${name}`, product_id: CAT[name].id, product_name: name, application_rate: 0.5, rate_unit: 'fl oz', total_amount: 5, amount_unit: 'fl oz' });
  async function attribute(options, names) {
    const db = planDb(options);
    const plan = await engine.buildPlanForService('visit-1', { db, billingModeColumnExists: false, now: NOW });
    await recordLawnProtocolCompletion(db, {
      service: { id: 'visit-1', customer_id: 'cust-1' }, serviceRecord: { id: 'record-1' }, plan, serviceProducts: names.map(applied), completionInput: { inventoryDeductions: [] },
    });
    return Object.fromEntries((db.inserts.lawn_protocol_product_actuals || []).map((row) => [row.product_name, row]));
  }

  test('the recorded 2EW attributes to the catch-up\'s row (the March window\'s), the bag to February\'s: no off_protocol_applied', async () => {
    const actuals = await attribute({ date: '2027-03-20' }, [NAMES.F24, NAMES.DIM2]);
    expect(actuals[NAMES.DIM2]).toMatchObject({ protocol_product_id: `row-3-${NAMES.DIM2}`, status: 'applied' });
    expect(actuals[NAMES.F24]).toMatchObject({ protocol_product_id: `row-2-${NAMES.F24}`, status: 'applied' });
  });

  test('a visit with no catch-up (history on the ledger): the same 2EW is off protocol, as before', async () => {
    const actuals = await attribute({ date: '2027-03-20', history: [DITHIOPYR_FEB] }, [NAMES.DIM2]);
    expect(actuals[NAMES.DIM2]).toMatchObject({ protocol_product_id: null, status: 'off_protocol_applied' });
  });

  test('a second visit in round 3: the 2EW is off protocol', async () => {
    const actuals = await attribute({ date: '2027-03-20', parent: 'visit-0', series: [earlierVisit()] }, [NAMES.DIM2]);
    expect(actuals[NAMES.DIM2].status).toBe('off_protocol_applied');
  });
});

// ── Readers that follow the plan ────────────────────────────────────────────────────────────────────────────────────────────────
describe('the catch-up line helpers', () => {
  test('the line comes from the track\'s March step, and only when that step has a 2EW line', () => {
    const lines = catchUp.catchUpLines(v13.st_augustine, (text, role) => engine.parseProtocolLines(text, role, { exactName: true }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ roundsCatchUp: true, role: 'conditional' });
    expect(lines[0].raw).toBe('Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide — 0.5 fl oz per 1,000 sq ft, hose');
    expect(catchUp.catchUpLines({ visits: [{ month: 'Mar', primary: 'Something Else — 1 oz' }] }, () => [{}])).toEqual([]);
    expect(catchUp.catchUpLines(null, () => [{}])).toEqual([]);
  });

  test('all three tracks have the same March 2EW line', () => {
    for (const track of ['st_augustine', 'bermuda', 'zoysia']) {
      const march = v13[track].visits.find((v) => v.month === 'Mar');
      expect(march.primary.split('\n')[0]).toBe('Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide — 0.5 fl oz per 1,000 sq ft, hose');
    }
  });

  test('isCatchUpRow: the 2EW pre-emergent row only (not granular Dimension, not a bermuda removal row)', () => {
    expect(catchUp.isCatchUpRow({ role: 'pre_emergent', product_name: NAMES.DIM2 })).toBe(true);
    expect(catchUp.isCatchUpRow({ role: 'pre_emergent', product_name: 'x', catalog_product_name: NAMES.DIM2 })).toBe(true);
    expect(catchUp.isCatchUpRow({ role: 'nutrition', product_name: 'LESCO Dimension 0.21% 18-0-10' })).toBe(false);
    expect(catchUp.isCatchUpRow({ role: 'pre_emergent', product_name: NAMES.DIM2, gates: { bermudaRemoval: true } })).toBe(false);
    expect(catchUp.isCatchUpRow(null)).toBe(false);
  });
});

// ── The tank sheet ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the tank sheet source reads the same decision', () => {
  const fs = require('fs');
  const path = require('path');
  test('the /lawn-mix route asks lawn-rounds-catchup, loads the catch-up row and settles the line like the plan', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-protocols.js'), 'utf8');
    expect(source).toMatch(/roundsCatchUp\.catchUpWanted\(db, scheduled\)/);
    expect(source).toMatch(/catchUp: catchUpWanted/);
    expect(source).toMatch(/settleSheetCatchUp\(roundsCatchUp\.selectCatchUp\(settled\.items\)/);
    expect(source).toMatch(/roundsCatchUp\.catchUpNotes\(line\)/);
  });
});
