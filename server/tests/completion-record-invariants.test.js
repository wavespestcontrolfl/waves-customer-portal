/**
 * Completion-record invariants — predicate registry shape and the
 * count/sample adapter. The SQL itself is exercised against the local
 * schema by the syntax check in the PR (psql), not here (no DB in jest).
 */
const { PREDICATES, runPredicate, _private } = require('../services/completion-record-invariants');

const KEYS = [
  'completed_visit_without_record',
  'duplicate_completed_records_per_visit',
  'completed_record_without_report_token',
  'completed_visit_without_completed_at',
  'completed_record_without_comms_marker',
];

describe('PREDICATES registry', () => {
  test('exactly the five audited mismatch classes, each with label, href, one SELECT count + bounded sample', () => {
    expect(Object.keys(PREDICATES).sort()).toEqual([...KEYS].sort());
    expect(Object.isFrozen(PREDICATES)).toBe(true);
    for (const key of KEYS) {
      const p = PREDICATES[key];
      expect(typeof p.label).toBe('string');
      expect(p.href.startsWith('/admin/')).toBe(true);
      expect(p.sql).toMatch(/count\(\*\)::int AS n/);
      expect(p.sql).toContain(`[1:${_private.SAMPLE}] AS sample`);
      // Read-only by construction.
      expect(p.sql).not.toMatch(/\b(update|delete|insert)\b/i);
    }
  });

  test('history-wide predicates exclude today (ET) so the dashboard keeps the closing day', () => {
    expect(PREDICATES.completed_visit_without_record.sql).toContain(_private.BEFORE_TODAY_ET);
    expect(PREDICATES.completed_visit_without_completed_at.sql).toContain(_private.BEFORE_TODAY_ET);
  });

  test('report-token and comms predicates skip backfills, suppressed deliveries, and project completions', () => {
    for (const key of ['completed_record_without_report_token', 'completed_record_without_comms_marker']) {
      const sql = PREDICATES[key].sql;
      expect(sql).toContain("structured_notes->>'backfill'");
      expect(sql).toContain("structured_notes->>'typedReportDelivery'");
      expect(sql).toContain("completion_source IS DISTINCT FROM 'project_completion'");
    }
    expect(PREDICATES.completed_record_without_comms_marker.sql).toContain(_private.COMMS_MARKER_SINCE);
  });
});

describe('runPredicate', () => {
  test('maps the single aggregate row to the sweep adapter shape', async () => {
    const knex = { raw: jest.fn(async () => ({ rows: [{ n: '3', sample: ['a', 'b', 'c'] }] })) };
    const out = await runPredicate('completed_visit_without_record', knex);
    expect(knex.raw).toHaveBeenCalledWith(PREDICATES.completed_visit_without_record.sql);
    expect(out).toEqual({ count: 3, ids: ['a', 'b', 'c'], detail: { sampleCap: _private.SAMPLE } });
  });

  test('an empty aggregate is a clean pass; an unknown key throws (fail closed in the runner)', async () => {
    const knex = { raw: jest.fn(async () => ({ rows: [{ n: 0, sample: null }] })) };
    expect(await runPredicate('duplicate_completed_records_per_visit', knex)).toMatchObject({ count: 0, ids: [] });
    await expect(runPredicate('nope', knex)).rejects.toThrow(/unknown completion-record predicate/);
  });
});
