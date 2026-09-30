/**
 * 20260928120000 — widens seo_link_intake_items_source_check with
 * `ai_citation` (the third registry source CHECK 20260928050000 missed), and
 * makes its own rollback safe + reversible: down() relabels ai_citation
 * intake rows to legacy_unknown before narrowing, up() restores them by their
 * never-rewritten `ai_citation:` item_key. Source-reading + fake-knex, the
 * same convention as the 050000 / 060000 / 110000 migration tests.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260928120000_link_intake_source_ai_citation.js');
const STEP2 = path.join(__dirname, '..', 'models/migrations/20260830000021_backlink_intake_step2.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

const src = fs.readFileSync(MIG, 'utf8');
const arrayLiteral = (text, name) => {
  const m = text.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};
const stringLiteral = (name) => {
  const m = src.match(new RegExp(`^const ${name} = '([^'\\n]*)';`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return m[1];
};

// Models the one table, its CHECK (enforced on every write, and when the
// constraint is re-added), and the migration's restore UPDATE.
function fakeKnex(items, { check = [...arrayLiteral(fs.readFileSync(STEP2, 'utf8'), 'LINK_SOURCES')] } = {}) {
  const state = { check, raws: [] };
  const assertCheck = () => {
    const bad = items.find((r) => !state.check.includes(r.source));
    if (bad) throw new Error(`check constraint "seo_link_intake_items_source_check" is violated by row ${bad.id}`);
  };
  const knex = Object.assign(jest.fn((table) => {
    expect(table).toBe('seo_link_intake_items');
    let whereArg = null;
    const q = {
      where(a) { whereArg = a; return q; },
      update: jest.fn(async (patch) => {
        let n = 0;
        for (const r of items) if (Object.entries(whereArg).every(([k, v]) => r[k] === v)) { Object.assign(r, patch); n += 1; }
        assertCheck();
        return n;
      }),
    };
    return q;
  }), {
    raw: jest.fn(async (sql, bindings = []) => {
      const text = String(sql);
      state.raws.push({ sql: text, bindings });
      if (/DROP CONSTRAINT IF EXISTS seo_link_intake_items_source_check$/.test(text)) { state.check = null; return {}; }
      const add = text.match(/ADD CONSTRAINT seo_link_intake_items_source_check CHECK \(source IN \((.*)\)\)$/);
      if (add) {
        state.check = add[1].split(', ').map((v) => v.replace(/'/g, ''));
        assertCheck(); // Postgres validates existing rows when a CHECK is added
        return {};
      }
      if (/^UPDATE seo_link_intake_items SET source = 'ai_citation' WHERE source = 'legacy_unknown' AND item_key ~ \?$/.test(text)) {
        for (const r of items) if (r.source === 'legacy_unknown' && new RegExp(bindings[0]).test(r.item_key)) r.source = 'ai_citation';
        assertCheck();
        return {};
      }
      throw new Error(`unexpected SQL: ${text}`);
    }),
  });
  knex._state = state;
  return knex;
}

const seedItems = () => ([
  { id: 'i1', source: 'ai_citation', item_key: R.intakeItemKey('ai_citation', 'https://bit.ly/sample-citation') },
  { id: 'i2', source: 'ai_citation', item_key: R.intakeItemKey('ai_citation', `https://www.example.com/${'long-path/'.repeat(80)}`) }, // hashed key
  { id: 'i3', source: 'legacy_unknown', item_key: R.intakeItemKey('legacy_unknown', 'https://legacy.example/post') },
  { id: 'i4', source: 'competitor_gap', item_key: R.intakeItemKey('competitor_gap', 'https://t.co/sample') },
]);
const sources = (items) => Object.fromEntries(items.map((r) => [r.id, r.source]));

describe('frozen literals', () => {
  test('LINK_SOURCES == services/seo/link-registry.js (ai_citation last)', () => {
    expect(arrayLiteral(src, 'LINK_SOURCES')).toEqual([...R.LINK_SOURCES]);
  });
  test('LINK_SOURCES_STEP1 == the 13-value set 20260830000021 created the intake CHECK with', () => {
    expect(arrayLiteral(src, 'LINK_SOURCES_STEP1')).toEqual(arrayLiteral(fs.readFileSync(STEP2, 'utf8'), 'LINK_SOURCES'));
  });
  test('ITEM_KEY_RE is the `${source}:` prefix intakeItemKey builds for ai_citation, anchored', () => {
    expect(stringLiteral('ITEM_KEY_RE')).toBe('^ai_citation:');
    expect(R.intakeItemKey('ai_citation', 'https://bit.ly/x').startsWith('ai_citation:')).toBe(true);
  });
  test('the migration requires no service module', () => {
    expect(src).not.toMatch(/require\(/);
  });
});

test('the old CHECK really rejects ai_citation (the runtime failure this fixes)', async () => {
  const items = [];
  const knex = fakeKnex(items);
  items.push({ id: 'new', source: 'ai_citation', item_key: 'ai_citation:bit.ly/x' });
  await expect(knex('seo_link_intake_items').where({ id: 'new' }).update({})).rejects.toThrow(/violated/);
});

test('up() on a forward deploy: DROP then ADD the widened CHECK, and the restore changes no row', async () => {
  const items = seedItems().map((r) => (r.source === 'ai_citation' ? { ...r, source: 'competitor_gap' } : r));
  const before = JSON.parse(JSON.stringify(items));
  const knex = fakeKnex(items);
  await migration.up(knex);
  const sqls = knex._state.raws.map((r) => r.sql);
  expect(sqls[0]).toBe('ALTER TABLE seo_link_intake_items DROP CONSTRAINT IF EXISTS seo_link_intake_items_source_check');
  expect(sqls[1]).toMatch(/^ALTER TABLE seo_link_intake_items ADD CONSTRAINT seo_link_intake_items_source_check CHECK \(source IN \('owner_seed'.*'legacy_unknown', 'ai_citation'\)\)$/);
  expect(sqls[2]).toMatch(/^UPDATE seo_link_intake_items SET source = 'ai_citation'/);
  expect(knex._state.raws[2].bindings).toEqual(['^ai_citation:']);
  expect(knex._state.check).toContain('ai_citation');
  expect(items).toEqual(before);
});

test('down() relabels ai_citation rows BEFORE narrowing, so the narrow never aborts', async () => {
  const items = seedItems();
  const knex = fakeKnex(items, { check: [...R.LINK_SOURCES] });
  await expect(migration.down(knex)).resolves.toBeUndefined();
  expect(sources(items)).toEqual({ i1: 'legacy_unknown', i2: 'legacy_unknown', i3: 'legacy_unknown', i4: 'competitor_gap' });
  expect(knex._state.check).not.toContain('ai_citation');
  // item_key is never rewritten — it is what up() restores by
  expect(items.map((r) => r.item_key)).toEqual(seedItems().map((r) => r.item_key));
});

test('rollback + reapply restores exactly the ai_citation intake rows, nothing else', async () => {
  const items = seedItems();
  const knex = fakeKnex(items, { check: [...R.LINK_SOURCES] });
  await migration.down(knex);
  await migration.up(knex);
  expect(sources(items)).toEqual({ i1: 'ai_citation', i2: 'ai_citation', i3: 'legacy_unknown', i4: 'competitor_gap' });
  expect(knex._state.check).toContain('ai_citation');
});
