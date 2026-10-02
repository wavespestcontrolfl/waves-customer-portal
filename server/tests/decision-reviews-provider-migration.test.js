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
