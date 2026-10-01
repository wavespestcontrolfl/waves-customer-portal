// Shape test for 20261001090000_decision_reviews. Runs without Postgres: a
// recording stub stands in for knex's table builder.
const migration = require('../models/migrations/20261001090000_decision_reviews');

function buildKnex({ exists = false } = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return chain; };
  const chain = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : (...args) => { calls.push([prop, ...args]); return chain; }) });
  const t = new Proxy({}, { get: (_target, prop) => rec(prop) });
  const state = { calls, created: [], dropped: [], raw: [] };
  // knex.raw is called both for the uuid default (sync, value used inline) and
  // for DDL (awaited): record only DDL.
  const knex = { fn: { now: () => 'NOW' }, raw: (sql) => { if (!/gen_random_uuid/.test(sql)) state.raw.push(sql); return sql; } };
  knex.schema = {
    hasTable: jest.fn(async () => exists),
    createTable: jest.fn(async (name, cb) => { state.created.push(name); cb(t); }),
    dropTableIfExists: jest.fn(async (name) => { state.dropped.push(name); }),
  };
  return { knex, state };
}

describe('decision_reviews migration', () => {
  test('creates the table with the agreed columns, unique key and indexes', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.created).toEqual(['decision_reviews']);
    const names = state.calls.map((c) => c[0]);
    const col = (type, name) => state.calls.find((c) => c[0] === type && c[1] === name);

    expect(col('uuid', 'id')).toBeTruthy();
    expect(col('string', 'capability')[2]).toBe(60);
    expect(col('string', 'package_id')[2]).toBe(80);
    expect(col('string', 'package_hash')[2]).toBe(64);
    expect(col('string', 'served_model')[2]).toBe(60);
    expect(col('string', 'subject_type')[2]).toBe(30);
    expect(col('uuid', 'subject_id')).toBeTruthy();
    expect(col('string', 'question_id')[2]).toBe(60);
    for (const jsonb of ['jev_answer', 'baseline_answers', 'outcome_evidence', 'label']) expect(col('jsonb', jsonb)).toBeTruthy();
    expect(col('string', 'sampled_for')[2]).toBe(20);
    expect(col('string', 'label_status')[2]).toBe(20);
    expect(col('string', 'labeled_by')[2]).toBe(120);
    expect(col('timestamp', 'labeled_at')).toBeTruthy();
    expect(col('timestamp', 'created_at')).toBeTruthy();
    expect(names).toContain('notNullable');
    expect(names).toContain('defaultTo');

    const unique = state.calls.find((c) => c[0] === 'unique');
    expect(unique[1]).toEqual(['capability', 'package_id', 'subject_type', 'subject_id', 'question_id']);
    const indexes = state.calls.filter((c) => c[0] === 'index').map((c) => c[1]);
    expect(indexes).toEqual([['capability', 'label_status'], ['sampled_for', 'created_at'], ['subject_type', 'subject_id']]);
  });

  test('constrains the enumerated columns', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    const sql = state.raw.join('\n');
    expect(sql).toMatch(/subject_type IN \('call_log','sms_log'\)/);
    expect(sql).toMatch(/label_status IN \('unreviewed','suspected_error','confirmed_error','disagreement','confirmed_correct'\)/);
    expect(sql).toMatch(/sampled_for IS NULL OR sampled_for IN \('disagreement','random_audit','heldout'\)/);
  });

  test('is a no-op when the table already exists', async () => {
    const { knex, state } = buildKnex({ exists: true });
    await migration.up(knex);
    expect(state.created).toEqual([]);
  });

  test('down drops the table', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);
    expect(state.dropped).toEqual(['decision_reviews']);
  });
});
