// decision_reviews.provider migration: the unique key gains the provider so a
// second provider keeps its own row per subject and question (Codex r1, #5546).
const migration = require('../models/migrations/20261002010000_decision_reviews_provider');
const { DECISION_PROVIDERS } = require('../services/typed-decisions/packages');

function buildKnex({ table = true, column = false, otherProviderRow = null, ledger = [] } = {}) {
  const state = { raw: [], ops: [], wheres: [], tables: [] };
  const t = {
    string: jest.fn((...a) => { state.ops.push(['string', ...a]); return t; }),
    notNullable: jest.fn(() => { state.ops.push(['notNullable']); return t; }),
    defaultTo: jest.fn((v) => { state.ops.push(['defaultTo', v]); return t; }),
    dropColumn: jest.fn((...a) => { state.ops.push(['dropColumn', ...a]); }),
  };
  const q = {
    whereNot: jest.fn((w) => { state.wheres.push(['whereNot', w]); return q; }),
    first: jest.fn(async () => otherProviderRow),
  };
  const ledgerQuery = {
    whereIn: jest.fn((col, names) => { state.wheres.push(['whereIn', col, names]); return ledgerQuery; }),
    select: jest.fn(async () => ledger),
  };
  const knex = jest.fn((name) => { state.tables.push(name); return name === 'knex_migrations' ? ledgerQuery : q; });
  knex.schema = {
    hasTable: jest.fn(async () => table),
    hasColumn: jest.fn(async () => column),
    alterTable: jest.fn(async (_name, fn) => fn(t)),
  };
  knex.raw = jest.fn(async (sql) => { state.raw.push(sql); });
  return { knex, state };
}

describe('decision_reviews provider migration', () => {
  test('up adds a NOT NULL provider defaulting to typesafe, the closed CHECK, and swaps the unique key new-before-old', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.ops).toEqual([['string', 'provider', 30], ['notNullable'], ['defaultTo', 'typesafe']]);
    expect(state.raw.find((s) => /ADD CONSTRAINT decision_reviews_provider_check/.test(s))).toMatch(/CHECK \(provider IN \('typesafe', 'cloudflare'\)\)/);
    const addNew = state.raw.findIndex((s) => /ADD CONSTRAINT decision_reviews_provider_subject_question_uniq UNIQUE \(capability, package_id, provider, subject_type, subject_id, question_id\)/.test(s));
    const dropOld = state.raw.findIndex((s) => /DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_uniq$/.test(s));
    expect(addNew).toBeGreaterThan(-1);
    expect(dropOld).toBeGreaterThan(addNew); // never a moment without a unique key
  });

  test('up is re-runnable: an existing column is not re-added, constraints are dropped-if-exists then added', async () => {
    const { knex, state } = buildKnex({ column: true });
    await migration.up(knex);
    expect(state.ops).toEqual([]);
    expect(state.raw.filter((s) => /DROP CONSTRAINT IF EXISTS/.test(s))).toHaveLength(3);
  });

  test('the CHECK set is the registry set: a provider the code can write is one the table accepts', () => {
    expect(migration.PROVIDERS).toEqual([...DECISION_PROVIDERS]);
  });

  test('down restores the old key and drops the column, but refuses while another provider has rows', async () => {
    const clean = buildKnex({ column: true });
    await migration.down(clean.knex);
    expect(clean.state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    expect(clean.state.raw.find((s) => /ADD CONSTRAINT decision_reviews_subject_question_uniq UNIQUE \(capability, package_id, subject_type, subject_id, question_id\)/.test(s))).toBeTruthy();
    expect(clean.state.ops).toEqual([['dropColumn', 'provider']]);

    const mixed = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await expect(migration.down(mixed.knex)).rejects.toThrow(/rows from a provider other than typesafe/);
    expect(mixed.state.raw).toEqual([]);
    expect(mixed.state.ops).toEqual([]);
  });

  test('both directions no-op without the table; down no-ops without the column', async () => {
    const missing = buildKnex({ table: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.state.raw).toEqual([]);
    const noColumn = buildKnex({ column: false });
    await migration.down(noColumn.knex);
    expect(noColumn.state.raw).toEqual([]);
  });
});

describe('decision_reviews provider rollback lock (supersedes the first provider migration)', () => {
  const superseding = require('../models/migrations/20261002020000_decision_reviews_provider_rollback_lock');

  test('up re-asserts the first migration: same column, CHECK and key, so the two can never disagree', async () => {
    const { knex, state } = buildKnex();
    await superseding.up(knex);
    expect(state.ops).toEqual([['string', 'provider', 30], ['notNullable'], ['defaultTo', 'typesafe']]);
    expect(state.raw.some((s) => /ADD CONSTRAINT decision_reviews_provider_subject_question_uniq/.test(s))).toBe(true);
  });

  test('down locks the table BEFORE checking for another provider, then restores the old key and drops the column', async () => {
    const { knex, state } = buildKnex({ column: true });
    await superseding.down(knex);
    expect(state.raw[0]).toBe('LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE');
    expect(state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    expect(state.raw.find((s) => /ADD CONSTRAINT decision_reviews_subject_question_uniq UNIQUE/.test(s))).toBeTruthy();
    expect(state.ops).toEqual([['dropColumn', 'provider']]);
  });

  test('down refuses under the lock while another provider has rows: nothing is altered', async () => {
    const { knex, state } = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await expect(superseding.down(knex)).rejects.toThrow(/rows from a provider other than typesafe/);
    expect(state.raw).toEqual(['LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE']);
    expect(state.ops).toEqual([]);
  });

  test('after it has run, the superseded down finds no column and does nothing', async () => {
    const { knex, state } = buildKnex({ column: false });
    await migration.down(knex);
    await superseding.down(knex);
    expect(state.raw).toEqual([]);
  });
});


describe('decision_reviews provider rollback guard (20261002030000; owns only its comment and guard)', () => {
  const guard = require('../models/migrations/20261002030000_decision_reviews_provider_rollback_guard');

  test('up drops its guard if present and writes its comment; it never touches the column, CHECK or key', async () => {
    const { knex, state } = buildKnex({ column: true });
    await guard.up(knex);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_provider_rollback_guard',
      expect.stringMatching(/^COMMENT ON COLUMN decision_reviews\.provider IS 'Provider that answered/),
    ]);
    expect(state.ops).toEqual([]);
  });

  test('down locks the table, refuses while another provider has rows, and alters nothing', async () => {
    const { knex, state } = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await expect(guard.down(knex)).rejects.toThrow(/rows from a provider other than typesafe/);
    expect(state.raw).toEqual(['LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE']);
    expect(state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    expect(state.ops).toEqual([]);
  });

  test('down with only default-provider rows installs the guard CHECK and removes the comment; the column, CHECK and key stay', async () => {
    const { knex, state } = buildKnex({ column: true });
    await guard.down(knex);
    expect(state.raw).toEqual([
      'LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE',
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_provider_rollback_guard',
      "ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_provider_rollback_guard CHECK (provider = 'typesafe')",
      'COMMENT ON COLUMN decision_reviews.provider IS NULL',
    ]);
    expect(state.ops).toEqual([]);
    expect(state.raw.some((q) => /DROP COLUMN|subject_question_uniq/.test(q))).toBe(false);
  });

  test('both directions no-op without the table or the column', async () => {
    for (const opts of [{ table: false }, { column: false }]) {
      const { knex, state } = buildKnex(opts);
      await guard.up(knex); await guard.down(knex);
      expect(state.raw).toEqual([]);
      expect(state.ops).toEqual([]);
    }
  });
});

describe('decision_reviews provider rollback order (20261002040000; owns only the ledger check)', () => {
  const order = require('../models/migrations/20261002040000_decision_reviews_provider_rollback_order');

  test('up re-asserts the guard file: drops the guard if present and writes the comment, nothing else', async () => {
    const { knex, state } = buildKnex({ column: true });
    await order.up(knex);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_provider_rollback_guard',
      expect.stringMatching(/^COMMENT ON COLUMN decision_reviews\.provider IS 'Provider that answered/),
    ]);
    expect(state.ops).toEqual([]);
  });

  test('down refuses before touching anything while the two frozen files sit in different ledger batches, and names the one-line fix', async () => {
    const { knex, state } = buildKnex({ column: true, ledger: [{ name: order.FIRST_FILE, batch: 3 }, { name: order.LOCK_FILE, batch: 5 }] });
    await expect(order.down(knex)).rejects.toThrow(/recorded in batch 3 but .* in batch 5/);
    await expect(order.down(knex)).rejects.toThrow(`UPDATE knex_migrations SET batch = 5 WHERE name = '${order.FIRST_FILE}';`);
    expect(state.raw).toEqual([]);
    expect(state.ops).toEqual([]);
    expect(state.tables).toEqual(['knex_migrations', 'knex_migrations']);
    expect(state.wheres).toEqual([
      ['whereIn', 'name', [order.FIRST_FILE, order.LOCK_FILE]],
      ['whereIn', 'name', [order.FIRST_FILE, order.LOCK_FILE]],
    ]);
  });

  test('down reads the ledger and changes nothing when the files share a batch, or when either is not recorded (no batch rollback can reach it)', async () => {
    for (const ledger of [
      [{ name: order.FIRST_FILE, batch: 4 }, { name: order.LOCK_FILE, batch: 4 }],
      [{ name: order.FIRST_FILE, batch: '4' }, { name: order.LOCK_FILE, batch: 4 }],
      [{ name: order.LOCK_FILE, batch: 4 }],
      [{ name: order.FIRST_FILE, batch: 2 }],
      [],
    ]) {
      const { knex, state } = buildKnex({ column: true, ledger });
      await order.down(knex);
      expect(state.raw).toEqual([]);
      expect(state.ops).toEqual([]);
      expect(state.tables).toEqual(['knex_migrations']);
    }
  });

  test('both directions no-op without the table or the column', async () => {
    for (const opts of [{ table: false }, { column: false }]) {
      const { knex, state } = buildKnex(opts);
      await order.up(knex); await order.down(knex);
      expect(state.raw).toEqual([]);
      expect(state.tables).toEqual([]);
    }
  });

  test('the ledger names are the two frozen files on disk, and the guard file it re-asserts exists', () => {
    const fs = require('fs');
    const path = require('path');
    for (const name of [order.FIRST_FILE, order.LOCK_FILE, '20261002030000_decision_reviews_provider_rollback_guard.js']) {
      expect(fs.existsSync(path.join(__dirname, '..', 'models', 'migrations', name))).toBe(true);
    }
  });
});

describe('decision_reviews keeps the old unique key for this deployment (20261002050000; expand first, contract with the second writer)', () => {
  const keep = require('../models/migrations/20261002050000_decision_reviews_keep_old_unique');

  test('up puts the five-column unique back so a pre-provider process can still upsert on it', async () => {
    const { knex, state } = buildKnex({ column: true });
    await keep.up(knex);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_uniq',
      'ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_question_uniq UNIQUE (capability, package_id, subject_type, subject_id, question_id)',
    ]);
    expect(state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    expect(state.ops).toEqual([]);
  });

  test('up restores nothing when another provider already has rows: the old key cannot hold them', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { knex, state } = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await keep.up(knex);
    expect(state.raw).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/old unique key is not restored/));
    warn.mockRestore();
  });

  test('down drops the constraint again; both directions no-op without the table, up without the column', async () => {
    const { knex, state } = buildKnex({ column: true });
    await keep.down(knex);
    expect(state.raw).toEqual(['ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_uniq']);
    for (const opts of [{ table: false }, { column: false }]) {
      const fresh = buildKnex(opts);
      await keep.up(fresh.knex);
      expect(fresh.state.raw).toEqual([]);
    }
    const noTable = buildKnex({ table: false });
    await keep.down(noTable.knex);
    expect(noTable.state.raw).toEqual([]);
  });
});

describe('decision_reviews legacy conflict target (20261002005000; sorts before the provider key so an arbiter exists at every commit)', () => {
  const legacy = require('../models/migrations/20261002005000_decision_reviews_legacy_conflict_target');
  const fs = require('fs');
  const path = require('path');

  test('up adds a second five-column unique under its own name, before the provider column exists', async () => {
    const { knex, state } = buildKnex({ column: false });
    await legacy.up(knex);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_legacy_uniq',
      'ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_question_legacy_uniq UNIQUE (capability, package_id, subject_type, subject_id, question_id)',
    ]);
    expect(state.wheres).toEqual([]); // no provider column yet: nothing to check
  });

  test('on a database that already ran the later files it still adds the key while only the default provider has rows, and skips with a warning otherwise', async () => {
    const clean = buildKnex({ column: true });
    await legacy.up(clean.knex);
    expect(clean.state.raw).toHaveLength(2);
    expect(clean.state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mixed = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await legacy.up(mixed.knex);
    expect(mixed.state.raw).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/legacy conflict target is not added/));
    warn.mockRestore();
  });

  test('down drops only its own constraint; both directions no-op without the table', async () => {
    const { knex, state } = buildKnex({ column: true });
    await legacy.down(knex);
    expect(state.raw).toEqual(['ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_legacy_uniq']);
    const none = buildKnex({ table: false });
    await legacy.up(none.knex); await legacy.down(none.knex);
    expect(none.state.raw).toEqual([]);
  });

  test('it sorts before the frozen provider migration, so it runs first in the same batch', () => {
    const names = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((n) => n.includes('decision_reviews_')).sort();
    expect(names.indexOf('20261002005000_decision_reviews_legacy_conflict_target.js')).toBeLessThan(names.indexOf('20261002010000_decision_reviews_provider.js'));
    expect(names.indexOf('20261002005000_decision_reviews_legacy_conflict_target.js')).toBeGreaterThan(-1);
  });
});


describe('decision_reviews contract step (20261002200000; the second writer ships, both five-column keys go)', () => {
  const contract = require('../models/migrations/20261002200000_decision_reviews_drop_single_provider_keys');
  const FIVE = '(capability, package_id, subject_type, subject_id, question_id)';

  test('up drops both single-provider keys and nothing else; the provider key stays', async () => {
    const { knex, state } = buildKnex({ column: true });
    await contract.up(knex);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_uniq',
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_legacy_uniq',
    ]);
    expect(state.raw.join('\n')).not.toMatch(/provider_subject_question_uniq/);
  });

  test('down restores both while only Jev has rows', async () => {
    const { knex, state } = buildKnex({ column: true });
    await contract.down(knex);
    expect(state.wheres).toEqual([['whereNot', { provider: 'typesafe' }]]);
    expect(state.raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_legacy_uniq',
      `ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_question_legacy_uniq UNIQUE ${FIVE}`,
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_question_uniq',
      `ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_question_uniq UNIQUE ${FIVE}`,
    ]);
  });

  test('down refuses, touching nothing, while another provider has rows; both directions no-op without the table', async () => {
    const { knex, state } = buildKnex({ column: true, otherProviderRow: { id: 'r1' } });
    await expect(contract.down(knex)).rejects.toThrow(/holds rows from a provider other than typesafe/);
    expect(state.raw).toEqual([]);
    const none = buildKnex({ table: false });
    await contract.up(none.knex); await contract.down(none.knex);
    expect(none.state.raw).toEqual([]);
  });
});
