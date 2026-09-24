jest.mock('../services/lead-estimate-link', () => ({
  isContactEvidenceType: (value) => new Set(['live_conversation', 'assessment_booked', 'assessment_completed']).has(value),
}));
const knex = require('knex')({ client: 'pg' });
const { buildLeadStatusReconciliation, getLeadStatusReconciliation, resolveAssessmentEvidence } = require('../services/lead-status-reconciliation');
const lead = { id: 'lead-1', status: 'new', customer_id: 'customer-1', estimate_id: null, first_contact_at: '2026-09-01T12:00:00.000Z' };
function contactActivity(overrides = {}) {
  return {
    activity_type: 'status_change',
    description: 'Status: new → contacted',
    created_at: '2026-09-01T13:00:00.000Z',
    metadata: { evidenceType: 'live_conversation', evidenceId: 'call-1' },
    ...overrides,
  };
}
function databaseResults({ openLeads = [], assessments = [], assessmentBatches } = {}) {
  const queries = [];
  let assessmentIndex = 0;
  knex.client.runner = (builder) => ({ run: async () => {
    const compiled = builder.toSQL();
    queries.push(compiled);
    return compiled.sql.includes('from "leads"') ? openLeads : assessmentBatches?.[assessmentIndex++] ?? assessments;
  } });
  return { database: (table) => knex(table), queries };
}
afterAll(() => knex.destroy());
test('flags an exact historical transition only within the current lead lifecycle', () => {
  const result = buildLeadStatusReconciliation({
    lead,
    activities: [
      contactActivity({ created_at: '2026-08-31T13:00:00.000Z', metadata: JSON.stringify({ evidenceType: 'live_conversation', evidenceId: 'old-call' }) }),
      contactActivity({ metadata: 'null' }),
      contactActivity(),
    ],
  });
  expect(result.status).toBe('review');
  expect(result.findings).toEqual([expect.objectContaining({
    code: 'historical_contact_transition',
    confidence: 'exact',
    evidence: expect.objectContaining({ id: 'call-1' }),
  })]);
  expect(result.scope).toMatchObject({ kind: 'single_record', writes: false, global_sweep: false });
});
test('treats closed and advanced statuses as review-only history, not an automatic mismatch', async () => {
  const database = jest.fn(() => { throw new Error('database should not be queried'); });
  for (const status of ['contacted', 'won', 'lost']) {
    const result = await getLeadStatusReconciliation({
      database,
      lead: { ...lead, status },
      activities: [contactActivity()],
      associatedCallCount: 1,
    });
    expect(result.status).toBe('not_evaluated');
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatch(/evaluated only for leads in New/);
  }
  expect(database).not.toHaveBeenCalled();
});
test('matches committed assessment history by exact source estimate after first contact', async () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    id: `assessment-${index}`,
    status: [null, 'cancelled', 'skipped', 'confirmed'][index % 4],
    created_at: '2026-09-02T12:00:00.000Z',
    customer_id: lead.customer_id,
  }));
  const { database, queries } = databaseResults({ assessments: rows });
  const result = await resolveAssessmentEvidence(database, { ...lead, estimate_id: 'estimate-1' });
  expect(result).toMatchObject({ association: 'exact_estimate', truncated: true });
  expect(result.candidates).toHaveLength(6);
  expect(queries[0].sql).toContain('"ss"."source_estimate_id" = ?');
  expect(queries[0].sql).toContain('"ss"."created_at" >= ?');
  expect(queries[0].sql).toContain('"ss"."completed_at" >= ?');
  expect(queries[0].bindings).not.toContain('cancelled');
  expect(queries[0].bindings).not.toContain('skipped');
  expect(queries[0].sql).toContain('"ss"."reservation_expires_at" is null');
  expect(queries[0].sql).toContain('or "ss"."customer_id" is not null');
  expect(queries[0].sql.toLowerCase()).toContain('lower(trim("ss"."service_type"))');
  expect(queries[0].sql.toLowerCase()).toContain('lower(trim("svc"."name"))');
  expect(queries[0].bindings).toContain('estimate-1');
  expect(queries[0].bindings).not.toContain('customer-1');
});
test('uses exact customer evidence only when this is the unique open lead', async () => {
  const assessment = { id: 'assessment-1', status: 'completed', created_at: '2026-09-02T12:00:00.000Z' };
  const unique = databaseResults({ openLeads: [{ id: lead.id }], assessments: [assessment] });
  const uniqueResult = await getLeadStatusReconciliation({ database: unique.database, lead });
  expect(uniqueResult.findings[0]).toMatchObject({
    code: 'assessment_contact_candidate',
    confidence: 'bounded',
    evidence: { type: 'assessment_completed', id: 'assessment-1', association: 'unique_customer' },
  });
  const ambiguous = databaseResults({ openLeads: [{ id: lead.id }, { id: 'lead-2' }], assessments: [assessment] });
  const ambiguousResult = await getLeadStatusReconciliation({ database: ambiguous.database, lead });
  expect(ambiguousResult.findings).toEqual([expect.objectContaining({
    code: 'ambiguous_customer_assessment',
    confidence: 'ambiguous',
  })]);
});
test('falls back from an empty estimate query to a uniquely owned customer assessment', async () => {
  const assessment = { id: 'assessment-1', status: 'completed', created_at: '2026-08-01T12:00:00.000Z', completed_at: '2026-09-02T12:00:00.000Z' };
  const result = databaseResults({ openLeads: [{ id: lead.id }], assessmentBatches: [[], [assessment]] });
  const review = await getLeadStatusReconciliation({ database: result.database, lead: { ...lead, estimate_id: 'estimate-1' } });
  expect(review.findings[0]).toMatchObject({ code: 'assessment_contact_candidate', evidence: { association: 'unique_customer', occurred_at: assessment.completed_at } });
});
test('surfaces estimate and customer association conflicts without treating them as exact evidence', async () => {
  const estimateConflict = databaseResults({ assessments: [{
    id: 'assessment-other-customer', customer_id: 'customer-2', source_estimate_id: 'estimate-1',
  }] });
  const estimateResult = await getLeadStatusReconciliation({
    database: estimateConflict.database,
    lead: { ...lead, estimate_id: 'estimate-1' },
  });
  expect(estimateResult.findings).toEqual([expect.objectContaining({
    code: 'assessment_identity_conflict', confidence: 'ambiguous',
  })]);
  const customerConflict = databaseResults({
    openLeads: [{ id: lead.id }],
    assessments: [{ id: 'assessment-other-estimate', customer_id: lead.customer_id, source_estimate_id: 'estimate-2' }],
  });
  const customerResult = await getLeadStatusReconciliation({ database: customerConflict.database, lead });
  expect(customerResult.findings).toEqual([expect.objectContaining({
    code: 'assessment_identity_conflict', confidence: 'ambiguous',
  })]);
});
test('reports associated raw calls as advisory without claiming live contact', () => {
  const result = buildLeadStatusReconciliation({ lead, associatedCallCount: 2 });
  expect(result.findings).toEqual([expect.objectContaining({
    code: 'associated_calls_unverified',
    confidence: 'advisory',
    evidence_count: 2,
  })]);
});
test('requires review when the associated call source is unavailable', () => {
  const result = buildLeadStatusReconciliation({ lead, associatedCallsAvailable: false });
  expect(result.status).toBe('review');
  expect(result.findings).toEqual([expect.objectContaining({
    code: 'associated_calls_unavailable', confidence: 'advisory',
  })]);
  expect(result.scope.calls_available).toBe(false);
});
test('uses created_at as the lifecycle floor and reports a missing floor as unavailable', async () => {
  const fallback = databaseResults({ assessments: [] });
  await resolveAssessmentEvidence(fallback.database, { ...lead, estimate_id: 'estimate-1', first_contact_at: null, created_at: lead.first_contact_at });
  expect(fallback.queries[0].bindings).toContain(lead.first_contact_at);
  await expect(getLeadStatusReconciliation({ database: jest.fn(), lead: { ...lead, first_contact_at: null } }))
    .resolves.toMatchObject({ status: 'review', findings: [{ code: 'lifecycle_start_unavailable' }] });
});
