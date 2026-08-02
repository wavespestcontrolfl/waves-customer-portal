const migration = require('../models/migrations/20260802000000_large_patch_token_standardization');
const speedzone = require('../models/migrations/20260802000001_speedzone_southern_turf_and_heat_limits');

const { RENAMES } = migration;

function mockKnex() {
  const calls = [];
  const proto = {
    _name: null,
    _match: null,
    whereRaw(sql, bindings) {
      if (sql.includes('LOWER(name)')) [this._name] = bindings;
      else [this._match] = bindings;
      return this;
    },
    whereNull() { return this; },
    where() { return this; },
    async update(row) {
      calls.push({ name: this._name, match: this._match, row });
      return 1;
    },
  };
  const knex = () => Object.create(proto);
  knex.schema = { hasTable: async () => true };
  return { knex, calls };
}

describe('large patch token standardization', () => {
  test('no row keeps a brown-patch spelling after the rename', () => {
    const leftovers = RENAMES.filter(([, , after]) =>
      after.some((t) => /brown patch/i.test(t)),
    ).map(([n]) => n);
    expect(leftovers).toEqual([]);
  });

  test('every row ends up with exactly one large-patch entry', () => {
    const wrong = RENAMES.filter(
      ([, , after]) => after.filter((t) => /large patch/i.test(t)).length !== 1,
    ).map(([n]) => n);
    expect(wrong).toEqual([]);
  });

  test('only the disease name changes — nothing else is added or dropped', () => {
    // Every other target must survive untouched, and the only permitted length
    // change is the dedupe on rows that carried BOTH names.
    RENAMES.forEach(([name, before, after]) => {
      const strip = (l) => l.filter((t) => !/brown patch|large patch/i.test(t));
      expect({ name, rest: strip(after) }).toEqual({ name, rest: strip(before) });
      const hadBoth =
        before.some((t) => /^brown patch$/i.test(t)) &&
        before.some((t) => /^large patch$/i.test(t));
      expect({ name, len: after.length }).toEqual({
        name,
        len: hadBoth ? before.length - 1 : before.length,
      });
    });
  });

  test('relative order of the surviving targets is preserved', () => {
    RENAMES.forEach(([name, before, after]) => {
      const strip = (l) => l.filter((t) => !/brown patch|large patch/i.test(t));
      expect({ name, order: strip(after) }).toEqual({ name, order: strip(before) });
    });
  });

  test('up() matches the exact prior list and writes the renamed one', async () => {
    const { knex, calls } = mockKnex();
    await migration.up(knex);
    expect(calls).toHaveLength(RENAMES.length);
    calls.forEach((c, i) => {
      const [name, before, after] = RENAMES[i];
      expect(c.name).toBe(name);
      expect(c.match).toBe(JSON.stringify(before));
      expect(c.row.target_pests).toBe(JSON.stringify(after));
    });
  });

  test('down() restores the exact prior list', async () => {
    const { knex, calls } = mockKnex();
    await migration.down(knex);
    expect(calls).toHaveLength(RENAMES.length);
    calls.forEach((c, i) => {
      const [name, before, after] = RENAMES[i];
      expect(c.name).toBe(name);
      expect(c.match).toBe(JSON.stringify(after));
      expect(c.row.target_pests).toBe(JSON.stringify(before));
    });
  });

  test('no product appears twice', () => {
    const names = RENAMES.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('no source still produces the retired disease token', () => {
  const fs = require('fs');
  const path = require('path');

  // Renaming the catalog is pointless if a producer keeps emitting the old
  // spelling into NEW records. The recurring lawn template seed is the
  // dangerous one — it upserts on every re-run.
  const PRODUCERS = [
    '../scripts/seed-job-form-templates.js',
    '../services/project-types.js',
  ];

  test('lawn disease pickers offer "Large patch", never "Brown patch"', () => {
    const offenders = [];
    for (const rel of PRODUCERS) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      // Quoted exactly — "Brown patches" (a visual description of
      // discoloration, not the disease) is legitimate and must not trip this.
      if (/['"]Brown patch['"]/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the seed still offers the disease at all, under the new name', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../scripts/seed-job-form-templates.js'),
      'utf8',
    );
    expect(src).toMatch(/['"]Large patch['"]/);
    // The turf-colour option describes what the lawn LOOKS like and is a
    // separate concept — it stays.
    expect(src).toMatch(/['"]Brown patches['"]/);
  });
});

describe('SpeedZone Southern turf and heat limits', () => {
  test('records the label temperature window', async () => {
    const { knex, calls } = mockKnex();
    await speedzone.up(knex);
    const temps = calls.find((c) => c.row.max_temp_f !== undefined);
    expect(temps.row.max_temp_f).toBe(85);
    expect(temps.row.min_temp_f).toBe(50);
    expect(temps.row.heat_restrictions).toBe(speedzone.HEAT_RESTRICTIONS);
  });

  test('keeps Floratam excluded and adds the Bitterblue the label also names', () => {
    expect(speedzone.NEXT_EXCLUDED).toContain('floratam');
    expect(speedzone.NEXT_EXCLUDED).toContain('bitterblue');
    // The unknown-cultivar guard must survive: an unidentified St. Augustine
    // could be Floratam, so it stays excluded too.
    expect(speedzone.NEXT_EXCLUDED).toContain('st_augustine_unknown_cultivar');
  });

  test('the restriction text names the cultivars and both temperature bounds', () => {
    const t = speedzone.HEAT_RESTRICTIONS;
    expect(t).toMatch(/Floratam/);
    expect(t).toMatch(/Bitterblue/);
    expect(t).toMatch(/85/);
    expect(t).toMatch(/50/);
    expect(t).toMatch(/spring green-up/i);
  });
});
