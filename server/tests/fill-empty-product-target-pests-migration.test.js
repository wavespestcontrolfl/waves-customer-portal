const migration = require('../models/migrations/20260801300000_fill_empty_product_target_pests');

const { FILLS } = migration;

function mockKnex() {
  const calls = [];
  const proto = {
    _name: null,
    _guard: null,
    _match: null,
    whereRaw(sql, bindings) {
      if (sql.includes('LOWER(name)')) [this._name] = bindings;
      else if (sql.includes('IS NULL')) this._guard = sql;
      else [this._match] = bindings;
      return this;
    },
    async update(row) {
      calls.push({
        name: this._name,
        guard: this._guard,
        match: this._match,
        wrote: row.target_pests,
      });
      return 1;
    },
  };
  const knex = () => Object.create(proto);
  knex.schema = { hasTable: async () => true };
  return { knex, calls };
}

describe('fill empty product target_pests migration', () => {
  test('every write is gated on the field being empty', async () => {
    // The whole point of this migration: it may ADD a target list, never
    // replace one. A previous attempt derived targets from the active
    // ingredient and overwrote curated lists, which turned Termidor SC into an
    // ant product. Any statement missing this guard is that bug returning.
    const { knex, calls } = mockKnex();
    await migration.up(knex);

    expect(calls).toHaveLength(FILLS.length);
    const ungated = calls.filter(
      (c) => !c.guard || !/target_pests IS NULL/.test(c.guard) || !/\[\]/.test(c.guard),
    );
    expect(ungated.map((c) => c.name)).toEqual([]);
  });

  test('writes the intended list for each product', async () => {
    const { knex, calls } = mockKnex();
    await migration.up(knex);
    calls.forEach((c, i) => {
      const [name, targets] = FILLS[i];
      expect(c.name).toBe(name);
      expect(c.wrote).toBe(JSON.stringify(targets));
    });
  });

  test('down() reverts only rows still holding exactly what up() wrote', async () => {
    const { knex, calls } = mockKnex();
    await migration.down(knex);
    expect(calls).toHaveLength(FILLS.length);
    calls.forEach((c, i) => {
      const [name, targets] = FILLS[i];
      expect(c.name).toBe(name);
      expect(c.match).toBe(JSON.stringify(targets));
      expect(c.wrote).toBeNull();
    });
  });

  test('never introduces a target that nothing controls', () => {
    // Ganoderma butt rot and Thielaviopsis trunk rot have no chemical control
    // (UF/IFAS), so no product may claim them.
    const banned = /ganoderma|thielaviopsis/i;
    const offenders = FILLS.filter(([, targets]) => targets.some((t) => banned.test(t)));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  test('no product is filled twice and no list is empty', () => {
    const names = FILLS.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect(FILLS.filter(([, t]) => !t.length).map(([n]) => n)).toEqual([]);
  });

  test('palm disease targets carry their preventive framing', () => {
    // Oxytetracycline is preventive — UF/IFAS PP163 has it repeated every 3-4
    // months on non-symptomatic palms, and once a palm is symptomatic it is
    // usually past saving. The chip must not read as a cure on a closed visit.
    const otc = FILLS.filter(([n]) => /Arbor OTC/i.test(n));
    expect(otc).toHaveLength(2);
    otc.forEach(([, targets]) => {
      expect(targets.every((t) => /preventive/i.test(t))).toBe(true);
    });
  });
});
