/**
 * 20261023110000: the rollback guard for the misting discount rules. down() runs before the frozen 20261023100000 down(): an
 * operator-edited rule loses the insertion marker (and survives the frozen removeMarked), an unedited rule is untouched (and is
 * removed by the frozen down() as before), and with no rows it is a no-op.
 */
const frozen = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
const guard = require('../models/migrations/20261023110000_mosquito_misting_discount_rules_rollback_guard');

const KEYS = ['mosquito_misting_install', 'mosquito_misting_service', 'mosquito_misting_refill'];

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        filters.push({ raw: { col: m[1], val: bindings[0] } });
        return q;
      },
      first: async () => { const hit = rowsNow().find(rowMatch); return hit ? { ...hit } : undefined; },
      select: async () => rowsNow().filter(rowMatch).map((r) => ({ ...r })),
      pluck: async (col) => rowsNow().filter(rowMatch).map((r) => r[col]),
      columnInfo: async () => Object.fromEntries((db.__columns?.[table] || Object.keys(rowsNow()[0] || {})).map((c) => [c, {}])),
      update: async (patch) => { const hits = rowsNow().filter(rowMatch); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(rowMatch); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(stored);
        const p = Promise.resolve([1]);
        p.returning = async (col) => [{ [col]: stored[col] }];
        p.onConflict = () => ({ ignore: async () => [1] });
        return p;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  knex.fn = { now: () => 'now()' };
  return knex;
}

const ALL_SERVICE_COLUMNS = ['id', ...new Set(frozen.SERVICES.flatMap((s) => Object.keys(s)))];
const emptyDb = () => ({
  __columns: { services: ALL_SERVICE_COLUMNS },
  services: [], service_completion_profiles: [], service_taxability: [], service_discount_rules: [], system_settings: [],
  service_records: [], scheduled_services: [], service_addons: [], service_package_items: [], scheduled_service_addons: [], discounts: [], leads: [],
});
const rule = (db, key) => db.service_discount_rules.find((r) => r.service_key === key);

async function seeded() {
  const db = emptyDb();
  await frozen.up(fakeKnex(db));
  return db;
}

describe('up()', () => {
  test('is a documented no-op: it writes nothing', async () => {
    const db = await seeded();
    const before = JSON.stringify(db);
    await guard.up(fakeKnex(db));
    expect(JSON.stringify(db)).toBe(before);
    await guard.up();
  });
});

describe('the seeded values mirror what the frozen migration wrote', () => {
  test('every seeded rule equals SEEDED_RULE on the pricing fields, and none counts as edited', async () => {
    const db = await seeded();
    expect(db.service_discount_rules.map((r) => r.service_key).sort()).toEqual([...KEYS].sort());
    for (const row of db.service_discount_rules) {
      for (const [field, value] of Object.entries(guard.SEEDED_RULE)) expect(row[field]).toBe(value);
      expect(row.notes).toContain(frozen.MARKER);
    }
  });
});

describe('down()', () => {
  test('an operator-edited rule loses the marker, keeps the rest of its notes, and survives the frozen down()', async () => {
    const db = await seeded();
    // the admin discount-rule PUT changes a pricing field and leaves notes alone
    rule(db, 'mosquito_misting_service').max_discount_pct = 5;
    const originalNotes = rule(db, 'mosquito_misting_service').notes;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await guard.down(fakeKnex(db));
    const edited = rule(db, 'mosquito_misting_service');
    expect(edited.notes).not.toContain(frozen.MARKER);
    expect(edited.notes).toContain(originalNotes.replace(frozen.MARKER, '').trim());
    expect(edited.notes).toMatch(/retained on rollback: operator-edited$/);
    await frozen.down(fakeKnex(db));
    // the edited rule survives; the two untouched rules and every service row are removed as before
    expect(db.service_discount_rules.map((r) => r.service_key)).toEqual(['mosquito_misting_service']);
    expect(rule(db, 'mosquito_misting_service')).toMatchObject({ max_discount_pct: 5 });
    expect(db.services).toEqual([]);
    expect(db.service_completion_profiles).toEqual([]);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/mosquito_misting_service was edited by an operator/);
    warn.mockRestore();
  });

  test('each pricing field counts as an edit', async () => {
    for (const patch of [{ tier_qualifier: true }, { exclude_from_pct_discount: false }, { max_discount_pct: 3 }, { flat_credit: 25 }, { flat_credit_min_tier: 'gold' }]) {
      const db = await seeded();
      Object.assign(rule(db, 'mosquito_misting_install'), patch);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await guard.down(fakeKnex(db));
      warn.mockRestore();
      expect(rule(db, 'mosquito_misting_install').notes).not.toContain(frozen.MARKER);
      expect(rule(db, 'mosquito_misting_refill').notes).toContain(frozen.MARKER);
    }
  });

  test('an unedited rule is untouched by the guard and removed by the frozen down() as before', async () => {
    const db = await seeded();
    const before = JSON.stringify(db.service_discount_rules);
    await guard.down(fakeKnex(db));
    expect(JSON.stringify(db.service_discount_rules)).toBe(before);
    await frozen.down(fakeKnex(db));
    expect(db.service_discount_rules).toEqual([]);
    expect(db.services).toEqual([]);
  });

  test('a rule an admin already replaced (no marker) is left exactly as it is', async () => {
    const db = await seeded();
    const mine = rule(db, 'mosquito_misting_refill');
    mine.notes = 'admin note';
    mine.flat_credit = 10;
    await guard.down(fakeKnex(db));
    expect(rule(db, 'mosquito_misting_refill')).toMatchObject({ notes: 'admin note', flat_credit: 10 });
  });

  test('re-running the guard is idempotent; no rows, no table, and absent services are no-ops', async () => {
    const db = await seeded();
    rule(db, 'mosquito_misting_service').flat_credit = 10;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await guard.down(fakeKnex(db));
    const once = rule(db, 'mosquito_misting_service').notes;
    await guard.down(fakeKnex(db));
    expect(rule(db, 'mosquito_misting_service').notes).toBe(once);
    warn.mockRestore();
    const empty = emptyDb();
    await expect(guard.down(fakeKnex(empty))).resolves.toBeUndefined();
    expect(empty.service_discount_rules).toEqual([]);
    const noTable = emptyDb();
    await expect(guard.down(fakeKnex(noTable, { missingTables: ['service_discount_rules'] }))).resolves.toBeUndefined();
  });

  test('without the guard the frozen down() would delete the edit (the bug this migration closes)', async () => {
    const db = await seeded();
    rule(db, 'mosquito_misting_service').max_discount_pct = 5;
    await frozen.down(fakeKnex(db));
    expect(db.service_discount_rules).toEqual([]);
  });

  test('the guard sorts after the frozen migration, so a rollback runs it first', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((f) => f.startsWith('20261023')).sort();
    expect(files.indexOf('20261023110000_mosquito_misting_discount_rules_rollback_guard.js'))
      .toBeGreaterThan(files.indexOf('20261023100000_mosquito_misting_catalog_rows.js'));
    // no foreign key ties a rule to a service row: the rule is keyed by a plain unique string
    const pricing = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260414000011_pricing_config.js'), 'utf8');
    expect(pricing).toMatch(/createTable\('service_discount_rules'[\s\S]*?t\.string\('service_key', 50\)\.notNullable\(\)\.unique\(\)/);
    expect(pricing.slice(pricing.indexOf("createTable('service_discount_rules'"), pricing.indexOf("createTable('service_discount_rules'") + 700)).not.toMatch(/references\(/);
  });
});
