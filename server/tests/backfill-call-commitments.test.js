// The call promise tracker backfill (scripts/backfill-call-commitments.js): argument and date
// handling, the candidate query's shape, and the dry-run / apply split. No database is opened;
// the query is only compiled. Synthetic ids only.
const knex = require('knex');
const backfill = require('../../scripts/backfill-call-commitments');

describe('backfill-call-commitments', () => {
  test('parseArgs: dry run by default, --apply opts in, limit defaults to 100', () => {
    expect(backfill.parseArgs(['--from', '2026-10-15', '--to', '2026-10-18'])).toEqual({ from: '2026-10-15', to: '2026-10-18', apply: false, limit: 100 });
    expect(backfill.parseArgs(['--from', '2026-10-15', '--to', '2026-10-18', '--apply', '--limit', '5'])).toMatchObject({ apply: true, limit: 5 });
  });

  test('etRange: inclusive ET calendar dates become [start, end) instants', () => {
    const { start, end } = backfill.etRange('2026-10-15', '2026-10-18');
    expect(start.toISOString()).toBe('2026-10-15T04:00:00.000Z'); // EDT
    expect(end.toISOString()).toBe('2026-10-19T04:00:00.000Z');
    expect(() => backfill.etRange('2026-10-18', '2026-10-15')).toThrow(/must not be after/);
    expect(() => backfill.etRange('10/15', '2026-10-18')).toThrow(/YYYY-MM-DD/);
    // Impossible dates never normalize into another range (Codex #6346 r1).
    expect(() => backfill.etRange('2026-00-01', '2026-00-02')).toThrow(/real ET dates/);
    expect(() => backfill.etRange('2026-02-30', '2026-03-01')).toThrow(/real ET dates/);
  });

  test('the candidate query keeps processed two-party calls with a transcript and no commitment row', () => {
    const db = knex({ client: 'pg' });
    const sql = backfill.candidateQuery(db, { start: new Date('2026-10-15T04:00:00Z'), end: new Date('2026-10-19T04:00:00Z'), limit: 7 }).toString();
    expect(sql).toMatch(/"c"\."processing_status" = 'processed'/);
    expect(sql).toMatch(/"c"\."processing_token" is null/);
    expect(sql).toMatch(/COALESCE\(c\.call_outcome, ''\) <> 'voicemail'/);
    expect(sql).toMatch(/COALESCE\(c\.answered_by, ''\) <> 'voicemail'/);
    expect(sql).toMatch(/voicemail_message/);
    expect(sql).toMatch(/not exists \(select 1 from "call_commitments" as "cc" where cc\.call_log_id = c\.id\)/);
    expect(sql).toMatch(/limit 7/);
    expect(sql).toMatch(/select "c"\."id", "c"\."created_at" from/);
  });

  const fakeDb = () => ({ transaction: async (fn) => fn({ raw: jest.fn(async () => {}) }) });
  const candidates = [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', created_at: '2026-10-16T15:00:00Z' }, { id: 'bbbbbbbb-0000-0000-0000-000000000002', created_at: '2026-10-17T15:00:00Z' }];

  test('dry run lists id8 and date, never runs the pipeline step', async () => {
    const lines = [];
    const step = jest.fn();
    const totals = await backfill.run({ dbh: fakeDb(), from: '2026-10-15', to: '2026-10-18', apply: false, find: async () => candidates, step, log: (l) => lines.push(l) });
    expect(step).not.toHaveBeenCalled();
    expect(totals.candidates).toBe(2);
    expect(lines.join('\n')).toMatch(/would run  aaaaaaaa  2026-10-16/);
    expect(lines.join('\n')).not.toMatch(/0000-0000/); // never the whole id
  });

  test('apply runs the step once per call, in order, and counts outcomes', async () => {
    const order = [];
    const step = jest.fn(async (_db, id) => { order.push(id); return id.startsWith('aaaaaaaa') ? { ran: true, rows: 2 } : { ran: false, reason: 'row_exists_now' }; });
    const lines = [];
    const totals = await backfill.run({ dbh: fakeDb(), from: '2026-10-15', to: '2026-10-18', apply: true, gateLive: true, find: async () => candidates, step, log: (l) => lines.push(l) });
    expect(order).toEqual(candidates.map((c) => c.id));
    expect(totals).toMatchObject({ candidates: 2, ran: 1, withRows: 1, skipped: 1, failed: 0 });
  });

  test('apply with the commitments gate off stops before any call', async () => {
    const step = jest.fn();
    const totals = await backfill.run({ dbh: fakeDb(), from: '2026-10-15', to: '2026-10-18', apply: true, gateLive: false, find: async () => candidates, step, log: () => {} });
    expect(step).not.toHaveBeenCalled();
    expect(totals.ran).toBe(0);
  });

  test('a step that throws is counted as failed and the next call still runs', async () => {
    const step = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom with a transcript line'), { code: 'X1' }))
      .mockResolvedValueOnce({ ran: true, rows: 0 });
    const lines = [];
    const totals = await backfill.run({ dbh: fakeDb(), from: '2026-10-15', to: '2026-10-18', apply: true, gateLive: true, find: async () => candidates, step, log: (l) => lines.push(l) });
    expect(totals).toMatchObject({ failed: 1, ran: 1, noRows: 1 });
    expect(lines.join('\n')).not.toMatch(/transcript line/);
  });
  test('runPipelineStep reports a failed replay, never "nothing promised" (Codex #6346 r1)', async () => {
    const callRow = { id: 'c1', processing_status: 'processed', processing_token: null, transcription: 'x'.repeat(60), processing_generation: 1 };
    const dbh = (table) => ({
      where: () => ({
        first: async () => (table === 'call_log' ? callRow : null),
        count: () => ({ first: async () => ({ n: 0 }) }),
      }),
    });
    for (const [summary, reason] of [
      [{ skipped: 'model_failed' }, 'model_failed'], [{ skipped: 'schema_failed' }, 'schema_failed'],
      [{ error: 'db down' }, 'write_failed'], [{ ownershipLost: true }, 'superseded'], [null, 'step_did_not_run'],
    ]) {
      await expect(backfill.runPipelineStep(dbh, 'c1', { recordCommitmentsStep: async () => summary })).resolves.toEqual({ ran: false, failed: true, reason });
    }
    await expect(backfill.runPipelineStep(dbh, 'c1', { recordCommitmentsStep: async () => ({ skipped: null, written: 0 }) })).resolves.toEqual({ ran: true, rows: 0 });
  });

  test('a failed step result is counted as failed', async () => {
    const step = jest.fn(async () => ({ ran: false, failed: true, reason: 'model_failed' }));
    const totals = await backfill.run({ dbh: fakeDb(), from: '2026-10-15', to: '2026-10-18', apply: true, gateLive: true, find: async () => candidates, step, log: () => {} });
    expect(totals).toMatchObject({ failed: 2, ran: 0, skipped: 0 });
  });
});
