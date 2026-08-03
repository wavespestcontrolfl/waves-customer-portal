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

  test('down() touches nothing — matching a value is not provenance', async () => {
    // A value-matched rollback cannot tell a row up() rewrote from one that
    // already held the normalized value because an admin standardized it by
    // hand — up() skips the latter, and reverting it would push a correct edit
    // back to the retired spelling.
    const { knex, calls } = mockKnex();
    await migration.down(knex);
    expect(calls).toEqual([]);
  });

  test('none of these migrations reverts by value', async () => {
    // Same failure mode across the set: the SpeedZone catalog migration would
    // strip a hand-entered cultivar exclusion, and the gate migration would
    // re-open the off-label 86-90°F band. All three are no-ops.
    const gate = require('../models/migrations/20260802000002_speedzone_heat_gate_to_label_limit');
    for (const m of [migration, speedzone, gate]) {
      const { knex, calls } = mockKnex();
      await m.down(knex);
      expect(calls).toEqual([]);
    }
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

describe('raw SQL compiles — jsonb ? operator is escaped', () => {
  // Knex reads a bare `?` as a binding placeholder, so the jsonb existence
  // operator has to be written `\\?`. Get it wrong and the query fails while
  // COMPILING — which means the migration throws, and since migrations run
  // pre-deploy, the deploy dies with it. A mocked knex cannot catch this
  // because nothing compiles SQL; this builds real query objects instead.
  const knexLib = require('knex');
  const k = knexLib({ client: 'pg' });
  afterAll(async () => { await k.destroy(); });

  const ESCAPED = "NOT (COALESCE(gates, '{}'::jsonb) \\? 'minTempF')";

  // NOTE: toSQL() alone cannot tell these apart — it leaves the escape
  // unprocessed. The substitution happens in toNative(), which is where the
  // driver-bound statement is produced, so that is what these assert.
  const native = (pred) =>
    k('lawn_protocol_products').whereRaw(pred).update({ a: 1 }).toSQL().toNative();

  test('the escaped form keeps ? as the jsonb operator', () => {
    const n = native(ESCAPED);
    expect(n.sql).toContain("? 'minTempF'");
    // Only the update value is bound.
    expect(n.bindings).toEqual([1]);
  });

  test('the UNescaped form corrupts the statement — the escape is load-bearing', () => {
    const bare = "NOT (COALESCE(gates, '{}'::jsonb) ? 'minTempF')";
    const n = native(bare);
    // The operator is consumed as placeholder $2 while only one binding
    // exists, so Postgres rejects the statement: "bind message supplies 1
    // parameters, but prepared statement requires 2".
    expect(n.sql).toContain("$2 'minTempF'");
    expect(n.bindings).toHaveLength(1);
  });

  test('no migration in this change ships a bare jsonb ? operator', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '../models/migrations');
    const mine = fs.readdirSync(dir).filter((f) => f.startsWith('202608020000'));
    expect(mine.length).toBeGreaterThan(0);
    const offenders = mine.filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // A `?` directly after a jsonb expression and before a quoted key,
      // without the backslash escape.
      return /jsonb\)\s*\?\s*'/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe('deployed lawn template rename', () => {
  const tpl = require('../models/migrations/20260802000003_lawn_visit_template_large_patch');

  const sections = () => ([
    {
      id: 'assessment',
      fields: [
        // A different field that also mentions brown — must NOT be touched.
        { key: 'turf_color', options: ['Dark green — healthy', 'Brown patches'] },
        { key: 'disease_symptoms', options: ['None', 'Brown patch', 'Dollar spot'] },
      ],
    },
    { id: 'other', fields: [{ key: 'notes', type: 'text' }] },
  ]);

  test('renames only the disease option, in only that field', () => {
    const { sections: out, changed } = tpl.renameOption(sections(), tpl.OLD, tpl.NEW);
    expect(changed).toBe(true);
    expect(out[0].fields[1].options).toEqual(['None', 'Large patch', 'Dollar spot']);
    // The turf-colour option describes appearance, not diagnosis — untouched.
    expect(out[0].fields[0].options).toEqual(['Dark green — healthy', 'Brown patches']);
    // Unrelated sections and fields survive.
    expect(out[1]).toEqual(sections()[1]);
  });

  test('reports no change when the template was already renamed', () => {
    const already = [{ id: 'a', fields: [{ key: 'disease_symptoms', options: ['Large patch'] }] }];
    expect(tpl.renameOption(already, tpl.OLD, tpl.NEW).changed).toBe(false);
  });

  test('tolerates templates with no fields or odd shapes', () => {
    expect(tpl.renameOption(null, tpl.OLD, tpl.NEW).changed).toBe(false);
    expect(tpl.renameOption([{ id: 'x' }], tpl.OLD, tpl.NEW).changed).toBe(false);
    expect(tpl.renameOption([{ fields: [{ key: 'disease_symptoms' }] }], tpl.OLD, tpl.NEW).changed)
      .toBe(false);
  });

  test('down() touches nothing', async () => {
    const { knex, calls } = mockKnex();
    await tpl.down(knex);
    expect(calls).toEqual([]);
  });
});

describe('SpeedZone Southern turf and heat limits', () => {
  test('records the label temperature window', async () => {
    // Written across independent statements so a partially populated row still
    // gets its missing fields — see the off-label-ceiling test below.
    const { knex, calls } = mockKnex();
    await speedzone.up(knex);
    const written = Object.assign({}, ...calls.map((c) => c.row));
    expect(written.max_temp_f).toBe(85);
    expect(written.min_temp_f).toBe(50);
    expect(written.heat_restrictions).toBe(speedzone.HEAT_RESTRICTIONS);
  });

  test('keeps Floratam excluded and adds the Bitterblue the label also names', () => {
    expect(speedzone.NEXT_EXCLUDED).toContain('floratam');
    expect(speedzone.NEXT_EXCLUDED).toContain('bitterblue');
    // The unknown-cultivar guard must survive: an unidentified St. Augustine
    // could be Floratam, so it stays excluded too.
    expect(speedzone.NEXT_EXCLUDED).toContain('st_augustine_unknown_cultivar');
  });

  test('corrects an off-label ceiling instead of skipping the row', async () => {
    // Requiring all three fields to be NULL meant a row already holding
    // max_temp_f = 90 — the off-label ceiling this migration exists to remove
    // — was skipped and kept it. Each field is now handled independently.
    const { knex, calls } = mockKnex();
    await speedzone.up(knex);
    const ceiling = calls.find((c) => c.row.max_temp_f !== undefined);
    const floor = calls.find((c) => c.row.min_temp_f !== undefined);
    const prose = calls.find((c) => c.row.heat_restrictions !== undefined);
    // Three separate statements, not one all-or-nothing update.
    expect(ceiling).toBeDefined();
    expect(floor).toBeDefined();
    expect(prose).toBeDefined();
    expect(ceiling).not.toBe(floor);
    expect(ceiling.row.max_temp_f).toBe(85);
    expect(floor.row.min_temp_f).toBe(50);
    // The prose write must NOT also carry the numbers — that would recreate
    // the all-or-nothing coupling.
    expect(prose.row.max_temp_f).toBeUndefined();
    expect(prose.row.min_temp_f).toBeUndefined();
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
