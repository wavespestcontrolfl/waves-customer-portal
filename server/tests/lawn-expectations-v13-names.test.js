// The v13 lawn program's exact catalog names in the "What to expect" product table
// (config/lawn-expectations.js PRODUCT_CLASS_ENTRIES). Matching is whole-name and an unmapped name gets NO
// line (fail closed), so every product the v13 program can log needs a decision: a family whose approved
// sentence is true for it, or an explicit null. No sentence is new: each name maps to an existing row.
// Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const {
  PRODUCT_ROWS, PRODUCT_CLASS,
} = require('../config/lawn-expectations');
const {
  buildLawnExpectations, classifyLawnProduct, classifyLawnProductStatus,
} = require('../services/service-report/lawn-expectations');
const { buildLawnCopyV6 } = require('../services/service-report/lawn-copy-v6');
const facts = require('../services/service-report/lawn-report-facts');
const { ARENA_OLD, ARENA_NEW } = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');

// ── the v13 names, read from the sources (so a future v13 product cannot be silently unmapped) ──
function readInventoryNames() {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-inventory.js'), 'utf8');
  const start = src.indexOf('const V13_LAWN_PROTOCOL_PRODUCT_DEFINITIONS = [');
  const end = src.indexOf('].map(', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/\['v13_[a-z0-9_]+',\s*'([^']+)'/g)].map((m) => m[1]);
}

function readRecipeNames() {
  const recipe = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/lawn-protocol-v13.json'), 'utf8'));
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'primary' || key === 'secondary') && typeof value === 'string') {
          value.split('\n').filter((line) => line.includes(' — ')).forEach((line) => names.add(line.split(' — ')[0].trim()));
        } else walk(value);
      }
    }
  };
  walk(recipe);
  return [...names];
}

describe('every product the v13 program can log has a decision', () => {
  const inventory = readInventoryNames();
  const recipe = readRecipeNames();

  test('the readiness list was read whole (22 names today; every v13_ key in the block is read)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-inventory.js'), 'utf8');
    const block = src.slice(src.indexOf('const V13_LAWN_PROTOCOL_PRODUCT_DEFINITIONS = ['), src.indexOf('].map(', src.indexOf('const V13_LAWN_PROTOCOL_PRODUCT_DEFINITIONS = [')));
    expect(inventory).toHaveLength(22);
    expect(inventory).toHaveLength((block.match(/\['v13_/g) || []).length);
    expect(new Set(inventory).size).toBe(inventory.length);
    expect(recipe.length).toBeGreaterThan(15);
  });

  test.each(inventory)('readiness name %s is a family or an explicit null', (name) => {
    expect(classifyLawnProductStatus(name)).not.toBe('unmapped');
  });

  test.each(recipe)('recipe product line %s is a family or an explicit null', (name) => {
    expect(classifyLawnProductStatus(name)).not.toBe('unmapped');
  });

  test('the renamed Arena row and its SiteOne alias resolve like Arena 50 WDG', () => {
    expect(ARENA_OLD).toBe('Arena 50 WDG');
    for (const name of [ARENA_OLD, ARENA_NEW, 'Arena S.E. 50 WDG Insecticide 2.5 lb. (40 oz.) Jug (Florida Only)']) {
      expect(classifyLawnProduct(name)).toEqual(classifyLawnProduct('Arena 50 WDG'));
      expect(classifyLawnProduct(name).family).toBe('insecticide');
    }
  });
});

describe('the mapping, name by name', () => {
  const FAMILY_OF = [
    ['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', 'pre_emergent', null, []],
    ['Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', 'pre_emergent', null, []],
    ['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', 'pre_emergent', null, ['granular_fertilizer']],
    ['LESCO Nutra-TECH T&O Micronutrient Package', 'iron_micros', null, []],
    ['Velista', 'fungicide', null, []],
    ['Gravex 20 EW', 'fungicide', null, []],
    ['Tetrino Insecticide', 'insecticide', null, []],
    ['Dylox 6.2 G Granular Insecticide', 'insecticide', 'curative', []],
  ];

  test.each(FAMILY_OF)('%s -> %s (lock %s, also %j)', (name, family, modeLock, alsoFamilies) => {
    expect(classifyLawnProduct(name)).toEqual({ family, modeLock, alsoFamilies });
    expect(classifyLawnProduct(name.toUpperCase())).toEqual({ family, modeLock, alsoFamilies });
  });

  test('a product that names no extra family has none, and the old mappings are unchanged', () => {
    expect(classifyLawnProduct('LESCO Stonewall 4FL')).toEqual({ family: 'pre_emergent', modeLock: null, alsoFamilies: [] });
    expect(classifyLawnProduct('Acelepryn Insecticide')).toEqual({ family: 'insecticide', modeLock: 'preventive', alsoFamilies: [] });
    expect(PRODUCT_CLASS.get('lesco 24-0-11 with polyplus opti')).toEqual({ family: 'granular_fertilizer', modeLock: null, alsoFamilies: [] });
  });
});

const lines = (built) => built.rows.flatMap((row) => row.sentences).map((s) => s.text);
const visible = (built) => built.rows.flatMap((row) => row.sentences).filter((s) => s.key === 'visibleChange').map((s) => s.text);
const apps = (...names) => names.map((name) => ({ name }));

describe('the engine prints the existing approved sentence for each name', () => {
  test('liquid pre-emergents: the barrier row, judged by absence', () => {
    for (const name of ['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide']) {
      const built = buildLawnExpectations({ applications: apps(name), visitDate: '2026-03-10' });
      expect(built.unmapped).toEqual([]);
      expect(built.rows.map((r) => r.id)).toEqual(['pre_emergent']);
      expect(visible(built)).toEqual([PRODUCT_ROWS.pre_emergent.visibleChange]);
    }
  });

  test('Nutra-TECH: the micronutrient color row', () => {
    const built = buildLawnExpectations({ applications: apps('LESCO Nutra-TECH T&O Micronutrient Package') });
    expect(built.rows.map((r) => r.id)).toEqual(['iron_micros']);
    expect(visible(built)).toEqual([PRODUCT_ROWS.iron_micros.visibleChange]);
  });

  test('Dimension 18-0-10 reads BOTH the feed row and the barrier row, as two products would', () => {
    const name = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
    const one = buildLawnExpectations({ applications: apps(name), visitDate: '2026-10-08' });
    const two = buildLawnExpectations({ applications: apps('Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', 'LESCO 24-0-11 with PolyPlus OPTI'), visitDate: '2026-10-08' });
    expect(one.rows.map((r) => r.id).sort()).toEqual(['granular_fertilizer', 'pre_emergent']);
    expect(one.rows.map((r) => r.id)).toEqual(two.rows.map((r) => r.id));
    expect(lines(one)).toEqual(lines(two));
    expect(visible(one)).toEqual([PRODUCT_ROWS.granular_fertilizer.visibleChange, PRODUCT_ROWS.pre_emergent.visibleChange]);
  });

  test('fungicides: preventive until a target or named issue says curative (the rule is unchanged)', () => {
    for (const name of ['Velista', 'Gravex 20 EW']) {
      expect(visible(buildLawnExpectations({ applications: apps(name) }))).toEqual([PRODUCT_ROWS.fungicide_preventive.visibleChange]);
      expect(visible(buildLawnExpectations({ applications: [{ name, targets: ['Gray leaf spot'] }] }))).toEqual([PRODUCT_ROWS.fungicide_curative.visibleChange]);
      expect(visible(buildLawnExpectations({ applications: apps(name), issues: ['large_patch'] }))).toContain(PRODUCT_ROWS.fungicide_curative.visibleChange);
    }
  });

  test('Tetrino: protective on the May whole-lawn pass, curative when chinch bugs are tagged, named or tied', () => {
    const tetrino = 'Tetrino Insecticide';
    expect(visible(buildLawnExpectations({ applications: apps(tetrino), visitDate: '2026-05-12' }))).toEqual([PRODUCT_ROWS.insecticide_preventive.visibleChange]);
    expect(visible(buildLawnExpectations({ applications: [{ name: tetrino, targets: ['Southern chinch bugs'] }] }))).toEqual([PRODUCT_ROWS.insecticide_curative.visibleChange]);
    expect(visible(buildLawnExpectations({ applications: apps(tetrino), issues: ['chinch'] }))).toContain(PRODUCT_ROWS.insecticide_curative.visibleChange);
    expect(visible(buildLawnExpectations({ applications: apps(tetrino), tiedFamilies: ['insecticide'] }))).toEqual([PRODUCT_ROWS.insecticide_curative.visibleChange]);
  });

  test('Dylox 6.2 G: always the curative insecticide row (a curative granule; never "works ahead of the pests")', () => {
    const dylox = 'Dylox 6.2 G Granular Insecticide';
    expect(visible(buildLawnExpectations({ applications: apps(dylox) }))).toEqual([PRODUCT_ROWS.insecticide_curative.visibleChange]);
    expect(visible(buildLawnExpectations({ applications: [{ name: dylox, targets: ['White grubs'] }] }))).toEqual([PRODUCT_ROWS.insecticide_curative.visibleChange]);
  });

  test('the v6 "what to expect" paragraph fills for the October and May visits that used to print nothing', () => {
    const copy = (names, visitDate) => buildLawnCopyV6({ snapshot: { statusHeadline: 'h' }, insights: [], treatment: { products: names.map((name) => ({ name, targets: [] })) } }, { visitDate, nextVisitGapDays: 30 }).fields.whatToExpect;
    const october = copy(['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', 'LESCO Nutra-TECH T&O Micronutrient Package'], '2026-10-08');
    expect(october).toContain(PRODUCT_ROWS.granular_fertilizer.visibleChange);
    expect(october).toContain(PRODUCT_ROWS.iron_micros.visibleChange);
    expect(copy(['Tetrino Insecticide'], '2026-05-12')).toContain(PRODUCT_ROWS.insecticide_preventive.visibleChange);
  });
});

describe('Tetrino is not mode-locked, so its tie behaves like any insecticide', () => {
  test('rowProductKind keeps Tetrino and Dylox as insecticide rows (only Acelepryn is locked out of ties)', () => {
    const row = (name) => ({ product_name: name, product_category: 'insecticide' });
    expect(facts._test.rowProductKind(row('Tetrino Insecticide'))).toBe('insecticide');
    expect(facts._test.rowProductKind(row('Dylox 6.2 G Granular Insecticide'))).toBe('insecticide');
    expect(facts._test.rowProductKind(row('Acelepryn Insecticide'))).toBeNull();
  });
});
