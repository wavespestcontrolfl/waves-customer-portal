/**
 * Completion-record invariants — predicate registry shape and the
 * count/sample adapter. The SQL itself is exercised against the local
 * schema by the syntax check in the PR (psql), not here (no DB in jest).
 */
const { PREDICATES, PREDICATE_KEYS, runPredicate, _private } = require('../services/completion-record-invariants');

const KEYS = [
  'completed_visit_without_record',
  'duplicate_completed_records_per_visit',
  'completed_record_without_report_token',
  'completed_visit_without_completed_at',
  'completed_record_without_comms_marker',
  'aged_incomplete_visit_records',
];

describe('PREDICATES registry', () => {
  test('exactly the six audited mismatch classes, each with label, href, and a bounded count+sample aggregate', () => {
    expect(Object.keys(PREDICATES).sort()).toEqual([...KEYS].sort());
    expect(PREDICATE_KEYS).toEqual(Object.keys(PREDICATES));
    expect(Object.isFrozen(PREDICATES)).toBe(true);
    for (const key of KEYS) {
      const p = PREDICATES[key];
      expect(typeof p.label).toBe('string');
      expect(p.href.startsWith('/admin/')).toBe(true);
      // Count over the whole match, sample bounded BEFORE aggregation.
      expect(p.sql).toMatch(/WITH m AS \(/);
      expect(p.sql).toMatch(/\(SELECT count\(\*\)::int FROM m\) AS n/);
      expect(p.sql).toContain(`ORDER BY m.ord DESC LIMIT ${_private.SAMPLE}) s) AS sample`);
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

  test('grace periods age from the completion-specific marker (visit completed_at), never the row\'s general updated_at', () => {
    expect(_private.COMPLETED_MARKER_AT).toBe('GREATEST(sr.created_at, COALESCE(ss.completed_at, sr.created_at))');
    expect(_private.COMPLETED_MARKER_AT).not.toContain('updated_at');
    expect(PREDICATES.completed_record_without_report_token.sql).toContain(`${_private.COMPLETED_MARKER_AT} < now() - interval '2 hours'`);
    expect(PREDICATES.completed_record_without_comms_marker.sql).toContain(`${_private.COMPLETED_MARKER_AT} < now() - interval '24 hours'`);
  });

  test('token and comms predicates are VISIT-level: any sibling carrying the artifact clears the visit', () => {
    const token = PREDICATES.completed_record_without_report_token.sql;
    expect(token).toMatch(/FROM scheduled_services ss/);
    expect(token).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM service_records tok[\s\S]*report_view_token IS NOT NULL/);
    // A stamped report_generated_at never hides a missing token.
    expect(token).not.toContain('report_generated_at');
    // A frozen "no report owed" catalog rule exempts the record; absent = owed.
    expect(token).toContain("closeoutRequirements'->>'requiresServiceReport', 'true') <> 'false'");
    const comms = PREDICATES.completed_record_without_comms_marker.sql;
    expect(comms).toMatch(/FROM scheduled_services ss/);
    expect(comms).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM service_records sib[\s\S]*service_report_deliveries d/);
    // Email evidence counts only on the sibling that owns the report artifact.
    expect(comms).toContain("(sib.report_view_token IS NOT NULL AND EXISTS (");
    // Only TERMINAL SMS outcomes clear the visit (closeout-status done /
    // not_required); pending 'sending' / 'deferred' and 'failed' do not.
    expect(_private.TERMINAL_SMS_STATUSES).toEqual(['sent', 'skipped_recap_sms_already_sent', 'blocked']);
    expect(comms).toContain("completionSmsStatus' IN ('sent', 'skipped_recap_sms_already_sent', 'blocked')");
    expect(comms).not.toMatch(/'sending'|'deferred'/);
    // A frozen "no customer notice owed" catalog rule exempts the record.
    expect(comms).toContain("closeoutRequirements'->>'requiresCustomerNotice', 'true') <> 'false'");
    // An unconfirmed recap claim is not delivery evidence.
    expect(comms).not.toContain('recap_sms_sent_at');
  });

  test('duplicates are counted within ONE completion rail; cross-rail siblings are supported history', () => {
    const sql = PREDICATES.duplicate_completed_records_per_visit.sql;
    expect(sql).toContain("completion_source IN ('detailed_form', 'project_completion')");
    expect(sql).toContain('GROUP BY sr.scheduled_service_id, sr.completion_source');
  });

  test('incomplete visits stay visible after the grace window until a completed sibling or a live follow-up exists', () => {
    const sql = PREDICATES.aged_incomplete_visit_records.sql;
    expect(_private.INCOMPLETE_FOLLOWUP_GRACE_DAYS).toBe(7);
    expect(sql).toContain(`- ${_private.INCOMPLETE_FOLLOWUP_GRACE_DAYS}`);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM service_records sr WHERE sr\.scheduled_service_id = ss\.id AND sr\.status = 'incomplete'\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM service_records c WHERE c\.scheduled_service_id = ss\.id AND c\.status = 'completed'\)/);
    expect(sql).toMatch(/f\.followup_source_service_id = ss\.id[\s\S]*f\.status NOT IN \('cancelled', 'skipped', 'no_show'\)/);
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
