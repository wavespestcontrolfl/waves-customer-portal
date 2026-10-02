// The v6 copy freeze against REAL Postgres: the guarded UPDATE is the whole
// first-writer-wins guarantee, so its SQL is executed, not simulated. Runs in a
// private throwaway schema; skipped without DATABASE_URL (CI has it).
// Synthetic data only.
//
// Proves: concurrent first renders converge on ONE entry and every writer
// returns it; a lost race adopts the winner; A -> B -> A never overwrites (each
// assessment keeps its own key, a re-render with a different model answer
// changes nothing); concurrent renders of different assessments on one record
// all land (two-level merge, not a top-level replace); other structured_notes
// keys survive; a degraded read never creates a freeze; an unavailable model
// creates none either. Both column types are exercised: structured_notes is
// read through ::jsonb, so the freeze must work whether the column is jsonb or
// text.

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const {
  freezeLawnCopyV6, resolveLawnCopyV6ForRender, storedLawnCopyV6For, PROMPT_VERSION, _test,
} = require('../services/service-report/lawn-copy-v6');

const URL = process.env.LAWN_COPY_V6_TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const entry = (assessmentId, headline, over = {}) => ({
  v: 1, promptVersion: PROMPT_VERSION, assessmentId, frozenAt: '2026-09-30T18:00:00.000Z',
  fields: { headline, whatWeDid: null, whatToExpect: null, watching: null }, expectRows: [], ...over,
});

const report = () => ({
  snapshot: { status: 'watch' },
  diagnosis: [],
  treatment: { products: [{ name: 'Test Herbicide B', kind: 'herbicide', targets: [] }] },
  insights: [{ category: 'weeds', status: 'watch', priority: 1 }],
});
const modelSaying = (headline) => ({ callModel: jest.fn(async () => ({ ok: true, json: { headline, whatWeDid: '', watching: '' } })) });

describeIfDb.each([['jsonb'], ['text']])('lawn copy v6 freeze (postgres, structured_notes %s)', (columnType) => {
  let knex; let schema;
  const notes = async (id = 's1') => {
    const row = await knex('service_records').where({ id }).first('structured_notes');
    return typeof row.structured_notes === 'string' ? JSON.parse(row.structured_notes) : row.structured_notes;
  };

  beforeAll(async () => {
    schema = `lawn_cv6_test_${Math.random().toString(36).slice(2, 10)}`;
    const setup = require('knex')({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    await setup.raw(`CREATE SCHEMA ${schema}`);
    await setup.destroy();
    knex = require('knex')({
      client: 'pg',
      connection: URL,
      pool: { min: 0, max: 12, afterCreate: (conn, done) => conn.query(`SET search_path TO ${schema}`, (err) => done(err, conn)) },
    });
    await knex.raw(`CREATE TABLE service_records (id text PRIMARY KEY, customer_id text, structured_notes ${columnType})`);
  });
  afterAll(async () => {
    if (!knex) return;
    await knex.raw(`DROP SCHEMA ${schema} CASCADE`);
    await knex.destroy();
  });
  beforeEach(async () => {
    _test._cache.clear();
    await knex('service_records').del();
    await knex('service_records').insert({ id: 's1', customer_id: 'c1', structured_notes: JSON.stringify({ timeOnSiteAdjusted: true }) });
  });

  test('the first writer persists and unrelated keys survive; a second writer gets the first entry back', async () => {
    const first = entry('as-A', 'First');
    await expect(freezeLawnCopyV6('s1', first, knex)).resolves.toEqual(first);
    await expect(freezeLawnCopyV6('s1', entry('as-A', 'Second'), knex)).resolves.toEqual(first);
    const n = await notes();
    expect(n.lawnCopyV6['as-A']).toEqual(first);
    expect(n.timeOnSiteAdjusted).toBe(true);
  });

  test('eight truly concurrent first renders converge on one entry and every writer returns it', async () => {
    const writers = Array.from({ length: 8 }, (_, i) => entry('as-A', `Writer ${i}`));
    const results = await Promise.all(writers.map((w) => freezeLawnCopyV6('s1', w, knex)));
    const stored = (await notes()).lawnCopyV6['as-A'];
    expect(writers.map((w) => w.fields.headline)).toContain(stored.fields.headline);
    for (const r of results) expect(r).toEqual(stored);
    expect(Object.keys((await notes()).lawnCopyV6)).toEqual(['as-A']);
  });

  test('concurrent full renders (model call + freeze) of one assessment converge: every caller serves the stored copy', async () => {
    const renders = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      _test._cache.clear();
      return resolveLawnCopyV6ForRender({
        structuredNotes: {}, serviceRecordId: 's1', assessmentId: 'as-A', reportV2: report(), knex, deps: modelSaying(`Healthy overall, writer ${['a', 'b', 'c', 'd', 'e', 'f'][i]}`),
      });
    }));
    const stored = storedLawnCopyV6For(await notes(), 'as-A');
    expect(stored).toBeTruthy();
    for (const r of renders) {
      expect(r.unfrozen).toBe(false);
      expect(r.copy.headline).toBe(stored.fields.headline);
    }
  });

  test('concurrent renders of DIFFERENT assessments on one record both land (the two-level merge, not a top-level replace)', async () => {
    const ids = ['as-A', 'as-B', 'as-C', 'as-D'];
    await Promise.all(ids.map((id) => freezeLawnCopyV6('s1', entry(id, `Entry ${id}`), knex)));
    const map = (await notes()).lawnCopyV6;
    expect(Object.keys(map).sort()).toEqual(ids);
    for (const id of ids) expect(map[id].fields.headline).toBe(`Entry ${id}`);
  });

  test('A -> B -> A: the re-render of A with a different model answer never overwrites A, and B keeps its own entry', async () => {
    const run = (assessmentId, headline) => {
      _test._cache.clear();
      return knex('service_records').where({ id: 's1' }).first('structured_notes').then((row) => resolveLawnCopyV6ForRender({
        structuredNotes: row.structured_notes, serviceRecordId: 's1', assessmentId, reportV2: report(), knex, deps: modelSaying(headline),
      }));
    };
    const a1 = await run('as-A', 'Healthy overall, original A');
    const b = await run('as-B', 'Healthy overall, re-do B');
    const a2 = await run('as-A', 'Healthy overall, different A');
    expect(a2.copy).toEqual(a1.copy);
    expect(a2.copy.headline).toBe('Healthy overall, original A');
    const map = (await notes()).lawnCopyV6;
    expect(map['as-A'].fields.headline).toBe('Healthy overall, original A');
    expect(map['as-B'].fields.headline).toBe('Healthy overall, re-do B');
    expect(b.copy.headline).toBe('Healthy overall, re-do B');
  });

  test('a frozen entry replays with no model call', async () => {
    await freezeLawnCopyV6('s1', entry('as-A', 'Frozen headline'), knex);
    const deps = modelSaying('Never used');
    const out = await resolveLawnCopyV6ForRender({
      structuredNotes: await notes(), serviceRecordId: 's1', assessmentId: 'as-A', reportV2: report(), knex, deps,
    });
    expect(out.copy.headline).toBe('Frozen headline');
    expect(deps.callModel).not.toHaveBeenCalled();
  });

  test('a degraded read creates no freeze and calls no model; an unavailable model creates none either', async () => {
    const deps = modelSaying('Never used');
    const degraded = await resolveLawnCopyV6ForRender({
      structuredNotes: {}, serviceRecordId: 's1', assessmentId: 'as-A', reportV2: report(), knex, degraded: true, deps,
    });
    expect(degraded).toEqual({ copy: null, unfrozen: true });
    expect(deps.callModel).not.toHaveBeenCalled();
    const down = await resolveLawnCopyV6ForRender({
      structuredNotes: {}, serviceRecordId: 's1', assessmentId: 'as-A', reportV2: report(), knex, deps: { callModel: async () => ({ ok: false }) },
    });
    expect(down).toEqual({ copy: null, unfrozen: true });
    expect((await notes()).lawnCopyV6).toBeUndefined();
  });

  test('a record that does not exist freezes nothing and does not throw', async () => {
    await expect(freezeLawnCopyV6('missing', entry('as-A', 'x'), knex)).resolves.toBeNull();
  });
});
