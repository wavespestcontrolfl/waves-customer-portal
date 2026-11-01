// Lawn protocol v13 fungus prevention lines: gray leaf spot prevention in May (Artavia) and the large patch spring pass in February
// (Velista), migration 20261101200000, owner 2026-11-01. Synthetic data only. No database: a small in-memory fake knex (the shape of
// lawn-v13-spot-lines.test.js).
//
// Pinned: the recipe lines and notes on all three tracks; the staged rows copy the June Artavia row and the November Velista row;
// the treatment guide offers Velista as February's fungus card and leaves May's first fungicide row alone; the new triggers are not
// take-all triggers (treatment guide, approval engine); the rounds spot month serves the February row to St. Augustine round 2 in
// March; the migration appends (no row moves), writes one audit row per protocol and rolls back all or nothing.
const engine = require('../services/waveguard-plan-engine');
const v13Recipe = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261101200000_lawn_v13_fungus_prevention');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const { pickAddOns, takeAllAddOns } = require('../services/lawn-treatment-guide');
const { rowNamesTakeAll } = require('../services/waveguard-approval-engine');
const { roundSpotMonth } = require('../services/lawn-rounds');
const { V13_TROUBLE_PRODUCT_SWAPS } = require('../config/lawn-v13-trouble-product-swaps');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const V13 = staged.V13_VERSION;
const N = staged.NAMES;
const W = migration.WINDOWS;
const TRACKS = Object.keys(v13Recipe);
const visit = (grass, month) => v13Recipe[grass].visits.find((v) => v.month === month);
const lines = (grass, month) => visit(grass, month).secondary.split('\n');
const lineOf = (grass, month, name) => lines(grass, month).find((l) => l.startsWith(`${name} — `));

const GRAY_LEAF_SPOT_LINE = 'Artavia 2 SC (Azoxy) — gray leaf spot prevention, one pass in May on areas mapped for gray leaf spot last summer';
const LARGE_PATCH_SPRING_LINE = 'Velista — mapped large patch, spring prevention pass at 2 gal per 1,000 sq ft, one pass in February on areas mapped for large patch this winter';
const ALL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

describe('fungus prevention: the recipe', () => {
  test('the audit action fits varchar(96), with room for a migration:<name>:<column> action', () => {
    expect(migration.ACTION.length).toBeLessThanOrEqual(96);
    expect(`migration:${migration.MIGRATION}:${'x'.repeat(40)}`.length).toBeLessThanOrEqual(96);
  });

  test.each(TRACKS)('%s: May ends with the Artavia gray leaf spot prevention line; no other month carries it', (grass) => {
    const may = lines(grass, 'May');
    expect(may[may.length - 1]).toBe(GRAY_LEAF_SPOT_LINE);
    expect(may.filter((l) => l.startsWith('Artavia 2 SC'))).toEqual([GRAY_LEAF_SPOT_LINE]);
    for (const month of ALL_MONTHS.filter((m) => m !== 'May')) expect(visit(grass, month).secondary).not.toContain('gray leaf spot prevention');
    // June and August keep their curative Artavia line.
    expect(lineOf(grass, 'Jun', 'Artavia 2 SC (Azoxy)')).toMatch(/^Artavia 2 SC \(Azoxy\) — gray leaf spot, hose spot treatment; Pythium root rot/);
  });

  test.each(TRACKS)('%s: February is Celsius, then the Velista large patch spring pass; no other month carries it', (grass) => {
    const feb = lines(grass, 'Feb');
    expect(feb).toHaveLength(2);
    expect(feb[0]).toMatch(/^Celsius WG — light weed spots only during green-up/);
    expect(feb[1]).toBe(LARGE_PATCH_SPRING_LINE);
    for (const month of ALL_MONTHS.filter((m) => m !== 'Feb')) expect(visit(grass, month).secondary).not.toContain('spring prevention pass');
    // Velista (Group 7) for February, not Artavia (Group 11): January's large patch line is Artavia.
    expect(lineOf(grass, 'Jan', 'Artavia 2 SC (Azoxy)')).toBeDefined();
    expect(feb.some((l) => l.startsWith('Artavia'))).toBe(false);
  });

  test.each(TRACKS)('%s: both new lines parse as conditional spot lines (never a default product)', (grass) => {
    for (const line of [lineOf(grass, 'Feb', 'Velista'), lineOf(grass, 'May', 'Artavia 2 SC (Azoxy)')]) {
      const [parsed] = engine.parseProtocolLines(line, 'conditional', { exactName: true });
      expect(parsed).toMatchObject({ conditional: true, scope: 'CONDITIONAL_RESCUE' });
    }
  });

  test.each(TRACKS)('%s: the notes say where each line applies', (grass) => {
    const notes = v13Recipe[grass].notes;
    const largePatch = notes.find((n) => n.startsWith('Large patch: Artavia, then Velista.'));
    expect(largePatch).toContain("The February spring prevention pass is Velista, after January's Artavia, at 2 gal per 1,000 sq ft on areas mapped for large patch this winter; the disease runs to May.");
    expect(notes).toContain('Gray leaf spot: Artavia, then Gravex. A lawn mapped for gray leaf spot last summer gets one Artavia prevention pass in May.');
  });

  test('the three tracks carry the same lines', () => {
    for (const month of ALL_MONTHS) {
      expect(visit('bermuda', month).secondary).toBe(visit('st_augustine', month).secondary);
      expect(visit('zoysia', month).secondary).toBe(visit('st_augustine', month).secondary);
    }
  });
});

describe('fungus prevention: the rows copy the existing rows of the same product', () => {
  const stagedRow = (windowKey, name) => {
    const hit = staged.PRODUCTS.filter(([key, spec]) => key === windowKey && spec[0] === name).map(([, spec]) => spec);
    expect(hit).toHaveLength(1);
    const [product_name, role, application_mode, rate, rate_unit, carrier, default_in_plan] = hit[0];
    return { product_name, role, application_mode, rate, rate_unit, carrier, default_in_plan };
  };

  test.each([
    ['ARTAVIA', W.JUN, 'mapped_gray_leaf_spot_prevention'],
    ['VELISTA', W.NOV, 'mapped_large_patch_spring'],
  ])('%s: the %s row (role, mode, rate, unit, carrier), with its own trigger, never on by default', (key, templateWindow, trigger) => {
    const template = stagedRow(templateWindow, migration.ROWS[key].name);
    const { row, gates, annual_counter } = migration.ROWS[key];
    expect(migration.ROWS[key].template).toBe(templateWindow);
    expect(row).toMatchObject({ role: template.role, application_mode: template.application_mode, rate_per_1000: template.rate, rate_unit: template.rate_unit, carrier_gal_per_1000: template.carrier, default_in_plan: false });
    expect(gates).toEqual({ trigger });
    expect(annual_counter).toEqual({});
  });

  test('placement: February gets Velista and May gets Artavia, nothing else', () => {
    const byWindow = Object.fromEntries(migration.PLACEMENTS.map(([key, specs]) => [key, specs.map((s) => s.name)]));
    expect(byWindow).toEqual({ [W.FEB]: [N.VEL], [W.MAY]: [N.ART] });
  });

  test('the two triggers are new, and the Artavia (Group 11) and Velista (Group 7) rows are different products', () => {
    expect(migration.GRAY_LEAF_SPOT_TRIGGER).not.toBe(migration.LARGE_PATCH_SPRING_TRIGGER);
    expect(N.ART).not.toBe(N.VEL);
  });
});

describe('fungus prevention: the readers', () => {
  const P = { ART: 'p-art', VEL: 'p-vel', GRV: 'p-grv', CEL: 'p-cel' };
  const row = (role, trigger) => ({ role, gates: { trigger } });
  const offer = (rows, options) => {
    const candidates = [...rows.keys()].map((id) => ({ raw: { product: { id, name: id } }, item: { productId: id, name: id, line: '' } }));
    return pickAddOns(candidates, rows, options);
  };

  test('February: the new Velista row is the fungus card offer (the month had no fungicide row), also on a lawn with take-all mapped', () => {
    const rows = new Map([[P.CEL, { role: 'post_emergent_spot', gates: {} }], [P.VEL, row('fungicide_spot', migration.LARGE_PATCH_SPRING_TRIGGER)]]);
    expect(offer(rows).fungus.raw.product.id).toBe(P.VEL);
    // Velista is not azoxystrobin: the Group 11 hold for a take-all lawn does not pass it over.
    expect(offer(rows, { takeAllMapped: true }).fungus.raw.product.id).toBe(P.VEL);
  });

  test('May: the new Artavia row is appended last, so the month\'s first fungicide row stays the first fungicide row', () => {
    const rows = new Map([
      [P.VEL, row('fungicide_spot', 'fairy_ring_dollar_spot_rust_leaf_spot')],
      [P.GRV, row('fungicide_spot', 'dollar_spot_rust')],
      [P.ART, row('fungicide_spot', migration.GRAY_LEAF_SPOT_TRIGGER)],
    ]);
    expect(offer(rows).fungus.raw.product.id).toBe(P.VEL);
    expect(offer(rows, { takeAllMapped: true }).fungus.raw.product.id).toBe(P.VEL);
  });

  test('neither trigger, nor either recipe line, is read as take-all by the treatment guide', () => {
    const rows = new Map([[P.ART, row('fungicide_spot', migration.GRAY_LEAF_SPOT_TRIGGER)], [P.VEL, row('fungicide_spot', migration.LARGE_PATCH_SPRING_TRIGGER)]]);
    const candidates = [
      { raw: { product: { id: P.ART, name: N.ART } }, item: { productId: P.ART, line: GRAY_LEAF_SPOT_LINE } },
      { raw: { product: { id: P.VEL, name: N.VEL } }, item: { productId: P.VEL, line: LARGE_PATCH_SPRING_LINE } },
    ];
    expect(takeAllAddOns(candidates, rows)).toEqual([]);
    // The trigger test the guide uses for take-all.
    for (const trigger of [migration.GRAY_LEAF_SPOT_TRIGGER, migration.LARGE_PATCH_SPRING_TRIGGER]) expect(trigger).not.toMatch(/^mapped_take_all/);
    for (const line of [GRAY_LEAF_SPOT_LINE, LARGE_PATCH_SPRING_LINE]) expect(line).not.toMatch(/mapped take-all/i);
  });

  test('approval engine: neither trigger can prove a take-all application (no take-all words)', () => {
    for (const trigger of [migration.GRAY_LEAF_SPOT_TRIGGER, migration.LARGE_PATCH_SPRING_TRIGGER]) {
      expect(rowNamesTakeAll({ gates: { trigger }, role: 'fungicide_spot' })).toBe(false);
      expect(rowNamesTakeAll({ gates: JSON.stringify({ trigger }), role: 'fungicide_spot' })).toBe(false);
    }
    // Control: a real take-all trigger still counts.
    expect(rowNamesTakeAll({ gates: { trigger: 'mapped_take_all_spring_2' }, role: 'fungicide_spot' })).toBe(true);
  });

  test('the December large patch potassium swap still keys on its own trigger, which neither new row uses', () => {
    expect(V13_TROUBLE_PRODUCT_SWAPS.map((rule) => rule.trigger)).toEqual(['active_large_patch_mapped']);
    for (const spec of Object.values(migration.ROWS)) expect(spec.gates.trigger).not.toBe('active_large_patch_mapped');
  });

  test('rounds: a St. Augustine round-2 visit dated in March reads the February window, so it also gets the February Velista row', () => {
    expect(roundSpotMonth({ round: 2, realMonth: 3, grassTrack: 'st_augustine' })).toBe(2);
    expect(roundSpotMonth({ round: 2, realMonth: 2, grassTrack: 'st_augustine' })).toBe(2);
    expect(roundSpotMonth({ round: 2, realMonth: 3, grassTrack: 'bermuda' })).toBe(3);
    expect(roundSpotMonth({ round: 5, realMonth: 5, grassTrack: 'st_augustine' })).toBe(5);
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
// What the windows hold before the migration: the template rows (June Artavia, November Velista) and a few neighbors, each window with
// its own highest sort_order.
const BEFORE = {
  [W.FEB]: [[N.F24, 'nutrition', 'broadcast', true, {}], [N.CEL, 'post_emergent_spot', 'spot', false, { stressGate: true, annualCounter: 'celsius_oz_per_1000', annualMaxApps: 2 }, { counter: 'celsius_oz_per_1000', maxApplications: 2 }]],
  [W.MAY]: [[N.TET, 'insecticide', 'broadcast', true, {}], [N.DSP, 'wetting_agent_spot', 'spot', false, { trigger: 'dry_spots', noWaterIn: true }], [N.VEL, 'fungicide_spot', 'spot', false, { trigger: 'fairy_ring_dollar_spot_rust_leaf_spot' }]],
  [W.JUN]: [[N.NT, 'micronutrients', 'broadcast', true, {}], [N.ARE, 'insecticide_spot', 'spot', false, { trigger: 'chinch_20_to_25_per_sqft' }], [N.ART, 'fungicide_spot', 'spot', false, { trigger: 'gray_leaf_spot_pythium_root_rot' }]],
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
          application_mode: mode, rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2, default_in_plan: defaultInPlan,
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
const fresh = (knex) => knex.tables().lawn_protocol_products.filter((r) => !r.id.startsWith('r-'));

describe('fungus prevention migration (in-memory knex)', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('up: February gets Velista and May gets Artavia, each appended after the window\'s last row, on every protocol', async () => {
    const knex = seeded();
    const before = snapshot(knex);
    await migration.up(knex);
    for (const key of ['fixture_a', 'fixture_b', 'fixture_c']) {
      for (const [windowKey, specs] of migration.PLACEMENTS) {
        const old = before.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === `w-${key}-${windowKey}`);
        const rows = inWindow(knex, key, windowKey);
        expect(rows.map((r) => r.product_name)).toEqual([...old.map((r) => r.product_name), ...specs.map((s) => s.name)]);
        expect(rows[rows.length - 1].sort_order).toBe(Math.max(...old.map((r) => r.sort_order)) + 1);
      }
    }
    expect(names(knex, 'fixture_a', W.FEB)).toEqual([N.F24, N.CEL, N.VEL]);
    expect(names(knex, 'fixture_a', W.MAY)).toEqual([N.TET, N.DSP, N.VEL, N.ART]);
    expect(fresh(knex)).toHaveLength(6);
  });

  test('up: the new rows match the spec exactly, link to the template row\'s catalog id and never default into the plan', async () => {
    const knex = seeded();
    await migration.up(knex);
    for (const row of fresh(knex)) {
      const spec = Object.values(migration.ROWS).find((s) => s.name === row.product_name);
      expect(row).toMatchObject({
        product_id: catalogId(row.product_name), role: 'fungicide_spot', application_mode: 'spot', rate_per_1000: null, rate_unit: 'label_rate',
        carrier_gal_per_1000: 2, default_in_plan: false,
      });
      expect(json(row.gates)).toEqual(spec.gates);
      expect(json(row.annual_counter)).toEqual({});
      expect(json(row.mixing)).toEqual({});
      expect(json(row.report_copy)).toEqual({ role: 'fungicide_spot' });
    }
    expect(fresh(knex).map((r) => json(r.gates).trigger).sort()).toEqual([
      ...Array(3).fill('mapped_gray_leaf_spot_prevention'), ...Array(3).fill('mapped_large_patch_spring'),
    ].sort());
  });

  test('up: no existing row changes, and the June and November template rows keep their triggers', async () => {
    const knex = seeded();
    const before = snapshot(knex);
    await migration.up(knex);
    const now = new Map(knex.tables().lawn_protocol_products.map((r) => [r.id, r]));
    for (const row of before.lawn_protocol_products) expect(now.get(row.id)).toEqual(row);
    expect(json(inWindow(knex, 'fixture_a', W.JUN)[2].gates).trigger).toBe('gray_leaf_spot_pythium_root_rot');
    expect(json(inWindow(knex, 'fixture_a', W.NOV)[1].gates).trigger).toBe('mapped_large_patch');
  });

  test('up: one audit row per protocol, listing its two inserted rows', async () => {
    const knex = seeded();
    await migration.up(knex);
    const logs = knex.tables().lawn_protocol_audit_log;
    expect(logs).toHaveLength(3);
    for (const log of logs) {
      expect(log).toMatchObject({ action: migration.ACTION, actor_name: 'migration 20261101200000', entity_type: 'protocol' });
      expect(json(log.after_snapshot).rows).toHaveLength(2);
      expect(json(log.metadata)).toMatchObject({ migration: migration.MIGRATION, gate: 'GATE_LAWN_V13' });
    }
  });

  test('up twice adds nothing the second time', async () => {
    const knex = seeded();
    await migration.up(knex);
    const once = snapshot(knex);
    await migration.up(knex);
    expect(snapshot(knex)).toEqual(once);
  });

  test('a window that already holds the product (retired or not) is skipped for it', async () => {
    const knex = seeded();
    const t = knex.tables();
    t.lawn_protocol_products.push({
      id: 'x-1', lawn_protocol_window_id: `w-fixture_a-${W.FEB}`, product_id: catalogId(N.VEL), product_name: N.VEL, role: 'fungicide_spot', application_mode: 'spot',
      rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2, default_in_plan: false, gates: JSON.stringify({ retired: true, trigger: 'mapped_large_patch_spring' }),
      annual_counter: '{}', mixing: '{}', report_copy: '{}', sort_order: 900,
    });
    await migration.up(knex);
    expect(names(knex, 'fixture_a', W.FEB).filter((n) => n === N.VEL)).toHaveLength(1);
    expect(names(knex, 'fixture_a', W.MAY)).toContain(N.ART);
    expect(names(knex, 'fixture_b', W.FEB)).toContain(N.VEL);
  });

  test('a protocol with no linked or only a retired template row skips that product; a protocol without a window skips the window', async () => {
    const knex = seeded();
    const t = knex.tables();
    Object.assign(t.lawn_protocol_products.find((r) => r.lawn_protocol_window_id === `w-fixture_a-${W.JUN}` && r.product_name === N.ART), { gates: JSON.stringify({ retired: true, trigger: 'gray_leaf_spot' }) });
    Object.assign(t.lawn_protocol_products.find((r) => r.lawn_protocol_window_id === `w-fixture_b-${W.NOV}` && r.product_name === N.VEL), { product_id: null });
    t.lawn_protocol_windows = t.lawn_protocol_windows.filter((w) => w.id !== `w-fixture_c-${W.FEB}`);
    await migration.up(knex);
    expect(names(knex, 'fixture_a', W.MAY)).not.toContain(N.ART);
    expect(names(knex, 'fixture_a', W.FEB)).toContain(N.VEL);
    expect(names(knex, 'fixture_b', W.FEB)).not.toContain(N.VEL);
    expect(names(knex, 'fixture_b', W.MAY)).toContain(N.ART);
    expect(names(knex, 'fixture_c', W.MAY)).toContain(N.ART);
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
    ['moved', () => ({ sort_order: 9999 })],
    ['renamed', () => ({ product_name: 'Renamed by staff' })],
    ['switched on by default', () => ({ default_in_plan: true })],
    ['moved to another window', () => ({ lawn_protocol_window_id: 'w-elsewhere' })],
  ])('one inserted row %s makes down a full no-op', async (_label, change) => {
    const knex = seeded();
    await migration.up(knex);
    const [row] = fresh(knex).filter((r) => r.product_name === N.ART);
    Object.assign(row, change(row));
    const edited = snapshot(knex);
    await migration.down(knex);
    expect(snapshot(knex)).toEqual(edited);
  });

  test('an inserted row staff deleted makes down a full no-op', async () => {
    const knex = seeded();
    await migration.up(knex);
    const [gone] = fresh(knex);
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
