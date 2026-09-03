/**
 * 20260903000010 — Backlink Manager v2 step 4a (authority policy) migration.
 * Source-reading + fake-knex: the frozen enum literals equal the service enums
 * (drift ⇒ a NEW migration, never an edit here), the policy row is created with
 * the §6.2 defaults and seeded exactly once (ON CONFLICT DO NOTHING — an
 * admin-edited row is never overwritten), the audit table lands, the
 * placement-authorities level CHECK is swapped to include OWNER_INPUT_REQUIRED,
 * idempotence in both directions, and down() restores the step-1 set.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260903000010_link_authority_policy_step4a.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');
const P = require('../services/seo/link-authority-policy');

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

function fakeKnex({ existing = [] } = {}) {
  const raws = [];
  const created = {};
  const dropped = [];
  const table = (cb) => {
    const cols = [];
    const t = new Proxy({}, {
      get: (_, method) => (...args) => {
        const col = { method, args, mods: [] };
        cols.push(col);
        const chain = new Proxy({}, { get: (__, mod) => (...margs) => { col.mods.push([mod, margs]); return chain; } });
        return chain;
      },
    });
    cb(t);
    return cols;
  };
  const knex = Object.assign(jest.fn(), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
    fn: { now: () => 'now()' },
    schema: {
      hasTable: jest.fn(async (name) => existing.includes(name)),
      createTable: jest.fn(async (name, cb) => { created[name] = table(cb); }),
      dropTableIfExists: jest.fn(async (name) => { dropped.push(name); }),
    },
  });
  knex._raws = raws; knex._created = created; knex._dropped = dropped;
  return knex;
}

describe('frozen enum literals == service enums', () => {
  test('AUTHORITY_LEVELS (the full current set, OWNER_INPUT_REQUIRED last)', () => {
    expect(literal('AUTHORITY_LEVELS')).toEqual([...R.AUTHORITY_LEVELS]);
    expect(literal('AUTHORITY_LEVELS').slice(-1)).toEqual(['OWNER_INPUT_REQUIRED']);
  });
  test('ATTEMPT_PROVIDERS', () => {
    expect(literal('ATTEMPT_PROVIDERS')).toEqual([...R.ATTEMPT_PROVIDERS]);
  });
  test('the migration requires no service module', () => {
    expect(src).not.toMatch(/require\(/);
  });
});

describe('up()', () => {
  test('creates the policy row with the §6.2 defaults, seeds it once, creates the audit table, swaps the level CHECK', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const policy = knex._created.seo_link_policy;
    expect(policy).toBeDefined();
    const byName = Object.fromEntries(policy.map((c) => [c.args[0], c]));
    // every service field is a column; defaults match the service's shipped defaults
    for (const name of P.POLICY_FIELD_NAMES) {
      expect(byName[name]).toBeDefined();
      const def = byName[name].mods.find(([m]) => m === 'defaultTo');
      const spec = P.POLICY_FIELDS[name];
      if (spec.default === null) { expect(def).toBeUndefined(); expect(byName[name].mods.find(([m]) => m === 'notNullable')).toBeUndefined(); }
      else { expect(def[1][0]).toBe(spec.default); expect(byName[name].mods.find(([m]) => m === 'notNullable')).toBeDefined(); }
    }
    expect(byName.id.method).toBe('integer');
    expect(knex._raws.some((r) => r.includes('seo_link_policy_singleton_check') && r.includes('id = 1'))).toBe(true);
    expect(knex._raws.some((r) => r.includes('seo_link_policy_preferred_provider_check') && r.includes("'deterministic_runner'"))).toBe(true);
    expect(knex._raws).toContain('INSERT INTO seo_link_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    expect(knex._created.seo_link_policy_audit.map((c) => c.args[0])).toEqual(expect.arrayContaining(['field', 'old_value', 'new_value', 'changed_by', 'changed_at']));
    const drop = knex._raws.findIndex((r) => r.includes('DROP CONSTRAINT IF EXISTS seo_link_placement_authorities_level_check'));
    const add = knex._raws.findIndex((r) => r.includes('ADD CONSTRAINT seo_link_placement_authorities_level_check'));
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(knex._raws[add]).toContain("'OWNER_INPUT_REQUIRED'");
  });
  test('idempotent: existing tables are not recreated, the seed and CHECK swap still run', async () => {
    const knex = fakeKnex({ existing: ['seo_link_policy', 'seo_link_policy_audit'] });
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex._raws).toContain('INSERT INTO seo_link_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    expect(knex._raws.filter((r) => r.includes('seo_link_placement_authorities_level_check'))).toHaveLength(2);
  });
});

describe('down()', () => {
  test('restores the step-1 level set and drops both tables', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    const add = knex._raws.find((r) => r.includes('ADD CONSTRAINT seo_link_placement_authorities_level_check'));
    expect(add).not.toContain('OWNER_INPUT_REQUIRED');
    expect(add).toContain("'INVALID'");
    expect(knex._dropped).toEqual(['seo_link_policy_audit', 'seo_link_policy']);
  });
});
