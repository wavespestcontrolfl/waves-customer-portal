/**
 * 20261127143000_product_mix_rules: the table's constraints (checked against the migration source), the seed (every
 * row quotes its source, a missing product skips its row, insert-only, one audit event per added row) and down().
 * The migrated table itself is exercised in product-mix-rules-postgres.test.js (CI server-db job).
 */
const fs = require('fs');
const path = require('path');

const mockAudit = [];
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => { mockAudit.push(event); }),
}));

// The seed logs each skipped or added row; keep the test output quiet.
beforeAll(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });

const FILE = path.join(__dirname, '..', 'models', 'migrations', '20261127143000_product_mix_rules.js');
const migration = require(FILE);
const source = fs.readFileSync(FILE, 'utf8');
const lawnCard = fs.readFileSync(path.join(__dirname, '..', 'config', 'lawn-protocol-v13.json'), 'utf8');
const protocols = fs.readFileSync(path.join(__dirname, '..', 'config', 'protocols.json'), 'utf8');
const catalogSeed = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260401000026_service_protocols.js'), 'utf8');

describe('the table', () => {
  test('exactly one of product_b_id / group_b, a pair stored smaller id first, and the verdict list', () => {
    expect(source).toContain('CHECK ((product_b_id IS NULL) <> (group_b IS NULL))');
    expect(source).toContain('CHECK (product_b_id IS NULL OR product_a_id < product_b_id)');
    expect(migration._VERDICTS).toEqual(['ok', 'caution', 'never']);
    expect(source).toContain('product_mix_rules_verdict_check');
    expect(source).toContain('product_mix_rules_group_check');
  });

  test('one row per pair and per product + group (two partial unique indexes)', () => {
    expect(source).toMatch(/CREATE UNIQUE INDEX product_mix_rules_one_per_pair\s+ON product_mix_rules \(product_a_id, product_b_id\) WHERE product_b_id IS NOT NULL/);
    expect(source).toMatch(/CREATE UNIQUE INDEX product_mix_rules_one_per_group\s+ON product_mix_rules \(product_a_id, group_b\) WHERE group_b IS NOT NULL/);
  });

  test('the reason column holds 200 characters and every audit action fits varchar(96)', () => {
    expect(source).toContain("t.string('reason', 200).notNullable()");
    expect(migration._AUDIT_ACTION.length).toBeLessThanOrEqual(96);
  });
});

describe('the seed rules', () => {
  // Every double-quoted passage in a source names text that is in the card or catalog row it cites.
  test.each(migration._SEED.map((rule) => [rule.reason, rule]))('%s: quotes text that exists in its source', (_reason, rule) => {
    const quotes = [...rule.source.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(quotes.length).toBeGreaterThan(0);
    const haystack = rule.source.startsWith('Catalog row') ? catalogSeed : `${lawnCard}\n${protocols}`;
    for (const quote of quotes) {
      for (const part of quote.split(' ... ')) expect(haystack).toContain(part.trim());
    }
    expect(rule.reason.length).toBeLessThanOrEqual(200);
    expect(Boolean(rule.b) !== Boolean(rule.group)).toBe(true);
    if (rule.group) expect(migration._GROUPS).toContain(rule.group);
  });
});

describe('up()', () => {
  function makeKnex({ products, existing = [], hasAudit = true, hasRules = true }) {
    const inserted = [];
    const knex = jest.fn((table) => {
      const filters = [];
      const q = {
        where(a, op, value) {
          if (typeof a === 'object') filters.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
          else if (op === 'ilike') filters.push((r) => r[a].toLowerCase().startsWith(value.replace(/%$/, '').replace(/\\(.)/g, '$1').toLowerCase()));
          return q;
        },
        andWhere(a) { return q.where(a); },
        select: async () => (table === 'products_catalog' ? products.filter((r) => filters.every((f) => f(r))) : []),
        first: async () => existing.find((r) => filters.every((f) => f(r))),
        insert: (row) => { inserted.push(row); return { returning: async () => [{ id: `rule-${inserted.length}` }] }; },
      };
      return q;
    });
    knex.schema = {
      hasTable: jest.fn(async (name) => ({ products_catalog: true, product_mix_rules: hasRules, audit_log: hasAudit })[name]),
      createTable: jest.fn(async () => {}),
    };
    knex.raw = jest.fn(async () => {});
    return { knex, inserted };
  }
  const catalog = [
    { id: 'b0000000-0000-4000-8000-000000000001', name: 'Celsius WG', active: true },
    { id: 'a0000000-0000-4000-8000-000000000002', name: 'Certainty Turf Herbicide', active: true },
    { id: 'c0000000-0000-4000-8000-000000000003', name: 'Tetrino Insecticide', active: true },
  ];
  beforeEach(() => { mockAudit.length = 0; });

  test('seeds only the rules whose products are in the catalog, a pair smaller id first, one audit event each', async () => {
    const { knex, inserted } = makeKnex({ products: catalog });
    await migration.up(knex);
    expect(inserted).toEqual([
      expect.objectContaining({ product_a_id: catalog[0].id, group_b: 'fertilizer', verdict: 'never', active: true }),
      expect.objectContaining({ product_a_id: catalog[1].id, product_b_id: catalog[0].id, verdict: 'caution' }),
      expect.objectContaining({ product_a_id: catalog[2].id, group_b: 'any', verdict: 'never' }),
    ]);
    expect(mockAudit).toHaveLength(3);
    expect(mockAudit[0]).toMatchObject({ actor_type: 'system', action: 'product_mix_rules.seeded', resource_type: 'product_mix_rules', critical: true });
  });

  test('finds a product by a name prefix when the exact name is missing, and only when one row matches', async () => {
    const { knex, inserted } = makeKnex({ products: [{ id: 'd0000000-0000-4000-8000-000000000004', name: 'Reliant Systemic Fungicide (phosphite) 2.5 gal', active: true }] });
    await migration.up(knex);
    expect(inserted).toEqual([expect.objectContaining({ group_b: 'copper', verdict: 'never' })]);
    const twice = makeKnex({ products: [
      { id: 'd0000000-0000-4000-8000-000000000004', name: 'Reliant Systemic Fungicide A', active: true },
      { id: 'd0000000-0000-4000-8000-000000000005', name: 'Reliant Systemic Fungicide B', active: true },
    ] });
    await migration.up(twice.knex);
    expect(twice.inserted).toEqual([]);
  });

  test('an existing row (an admin edit, or a second run) is never overwritten or added again', async () => {
    const existing = [{ product_a_id: catalog[0].id, group_b: 'fertilizer' }];
    const { knex, inserted } = makeKnex({ products: catalog, existing });
    await migration.up(knex);
    expect(inserted.map((r) => r.group_b || r.product_b_id)).toEqual([catalog[0].id, 'any']);
  });

  test('an empty catalog seeds nothing and does not fail; a missing table is created first', async () => {
    const { knex, inserted } = makeKnex({ products: [], hasRules: false });
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(knex.schema.createTable).toHaveBeenCalledWith('product_mix_rules', expect.any(Function));
    expect(inserted).toEqual([]);
  });

  test('down() drops the table', async () => {
    const knex = { schema: { dropTableIfExists: jest.fn(async () => {}) } };
    await migration.down(knex);
    expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith('product_mix_rules');
  });
});

describe('20261127160000_product_mix_rules_certainty_nis_caution', () => {
  const fix = require('../models/migrations/20261127160000_product_mix_rules_certainty_nis_caution');

  test('moves the seeded Certainty + 90/10 row from ok to caution with the card\'s reason; the reason fits 200', () => {
    expect(fix._BEFORE).toEqual({ verdict: 'ok', reason: migration._SEED.find((r) => r.verdict === 'ok').reason });
    expect(fix._AFTER).toEqual({ verdict: 'caution', reason: 'Card leaves both out in February and June to September' });
    expect(`migration:${fix._MIGRATION}:down`.length).toBeLessThanOrEqual(96);
  });

  test('a missing table or product changes nothing and does not fail', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };
    await expect(fix.up(knex)).resolves.toBeUndefined();
    await expect(fix.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('20261127170000_product_mix_rules_version_and_prefix', () => {
  const fix = require('../models/migrations/20261127170000_product_mix_rules_version_and_prefix');

  test('adds an integer version (default 1) and repeats the caution fix for prefix-matched names', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20261127170000_product_mix_rules_version_and_prefix.js'), 'utf8');
    expect(text).toContain("t.integer('version').notNullable().defaultTo(1)");
    expect(text).toContain("'ilike'");
    expect(fix._AFTER).toEqual({ verdict: 'caution', reason: 'Card leaves both out in February and June to September' });
    expect(`migration:${fix._MIGRATION}:down`.length).toBeLessThanOrEqual(96);
  });

  test('a missing table changes nothing and does not fail', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => false), alterTable: jest.fn() };
    await expect(fix.up(knex)).resolves.toBeUndefined();
    await expect(fix.down(knex)).resolves.toBeUndefined();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });
});

describe('20261127180000_celsius_surfactant_heat', () => {
  const fix = require('../models/migrations/20261127180000_celsius_surfactant_heat');
  const seed = require('../models/migrations/20261127143000_product_mix_rules');

  test('the heat line is the job sheet\'s own wording, on the pair and on a surfactant group caution', () => {
    const sheet = fs.readFileSync(path.join(__dirname, '..', 'services', 'lawn-weed-mix.js'), 'utf8');
    expect(sheet).toContain('const SURFACTANT_MAX_TEMP_F = 90;');
    expect(sheet).toContain('const SURFACTANT_CHECK_NOTE = `Leave the surfactant out if it is ${SURFACTANT_MAX_TEMP_F}°F or hotter.`;');
    expect(fix._HEAT).toBe('Leave the surfactant out if it is 90°F or hotter.');
    const seeded = seed._SEED.find((r) => r.a[0] === 'Celsius WG' && r.b && r.b[0] === 'LESCO 90/10 Nonionic Surfactant');
    expect(fix._PAIR_BEFORE).toBe(seeded.reason);
    expect(fix._PAIR_AFTER).toBe(`${seeded.reason} Leave the surfactant out if it is 90°F or hotter.`);
    expect(fix._GROUP_RULE).toMatchObject({ group_b: 'surfactant', verdict: 'caution' });
    expect(fix._GROUP_RULE.reason).toContain('In February and June to September, spray Celsius alone: no surfactant.');
    expect(fix._GROUP_RULE.reason.endsWith(fix._HEAT)).toBe(true);
    expect(seed._GROUPS).toContain('surfactant');
    for (const reason of [fix._PAIR_AFTER, fix._GROUP_RULE.reason]) expect(reason.length).toBeLessThanOrEqual(200);
    expect(`migration:${fix._MIGRATION}:down:group`.length).toBeLessThanOrEqual(96);
  });

  test('a missing table changes nothing and does not fail', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };
    knex.raw = jest.fn();
    await expect(fix.up(knex)).resolves.toBeUndefined();
    await expect(fix.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
    expect(knex.raw).not.toHaveBeenCalled();
  });
});

describe('20261127190000_reliant_fertilizer_test', () => {
  const fix = require('../models/migrations/20261127190000_reliant_fertilizer_test');

  test('the rule quotes the Reliant card line word for word', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'config', 'tree-shrub-field-guide.json'), 'utf8');
    const line = 'Do not tank mix with copper. Jar test and small plant test before a mix with foliar fertilizer.';
    expect(guide).toContain(`"${line}"`);
    expect(fix._RULE).toMatchObject({ group_b: 'fertilizer', verdict: 'caution', reason: 'Jar test and plant test first.', jar_test_required: true });
    expect(fix._RULE.source).toContain(`"${line}"`);
    expect(`migration:${fix._MIGRATION}:down`.length).toBeLessThanOrEqual(96);
  });

  test('a missing table changes nothing and does not fail', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };
    knex.raw = jest.fn();
    await expect(fix.up(knex)).resolves.toBeUndefined();
    await expect(fix.down(knex)).resolves.toBeUndefined();
    expect(knex).not.toHaveBeenCalled();
    expect(knex.raw).not.toHaveBeenCalled();
  });
});
