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

  test('down() touches nothing at all', async () => {
    // Reverting by value is unsafe: matching the list does not prove this
    // migration wrote it. up() only fills EMPTY fields, so a row that already
    // held that exact list was SKIPPED by up() — and a value-matching down()
    // would then erase a curated list this migration never owned. Nothing here
    // is destructive, so the correct reversal is to do nothing.
    const { knex, calls } = mockKnex();
    await migration.down(knex);
    expect(calls).toEqual([]);
  });

  test('never introduces a target that nothing controls', () => {
    // Ganoderma butt rot and Thielaviopsis trunk rot have no chemical control
    // (UF/IFAS), so no product may claim them.
    const banned = /ganoderma|thielaviopsis/i;
    const offenders = FILLS.filter(([, targets]) => targets.some((t) => banned.test(t)));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  test('keeps ornamental-only root rot off the turf oomycete fills', () => {
    // The classifier reads ANY "pythium" target as turf, so "Pythium root rot"
    // on a turf fungicide would put a root-rot claim on a lawn report. These
    // labels group root rot under their ornamental/nursery directions; the
    // turf directions are blight and damping-off (pre-push P1).
    const oomycete = FILLS.filter(([n]) => /Banol|Subdue Maxx/i.test(n));
    expect(oomycete).toHaveLength(2);
    oomycete.forEach(([, targets]) => {
      expect(targets.some((t) => /root rot/i.test(t))).toBe(false);
      expect(targets).toContain('Pythium blight');
      expect(targets).toContain('Pythium damping-off');
    });
  });

  test('Subdue Maxx carries the yellow tuft its turf rate covers', () => {
    // The Syngenta turf directions group "Pythium blight / Pythium damping-off
    // / Yellow tuft (downy mildew)" under one rate. Asserted on the persisted
    // fill, not just on the classifier — classifying a target the migration
    // never writes is a capability nothing uses.
    const [, subdue] = FILLS.find(([n]) => /Subdue Maxx/i.test(n));
    expect(subdue).toContain('Yellow tuft (downy mildew)');
    // Within the 3-target prefill cap, so a lawn visit actually sees it.
    expect(subdue.slice(0, 3)).toContain('Yellow tuft (downy mildew)');
    // Banol is propamocarb — Pythium only, no yellow tuft.
    const [, banol] = FILLS.find(([n]) => /Banol/i.test(n));
    expect(banol.some((t) => /yellow tuft/i.test(t))).toBe(false);
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
