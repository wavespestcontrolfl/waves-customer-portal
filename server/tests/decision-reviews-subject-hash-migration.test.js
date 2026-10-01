// decision_reviews.subject_hash migration (Codex #5505).
const migration = require('../models/migrations/20261001180000_decision_reviews_subject_hash');

function buildKnex({ table = true, column = false } = {}) {
  const ops = [];
  const t = { string: jest.fn((...a) => ops.push(['string', ...a])), dropColumn: jest.fn((...a) => ops.push(['dropColumn', ...a])) };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => table),
      hasColumn: jest.fn(async () => column),
      alterTable: jest.fn(async (_name, fn) => fn(t)),
    },
  };
  return { knex, ops };
}

describe('decision_reviews subject_hash migration', () => {
  test('up adds a nullable 64-char column once', async () => {
    const { knex, ops } = buildKnex();
    await migration.up(knex);
    expect(ops).toEqual([['string', 'subject_hash', 64]]);
    const again = buildKnex({ column: true });
    await migration.up(again.knex);
    expect(again.ops).toEqual([]);
  });
  test('down drops it; both no-op without the table', async () => {
    const { knex, ops } = buildKnex({ column: true });
    await migration.down(knex);
    expect(ops).toEqual([['dropColumn', 'subject_hash']]);
    const missing = buildKnex({ table: false });
    await migration.up(missing.knex); await migration.down(missing.knex);
    expect(missing.ops).toEqual([]);
  });
});
