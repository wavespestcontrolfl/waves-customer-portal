// decision_reviews.provider migration: the unique key gains the provider so a
// second provider keeps its own row per subject and question (Codex r1, #5546).
const migration = require('../models/migrations/20261002010000_decision_reviews_provider');
const { DECISION_PROVIDERS } = require('../services/typed-decisions/packages');

function buildKnex({ table = true, column = false, otherProviderRow = null } = {}) {
  const state = { raw: [], ops: [], wheres: [] };
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
  const knex = jest.fn(() => q);
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
