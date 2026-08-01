const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20260801200000_lawn_ts_label_target_ordering');

const { TARGET_REORDERS } = migration;

// The migration only rewrites a row whose target_pests is byte-for-byte what
// 20260723000001 wrote. If that source list is ever edited without updating
// `prev` here, every UPDATE quietly matches zero rows and the reorder never
// ships — the failure mode is silence, so it gets a test.
const SOURCE_MIGRATION = fs.readFileSync(
  path.join(__dirname, '../models/migrations/20260723000001_species_specific_target_prefill.js'),
  'utf8',
);

function mockKnex() {
  const updates = [];
  const query = {
    _name: null,
    _match: null,
    whereRaw(sql, bindings) {
      if (sql.includes('LOWER(name)')) [this._name] = bindings;
      else [this._match] = bindings;
      return this;
    },
    async update(row) {
      updates.push({ name: this._name, match: this._match, wrote: row.target_pests });
      return 1;
    },
  };
  const knex = () => Object.create(query);
  knex.schema = { hasTable: async () => true };
  return { knex, updates };
}

describe('lawn + tree & shrub label target ordering migration', () => {
  test('every prev list is still what the source migration writes', () => {
    // A name in this list means its `prev` no longer appears in the source
    // migration, so the UPDATE would match zero rows and ship nothing.
    const drifted = TARGET_REORDERS.filter(([, , prev]) => {
      // The source file stores each list as a JS array literal with single
      // quotes; compare content, not formatting.
      const literal = prev.map((t) => `'${t.replace(/'/g, "\\'")}'`).join(', ');
      return !SOURCE_MIGRATION.includes(`[${literal}]`);
    }).map(([name]) => name);
    expect(drifted).toEqual([]);
  });

  test('reorders without inventing or dropping targets, except where documented', () => {
    // Two entries deliberately change content rather than just order:
    // Tetrino gains the chinch bugs its label carries, and the Arborjet pair
    // names the SWFL whitefly instead of the generic one.
    const CONTENT_CHANGES = {
      'Tetrino Insecticide': { added: ['Southern chinch bugs'], removed: [] },
      'Arborjet Ima-Jet 10': { added: ['Ficus whitefly'], removed: ['Whiteflies'] },
      'Arborjet Ima-Jet Systemic Insecticide': {
        added: ['Ficus whitefly'],
        removed: ['Whiteflies'],
      },
    };

    const sets = TARGET_REORDERS.map(([name, next, prev]) => {
      const { added = [], removed = [] } = CONTENT_CHANGES[name] || {};
      return {
        name,
        got: [...next].sort(),
        want: [...prev.filter((t) => !removed.includes(t)), ...added].sort(),
        reordered: JSON.stringify(next) !== JSON.stringify(prev),
      };
    });
    expect(sets.filter((s) => JSON.stringify(s.got) !== JSON.stringify(s.want))).toEqual([]);
    // An entry whose order never changed does nothing — catch the dead weight.
    expect(sets.filter((s) => !s.reordered).map((s) => s.name)).toEqual([]);
  });

  test('puts southern chinch bugs first wherever the product controls them', () => {
    const buried = TARGET_REORDERS.filter(
      ([, next]) => next.includes('Southern chinch bugs') && next[0] !== 'Southern chinch bugs',
    ).map(([name]) => name);
    expect(buried).toEqual([]);
  });

  test('keeps every intended target inside the three-target prefill cap', () => {
    // MAX_LABEL_TARGET_PREFILL is 3 — anything past position 3 never reaches
    // the tech, which is the whole reason this migration exists.
    const MUST_SURVIVE = {
      'Acelepryn Xtra': 'Southern chinch bugs',
      'Acelepryn Insecticide': 'Tropical sod webworms',
      'Tetrino Insecticide': 'Southern chinch bugs',
      'Dylox 420 SL T&O Insecticide': 'Tropical sod webworms',
      'Pillar G Intrinsic': 'Gray leaf spot',
      'Arborjet Ima-Jet 10': 'Ficus whitefly',
    };
    const cut = TARGET_REORDERS.filter(
      ([name, next]) => MUST_SURVIVE[name] && !next.slice(0, 3).includes(MUST_SURVIVE[name]),
    ).map(([name]) => `${name} loses ${MUST_SURVIVE[name]}`);
    expect(cut).toEqual([]);
  });

  test('up() matches the exact prior list and writes the reordered one', async () => {
    const { knex, updates } = mockKnex();
    await migration.up(knex);

    expect(updates).toHaveLength(TARGET_REORDERS.length);
    updates.forEach((u, i) => {
      const [name, next, prev] = TARGET_REORDERS[i];
      expect(u.name).toBe(name);
      expect(u.match).toBe(JSON.stringify(prev));
      expect(u.wrote).toBe(JSON.stringify(next));
    });
  });

  test('down() reverts only rows still holding what up() wrote', async () => {
    const { knex, updates } = mockKnex();
    await migration.down(knex);

    expect(updates).toHaveLength(TARGET_REORDERS.length);
    updates.forEach((u, i) => {
      const [name, next, prev] = TARGET_REORDERS[i];
      expect(u.name).toBe(name);
      expect(u.match).toBe(JSON.stringify(next));
      expect(u.wrote).toBe(JSON.stringify(prev));
    });
  });

  test('no product appears twice', () => {
    const names = TARGET_REORDERS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});
