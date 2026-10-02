// The treatment-memory freeze against REAL Postgres: the guarded UPDATE is the
// whole first-writer-wins guarantee, so its SQL is executed, not simulated.
// Runs in a private throwaway schema; skipped without DATABASE_URL (CI has it).
// Synthetic data only.
//
// Proves: concurrent first renders converge on ONE entry; A -> B -> A never
// overwrites (each assessment keeps its own key, and a re-render with different
// inputs changes nothing); other structured_notes keys survive; a render
// replays the frozen entry after a NEWER visit exists; a later-dated row is
// never the prior; a moved home (a different property's history) gives none.
// Both column types are exercised: structured_notes is read through ::jsonb, so
// the freeze must work whether the column is jsonb or text.

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const {
  freezeLawnVisitMemory, resolveVisitMemoryForRender, selectPriorVisit, storedVisitMemoryFor,
} = require('../services/service-report/lawn-visit-memory');

const URL = process.env.LAWN_VISIT_MEMORY_TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const entry = (assessmentId, name, over = {}) => ({
  v: 1, assessmentId, serviceDate: '2026-09-02',
  applied: [{ name, activeIngredient: null, kind: 'other', tag: 'lawn treatment', targets: [] }],
  checks: [], sinceLast: null, ...over,
});

describeIfDb.each([['jsonb'], ['text']])('lawn visit memory freeze (postgres, structured_notes %s)', (columnType) => {
  let knex; let schema;
  const notes = async (id = 's1') => {
    const row = await knex('service_records').where({ id }).first('structured_notes');
    return typeof row.structured_notes === 'string' ? JSON.parse(row.structured_notes) : row.structured_notes;
  };

  beforeAll(async () => {
    schema = `lawn_vm_test_${Math.random().toString(36).slice(2, 10)}`;
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
    await knex('service_records').del();
    await knex('service_records').insert({ id: 's1', customer_id: 'c1', structured_notes: JSON.stringify({ timeOnSiteAdjusted: true }) });
  });

  test('the first writer persists and unrelated keys survive; a second writer gets the first entry back', async () => {
    const first = entry('as-A', 'First');
    await expect(freezeLawnVisitMemory('s1', first, knex)).resolves.toEqual(first);
    await expect(freezeLawnVisitMemory('s1', entry('as-A', 'Second', { checks: [{ key: 'water', status: 'watch' }] }), knex)).resolves.toEqual(first);
    const n = await notes();
    expect(n.lawnVisitMemory['as-A']).toEqual(first);
    expect(n.timeOnSiteAdjusted).toBe(true);
  });

  test('eight truly concurrent first renders converge on one entry and every writer returns it', async () => {
    const writers = Array.from({ length: 8 }, (_, i) => entry('as-A', `Writer ${i}`));
    const results = await Promise.all(writers.map((w) => freezeLawnVisitMemory('s1', w, knex)));
    const stored = (await notes()).lawnVisitMemory['as-A'];
    expect(writers.map((w) => w.applied[0].name)).toContain(stored.applied[0].name);
    for (const r of results) expect(r).toEqual(stored);
    expect(Object.keys((await notes()).lawnVisitMemory)).toEqual(['as-A']);
  });

  test('concurrent renders of DIFFERENT assessments on one record both land (the two-level merge, not a top-level replace)', async () => {
    const ids = ['as-A', 'as-B', 'as-C', 'as-D'];
    await Promise.all(ids.map((id) => freezeLawnVisitMemory('s1', entry(id, `Entry ${id}`), knex)));
    const map = (await notes()).lawnVisitMemory;
    expect(Object.keys(map).sort()).toEqual(ids);
    for (const id of ids) expect(map[id].applied[0].name).toBe(`Entry ${id}`);
  });

  test('A -> B -> A: the re-render of A with different inputs never overwrites A, and B keeps its own entry', async () => {
    const a1 = entry('as-A', 'Original A');
    const b = entry('as-B', 'Re-do B');
    await freezeLawnVisitMemory('s1', a1, knex);
    await freezeLawnVisitMemory('s1', b, knex);
    await expect(freezeLawnVisitMemory('s1', entry('as-A', 'Different A'), knex)).resolves.toEqual(a1);
    const map = (await notes()).lawnVisitMemory;
    expect(map['as-A']).toEqual(a1);
    expect(map['as-B']).toEqual(b);
  });

  test('a render replays its frozen entry after a NEWER visit exists, and a later-dated row is never the prior', async () => {
    // Prior visit (Aug) froze its memory; this visit (Sep) renders; then an Oct visit lands.
    const priorEntry = entry('as-P', 'Prior Product', { serviceDate: '2026-08-01', checks: [{ key: 'weeds', status: 'watch' }] });
    await knex('service_records').insert({ id: 's0', customer_id: 'c1', structured_notes: JSON.stringify({ lawnVisitMemory: { 'as-P': priorEntry } }) });
    const row = (id, date, rec) => ({ id, service_date: date, history_record_id: rec });
    const rowsAtRender = [row('as-P', '2026-08-01', 's0'), row('as-C', '2026-09-02', 's1')];
    const render = async (rows, report) => resolveVisitMemoryForRender({
      structuredNotes: (await notes()), serviceRecordId: 's1', customerId: 'c1',
      reportV2: report, assessmentId: 'as-C', serviceDate: '2026-09-02',
      priorVisit: selectPriorVisit(rows, 'as-C'), knex,
    });
    const report = { treatment: { products: [{ name: 'This Visit Product', kind: 'other', targets: [] }] }, insights: [] };

    const first = await render(rowsAtRender, report);
    expect(first.sinceLast).toMatchObject({ priorAssessmentId: 'as-P', priorDate: '2026-08-01', checks: [{ key: 'weeds', status: 'watch' }] });

    // A newer (Oct) visit now exists in the history, and this render's inputs differ.
    const rowsLater = [...rowsAtRender, row('as-N', '2026-10-05', 's2')];
    expect(selectPriorVisit(rowsLater, 'as-C').assessmentId).toBe('as-P');
    const again = await render(rowsLater, { treatment: { products: [{ name: 'Edited Later', kind: 'other', targets: [] }] }, insights: [] });
    expect(JSON.stringify(again.sinceLast)).toBe(JSON.stringify(first.sinceLast));
    expect(storedVisitMemoryFor(await notes(), 'as-C').applied[0].name).toBe('This Visit Product');
  });

  test('a moved home: history scoped to the new property has no earlier visit, so no prior is read and sinceLast is frozen null', async () => {
    const rows = [{ id: 'as-C', service_date: '2026-09-02', history_record_id: 's1' }]; // old home's rows are not in this property's history
    expect(selectPriorVisit(rows, 'as-C')).toBeNull();
    const out = await resolveVisitMemoryForRender({
      structuredNotes: await notes(), serviceRecordId: 's1', customerId: 'c1',
      reportV2: { treatment: { products: [] }, insights: [] }, assessmentId: 'as-C', serviceDate: '2026-09-02',
      priorVisit: selectPriorVisit(rows, 'as-C'), knex,
    });
    expect(out).toEqual({ sinceLast: null, unfrozen: false });
    expect(storedVisitMemoryFor(await notes(), 'as-C').sinceLast).toBeNull();
  });
});
