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
  freezeLawnVisitMemory, resolveVisitMemoryForRender, selectPriorVisit, storedVisitMemoryFor, recordPairedRecheck, recordRetreatCheck, buildSinceLast, publicSinceLast,
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
    await knex.raw(`CREATE TABLE service_records (id text PRIMARY KEY, customer_id text, structured_notes ${columnType}, report_template_version text DEFAULT 'service_report_v1')`);
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
  // P19b: the paired-photo recheck is written onto an ALREADY FROZEN entry by a
  // compare-and-set UPDATE. Real SQL, both column types.
  describe('recordPairedRecheck (P19b)', () => {
    const photo = (verdict) => ({ verdict, source: 'photo_pair', whatChanged: ['color'], pairs: ['front'], promptVersion: 'p' });
    const withPrior = (over = {}) => entry('as-C', 'This Visit', {
      sinceLast: { v: 1, priorAssessmentId: 'as-P', priorDate: '2026-08-01', applied: [], checks: [{ key: 'weeds', status: 'watch' }, { key: 'water', status: 'needs_attention' }] },
      ...over,
    });

    test('writes the recheck on the matching check and the pair verdicts once; every other byte of the record is untouched', async () => {
      const frozen = withPrior();
      await freezeLawnVisitMemory('s1', frozen, knex);
      await freezeLawnVisitMemory('s1', entry('as-Z', 'Other Visit'), knex);
      const pairs = [{ zone: 'front', verdict: 'better', whatChanged: ['color'] }];
      await expect(recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('better') }, photoPairs: pairs }, knex))
        .resolves.toEqual({ written: ['weeds'], photoPairs: true });
      const n = await notes();
      expect(n.timeOnSiteAdjusted).toBe(true);
      expect(n.lawnVisitMemory['as-Z']).toEqual(entry('as-Z', 'Other Visit'));
      const stored = n.lawnVisitMemory['as-C'];
      expect(stored.applied).toEqual(frozen.applied);
      expect(stored.sinceLast.checks).toEqual([{ key: 'weeds', status: 'watch', recheck: photo('better') }, { key: 'water', status: 'needs_attention' }]);
      expect(stored.sinceLast.photoPairs).toEqual(pairs);
    });

    test('first writer wins per check: a second photo read, or one after an office decision, changes nothing', async () => {
      await freezeLawnVisitMemory('s1', withPrior(), knex);
      await recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('better') }, photoPairs: [{ zone: 'front', verdict: 'better', whatChanged: [] }] }, knex);
      await expect(recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('worse') }, photoPairs: [{ zone: 'back', verdict: 'worse', whatChanged: [] }] }, knex))
        .resolves.toEqual({ written: [], photoPairs: false });
      let stored = (await notes()).lawnVisitMemory['as-C'];
      expect(stored.sinceLast.checks[0].recheck.verdict).toBe('better');
      expect(stored.sinceLast.photoPairs).toEqual([{ zone: 'front', verdict: 'better', whatChanged: [] }]);
      // an office decision already on the other check is kept
      const rec = (await notes());
      rec.lawnVisitMemory['as-C'].sinceLast.checks[1].recheck = { verdict: 'same', source: 'office_review' };
      await knex('service_records').where({ id: 's1' }).update({ structured_notes: JSON.stringify(rec) });
      await expect(recordPairedRecheck('s1', 'as-C', { rechecks: { water: photo('worse') } }, knex)).resolves.toEqual({ written: [], photoPairs: false });
      stored = (await notes()).lawnVisitMemory['as-C'];
      expect(stored.sinceLast.checks[1].recheck).toEqual({ verdict: 'same', source: 'office_review' });
    });

    test('never creates an entry: no entry, or an entry with no sinceLast, writes nothing', async () => {
      await expect(recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('better') } }, knex)).resolves.toBeNull();
      await freezeLawnVisitMemory('s1', entry('as-C', 'No Prior'), knex);
      await expect(recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('better') } }, knex)).resolves.toBeNull();
      const n = await notes();
      expect(n.lawnVisitMemory['as-C']).toEqual(entry('as-C', 'No Prior'));
      expect(Object.keys(n.lawnVisitMemory)).toEqual(['as-C']);
    });

    test('two writers racing on one entry both land (compare-and-set re-reads), each check written exactly once', async () => {
      await freezeLawnVisitMemory('s1', withPrior(), knex);
      const results = await Promise.all([
        recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: photo('better') } }, knex),
        recordPairedRecheck('s1', 'as-C', { rechecks: { water: photo('worse') } }, knex),
      ]);
      expect(results.every(Boolean)).toBe(true);
      const checks = (await notes()).lawnVisitMemory['as-C'].sinceLast.checks;
      expect(checks.map((c) => c.recheck && c.recheck.verdict)).toEqual(['better', 'worse']);
    });
  });

  // P31: the rainfast retreat-check is written onto an ALREADY FROZEN entry by the
  // same compare-and-set UPDATE. Real SQL, both column types.
  describe('recordRetreatCheck (P31)', () => {
    const item = (inches = 0.4) => ({
      v: 1, kind: 'rainfast_breach', source: 'open_meteo', windowFrom: '2026-09-02T18:00:00.000Z',
      breaches: [{ minutes: 180, inches, windowTo: '2026-09-02T21:00:00.000Z', products: ['Test Herbicide'] }],
      recordedAt: '2026-09-03T00:00:00.000Z',
    });

    test('writes one item on the frozen entry; every other byte of the record is untouched', async () => {
      const frozen = entry('as-C', 'This Visit', { checks: [{ key: 'weeds', status: 'watch' }] });
      await freezeLawnVisitMemory('s1', frozen, knex);
      await freezeLawnVisitMemory('s1', entry('as-Z', 'Other Visit'), knex);
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toEqual(item());
      const n = await notes();
      expect(n.timeOnSiteAdjusted).toBe(true);
      expect(n.lawnVisitMemory['as-Z']).toEqual(entry('as-Z', 'Other Visit'));
      expect(n.lawnVisitMemory['as-C']).toEqual({ ...frozen, retreatCheck: item() });
    });

    test('first writer wins: a second item is refused and the stored one is handed back', async () => {
      await freezeLawnVisitMemory('s1', entry('as-C', 'This Visit'), knex);
      await recordRetreatCheck('s1', 'as-C', item(0.4), knex);
      await expect(recordRetreatCheck('s1', 'as-C', item(0.9), knex)).resolves.toEqual(item(0.4));
      expect((await notes()).lawnVisitMemory['as-C'].retreatCheck).toEqual(item(0.4));
    });

    test('a record that stopped being a readable report writes nothing: another template, or a suppressed typed report', async () => {
      await freezeLawnVisitMemory('s1', entry('as-C', 'This Visit'), knex);
      await knex('service_records').where({ id: 's1' }).update({ report_template_version: 'other_template' });
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toBeNull();
      expect((await notes()).lawnVisitMemory['as-C'].retreatCheck).toBeUndefined();
      await knex('service_records').where({ id: 's1' }).update({ report_template_version: 'service_report_v1' });
      const withDelivery = async (mode) => {
        const n = await notes();
        n.typedReportDelivery = mode;
        await knex('service_records').where({ id: 's1' }).update({ structured_notes: JSON.stringify(n) });
      };
      await withDelivery('internal_only');
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toBeNull();
      await withDelivery('disabled');
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toBeNull();
      expect((await notes()).lawnVisitMemory['as-C'].retreatCheck).toBeUndefined();
      // readable again (auto_send, an empty marker, or none) writes
      await withDelivery('');
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toEqual(item());
    });

    test('auto_send and an absent marker are readable', async () => {
      await freezeLawnVisitMemory('s1', entry('as-C', 'This Visit'), knex);
      const n = await notes();
      n.typedReportDelivery = 'auto_send';
      await knex('service_records').where({ id: 's1' }).update({ structured_notes: JSON.stringify(n) });
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toEqual(item());
    });

    test('never creates an entry', async () => {
      await expect(recordRetreatCheck('s1', 'as-C', item(), knex)).resolves.toBeNull();
      expect((await notes()).lawnVisitMemory).toBeUndefined();
    });

    test('racing with a paired recheck on the same entry: both land', async () => {
      const frozen = entry('as-C', 'This Visit', {
        sinceLast: { v: 1, priorAssessmentId: 'as-P', priorDate: '2026-08-01', applied: [], checks: [{ key: 'weeds', status: 'watch' }] },
      });
      await freezeLawnVisitMemory('s1', frozen, knex);
      const [a, b] = await Promise.all([
        recordRetreatCheck('s1', 'as-C', item(), knex),
        recordPairedRecheck('s1', 'as-C', { rechecks: { weeds: { verdict: 'better', source: 'photo_pair', whatChanged: [], pairs: [], promptVersion: 'p' } } }, knex),
      ]);
      expect(a).toEqual(item());
      expect(b).toEqual({ written: ['weeds'], photoPairs: false });
      const stored = (await notes()).lawnVisitMemory['as-C'];
      expect(stored.retreatCheck).toEqual(item());
      expect(stored.sinceLast.checks[0].recheck.verdict).toBe('better');
    });

    test('the next visit carries the item as engine input and the public block leaves it off', async () => {
      await freezeLawnVisitMemory('s1', entry('as-P', 'Prior Visit', { checks: [{ key: 'weeds', status: 'watch' }] }), knex);
      await recordRetreatCheck('s1', 'as-P', item(), knex);
      const priorMemory = storedVisitMemoryFor(await notes(), 'as-P');
      const sinceLast = buildSinceLast({ priorVisit: { assessmentId: 'as-P', date: '2026-09-02' }, priorMemory });
      expect(sinceLast.retreatCheck).toEqual(item());
      expect(publicSinceLast(sinceLast)).not.toHaveProperty('retreatCheck');
    });
  });
});
