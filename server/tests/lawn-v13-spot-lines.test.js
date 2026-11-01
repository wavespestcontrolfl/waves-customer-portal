// Lawn protocol v13 spot lines: caterpillars in October and November, dry spots from March to October and Celsius alone on the
// summer weed spots (June to September), migration 20261101170000, owner 2026-11-01. Synthetic data only. No database: a small
// in-memory fake knex (the shape of lawn-v13-summer-potassium.test.js).
//
// Pinned: the recipe lines on all three tracks (the exact wording copied from the existing rows); no Certainty, no surfactant and no
// Blindside line in a summer window; the migration rows copy the existing rows of the same product; the treatment guide offers the
// caterpillar and dry spot cards in the new months; the migration appends (no row moves), writes one audit row per protocol, never
// writes Celsius to a bahia protocol, and rolls back all or nothing.
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261101170000_lawn_v13_spot_lines');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { pickAddOns } = require('../services/lawn-treatment-guide');
const { weedMixGroup } = require('../services/lawn-weed-mix');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const V13 = staged.V13_VERSION;
const N = staged.NAMES;
const W = migration.WINDOWS;
const TRACKS = Object.keys(v13Recipe);
const visit = (grass, month) => v13Recipe[grass].visits.find((v) => v.month === month);
const lines = (grass, month) => visit(grass, month).secondary.split('\n');
const lineOf = (grass, month, name) => lines(grass, month).find((l) => l.startsWith(`${name} — `));

const ACELEPRYN_LINE = 'Acelepryn Insecticide — caterpillars, 0.046 to 0.092 fl oz per 1,000 sq ft, recheck in 7 days, delay watering (irrigation) or mowing for 24 hours after application';
const TALAK_LINE = 'Atticus Talak 7.9 F — bifenthrin for caterpillars, second product if Acelepryn does not hold at the 7-day recheck; delay watering 24 hours';
const DISPATCH_LINE = 'Dispatch Sprayable Wetting Agent — dry spots only, no water-in needed';
const CELSIUS_LINE = 'Celsius WG — weed spots, 0.085 oz per 1,000 sq ft, alone: no Certainty and no surfactant (summer), mornings, watered turf only';

const CATERPILLAR_MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
const DRY_SPOT_MONTHS = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const SUMMER_MONTHS = ['Jun', 'Jul', 'Aug', 'Sep'];
const ALL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

describe('spot lines: the recipe', () => {
  test('the audit action fits varchar(96), with room for a migration:<name>:<column> action', () => {
    expect(migration.ACTION.length).toBeLessThanOrEqual(96);
    expect(`migration:${migration.MIGRATION}:${'x'.repeat(40)}`.length).toBeLessThanOrEqual(96);
  });

  test.each(TRACKS)('%s: caterpillars July through November, the Acelepryn line word for word as the July line', (grass) => {
    for (const month of ALL_MONTHS) {
      const expected = CATERPILLAR_MONTHS.includes(month);
      expect(lineOf(grass, month, 'Acelepryn Insecticide')).toBe(expected ? ACELEPRYN_LINE : undefined);
    }
    expect(lineOf(grass, 'Jul', 'Acelepryn Insecticide')).toBe(lineOf(grass, 'Aug', 'Acelepryn Insecticide'));
  });

  test.each(TRACKS)('%s: Talak for caterpillars in October and November (no chinch wording), and July keeps its own chinch line', (grass) => {
    for (const month of ['Oct', 'Nov']) {
      expect(lineOf(grass, month, 'Atticus Talak 7.9 F')).toBe(TALAK_LINE);
      expect(TALAK_LINE).not.toMatch(/chinch|Arena/i);
    }
    expect(lineOf(grass, 'Jul', 'Atticus Talak 7.9 F')).toBe('Atticus Talak 7.9 F — bifenthrin for chinch bugs, second product after Arena, or for caterpillars if Acelepryn does not hold at the 7-day recheck; delay watering 24 hours');
    for (const month of ['Aug', 'Sep', 'Dec', 'Jan']) expect(lineOf(grass, month, 'Atticus Talak 7.9 F')).toBeUndefined();
  });

  test.each(TRACKS)('%s: dry spots March through October, the Dispatch line word for word as the May line', (grass) => {
    for (const month of ALL_MONTHS) {
      expect(lineOf(grass, month, 'Dispatch Sprayable Wetting Agent')).toBe(DRY_SPOT_MONTHS.includes(month) ? DISPATCH_LINE : undefined);
    }
  });

  test.each(TRACKS)('%s: June through September weed spots are Celsius alone: no Certainty, no surfactant, no Blindside', (grass) => {
    for (const month of SUMMER_MONTHS) {
      const secondary = lines(grass, month);
      expect(secondary.filter((l) => l.startsWith('Celsius WG'))).toEqual([CELSIUS_LINE]);
      expect(secondary.filter((l) => /^(Certainty|Blindside|LESCO 90\/10 Nonionic)/.test(l))).toEqual([]);
      const [parsed] = engine.parseProtocolLines(CELSIUS_LINE, 'conditional', { exactName: true });
      expect(parsed).toMatchObject({ scope: 'SPOT_ALLOWANCE', conditional: true });
    }
    // The other months keep the weed lines they had: January, March, October, November and December carry the full mix.
    for (const month of ['Jan', 'Mar', 'May', 'Oct', 'Nov', 'Dec']) expect(lineOf(grass, month, 'Certainty Turf Herbicide')).toBeDefined();
    expect(lineOf(grass, 'Apr', 'Celsius WG')).toBeUndefined();
    expect(lines(grass, 'Feb')).toEqual(['Celsius WG — light weed spots only during green-up, 0.085 oz per 1,000 sq ft, alone: no Certainty and no surfactant this month']);
  });

  test.each(TRACKS)('%s: the track notes say where each line applies', (grass) => {
    const notes = v13Recipe[grass].notes.join('\n');
    expect(notes).toContain('Caterpillars: Acelepryn, then bifenthrin, with a 7-day recheck. Acelepryn on caterpillars: delay watering (irrigation) or mowing for 24 hours after application. Caterpillar spots run July through November.');
    expect(notes).toContain('In February and from June through September the weed spot is Celsius alone: no Certainty and no surfactant.');
    expect(notes).toContain('Dry spots: Dispatch Sprayable, March through October.');
    expect(notes).toMatch(/Blindside Herbicide in its place from November through March \(April through October: no weed spray once the Celsius cap is reached\)/);
  });

  test('the three tracks carry the same spot lines', () => {
    for (const month of ALL_MONTHS) {
      expect(visit('bermuda', month).secondary).toBe(visit('st_augustine', month).secondary);
      expect(visit('zoysia', month).secondary).toBe(visit('st_augustine', month).secondary);
    }
  });
});

describe('spot lines: the rows copy the existing rows of the same product', () => {
  const stagedRow = (windowKey, name) => {
    const hit = staged.PRODUCTS.filter(([key, spec]) => key === windowKey && spec[0] === name).map(([, spec]) => spec);
    expect(hit).toHaveLength(1);
    const [product_name, role, application_mode, rate, rate_unit, carrier, default_in_plan, gates] = hit[0];
    return { product_name, role, application_mode, rate, rate_unit, carrier, default_in_plan, gates };
  };

  test('Dispatch: the May row (role, mode, unit, carrier, trigger and the no water-in gate)', () => {
    const may = stagedRow(W.MAY, N.DSP);
    const { row, gates } = migration.ROWS.DISPATCH;
    expect(row).toMatchObject({ role: may.role, application_mode: may.application_mode, rate_unit: may.rate_unit, carrier_gal_per_1000: may.carrier, default_in_plan: false, rate_per_1000: may.rate });
    expect(gates).toEqual(may.gates);
    expect(gates).toEqual({ trigger: 'dry_spots', noWaterIn: true });
  });

  test('Acelepryn: the August row, including the 24-hour water-or-mow hold', () => {
    const aug = stagedRow(W.AUG, N.ACE);
    const { row, gates } = migration.ROWS.ACELEPRYN;
    expect(row).toMatchObject({ role: aug.role, application_mode: aug.application_mode, rate_unit: aug.rate_unit, carrier_gal_per_1000: aug.carrier, default_in_plan: false, rate_per_1000: aug.rate });
    expect(gates).toMatchObject({ trigger: aug.gates.trigger, rateRange: aug.gates.rateRange });
    expect(gates).toEqual({ trigger: 'caterpillars', rateRange: '0.046-0.092 fl oz/1000', delayWateringOrMowingHours: 24 });
  });

  test('Talak: the July row\'s role, mode, carrier and 24-hour watering hold; no rate and a caterpillar-only trigger', () => {
    const jul = stagedRow(W.JUL, N.TAL);
    const { row, gates } = migration.ROWS.TALAK;
    expect(row).toMatchObject({ role: jul.role, application_mode: jul.application_mode, carrier_gal_per_1000: jul.carrier, default_in_plan: false, rate_per_1000: null, rate_unit: 'label_rate' });
    expect(gates.delayWateringHours).toBe(jul.gates.delayWateringHours);
    expect(gates.trigger).toBe('caterpillars_second_product');
    expect(gates.trigger).not.toMatch(/chinch/);
    // The treatment guide's chinch rungs must not pick it up.
    const { CHINCH_TRIGGERS } = require('../services/lawn-treatment-guide');
    expect(CHINCH_TRIGGERS).not.toContain(gates.trigger);
  });

  test('Celsius: the February row (rate, carrier, stress gate, count cap keys and the annual counter), never on by default', () => {
    const feb = stagedRow(W.FEB, N.CEL);
    const { row, gates, annual_counter } = migration.ROWS.CELSIUS;
    expect(row).toMatchObject({ role: feb.role, application_mode: feb.application_mode, rate_per_1000: feb.rate, rate_unit: feb.rate_unit, carrier_gal_per_1000: feb.carrier, default_in_plan: false });
    expect(gates).toEqual({ ...feb.gates, annualMaxApps: 2 });
    expect(annual_counter).toEqual({ counter: 'celsius_oz_per_1000', maxApplications: 2 });
    expect(migration.ROWS.CELSIUS.skipTracks).toEqual(['bahia']);
  });

  test('no placement writes Blindside, Certainty or the surfactant, and no row defaults into the plan', () => {
    for (const spec of Object.values(migration.ROWS)) {
      expect(spec.row.default_in_plan).toBe(false);
      expect(spec.row.application_mode).toBe('spot');
      expect(spec.name).not.toMatch(/Blindside|Certainty|Surfactant/i);
    }
    const byWindow = Object.fromEntries(migration.PLACEMENTS.map(([key, specs]) => [key, specs.map((s) => s.name)]));
    expect(byWindow).toEqual({
      [W.MAR]: [N.DSP], [W.APR]: [N.DSP],
      [W.JUN]: [N.CEL, N.DSP], [W.JUL]: [N.CEL, N.DSP], [W.AUG]: [N.CEL, N.DSP], [W.SEP]: [N.CEL, N.DSP],
      [W.OCT]: [N.ACE, N.TAL, N.DSP], [W.NOV]: [N.ACE, N.TAL],
    });
  });
});

describe('spot lines: the treatment guide and the weed group', () => {
  const ids = { ACE: 'p-ace', TAL: 'p-tal', DSP: 'p-dsp', CEL: 'p-cel' };
  const specs = { [ids.ACE]: migration.ROWS.ACELEPRYN, [ids.TAL]: migration.ROWS.TALAK, [ids.DSP]: migration.ROWS.DISPATCH, [ids.CEL]: migration.ROWS.CELSIUS };
  // The month's add-ons: the placement's rows, as the plan hands them to the guide (a Map by product id, then the candidates).
  const monthRows = (windowKey) => {
    const placement = migration.PLACEMENTS.find(([key]) => key === windowKey);
    const wanted = new Set((placement ? placement[1] : []).map((s) => s.name));
    return Object.entries(specs).filter(([, s]) => wanted.has(s.name)).map(([id, s]) => [id, { role: s.row.role, gates: s.gates }]);
  };
  const offersFor = (windowKey) => {
    const entries = monthRows(windowKey);
    const rows = new Map(entries);
    const candidates = entries.map(([id, s]) => ({ raw: { product: { id, name: specs[id].name } }, item: { productId: id, name: specs[id].name }, s }));
    return pickAddOns(candidates, rows);
  };

  test.each([[W.OCT, true], [W.NOV, true]])('%s: the caterpillar card is offered, and the pick is Acelepryn, not Talak', (windowKey) => {
    const picks = offersFor(windowKey);
    expect(picks.caterpillars.raw.product.id).toBe(ids.ACE);
  });

  test.each([W.MAR, W.APR, W.JUN, W.JUL, W.AUG, W.SEP, W.OCT])('%s: the dry spot card is offered', (windowKey) => {
    expect(offersFor(windowKey).dry_spots.raw.product.id).toBe(ids.DSP);
  });

  test('November has no dry spot row and a summer window has no caterpillar row from this migration', () => {
    expect(offersFor(W.NOV).dry_spots).toBeNull();
    expect(offersFor(W.JUN).caterpillars).toBeNull();
  });

  test('Celsius alone forms no weed group (no tank-mix member), so it is a plain add-on and the tap is not drawn', () => {
    const celsius = { product: { id: ids.CEL, name: N.CEL }, gates: migration.ROWS.CELSIUS.gates };
    expect(weedMixGroup([celsius])).toBeNull();
    expect(migration.ROWS.CELSIUS.gates).not.toHaveProperty('tankMixWith');
  });
});

// ── a small in-memory knex ───────────────────────────────────────────────────

function fakeKnex(seed = {}) {
  const tables = {
    lawn_protocols: [], lawn_protocol_windows: [], lawn_protocol_products: [], lawn_protocol_audit_log: [],
    scheduled_services: [], lawn_protocol_service_completions: [], ...seed,
  };
  let next = 1;
  const matches = (row, filters) => filters.length === 0 || filters.some((group) => group.every(([k, v]) => String(row[k]) === String(v)));
  const knex = (name) => {
    expect(tables).toHaveProperty(name);
    const groups = [];
    const rowsNow = () => tables[name].filter((row) => matches(row, groups));
    const builder = {
      where(a, b) {
        const pairs = typeof a === 'object' ? Object.entries(a) : [[a, b]];
        if (groups.length === 0) groups.push(pairs); else groups.forEach((g) => g.push(...pairs));
        return builder;
      },
      orWhere(a) { groups.push(Object.entries(a)); return builder; },
      select(...columns) {
        return Promise.resolve(rowsNow().map((row) => (columns.length ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row })));
      },
      async first(...columns) {
        const [row] = rowsNow();
        if (!row) return undefined;
        return columns.length ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row };
      },
      insert(values) {
        const list = Array.isArray(values) ? values : [values];
        const made = list.map((value) => {
          const row = { id: `id-${next++}`, ...value };
          tables[name].push(row);
          return row;
        });
        const result = Promise.resolve(made.map(({ id }) => ({ id })));
        result.returning = () => Promise.resolve(made.map(({ id }) => ({ id })));
        return result;
      },
      async update(values) {
        const hit = rowsNow();
        hit.forEach((row) => Object.assign(row, values));
        return hit.length;
      },
      async del() {
        const hit = new Set(rowsNow());
        tables[name] = tables[name].filter((row) => !hit.has(row));
        return hit.size;
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (t) => t in tables };
  knex.tables = () => tables;
  return knex;
}

const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const catalogId = (name) => `cat-${name}`;
// What the windows hold before the migration: the template rows (February Celsius, May Dispatch, July Talak, August Acelepryn) and a few
// neighbors, each window with its own highest sort_order.
const BEFORE = {
  [W.FEB]: [[N.F24, 'nutrition', 'broadcast', true, {}], [N.CEL, 'post_emergent_spot', 'spot', false, { stressGate: true, annualCounter: 'celsius_oz_per_1000', annualMaxApps: 2 }, { counter: 'celsius_oz_per_1000', maxApplications: 2 }]],
  [W.MAR]: [[N.DIM, 'pre_emergent', 'broadcast', true, {}], [N.ART, 'fungicide_spot', 'spot', false, { trigger: 'mapped_take_all_spring_1' }]],
  [W.APR]: [[N.F24, 'nutrition', 'broadcast', true, {}]],
  [W.MAY]: [[N.TET, 'insecticide', 'broadcast', true, {}], [N.DSP, 'wetting_agent_spot', 'spot', false, { trigger: 'dry_spots', noWaterIn: true }]],
  [W.JUN]: [[N.NT, 'micronutrients', 'broadcast', true, {}], [N.ARE, 'insecticide_spot', 'spot', false, { trigger: 'chinch_20_to_25_per_sqft' }]],
  [W.JUL]: [[N.ACE, 'insecticide_spot', 'spot', false, { trigger: 'caterpillars' }], [N.TAL, 'insecticide_spot', 'spot', false, { trigger: 'chinch_second_product_or_caterpillars', delayWateringHours: 24 }]],
  [W.AUG]: [[N.NT, 'micronutrients', 'broadcast', true, {}], [N.ACE, 'insecticide_spot', 'spot', false, { trigger: 'caterpillars' }]],
  [W.SEP]: [[N.NT, 'micronutrients', 'broadcast', true, {}], [N.ACE, 'insecticide_spot', 'spot', false, { trigger: 'caterpillars' }]],
  [W.OCT]: [[N.STW15, 'fall_pre_emergent_nutrition', 'broadcast', true, {}], [N.CEL, 'post_emergent_spot', 'spot', false, { stressGate: true }]],
  [W.NOV]: [[N.F24, 'nutrition', 'broadcast', true, {}], [N.VEL, 'fungicide_spot', 'spot', false, { trigger: 'mapped_large_patch' }]],
};

function seeded(keys = [['fixture_a', 'st_augustine'], ['fixture_b', 'bermuda'], ['fixture_c', 'bahia']]) {
  const knex = fakeKnex();
  const t = knex.tables();
  keys.forEach(([key, track], index) => {
    t.lawn_protocols.push({ id: `p-${key}`, protocol_key: key, version: V13, grass_track: track });
    let sort = (index + 1) * 100;
    for (const [windowKey, rows] of Object.entries(BEFORE)) {
      const windowId = `w-${key}-${windowKey}`;
      t.lawn_protocol_windows.push({ id: windowId, lawn_protocol_id: `p-${key}`, window_key: windowKey });
      for (const [product, role, mode, defaultInPlan, gates, counter] of rows) {
        sort += 1;
        t.lawn_protocol_products.push({
          id: `r-${key}-${windowKey}-${sort}`, lawn_protocol_window_id: windowId, product_id: catalogId(product), product_name: product, role,
          application_mode: mode, rate_per_1000: null, rate_unit: 'fl oz', carrier_gal_per_1000: 1, default_in_plan: defaultInPlan,
          gates: JSON.stringify(gates), annual_counter: JSON.stringify(counter || {}), mixing: '{}', report_copy: JSON.stringify({ role }), sort_order: sort,
        });
      }
    }
  });
  return knex;
}
const snapshot = (knex) => JSON.parse(JSON.stringify(knex.tables()));
const inWindow = (knex, key, windowKey) => knex.tables().lawn_protocol_products
  .filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`).sort((a, b) => a.sort_order - b.sort_order);
const names = (knex, key, windowKey) => inWindow(knex, key, windowKey).map((r) => r.product_name);

describe('spot lines migration (in-memory knex)', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('up: every window gets its rows appended after its last row, in placement order', async () => {
    const knex = seeded();
    const before = snapshot(knex);
    await migration.up(knex);
    for (const key of ['fixture_a', 'fixture_b']) {
      for (const [windowKey, specs] of migration.PLACEMENTS) {
        const oldNames = before.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`).map((r) => r.product_name);
        const oldMax = Math.max(...before.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`).map((r) => r.sort_order));
        const rows = inWindow(knex, key, windowKey);
        expect(rows.map((r) => r.product_name)).toEqual([...oldNames, ...specs.map((s) => s.name)]);
        rows.slice(oldNames.length).forEach((row, i) => expect(row.sort_order).toBe(oldMax + 1 + i));
      }
    }
  });

  test('up: the new rows match the spec exactly, link to the template row\'s catalog id and never default into the plan', async () => {
    const knex = seeded();
    await migration.up(knex);
    const fresh = knex.tables().lawn_protocol_products.filter((r) => json(r.report_copy) && !r.id.startsWith('r-'));
    expect(fresh.length).toBeGreaterThan(0);
    for (const row of fresh) {
      const spec = Object.values(migration.ROWS).find((s) => s.name === row.product_name);
      expect(row).toMatchObject({
        product_id: catalogId(row.product_name), role: spec.row.role, application_mode: 'spot', rate_per_1000: spec.row.rate_per_1000, rate_unit: spec.row.rate_unit,
        carrier_gal_per_1000: spec.row.carrier_gal_per_1000, default_in_plan: false,
      });
      expect(json(row.gates)).toEqual(spec.gates);
      expect(json(row.annual_counter)).toEqual(spec.annual_counter);
      expect(json(row.mixing)).toEqual({});
      expect(json(row.report_copy)).toEqual({ role: spec.row.role });
    }
  });

  test('up: no existing row changes (id, window, gates, place and everything else), and the Certainty, surfactant and Blindside rows are never written', async () => {
    const knex = seeded();
    const before = snapshot(knex).lawn_protocol_products;
    await migration.up(knex);
    const after = knex.tables().lawn_protocol_products;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter((r) => /Blindside|Certainty|Surfactant/i.test(r.product_name))).toEqual([]);
  });

  test('up: the expected counts per track (Celsius four, Dispatch seven, Acelepryn two, Talak two) and bahia gets no Celsius', async () => {
    const knex = seeded();
    await migration.up(knex);
    const count = (key, name, original) => knex.tables().lawn_protocol_products
      .filter((r) => r.product_name === name && r.lawn_protocol_window_id.startsWith(`w-${key}-`) && (original ? true : !r.id.startsWith('r-'))).length;
    for (const key of ['fixture_a', 'fixture_b']) {
      expect([N.CEL, N.DSP, N.ACE, N.TAL].map((n) => count(key, n))).toEqual([4, 7, 2, 2]);
    }
    expect([N.CEL, N.DSP, N.ACE, N.TAL].map((n) => count('fixture_c', n))).toEqual([0, 7, 2, 2]);
  });

  test('audit: one row per protocol listing what was inserted, short enough for varchar(96)', async () => {
    const knex = seeded();
    await migration.up(knex);
    const logs = knex.tables().lawn_protocol_audit_log;
    expect(logs).toHaveLength(3);
    for (const log of logs) {
      expect(log.action).toBe(migration.ACTION);
      expect(log.action.length).toBeLessThanOrEqual(96);
      expect(json(log.after_snapshot).rows.length).toBeGreaterThan(0);
    }
    expect(json(logs.find((l) => l.lawn_protocol_id === 'p-fixture_a').after_snapshot).rows).toHaveLength(15);
    expect(json(logs.find((l) => l.lawn_protocol_id === 'p-fixture_c').after_snapshot).rows).toHaveLength(11);
  });

  test('up twice adds nothing the second time', async () => {
    const knex = seeded();
    await migration.up(knex);
    const once = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(once);
  });

  test('a window that already holds the product (retired or not) is skipped for that product only', async () => {
    const knex = seeded();
    const t = knex.tables();
    t.lawn_protocol_products.push({
      id: 'x1', lawn_protocol_window_id: `w-fixture_a-${W.NOV}`, product_id: catalogId(N.ACE), product_name: N.ACE, role: 'insecticide_spot', application_mode: 'spot',
      rate_per_1000: null, rate_unit: 'fl oz', carrier_gal_per_1000: 2, default_in_plan: false, gates: JSON.stringify({ retired: true, trigger: 'caterpillars' }),
      annual_counter: '{}', mixing: '{}', report_copy: '{}', sort_order: 900,
    });
    await migration.up(knex);
    expect(names(knex, 'fixture_a', W.NOV).filter((n) => n === N.ACE)).toHaveLength(1);
    expect(names(knex, 'fixture_a', W.NOV)).toContain(N.TAL);
    expect(names(knex, 'fixture_b', W.NOV)).toContain(N.ACE);
  });

  test('a protocol with no linked or only a retired template row skips that product; a protocol without a window skips the window', async () => {
    const knex = seeded();
    const t = knex.tables();
    // fixture_a: the May Dispatch template is retired; fixture_b: the July Talak template has no catalog link.
    Object.assign(t.lawn_protocol_products.find((r) => r.lawn_protocol_window_id === `w-fixture_a-${W.MAY}` && r.product_name === N.DSP), { gates: JSON.stringify({ retired: true, trigger: 'dry_spots' }) });
    Object.assign(t.lawn_protocol_products.find((r) => r.lawn_protocol_window_id === `w-fixture_b-${W.JUL}` && r.product_name === N.TAL), { product_id: null });
    t.lawn_protocol_windows = t.lawn_protocol_windows.filter((w) => w.id !== `w-fixture_b-${W.APR}`);
    await migration.up(knex);
    expect(t.lawn_protocol_products.filter((r) => r.product_name === N.DSP && r.lawn_protocol_window_id.startsWith('w-fixture_a-')).map((r) => r.lawn_protocol_window_id)).toEqual([`w-fixture_a-${W.MAY}`]);
    expect(names(knex, 'fixture_b', W.OCT)).not.toContain(N.TAL);
    expect(names(knex, 'fixture_b', W.OCT)).toContain(N.ACE);
    expect(t.lawn_protocol_products.filter((r) => r.product_name === N.DSP && r.lawn_protocol_window_id.startsWith('w-fixture_b-')).length).toBe(7);
  });

  test('a database with no v13 protocol, or without the tables, writes nothing', async () => {
    const none = fakeKnex();
    await migration.up(none);
    expect(none.tables().lawn_protocol_audit_log).toEqual([]);
    const missing = fakeKnex();
    delete missing.tables().lawn_protocol_audit_log;
    await expect(migration.up(missing)).resolves.toBeUndefined();
  });

  test('down: up then down is the starting state exactly', async () => {
    const knex = seeded();
    const start = snapshot(knex);
    await migration.up(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(start);
  });

  test('down: a visit or a completion that references ANY v13 protocol makes it a full no-op', async () => {
    for (const reference of [
      (t) => t.scheduled_services.push({ id: 's', lawn_protocol_key: 'fixture_b', lawn_protocol_version: V13 }),
      (t) => t.lawn_protocol_service_completions.push({ id: 'c', lawn_protocol_id: 'p-fixture_a', protocol_key: 'fixture_a', protocol_version: V13 }),
    ]) {
      const knex = seeded();
      await migration.up(knex);
      reference(knex.tables());
      const upped = snapshot(knex);
      await migration.down(knex);
      expect(snapshot(knex)).toEqual(upped);
    }
  });

  test.each([
    ['re-rated', () => ({ rate_per_1000: 9 })],
    ['re-gated', (row) => ({ gates: JSON.stringify({ ...json(row.gates), extra: true }) })],
    ['lost its count keys', () => ({ annual_counter: '{}' })],
    ['moved', () => ({ sort_order: 9999 })],
    ['renamed', () => ({ product_name: 'Renamed by staff' })],
    ['switched on by default', () => ({ default_in_plan: true })],
    ['moved to another window', () => ({ lawn_protocol_window_id: 'w-elsewhere' })],
  ])('one inserted row %s makes down a full no-op', async (_label, change) => {
    const knex = seeded();
    await migration.up(knex);
    // A Celsius row: the only inserted row with count keys to lose.
    const [row] = knex.tables().lawn_protocol_products.filter((r) => !r.id.startsWith('r-') && r.product_name === N.CEL);
    Object.assign(row, change(row));
    const edited = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(edited);
  });

  test('an inserted row staff deleted makes down a full no-op', async () => {
    const knex = seeded();
    await migration.up(knex);
    const [gone] = knex.tables().lawn_protocol_products.filter((r) => !r.id.startsWith('r-'));
    knex.tables().lawn_protocol_products = knex.tables().lawn_protocol_products.filter((r) => r !== gone);
    const edited = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(edited);
  });

  test('re-running up after a no-op rollback adds nothing', async () => {
    const knex = seeded();
    await migration.up(knex);
    knex.tables().scheduled_services.push({ id: 's', lawn_protocol_key: 'fixture_a', lawn_protocol_version: V13 });
    await migration.down(knex);
    const once = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(once);
  });
});
