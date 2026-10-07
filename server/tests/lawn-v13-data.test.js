// Lawn protocol v13 data (PR 1 of 3, runtime-inert): the recipe file and the
// migrations that stage it. Nothing here is read at runtime; the gate and the
// readers arrive in PR 2.
// Synthetic catalog, synthetic knex: no database. The Postgres run of the same
// migrations is a manual check recorded in the PR body.
//
// Pins: the v13 recipe is one universal 12-month program in the existing visit
// shape whose every line names a catalog row the migrations know; the staged
// migration inserts what the recipe says (whole-lawn tool = default_in_plan,
// spots are not), is idempotent and reverses only its own unreferenced rows;
// the follow-up migrations link, price-classify and gate what they promise and
// roll back in the right order.

const v13 = require('../config/lawn-protocol-v13.json');
const engine = require('../services/waveguard-plan-engine');
const fixMigration = require('../models/migrations/20261005130000_lawn_v13_catalog_rows_and_product_links');
const round2 = require('../models/migrations/20261005140000_lawn_v13_round2_fixes');
const round3 = require('../models/migrations/20261005160000_lawn_v13_round3_gates_and_combo_class');
const migration = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const octoberMigration = require('../models/migrations/20261007120500_lawn_v13_october_dimension');

const LAWN_V13_VERSION = migration.V13_VERSION;
// Three tracks: the bahia track is deleted (owner 2026-10-06; Celsius and Blindside are not labeled for bahiagrass).
const GRASSES = ['st_augustine', 'bermuda', 'zoysia'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

const nameOfLine = (line) => line.split(' — ')[0];
const visitFor = (month) => v13.st_augustine.visits.find((v) => v.month === MONTH_ABBR[month - 1]);
const lines = (text) => String(text || '').split('\n').filter(Boolean);

describe('the v13 recipe', () => {
  test('three tracks (no bahia), one universal program, 12 months in the existing visit shape', () => {
    expect(Object.keys(v13)).toEqual(GRASSES);
    for (const grass of GRASSES) {
      expect(v13[grass].visits).toEqual(v13.st_augustine.visits);
      expect(v13[grass].visits.map((v) => v.month)).toEqual(MONTH_ABBR);
      expect(v13[grass].visits.map((v) => v.visit)).toEqual(MONTHS);
      expect(v13[grass].exact_catalog_names).toBe(true);
      expect(v13[grass].notes).toEqual(v13.st_augustine.notes);
      expect(v13[grass].safety_rules.length).toBeGreaterThan(0);
      for (const visit of v13[grass].visits) {
        // April alone carries the 9x plan step (cadenceVariants); every other visit is the plain shape.
        expect(Object.keys(visit).sort()).toEqual(['month', 'notes', 'primary', 'secondary', 'tiers', 'visit', ...(visit.month === 'Apr' ? ['cadenceVariants'] : [])].sort());
        expect(Object.values(visit.tiers)).toEqual([true, true, true, true]);
      }
    }
  });

  test('what the program drops stays out (no Pennant, no July potash, no March large patch spray, no SpeedZone)', () => {
    const text = JSON.stringify(v13);
    expect(text).not.toMatch(/pennant|k-?flow|potash|speedzone|medallion|t-storm|eagle|sedgehammer|cleary|harrell|atrazine|headway|image for southern/i);
    const jul = visitFor(7);
    expect(jul.primary).toMatch(/scout visit/i);
    expect(jul.primary).not.toMatch(/\bLESCO|Dimension|Stonewall/);
    expect(visitFor(3).secondary).not.toMatch(/velista|gravex/i);
    expect(visitFor(3).secondary).toMatch(/artavia/i);
  });

  test('line grammar the plan engine depends on: no "if", no scope words, one product per line', () => {
    for (const visit of v13.st_augustine.visits) {
      for (const line of lines(visit.primary)) {
        expect(line).not.toMatch(/\bif\b|skip|audit|premium|history|drive by|soil sample/i);
        if (visit.month !== 'Jul') expect(line).toMatch(/ — /);
      }
      for (const line of [...lines(visit.primary), ...lines(visit.secondary)]) expect(line).not.toMatch(/\$\d/);
    }
  });

  test('July is inspect and spot: its primary line classifies as inspection (no area, no product)', () => {
    const [line] = engine.parseProtocolLines(visitFor(7).primary, 'base');
    expect(line.scope).toBe('INSPECTION_ONLY');
  });

  test('N targets parse from the visit notes and total the program', () => {
    const n = MONTHS.map((m) => engine.parseVisitNutrientTargets(visitFor(m).notes).targetNPer1000);
    // October is Dimension 18-0-10 at 4.04 lb per 1,000 sq ft (commercial label, Coastal South): 0.73 lb N, 0.40 lb K2O.
    expect(n).toEqual([0, 0.75, 0, 0.5, 0, 0, 0, 0, 0, 0.73, 0.75, 0.5]);
    expect(Number(n.reduce((a, b) => a + b, 0).toFixed(2))).toBe(3.23);
    expect(engine.parseVisitNutrientTargets(visitFor(10).notes).targetKPer1000).toBe(0.4);
    // No N or P in Jun-Sep.
    for (const m of [6, 7, 8, 9]) expect(n[m - 1]).toBe(0);
  });

  test('whole-lawn tools per month match the approved program', () => {
    const tools = MONTHS.map((m) => lines(visitFor(m).primary).filter((l) => / — /.test(l)).map(nameOfLine));
    const N = migration.NAMES;
    expect(tools).toEqual([
      [N.STW, N.NT], [N.F24], [N.DIM, N.NT], [N.F24], [N.TET], [N.NT, N.DIM], [], [N.NT], [N.NT], [octoberMigration.NEW_NAME], [N.F24], [N.F24],
    ]);
  });
});

// ── The 9x April step ────────────────────────────────────────────────────────
describe('the 9x plan April step (recipe file and staged rows agree)', () => {
  const april = require('../models/migrations/20261006150000_lawn_v13_april_9x_branch');
  const { visitForCadence } = require('../services/lawn-program');

  test('April carries one 9x variant naming the Dimension 0.21% catalog row the fix migration inserts; no other visit has one', () => {
    for (const grass of GRASSES) {
      const variants = v13[grass].visits.filter((v) => v.cadenceVariants);
      expect(variants.map((v) => v.month)).toEqual(['Apr']);
      expect(Object.keys(variants[0].cadenceVariants)).toEqual(['9']);
      const [line, ...rest] = lines(variants[0].cadenceVariants['9'].primary);
      expect(rest).toEqual([]);
      expect(nameOfLine(line)).toBe(april.DIMENSION);
      expect(line).toMatch(/2\.78 lb per 1,000 sq ft \(0\.5 lb N\), spreader$/);
    }
    expect(fixMigration.PRODUCTS.map((p) => p.name)).toContain(april.DIMENSION);
  });

  test('the variant is the same whole-lawn spreader step as the 12x one: one tool, same N target, no scope word the engine reads', () => {
    const [april12] = engine.parseProtocolLines(visitFor(4).primary, 'base', { exactName: true });
    const [april9] = engine.parseProtocolLines(visitFor(4).cadenceVariants['9'].primary, 'base', { exactName: true });
    expect(april9).toMatchObject({ scope: april12.scope, conditional: false, exactName: true });
    expect(engine.parseVisitNutrientTargets(visitFor(4).notes).targetNPer1000).toBe(0.5);
  });

  test('visitForCadence: 9 takes the variant, 12 / 6 keep the visit, unknown keeps it and names the variant', () => {
    const visit = visitFor(4);
    expect(visitForCadence(visit, 9)).toMatchObject({ branch: '9', unknownCadence: null });
    expect(visitForCadence(visit, 9).visit.primary).toBe(visit.cadenceVariants['9'].primary);
    for (const visits of [12, 6]) expect(visitForCadence(visit, visits)).toEqual({ visit, branch: null, unknownCadence: null });
    expect(visitForCadence(visit, null)).toEqual({ visit, branch: null, unknownCadence: { variantProducts: [april.DIMENSION], cadences: ['9'] } });
    // A visit with no variants is returned as it is, whatever the cadence.
    expect(visitForCadence(visitFor(5), 9)).toEqual({ visit: visitFor(5), branch: null, unknownCadence: null });
  });
});

// ── October: Dimension 18-0-10 replaces the discontinued Stonewall 15-0-15 (20261007120500) ──
describe('migration 20261007120500: the October recipe line and the staged row it writes agree', () => {
  const NEW = octoberMigration.NEW_NAME;
  test('same name, same rate, same N and K2O targets, in every grass track', () => {
    for (const grass of GRASSES) {
      const october = v13[grass].visits.find((v) => v.month === 'Oct');
      const [line] = lines(october.primary);
      expect(nameOfLine(line)).toBe(NEW);
      expect(line).toContain(`${octoberMigration.OCT_RATE} lb per 1,000 sq ft`);
      const targets = engine.parseVisitNutrientTargets(october.notes);
      expect(`${targets.targetNPer1000} lb N/1000`).toBe(octoberMigration.NEW_GATES.targetN);
      expect(`${targets.targetKPer1000} lb K2O/1000`).toBe(octoberMigration.NEW_GATES.targetK2O);
      // Dithiopyr, not the prodiamine cap; the commercial label's figures.
      expect(october.notes).toMatch(/Dithiopyr this year stays under the label yearly cap/);
      expect(october.notes).toMatch(/0\.37 lb ai per acre: 4\.04 lb of product per 1,000 sq ft, the commercial label's Coastal South rate .* under its per-application maximum of 5\.46 lb/);
      expect(october.notes).not.toMatch(/prodiamine|1\.5 lb ai per acre cap/i);
    }
    expect(octoberMigration.OCT_RATE).toBe(4.04);
    expect(octoberMigration.MAX_LABEL).toBe(5.46);
  });

  test('the 9x April step is untouched: still the derived 2.78 lb from the 0.5 lb N target', () => {
    const [line] = lines(visitFor(4).cadenceVariants['9'].primary);
    expect(line).toMatch(/2\.78 lb per 1,000 sq ft \(0\.5 lb N\), spreader$/);
    expect(engine.parseVisitNutrientTargets(visitFor(4).notes).targetNPer1000).toBe(0.5);
  });

  test('the product limits it adds are the label\'s: 3 applications a year, 60 days between, both hard blocks', () => {
    expect(octoberMigration.PRODUCT_LIMITS.map((l) => [l.limit_type, l.limit_value, l.limit_unit, l.severity])).toEqual([
      ['annual_max_apps', 3, 'applications', 'hard_block'],
      ['min_interval_days', 60, 'days', 'hard_block'],
    ]);
  });
});

// ── The recipe names only catalog rows the migrations know ───────────────────
// Blindside is added by migration 20261005140000 (the staged rows of 120000 have none).
const BLINDSIDE = 'Blindside Herbicide';
const CATALOG_NAMES = [...Object.values(migration.NAMES), BLINDSIDE, octoberMigration.NEW_NAME];

describe('every v13 line names a catalog row the migrations know', () => {
  test('the recipe names only catalog names the migration knows', () => {
    for (const month of MONTHS) {
      for (const text of [visitFor(month).primary, visitFor(month).secondary]) {
        for (const raw of lines(text)) if (raw.includes(' — ')) expect(CATALOG_NAMES).toContain(nameOfLine(raw));
      }
    }
  });
});

// ── The staged migration ─────────────────────────────────────────────────────
function makeKnex(db) {
  let counter = 0;
  const knex = (table) => {
    // 'lawn_protocol_products as p' joined to its window and protocol (the fix migration's read).
    const joined = table === 'lawn_protocol_products as p';
    const rowsOf = () => {
      if (!joined) return (db[table] = db[table] || []);
      return (db.lawn_protocol_products || []).map((p) => {
        const w = db.lawn_protocol_windows.find((x) => x.id === p.lawn_protocol_window_id);
        const l = db.lawn_protocols.find((x) => x.id === w.lawn_protocol_id);
        return { ...p, 'l.version': l.version, protocol_id: l.id, window_key: w.window_key };
      });
    };
    const conds = [];
    let insertRows = null; let isDel = false; let updatePatch = null;
    const test = (row, obj) => Object.entries(obj).every(([k, v]) => (row[k] ?? null) === v);
    const hit = (row) => conds.reduce((acc, c, i) => (i === 0 ? test(row, c.obj) : (c.or ? acc || test(row, c.obj) : acc && test(row, c.obj))), true);
    const run = () => {
      if (insertRows) {
        const made = insertRows.map((r) => ({ id: `${table}-${++counter}`, ...r }));
        rowsOf().push(...made);
        return made;
      }
      if (updatePatch) { const hits = rowsOf().filter(hit); hits.forEach((r) => Object.assign(r, updatePatch)); return hits.length; }
      if (isDel) { const keep = rowsOf().filter((r) => !hit(r)); const n = rowsOf().length - keep.length; db[table] = keep; return n; }
      return rowsOf().filter(hit);
    };
    const b = {
      where(obj, val) { conds.push({ obj: typeof obj === 'string' ? { [obj]: val } : obj }); return b; },
      orWhere(obj) { conds.push({ obj, or: true }); return b; },
      join() { return b; },
      update(patch) { updatePatch = patch; return b; },
      first() { return Promise.resolve(run()[0]); },
      select() { return b; },
      del() { isDel = true; return Promise.resolve(run()); },
      insert(r) { insertRows = Array.isArray(r) ? r : [r]; return b; },
      returning() { return Promise.resolve(run()); },
      then(res, rej) {
        const result = insertRows ? run().map(() => 1) : run();
        return Promise.resolve(result).then(res, rej);
      },
    };
    return b;
  };
  knex.schema = { hasTable: async (t) => t in db, hasColumn: async () => true };
  knex.fn = { now: () => 'now' };
  return knex;
}

function seedDb({ without = [] } = {}) {
  const N = migration.NAMES;
  const catalog = Object.values(N).filter((name) => !without.includes(name))
    .map((name, i) => ({ id: `cat-${i}`, name: name === N.VEL ? 'Velista Fungicide' : name, active: true }));
  const db = {
    lawn_protocols: migration.TRACKS.map((t, i) => ({ id: `base-${i}`, protocol_key: t.key, version: '2026.06', status: 'active', grass_track: t.track })),
    lawn_protocol_windows: [], lawn_protocol_products: [],
    lawn_protocol_gates: migration.TRACKS.flatMap((t, i) => [
      { id: `g-${i}-a`, lawn_protocol_id: `base-${i}`, gate_key: 'sarasota_blackout', gate_type: 'ordinance', severity: 'block', title: 'x', rule_text: 'y', logic: { start: '06-01' }, wiki_refs: [] },
      { id: `g-${i}-b`, lawn_protocol_id: `base-${i}`, gate_key: 'valid_calibration_required', gate_type: 'equipment', severity: 'block', title: 'x', rule_text: 'y', logic: {}, wiki_refs: [] },
    ]),
    lawn_protocol_audit_log: [],
    products_catalog: catalog,
    product_aliases: [{ product_id: 'cat-alias', alias_name: 'Velista' }],
    scheduled_services: [], lawn_protocol_service_completions: [],
  };
  return db;
}

describe('staged migration 20261005120000', () => {
  test('inserts v13 staged per key with 12 windows, products, copied gates and an audit row', async () => {
    const db = seedDb();
    await migration.up(makeKnex(db));
    const staged = db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION);
    expect(migration.V13_VERSION).toBe('2026.10-v13');
    expect(staged.map((p) => [p.protocol_key, p.grass_track, p.status])).toEqual(migration.TRACKS.map((t) => [t.key, t.track, 'staged']));
    // The old versions are untouched and still the only active rows.
    expect(db.lawn_protocols.filter((p) => p.status === 'active').map((p) => p.version)).toEqual(['2026.06', '2026.06', '2026.06', '2026.06']);
    expect(staged.every((p) => p.effective_from === '2000-01-01')).toBe(true);
    for (const p of staged) {
      const wins = db.lawn_protocol_windows.filter((w) => w.lawn_protocol_id === p.id);
      expect(wins.map((w) => w.month)).toEqual(MONTHS);
      expect(db.lawn_protocol_gates.filter((g) => g.lawn_protocol_id === p.id).map((g) => g.gate_key)).toEqual(['sarasota_blackout', 'valid_calibration_required']);
      const audit = db.lawn_protocol_audit_log.filter((a) => a.lawn_protocol_id === p.id);
      expect(audit.map((a) => a.action)).toEqual(['seed_v13']);
    }
    // product_id resolved by catalog name, then alias (Velista only has an alias row here).
    const prods = db.lawn_protocol_products;
    expect(prods.filter((r) => r.product_name === migration.NAMES.ART).every((r) => /^cat-\d+$/.test(r.product_id))).toBe(true);
    expect(prods.filter((r) => r.product_name === migration.NAMES.VEL).every((r) => r.product_id === 'cat-alias' || /^cat-\d+$/.test(r.product_id))).toBe(true);
    expect(prods.every((r) => r.product_id)).toBe(true);
  });

  test('a name in neither the catalog nor the aliases keeps product_id null instead of failing', async () => {
    const db = seedDb();
    db.products_catalog = db.products_catalog.filter((r) => r.name !== migration.NAMES.GRA);
    await migration.up(makeKnex(db));
    const gra = db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.GRA);
    expect(gra.length).toBe(4);
    expect(gra.every((r) => r.product_id === null)).toBe(true);
  });

  test('idempotent, and a key with no active version is skipped', async () => {
    const db = seedDb();
    db.lawn_protocols = db.lawn_protocols.filter((p) => p.protocol_key !== 'swfl_bahia_10_10');
    const knex = makeKnex(db);
    await migration.up(knex);
    const count = db.lawn_protocols.length; const prods = db.lawn_protocol_products.length;
    await migration.up(knex);
    expect(db.lawn_protocols.length).toBe(count);
    expect(db.lawn_protocol_products.length).toBe(prods);
    expect(db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION).length).toBe(3);
  });

  test('default_in_plan is true only for the whole-lawn tool, and matches the recipe', () => {
    for (const month of MONTHS) {
      const [, windowKey] = migration.WINDOWS.find((w) => w[0] === month);
      const rowsForWindow = migration.PRODUCTS.filter(([key]) => key === windowKey).map(([, spec]) => spec);
      // The staged October row names Stonewall 15-0-15; 20261007120500 swaps it for Dimension 18-0-10.
      const whole = rowsForWindow.filter((s) => s[6]).map((s) => (s[0] === octoberMigration.OLD_NAME ? octoberMigration.NEW_NAME : s[0]));
      const spots = rowsForWindow.filter((s) => !s[6]).map((s) => s[0]);
      const visit = visitFor(month);
      expect(whole.sort()).toEqual(lines(visit.primary).filter((l) => / — /.test(l)).map(nameOfLine).sort());
      // The staged rows of 120000 carry no Blindside; 140000 adds them (tested below).
      expect(spots.sort()).toEqual([...new Set(lines(visit.secondary).map(nameOfLine))].filter((n) => n !== BLINDSIDE).sort());
      // Spot products are application_mode spot except the granular Dylox; broadcast only for the tool.
      for (const s of rowsForWindow) {
        if (s[6]) expect(s[2]).toBe('broadcast');
        if (!s[6] && s[0] !== migration.NAMES.DYL) expect(s[2]).toBe('spot');
      }
    }
  });

  test('down deletes only its own unreferenced rows; a referenced key stays', async () => {
    const db = seedDb();
    const knex = makeKnex(db);
    await migration.up(knex);
    db.scheduled_services.push({ id: 's1', lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: LAWN_V13_VERSION });
    const zoysiaId = db.lawn_protocols.find((p) => p.protocol_key === 'swfl_bermuda_10_10' && p.version === LAWN_V13_VERSION).id;
    db.lawn_protocol_service_completions.push({ id: 'c1', lawn_protocol_id: zoysiaId });
    await migration.down(knex);
    const left = db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION).map((p) => p.protocol_key).sort();
    expect(left).toEqual(['swfl_bermuda_10_10', 'swfl_zoysia_10_10']);
    expect(db.lawn_protocols.filter((p) => p.status === 'active').length).toBe(4);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'seed_v13').length).toBe(2);
  });
});

// ── Codex round 1 fixes ──────────────────────────────────────────────────────
describe('migration 20261005130000: catalog rows, links and unread gate keys', () => {
  const MISSING = fixMigration.PRODUCTS.slice(0, 4).map((p) => p.name);
  const stage = async (db) => { await migration.up(makeKnex(db)); };

  test('the four catalog rows carry the owner values', () => {
    const byName = Object.fromEntries(fixMigration.PRODUCTS.map((p) => [p.name, p]));
    expect(byName[migration.NAMES.NT]).toMatchObject({ category: 'fertilizer', formulation: 'liquid', container_size: '2.5 gal', unit_size_oz: 320, epa_reg_number: 'N/A', default_rate_per_1000: 12, min_label_rate_per_1000: 6, max_label_rate_per_1000: 16, rate_unit: 'fl oz' });
    expect(byName[migration.NAMES.STW15]).toMatchObject({ category: 'fertilizer', formulation: 'granular', container_size: '50 lb', unit_size_oz: 800, epa_reg_number: '10404-89', default_rate_per_1000: 4.02, rate_unit: 'lb' });
    expect(byName['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer']).toMatchObject({ epa_reg_number: '10404-87', default_rate_per_1000: 2.78, max_label_rate_per_1000: 5.48, rate_unit: 'lb' });
    expect(byName[migration.NAMES.DYL]).toMatchObject({ category: 'insecticide', formulation: 'granular', container_size: '30 lb', unit_size_oz: 480, epa_reg_number: '432-1308', default_rate_per_1000: 3, rate_unit: 'lb' });
  });

  test('every product the recipe names has a catalog row spec; an EPA number appears only where the owner gave one', () => {
    const named = new Set();
    for (const month of MONTHS) {
      for (const line of [...lines(visitFor(month).primary), ...lines(visitFor(month).secondary)]) if (line.includes(' — ')) named.add(nameOfLine(line));
    }
    const specNames = fixMigration.PRODUCTS.map((p) => p.name);
    for (const name of named) expect(specNames).toContain(name);
    expect(new Set(specNames).size).toBe(specNames.length);
    const withEpa = Object.fromEntries(fixMigration.PRODUCTS.filter((p) => p.epa_reg_number).map((p) => [p.name, p.epa_reg_number]));
    expect(withEpa).toEqual({
      'LESCO Nutra-TECH T&O Micronutrient Package': 'N/A',
      'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer': '10404-89',
      'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer': '10404-87',
      'Dylox 6.2 G Granular Insecticide': '432-1308',
      'Artavia 2 SC (Azoxy)': '91234-74',
      'Certainty Turf Herbicide': '59639-226',
      'Gravex 20 EW': '91234-283',
      'LESCO 24-0-11 with PolyPlus OPTI': 'N/A',
      'LESCO 90/10 Nonionic Surfactant': 'N/A',
      'Celsius WG': '432-1507',
    });
  });

  test('a repo-built catalog with only the recipe products absent from a bare database: all are inserted and linked', async () => {
    const db = seedDb({ without: Object.values(migration.NAMES) });
    await stage(db);
    await fixMigration.up(makeKnex(db));
    // Velista is covered by an alias row in this fixture, so it is not inserted.
    for (const name of Object.values(migration.NAMES).filter((n) => n !== migration.NAMES.VEL)) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
    expect(db.products_catalog.filter((c) => c.name === migration.NAMES.VEL)).toHaveLength(0);
    expect(db.lawn_protocol_products.filter((r) => !r.product_id)).toEqual([]);
  });

  test('a repo-built catalog (the four rows absent): rows are inserted, every v13 row links, unread gate keys go', async () => {
    const db = seedDb({ without: MISSING });
    await stage(db);
    expect(db.lawn_protocol_products.some((r) => r.product_id === null)).toBe(true);
    const knex = makeKnex(db);
    await fixMigration.up(knex);
    for (const name of MISSING) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
    expect(db.lawn_protocol_products.filter((r) => !r.product_id)).toEqual([]);
    const nt = db.products_catalog.find((c) => c.name === migration.NAMES.NT);
    expect(db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.NT).every((r) => r.product_id === nt.id)).toBe(true);
    // Tetrino keeps sunnyTurfOnly (read by the plan engine) and loses the keys nothing reads.
    const tet = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    expect(JSON.parse(tet.gates)).toEqual({ sunnyTurfOnly: true });
    for (const row of db.lawn_protocol_products) {
      const keys = Object.keys(typeof row.gates === 'string' ? JSON.parse(row.gates) : row.gates);
      expect(keys.filter((k) => !fixMigration.KEPT_GATE_KEYS.has(k))).toEqual([]);
    }
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_link_fix')).toHaveLength(4);
    // Idempotent.
    const rows = db.products_catalog.length; const logs = db.lawn_protocol_audit_log.length;
    await fixMigration.up(knex);
    expect(db.products_catalog.length).toBe(rows);
    expect(db.lawn_protocol_audit_log.length).toBe(logs);
  });

  test('a prod catalog that already has the rows is not touched or duplicated; an alias counts as present', async () => {
    const db = seedDb();
    db.products_catalog = db.products_catalog.filter((c) => c.name !== migration.NAMES.DYL);
    db.product_aliases.push({ product_id: 'cat-existing', alias_name: migration.NAMES.DYL });
    await stage(db);
    const before = db.products_catalog.length;
    await fixMigration.up(makeKnex(db));
    // Only the two rows this fixture lacks (Blindside, the 18-0-10) are added: no Dylox row.
    expect(db.products_catalog.length).toBe(before + 2);
    expect(db.products_catalog.filter((c) => /Dylox 6\.2/.test(c.name))).toHaveLength(0);
    expect(db.lawn_protocol_products.filter((r) => r.product_name === migration.NAMES.DYL).every((r) => r.product_id === 'cat-existing')).toBe(true);
  });

  test('a v13 product row naming something no spec covers fails the migration', async () => {
    const db = seedDb();
    await stage(db);
    const row = db.lawn_protocol_products[0];
    Object.assign(row, { product_id: null, product_name: 'Unlisted Product XYZ' });
    await expect(fixMigration.up(makeKnex(db))).rejects.toThrow(/Unlisted Product XYZ/);
  });

  test('a database with no staged rows is a no-op (nothing to link, nothing thrown)', async () => {
    const db = seedDb({ without: MISSING });
    await expect(fixMigration.up(makeKnex(db))).resolves.toBeUndefined();
  });

  test('down restores the gates, nulls only the ids it wrote, removes its audit rows, keeps the catalog rows', async () => {
    const db = seedDb({ without: MISSING });
    await stage(db);
    const gatesBefore = new Map(db.lawn_protocol_products.map((r) => [r.id, r.gates]));
    const nullBefore = db.lawn_protocol_products.filter((r) => !r.product_id).map((r) => r.id).sort();
    const knex = makeKnex(db);
    await fixMigration.up(knex);
    // A link made by someone else after the fact must survive down().
    const other = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.DYL);
    other.product_id = 'manual-link';
    await fixMigration.down(knex);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_link_fix')).toHaveLength(0);
    for (const r of db.lawn_protocol_products) expect(JSON.stringify(typeof r.gates === 'string' ? JSON.parse(r.gates) : r.gates)).toBe(JSON.stringify(typeof gatesBefore.get(r.id) === 'string' ? JSON.parse(gatesBefore.get(r.id)) : gatesBefore.get(r.id)));
    const nullAfter = db.lawn_protocol_products.filter((r) => !r.product_id).map((r) => r.id).sort();
    expect(nullAfter).toEqual(nullBefore.filter((id) => id !== other.id));
    expect(other.product_id).toBe('manual-link');
    for (const name of MISSING) expect(db.products_catalog.filter((c) => c.name === name)).toHaveLength(1);
  });
});

// ── Codex round 2 ────────────────────────────────────────────────────────────
describe('migration 20261005140000: rollback order, EPA numbers, Blindside rows', () => {
  const MISSING_ALL = fixMigration.PRODUCTS.map((p) => p.name);
  async function build({ catalogExtras = [] } = {}) {
    const db = seedDb({ without: MISSING_ALL });
    db.products_catalog.push(...catalogExtras);
    const knex = makeKnex(db);
    await migration.up(knex);
    await fixMigration.up(knex);
    await round2.up(knex);
    return { db, knex };
  }
  const v13Protocols = (db) => db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION);
  const rowsOf = (db, protocolId) => db.lawn_protocol_products.filter((r) => db.lawn_protocol_windows.find((w) => w.id === r.lawn_protocol_window_id).lawn_protocol_id === protocolId);

  test('up hands the link lists to this migration, so 130000.down finds none', async () => {
    const { db, knex } = await build();
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_link_fix')).toHaveLength(0);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === round2.LINK_FIX_HELD)).toHaveLength(4);
    // 130000.down alone now changes nothing.
    const before = JSON.stringify(db.lawn_protocol_products.map((r) => [r.id, r.product_id]));
    await fixMigration.down(knex);
    expect(JSON.stringify(db.lawn_protocol_products.map((r) => [r.id, r.product_id]))).toBe(before);
    expect(db.lawn_protocol_products.filter((r) => !r.product_id)).toEqual([]);
  });

  test('full rollback, nothing references v13: every v13 protocol, link and audit row goes', async () => {
    const { db, knex } = await build();
    await round2.down(knex); await fixMigration.down(knex); await migration.down(knex);
    expect(v13Protocols(db)).toHaveLength(0);
    expect(db.lawn_protocol_audit_log.filter((a) => /v13/.test(a.action))).toHaveLength(0);
    expect(db.lawn_protocols.filter((p) => p.status === 'active')).toHaveLength(4);
  });

  test('full rollback with a scheduled visit on one key: that key keeps every link, the others go', async () => {
    const { db, knex } = await build();
    db.scheduled_services.push({ id: 'v1', lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: LAWN_V13_VERSION });
    const zoysia = v13Protocols(db).find((p) => p.protocol_key === 'swfl_zoysia_10_10');
    const zoysiaBefore = rowsOf(db, zoysia.id).map((r) => [r.id, r.product_id]);
    await round2.down(knex); await fixMigration.down(knex); await migration.down(knex);
    expect(v13Protocols(db).map((p) => p.protocol_key)).toEqual(['swfl_zoysia_10_10']);
    expect(rowsOf(db, zoysia.id).map((r) => [r.id, r.product_id])).toEqual(zoysiaBefore);
    expect(rowsOf(db, zoysia.id).filter((r) => !r.product_id)).toEqual([]);
    // The referenced key keeps its Blindside rows and its audit trail too.
    expect(rowsOf(db, zoysia.id).filter((r) => r.product_name === 'Blindside Herbicide')).toHaveLength(6);
    expect(db.lawn_protocols.filter((p) => p.status === 'active')).toHaveLength(4);
  });

  test('a completion row also counts as a reference', async () => {
    const { db, knex } = await build();
    const bahia = v13Protocols(db).find((p) => p.protocol_key === 'swfl_bahia_10_10');
    db.lawn_protocol_service_completions.push({ id: 'c1', lawn_protocol_id: bahia.id });
    await round2.down(knex); await fixMigration.down(knex); await migration.down(knex);
    expect(v13Protocols(db).map((p) => p.protocol_key)).toEqual(['swfl_bahia_10_10']);
    expect(rowsOf(db, bahia.id).filter((r) => !r.product_id)).toEqual([]);
  });

  test('the verified EPA numbers fill only empty values and never overwrite', async () => {
    const extras = Object.keys(round2.EPA_NUMBERS).map((name, i) => ({ id: `x${i}`, name, active: true, epa_reg_number: name === 'Dismiss 64 oz' ? 'EXISTING-1' : (i % 2 ? '' : null) }));
    const { db } = await build({ catalogExtras: extras });
    const epaOf = (name) => db.products_catalog.find((c) => c.name === name).epa_reg_number;
    for (const [name, epa] of Object.entries(round2.EPA_NUMBERS)) expect(epaOf(name)).toBe(name === 'Dismiss 64 oz' ? 'EXISTING-1' : epa);
    // Stonewall 4FL has no verified number: it is not in the map and stays empty.
    expect(Object.keys(round2.EPA_NUMBERS)).not.toContain(migration.NAMES.STW);
    expect(db.products_catalog.find((c) => c.name === migration.NAMES.STW).epa_reg_number ?? null).toBeNull();
  });

  test('EPA numbers come back out on rollback only while no v13 protocol is referenced', async () => {
    const extras = Object.keys(round2.EPA_NUMBERS).map((name, i) => ({ id: `x${i}`, name, active: true, epa_reg_number: null }));
    const free = await build({ catalogExtras: extras });
    await round2.down(free.knex);
    expect(free.db.products_catalog.filter((c) => round2.EPA_NUMBERS[c.name] && c.epa_reg_number)).toEqual([]);
    const held = await build({ catalogExtras: extras.map((e) => ({ ...e, id: `y${e.id}` })) });
    held.db.scheduled_services.push({ id: 'v1', lawn_protocol_key: 'swfl_bermuda_10_10', lawn_protocol_version: LAWN_V13_VERSION });
    await round2.down(held.knex);
    expect(held.db.products_catalog.find((c) => c.name === 'Tetrino Insecticide').epa_reg_number).toBe('432-1591');
  });

  test('Blindside: a conditional spot row beside Celsius in every window that lists it, mirroring the recipe', async () => {
    const { db, knex } = await build();
    for (const protocol of v13Protocols(db)) {
      const rows = rowsOf(db, protocol.id);
      const byWindow = new Map();
      for (const r of rows) byWindow.set(r.lawn_protocol_window_id, [...(byWindow.get(r.lawn_protocol_window_id) || []), r]);
      for (const group of byWindow.values()) {
        const hasCelsius = group.some((r) => r.product_name === migration.NAMES.CEL);
        const blind = group.filter((r) => r.product_name === BLINDSIDE);
        expect(blind).toHaveLength(hasCelsius ? 1 : 0);
        for (const b of blind) {
          expect(b).toMatchObject({ role: 'post_emergent_spot', application_mode: 'spot', default_in_plan: false });
          expect(JSON.parse(b.gates)).toEqual({ trigger: 'celsius_annual_cap_reached' });
          expect(b.product_id).toBeTruthy();
          expect(b.sort_order).toBeGreaterThan(Math.max(...group.filter((r) => r !== b).map((r) => r.sort_order)));
        }
      }
    }
    // The windows that list Blindside are exactly the recipe months that list it.
    const recipeMonths = MONTHS.filter((m) => lines(visitFor(m).secondary).some((l) => l.startsWith(BLINDSIDE)));
    const celsiusMonths = MONTHS.filter((m) => lines(visitFor(m).secondary).some((l) => l.startsWith('Celsius WG')));
    expect(recipeMonths).toEqual(celsiusMonths);
    const protocol = v13Protocols(db)[0];
    const monthsWithBlindside = db.lawn_protocol_windows.filter((w) => w.lawn_protocol_id === protocol.id && db.lawn_protocol_products.some((r) => r.lawn_protocol_window_id === w.id && r.product_name === BLINDSIDE)).map((w) => w.month).sort((a, b) => a - b);
    expect(monthsWithBlindside).toEqual(recipeMonths);
    // Idempotent.
    const count = db.lawn_protocol_products.length;
    await round2.up(knex);
    expect(db.lawn_protocol_products.length).toBe(count);
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_round2')).toHaveLength(4);
  });
});

// ── Codex round 3 ────────────────────────────────────────────────────────────
describe('migration 20261005160000: safety gate keys and combination pre-emergents', () => {
  const STW15 = migration.NAMES.STW15;
  const DIM15 = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
  const MISSING_ALL = fixMigration.PRODUCTS.map((p) => p.name);
  async function build({ catalogExtras = [], stop = false } = {}) {
    const db = seedDb({ without: MISSING_ALL });
    db.products_catalog.push(...catalogExtras);
    const knex = makeKnex(db);
    await migration.up(knex);
    await fixMigration.up(knex);
    await round2.up(knex);
    if (!stop) await round3.up(knex);
    return { db, knex };
  }
  const gatesOf = (row) => (typeof row.gates === 'string' ? JSON.parse(row.gates) : row.gates);
  const catalogRow = (db, name) => db.products_catalog.find((c) => c.name === name);
  const v13Protocols = (db) => db.lawn_protocols.filter((p) => p.version === LAWN_V13_VERSION);
  const fullRollback = async (knex) => { await round3.down(knex); await round2.down(knex); await fixMigration.down(knex); await migration.down(knex); };

  test('every gate key the recipe states is either restored or named informational: none is left unclassified', () => {
    const stated = new Set();
    for (const [, spec] of migration.PRODUCTS) for (const key of Object.keys(spec[7] || {})) stated.add(key);
    for (const key of stated) {
      const known = fixMigration.KEPT_GATE_KEYS.has(key) || round3.RESTORED_GATE_KEYS.has(key) || round3.INFORMATIONAL_GATE_KEYS.has(key);
      expect({ key, known }).toEqual({ key, known: true });
    }
    // The label limits the owner named stay restored.
    for (const key of ['minDistanceFromWaterFt', 'applyAlone', 'noWaterIn', 'delayWateringHours', 'spreaderVisitOnly', 'northPortBlocked']) {
      expect(round3.RESTORED_GATE_KEYS.has(key)).toBe(true);
    }
  });

  test('after 130000 the label limits are gone, after 150000 every staged row carries them again', async () => {
    const before = await build({ stop: true });
    const tetBefore = before.db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    expect(gatesOf(tetBefore)).toEqual({ sunnyTurfOnly: true });
    const { db } = await build();
    for (const row of db.lawn_protocol_products) {
      const window = db.lawn_protocol_windows.find((w) => w.id === row.lawn_protocol_window_id);
      const spec = migration.PRODUCTS.find(([key, s]) => key === window.window_key && s[0] === row.product_name);
      if (!spec) continue; // the Blindside rows 140000 adds
      const expected = Object.fromEntries(Object.entries(spec[1][7] || {}).filter(([key]) => !round3.INFORMATIONAL_GATE_KEYS.has(key)));
      expect({ w: window.window_key, n: row.product_name, g: gatesOf(row) }).toEqual({ w: window.window_key, n: row.product_name, g: expected });
    }
    const tet = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    expect(gatesOf(tet)).toEqual({ sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true });
    const acelepryn = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.ACE);
    expect(gatesOf(acelepryn)).toEqual({ trigger: expect.any(String), rateRange: '0.046-0.092 fl oz/1000' });
    expect(db.lawn_protocol_audit_log.filter((a) => a.action === 'v13_gate_restore')).toHaveLength(4);
  });

  test('a value the row already carries is never overwritten, and a second run changes nothing', async () => {
    const { db, knex } = await build({ stop: true });
    const tet = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    tet.gates = JSON.stringify({ ...gatesOf(tet), minDistanceFromWaterFt: 50 });
    await round3.up(knex);
    expect(gatesOf(tet)).toEqual({ sunnyTurfOnly: true, minDistanceFromWaterFt: 50, applyAlone: true });
    const snapshot = JSON.stringify(db.lawn_protocol_products.map((r) => [r.id, r.gates]));
    const logs = db.lawn_protocol_audit_log.length;
    await round3.up(knex);
    expect(JSON.stringify(db.lawn_protocol_products.map((r) => [r.id, r.gates]))).toBe(snapshot);
    expect(db.lawn_protocol_audit_log.length).toBe(logs);
  });

  test('the two combination pre-emergents become herbicide pesticides with their EPA numbers; analyses stay', async () => {
    const { db } = await build();
    for (const [name, epa, n, k] of [[STW15, '10404-89', 15, 15], [DIM15, '10404-87', 18, 10]]) {
      expect(catalogRow(db, name)).toMatchObject({ category: 'herbicide', product_type: 'pesticide', epa_reg_number: epa, analysis_n: n, analysis_p: 0, analysis_k: k });
    }
    // Nothing else changed class: the fertilizers stay fertilizers.
    expect(catalogRow(db, migration.NAMES.F24).category).toBe('fertilizer');
    expect(catalogRow(db, migration.NAMES.NT).category).toBe('fertilizer');
    expect(catalogRow(db, migration.NAMES.STW).category).toBe('herbicide');
  });

  test('a prod row already classed as herbicide keeps its own values; a blank or N/A EPA number is filled, a real one is not', async () => {
    const prodStw = { id: 'prod-stw', name: STW15, active: true, category: 'Herbicide', product_type: 'pesticide', epa_reg_number: '10404-99' };
    const prodDim = { id: 'prod-dim', name: DIM15, active: true, category: 'fertilizer', product_type: 'fertilizer', epa_reg_number: 'N/A' };
    const { db } = await build({ catalogExtras: [prodStw, prodDim] });
    expect(prodStw).toMatchObject({ category: 'Herbicide', product_type: 'pesticide', epa_reg_number: '10404-99' });
    expect(prodDim).toMatchObject({ category: 'herbicide', product_type: 'pesticide', epa_reg_number: '10404-87' });
    expect(db.products_catalog.filter((c) => c.name === STW15)).toHaveLength(1);
  });

  test('full rollback, nothing references v13: the gates, the audit rows and the classification all go back', async () => {
    const { db, knex } = await build();
    await fullRollback(knex);
    expect(v13Protocols(db)).toHaveLength(0);
    expect(db.lawn_protocol_audit_log.filter((a) => /v13/.test(a.action))).toHaveLength(0);
    expect(catalogRow(db, STW15)).toMatchObject({ category: 'fertilizer' });
    expect(catalogRow(db, DIM15)).toMatchObject({ category: 'fertilizer' });
  });

  test('full rollback with a scheduled visit on one key: that key keeps the restored gates and the classification stays', async () => {
    const { db, knex } = await build();
    db.scheduled_services.push({ id: 'v1', lawn_protocol_key: 'swfl_zoysia_10_10', lawn_protocol_version: LAWN_V13_VERSION });
    await fullRollback(knex);
    expect(v13Protocols(db).map((p) => p.protocol_key)).toEqual(['swfl_zoysia_10_10']);
    const zoysia = v13Protocols(db)[0];
    const windows = db.lawn_protocol_windows.filter((w) => w.lawn_protocol_id === zoysia.id).map((w) => w.id);
    const tet = db.lawn_protocol_products.find((r) => windows.includes(r.lawn_protocol_window_id) && r.product_name === migration.NAMES.TET);
    expect(gatesOf(tet)).toEqual({ sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true });
    expect(catalogRow(db, STW15).category).toBe('herbicide');
  });

  test('down removes a restored key only while it still holds the value written', async () => {
    const { db, knex } = await build();
    const tet = db.lawn_protocol_products.find((r) => r.product_name === migration.NAMES.TET);
    tet.gates = JSON.stringify({ ...gatesOf(tet), minDistanceFromWaterFt: 50 });
    await round3.down(knex);
    expect(gatesOf(tet)).toEqual({ sunnyTurfOnly: true, minDistanceFromWaterFt: 50 });
  });
});
