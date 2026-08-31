/**
 * 20260831000030 — Backlink Manager v2 step 3 (path investigator) migration.
 * Source-reading + fake-knex: the frozen enum literals equal the service enums
 * (drift ⇒ a NEW migration, never an edit here), the two §3.2 payment-input
 * columns land with their CHECKs (currency NOT NULL DEFAULT 'unknown';
 * fee_scope nullable), idempotence in both directions, and down() drops both.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260831000030_backlink_investigator_step3.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

function fakeKnex({ existing = ['seo_link_acquisition_paths'], pathColumns = {} } = {}) {
  const raws = [];
  const altered = {};
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
  const knex = Object.assign(jest.fn(() => ({ columnInfo: async () => pathColumns })), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
    schema: {
      hasTable: jest.fn(async (name) => existing.includes(name)),
      alterTable: jest.fn(async (name, cb) => { altered[name] = [...(altered[name] || []), ...table(cb)]; }),
    },
  });
  knex._raws = raws; knex._altered = altered;
  return knex;
}

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

const colOf = (cols, name) => cols.find((c) => c.args[0] === name);
const hasMod = (col, mod, args) => col.mods.some(([m, a]) => m === mod && (args === undefined || JSON.stringify(a) === JSON.stringify(args)));

describe('frozen enum literals == services/seo/link-registry.js', () => {
  test.each([['CURRENCIES'], ['FEE_SCOPES']])('%s', (name) => {
    expect(literal(name)).toEqual([...R[name]]);
  });
  test('the migration requires no service enum (literals are frozen at migration time)', () => {
    expect(src).not.toMatch(/require\(['"][^'"]*link-registry['"]\)/);
  });
});

describe('up()', () => {
  test('currency: string NOT NULL DEFAULT unknown + CHECK; fee_scope: nullable string + nullable CHECK', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const cols = knex._altered.seo_link_acquisition_paths;
    expect(cols.map((c) => [c.method, c.args[0]])).toEqual([['string', 'currency'], ['string', 'fee_scope']]);
    const currency = colOf(cols, 'currency');
    expect(hasMod(currency, 'notNullable')).toBe(true);
    expect(hasMod(currency, 'defaultTo', ['unknown'])).toBe(true);
    const feeScope = colOf(cols, 'fee_scope');
    expect(hasMod(feeScope, 'notNullable')).toBe(false);
    const raws = knex._raws;
    expect(raws).toEqual([
      "ALTER TABLE seo_link_acquisition_paths ADD CONSTRAINT seo_link_acquisition_paths_currency_check CHECK (currency IN ('USD', 'unknown', 'foreign'))",
      "ALTER TABLE seo_link_acquisition_paths ADD CONSTRAINT seo_link_acquisition_paths_fee_scope_check CHECK (fee_scope IS NULL OR fee_scope IN ('per_location', 'account_wide'))",
    ]);
  });

  test('idempotent: existing columns are not re-added and no CHECK is re-added', async () => {
    const knex = fakeKnex({ pathColumns: { currency: {}, fee_scope: {} } });
    await migration.up(knex);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex._raws).toEqual([]);
  });

  test('missing table (fresh DB mid-chain): no-op, never throws', async () => {
    const knex = fakeKnex({ existing: [] });
    await migration.up(knex);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex._raws).toEqual([]);
  });
});

describe('down()', () => {
  test('drops both columns, fee_scope first, IF EXISTS both ways', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex._raws).toEqual([
      'ALTER TABLE seo_link_acquisition_paths DROP COLUMN IF EXISTS fee_scope',
      'ALTER TABLE seo_link_acquisition_paths DROP COLUMN IF EXISTS currency',
    ]);
  });
});
